import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';
import { conflict, notFound } from '../../lib/errors';

const VALID_FDI_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18,
  21, 22, 23, 24, 25, 26, 27, 28,
  31, 32, 33, 34, 35, 36, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48,
  51, 52, 53, 54, 55,
  61, 62, 63, 64, 65,
  71, 72, 73, 74, 75,
  81, 82, 83, 84, 85,
]);

const zFdiTooth = z
  .number()
  .int()
  .refine((n) => VALID_FDI_TEETH.has(n), 'رقم السن غير صالح وفق نظام الترقيم العالمي FDI (11–48 أو 51–85)');

const SURFACES = ['whole', 'occlusal', 'mesial', 'distal', 'buccal', 'lingual', 'incisal'] as const;
const CONDITIONS = [
  'healthy',
  'caries',
  'filled',
  'crown',
  'root_canal',
  'missing',
  'extracted',
  'implant',
  'fracture',
  'periodontal',
] as const;

const CATEGORIES = [
  'exam',
  'restorative',
  'endodontic',
  'extraction',
  'periodontic',
  'prosthodontic',
  'orthodontic',
  'preventive',
  'oral_surgery',
] as const;

export const DENTAL_CONDITION_AR: Record<string, string> = {
  healthy: 'سليم',
  caries: 'تسوس نشط',
  filled: 'حشوة ترميمية',
  crown: 'تاج / تلبيسة',
  root_canal: 'معالج لبيًا (عصب)',
  missing: 'مفقود خلقيًا/سابقًا',
  extracted: 'مخلوع',
  implant: 'زرعة سنية',
  fracture: 'كسر تاجي/جذري',
  periodontal: 'إصابة لثوية حول سنية',
};

export const DENTAL_CATEGORY_AR: Record<string, string> = {
  exam: 'فحص وتشخيص فموي',
  restorative: 'مداواة تحفظية وحشوات',
  endodontic: 'علاج الجذور والأعصاب',
  extraction: 'خلع الأسنان',
  periodontic: 'علاج اللثة والأنسجة الداعمة',
  prosthodontic: 'تركيبات وتعويضات سنية',
  orthodontic: 'تقويم الأسنان',
  preventive: 'وقاية وتنظيف وفلورايد',
  oral_surgery: 'جراحة الفم والفكين',
};

export const DENTAL_CATALOG = [
  { code: 'D0120', category: 'exam', ar: 'فحص شامل للأسنان واللثة وخطة علاجية', fee: 120 },
  { code: 'D1110', category: 'preventive', ar: 'إزالة الجير وتلميع الأسنان (Scaling & Polishing)', fee: 220 },
  { code: 'D2391', category: 'restorative', ar: 'حشوة تجميلية ضوئية كومبوزيت (سطح واحد)', fee: 320 },
  { code: 'D2392', category: 'restorative', ar: 'حشوة تجميلية ضوئية كومبوزيت (سطحان أو أكثر)', fee: 420 },
  { code: 'D3310', category: 'endodontic', ar: 'معالجة لبية كاملة لسن أمامي (علاج عصب)', fee: 650 },
  { code: 'D3330', category: 'endodontic', ar: 'معالجة لبية لضرس خلفي متعدد القنوات', fee: 950 },
  { code: 'D7140', category: 'extraction', ar: 'خلع سن بسيط تحت التخدير الموضعي', fee: 250 },
  { code: 'D7210', category: 'oral_surgery', ar: 'خلع جراحي لضرس العقل المنطمر', fee: 650 },
  { code: 'D2740', category: 'prosthodontic', ar: 'تاج خزفي زيركونيا للسن', fee: 1400 },
  { code: 'D6010', category: 'oral_surgery', ar: 'غرسة سنية تيتانيوم (Dental Implant)', fee: 3200 },
] as const;

const AUTO_TOOTH_CONDITION: Partial<Record<(typeof CATEGORIES)[number], (typeof CONDITIONS)[number]>> = {
  restorative: 'filled',
  endodontic: 'root_canal',
  extraction: 'extracted',
  prosthodontic: 'crown',
};

