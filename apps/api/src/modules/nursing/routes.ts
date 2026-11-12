import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

/**
 * Nursing module: the medication administration record (MAR), nursing care
 * plans with scheduled tasks, and shift handover (SBAR).
 *
 * Safety rules enforced here (not only in the UI):
 *  - a medicine can only be given after the pharmacy dispensed it;
 *  - giving records the five rights (patient identity + allergy check + dose +
 *    route + time) and refuses to proceed without them;
 *  - high-alert medicines need a second nurse as witness holding nursing.witness;
 *  - one record per scheduled slot; corrections are appended, never edited.
 */

const DEFAULT_INTERVAL_HOURS = 24;

function parseIntervalHours(frequency: string | null | undefined, stored: number | null | undefined): number {
  if (stored && stored >= 1) return stored;
  const text = (frequency ?? '').replace(/\u200f/g, '');
  if (/مرتين|twice/i.test(text)) return 12;
  if (/ثلاث|three times/i.test(text)) return 8;
  if (/أربع|four times/i.test(text)) return 6;
  const everyHours = text.match(/كل\s*(\d{1,2})\s*ساع/);
  if (everyHours) return Math.min(168, Math.max(1, Number(everyHours[1])));
  const arabicDigits: Record<string, number> = { '٤': 4, '٦': 6, '٨': 8, '١٢': 12 };
  for (const [digit, hours] of Object.entries(arabicDigits)) {
    if (text.includes(`كل ${digit}`)) return hours;
  }
  if (/يوميًا|يوميا|once daily/i.test(text)) return 24;
  return DEFAULT_INTERVAL_HOURS;
}

interface DueDose {
  itemId: string;
  drug: string;
  dose: string;
  route: string;
  frequency: string;
  highAlert: boolean;
  lastGivenAt: string | null;
  nextDueAt: string;
  overdueMinutes: number;
}

