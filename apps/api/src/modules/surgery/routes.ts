import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId, zDateTime } from '../../lib/validation';
import { requireAuth, requirePermission, hasPermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';

/**
 * Operating theatre module: scheduling, the WHO surgical safety checklist,
 * intra-operative anaesthesia observations and post-anaesthesia recovery.
 *
 * Safety rules enforced server-side:
 *  - a theatre cannot hold two overlapping operations;
 *  - sign-in and time-out require every mandatory item to be confirmed;
 *  - the operation cannot start before both checklists exist;
 *  - instrument/sponge/needle counts are recorded at close; a mismatch blocks
 *    closure unless an explicit discrepancy note is written, and stays flagged;
 *  - checklist, anaesthesia and recovery records are append-only, and a closed
 *    case cannot be modified (also enforced by database triggers).
 */

const PHASES = ['sign_in', 'time_out', 'sign_out'] as const;

/** Mandatory WHO checklist items per phase, with their Arabic labels. */
export const CHECKLIST_ITEMS: Record<string, { key: string; label: string }[]> = {
  sign_in: [
    { key: 'identity_confirmed', label: 'تأكيد هوية المريض والموقع الجراحي' },
    { key: 'consent_signed', label: 'الموافقة الجراحية موقعة ومرفقة' },
    { key: 'site_marked', label: 'تحديد موضع العملية على المريض' },
    { key: 'allergies_checked', label: 'مراجعة الحساسية والتحذيرات' },
    { key: 'airway_risk_assessed', label: 'تقييم خطر مجرى الهواء والشفط' },
    { key: 'blood_available', label: 'تأكيد توفر الدم/المحاليل المطلوبة' },
    { key: 'imaging_displayed', label: 'عرض صور الأشعة والفحوص اللازمة' },
  ],
  time_out: [
    { key: 'team_introduced', label: 'تعريف جميع أعضاء الفريق بأدوارهم' },
    { key: 'patient_procedure_confirmed', label: 'تأكيد المريض والإجراء والموضع بصوت مسموع' },
    { key: 'antibiotics_given', label: 'إعطاء المضاد الحيوي الوقائي قبل الشق' },
    { key: 'sterile_field_confirmed', label: 'تأكيد جاهزية الحقل المعقم' },
    { key: 'critical_events_planned', label: 'مناقشة الخطوات الحرجة وخطر فقد الدم' },
    { key: 'imaging_displayed', label: 'الصور والفحوص معروضة أمام الفريق' },
  ],
  sign_out: [
    { key: 'procedure_recorded', label: 'تسجيل اسم الإجراء كما أُجري' },
    { key: 'counts_confirmed', label: 'تأكيد عدّ الأدوات والكمامات والإبر' },
    { key: 'specimens_labelled', label: 'وسم العينات المرسلة للمختبر' },
    { key: 'equipment_problems', label: 'تسجيل أي أعطال أو مشكلات في الأجهزة' },
    { key: 'recovery_plan', label: 'خطة النقل إلى الإفاقة والتعليمات' },
  ],
};

const CASE_STATUS_AR: Record<string, string> = {
  scheduled: 'مجدولة',
  prepared: 'جاهزة (تم التحقق)',
  in_progress: 'قيد العملية',
  recovery: 'في الإفاقة',
  completed: 'مكتملة',
  cancelled: 'ملغاة',
};

function checklistKey(phase: string) {
  return CHECKLIST_ITEMS[phase] ?? [];
}

function assertPhaseItems(phase: string, items: Record<string, boolean>) {
  const required = checklistKey(phase);
  const missing = required.filter((i) => items[i.key] !== true).map((i) => ({ key: i.key, label: i.label }));
  if (missing.length > 0) {
    throw conflict('لا يمكن إتمام قائمة التحقق قبل تأكيد كل البنود الإلزامية', { missing, phase });
  }
}

async function loadCase(db: any, id: string) {
  const res = await db.query(
    `SELECT c.*, p.mrn, p.full_name_ar AS patient_name, p.date_of_birth, p.blood_type,
            e.encounter_no, e.status AS encounter_status,
            t.name_ar AS theatre_name, t.code AS theatre_code,
            s.full_name_ar AS surgeon_name, a.full_name_ar AS anesthesiologist_name
       FROM surgical_cases c
       JOIN patients p ON p.id = c.patient_id
       JOIN encounters e ON e.id = c.encounter_id
       JOIN operating_theatres t ON t.id = c.theatre_id
       JOIN users s ON s.id = c.surgeon_id
       LEFT JOIN users a ON a.id = c.anesthesiologist_id
      WHERE c.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('العملية الجراحية غير موجودة');
  return row;
}

async function caseDetail(db: any, id: string) {
  const row = await loadCase(db, id);
  const [checklists, anesthesia, pacu] = await Promise.all([
    db.query('SELECT * FROM surgical_checklists WHERE case_id = $1 ORDER BY completed_at', [id]),
    db.query(
      `SELECT r.*, u.full_name_ar AS recorded_by_name FROM anesthesia_records r
         JOIN users u ON u.id = r.recorded_by WHERE r.case_id = $1 ORDER BY r.recorded_at`,
      [id],
    ),
    db.query(
      `SELECT r.*, u.full_name_ar AS recorded_by_name FROM pacu_records r
         JOIN users u ON u.id = r.recorded_by WHERE r.case_id = $1`,
      [id],
    ),
  ]);
  return {
    ...row,
    status_ar: CASE_STATUS_AR[row.status] ?? row.status,
    checklists: checklists.rows.map((c: any) => ({
      ...c,
      required: checklistKey(c.phase),
    })),
    anesthesia: anesthesia.rows,
    pacu: pacu.rows[0] ?? null,
  };
}

async function priceSetting(db: any, facilityId: string, key: string, fallback: number) {
  const row = await db.query(`SELECT value FROM app_settings WHERE facility_id = $1 AND key = $2`, [facilityId, key]);
  return Number(row.rows[0]?.value?.amount ?? fallback);
}

export async function surgeryRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- Theatres ----
  app.get('/api/surgery/theatres', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.read');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT id, code, name_ar, is_active FROM operating_theatres
          WHERE is_active = true ORDER BY code`,
      );
      return { items: rows.rows };
    });
  });

  // -------------------------------------------------------------- Booking ----
  app.post('/api/surgery/cases', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.schedule');
    const body = parse(
      z.object({
        patientId: zId,
        encounterId: zId,
        admissionId: zId.optional(),
        theatreId: zId,
        procedureName: z.string().min(3).max(200),
        procedureCode: z.string().max(20).optional(),
        laterality: z.enum(['none', 'left', 'right', 'bilateral']).default('none'),
        priority: z.enum(['elective', 'urgent', 'emergency']).default('elective'),
        anesthesiaType: z.enum(['general', 'regional', 'local', 'sedation', 'none']).default('general'),
        surgeonId: zId.optional(),
        anesthesiologistId: zId.optional(),
        scheduledAt: zDateTime,
        estimatedMinutes: z.number().int().min(15).max(720).default(60),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, body.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'surgery_schedule' });

        const enc = await db.query<any>('SELECT * FROM encounters WHERE id = $1', [body.encounterId]);
        const encounter = enc.rows[0];
        if (!encounter) throw notFound('الزيارة غير موجودة');
        if (encounter.patient_id !== body.patientId) throw conflict('الزيارة لا تخص هذا المريض');
        if (encounter.status !== 'open') throw conflict('لا يمكن جدولة عملية على زيارة مغلقة');

        const theatre = await db.query<any>('SELECT * FROM operating_theatres WHERE id = $1 AND is_active = true', [body.theatreId]);
        if (!theatre.rows[0]) throw notFound('غرفة العمليات غير موجودة أو غير مفعّلة');

        if (body.admissionId) {
          const adm = await db.query<any>('SELECT * FROM admissions WHERE id = $1', [body.admissionId]);
          if (!adm.rows[0]) throw notFound('التنويم غير موجود');
          if (adm.rows[0].patient_id !== body.patientId) throw conflict('التنويم لا يخص هذا المريض');
          if (adm.rows[0].status !== 'active') throw conflict('لا يمكن جدولة عملية على تنويم مغلق');
        }

        const surgeonId = body.surgeonId ?? auth.user.id;
        const surgeon = await db.query<any>(
          `SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $2
            WHERE u.id = $1 AND u.is_active = true`,
          [surgeonId, auth.activeFacilityId],
        );
        if (!surgeon.rows[0]) throw notFound('الجراح غير موجود في هذه المنشأة');
        if (body.anesthesiologistId) {
          const an = await db.query<any>(
            `SELECT u.id FROM users u
               JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $2
              WHERE u.id = $1 AND u.is_active = true`,
            [body.anesthesiologistId, auth.activeFacilityId],
          );
          if (!an.rows[0]) throw notFound('طبيب التخدير غير موجود في هذه المنشأة');
        }

        const start = new Date(body.scheduledAt);
        if (Number.isNaN(start.getTime())) throw conflict('وقت العملية غير صالح');
        // Overlap test: [start, start+duration) against every live case in the theatre.
        const overlap = await db.query<any>(
          `SELECT case_no FROM surgical_cases
            WHERE theatre_id = $1 AND status NOT IN ('cancelled','completed')
              AND scheduled_at < $2::timestamptz + make_interval(mins => $3::int)
              AND scheduled_at + make_interval(mins => estimated_minutes::int) > $2::timestamptz
            LIMIT 1`,
          [body.theatreId, start.toISOString(), body.estimatedMinutes],
        );
        if (overlap.rows[0]) {
          throw conflict(`غرفة العمليات مشغولة في هذا الوقت (${overlap.rows[0].case_no})`, {
            theatreId: body.theatreId,
            scheduledAt: start.toISOString(),
          });
        }

        const caseNo = await nextDocumentNo(db, auth.activeFacilityId, 'surgery', 'SUR');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO surgical_cases (id, facility_id, case_no, patient_id, encounter_id, admission_id, theatre_id,
             procedure_name, procedure_code, laterality, priority, anesthesia_type, surgeon_id, anesthesiologist_id,
             scheduled_at, estimated_minutes, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [id, auth.activeFacilityId, caseNo, body.patientId, body.encounterId, body.admissionId ?? null, body.theatreId,
            body.procedureName, body.procedureCode ?? null, body.laterality, body.priority, body.anesthesiaType,
            surgeonId, body.anesthesiologistId ?? null, start.toISOString(), body.estimatedMinutes, body.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, caseNo, status: 'scheduled', scheduledAt: start.toISOString(), theatre: theatre.rows[0].name_ar };
      },
      (r) => ({
        action: 'surgery.schedule',
        entityType: 'surgical_case',
        entityId: r.id,
        patientId: body.patientId,
        detail: { caseNo: r.caseNo, procedure: body.procedureName, theatreId: body.theatreId, priority: body.priority },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- Board ----
  app.get('/api/surgery/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.read');
    const q = parse(
      z.object({
        status: z.enum(['active', 'all', 'scheduled', 'prepared', 'in_progress', 'recovery', 'completed', 'cancelled']).default('active'),
      }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const params: any[] = [auth.activeFacilityId];
      let filter = '';
      if (q.status === 'active') filter = ` AND c.status IN ('scheduled','prepared','in_progress','recovery')`;
      else if (q.status !== 'all') {
        params.push(q.status);
        filter = ` AND c.status = $${params.length}`;
      }
      const rows = await db.query(
        `SELECT c.id, c.case_no, c.procedure_name, c.priority, c.status, c.scheduled_at, c.estimated_minutes,
                c.anesthesia_type, c.counts_correct, c.started_at, c.closed_at,
                p.mrn, p.full_name_ar AS patient_name,
                t.name_ar AS theatre_name, s.full_name_ar AS surgeon_name,
                a.full_name_ar AS anesthesiologist_name,
                (SELECT count(*)::int FROM surgical_checklists sc
                  WHERE sc.case_id = c.id AND sc.phase IN ('sign_in','time_out')) AS preop_checks,
                (SELECT count(*)::int FROM anesthesia_records ar WHERE ar.case_id = c.id) AS observations,
                EXISTS (SELECT 1 FROM pacu_records pr WHERE pr.case_id = c.id) AS in_recovery
           FROM surgical_cases c
           JOIN patients p ON p.id = c.patient_id
           JOIN operating_theatres t ON t.id = c.theatre_id
           JOIN users s ON s.id = c.surgeon_id
           LEFT JOIN users a ON a.id = c.anesthesiologist_id
          WHERE c.facility_id = $1${filter}
          ORDER BY CASE c.status WHEN 'in_progress' THEN 0 WHEN 'recovery' THEN 1
                                 WHEN 'prepared' THEN 2 WHEN 'scheduled' THEN 3 ELSE 4 END,
                   c.scheduled_at`,
        params,
      );
      const totals = await db.query<{ in_progress: number; recovery: number; scheduled: number; completed_today: number }>(
        `SELECT count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
                count(*) FILTER (WHERE status = 'recovery')::int AS recovery,
                count(*) FILTER (WHERE status IN ('scheduled','prepared'))::int AS scheduled,
                count(*) FILTER (WHERE status = 'completed' AND completed_at::date = now()::date)::int AS completed_today
           FROM surgical_cases WHERE facility_id = $1`,
        [auth.activeFacilityId],
      );
      return {
        items: rows.rows.map((r: any) => ({ ...r, status_ar: CASE_STATUS_AR[r.status] ?? r.status })),
        totals: totals.rows[0],
        checklist: CHECKLIST_ITEMS,
      };
    });
  });

  app.get('/api/surgery/cases/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const detail = await caseDetail(db, id);
      const patient = await loadPatientOr404(db, detail.patient_id);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'surgery_case_view' });
      return detail;
    });
  });

  // ----------------------------------------------------------- Checklists ----
  app.post('/api/surgery/cases/:id/checklists', async (req, reply) => {
    const auth = requireAuth(req);
    if (!hasPermission(auth, 'surgery.checklist') && !hasPermission(auth, 'surgery.perform') && !hasPermission(auth, 'anesthesia.perform')) {
      throw forbidden('لا تملك صلاحية إتمام قوائم التحقق الجراحية');
    }
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        phase: z.enum(['sign_in', 'time_out']),
        items: z.record(z.boolean()),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        const patient = await loadPatientOr404(db, c.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'surgery_checklist' });
        if (body.phase === 'sign_in' && c.status !== 'scheduled') {
          throw conflict('قائمة التحقق قبل التخدير تُسجَّل مرة واحدة قبل بدء العملية');
        }
        if (body.phase === 'time_out' && c.status !== 'prepared') {
          throw conflict('قائمة التحقق قبل الشق تتطلب إتمام قائمة ما قبل التخدير أولًا');
        }
        assertPhaseItems(body.phase, body.items);
        const exists = await db.query(`SELECT id FROM surgical_checklists WHERE case_id = $1 AND phase = $2`, [id, body.phase]);
        if (exists.rows[0]) throw conflict('قائمة التحقق مسجّلة مسبقًا ولا يمكن تعديلها');
        await db.query(
          `INSERT INTO surgical_checklists (id, facility_id, case_id, phase, items, completed_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [crypto.randomUUID(), c.facility_id, id, body.phase, JSON.stringify(body.items), auth.user.id, body.notes ?? null],
        );
        if (body.phase === 'sign_in') {
          await db.query(`UPDATE surgical_cases SET status = 'prepared' WHERE id = $1`, [id]);
        }
        reply.code(201);
        return { caseId: id, phase: body.phase, status: body.phase === 'sign_in' ? 'prepared' : c.status };
      },
      (r) => ({
        action: `surgery.${r.phase}`,
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, phase: r.phase },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- Start ----
  app.post('/api/surgery/cases/:id/start', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        const patient = await loadPatientOr404(db, c.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'surgery_start' });
        if (c.encounter_status !== 'open') throw conflict('لا يمكن بدء عملية على زيارة مغلقة');
        if (c.status !== 'prepared') throw conflict('لا يمكن بدء العملية قبل تسجيل قائمتي التحقق (قبل التخدير وقبل الشق)');
        const checks = await db.query<{ phase: string }>(
          `SELECT phase FROM surgical_checklists WHERE case_id = $1 AND phase IN ('sign_in','time_out')`,
          [id],
        );
        const phases = new Set(checks.rows.map((r) => r.phase));
        if (!phases.has('sign_in') || !phases.has('time_out')) {
          throw conflict('قوائم التحقق غير مكتملة', { missing: ['sign_in', 'time_out'].filter((p) => !phases.has(p)) });
        }
        await db.query(`UPDATE surgical_cases SET status = 'in_progress', started_at = now() WHERE id = $1`, [id]);
        return { caseId: id, status: 'in_progress', startedAt: new Date().toISOString() };
      },
      (r) => ({
        action: 'surgery.start',
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, status: r.status },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------ Anaesthesia obs ----
  app.post('/api/surgery/cases/:id/anesthesia', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'anesthesia.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        phase: z.enum(['induction', 'maintenance', 'emergence']).default('maintenance'),
        heartRate: z.number().int().min(20).max(250).optional(),
        systolicBp: z.number().int().min(40).max(300).optional(),
        diastolicBp: z.number().int().min(20).max(200).optional(),
        spo2: z.number().int().min(50).max(100).optional(),
        etco2: z.number().int().min(10).max(100).optional(),
        temperatureC: z.number().min(30).max(45).optional(),
        agent: z.string().max(100).optional(),
        agentDose: z.string().max(100).optional(),
        airway: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        if (c.status !== 'in_progress') throw conflict('لا يمكن تسجيل قياسات التخدير قبل بدء العملية أو بعد إغلاقها');
        if (!body.heartRate && !body.systolicBp && !body.spo2 && !body.agent) {
          throw conflict('سجّل قياسًا حيويًا واحدًا على الأقل أو اسم الدواء التخديري');
        }
        const recordId = crypto.randomUUID();
        await db.query(
          `INSERT INTO anesthesia_records (id, facility_id, case_id, phase, heart_rate, systolic_bp, diastolic_bp,
             spo2, etco2, temperature_c, agent, agent_dose, airway, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [recordId, c.facility_id, id, body.phase, body.heartRate ?? null, body.systolicBp ?? null,
            body.diastolicBp ?? null, body.spo2 ?? null, body.etco2 ?? null, body.temperatureC ?? null,
            body.agent ?? null, body.agentDose ?? null, body.airway ?? null, body.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id: recordId, caseId: id, phase: body.phase };
      },
      (r) => ({
        action: 'anesthesia.record',
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, phase: body.phase, recordId: r.id },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- Close ----
  app.post('/api/surgery/cases/:id/close', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const countSchema = z.object({ expected: z.number().int().min(0).max(999), actual: z.number().int().min(0).max(999) });
    const body = parse(
      z.object({
        signOut: z.record(z.boolean()),
        counts: z.object({ instruments: countSchema, sponges: countSchema, needles: countSchema }),
        discrepancyNote: z.string().min(15).max(1000).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        const patient = await loadPatientOr404(db, c.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'surgery_close' });
        if (c.status !== 'in_progress') throw conflict('إغلاق العملية متاح فقط أثناء سيرها');

        assertPhaseItems('sign_out', body.signOut);

        const mismatches = (['instruments', 'sponges', 'needles'] as const)
          .filter((k) => body.counts[k].expected !== body.counts[k].actual)
          .map((k) => ({ item: k, expected: body.counts[k].expected, actual: body.counts[k].actual }));
        if (mismatches.length > 0 && !body.discrepancyNote) {
          throw conflict('عدّ الأدوات والكمامات والإبر غير متطابق: وثّق الإجراء التصحيحي قبل الإغلاق', { mismatches });
        }

        const exists = await db.query(`SELECT id FROM surgical_checklists WHERE case_id = $1 AND phase = 'sign_out'`, [id]);
        if (exists.rows[0]) throw conflict('قائمة ما بعد العملية مسجّلة مسبقًا');

        await db.query(
          `INSERT INTO surgical_checklists (id, facility_id, case_id, phase, items, completed_by, notes)
           VALUES ($1,$2,$3,'sign_out',$4,$5,$6)`,
          [crypto.randomUUID(), c.facility_id, id,
            JSON.stringify({ ...body.signOut, counts: body.counts }), auth.user.id,
            body.discrepancyNote ?? body.notes ?? null],
        );
        await db.query(
          `UPDATE surgical_cases SET status = 'recovery', closed_at = now(), counts_correct = $2,
             count_discrepancy = $3 WHERE id = $1`,
          [id, mismatches.length === 0, body.discrepancyNote ?? null],
        );

        const procedureFee = await priceSetting(db, c.facility_id, 'pricing.surgery_case', 3500);
        const surgeryCharge = await ensureCharge(db, {
          facilityId: c.facility_id,
          patientId: c.patient_id,
          encounterId: c.encounter_id,
          category: 'procedure',
          description: `عملية جراحية: ${c.procedure_name}`,
          referenceType: 'surgery_case',
          referenceId: id,
          quantity: 1,
          unitPrice: procedureFee,
          createdBy: auth.user.id,
        });
        let anesthesiaFee = 0;
        let anesthesiaCharge: { invoiceId: string } | null = null;
        if (c.anesthesia_type !== 'none') {
          anesthesiaFee = await priceSetting(db, c.facility_id, 'pricing.anesthesia_case', 1200);
          anesthesiaCharge = await ensureCharge(db, {
            facilityId: c.facility_id,
            patientId: c.patient_id,
            encounterId: c.encounter_id,
            category: 'procedure',
            description: `تخدير: ${c.procedure_name}`,
            referenceType: 'anesthesia_case',
            referenceId: id,
            quantity: 1,
            unitPrice: anesthesiaFee,
            createdBy: auth.user.id,
          });
        }
        return {
          caseId: id,
          status: 'recovery',
          countsCorrect: mismatches.length === 0,
          mismatches,
          fees: { procedure: procedureFee, anesthesia: anesthesiaFee },
          invoiceId: surgeryCharge.invoiceId ?? anesthesiaCharge?.invoiceId ?? null,
        };
      },
      (r) => ({
        action: 'surgery.close',
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, countsCorrect: r.countsCorrect, mismatches: r.mismatches.length, fees: r.fees },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- PACU -----
  app.post('/api/surgery/cases/:id/recovery', async (req, reply) => {
    const auth = requireAuth(req);
    if (!hasPermission(auth, 'anesthesia.perform') && !hasPermission(auth, 'surgery.perform') && !hasPermission(auth, 'surgery.checklist')) {
      throw forbidden('لا تملك صلاحية تسجيل الإفاقة');
    }
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        aldreteScore: z.number().int().min(0).max(10),
        painScore: z.number().int().min(0).max(10).optional(),
        heartRate: z.number().int().min(20).max(250).optional(),
        systolicBp: z.number().int().min(40).max(300).optional(),
        diastolicBp: z.number().int().min(20).max(200).optional(),
        spo2: z.number().int().min(50).max(100).optional(),
        nausea: z.boolean().default(false),
        disposition: z.enum(['ward', 'icu', 'day_surgery_discharge']),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        if (c.status !== 'recovery') throw conflict('تسجيل الإفاقة متاح بعد إغلاق العملية فقط');
        if (body.aldreteScore < 8) {
          throw conflict('درجة ألدريتي أقل من 8: لا يجوز نقل المريض من الإفاقة قبل تحسّنه', { aldreteScore: body.aldreteScore });
        }
        const exists = await db.query(`SELECT id FROM pacu_records WHERE case_id = $1`, [id]);
        if (exists.rows[0]) throw conflict('سجل الإفاقة مسجّل مسبقًا');
        const recordId = crypto.randomUUID();
        await db.query(
          `INSERT INTO pacu_records (id, facility_id, case_id, aldrete_score, pain_score, heart_rate, systolic_bp,
             diastolic_bp, spo2, nausea, disposition, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [recordId, c.facility_id, id, body.aldreteScore, body.painScore ?? null, body.heartRate ?? null,
            body.systolicBp ?? null, body.diastolicBp ?? null, body.spo2 ?? null, body.nausea, body.disposition,
            body.notes ?? null, auth.user.id],
        );
        await db.query(`UPDATE surgical_cases SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
        reply.code(201);
        return { caseId: id, status: 'completed', disposition: body.disposition };
      },
      (r) => ({
        action: 'surgery.recovery',
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, aldrete: body.aldreteScore, disposition: body.disposition },
        ip: req.ip,
      }),
    );
  });

  // --------------------------------------------------------------- Cancel ----
  app.post('/api/surgery/cases/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'surgery.schedule');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
    let c: any;
    return withTenantAudited(
      auth,
      async (db) => {
        c = await loadCase(db, id);
        if (!['scheduled', 'prepared'].includes(c.status)) {
          throw conflict('لا يمكن إلغاء عملية بدأت بالفعل؛ سجّل ما جرى وأغلقها');
        }
        await db.query(
          `UPDATE surgical_cases SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, cancelled_at = now()
            WHERE id = $1`,
          [id, body.reason, auth.user.id],
        );
        return { caseId: id, status: 'cancelled', reason: body.reason };
      },
      () => ({
        action: 'surgery.cancel',
        entityType: 'surgical_case',
        entityId: id,
        patientId: null,
        detail: { caseNo: c.case_no, reason: body.reason },
        ip: req.ip,
      }),
    );
  });
}