export async function dentalRoutes(app: FastifyInstance) {
  app.get('/api/dental/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.read');
    return withTenant(auth, async (db) => {
      const [procedures, openEncounters, summary] = await Promise.all([
        db.query(
          `SELECT dp.*, p.full_name_ar AS patient_name, p.mrn, e.encounter_no,
                  u.full_name_ar AS dentist_name
             FROM dental_procedures dp
             JOIN patients p ON p.id = dp.patient_id
             JOIN encounters e ON e.id = dp.encounter_id
             JOIN users u ON u.id = dp.dentist_id
            WHERE dp.facility_id = $1
            ORDER BY CASE dp.status WHEN 'planned' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                     dp.created_at DESC
            LIMIT 150`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT e.id, e.encounter_no, e.patient_id, e.chief_complaint, e.started_at,
                  p.full_name_ar AS patient_name, p.mrn, d.code AS dept_code, d.name_ar AS dept_name,
                  u.full_name_ar AS doctor_name
             FROM encounters e
             JOIN patients p ON p.id = e.patient_id
             JOIN departments d ON d.id = e.department_id
             LEFT JOIN users u ON u.id = e.doctor_id
            WHERE e.facility_id = $1 AND e.status = 'open'
            ORDER BY CASE WHEN d.dept_type = 'dental' THEN 0 ELSE 1 END, e.started_at DESC
            LIMIT 100`,
          [auth.activeFacilityId],
        ),
        db.query<any>(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'planned')::int AS planned_count,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
             COUNT(*) FILTER (WHERE status = 'completed' AND performed_at::date = current_date)::int AS completed_today,
             (SELECT COUNT(DISTINCT patient_id)::int FROM dental_chart_entries WHERE facility_id = $1) AS charted_patients
           FROM dental_procedures
          WHERE facility_id = $1`,
          [auth.activeFacilityId],
        ),
      ]);

      const st = summary.rows[0] ?? {};
      return {
        totals: {
          planned: Number(st.planned_count ?? 0),
          inProgress: Number(st.in_progress_count ?? 0),
          completedToday: Number(st.completed_today ?? 0),
          chartedPatients: Number(st.charted_patients ?? 0),
        },
        procedures: procedures.rows.map((r: any) => ({
          ...r,
          category_ar: DENTAL_CATEGORY_AR[r.category] ?? r.category,
        })),
        openEncounters: openEncounters.rows,
        catalog: DENTAL_CATALOG,
      };
    });
  });

  app.get('/api/dental/patients/:patientId', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.read');
    const { patientId } = parse(z.object({ patientId: zId }), req.params);
    return withTenant(auth, async (db) => {
      const patient = await loadPatientOr404(db, patientId);
      await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'dental_chart_view' });

      const [entries, procedures, allergies, encounters] = await Promise.all([
        db.query(
          `SELECT dc.*, u.full_name_ar AS recorded_by_name
             FROM dental_chart_entries dc
             JOIN users u ON u.id = dc.recorded_by
            WHERE dc.facility_id = $1 AND dc.patient_id = $2
            ORDER BY dc.recorded_at DESC`,
          [auth.activeFacilityId, patientId],
        ),
        db.query(
          `SELECT dp.*, e.encounter_no, u.full_name_ar AS dentist_name
             FROM dental_procedures dp
             JOIN encounters e ON e.id = dp.encounter_id
             JOIN users u ON u.id = dp.dentist_id
            WHERE dp.facility_id = $1 AND dp.patient_id = $2
            ORDER BY dp.created_at DESC`,
          [auth.activeFacilityId, patientId],
        ),
        db.query(
          `SELECT allergen, severity, reaction FROM patient_allergies WHERE patient_id = $1 AND is_active = true`,
          [patientId],
        ),
        db.query(
          `SELECT e.id, e.encounter_no, e.chief_complaint, e.started_at, d.name_ar AS dept_name
             FROM encounters e JOIN departments d ON d.id = e.department_id
            WHERE e.facility_id = $1 AND e.patient_id = $2 AND e.status = 'open'
            ORDER BY e.started_at DESC`,
          [auth.activeFacilityId, patientId],
        ),
      ]);

      // Latest status per tooth (entries are ordered DESC by recorded_at)
      const latestByTooth: Record<number, any> = {};
      for (const row of entries.rows as any[]) {
        const tn = Number(row.tooth_number);
        const cond = String(row.condition);
        if (!latestByTooth[tn]) {
          latestByTooth[tn] = {
            ...row,
            condition_ar: DENTAL_CONDITION_AR[cond] ?? cond,
          };
        }
      }

      return {
        patient: {
          id: patient.id,
          mrn: patient.mrn,
          full_name_ar: patient.full_name_ar,
          date_of_birth: patient.date_of_birth,
          sex: patient.sex,
          blood_type: patient.blood_type,
        },
        allergies: allergies.rows,
        toothMap: latestByTooth,
        entries: entries.rows.map((r: any) => ({
          ...r,
          condition_ar: DENTAL_CONDITION_AR[r.condition] ?? rowConditionLabel(r.condition),
        })),
        procedures: procedures.rows.map((p: any) => ({
          ...p,
          category_ar: DENTAL_CATEGORY_AR[p.category] ?? p.category,
        })),
        openEncounters: encounters.rows,
      };
    });
  });

  app.post('/api/dental/odontogram', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.chart');
    const b = parse(
      z.object({
        patientId: zId,
        encounterId: zId.optional(),
        toothNumber: zFdiTooth,
        surface: z.enum(SURFACES).default('whole'),
        condition: z.enum(CONDITIONS),
        notes: z.string().max(400).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, b.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'dental_odontogram_write' });
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO dental_chart_entries (
             id, facility_id, patient_id, encounter_id, tooth_number, surface, condition, notes, recorded_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, auth.activeFacilityId, b.patientId, b.encounterId ?? null, b.toothNumber, b.surface, b.condition, b.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, toothNumber: b.toothNumber, condition: b.condition };
      },
      (r) => ({
        action: 'dental.odontogram.record',
        entityType: 'dental_chart_entry',
        entityId: r.id,
        patientId: b.patientId,
        detail: { toothNumber: b.toothNumber, surface: b.surface, condition: b.condition },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/dental/procedures', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.perform');
    const b = parse(
      z.object({
        encounterId: zId,
        toothNumber: zFdiTooth.optional(),
        procedureCode: z.string().trim().min(2).max(24),
        category: z.enum(CATEGORIES),
        description: z.string().trim().min(3).max(400),
        anesthesiaUsed: z.string().max(150).optional(),
        fee: z.number().min(0).max(100_000).default(250),
        clinicalNotes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await db.query<any>(`SELECT * FROM encounters WHERE id = $1 AND facility_id = $2`, [b.encounterId, auth.activeFacilityId]);
        const encounter = enc.rows[0];
        if (!encounter) throw notFound('الزيارة السريرية غير موجودة');
        if (encounter.status !== 'open') throw conflict('لا يمكن تسجيل إجراء أسنان على زيارة مغلقة');
        const patient = await loadPatientOr404(db, encounter.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'dental_procedure_plan' });

        const id = crypto.randomUUID();
        const procedureNo = await nextDocumentNo(db, auth.activeFacilityId, 'dental_proc', 'DNT');
        await db.query(
          `INSERT INTO dental_procedures (
             id, facility_id, procedure_no, patient_id, encounter_id, tooth_number,
             procedure_code, category, description, anesthesia_used, status, fee,
             dentist_id, clinical_notes, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned',$11,$12,$13,$12)`,
          [
            id,
            auth.activeFacilityId,
            procedureNo,
            encounter.patient_id,
            b.encounterId,
            b.toothNumber ?? null,
            b.procedureCode,
            b.category,
            b.description,
            b.anesthesiaUsed ?? null,
            b.fee,
            auth.user.id,
            b.clinicalNotes ?? null,
          ],
        );
        reply.code(201);
        return { id, procedureNo, patientId: encounter.patient_id, status: 'planned' };
      },
      (r) => ({
        action: 'dental.procedure.create',
        entityType: 'dental_procedure',
        entityId: r.id,
        patientId: r.patientId,
        detail: { procedureNo: r.procedureNo, procedureCode: b.procedureCode, toothNumber: b.toothNumber ?? null, fee: b.fee },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/dental/procedures/:id/complete', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        anesthesiaUsed: z.string().max(150).optional(),
        clinicalNotes: z.string().max(1000).optional(),
        toothCondition: z.enum(CONDITIONS).optional(),
      }),
      req.body ?? {},
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT * FROM dental_procedures WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const proc = res.rows[0];
        if (!proc) throw notFound('إجراء الأسنان غير موجود');
        if (proc.status === 'completed') throw conflict('تم إتمام إجراء الأسنان مسبقًا');
        if (proc.status === 'cancelled') throw conflict('إجراء الأسنان ملغى');

        const patient = await loadPatientOr404(db, proc.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'dental_procedure_complete' });

        await db.query(
          `UPDATE dental_procedures
              SET status = 'completed',
                  dentist_id = $1,
                  performed_at = now(),
                  anesthesia_used = COALESCE($2, anesthesia_used),
                  clinical_notes = COALESCE($3, clinical_notes)
            WHERE id = $4`,
          [auth.user.id, b.anesthesiaUsed ?? null, b.clinicalNotes ?? null, id],
        );

        const nextCond = b.toothCondition ?? AUTO_TOOTH_CONDITION[proc.category as (typeof CATEGORIES)[number]];
        if (proc.tooth_number && nextCond) {
          await db.query(
            `INSERT INTO dental_chart_entries (
               id, facility_id, patient_id, encounter_id, tooth_number, surface, condition, notes, recorded_by
             ) VALUES ($1,$2,$3,$4,$5,'whole',$6,$7,$8)`,
            [
              crypto.randomUUID(),
              proc.facility_id,
              proc.patient_id,
              proc.encounter_id,
              proc.tooth_number,
              nextCond,
              `تحديث تلقائي بعد إتمام ${proc.procedure_no} (${proc.description})`,
              auth.user.id,
            ],
          );
        }

        const charge = await ensureCharge(db, {
          facilityId: proc.facility_id,
          patientId: proc.patient_id,
          encounterId: proc.encounter_id,
          category: 'procedure',
          description: `إجراء أسنان${proc.tooth_number ? ` (سن ${proc.tooth_number})` : ''} — ${proc.description}`,
          referenceType: 'dental_procedure',
          referenceId: proc.id,
          quantity: 1,
          unitPrice: Number(proc.fee),
          createdBy: auth.user.id,
        });

        return { ok: true, status: 'completed', invoiceId: charge.invoiceId, fee: Number(proc.fee) };
      },
      (r) => ({
        action: 'dental.procedure.complete',
        entityType: 'dental_procedure',
        entityId: id,
        detail: { invoiceId: r.invoiceId, fee: r.fee },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/dental/procedures/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'dental.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(400) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT * FROM dental_procedures WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const proc = res.rows[0];
        if (!proc) throw notFound('إجراء الأسنان غير موجود');
        if (!['planned', 'in_progress'].includes(proc.status)) {
          throw conflict('لا يمكن إلغاء إجراء مكتمل أو ملغى مسبقًا');
        }
        await db.query(
          `UPDATE dental_procedures SET status = 'cancelled', cancel_reason = $1 WHERE id = $2`,
          [b.reason, id],
        );
        return { ok: true, status: 'cancelled' };
      },
      () => ({
        action: 'dental.procedure.cancel',
        entityType: 'dental_procedure',
        entityId: id,
        reason: b.reason,
        ip: req.ip,
      }),
    );
  });
}

function rowConditionLabel(c: string): string {
  return DENTAL_CONDITION_AR[c] ?? c;
}
