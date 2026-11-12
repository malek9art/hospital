import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission, hasPermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

/**
 * Intensive care unit: stays, hourly charting, ventilation settings, the daily
 * care bundle and the SOFA score.
 *
 * Safety rules enforced here:
 *  - a stay can only be opened on an active admission occupying an ICU bed;
 *  - observations, ventilator changes and scores are append-only (also in DB);
 *  - a closed stay refuses further charting and can never be reopened;
 *  - SOFA is computed from the entered physiology, not typed in by hand.
 */

export interface SofaInput {
  pao2: number;
  fio2Pct: number;
  respiratorySupport: boolean;
  platelets: number;
  bilirubin: number;
  map: number;
  vasopressor?: 'none' | 'dopamine_low' | 'dobutamine' | 'dopamine_mid' | 'epinephrine_low' | 'norepinephrine_low' | 'dopamine_high' | 'epinephrine_high' | 'norepinephrine_high';
  gcs: number;
  creatinine: number;
  urine24hMl?: number;
}

export interface SofaResult {
  components: Record<string, number>;
  detail: Record<string, string>;
  total: number;
}

/** Standard SOFA score (Vincent et al. 1996), computed server-side. */
export function computeSofa(input: SofaInput): SofaResult {
  const detail: Record<string, string> = {};

  const ratio = (input.pao2 * 100) / input.fio2Pct;
  let resp: number;
  if (ratio >= 400) resp = 0;
  else if (ratio >= 300) resp = 1;
  else if (ratio >= 200) resp = 2;
  else if (ratio >= 100) resp = input.respiratorySupport ? 3 : 2;
  else resp = input.respiratorySupport ? 4 : 3;
  detail.respiration = `PaO2/FiO2 = ${Math.round(ratio)}${input.respiratorySupport ? ' مع دعم تنفسي' : ''}`;

  const plt = input.platelets;
  let coag = 0;
  if (plt < 20) coag = 4;
  else if (plt < 50) coag = 3;
  else if (plt < 100) coag = 2;
  else if (plt < 150) coag = 1;
  detail.coagulation = `الصفيحات ${plt} ×10³/µL`;

  const bili = input.bilirubin;
  let liver = 0;
  if (bili >= 12) liver = 4;
  else if (bili >= 6) liver = 3;
  else if (bili >= 2) liver = 2;
  else if (bili >= 1.2) liver = 1;
  detail.liver = `البيليروبين ${bili} mg/dL`;

  const pressor = input.vasopressor ?? 'none';
  let cardio: number;
  if (['dopamine_high', 'epinephrine_high', 'norepinephrine_high'].includes(pressor)) cardio = 4;
  else if (['dopamine_mid', 'epinephrine_low', 'norepinephrine_low'].includes(pressor)) cardio = 3;
  else if (['dopamine_low', 'dobutamine'].includes(pressor)) cardio = 2;
  else cardio = input.map < 70 ? 1 : 0;
  detail.cardiovascular = pressor === 'none' ? `MAP ${input.map}` : `رافع ضغط: ${pressor} · MAP ${input.map}`;

  const gcs = input.gcs;
  let cns: number;
  if (gcs < 6) cns = 4;
  else if (gcs <= 9) cns = 3;
  else if (gcs <= 12) cns = 2;
  else if (gcs <= 14) cns = 1;
  else cns = 0;
  detail.cns = `GCS ${gcs}`;

  const cr = input.creatinine;
  const urine = input.urine24hMl;
  let renal: number;
  if (cr >= 5 || (urine !== undefined && urine < 200)) renal = 4;
  else if (cr >= 3.5 || (urine !== undefined && urine < 500)) renal = 3;
  else if (cr >= 2) renal = 2;
  else if (cr >= 1.2) renal = 1;
  else renal = 0;
  detail.renal = `الكرياتينين ${cr} mg/dL${urine !== undefined ? ` · بول ٢٤ ساعة ${urine} مل` : ''}`;

  const components = { respiration: resp, coagulation: coag, liver, cardiovascular: cardio, cns, renal };
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return { components, detail, total };
}

const DISPOSITIONS = ['ward', 'transfer', 'home', 'deceased', 'against_advice'] as const;

