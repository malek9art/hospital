import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

/**
 * Clinical nutrition: screening, dietitian assessment, diet orders, tray
 * production/delivery and intake monitoring, plus enteral/parenteral feeding.
 *
 * Enforced here:
 *  - screening is nursing, assessment/ordering is the dietitian (separation);
 *  - a diet order requires a current assessment and is checked against the
 *    patient's recorded food allergies (no silent override);
 *  - trays advance ordered → prepared → delivered → consumed/refused, and
 *    intake is recorded only after delivery;
 *  - one active diet order and one active feed per route per admission.
 *
 * Limits (stated in the UI and docs): energy/protein targets are weight-based
 * estimates, meals carry a fixed energy share, and there is no food-composition
 * database, kitchen stock or menu catalogue.
 */

export const MEAL_SHARE: Record<string, number> = { breakfast: 25, lunch: 35, dinner: 30, snack: 10 };
export const MEAL_AR: Record<string, string> = { breakfast: 'إفطار', lunch: 'غداء', dinner: 'عشاء', snack: 'وجبة خفيفة' };
export const DIET_AR: Record<string, string> = {
  regular: 'عادي', diabetic: 'سكري', renal: 'كلوي', low_sodium: 'قليل الصوديوم', soft: 'لين',
  liquid: 'سوائل صافية', npo: 'صائم (NPO)', enteral: 'تغذية أنبوبية', parenteral: 'تغذية وريدية',
};
export const ROUTE_AR: Record<string, string> = {
  ng: 'أنفي معدي', og: 'فموي معدي', peg: 'فغر معدة (PEG)', pej: 'فغر صائم (PEJ)', tpn: 'تغذية وريدية كلية', ppn: 'تغذية وريدية جزئية',
};
export const RESTRICTION_AR: Record<string, string> = {
  lactose_free: 'خالٍ من اللاكتوز', gluten_free: 'خالٍ من الغلوتين', nut_free: 'خالٍ من المكسرات',
  egg_free: 'خالٍ من البيض', fish_free: 'خالٍ من السمك', soy_free: 'خالٍ من الصويا',
  diabetic: 'سكري', low_sodium: 'قليل الصوديوم', renal: 'كلوي', low_fat: 'قليل الدهون',
};

/** Allergen keywords found in recorded allergies → the restriction they imply. */
export const ALLERGEN_RULES: { restriction: string; keywords: string[] }[] = [
  { restriction: 'lactose_free', keywords: ['حليب', 'لاكتوز', 'لبن', 'milk', 'lactose', 'dairy'] },
  { restriction: 'gluten_free', keywords: ['غلوتين', 'قمح', 'جلوتين', 'gluten', 'wheat'] },
  { restriction: 'nut_free', keywords: ['مكسرات', 'فول سوداني', 'بندق', 'لوز', 'nut', 'peanut'] },
  { restriction: 'egg_free', keywords: ['بيض', 'egg'] },
  { restriction: 'fish_free', keywords: ['سمك', 'بحري', 'fish', 'seafood'] },
  { restriction: 'soy_free', keywords: ['صويا', 'soy'] },
];

export interface ScreeningInput {
  weightKg: number;
  heightCm: number;
  weightLossPct?: number;
  intakeReduction: 'none' | 'mild' | 'moderate' | 'severe';
  diseaseSeverity: 'none' | 'mild' | 'moderate' | 'severe';
  ageYears: number;
}

export interface ScreeningResult {
  bmi: number;
  score: number;
  riskLevel: 'low' | 'medium' | 'high';
  components: Record<string, number>;
}

/**
 * Nutrition risk score inspired by NRS-2002 (weight loss, BMI, intake, disease
 * severity, age). It is a transparent screening aid, not a validated medical
 * device; the API only uses it to route patients to the dietitian.
 */
export function computeScreening(input: ScreeningInput): ScreeningResult {
  const bmi = Math.round((input.weightKg / Math.pow(input.heightCm / 100, 2)) * 10) / 10;
  const lossPct = input.weightLossPct ?? 0;
  const loss = lossPct >= 10 ? 3 : lossPct >= 5 ? 2 : 0;
  const bmiScore = bmi < 18.5 ? 2 : bmi < 20 ? 1 : 0;
  const intake = { none: 0, mild: 1, moderate: 2, severe: 3 }[input.intakeReduction];
  const severity = { none: 0, mild: 1, moderate: 2, severe: 3 }[input.diseaseSeverity];
  const age = input.ageYears >= 65 ? 1 : 0;
  const score = loss + bmiScore + intake + severity + age;
  const riskLevel = score >= 5 || bmi < 17 ? 'high' : score >= 3 || bmi < 18.5 ? 'medium' : 'low';
  return { bmi, score, riskLevel, components: { weightLoss: loss, bmi: bmiScore, intake, severity, age } };
}

