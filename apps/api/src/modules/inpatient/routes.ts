import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';

const ADMIT_ROLES = new Set(['physician', 'department_manager']);

async function loadAdmission(db: any, id: string) {
  const res: any = await db.query(
    `SELECT a.*, p.full_name_ar AS patient_name, p.mrn, u.full_name_ar AS doctor_name,
            b.bed_no, r.room_no, w.name_ar AS ward_name, e.encounter_no
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       JOIN users u ON u.id = a.attending_doctor_id
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN wards w ON w.id = b.ward_id
       JOIN encounters e ON e.id = a.encounter_id
      WHERE a.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('التنويم غير موجود');
  return row;
}

export async function inpatientRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ Beds ----
  app.get('/api/inpatient/beds', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.bed.manage');
    return withTenant(auth, async (db) => {
      const rows = await db.query<any>(
        `SELECT b.id, b.bed_no, b.status AS bed_status, r.room_no, r.room_type, w.id AS ward_id,
                w.name_ar AS ward_name, w.ward_type,
                a.id AS admission_id, p.full_name_ar AS patient_name, p.mrn, a.admitted_at
           FROM beds b
           JOIN rooms r ON r.id = b.room_id
           JOIN wards w ON w.id = b.ward_id
           LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'active'
           LEFT JOIN patients p ON p.id = a.patient_id
          WHERE b.facility_id = $1
          ORDER BY w.name_ar, r.room_no, b.bed_no`,
        [auth.activeFacilityId],
      );
      const wards = await db.query(`SELECT id, name_ar, ward_type FROM wards WHERE facility_id = $1 AND is_active = true ORDER BY name_ar`, [auth.activeFacilityId]);
      const summary = await db.query<any>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'occupied')::int AS occupied,
                count(*) FILTER (WHERE status = 'available')::int AS available,
                count(*) FILTER (WHERE status = 'cleaning')::int AS cleaning,
                count(*) FILTER (WHERE status = 'maintenance')::int AS maintenance
           FROM beds WHERE facility_id = $1`,
        [auth.activeFacilityId],
      );
      return { beds: rows.rows, wards: wards.rows, summary: summary.rows[0] };
    });
  });

  app.patch('/api/inpatient/beds/:id/status', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.bed.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ status: z.enum(['available', 'cleaning', 'maintenance']) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const bed = await db.query<{ status: string }>('SELECT status FROM beds WHERE id = $1', [id]);
        if (!bed.rows[0]) throw notFound('السرير غير موجود');
        if (bed.rows[0].status === 'occupied') throw conflict('لا يمكن تغيير حالة سرير مشغول — يجب خروج المريض أولًا');
        await db.query('UPDATE beds SET status = $1 WHERE id = $2', [b.status, id]);
        return { ok: true, status: b.status };
      },
      () => ({ action: 'bed.status.change', entityType: 'bed', entityId: id, detail: { status: b.status }, ip: req.ip }),
    );
  });

  // ------------------------------------------------------------ Admissions ----
  app.get('/api/inpatient/admissions', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.admit');
    return withTenant(auth, async (db) => {
      const rows = await db.query<any>(
        `SELECT a.id, a.admission_no, a.status, a.admitted_at, a.discharged_at, a.discharge_type,
                p.full_name_ar AS patient_name, p.mrn, w.name_ar AS ward_name, r.room_no, b.bed_no,
                u.full_name_ar AS doctor_name
           FROM admissions a
           JOIN patients p ON p.id = a.patient_id
           JOIN users u ON u.id = a.attending_doctor_id
           LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
          WHERE a.facility_id = $1
          ORDER BY (a.status = 'active') DESC, a.admitted_at DESC LIMIT 100`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/api/inpatient/admissions/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.admit');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const admission = await loadAdmission(db, id);
      const patient = await loadPatientOr404(db, admission.patient_id);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'admission_view' });
      const transfers = await db.query(
        `SELECT t.*, fb.bed_no AS from_bed, tb.bed_no AS to_bed, u.full_name_ar AS by_name
           FROM bed_transfers t LEFT JOIN beds fb ON fb.id = t.from_bed_id
           LEFT JOIN beds tb ON tb.id = t.to_bed_id
           LEFT JOIN users u ON u.id = t.transferred_by
          WHERE t.admission_id = $1 ORDER BY t.transferred_at`,
        [id],
      );
      return { admission, transfers: transfers.rows };
    });
  });

  app.post('/api/inpatient/admissions', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.admit');
    const b = parse(
      z.object({
        patientId: zId,
        bedId: zId.optional(),
        wardId: zId.optional(),
        departmentId: zId.optional(),
        attendingDoctorId: zId.optional(),
        reason: z.string().min(3).max(500),
      }),
      req.body,
    );
    if (!ADMIT_ROLES.has(auth.roles[0]?.role_id ?? '')) {
      // Reception/accounting may not create admissions; a clinician order is required.
      throw forbidden('التنويم يتطلب صلاحية سريرية (طبيب/مدير قسم)');
    }
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, b.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'admit' });
        const existing = await db.query(`SELECT id FROM admissions WHERE patient_id = $1 AND status = 'active'`, [b.patientId]);
        if (existing.rows[0]) throw conflict('المريض منوّم بالفعل', { admissionId: existing.rows[0].id });

        let bedId: string | null = b.bedId ?? null;
        if (bedId) {
          const bed = await db.query<{ status: string; ward_id: string }>('SELECT status, ward_id FROM beds WHERE id = $1', [bedId]);
          if (!bed.rows[0]) throw notFound('السرير غير موجود');
          if (bed.rows[0].status !== 'available') throw conflict(`السرير غير متاح حاليًا (${bed.rows[0].status})`);
        } else if (b.wardId) {
          const free = await db.query<{ id: string }>(
            `SELECT id FROM beds WHERE ward_id = $1 AND status = 'available' ORDER BY bed_no LIMIT 1 FOR UPDATE`,
            [b.wardId],
          );
          if (!free.rows[0]) throw conflict('لا يوجد سرير متاح في الجناح المحدد');
          bedId = free.rows[0].id;
        }

        // Resolve the inpatient department server-side when the client omits it.
        let departmentId = b.departmentId ?? null;
        if (!departmentId) {
          const dept = await db.query<{ id: string }>(
            `SELECT id FROM departments WHERE facility_id = $1 AND is_active = true
              ORDER BY (dept_type = 'inpatient') DESC, name_ar LIMIT 1`,
            [patient.facility_id],
          );
          departmentId = dept.rows[0]?.id ?? null;
        }
        if (!departmentId) throw conflict('لا يوجد قسم متاح لتسجيل التنويم');

        // Inpatient encounter (separate from any outpatient visit).
        const encounterId = crypto.randomUUID();
        const encounterNo = await nextDocumentNo(db, patient.facility_id, 'encounter', 'ENC');
        await db.query(
          `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
             status, chief_complaint, created_by)
           VALUES ($1,$2,$3,$4,'inpatient',$5,$6,'open',$7,$8)`,
          [encounterId, patient.facility_id, encounterNo, b.patientId, departmentId,
            b.attendingDoctorId ?? auth.user.id, b.reason, auth.user.id],
        );
        const visit = await db.query<{ value: { amount: number } }>(
          `SELECT value FROM app_settings WHERE facility_id = $1 AND key = 'pricing.consultation'`,
          [patient.facility_id],
        );
        await ensureCharge(db, {
          facilityId: patient.facility_id,
          patientId: b.patientId,
          encounterId,
          category: 'consultation',
          description: 'تقييم تنويم',
          referenceType: 'encounter_consultation',
          referenceId: encounterId,
          quantity: 1,
          unitPrice: Number(visit.rows[0]?.value?.amount ?? 150),
          createdBy: auth.user.id,
        });

        const admissionId = crypto.randomUUID();
        const admissionNo = await nextDocumentNo(db, patient.facility_id, 'admission', 'ADM');
        await db.query(
          `INSERT INTO admissions (id, facility_id, admission_no, patient_id, encounter_id, bed_id,
             attending_doctor_id, admitted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [admissionId, patient.facility_id, admissionNo, b.patientId, encounterId, bedId,
            b.attendingDoctorId ?? auth.user.id, auth.user.id],
        );
        if (bedId) {
          await db.query(`UPDATE beds SET status = 'occupied' WHERE id = $1`, [bedId]);
        }
        reply.code(201);
        return { id: admissionId, admissionNo, encounterId, bedId };
      },
      (r) => ({
        action: 'inpatient.admit',
        entityType: 'admission',
        entityId: r.id,
        patientId: b.patientId,
        reason: b.reason,
        detail: { admissionNo: r.admissionNo, bedId: r.bedId, encounterId: r.encounterId },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inpatient/admissions/:id/transfer', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.bed.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ toBedId: zId, reason: z.string().min(3).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await loadAdmission(db, id);
        if (admission.status !== 'active') throw conflict('لا يمكن نقل تنويم غير نشط');
        const target = await db.query<{ status: string }>('SELECT status FROM beds WHERE id = $1', [b.toBedId]);
        if (!target.rows[0]) throw notFound('السرير الهدف غير موجود');
        if (target.rows[0].status !== 'available') throw conflict('السرير الهدف غير متاح');
        if (admission.bed_id === b.toBedId) throw conflict('المريض في هذا السرير بالفعل');
        await db.query(
          `INSERT INTO bed_transfers (id, facility_id, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [crypto.randomUUID(), admission.facility_id, id, admission.bed_id, b.toBedId, b.reason, auth.user.id],
        );
        await db.query(`UPDATE admissions SET bed_id = $1 WHERE id = $2`, [b.toBedId, id]);
        await db.query(`UPDATE beds SET status = 'cleaning' WHERE id = $1`, [admission.bed_id]);
        await db.query(`UPDATE beds SET status = 'occupied' WHERE id = $1`, [b.toBedId]);
        return { ok: true };
      },
      (r) => ({ action: 'inpatient.transfer', entityType: 'admission', entityId: id, reason: b.reason, detail: { toBedId: b.toBedId }, ip: req.ip }),
    );
  });

  app.post('/api/inpatient/admissions/:id/discharge', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inpatient.discharge');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        dischargeType: z.enum(['home', 'transfer', 'deceased', 'against_advice']),
        summary: z.string().min(20, 'ملخص الخروج مطلوب (20 حرفًا على الأقل)').max(5000),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await loadAdmission(db, id);
        if (admission.status !== 'active') throw conflict('التنويم منتهٍ بالفعل');
        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'discharge' });

        const now = new Date();
        const days = Math.max(1, Math.ceil((now.getTime() - new Date(admission.admitted_at).getTime()) / 86_400_000));
        const rate = await db.query<{ value: { amount: number } }>(
          `SELECT value FROM app_settings WHERE facility_id = $1 AND key = 'pricing.bed_day'`,
          [admission.facility_id],
        );
        const perDay = Number(rate.rows[0]?.value?.amount ?? 400);
        await ensureCharge(db, {
          facilityId: admission.facility_id,
          patientId: admission.patient_id,
          encounterId: admission.encounter_id,
          category: 'bed',
          description: `إقامة ${days} يوم (${admission.ward_name ?? 'جناح'})`,
          referenceType: 'admission_bed_days',
          referenceId: id,
          quantity: days,
          unitPrice: perDay,
          createdBy: auth.user.id,
        });

        await db.query(
          `UPDATE admissions SET status = 'discharged', discharged_at = now(), discharge_type = $1, discharge_summary = $2 WHERE id = $3`,
          [b.dischargeType, b.summary, id],
        );
        await db.query(
          `INSERT INTO clinical_notes (id, facility_id, patient_id, encounter_id, note_type, assessment, plan, author_id, signed_at)
           VALUES ($1,$2,$3,$4,'discharge',$5,$6,$7, now())`,
          [crypto.randomUUID(), admission.facility_id, admission.patient_id, admission.encounter_id, b.summary, 'تعليمات ما بعد الخروج مسجلة في الملخص', auth.user.id],
        );
        await db.query(`UPDATE encounters SET status = 'closed', closed_at = now(), disposition = $1 WHERE id = $2`, ['خروج من التنويم', admission.encounter_id]);
        if (admission.bed_id) {
          await db.query(`UPDATE beds SET status = 'cleaning' WHERE id = $1`, [admission.bed_id]);
        }
        return { ok: true, bedDays: days, bedCharge: days * perDay, patientId: admission.patient_id };
      },
      (r) => ({
        action: 'inpatient.discharge',
        entityType: 'admission',
        entityId: id,
        patientId: r.patientId,
        reason: b.summary.slice(0, 200),
        detail: { dischargeType: b.dischargeType, bedDays: r.bedDays, bedCharge: r.bedCharge },
        ip: req.ip,
      }),
    );
  });
}
