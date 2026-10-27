import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';
import { normalize } from '../../lib/crypto';

async function encounterContext(db: any, encounterId: string) {
  const res = await db.query(
    `SELECT e.*, p.facility_id AS patient_facility, p.full_name_ar AS patient_name, p.mrn
       FROM encounters e JOIN patients p ON p.id = e.patient_id WHERE e.id = $1`,
    [encounterId],
  );
  const enc = res.rows[0];
  if (!enc) throw notFound('الزيارة غير موجودة');
  return enc;
}

const NoteSchema = z.object({
  subjective: z.string().max(5000).optional(),
  objective: z.string().max(5000).optional(),
  assessment: z.string().max(5000).optional(),
  plan: z.string().max(5000).optional(),
  sign: z.boolean().default(true),
});

export async function encounterRoutes(app: FastifyInstance) {
  app.post('/api/encounters', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.encounter.create');
    const body = parse(
      z.object({
        patientId: zId,
        appointmentId: zId.optional(),
        encounterType: z.enum(['outpatient', 'emergency', 'telemedicine']),
        departmentId: zId,
        chiefComplaint: z.string().max(500).optional(),
        triageLevel: z.number().int().min(1).max(5).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, body.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'encounter_create' });
        const open = await db.query(`SELECT id FROM encounters WHERE patient_id = $1 AND status = 'open' LIMIT 1`, [body.patientId]);
        if (open.rows[0]) throw conflict('يوجد زيارة مفتوحة لهذا المريض. أكملها قبل فتح زيارة جديدة.', { encounterId: open.rows[0].id });
        if (body.appointmentId) {
          const appt = await db.query<{ status: string; patient_id: string; doctor_id: string }>(`SELECT status, patient_id, doctor_id FROM appointments WHERE id = $1`, [body.appointmentId]);
          const a = appt.rows[0];
          if (!a) throw notFound('الموعد غير موجود');
          if (a.patient_id !== body.patientId) throw conflict('الموعد لا يخص هذا المريض');
          if (!['booked', 'checked_in'].includes(a.status)) throw conflict('لا يمكن بدء زيارة لهذا الموعد');
        }
        const id = crypto.randomUUID();
        const encounterNo = await nextDocumentNo(db, auth.activeFacilityId, 'encounter', 'ENC');
        await db.query(
          `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, appointment_id, encounter_type,
             department_id, doctor_id, chief_complaint, triage_level, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, auth.activeFacilityId, encounterNo, body.patientId, body.appointmentId ?? null, body.encounterType,
            body.departmentId, auth.user.id, body.chiefComplaint ?? null, body.triageLevel ?? null, auth.user.id],
        );
        if (body.appointmentId) {
          await db.query(`UPDATE appointments SET status = 'in_consultation', updated_at = now() WHERE id = $1`, [body.appointmentId]);
        }
        reply.code(201);
        return { id, encounterNo };
      },
      (r) => ({
        action: 'encounter.create',
        entityType: 'encounter',
        entityId: r.id,
        patientId: body.patientId,
        detail: { encounterNo: r.encounterNo, type: body.encounterType },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/encounters/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.encounter.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const enc = await encounterContext(db, id);
      const patient = await loadPatientOr404(db, enc.patient_id);
      const { basis } = await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'encounter_view' });
      const [vitals, notes, diagnoses, labs, prescriptions, allergies, invoices] = await Promise.all([
        db.query(`SELECT * FROM vitals WHERE encounter_id = $1 ORDER BY recorded_at DESC`, [id]),
        db.query(`SELECT n.*, u.full_name_ar AS author FROM clinical_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.encounter_id = $1 ORDER BY n.created_at DESC`, [id]),
        db.query(`SELECT * FROM diagnoses WHERE encounter_id = $1 ORDER BY created_at`, [id]),
        db.query(
          `SELECT lo.id, lo.order_no, lo.priority, lo.status, lo.ordered_at,
                  json_agg(json_build_object('id', li.id, 'testCode', li.test_code, 'status', li.status,
                    'barcode', li.specimen_barcode, 'verifiedAt', li.verified_at)) AS items
             FROM lab_orders lo JOIN lab_order_items li ON li.order_id = lo.id
            WHERE lo.encounter_id = $1 GROUP BY lo.id ORDER BY lo.ordered_at DESC`, [id]),
        db.query(
          `SELECT p.id, p.prescription_no, p.status, p.prescribed_at,
                  json_agg(json_build_object('id', pi.id, 'drugId', pi.drug_id, 'drug', dr.name_ar,
                    'dose', pi.dose, 'route', pi.route, 'frequency', pi.frequency, 'durationDays', pi.duration_days,
                    'quantity', pi.quantity, 'status', pi.status)) AS items
             FROM prescriptions p JOIN prescription_items pi ON pi.prescription_id = p.id
             JOIN drugs dr ON dr.id = pi.drug_id
            WHERE p.encounter_id = $1 GROUP BY p.id ORDER BY p.prescribed_at DESC`, [id]),
        db.query(`SELECT id, allergen, reaction, severity FROM patient_allergies WHERE patient_id = $1 AND is_active = true`, [enc.patient_id]),
        db.query(`SELECT id, invoice_no, status, total, paid_amount, currency FROM invoices WHERE encounter_id = $1 ORDER BY created_at DESC`, [id]),
      ]);
      return {
        encounter: {
          id: enc.id,
          encounterNo: enc.encounter_no,
          type: enc.encounter_type,
          status: enc.status,
          chiefComplaint: enc.chief_complaint,
          triageLevel: enc.triage_level,
          startedAt: enc.started_at,
          closedAt: enc.closed_at,
          disposition: enc.disposition,
          appointmentId: enc.appointment_id,
          patient: { id: patient.id, mrn: patient.mrn, nameAr: patient.full_name_ar, sex: patient.sex, dateOfBirth: patient.date_of_birth, bloodType: patient.blood_type },
          accessBasis: basis,
        },
        vitals: vitals.rows,
        notes: notes.rows,
        diagnoses: diagnoses.rows,
        labOrders: labs.rows,
        prescriptions: prescriptions.rows,
        allergies: allergies.rows,
        invoices: invoices.rows,
      };
    });
  });

  app.post('/api/encounters/:id/vitals', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.vitals.write');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        temperatureC: z.number().min(25).max(45).optional(),
        heartRate: z.number().int().min(20).max(250).optional(),
        respRate: z.number().int().min(4).max(80).optional(),
        systolicBp: z.number().int().min(40).max(300).optional(),
        diastolicBp: z.number().int().min(20).max(200).optional(),
        spo2: z.number().int().min(40).max(100).optional(),
        painScore: z.number().int().min(0).max(10).optional(),
        weightKg: z.number().min(1).max(400).optional(),
        heightCm: z.number().min(20).max(260).optional(),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        const patient = await loadPatientOr404(db, enc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'vitals_write' });
        const vitalsId = crypto.randomUUID();
        await db.query(
          `INSERT INTO vitals (id, facility_id, patient_id, encounter_id, recorded_by, temperature_c, heart_rate,
             resp_rate, systolic_bp, diastolic_bp, spo2, pain_score, weight_kg, height_cm, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [vitalsId, enc.facility_id, enc.patient_id, id, auth.user.id, b.temperatureC ?? null, b.heartRate ?? null,
            b.respRate ?? null, b.systolicBp ?? null, b.diastolicBp ?? null, b.spo2 ?? null, b.painScore ?? null,
            b.weightKg ?? null, b.heightCm ?? null, b.notes ?? null],
        );
        reply.code(201);
        return { id: vitalsId };
      },
      (r) => ({ action: 'vitals.record', entityType: 'encounter', entityId: id, patientId: null, detail: { vitalsId: r.id }, ip: req.ip }),
    );
  });

  app.post('/api/encounters/:id/notes', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.note.write');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(NoteSchema, req.body);
    if (!b.subjective && !b.objective && !b.assessment && !b.plan) throw conflict('الملاحظة فارغة');
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        const patient = await loadPatientOr404(db, enc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'note_write' });
        const noteId = crypto.randomUUID();
        await db.query(
          `INSERT INTO clinical_notes (id, facility_id, patient_id, encounter_id, note_type, subjective, objective,
             assessment, plan, author_id, signed_at)
           VALUES ($1,$2,$3,$4,'consultation',$5,$6,$7,$8,$9,$10)`,
          [noteId, enc.facility_id, enc.patient_id, id, b.subjective ?? null, b.objective ?? null, b.assessment ?? null,
            b.plan ?? null, auth.user.id, b.sign ? new Date().toISOString() : null],
        );
        reply.code(201);
        return { id: noteId };
      },
      (r) => ({ action: 'clinical.note.write', entityType: 'encounter', entityId: id, patientId: null, detail: { noteId: r.id }, ip: req.ip }),
    );
  });

  app.post('/api/encounters/:id/diagnoses', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.diagnose');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        icd10Code: z.string().min(3).max(10),
        description: z.string().min(2).max(250),
        type: z.enum(['primary', 'secondary']).default('primary'),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        const patient = await loadPatientOr404(db, enc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'diagnosis_write' });
        const dxId = crypto.randomUUID();
        await db.query(
          `INSERT INTO diagnoses (id, facility_id, patient_id, encounter_id, icd10_code, description, diagnosis_type, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [dxId, enc.facility_id, enc.patient_id, id, b.icd10Code, b.description, b.type, auth.user.id],
        );
        reply.code(201);
        return { id: dxId };
      },
      (r) => ({ action: 'diagnosis.record', entityType: 'encounter', entityId: id, patientId: null, detail: { icd10: b.icd10Code }, ip: req.ip }),
    );
  });

  app.post('/api/encounters/:id/lab-orders', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.order.create');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        tests: z.array(z.string().min(1)).min(1).max(20),
        priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
        clinicalNotes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        if (enc.status !== 'open') throw conflict('الزيارة مغلقة');
        const patient = await loadPatientOr404(db, enc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'lab_order' });
        const tests = await db.query(`SELECT code, name_ar, price FROM lab_tests WHERE code = ANY($1::text[])`, [b.tests]);
        if (tests.rows.length !== b.tests.length) throw notFound('أحد التحاليل المطلوبة غير معرّف');
        const orderId = crypto.randomUUID();
        const orderNo = await nextDocumentNo(db, enc.facility_id, 'lab_order', 'LAB');
        await db.query(
          `INSERT INTO lab_orders (id, facility_id, order_no, patient_id, encounter_id, ordered_by, priority, clinical_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [orderId, enc.facility_id, orderNo, enc.patient_id, id, auth.user.id, b.priority, b.clinicalNotes ?? null],
        );
        for (const t of tests.rows as any[]) {
          const itemId = crypto.randomUUID();
          await db.query(
            `INSERT INTO lab_order_items (id, facility_id, order_id, test_code, price) VALUES ($1,$2,$3,$4,$5)`,
            [itemId, enc.facility_id, orderId, t.code, t.price],
          );
          await ensureCharge(db, {
            facilityId: enc.facility_id,
            patientId: enc.patient_id,
            encounterId: id,
            category: 'lab',
            description: `تحليل ${t.name_ar}`,
            referenceType: 'lab_item',
            referenceId: itemId,
            quantity: 1,
            unitPrice: Number(t.price),
            createdBy: auth.user.id,
          });
        }
        await db.query(
          `INSERT INTO notifications_outbox (facility_id, channel, subject, body, patient_id, related_type, related_id)
           VALUES ($1,'in_app','طلب تحليل جديد',$2,$3,'lab_order',$4)`,
          [enc.facility_id, `طلب ${orderNo} (${b.priority})`, enc.patient_id, orderId],
        );
        reply.code(201);
        return { id: orderId, orderNo };
      },
      (r) => ({ action: 'lab.order.create', entityType: 'lab_order', entityId: r.id, patientId: null, detail: { tests: b.tests, priority: b.priority, orderNo: r.orderNo }, ip: req.ip }),
    );
  });

  app.post('/api/encounters/:id/prescriptions', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.prescription.create');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        items: z.array(z.object({
          drugId: zId,
          dose: z.string().min(1).max(60),
          route: z.string().min(1).max(30),
          frequency: z.string().min(1).max(60),
          durationDays: z.number().int().min(1).max(365),
          quantity: z.number().positive().max(10000),
          instructions: z.string().max(300).optional(),
        })).min(1).max(20),
        notes: z.string().max(500).optional(),
        allergyAcknowledged: z.boolean().default(false),
      }),
      req.body,
    );
    const allWarnings: { type: string; message: string }[] = [];
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        if (enc.status !== 'open') throw conflict('الزيارة مغلقة');
        const patient = await loadPatientOr404(db, enc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'prescribe' });
        const drugs = await db.query(`SELECT id, code, name_ar, name_en, price FROM drugs WHERE id = ANY($1::uuid[])`, [b.items.map((i) => i.drugId)]);
        if (drugs.rows.length !== b.items.length) throw notFound('أحد الأدوية غير معرّف');
        const allergies = await db.query<{ allergen: string }>(`SELECT allergen FROM patient_allergies WHERE patient_id = $1 AND is_active = true`, [enc.patient_id]);
        const warnings: { type: string; message: string }[] = [];
        for (const drug of drugs.rows as any[]) {
          for (const a of allergies.rows) {
            const allergen = normalize(a.allergen);
            if (allergen.length > 2 && (normalize(drug.name_ar).includes(allergen) || normalize(drug.name_en).includes(allergen))) {
              warnings.push({ type: 'allergy', message: `تحذير حساسية: ${drug.name_ar} يتقاطع مع حساسية مسجلة (${a.allergen})` });
            }
          }
        }
        allWarnings.push(...warnings);
        if (warnings.length > 0 && !b.allergyAcknowledged) {
          throw conflict('تحذيرات حساسية تتطلب مراجعة وتأكيدًا موثقًا', { warnings, requiresAcknowledgement: true });
        }
        const rxId = crypto.randomUUID();
        const rxNo = await nextDocumentNo(db, enc.facility_id, 'prescription', 'RX');
        await db.query(
          `INSERT INTO prescriptions (id, facility_id, prescription_no, patient_id, encounter_id, prescribed_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [rxId, enc.facility_id, rxNo, enc.patient_id, id, auth.user.id, b.notes ?? null],
        );
        for (const item of b.items) {
          const drug = (drugs.rows as any[]).find((d) => d.id === item.drugId);
          await db.query(
            `INSERT INTO prescription_items (id, facility_id, prescription_id, drug_id, dose, route, frequency,
               duration_days, quantity, instructions, price)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [crypto.randomUUID(), enc.facility_id, rxId, item.drugId, item.dose, item.route, item.frequency,
              item.durationDays, item.quantity, item.instructions ?? null, Number(drug?.price ?? 0)],
          );
        }
        await db.query(
          `INSERT INTO notifications_outbox (facility_id, channel, subject, body, patient_id, related_type, related_id)
           VALUES ($1,'in_app','وصفة جديدة',$2,$3,'prescription',$4)`,
          [enc.facility_id, `وصفة ${rxNo}`, enc.patient_id, rxId],
        );
        reply.code(201);
        return { id: rxId, prescriptionNo: rxNo, warnings };
      },
      (r) => ({
        action: 'prescription.create', entityType: 'prescription', entityId: r.id, patientId: null,
        reason: allWarnings.length ? `تم تأكيد تحذيرات الحساسية: ${allWarnings.map((w) => w.message).join(' | ')}` : null,
        detail: { prescriptionNo: r.prescriptionNo }, ip: req.ip,
      }),
    );
  });

  app.post('/api/encounters/:id/close', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.encounter.create');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ disposition: z.string().min(2).max(200), followUpDays: z.number().int().min(0).max(365).optional() }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await encounterContext(db, id);
        if (enc.status !== 'open') throw conflict('الزيارة مغلقة مسبقًا');
        await authorizeChartAccess(db, auth, { ...(await loadPatientOr404(db, enc.patient_id)) }, 'clinical', { ip: req.ip, accessType: 'encounter_close' });
        const pending = await db.query<{ count: string }>(
          `SELECT count(*) FROM lab_order_items li JOIN lab_orders lo ON lo.id = li.order_id
            WHERE lo.encounter_id = $1 AND li.status IN ('ordered','collected','resulted')`,
          [id],
        );
        const pendingRx = await db.query<{ count: string }>(
          `SELECT count(*) FROM prescription_items pi JOIN prescriptions p ON p.id = pi.prescription_id
            WHERE p.encounter_id = $1 AND pi.status = 'pending'`,
          [id],
        );
        await db.query(`UPDATE encounters SET status = 'closed', closed_at = now(), disposition = $1 WHERE id = $2`, [b.disposition, id]);
        if (enc.appointment_id) {
          await db.query(`UPDATE appointments SET status = 'completed', updated_at = now() WHERE id = $1 AND status IN ('in_consultation','checked_in')`, [enc.appointment_id]);
        }
        const feeRow = await db.query<{ value: { amount: number } }>(
          `SELECT value FROM app_settings WHERE facility_id = $1 AND key = 'pricing.consultation'`,
          [enc.facility_id],
        );
        const fee = Number(feeRow.rows[0]?.value?.amount ?? 150);
        const charge = await ensureCharge(db, {
          facilityId: enc.facility_id,
          patientId: enc.patient_id,
          encounterId: id,
          category: 'consultation',
          description: 'أتعاب استشارة طبية',
          referenceType: 'encounter_consultation',
          referenceId: id,
          quantity: 1,
          unitPrice: fee,
          createdBy: auth.user.id,
        });
        return {
          ok: true,
          invoiceId: charge.invoiceId,
          pendingLabItems: Number(pending.rows[0]?.count ?? 0),
          pendingPrescriptionItems: Number(pendingRx.rows[0]?.count ?? 0),
        };
      },
      (r) => ({
        action: 'encounter.close', entityType: 'encounter', entityId: id, patientId: null,
        detail: { disposition: b.disposition, invoiceId: r.invoiceId, pendingLabItems: r.pendingLabItems, pendingRx: r.pendingPrescriptionItems }, ip: req.ip,
      }),
    );
  });
}