async function loadStay(db: any, id: string) {
  const res = await db.query(
    `SELECT s.*, p.mrn, p.full_name_ar AS patient_name, p.date_of_birth, p.blood_type,
            e.encounter_no, w.name_ar AS ward_name, r.room_no, b.bed_no,
            u.full_name_ar AS intensivist_name, a.admission_no
       FROM icu_stays s
       JOIN patients p ON p.id = s.patient_id
       JOIN encounters e ON e.id = s.encounter_id
       LEFT JOIN beds b ON b.id = s.bed_id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN wards w ON w.id = b.ward_id
       LEFT JOIN users u ON u.id = s.intensivist_id
       JOIN admissions a ON a.id = s.admission_id
      WHERE s.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('إقامة العناية المركزة غير موجودة');
  return row;
}

const observationSchema = z.object({
  heartRate: z.number().int().min(20).max(250).optional(),
  systolicBp: z.number().int().min(40).max(300).optional(),
  diastolicBp: z.number().int().min(20).max(200).optional(),
  respRate: z.number().int().min(4).max(80).optional(),
  spo2: z.number().int().min(50).max(100).optional(),
  temperatureC: z.number().min(30).max(45).optional(),
  gcs: z.number().int().min(3).max(15).optional(),
  rass: z.number().int().min(-5).max(1).optional(),
  urineMl: z.number().int().min(0).max(5000).optional(),
  glucose: z.number().int().min(20).max(900).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  notes: z.string().max(1000).optional(),
});

export async function icuRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Board ----
  app.get('/api/icu/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.read');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT s.id, s.stay_no, s.opened_at, s.status,
                p.mrn, p.full_name_ar AS patient_name, p.date_of_birth,
                a.admission_no, a.admitted_at,
                w.name_ar AS ward_name, r.room_no, b.bed_no,
                ui.full_name_ar AS intensivist_name,
                o.recorded_at AS last_observed_at, o.heart_rate, o.systolic_bp, o.diastolic_bp,
                o.spo2, o.gcs, o.temperature_c,
                v.mode AS vent_mode, v.fio2_pct, v.peep_cmh2o,
                sc.total AS sofa_total, sc.recorded_at AS sofa_at,
                (SELECT count(*)::int FROM icu_observations io WHERE io.stay_id = s.id) AS observation_count,
                EXISTS (SELECT 1 FROM icu_daily_goals g WHERE g.stay_id = s.id AND g.goal_date = current_date) AS bundled_today
           FROM icu_stays s
           JOIN patients p ON p.id = s.patient_id
           JOIN admissions a ON a.id = s.admission_id
           JOIN users ui ON ui.id = COALESCE(s.intensivist_id, s.opened_by)
           LEFT JOIN beds b ON b.id = s.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
           LEFT JOIN LATERAL (
             SELECT * FROM icu_observations io WHERE io.stay_id = s.id ORDER BY io.recorded_at DESC LIMIT 1
           ) o ON true
           LEFT JOIN LATERAL (
             SELECT * FROM icu_ventilator_settings vs WHERE vs.stay_id = s.id ORDER BY vs.recorded_at DESC LIMIT 1
           ) v ON true
           LEFT JOIN LATERAL (
             SELECT * FROM icu_scores isc WHERE isc.stay_id = s.id ORDER BY isc.recorded_at DESC LIMIT 1
           ) sc ON true
          WHERE s.facility_id = $1 AND s.status = 'active'
          ORDER BY COALESCE(sc.total, 0) DESC, s.opened_at`,
        [auth.activeFacilityId],
      );
      const totals = await db.query<any>(
        `SELECT count(*)::int AS patients,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM icu_ventilator_settings v2
                   WHERE v2.stay_id = s.id AND v2.mode NOT IN ('room_air')
                     AND v2.recorded_at = (SELECT max(recorded_at) FROM icu_ventilator_settings v3 WHERE v3.stay_id = s.id)
                ))::int AS ventilated,
                COALESCE(round(avg((SELECT total FROM icu_scores x WHERE x.stay_id = s.id ORDER BY x.recorded_at DESC LIMIT 1)), 1), 0) AS avg_sofa
           FROM icu_stays s WHERE s.facility_id = $1 AND s.status = 'active'`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows, totals: totals.rows[0] };
    });
  });

  // ----------------------------------------------------------- Open a stay ---
  app.post('/api/icu/stays', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.manage');
    const body = parse(
      z.object({
        admissionId: zId,
        intensivistId: zId.optional(),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const adm = await db.query<any>(
          `SELECT a.*, b.ward_id, w.ward_type, w.name_ar AS ward_name
             FROM admissions a
             LEFT JOIN beds b ON b.id = a.bed_id
             LEFT JOIN wards w ON w.id = b.ward_id
            WHERE a.id = $1`,
          [body.admissionId],
        );
        const admission = adm.rows[0];
        if (!admission) throw notFound('التنويم غير موجود');
        if (admission.status !== 'active') throw conflict('لا يمكن فتح إقامة عناية مركزة على تنويم غير نشط');
        if (admission.ward_type !== 'icu') throw conflict('المريض ليس في سرير عناية مركزة؛ انقله إلى العناية أولًا', { bedId: admission.bed_id });

        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'icu_admit' });

        const existing = await db.query(`SELECT stay_no FROM icu_stays WHERE admission_id = $1 AND status = 'active'`, [body.admissionId]);
        if (existing.rows[0]) throw conflict(`يوجد إقامة عناية مركزة نشطة بالفعل (${existing.rows[0].stay_no})`);

        if (body.intensivistId) {
          const doc = await db.query(
            `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $2
              WHERE u.id = $1 AND u.is_active = true
                AND ur.role_id IN ('intensivist','physician','department_manager')`,
            [body.intensivistId, auth.activeFacilityId],
          );
          if (!doc.rows[0]) throw notFound('الطبيب المعالج غير موجود أو غير مؤهل للعناية المركزة');
        }

        const stayNo = await nextDocumentNo(db, auth.activeFacilityId, 'icu_stay', 'ICU');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO icu_stays (id, facility_id, stay_no, admission_id, patient_id, encounter_id, bed_id,
             intensivist_id, opened_by, admission_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, auth.activeFacilityId, stayNo, body.admissionId, admission.patient_id, admission.encounter_id,
            admission.bed_id, body.intensivistId ?? auth.user.id, auth.user.id, body.note ?? null],
        );
        reply.code(201);
        return { id, stayNo, status: 'active', bed: `${admission.ward_name ?? 'ICU'} ${admission.bed_no ?? ''}`.trim() };
      },
      (r) => ({
        action: 'icu.admit',
        entityType: 'icu_stay',
        entityId: r.id,
        patientId: null,
        detail: { stayNo: r.stayNo, admissionId: body.admissionId },
        ip: req.ip,
      }),
    );
  });

  // --------------------------------------------------------------- Detail ----
  app.get('/api/icu/stays/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const stay = await loadStay(db, id);
      const patient = await loadPatientOr404(db, stay.patient_id);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'icu_view' });
      const [observations, vent, goals, scores] = await Promise.all([
        db.query(
          `SELECT o.*, u.full_name_ar AS recorded_by_name FROM icu_observations o
             JOIN users u ON u.id = o.recorded_by WHERE o.stay_id = $1 ORDER BY o.recorded_at DESC LIMIT 48`,
          [id],
        ),
        db.query(
          `SELECT v.*, u.full_name_ar AS recorded_by_name FROM icu_ventilator_settings v
             JOIN users u ON u.id = v.recorded_by WHERE v.stay_id = $1 ORDER BY v.recorded_at DESC`,
          [id],
        ),
        db.query(
          `SELECT g.*, u.full_name_ar AS created_by_name FROM icu_daily_goals g
             JOIN users u ON u.id = g.created_by WHERE g.stay_id = $1 ORDER BY g.goal_date DESC LIMIT 7`,
          [id],
        ),
        db.query(
          `SELECT s.*, u.full_name_ar AS recorded_by_name FROM icu_scores s
             JOIN users u ON u.id = s.recorded_by WHERE s.stay_id = $1 ORDER BY s.recorded_at DESC LIMIT 10`,
          [id],
        ),
      ]);
      return {
        ...stay,
        observations: observations.rows,
        ventilator: vent.rows,
        goals: goals.rows,
        scores: scores.rows,
      };
    });
  });

  // ---------------------------------------------------------- Observations ----
  app.post('/api/icu/stays/:id/observations', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.chart');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(observationSchema, req.body);
    let stay: any;
    return withTenantAudited(
      auth,
      async (db) => {
        stay = await loadStay(db, id);
        if (stay.status !== 'active') throw conflict('الإقامة مغلقة: لا يمكن تسجيل قياسات جديدة');
        const patient = await loadPatientOr404(db, stay.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'icu_chart' });
        const measured = Object.entries(body).filter(([k, v]) => v !== undefined && k !== 'notes');
        if (measured.length === 0) throw conflict('سجّل قياسًا واحدًا على الأقل');
        const sid = crypto.randomUUID();
        await db.query(
          `INSERT INTO icu_observations (id, facility_id, stay_id, heart_rate, systolic_bp, diastolic_bp, resp_rate,
             spo2, temperature_c, gcs, rass, urine_ml, glucose, pain_score, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [sid, stay.facility_id, id, body.heartRate ?? null, body.systolicBp ?? null, body.diastolicBp ?? null,
            body.respRate ?? null, body.spo2 ?? null, body.temperatureC ?? null, body.gcs ?? null, body.rass ?? null,
            body.urineMl ?? null, body.glucose ?? null, body.painScore ?? null, body.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id: sid, stayId: id, recordedAt: new Date().toISOString() };
      },
      (r) => ({
        action: 'icu.observe',
        entityType: 'icu_stay',
        entityId: id,
        patientId: null,
        detail: { stayNo: stay.stay_no, observationId: r.id },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Ventilator ----
  app.post('/api/icu/stays/:id/ventilator', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.ventilator');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        mode: z.enum(['ac', 'simv', 'psv', 'cpap', 'hfnc', 'room_air']),
        fio2Pct: z.number().int().min(21).max(100),
        peepCmh2o: z.number().min(0).max(30).optional(),
        tidalVolumeMl: z.number().int().min(100).max(1200).optional(),
        setRate: z.number().int().min(4).max(60).optional(),
        reason: z.string().max(500).optional(),
      }),
      req.body,
    );
    let stay: any;
    return withTenantAudited(
      auth,
      async (db) => {
        stay = await loadStay(db, id);
        if (stay.status !== 'active') throw conflict('الإقامة مغلقة: لا يمكن تعديل إعدادات التنفس');
        if (body.mode === 'room_air' && body.fio2Pct !== 21) {
          throw conflict('وضع الهواء المحيط يعني FiO2 = 21%');
        }
        if (body.mode !== 'room_air' && body.fio2Pct < 21) {
          throw conflict('نسبة الأكسجين غير صالحة');
        }
        const patient = await loadPatientOr404(db, stay.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'icu_ventilator' });
        const vid = crypto.randomUUID();
        await db.query(
          `INSERT INTO icu_ventilator_settings (id, facility_id, stay_id, mode, fio2_pct, peep_cmh2o,
             tidal_volume_ml, set_rate, reason, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [vid, stay.facility_id, id, body.mode, body.fio2Pct, body.peepCmh2o ?? null,
            body.tidalVolumeMl ?? null, body.setRate ?? null, body.reason ?? null, auth.user.id],
        );
        reply.code(201);
        return { id: vid, stayId: id, mode: body.mode, fio2Pct: body.fio2Pct };
      },
      (r) => ({
        action: 'icu.ventilator',
        entityType: 'icu_stay',
        entityId: id,
        patientId: null,
        detail: { stayNo: stay.stay_no, mode: r.mode, fio2: r.fio2Pct },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------- Daily bundle ----
  app.post('/api/icu/stays/:id/goals', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.chart');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        goalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sedationTarget: z.boolean(),
        headOfBedElevated: z.boolean(),
        vapBundle: z.boolean(),
        dvtProphylaxis: z.boolean(),
        stressUlcerProphylaxis: z.boolean(),
        nutritionPlan: z.boolean(),
        earlyMobility: z.boolean(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let stay: any;
    return withTenantAudited(
      auth,
      async (db) => {
        stay = await loadStay(db, id);
        if (stay.status !== 'active') throw conflict('الإقامة مغلقة: لا يمكن تعديل حزمة الرعاية اليومية');
        const goalDate = body.goalDate ?? new Date().toISOString().slice(0, 10);
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM icu_daily_goals WHERE stay_id = $1 AND goal_date = $2`,
          [id, goalDate],
        );
        if (existing.rows[0]) {
          await db.query(
            `UPDATE icu_daily_goals SET sedation_target = $3, head_of_bed_elevated = $4, vap_bundle = $5,
               dvt_prophylaxis = $6, stress_ulcer_prophylaxis = $7, nutrition_plan = $8, early_mobility = $9,
               notes = $10, updated_by = $11, updated_at = now()
             WHERE id = $1 AND stay_id = $2`,
            [existing.rows[0].id, id, body.sedationTarget, body.headOfBedElevated, body.vapBundle,
              body.dvtProphylaxis, body.stressUlcerProphylaxis, body.nutritionPlan, body.earlyMobility,
              body.notes ?? null, auth.user.id],
          );
          return { id: existing.rows[0].id, goalDate, updated: true };
        }
        const gid = crypto.randomUUID();
        await db.query(
          `INSERT INTO icu_daily_goals (id, facility_id, stay_id, goal_date, sedation_target, head_of_bed_elevated,
             vap_bundle, dvt_prophylaxis, stress_ulcer_prophylaxis, nutrition_plan, early_mobility, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [gid, stay.facility_id, id, goalDate, body.sedationTarget, body.headOfBedElevated, body.vapBundle,
            body.dvtProphylaxis, body.stressUlcerProphylaxis, body.nutritionPlan, body.earlyMobility,
            body.notes ?? null, auth.user.id],
        );
        return { id: gid, goalDate, updated: false };
      },
      (r) => ({
        action: 'icu.daily_goals',
        entityType: 'icu_stay',
        entityId: id,
        patientId: null,
        detail: { stayNo: stay.stay_no, goalDate: r.goalDate, updated: r.updated },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- SOFA -----
  app.post('/api/icu/stays/:id/sofa', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.chart');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        pao2: z.number().min(20).max(700),
        fio2Pct: z.number().min(21).max(100),
        respiratorySupport: z.boolean(),
        platelets: z.number().min(1).max(1500),
        bilirubin: z.number().min(0).max(60),
        map: z.number().min(20).max(200),
        vasopressor: z
          .enum(['none', 'dopamine_low', 'dobutamine', 'dopamine_mid', 'epinephrine_low', 'norepinephrine_low', 'dopamine_high', 'epinephrine_high', 'norepinephrine_high'])
          .default('none'),
        gcs: z.number().int().min(3).max(15),
        creatinine: z.number().min(0.1).max(20),
        urine24hMl: z.number().int().min(0).max(10000).optional(),
      }),
      req.body,
    );
    let stay: any;
    return withTenantAudited(
      auth,
      async (db) => {
        stay = await loadStay(db, id);
        if (stay.status !== 'active') throw conflict('الإقامة مغلقة: لا يمكن تسجيل درجة جديدة');
        // A score extrapolated from stale physiology is misleading: require a
        // recent observation on the chart.
        const recent = await db.query<{ recorded_at: string }>(
          `SELECT recorded_at FROM icu_observations
            WHERE stay_id = $1 AND recorded_at > now() - interval '6 hours'
              AND (heart_rate IS NOT NULL OR spo2 IS NOT NULL OR systolic_bp IS NOT NULL OR gcs IS NOT NULL)
            ORDER BY recorded_at DESC LIMIT 1`,
          [id],
        );
        if (!recent.rows[0]) {
          throw conflict('سجّل علامات حيوية حديثة (خلال ٦ ساعات) قبل حساب SOFA');
        }
        const result = computeSofa(body as any);
        const sid = crypto.randomUUID();
        await db.query(
          `INSERT INTO icu_scores (id, facility_id, stay_id, kind, components, total, recorded_by)
           VALUES ($1,$2,$3,'sofa',$4,$5,$6)`,
          [sid, stay.facility_id, id, JSON.stringify({ ...result.components, detail: result.detail }), result.total, auth.user.id],
        );
        reply.code(201);
        return { id: sid, stayId: id, total: result.total, components: result.components, detail: result.detail };
      },
      (r) => ({
        action: 'icu.sofa',
        entityType: 'icu_stay',
        entityId: id,
        patientId: null,
        detail: { stayNo: stay.stay_no, total: r.total },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------- Discharge ----
  app.post('/api/icu/stays/:id/discharge', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'icu.discharge');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        disposition: z.enum(DISPOSITIONS),
        note: z.string().min(15).max(2000),
      }),
      req.body,
    );
    let stay: any;
    return withTenantAudited(
      auth,
      async (db) => {
        stay = await loadStay(db, id);
        if (stay.status !== 'active') throw conflict('الإقامة مغلقة مسبقًا');
        if (body.disposition === 'deceased' && !hasPermission(auth, 'icu.discharge')) {
          throw forbidden('تسجيل الوفاة يتطلب صلاحية إغلاق إقامة العناية');
        }
        const patient = await loadPatientOr404(db, stay.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'icu_discharge' });
        await db.query(
          `UPDATE icu_stays SET status = 'closed', closed_at = now(), discharge_disposition = $2,
             closing_note = $3, closed_by = $4 WHERE id = $1`,
          [id, body.disposition, body.note, auth.user.id],
        );
        return { id, status: 'closed', disposition: body.disposition, closedAt: new Date().toISOString() };
      },
      () => ({
        action: 'icu.discharge',
        entityType: 'icu_stay',
        entityId: id,
        patientId: null,
        detail: { stayNo: stay.stay_no, disposition: body.disposition },
        ip: req.ip,
      }),
    );
  });
}