async function loadAdmissionContext(db: any, admissionId: string) {
  const res = await db.query(
    `SELECT a.*, p.mrn, p.full_name_ar AS patient_name, e.encounter_no
       FROM admissions a
       JOIN patients p ON p.id = a.patient_id
       JOIN encounters e ON e.id = a.encounter_id
      WHERE a.id = $1`,
    [admissionId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('التنويم غير موجود');
  return row;
}

async function loadEncounterContext(db: any, encounterId: string) {
  const res = await db.query(
    `SELECT e.*, p.mrn, p.full_name_ar AS patient_name, p.facility_id AS patient_facility
       FROM encounters e JOIN patients p ON p.id = e.patient_id
      WHERE e.id = $1`,
    [encounterId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('الزيارة غير موجودة');
  return row;
}

/** Active dispensed medicines of an encounter with their next due time. */
async function dueDoses(db: any, encounterIds: string[], now = new Date()): Promise<Record<string, DueDose[]>> {
  if (encounterIds.length === 0) return {};
  const items = await db.query(
    `SELECT pi.id, pr.encounter_id, pi.dose, pi.route, pi.frequency, pi.interval_hours,
            d.name_ar AS drug, d.is_high_alert,
            (SELECT max(m.scheduled_for) FROM medication_administrations m
              WHERE m.prescription_item_id = pi.id AND m.status = 'given' AND m.corrects_id IS NULL) AS last_given
       FROM prescription_items pi
       JOIN prescriptions pr ON pr.id = pi.prescription_id
       JOIN drugs d ON d.id = pi.drug_id
      WHERE pr.encounter_id = ANY($1::uuid[]) AND pi.status = 'dispensed' AND pr.status <> 'cancelled'`,
    [encounterIds],
  );
  const out: Record<string, DueDose[]> = {};
  for (const row of items.rows as any[]) {
    const interval = parseIntervalHours(row.frequency, row.interval_hours);
    const anchor = row.last_given ? new Date(row.last_given) : new Date(now.getTime() - interval * 3600_000 + 30 * 60_000);
    const nextDue = row.last_given
      ? new Date(new Date(row.last_given).getTime() + interval * 3600_000)
      : new Date(anchor.getTime());
    const overdueMinutes = Math.max(0, Math.round((now.getTime() - nextDue.getTime()) / 60_000));
    (out[row.encounter_id] ??= []).push({
      itemId: row.id,
      drug: row.drug,
      dose: row.dose,
      route: row.route,
      frequency: row.frequency,
      highAlert: Boolean(row.is_high_alert),
      lastGivenAt: row.last_given,
      nextDueAt: nextDue.toISOString(),
      overdueMinutes,
    });
  }
  return out;
}

export async function nursingRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ Board ---
  app.get('/api/nursing/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    return withTenant(auth, async (db: any) => {
      const rows = await db.query(
        `SELECT a.id AS admission_id, a.admission_no, a.admitted_at, a.patient_id, a.encounter_id,
                p.mrn, p.full_name_ar AS patient_name, p.sex,
                b.bed_no, r.room_no, w.name_ar AS ward_name, w.ward_type,
                doc.full_name_ar AS doctor_name,
                (SELECT row_to_json(v) FROM (
                    SELECT heart_rate, systolic_bp, diastolic_bp, spo2, temperature_c, pain_score, recorded_at
                      FROM vitals WHERE encounter_id = a.encounter_id ORDER BY recorded_at DESC LIMIT 1) v) AS last_vitals
           FROM admissions a
           JOIN patients p ON p.id = a.patient_id
           LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
           JOIN users doc ON doc.id = a.attending_doctor_id
          WHERE a.facility_id = $1 AND a.status = 'active'
          ORDER BY w.name_ar NULLS LAST, r.room_no NULLS LAST, b.bed_no`,
        [auth.activeFacilityId],
      );
      const admissions = rows.rows as any[];
      const encounterIds = admissions.map((a) => a.encounter_id);
      const dues = await dueDoses(db, encounterIds);

      const taskRows = encounterIds.length
        ? await db.query(
            `SELECT cp.encounter_id,
                    count(*) FILTER (WHERE t.status = 'pending' AND (t.due_at IS NULL OR t.due_at <= now() + interval '60 minutes'))::int AS due_tasks,
                    count(*) FILTER (WHERE t.status = 'pending')::int AS open_tasks
               FROM care_plan_tasks t JOIN care_plans cp ON cp.id = t.care_plan_id
              WHERE cp.status = 'active' AND cp.encounter_id = ANY($1::uuid[])
              GROUP BY cp.encounter_id`,
            [encounterIds],
          )
        : { rows: [] };
      const tasksByEncounter = new Map((taskRows.rows as any[]).map((r) => [r.encounter_id, r]));

      const items = admissions.map((a) => {
        const doses = (dues[a.encounter_id] ?? []).sort((x, y) => x.nextDueAt.localeCompare(y.nextDueAt));
        const tasks = tasksByEncounter.get(a.encounter_id) as any;
        return {
          ...a,
          next_due: doses[0] ?? null,
          overdue_medications: doses.filter((d) => d.overdueMinutes > 0).length,
          due_tasks: tasks?.due_tasks ?? 0,
          open_tasks: tasks?.open_tasks ?? 0,
        };
      });

      return {
        items,
        totals: {
          patients: items.length,
          overdue_medications: items.reduce((n, i) => n + i.overdue_medications, 0),
          due_tasks: items.reduce((n, i) => n + i.due_tasks, 0),
        },
      };
    });
  });

  /** Nurses able to witness a high-alert administration in this facility. */
  app.get('/api/nursing/witnesses', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    return withTenant(auth, async (db: any) => {
      const rows = await db.query(
        `SELECT DISTINCT u.id, u.full_name_ar, r.name_ar AS role_ar
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.facility_id = $1 AND u.is_active = true AND rp.permission_code = 'nursing.witness'
          ORDER BY u.full_name_ar`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows };
    });
  });

  // ------------------------------------------------------ MAR per patient ----
  app.get('/api/nursing/patients/:id/mar', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db: any) => {
      const patient = await loadPatientOr404(db, id);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'mar_view' });

      const open = await db.query(
        `SELECT e.id, e.encounter_no, e.encounter_type, e.started_at,
                a.id AS admission_id, a.admission_no, b.bed_no, r.room_no, w.name_ar AS ward_name
           FROM encounters e
           LEFT JOIN admissions a ON a.encounter_id = e.id AND a.status = 'active'
           LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
          WHERE e.patient_id = $1 AND e.status = 'open'
          ORDER BY e.started_at DESC LIMIT 1`,
        [id],
      );
      const encounter = open.rows[0] ?? null;
      const dues = encounter ? await dueDoses(db, [encounter.id]) : {};

      const history = await db.query(
        `SELECT m.id, m.scheduled_for, m.administered_at, m.status, m.dose_given, m.route, m.site,
                m.reason, m.identity_verified, m.allergy_checked, m.corrects_id,
                d.name_ar AS drug, d.is_high_alert,
                nurse.full_name_ar AS nurse_name, wit.full_name_ar AS witness_name
           FROM medication_administrations m
           JOIN prescription_items pi ON pi.id = m.prescription_item_id
           JOIN drugs d ON d.id = pi.drug_id
           JOIN users nurse ON nurse.id = m.administered_by
           LEFT JOIN users wit ON wit.id = m.witness_by
          WHERE m.patient_id = $1
          ORDER BY m.administered_at DESC LIMIT 100`,
        [id],
      );

      return {
        patient: { id: patient.id, mrn: patient.mrn, nameAr: patient.full_name_ar },
        encounter,
        due: (dues[encounter?.id] ?? []).sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt)),
        history: history.rows,
      };
    });
  });

  // ------------------------------------------------------ MAR: administer ----
  app.post('/api/nursing/mar', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.mar.administer');
    const body = parse(
      z.object({
        prescriptionItemId: zId,
        scheduledFor: z.string().datetime().optional(),
        status: z.enum(['given', 'held', 'refused', 'missed']),
        doseGiven: z.string().max(60).optional(),
        route: z.string().max(40).optional(),
        site: z.string().max(60).optional(),
        identityVerified: z.boolean().default(false),
        allergyChecked: z.boolean().default(false),
        witnessUserId: zId.optional(),
        reason: z.string().max(500).optional(),
        administeredAt: z.string().datetime().optional(),
      }),
      req.body,
    );

    return withTenantAudited(
      auth,
      async (db: any) => {
        const itemRes = await db.query(
          `SELECT pi.*, pr.encounter_id, pr.patient_id, pr.status AS prescription_status,
                  d.name_ar AS drug, d.is_high_alert
             FROM prescription_items pi
             JOIN prescriptions pr ON pr.id = pi.prescription_id
             JOIN drugs d ON d.id = pi.drug_id
            WHERE pi.id = $1`,
          [body.prescriptionItemId],
        );
        const item = itemRes.rows[0];
        if (!item) throw notFound('بند الوصفة غير موجود');
        if (item.facility_id !== auth.activeFacilityId) throw notFound('بند الوصفة غير موجود');
        if (item.status !== 'dispensed') throw conflict('لا يمكن إعطاء دواء لم يصرفه الصيدلي بعد');
        if (item.prescription_status === 'cancelled') throw conflict('الوصفة ملغاة');

        const encounter = await loadEncounterContext(db, item.encounter_id);
        if (encounter.status !== 'open') throw conflict('لا يمكن تسجيل إعطاء دواء على زيارة مغلقة');
        await authorizeChartAccess(db, auth, await loadPatientOr404(db, item.patient_id), 'clinical', {
          ip: req.ip,
          accessType: 'mar_record',
        });

        if (body.status === 'given') {
          if (!body.identityVerified || !body.allergyChecked) {
            throw conflict('يجب التحقق من هوية المريض ومن الحساسية قبل الإعطاء (حقوق الإعطاء الخمسة)');
          }
          if (!body.doseGiven || !body.route) throw conflict('الجرعة ومسار الإعطاء مطلوبان');
        } else if (!body.reason || body.reason.trim().length < 5) {
          throw conflict('سبب عدم الإعطاء (إيقاف/رفض/فوات) مطلوب بخمسة أحرف على الأقل');
        }

        let witnessName: string | null = null;
        if (item.is_high_alert && body.status === 'given') {
          if (!body.witnessUserId) throw conflict('دواء عالي الخطورة: يلزم شاهد ثانٍ من التمريض');
          if (body.witnessUserId === auth.user.id) throw conflict('لا يمكن أن يكون الشاهد هو نفس منفذ الإعطاء');
          const witness = await db.query(
            `SELECT u.full_name_ar,
                    EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                             WHERE ur.user_id = u.id AND ur.facility_id = $2 AND rp.permission_code = 'nursing.witness') AS allowed
               FROM users u WHERE u.id = $1`,
            [body.witnessUserId, auth.activeFacilityId],
          );
          const w = witness.rows[0];
          if (!w || !w.allowed) throw forbidden('الشاهد المحدد لا يملك صلاحية الشهادة على إعطاء الأدوية في هذه المنشأة');
          witnessName = w.full_name_ar;
        }

        // Minimum spacing between doses of the same order: half the prescribed
        // interval. Without this a double dose could be recorded minutes apart.
        if (body.status === 'given') {
          const interval = parseIntervalHours(item.frequency, item.interval_hours);
          const lastGiven = await db.query(
            `SELECT administered_at FROM medication_administrations
              WHERE prescription_item_id = $1 AND status = 'given' AND corrects_id IS NULL
              ORDER BY administered_at DESC LIMIT 1`,
            [item.id],
          );
          if (lastGiven.rows[0]) {
            const elapsedMin = (Date.now() - new Date(lastGiven.rows[0].administered_at).getTime()) / 60_000;
            const minGapMin = interval * 30; // half the interval, in minutes
            if (elapsedMin < minGapMin) {
              throw conflict(
                `الجرعة السابقة أُعطيت قبل ${Math.round(elapsedMin)} دقيقة؛ أقل فاصل مسموح لهذا الدواء ${interval} ساعة`,
              );
            }
          }
        }

        const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : new Date();
        const existing = await db.query(
          `SELECT id FROM medication_administrations
            WHERE prescription_item_id = $1 AND scheduled_for = $2 AND corrects_id IS NULL`,
          [body.prescriptionItemId, scheduledFor.toISOString()],
        );
        if (existing.rows[0]) throw conflict('سُجل إعطاء لهذه الجرعة مسبقًا في نفس الوقت المجدول');

        const admission = await db.query(
          `SELECT id FROM admissions WHERE encounter_id = $1 AND status = 'active' LIMIT 1`,
          [item.encounter_id],
        );

        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO medication_administrations (id, facility_id, patient_id, encounter_id, admission_id,
             prescription_item_id, scheduled_for, administered_at, status, dose_given, route, site,
             identity_verified, allergy_checked, administered_by, witness_by, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, item.facility_id, item.patient_id, item.encounter_id, admission.rows[0]?.id ?? null,
            item.id, scheduledFor.toISOString(), body.administeredAt ?? new Date().toISOString(), body.status,
            body.doseGiven ?? null, body.route ?? null, body.site ?? null, body.identityVerified, body.allergyChecked,
            auth.user.id, body.witnessUserId ?? null, body.reason ?? null],
        );
        reply.code(201);
        return {
          id,
          status: body.status,
          drug: item.drug,
          highAlert: Boolean(item.is_high_alert),
          witness: witnessName,
          scheduledFor: scheduledFor.toISOString(),
        };
      },
      (r) => ({
        action: 'nursing.mar.record',
        entityType: 'medication_administration',
        entityId: r.id,
        patientId: null,
        detail: { status: r.status, drug: r.drug, witness: r.witness, highAlert: r.highAlert },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/nursing/mar/:id/correct', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.mar.administer');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        status: z.enum(['given', 'held', 'refused', 'missed']),
        doseGiven: z.string().max(60).optional(),
        route: z.string().max(40).optional(),
        reason: z.string().min(5).max(500),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db: any) => {
        const originalRes = await db.query(`SELECT * FROM medication_administrations WHERE id = $1`, [id]);
        const original = originalRes.rows[0];
        if (!original) throw notFound('سجل الإعطاء غير موجود');
        await authorizeChartAccess(db, auth, await loadPatientOr404(db, original.patient_id), 'clinical', {
          ip: req.ip,
          accessType: 'mar_correct',
        });
        const corrected = await db.query(
          `SELECT 1 FROM medication_administrations WHERE corrects_id = $1`,
          [id],
        );
        if (corrected.rows[0]) throw conflict('سُجل تصحيح لهذا السجل مسبقًا؛ صحّح السجل الأحدث بدلًا منه');

        const newId = crypto.randomUUID();
        await db.query(
          `INSERT INTO medication_administrations (id, facility_id, patient_id, encounter_id, admission_id,
             prescription_item_id, scheduled_for, status, dose_given, route, site, identity_verified,
             allergy_checked, administered_by, reason, corrects_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [newId, original.facility_id, original.patient_id, original.encounter_id, original.admission_id,
            original.prescription_item_id, original.scheduled_for, body.status, body.doseGiven ?? original.dose_given,
            body.route ?? original.route, original.site, original.identity_verified, original.allergy_checked,
            auth.user.id, body.reason, original.id],
        );
        reply.code(201);
        return { id: newId, correctsId: original.id, status: body.status };
      },
      (r) => ({
        action: 'nursing.mar.correct',
        entityType: 'medication_administration',
        entityId: r.id,
        patientId: null,
        detail: { correctsId: r.correctsId, status: r.status, reason: body.reason },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Care plans ---
  app.post('/api/nursing/care-plans', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.careplan.manage');
    const body = parse(
      z.object({
        encounterId: zId,
        admissionId: zId.optional(),
        title: z.string().min(3).max(150),
        nursingDiagnosis: z.string().min(5).max(500),
        goals: z.string().min(5).max(2000),
        tasks: z
          .array(
            z.object({
              description: z.string().min(3).max(300),
              dueAt: z.string().datetime().optional(),
              frequencyHours: z.number().int().min(1).max(168).optional(),
            }),
          )
          .max(20)
          .default([]),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db: any) => {
        const encounter = await loadEncounterContext(db, body.encounterId);
        if (encounter.status !== 'open') throw conflict('لا يمكن إنشاء خطة رعاية على زيارة مغلقة');
        await authorizeChartAccess(db, auth, await loadPatientOr404(db, encounter.patient_id), 'clinical', {
          ip: req.ip,
          accessType: 'care_plan_create',
        });
        const admission = await db.query(
          `SELECT id FROM admissions WHERE encounter_id = $1 AND status = 'active' LIMIT 1`,
          [body.encounterId],
        );
        const planId = crypto.randomUUID();
        await db.query(
          `INSERT INTO care_plans (id, facility_id, patient_id, encounter_id, admission_id, title, nursing_diagnosis, goals, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [planId, encounter.facility_id, encounter.patient_id, body.encounterId,
            body.admissionId ?? admission.rows[0]?.id ?? null, body.title, body.nursingDiagnosis, body.goals, auth.user.id],
        );
        const tasks = body.tasks ?? [];
        for (const task of tasks) {
          await db.query(
            `INSERT INTO care_plan_tasks (id, facility_id, care_plan_id, description, due_at, frequency_hours)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [crypto.randomUUID(), encounter.facility_id, planId, task.description, task.dueAt ?? null, task.frequencyHours ?? null],
          );
        }
        reply.code(201);
        return { id: planId, tasks: tasks.length };
      },
      (r) => ({
        action: 'nursing.care_plan.create',
        entityType: 'care_plan',
        entityId: r.id,
        patientId: null,
        detail: { title: body.title, tasks: r.tasks, encounterId: body.encounterId },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/nursing/care-plans', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    const q = parse(z.object({ admissionId: zId.optional(), encounterId: zId.optional(), patientId: zId.optional() }), req.query);
    if (!q.admissionId && !q.encounterId && !q.patientId) throw conflict('حدد التنويم أو الزيارة أو المريض');
    return withTenant(auth, async (db: any) => {
      const params: any[] = [auth.activeFacilityId];
      let filter = '';
      if (q.admissionId) {
        params.push(q.admissionId);
        filter = `AND cp.admission_id = $${params.length}`;
      } else if (q.encounterId) {
        params.push(q.encounterId);
        filter = `AND cp.encounter_id = $${params.length}`;
      } else {
        params.push(q.patientId);
        filter = `AND cp.patient_id = $${params.length}`;
      }
      const plans = await db.query(
        `SELECT cp.*, u.full_name_ar AS created_by_name,
                (SELECT row_to_json(t) FROM (
                    SELECT count(*)::int AS open FROM care_plan_tasks
                     WHERE care_plan_id = cp.id AND status = 'pending') t) AS task_counts
           FROM care_plans cp JOIN users u ON u.id = cp.created_by
          WHERE cp.facility_id = $1 ${filter}
          ORDER BY cp.created_at DESC`,
        params,
      );
      const ids = (plans.rows as any[]).map((p) => p.id);
      const tasks = ids.length
        ? await db.query(
            `SELECT t.*, u.full_name_ar AS completed_by_name FROM care_plan_tasks t
               LEFT JOIN users u ON u.id = t.completed_by
              WHERE t.care_plan_id = ANY($1::uuid[]) ORDER BY t.due_at NULLS LAST, t.created_at`,
            [ids],
          )
        : { rows: [] };
      return {
        plans: (plans.rows as any[]).map((p) => ({ ...p, tasks: (tasks.rows as any[]).filter((t) => t.care_plan_id === p.id) })),
      };
    });
  });

  app.post('/api/nursing/care-plans/:id/tasks', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.careplan.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        description: z.string().min(3).max(300),
        dueAt: z.string().datetime().optional(),
        frequencyHours: z.number().int().min(1).max(168).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db: any) => {
        const planRes = await db.query(`SELECT * FROM care_plans WHERE id = $1`, [id]);
        const plan = planRes.rows[0];
        if (!plan) throw notFound('خطة الرعاية غير موجودة');
        if (plan.status !== 'active') throw conflict('الخطة غير نشطة');
        const taskId = crypto.randomUUID();
        await db.query(
          `INSERT INTO care_plan_tasks (id, facility_id, care_plan_id, description, due_at, frequency_hours)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [taskId, plan.facility_id, id, body.description, body.dueAt ?? null, body.frequencyHours ?? null],
        );
        reply.code(201);
        return { id: taskId };
      },
      (r) => ({
        action: 'nursing.care_plan.task_add',
        entityType: 'care_plan',
        entityId: id,
        patientId: null,
        detail: { taskId: r.id, description: body.description },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/nursing/care-plan-tasks/:id/complete', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.mar.administer');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ status: z.enum(['done', 'skipped']).default('done'), note: z.string().max(500).optional() }),
      req.body,
    );
    if (body.status === 'skipped' && (!body.note || body.note.trim().length < 5)) {
      throw conflict('تخطي مهمة رعاية يتطلب سببًا موثقًا');
    }
    return withTenantAudited(
      auth,
      async (db: any) => {
        const taskRes = await db.query(`SELECT * FROM care_plan_tasks WHERE id = $1`, [id]);
        const task = taskRes.rows[0];
        if (!task) throw notFound('مهمة الرعاية غير موجودة');
        if (task.status !== 'pending') throw conflict('المهمة مغلقة مسبقًا');
        await db.query(
          `UPDATE care_plan_tasks SET status = $1, completed_by = $2, completed_at = now(), note = $3 WHERE id = $4`,
          [body.status, auth.user.id, body.note ?? null, id],
        );
        return { ok: true, status: body.status };
      },
      () => ({
        action: 'nursing.care_plan.task_complete',
        entityType: 'care_plan_task',
        entityId: id,
        patientId: null,
        detail: { status: body.status, note: body.note ?? null },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/nursing/care-plans/:id/close', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.careplan.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ status: z.enum(['achieved', 'discontinued']), reason: z.string().min(5).max(500) }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db: any) => {
        const planRes = await db.query(`SELECT * FROM care_plans WHERE id = $1`, [id]);
        const plan = planRes.rows[0];
        if (!plan) throw notFound('خطة الرعاية غير موجودة');
        if (plan.status !== 'active') throw conflict('الخطة مغلقة مسبقًا');
        await db.query(
          `UPDATE care_plans SET status = $1, ended_at = now(), end_reason = $2, reviewed_at = now() WHERE id = $3`,
          [body.status, body.reason, id],
        );
        return { ok: true, status: body.status };
      },
      () => ({
        action: 'nursing.care_plan.close',
        entityType: 'care_plan',
        entityId: id,
        patientId: null,
        detail: { status: body.status, reason: body.reason },
        ip: req.ip,
      }),
    );
  });

  // -------------------------------------------------------------- Handover ---
  app.post('/api/nursing/handovers', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.handover.write');
    const body = parse(
      z.object({
        encounterId: zId,
        shift: z.enum(['morning', 'evening', 'night']),
        condition: z.enum(['stable', 'improving', 'deteriorating', 'critical']),
        situation: z.string().min(10).max(2000),
        background: z.string().min(10).max(4000),
        assessment: z.string().min(10).max(2000),
        recommendation: z.string().min(10).max(2000),
        toUserId: zId.optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db: any) => {
        const encounter = await loadEncounterContext(db, body.encounterId);
        if (encounter.status !== 'open') throw conflict('لا يمكن تسليم مناوبة على زيارة مغلقة');
        await authorizeChartAccess(db, auth, await loadPatientOr404(db, encounter.patient_id), 'clinical', {
          ip: req.ip,
          accessType: 'handover_write',
        });
        if (body.toUserId) {
          const nurseCheck = await db.query(
            `SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                             WHERE ur.user_id = $1 AND ur.facility_id = $2 AND rp.permission_code = 'nursing.read') AS ok`,
            [body.toUserId, auth.activeFacilityId],
          );
          if (!nurseCheck.rows[0]?.ok) throw conflict('المستلم المحدد لا يملك صلاحية استلام مناوبة في هذه المنشأة');
        }
        const admission = await db.query(
          `SELECT id FROM admissions WHERE encounter_id = $1 AND status = 'active' LIMIT 1`,
          [body.encounterId],
        );
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO shift_handovers (id, facility_id, patient_id, encounter_id, admission_id, shift, patient_condition,
             situation, background, assessment, recommendation, from_user_id, to_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, encounter.facility_id, encounter.patient_id, body.encounterId, admission.rows[0]?.id ?? null, body.shift,
            body.condition, body.situation, body.background, body.assessment, body.recommendation, auth.user.id,
            body.toUserId ?? null],
        );
        reply.code(201);
        return { id };
      },
      (r) => ({
        action: 'nursing.handover.write',
        entityType: 'shift_handover',
        entityId: r.id,
        patientId: null,
        detail: { shift: body.shift, condition: body.condition, encounterId: body.encounterId },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/nursing/handovers', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    const q = parse(z.object({ admissionId: zId.optional(), patientId: zId.optional() }), req.query);
    if (!q.admissionId && !q.patientId) throw conflict('حدد التنويم أو المريض');
    return withTenant(auth, async (db: any) => {
      const params: any[] = [auth.activeFacilityId];
      params.push(q.admissionId ?? q.patientId);
      const filter = q.admissionId ? `h.admission_id = $2` : `h.patient_id = $2`;
      const rows = await db.query(
        `SELECT h.*, f.full_name_ar AS from_name, t.full_name_ar AS to_name, ack.full_name_ar AS acknowledged_by_name,
                p.mrn, p.full_name_ar AS patient_name
           FROM shift_handovers h
           JOIN users f ON f.id = h.from_user_id
           LEFT JOIN users t ON t.id = h.to_user_id
           LEFT JOIN users ack ON ack.id = h.acknowledged_by
           JOIN patients p ON p.id = h.patient_id
          WHERE h.facility_id = $1 AND ${filter}
          ORDER BY h.handed_over_at DESC LIMIT 50`,
        params,
      );
      return { items: rows.rows };
    });
  });

  app.post('/api/nursing/handovers/:id/acknowledge', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'nursing.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db: any) => {
        const res = await db.query(`SELECT * FROM shift_handovers WHERE id = $1`, [id]);
        const handover = res.rows[0];
        if (!handover) throw notFound('سجل التسليم غير موجود');
        if (handover.acknowledged_at) throw conflict('سُجل استلام هذا التسليم مسبقًا');
        if (handover.from_user_id === auth.user.id) throw conflict('لا يمكن للمُسلِّم أن يستلم تسليمه بنفسه');
        await db.query(
          `UPDATE shift_handovers SET acknowledged_by = $1, acknowledged_at = now() WHERE id = $2`,
          [auth.user.id, id],
        );
        return { ok: true, acknowledgedAt: new Date().toISOString() };
      },
      () => ({
        action: 'nursing.handover.acknowledge',
        entityType: 'shift_handover',
        entityId: id,
        patientId: null,
        detail: {},
        ip: req.ip,
      }),
    );
  });
}