/** Weight-based target estimate; the dietitian may deviate with a reason. */
export function recommendedTargets(weightKg: number, bmi: number) {
  const energyPerKg = bmi < 18.5 ? 30 : 25;
  const proteinPerKg = bmi < 18.5 ? 1.5 : bmi >= 30 ? 1.0 : 1.2;
  return {
    energyKcal: Math.round(weightKg * energyPerKg),
    proteinG: Math.round(weightKg * proteinPerKg * 10) / 10,
  };
}

/** Restrictions implied by the patient's active allergies. */
export function requiredRestrictions(allergies: { allergen: string }[]) {
  const required = new Map<string, string>();
  for (const allergy of allergies) {
    const text = (allergy.allergen ?? '').toLowerCase();
    for (const rule of ALLERGEN_RULES) {
      if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) required.set(rule.restriction, allergy.allergen);
    }
  }
  return required;
}

async function loadAdmission(db: any, admissionId: string) {
  const res = await db.query(
    `SELECT a.*, p.mrn, p.full_name_ar AS patient_name, p.date_of_birth,
            date_part('year', age(p.date_of_birth))::int AS age_years,
            e.encounter_no, w.name_ar AS ward_name, r.room_no, b.bed_no
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       JOIN encounters e ON e.id = a.encounter_id
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN rooms r ON r.id = b.room_id
       LEFT JOIN wards w ON w.id = b.ward_id
      WHERE a.id = $1`,
    [admissionId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('التنويم غير موجود');
  return row;
}

async function activeAdmissionOr409(db: any, admissionId: string) {
  const admission = await loadAdmission(db, admissionId);
  if (admission.status !== 'active') throw conflict('لا يمكن تنفيذ إجراء تغذية على تنويم غير نشط');
  return admission;
}

async function latestAssessment(db: any, admissionId: string) {
  const res = await db.query(
    `SELECT * FROM nutrition_assessments WHERE admission_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
    [admissionId],
  );
  return res.rows[0] ?? null;
}

async function activeDietOrder(db: any, admissionId: string) {
  const res = await db.query(
    `SELECT * FROM nutrition_diet_orders WHERE admission_id = $1 AND status = 'active'`,
    [admissionId],
  );
  return res.rows[0] ?? null;
}

const admissionIdSchema = z.object({ admissionId: zId });

export async function nutritionRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Board ----
  app.get('/api/nutrition/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.read');
    return withTenant(auth, async (db) => {
      const [rows, totals, trays] = await Promise.all([
        db.query(
          `SELECT a.id AS admission_id, a.admission_no, a.admitted_at,
                  p.id AS patient_id, p.mrn, p.full_name_ar AS patient_name,
                  date_part('year', age(p.date_of_birth))::int AS age_years,
                  w.name_ar AS ward_name, r.room_no, b.bed_no,
                  s.id AS screening_id, s.score AS screening_score, s.risk_level, s.bmi,
                  s.weight_kg, s.screening_date, s.recorded_at AS screened_at,
                  d.id AS diet_order_id, d.order_no, d.diet_type, d.texture, d.restrictions,
                  d.energy_target_kcal, d.protein_target_g, d.fluid_limit_ml,
                  t.id AS tube_order_id, t.route AS tube_route, t.formula_name, t.kcal_day,
                  t.volume_ml_day, t.protein_g_day,
                  COALESCE(tray.total, 0)::int AS trays_total,
                  COALESCE(tray.done, 0)::int AS trays_done,
                  COALESCE(tray.pending, 0)::int AS trays_pending,
                  tray.kcal_consumed,
                  COALESCE(ass.assumed, false) AS assessed
             FROM admissions a
             JOIN patients p ON p.id = a.patient_id
             JOIN encounters e ON e.id = a.encounter_id
             LEFT JOIN beds b ON b.id = a.bed_id
             LEFT JOIN rooms r ON r.id = b.room_id
             LEFT JOIN wards w ON w.id = b.ward_id
             LEFT JOIN LATERAL (
               SELECT * FROM nutrition_screenings ns WHERE ns.admission_id = a.id ORDER BY ns.recorded_at DESC LIMIT 1
             ) s ON true
             LEFT JOIN LATERAL (
               SELECT EXISTS (SELECT 1 FROM nutrition_assessments na WHERE na.admission_id = a.id) AS assumed
             ) ass ON true
             LEFT JOIN nutrition_diet_orders d ON d.admission_id = a.id AND d.status = 'active'
             LEFT JOIN nutrition_tube_orders t ON t.admission_id = a.id AND t.status = 'active'
             LEFT JOIN LATERAL (
               SELECT count(*) AS total,
                      count(*) FILTER (WHERE tr.status IN ('consumed','refused')) AS done,
                      count(*) FILTER (WHERE tr.status IN ('ordered','prepared','delivered')) AS pending,
                      COALESCE(sum(tr.kcal_consumed), 0) AS kcal_consumed
                 FROM nutrition_trays tr
                WHERE tr.admission_id = a.id AND tr.tray_date = current_date
             ) tray ON true
            WHERE a.facility_id = $1 AND a.status = 'active'
            ORDER BY CASE COALESCE(s.risk_level, 'none') WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
                     a.admitted_at`,
          [auth.activeFacilityId],
        ),
        db.query<Record<string, unknown>>(
          `SELECT count(*)::int AS inpatients,
                  count(*) FILTER (WHERE s.risk_level = 'high')::int AS high_risk,
                  count(*) FILTER (WHERE d.diet_type = 'npo')::int AS npo,
                  count(*) FILTER (WHERE s.id IS NULL OR s.screening_date < current_date - 7)::int AS needs_screening,
                  count(*) FILTER (WHERE d.id IS NULL)::int AS without_diet
             FROM admissions a
             LEFT JOIN LATERAL (SELECT * FROM nutrition_screenings ns WHERE ns.admission_id = a.id ORDER BY ns.recorded_at DESC LIMIT 1) s ON true
             LEFT JOIN nutrition_diet_orders d ON d.admission_id = a.id AND d.status = 'active'
            WHERE a.facility_id = $1 AND a.status = 'active'`,
          [auth.activeFacilityId],
        ),
        db.query<Record<string, unknown>>(
          `SELECT count(*) FILTER (WHERE status IN ('ordered','prepared'))::int AS pending,
                  count(*) FILTER (WHERE status = 'delivered')::int AS awaiting_intake,
                  count(*) FILTER (WHERE status = 'consumed')::int AS consumed,
                  count(*) FILTER (WHERE status = 'refused')::int AS refused,
                  COALESCE(round(avg(intake_pct) FILTER (WHERE intake_pct IS NOT NULL), 0), 0)::int AS avg_intake_pct
             FROM nutrition_trays WHERE facility_id = $1 AND tray_date = current_date`,
          [auth.activeFacilityId],
        ),
      ]);
      return {
        items: rows.rows.map((r: any) => ({
          ...r,
          bmi: r.bmi === null ? null : Number(r.bmi),
          weight_kg: r.weight_kg === null ? null : Number(r.weight_kg),
          protein_target_g: r.protein_target_g === null ? null : Number(r.protein_target_g),
          diet_ar: r.diet_type ? DIET_AR[r.diet_type] : null,
          restriction_labels: (r.restrictions ?? []).map((x: string) => RESTRICTION_AR[x] ?? x),
          needs_screening: !r.screening_id || new Date(r.screening_date).getTime() < Date.now() - 7 * 86_400_000,
        })),
        totals: totals.rows[0],
        trays: trays.rows[0],
      };
    });
  });

  // ------------------------------------------------------------ Screening ----
  app.post('/api/nutrition/screenings', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.screen');
    const body = parse(
      z.object({
        admissionId: zId,
        weightKg: z.number().min(20).max(400),
        heightCm: z.number().min(80).max(250),
        weightLossPct: z.number().min(0).max(50).default(0),
        intakeReduction: z.enum(['none', 'mild', 'moderate', 'severe']),
        diseaseSeverity: z.enum(['none', 'mild', 'moderate', 'severe']),
        actionTaken: z.string().max(500).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await activeAdmissionOr409(db, body.admissionId);
        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_screen' });

        const ageYears = Number(admission.age_years ?? 0);
        const result = computeScreening({ ...body, ageYears });
        if (!body.actionTaken && result.riskLevel !== 'low') {
          throw conflict('النتيجة تتطلب إجراءً موثقًا (تحويل لأخصائي التغذية أو خطة متابعة)');
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO nutrition_screenings (id, facility_id, patient_id, admission_id, encounter_id,
             screening_date, weight_kg, height_cm, bmi, weight_loss_pct, intake_reduction, disease_severity,
             age_years, score, risk_level, action_taken, notes, recorded_by)
           VALUES ($1,$2,$3,$4,$5,current_date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, auth.activeFacilityId, admission.patient_id, admission.id, admission.encounter_id,
            body.weightKg, body.heightCm, result.bmi, body.weightLossPct, body.intakeReduction,
            body.diseaseSeverity, ageYears, result.score, result.riskLevel, body.actionTaken ?? null,
            body.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return {
          id,
          bmi: result.bmi,
          score: result.score,
          riskLevel: result.riskLevel,
          components: result.components,
          referralRequired: result.riskLevel !== 'low',
          recordedAt: new Date().toISOString(),
        };
      },
      (r) => ({
        action: 'nutrition.screen',
        entityType: 'nutrition_screening',
        entityId: r.id,
        patientId: null,
        detail: { score: r.score, riskLevel: r.riskLevel, bmi: r.bmi },
        ip: req.ip,
      }),
    );
  });

  // ----------------------------------------------------------- Assessment ----
  app.post('/api/nutrition/assessments', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.assess');
    const body = parse(
      z.object({
        admissionId: zId,
        weightKg: z.number().min(20).max(400),
        heightCm: z.number().min(80).max(250),
        energyTargetKcal: z.number().int().min(600).max(5000).optional(),
        proteinTargetG: z.number().min(20).max(300).optional(),
        fluidLimitMl: z.number().int().min(500).max(6000).optional(),
        nutritionDiagnosis: z.string().min(5).max(500),
        plan: z.string().min(10).max(2000),
        varianceReason: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await activeAdmissionOr409(db, body.admissionId);
        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_assess' });

        const screening = await db.query(
          `SELECT * FROM nutrition_screenings WHERE admission_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
          [admission.id],
        );
        if (!screening.rows[0]) throw conflict('لا يوجد فحص تغذية لهذا المريض؛ يجب أن يقيّم التمريض الحالة أولًا');

        const bmi = Math.round((body.weightKg / Math.pow(body.heightCm / 100, 2)) * 10) / 10;
        const ideal = Math.round((body.heightCm - 100 - (body.heightCm - 150) / 4) * 10) / 10;
        const rec = recommendedTargets(body.weightKg, bmi);
        const energy = body.energyTargetKcal ?? rec.energyKcal;
        const protein = body.proteinTargetG ?? rec.proteinG;
        const deviates =
          Math.abs(energy - rec.energyKcal) / rec.energyKcal > 0.25 ||
          Math.abs(protein - rec.proteinG) / rec.proteinG > 0.25;
        if (deviates && !body.varianceReason) {
          throw conflict('الهدف يختلف عن التوصية بأكثر من ٢٥٪؛ اذكر سببًا سريريًا موثقًا', {
            recommendedEnergyKcal: rec.energyKcal,
            recommendedProteinG: rec.proteinG,
          });
        }

        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO nutrition_assessments (id, facility_id, patient_id, admission_id, screening_id,
             weight_kg, height_cm, bmi, ideal_weight_kg, energy_target_kcal, protein_target_g, fluid_limit_ml,
             recommended_energy_kcal, recommended_protein_g, variance_reason, nutrition_diagnosis, plan, assessed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [id, auth.activeFacilityId, admission.patient_id, admission.id, screening.rows[0].id,
            body.weightKg, body.heightCm, bmi, Math.max(20, ideal), energy, protein, body.fluidLimitMl ?? null,
            rec.energyKcal, rec.proteinG, body.varianceReason ?? null, body.nutritionDiagnosis, body.plan,
            auth.user.id],
        );
        reply.code(201);
        return {
          id,
          bmi,
          idealWeightKg: Math.max(20, ideal),
          energyTargetKcal: energy,
          proteinTargetG: protein,
          recommendedEnergyKcal: rec.energyKcal,
          recommendedProteinG: rec.proteinG,
          deviates: deviates,
          assessedAt: new Date().toISOString(),
        };
      },
      (r) => ({
        action: 'nutrition.assess',
        entityType: 'nutrition_assessment',
        entityId: r.id,
        patientId: null,
        detail: { bmi: r.bmi, energy: r.energyTargetKcal, protein: r.proteinTargetG, deviates: r.deviates },
        ip: req.ip,
      }),
    );
  });

  // ----------------------------------------------------------- Diet order ----
  app.post('/api/nutrition/diet-orders', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.order');
    const body = parse(
      z.object({
        admissionId: zId,
        dietType: z.enum(['regular', 'diabetic', 'renal', 'low_sodium', 'soft', 'liquid', 'npo', 'enteral', 'parenteral']),
        texture: z.enum(['normal', 'soft', 'minced', 'pureed', 'liquid']).optional(),
        restrictions: z.array(z.enum(['lactose_free', 'gluten_free', 'nut_free', 'egg_free', 'fish_free', 'soy_free', 'diabetic', 'low_sodium', 'renal', 'low_fat'])).max(10).default([]),
        energyTargetKcal: z.number().int().min(600).max(5000).optional(),
        proteinTargetG: z.number().min(20).max(300).optional(),
        fluidLimitMl: z.number().int().min(500).max(6000).optional(),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await activeAdmissionOr409(db, body.admissionId);
        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_order' });

        const assessment = await latestAssessment(db, admission.id);
        if (!assessment) throw conflict('لا يمكن إصدار أمر تغذية قبل تقييم أخصائي التغذية');

        // Allergy safety: every recorded food allergy must map to a restriction
        // that this order actually carries.
        const allergies = await db.query(
          `SELECT allergen, severity FROM patient_allergies WHERE patient_id = $1 AND is_active = true`,
          [admission.patient_id],
        );
        const required = requiredRestrictions(allergies.rows as unknown as { allergen: string }[]);
        const chosen: string[] = body.restrictions ?? [];
        const missing = [...required.entries()].filter(([code]) => !chosen.includes(code));
        if (missing.length > 0) {
          throw conflict(
            `أمر التغذية لا يستبعد مسببات الحساسية المسجلة (${missing.map(([, name]) => name).join('، ')})`,
            { requiredRestrictions: missing.map(([code]) => code) },
          );
        }

        const previous = await activeDietOrder(db, admission.id);
        if (previous) {
          await db.query(
            `UPDATE nutrition_diet_orders SET status = 'discontinued', discontinued_at = now(),
               discontinued_by = $2, discontinue_reason = $3 WHERE id = $1`,
            [previous.id, auth.user.id, 'استبدال بأمر تغذية جديد'],
          );
        }

        const orderNo = await nextDocumentNo(db, auth.activeFacilityId, 'nutrition_order', 'NUT');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO nutrition_diet_orders (id, facility_id, patient_id, admission_id, encounter_id, order_no,
             assessment_id, diet_type, texture, restrictions, energy_target_kcal, protein_target_g, fluid_limit_ml,
             allergen_snapshot, ordered_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, auth.activeFacilityId, admission.patient_id, admission.id, admission.encounter_id, orderNo,
            assessment.id, body.dietType, body.texture ?? (body.dietType === 'liquid' ? 'liquid' : 'normal'),
            body.restrictions, body.energyTargetKcal ?? Number(assessment.energy_target_kcal),
            body.proteinTargetG ?? Number(assessment.protein_target_g),
            body.fluidLimitMl ?? assessment.fluid_limit_ml ?? null,
            JSON.stringify(allergies.rows.map((a: any) => ({ allergen: a.allergen, severity: a.severity }))),
            auth.user.id, body.notes ?? null],
        );
        reply.code(201);
        return {
          id,
          orderNo,
          dietType: body.dietType,
          dietAr: DIET_AR[body.dietType],
          restrictions: body.restrictions,
          replacesOrderId: previous?.id ?? null,
          allergyChecked: allergies.rows.map((a: any) => a.allergen),
        };
      },
      (r) => ({
        action: 'nutrition.diet_order',
        entityType: 'nutrition_diet_order',
        entityId: r.id,
        patientId: null,
        detail: { orderNo: r.orderNo, dietType: r.dietType, restrictions: r.restrictions, replaces: r.replacesOrderId },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/nutrition/diet-orders/:id/discontinue', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.order');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await db.query(`SELECT * FROM nutrition_diet_orders WHERE id = $1`, [id]);
        const row = order.rows[0];
        if (!row) throw notFound('أمر التغذية غير موجود');
        if (row.status !== 'active') throw conflict('أمر التغذية موقوف مسبقًا');
        await db.query(
          `UPDATE nutrition_diet_orders SET status = 'discontinued', discontinued_at = now(),
             discontinued_by = $2, discontinue_reason = $3 WHERE id = $1`,
          [id, auth.user.id, body.reason],
        );
        return { id, status: 'discontinued', reason: body.reason };
      },
      () => ({
        action: 'nutrition.diet_order_discontinue',
        entityType: 'nutrition_diet_order',
        entityId: id,
        patientId: null,
        detail: { reason: body.reason },
        ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- Trays ----
  app.post('/api/nutrition/diet-orders/:id/trays', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.order');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body ?? {});
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await db.query(`SELECT * FROM nutrition_diet_orders WHERE id = $1`, [id]);
        const row = order.rows[0];
        if (!row) throw notFound('أمر التغذية غير موجود');
        if (row.status !== 'active') throw conflict('لا يمكن توليد وجبات لأمر تغذية موقوف');
        if (['npo', 'enteral', 'parenteral'].includes(String(row.diet_type))) {
          throw conflict('هذا الأمر لا يتضمن وجبات فموية؛ استخدم أمر التغذية الأنبوبية/الوريدية');
        }
        const date = body.date ?? new Date().toISOString().slice(0, 10);
        const energy = Number(row.energy_target_kcal ?? 0);
        const protein = Number(row.protein_target_g ?? 0);
        if (energy <= 0) throw conflict('أمر التغذية بلا هدف طاقة؛ حدّث التقييم');

        const created: any[] = [];
        const skipped: string[] = [];
        for (const [meal, share] of Object.entries(MEAL_SHARE)) {
          const existing = await db.query(
            `SELECT id FROM nutrition_trays WHERE diet_order_id = $1 AND tray_date = $2 AND meal = $3`,
            [id, date, meal],
          );
          if (existing.rows[0]) {
            skipped.push(meal);
            continue;
          }
          const trayId = crypto.randomUUID();
          const trayNo = await nextDocumentNo(db, auth.activeFacilityId, 'nutrition_tray', 'TRY');
          await db.query(
            `INSERT INTO nutrition_trays (id, facility_id, diet_order_id, patient_id, admission_id, tray_no,
               tray_date, meal, kcal_planned, protein_planned_g, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [trayId, auth.activeFacilityId, id, row.patient_id, row.admission_id, trayNo, date, meal,
              Math.round((energy * share) / 100), Math.round(((protein * share) / 100) * 10) / 10,
              `حصة ${share}% من هدف اليوم`],
          );
          created.push({ id: trayId, trayNo, meal, mealAr: MEAL_AR[meal], kcal: Math.round((energy * share) / 100) });
        }
        reply.code(201);
        return { dietOrderId: id, date, created, skipped, note: 'حصة الطاقة موزعة ٢٥/٣٥/٣٠/١٠٪ ولا تمثل قائمة طعام فعلية' };
      },
      (r) => ({
        action: 'nutrition.trays_generate',
        entityType: 'nutrition_diet_order',
        entityId: id,
        patientId: null,
        detail: { date: r.date, created: r.created.length, skipped: r.skipped.length },
        ip: req.ip,
      }),
    );
  });

  // Kitchen worklist: operational data only, no clinical risk fields.
  app.get('/api/nutrition/kitchen', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.kitchen');
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT t.id, t.tray_no, t.meal, t.status, t.kcal_planned, t.protein_planned_g, t.tray_date,
                p.mrn, p.full_name_ar AS patient_name,
                d.diet_type, d.texture, d.restrictions,
                w.name_ar AS ward_name, r.room_no, b.bed_no
           FROM nutrition_trays t
           JOIN patients p ON p.id = t.patient_id
           JOIN nutrition_diet_orders d ON d.id = t.diet_order_id
           LEFT JOIN admissions a ON a.id = t.admission_id
           LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
          WHERE t.facility_id = $1 AND t.tray_date = $2 AND t.status <> 'cancelled'
          ORDER BY CASE t.meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, t.tray_no`,
        [auth.activeFacilityId, date],
      );
      return {
        date,
        items: rows.rows.map((r: any) => ({
          ...r,
          kcal_planned: Number(r.kcal_planned),
          protein_planned_g: Number(r.protein_planned_g),
          meal_ar: MEAL_AR[r.meal],
          diet_ar: DIET_AR[r.diet_type],
          restriction_labels: (r.restrictions ?? []).map((x: string) => RESTRICTION_AR[x] ?? x),
        })),
        totals: {
          ordered: rows.rows.filter((r: any) => r.status === 'ordered').length,
          prepared: rows.rows.filter((r: any) => r.status === 'prepared').length,
          delivered: rows.rows.filter((r: any) => r.status === 'delivered').length,
        },
      };
    });
  });

  app.post('/api/nutrition/trays/:id/prepare', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.kitchen');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const tray = await db.query(`SELECT * FROM nutrition_trays WHERE id = $1`, [id]);
        if (!tray.rows[0]) throw notFound('صينية الوجبة غير موجودة');
        if (tray.rows[0].status !== 'ordered') throw conflict('لا يمكن تحضير صينية ليست بحالة «مطلوبة»');
        await db.query(
          `UPDATE nutrition_trays SET status = 'prepared', prepared_by = $2, prepared_at = now() WHERE id = $1`,
          [id, auth.user.id],
        );
        return { id, status: 'prepared' };
      },
      () => ({ action: 'nutrition.tray_prepare', entityType: 'nutrition_tray', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  app.post('/api/nutrition/trays/:id/deliver', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.kitchen');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const tray = await db.query(`SELECT * FROM nutrition_trays WHERE id = $1`, [id]);
        if (!tray.rows[0]) throw notFound('صينية الوجبة غير موجودة');
        if (tray.rows[0].status !== 'prepared') throw conflict('يجب تحضير الصينية قبل تسليمها');
        await db.query(
          `UPDATE nutrition_trays SET status = 'delivered', delivered_by = $2, delivered_at = now() WHERE id = $1`,
          [id, auth.user.id],
        );
        return { id, status: 'delivered' };
      },
      () => ({ action: 'nutrition.tray_deliver', entityType: 'nutrition_tray', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  // Intake is a clinical observation: nursing records how much was eaten.
  app.post('/api/nutrition/trays/:id/intake', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.intake');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        consumedPct: z.number().int().min(0).max(100),
        refused: z.boolean().default(false),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const tray = await db.query(`SELECT * FROM nutrition_trays WHERE id = $1`, [id]);
        const row = tray.rows[0];
        if (!row) throw notFound('صينية الوجبة غير موجودة');
        if (row.status !== 'delivered') throw conflict('لا يمكن تسجيل الاستهلاك قبل تسليم الصينية للمريض');
        if (body.refused && body.consumedPct > 0) throw conflict('الصينية المرفوضة لا يمكن أن يكون استهلاكها أكبر من صفر');

        const pct = body.refused ? 0 : body.consumedPct;
        const kcal = Math.round((Number(row.kcal_planned) * pct) / 100);
        const protein = Math.round(((Number(row.protein_planned_g) * pct) / 100) * 10) / 10;
        await db.query(
          `UPDATE nutrition_trays SET status = $2, intake_pct = $3, kcal_consumed = $4, protein_consumed_g = $5,
             intake_recorded_by = $6, intake_recorded_at = now(), notes = COALESCE($7, notes)
           WHERE id = $1`,
          [id, body.refused ? 'refused' : 'consumed', pct, kcal, protein, auth.user.id, body.notes ?? null],
        );
        return { id, status: body.refused ? 'refused' : 'consumed', intakePct: pct, kcalConsumed: kcal, proteinConsumedG: protein };
      },
      (r) => ({
        action: 'nutrition.intake',
        entityType: 'nutrition_tray',
        entityId: id,
        patientId: null,
        detail: { status: r.status, intakePct: r.intakePct, kcal: r.kcalConsumed },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------- Tube / TPN feed ---
  app.post('/api/nutrition/tube-orders', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.tube');
    const body = parse(
      z.object({
        admissionId: zId,
        route: z.enum(['ng', 'og', 'peg', 'pej', 'tpn', 'ppn']),
        formulaName: z.string().min(2).max(120),
        kcalPerMl: z.number().min(0.3).max(3),
        proteinGPerL: z.number().min(0).max(150),
        rateMlHr: z.number().min(1).max(300),
        hoursPerDay: z.number().int().min(1).max(24),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await activeAdmissionOr409(db, body.admissionId);
        const patient = await loadPatientOr404(db, admission.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_tube' });
        if (!(await latestAssessment(db, admission.id))) {
          throw conflict('لا يمكن بدء تغذية أنبوبية قبل تقييم أخصائي التغذية');
        }
        const active = await db.query(
          `SELECT order_no, route FROM nutrition_tube_orders WHERE admission_id = $1 AND route = $2 AND status = 'active'`,
          [admission.id, body.route],
        );
        if (active.rows[0]) {
          throw conflict(`يوجد أمر تغذية نشط على نفس المسار (${active.rows[0].order_no})؛ أوقفه قبل البدء بغيره`);
        }
        const volume = Math.round(body.rateMlHr * body.hoursPerDay);
        const kcalDay = Math.round(volume * body.kcalPerMl);
        const proteinDay = Math.round(((volume / 1000) * body.proteinGPerL) * 10) / 10;
        const orderNo = await nextDocumentNo(db, auth.activeFacilityId, 'nutrition_order', 'NUT');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO nutrition_tube_orders (id, facility_id, patient_id, admission_id, encounter_id, order_no,
             route, formula_name, kcal_per_ml, protein_g_per_l, rate_ml_hr, hours_per_day, volume_ml_day,
             kcal_day, protein_g_day, ordered_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, auth.activeFacilityId, admission.patient_id, admission.id, admission.encounter_id, orderNo,
            body.route, body.formulaName, body.kcalPerMl, body.proteinGPerL, body.rateMlHr, body.hoursPerDay,
            volume, kcalDay, proteinDay, auth.user.id, body.notes ?? null],
        );
        reply.code(201);
        return { id, orderNo, route: body.route, routeAr: ROUTE_AR[body.route], volumeMlDay: volume, kcalDay, proteinGDay: proteinDay };
      },
      (r) => ({
        action: 'nutrition.tube_order',
        entityType: 'nutrition_tube_order',
        entityId: r.id,
        patientId: null,
        detail: { orderNo: r.orderNo, route: r.route, volume: r.volumeMlDay, kcal: r.kcalDay },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/nutrition/tube-orders/:id/stop', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.tube');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ reason: z.string().min(5).max(300), completed: z.boolean().default(false) }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await db.query(`SELECT * FROM nutrition_tube_orders WHERE id = $1`, [id]);
        if (!order.rows[0]) throw notFound('أمر التغذية غير موجود');
        if (order.rows[0].status !== 'active') throw conflict('أمر التغذية مغلق مسبقًا');
        await db.query(
          `UPDATE nutrition_tube_orders SET status = $2, stopped_at = now(), stopped_by = $3, stop_reason = $4
            WHERE id = $1`,
          [id, body.completed ? 'completed' : 'stopped', auth.user.id, body.reason],
        );
        return { id, status: body.completed ? 'completed' : 'stopped', reason: body.reason };
      },
      () => ({
        action: 'nutrition.tube_order_stop',
        entityType: 'nutrition_tube_order',
        entityId: id,
        patientId: null,
        detail: { reason: body.reason, completed: body.completed },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Follow-up ----
  app.post('/api/nutrition/patients/:patientId/followups', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.assess');
    const { patientId } = parse(z.object({ patientId: zId }), req.params);
    const body = parse(
      z.object({
        admissionId: zId,
        weightKg: z.number().min(20).max(400).optional(),
        intakePctAvg: z.number().int().min(0).max(100).optional(),
        tolerance: z.enum(['good', 'partial', 'poor']),
        note: z.string().min(10).max(2000),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const admission = await activeAdmissionOr409(db, body.admissionId);
        if (admission.patient_id !== patientId) throw conflict('التنويم لا يخص هذا المريض');
        const patient = await loadPatientOr404(db, patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_followup' });
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO nutrition_followups (id, facility_id, patient_id, admission_id, weight_kg, intake_pct_avg,
             tolerance, note, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, auth.activeFacilityId, patientId, admission.id, body.weightKg ?? null,
            body.intakePctAvg ?? null, body.tolerance, body.note, auth.user.id],
        );
        reply.code(201);
        return { id, recordedAt: new Date().toISOString() };
      },
      (r) => ({
        action: 'nutrition.followup',
        entityType: 'nutrition_followup',
        entityId: r.id,
        patientId,
        detail: { tolerance: body.tolerance, weightKg: body.weightKg ?? null },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Patient file -
  app.get('/api/nutrition/patients/:patientId', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nutrition.read');
    const { patientId } = parse(z.object({ patientId: zId }), req.params);
    return withTenant(auth, async (db) => {
      const patient = await loadPatientOr404(db, patientId);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'nutrition_file' });

      const [screenings, assessments, orders, tubes, followups, trays, dietary] = await Promise.all([
        db.query(`SELECT * FROM nutrition_screenings WHERE patient_id = $1 ORDER BY recorded_at DESC LIMIT 20`, [patientId]),
        db.query(`SELECT * FROM nutrition_assessments WHERE patient_id = $1 ORDER BY assessed_at DESC LIMIT 20`, [patientId]),
        db.query(
          `SELECT d.*, u.full_name_ar AS ordered_by_name
             FROM nutrition_diet_orders d JOIN users u ON u.id = d.ordered_by
            WHERE d.patient_id = $1 ORDER BY d.started_at DESC LIMIT 20`, [patientId]),
        db.query(
          `SELECT t.*, u.full_name_ar AS ordered_by_name
             FROM nutrition_tube_orders t JOIN users u ON u.id = t.ordered_by
            WHERE t.patient_id = $1 ORDER BY t.started_at DESC LIMIT 20`, [patientId]),
        db.query(
          `SELECT f.*, u.full_name_ar AS recorded_by_name
             FROM nutrition_followups f JOIN users u ON u.id = f.recorded_by
            WHERE f.patient_id = $1 ORDER BY f.recorded_at DESC LIMIT 20`, [patientId]),
        db.query(
          `SELECT t.*, u.full_name_ar AS delivered_by_name
             FROM nutrition_trays t LEFT JOIN users u ON u.id = t.delivered_by
            WHERE t.patient_id = $1 AND t.tray_date >= current_date - 2
            ORDER BY t.tray_date DESC, t.meal`,
          [patientId],
        ),
        db.query(
          `SELECT allergen, reaction, severity FROM patient_allergies WHERE patient_id = $1 AND is_active = true`,
          [patientId],
        ),
      ]);
      const required = [...requiredRestrictions(dietary.rows as unknown as { allergen: string }[]).entries()]
        .map(([code, name]) => ({ code, name }));
      const activeOrder = orders.rows.find((o: any) => o.status === 'active') ?? null;
      const todayConsumed = trays.rows
        .filter((t: any) => t.tray_date === new Date().toISOString().slice(0, 10))
        .reduce((sum: number, t: any) => sum + Number(t.kcal_consumed ?? 0), 0);

      return {
        patient: { id: patient.id, mrn: patient.mrn, name: patient.full_name_ar },
        allergies: dietary.rows,
        requiredRestrictions: required,
        activeDiet: activeOrder ? {
          ...activeOrder,
          dietAr: DIET_AR[String(activeOrder.diet_type)],
          restrictionLabels: ((activeOrder.restrictions ?? []) as string[]).map((x) => RESTRICTION_AR[x] ?? x),
        } : null,
        screenings: screenings.rows,
        assessments: assessments.rows,
        dietOrders: orders.rows.map((o: any) => ({
          ...o,
          dietAr: DIET_AR[o.diet_type],
          restrictionLabels: (o.restrictions ?? []).map((x: string) => RESTRICTION_AR[x] ?? x),
        })),
        tubeOrders: tubes.rows.map((t: any) => ({ ...t, routeAr: ROUTE_AR[t.route] })),
        trays: trays.rows.map((t: any) => ({ ...t, mealAr: MEAL_AR[t.meal], kcal_planned: Number(t.kcal_planned) })),
        followups: followups.rows,
        today: {
          kcalConsumed: todayConsumed,
          targetKcal: activeOrder ? Number(activeOrder.energy_target_kcal ?? 0) : 0,
          adherencePct: activeOrder && Number(activeOrder.energy_target_kcal) > 0
            ? Math.round((todayConsumed / Number(activeOrder.energy_target_kcal)) * 100)
            : null,
        },
        limits: 'أهداف الطاقة/البروتين تقديرية حسب الوزن، وتوزيع الوجبات ثابت ٢٥/٣٥/٣٠/١٠٪؛ لا قاعدة تراكيب غذائية ولا مخزون مطبخ.',
      };
    });
  });
}
