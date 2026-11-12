import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { createAdmission, priceFor } from '../inpatient/service';
import { ensureCharge, applyPayment } from '../billing/service';
import { writeAudit } from '../../lib/audit';
import { blindIndex } from '../../lib/crypto';

const TRIAGE_PERMS = ['emergency.triage'];

async function loadTriage(db: any, encounterId: string) {
  const res: any = await db.query(
    `SELECT t.*, p.full_name_ar AS patient_name, p.mrn, p.sex, p.date_of_birth, p.identity_status,
            e.encounter_no, e.status AS encounter_status
       FROM triage_records t
       JOIN patients p ON p.id = t.patient_id
       JOIN encounters e ON e.id = t.encounter_id
      WHERE t.encounter_id = $1
      ORDER BY t.triaged_at DESC LIMIT 1`,
    [encounterId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('لا يوجد سجل فرز لهذه الزيارة');
  return row;
}

function requireTriage(auth: any) {
  requirePermission(auth, 'emergency.triage');
}

export async function emergencyRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- ER board ----
  app.get('/api/emergency/board', async (req) => {
    const auth = requireAuth(req);
    requireTriage(auth);
    return withTenant(auth, async (db) => {
      const rows = await db.query<any>(
        `SELECT t.id, t.encounter_id, t.level, t.chief_complaint, t.status, t.arrived_at, t.triaged_at,
                t.previous_level, p.full_name_ar AS patient_name, p.mrn, p.sex, p.identity_status,
                u.full_name_ar AS triaged_by_name,
                EXTRACT(EPOCH FROM (now() - t.arrived_at)) / 60 AS waiting_minutes,
                (SELECT v.heart_rate FROM vitals v WHERE v.encounter_id = t.encounter_id ORDER BY v.recorded_at DESC LIMIT 1) AS last_hr,
                (SELECT v.systolic_bp FROM vitals v WHERE v.encounter_id = t.encounter_id ORDER BY v.recorded_at DESC LIMIT 1) AS last_sbp,
                (SELECT v.spo2 FROM vitals v WHERE v.encounter_id = t.encounter_id ORDER BY v.recorded_at DESC LIMIT 1) AS last_spo2
           FROM triage_records t
           JOIN patients p ON p.id = t.patient_id
           LEFT JOIN users u ON u.id = t.triaged_by
          WHERE t.facility_id = $1
            AND t.status IN ('waiting','in_treatment','observation')
          ORDER BY t.level ASC, t.arrived_at ASC`,
        [auth.activeFacilityId],
      );
      const counts = await db.query<any>(
        `SELECT level, count(*)::int AS n FROM triage_records
          WHERE facility_id = $1 AND status IN ('waiting','in_treatment','observation')
          GROUP BY level`,
        [auth.activeFacilityId],
      );
      return {
        items: rows.rows.map((r) => ({ ...r, waiting_minutes: Math.round(Number(r.waiting_minutes ?? 0)) })),
        byLevel: Object.fromEntries(counts.rows.map((c) => [c.level, c.n])),
        levels: [
          { level: 1, ar: 'إنعاش فوري', targetMinutes: 0 },
          { level: 2, ar: 'تهديد للحياة', targetMinutes: 10 },
          { level: 3, ar: 'عاجل', targetMinutes: 30 },
          { level: 4, ar: 'أقل إلحاحًا', targetMinutes: 60 },
          { level: 5, ar: 'غير عاجل', targetMinutes: 120 },
        ],
      };
    });
  });

  // ------------------------------------------------------------- Arrivals ----
  app.post('/api/emergency/arrivals', async (req, reply) => {
    const auth = requireAuth(req);
    requireTriage(auth);
    const b = parse(
      z.object({
        patientId: zId.optional(),
        unidentified: z
          .object({ sex: z.enum(['male', 'female', 'other']), estimatedAge: z.number().int().min(0).max(120).optional(), description: z.string().max(120).optional() })
          .optional(),
        chiefComplaint: z.string().min(3).max(500),
        level: z.number().int().min(1).max(5),
        notes: z.string().max(1000).optional(),
        vitals: z
          .object({
            temperatureC: z.number().min(25).max(45).optional(),
            heartRate: z.number().int().min(20).max(250).optional(),
            respRate: z.number().int().min(4).max(80).optional(),
            systolicBp: z.number().int().min(40).max(300).optional(),
            diastolicBp: z.number().int().min(20).max(200).optional(),
            spo2: z.number().int().min(40).max(100).optional(),
          })
          .optional(),
      }),
      req.body,
    );
    if (!b.patientId && !b.unidentified) throw conflict('حدد المريض أو سجّل وصولًا مجهول الهوية');

    return withTenantAudited(
      auth,
      async (db) => {
        let patientId = b.patientId ?? null;
        let temporary = false;
        if (!patientId && b.unidentified) {
          // Temporary identity: unique blind-index on a random placeholder so the
          // normal uniqueness rules still hold, and it can be merged later.
          const placeholder = `ER-${crypto.randomUUID()}`;
          const id = crypto.randomUUID();
          const mrn = await nextDocumentNo(db, auth.activeFacilityId, 'er_mrn', 'ER');
          const label =
            b.unidentified.description?.trim() ||
            `مجهول الهوية (${b.unidentified.sex === 'male' ? 'ذكر' : b.unidentified.sex === 'female' ? 'أنثى' : 'غير محدد'})`;
          await db.query(
            `INSERT INTO patients (id, facility_id, mrn, national_id_hash, full_name_ar, date_of_birth, sex,
               identity_status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified_temporary',$8)`,
            [id, auth.activeFacilityId, mrn, blindIndex(placeholder), label,
              `${new Date().getFullYear() - (b.unidentified.estimatedAge ?? 40)}-01-01`,
              b.unidentified.sex, auth.user.id],
          );
          patientId = id;
          temporary = true;
        }
        const patient = await loadPatientOr404(db, patientId!);

        // One open encounter per patient: an existing open visit may be escalated to the ER.
        const open = await db.query<{ id: string; encounter_type: string }>(
          `SELECT id, encounter_type FROM encounters WHERE patient_id = $1 AND status = 'open' LIMIT 1`,
          [patientId],
        );
        let encounterId: string;
        if (open.rows[0]) {
          if (open.rows[0].encounter_type === 'emergency') throw conflict('يوجد زيارة طوارئ مفتوحة لهذا المريض', { encounterId: open.rows[0].id });
          if (open.rows[0].encounter_type === 'inpatient') throw conflict('المريض منوّم حاليًا — استخدم مسار التنويم الداخلي');
          encounterId = open.rows[0].id;
          // The ER physician takes over the escalated visit (documented handover).
          await db.query(
            `UPDATE encounters SET encounter_type = 'emergency', chief_complaint = $1, triage_level = $2, doctor_id = $3 WHERE id = $4`,
            [b.chiefComplaint, b.level, auth.user.id, encounterId],
          );
        } else {
          const dept = await db.query<{ id: string }>(
            `SELECT id FROM departments WHERE facility_id = $1 AND is_active = true ORDER BY (dept_type = 'emergency') DESC, name_ar LIMIT 1`,
            [auth.activeFacilityId],
          );
          if (!dept.rows[0]) throw conflict('لا يوجد قسم طوارئ معرّف');
          encounterId = crypto.randomUUID();
          const encounterNo = await nextDocumentNo(db, auth.activeFacilityId, 'encounter', 'ENC');
          await db.query(
            `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
               status, chief_complaint, triage_level, created_by)
             VALUES ($1,$2,$3,$4,'emergency',$5,$6,'open',$7,$8,$9)`,
            [encounterId, auth.activeFacilityId, encounterNo, patientId, dept.rows[0].id, auth.user.id,
              b.chiefComplaint, b.level, auth.user.id],
          );
        }

        // The encounter now documents the care relationship; record the access.
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'er_arrival' });

        if (b.vitals) {
          const v = b.vitals;
          const vitalCount = await db.query<{ count: string }>(`SELECT count(*) FROM vitals WHERE encounter_id = $1`, [encounterId]);
          if (Number(vitalCount.rows[0]?.count ?? 0) === 0) {
            await db.query(
              `INSERT INTO vitals (id, facility_id, patient_id, encounter_id, recorded_by, temperature_c, heart_rate,
                 resp_rate, systolic_bp, diastolic_bp, spo2)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [crypto.randomUUID(), auth.activeFacilityId, patientId, encounterId, auth.user.id,
                v.temperatureC ?? null, v.heartRate ?? null, v.respRate ?? null, v.systolicBp ?? null,
                v.diastolicBp ?? null, v.spo2 ?? null],
            );
          }
        }

        const triageId = crypto.randomUUID();
        await db.query(
          `INSERT INTO triage_records (id, facility_id, patient_id, encounter_id, level, chief_complaint, notes, triaged_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [triageId, auth.activeFacilityId, patientId, encounterId, b.level, b.chiefComplaint, b.notes ?? null, auth.user.id],
        );
        if (b.level <= 2) {
          await db.query(
            `INSERT INTO notifications_outbox (facility_id, channel, subject, body, patient_id, related_type, related_id)
             VALUES ($1,'in_app','وصول حالة حرجة',$2,$3,'triage',$4)`,
            [auth.activeFacilityId, `مستوى فرز ${b.level}: ${b.chiefComplaint}`, patientId, triageId],
          );
        }
        reply.code(201);
        return { triageId, encounterId, patientId, temporaryIdentity: temporary };
      },
      (r) => ({
        action: 'emergency.arrival',
        entityType: 'triage',
        entityId: r.triageId,
        patientId: r.patientId,
        detail: { level: b.level, temporaryIdentity: r.temporaryIdentity, encounterId: r.encounterId },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------- Retriage ----
  app.post('/api/emergency/visits/:encounterId/retriage', async (req) => {
    const auth = requireAuth(req);
    requireTriage(auth);
    const { encounterId } = parse(z.object({ encounterId: zId }), req.params);
    const b = parse(z.object({ level: z.number().int().min(1).max(5), reason: z.string().min(5).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const current = await loadTriage(db, encounterId);
        if (!['waiting', 'in_treatment', 'observation'].includes(current.status)) {
          throw conflict('لا يمكن إعادة الفرز بعد انتهاء الزيارة');
        }
        if (current.level === b.level) throw conflict('المستوى الحالي مطابق للمستوى المطلوب');
        await db.query(
          `INSERT INTO triage_records (id, facility_id, patient_id, encounter_id, level, chief_complaint, notes,
             triaged_by, previous_level, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [crypto.randomUUID(), current.facility_id, current.patient_id, encounterId, b.level, current.chief_complaint,
            current.notes, auth.user.id, current.level, b.reason, current.status],
        );
        await db.query(`UPDATE triage_records SET status = 'in_treatment' WHERE id = $1`, [current.id]);
        await db.query(`UPDATE encounters SET triage_level = $1 WHERE id = $2`, [b.level, encounterId]);
        return { ok: true, from: current.level, to: b.level };
      },
      (r) => ({
        action: 'emergency.retriage',
        entityType: 'encounter',
        entityId: encounterId,
        reason: b.reason,
        detail: { from: r.from, to: r.to },
        ip: req.ip,
      }),
    );
  });

  // --------------------------------------------------------------- Status ----
  app.post('/api/emergency/visits/:encounterId/status', async (req) => {
    const auth = requireAuth(req);
    requireTriage(auth);
    const { encounterId } = parse(z.object({ encounterId: zId }), req.params);
    const b = parse(z.object({ status: z.enum(['in_treatment', 'observation']) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const current = await loadTriage(db, encounterId);
        if (!['waiting', 'in_treatment', 'observation'].includes(current.status)) throw conflict('الزيارة منتهية');
        await db.query(`UPDATE triage_records SET status = $1 WHERE id = $2`, [b.status, current.id]);
        return { ok: true };
      },
      () => ({ action: 'emergency.status', entityType: 'encounter', entityId: encounterId, detail: { status: b.status }, ip: req.ip }),
    );
  });

  // ---------------------------------------------------------- Disposition ----
  app.post('/api/emergency/visits/:encounterId/disposition', async (req, reply) => {
    const auth = requireAuth(req);
    requireTriage(auth);
    const { encounterId } = parse(z.object({ encounterId: zId }), req.params);
    const b = parse(
      z.object({
        decision: z.enum(['admit', 'discharge', 'transfer', 'left_without_being_seen']),
        bedId: zId.optional(),
        wardId: zId.optional(),
        departmentId: zId.optional(),
        summary: z.string().min(10).max(3000).optional(),
        dischargeType: z.enum(['home', 'transfer', 'deceased', 'against_advice']).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const current = await loadTriage(db, encounterId);
        if (!['waiting', 'in_treatment', 'observation'].includes(current.status)) throw conflict('تم تسجيل قرار لهذه الزيارة مسبقًا');
        const patient = await loadPatientOr404(db, current.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'er_disposition' });

        if (b.decision === 'admit') {
          const created = await createAdmission(db, {
            facilityId: patient.facility_id,
            patientId: patient.id,
            userId: auth.user.id,
            bedId: b.bedId ?? null,
            wardId: b.wardId ?? null,
            departmentId: b.departmentId ?? null,
            reason: `تنويم من الطوارئ: ${current.chief_complaint}`,
            reuseEncounterId: encounterId,
          });
          await db.query(`UPDATE triage_records SET status = 'admitted', disposition_at = now() WHERE id = $1`, [current.id]);
          reply.code(201);
          return { decision: 'admit', admissionId: created.admissionId, admissionNo: created.admissionNo, bedId: created.bedId };
        }

        if (b.decision === 'discharge') {
          if (!b.summary || b.summary.length < 10) throw conflict('ملخص الخروج مطلوب لإنهاء زيارة الطوارئ');
          const fee = await priceFor(db, patient.facility_id, 'pricing.er_visit', 200);
          const charge = await ensureCharge(db, {
            facilityId: patient.facility_id,
            patientId: patient.id,
            encounterId,
            category: 'consultation',
            description: 'زيارة طوارئ',
            referenceType: 'encounter_er_visit',
            referenceId: encounterId,
            quantity: 1,
            unitPrice: fee,
            createdBy: auth.user.id,
          });
          await db.query(
            `INSERT INTO clinical_notes (id, facility_id, patient_id, encounter_id, note_type, assessment, plan, author_id, signed_at)
             VALUES ($1,$2,$3,$4,'discharge',$5,$6,$7, now())`,
            [crypto.randomUUID(), patient.facility_id, patient.id, encounterId, b.summary, 'تعليمات المتابعة مسجلة في الملخص', auth.user.id],
          );
          await db.query(
            `UPDATE encounters SET status = 'closed', closed_at = now(), disposition = $1 WHERE id = $2`,
            [b.dischargeType ?? 'home', encounterId],
          );
          await db.query(`UPDATE triage_records SET status = 'discharged', disposition_at = now() WHERE id = $1`, [current.id]);
          reply.code(200);
          return { decision: 'discharge', invoiceId: charge.invoiceId, fee };
        }

        if (b.decision === 'left_without_being_seen') {
          const reason = b.summary && b.summary.length >= 10 ? b.summary : 'غادر قبل التقييم الطبي (بدون ملاحظات إضافية)';
          await db.query(`UPDATE encounters SET status = 'closed', closed_at = now(), disposition = 'left_without_being_seen' WHERE id = $1`, [encounterId]);
          await db.query(`UPDATE triage_records SET status = 'left_without_being_seen', disposition_at = now(), reason = $1 WHERE id = $2`, [reason, current.id]);
          return { decision: 'left_without_being_seen' };
        }

        // transfer: closed with a documented referral; billing handled by the source invoice.
        if (!b.summary || b.summary.length < 10) throw conflict('سبب التحويل مطلوب');
        await db.query(`UPDATE encounters SET status = 'closed', closed_at = now(), disposition = 'transfer' WHERE id = $1`, [encounterId]);
        await db.query(`UPDATE triage_records SET status = 'transferred', disposition_at = now(), reason = $1 WHERE id = $2`, [b.summary, current.id]);
        return { decision: 'transfer' };
      },
      (r) => ({
        action: `emergency.disposition.${b.decision}`,
        entityType: 'encounter',
        entityId: encounterId,
        patientId: null,
        reason: b.summary ?? null,
        detail: { ...r, decision: b.decision },
        ip: req.ip,
      }),
    );
  });

  // --------------------------------------------------- Unidentified → merge --
  app.post('/api/emergency/patients/:id/identify', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.merge');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        targetPatientId: zId,
        evidence: z.string().min(10).max(500),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const source = await loadPatientOr404(db, id);
        if (source.identity_status !== 'unverified_temporary' || source.status === 'merged') {
          throw conflict('هذا السجل المؤقت تمت مطابقته مسبقًا أو ليس مجهول هوية');
        }
        const target = await loadPatientOr404(db, b.targetPatientId);
        if (target.id === source.id) throw conflict('لا يمكن المطابقة مع نفس السجل');
        const openSource = await db.query<{ id: string }>(`SELECT id FROM encounters WHERE patient_id = $1 AND status = 'open'`, [id]);
        if (openSource.rows[0]) throw conflict('أغلق زيارة الطوارئ المفتوحة قبل المطابقة');
        const moved: Record<string, number> = {};
        for (const table of [
          'appointments', 'encounters', 'vitals', 'clinical_notes', 'diagnoses', 'lab_orders', 'prescriptions',
          'invoices', 'patient_allergies', 'patient_conditions', 'consents', 'admissions', 'triage_records',
          'insurance_policies', 'critical_alerts',
        ]) {
          const res = await db.query(`UPDATE ${table} SET patient_id = $1 WHERE patient_id = $2`, [target.id, source.id]);
          moved[table] = res.rowCount;
        }
        await db.query(
          `UPDATE patients SET status = 'merged', duplicate_of_id = $1, version = version + 1, updated_at = now() WHERE id = $2`,
          [target.id, source.id],
        );
        return { mergedInto: target.id, moved };
      },
      (r) => ({
        action: 'patient.identity.match',
        entityType: 'patient',
        entityId: b.targetPatientId,
        patientId: b.targetPatientId,
        reason: b.evidence,
        detail: { temporaryPatientId: id, moved: r.moved },
        ip: req.ip,
      }),
    );
  });

  // ----------------------------------------------------------- ER billing ----
  app.post('/api/emergency/encounters/:encounterId/payment', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.payment.record');
    const { encounterId } = parse(z.object({ encounterId: zId }), req.params);
    const b = parse(z.object({ amount: z.number().positive(), method: z.enum(['cash', 'card', 'transfer', 'insurance', 'online']) }), req.body);
    return withTenant(auth, async (db) => {
      const invoice = await db.query<{ id: string; patient_id: string }>(
        `SELECT id, patient_id FROM invoices WHERE encounter_id = $1 AND status IN ('open','partially_paid') ORDER BY created_at DESC LIMIT 1`,
        [encounterId],
      );
      if (!invoice.rows[0]) throw notFound('لا توجد فاتورة مفتوحة لهذه الزيارة');
      const result = await applyPayment(db, invoice.rows[0].id, b.amount, b.method, null, auth.user.id);
      await writeAudit(db, {
        facilityId: auth.activeFacilityId,
        actorUserId: auth.user.id,
        actorRole: auth.roles[0]?.role_id ?? null,
        action: 'billing.payment.record',
        entityType: 'invoice',
        entityId: invoice.rows[0].id,
        patientId: invoice.rows[0].patient_id,
        detail: { amount: b.amount, method: b.method, source: 'emergency' },
        ip: req.ip,
      });
      reply.code(201);
      return result;
    });
  });
  void forbidden;
}
