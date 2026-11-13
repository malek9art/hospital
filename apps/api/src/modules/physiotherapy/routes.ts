import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission, requireAnyPermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';
import { conflict, notFound } from '../../lib/errors';

const MODALITIES = [
  'therapeutic_exercise',
  'manual_therapy',
  'electrotherapy',
  'ultrasound_therapy',
  'hydrotherapy',
  'gait_training',
  'neuro_rehab',
  'post_op_rehab',
  'chest_physio',
] as const;

export const PHYSIO_MODALITY_AR: Record<string, string> = {
  therapeutic_exercise: 'تمارين علاجية وتقوية عضلية',
  manual_therapy: 'علاج يدوي وتحريك مفاصل',
  electrotherapy: 'علاج كهربائي (TENS / EMS)',
  ultrasound_therapy: 'موجات فوق صوتية علاجية',
  hydrotherapy: 'علاج مائي تأهيلي',
  gait_training: 'تدريب المشي والتوازن الوظيفي',
  neuro_rehab: 'تأهيل عصبي وحركي',
  post_op_rehab: 'تأهيل ما بعد العمليات الجراحية',
  chest_physio: 'علاج طبيعي صدري وتنفسي',
};

export const TOLERANCE_AR: Record<string, string> = {
  excellent: 'ممتاز',
  good: 'جيد',
  fair: 'متوسط',
  poor: 'ضعيف / إجهاد سريع',
};

export async function physiotherapyRoutes(app: FastifyInstance) {
  app.get('/api/physio/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.read');
    return withTenant(auth, async (db) => {
      const [referrals, sessions, openEncounters, therapists, stats] = await Promise.all([
        db.query(
          `SELECT r.*, p.full_name_ar AS patient_name, p.mrn, e.encounter_no,
                  u1.full_name_ar AS referred_by_name,
                  u2.full_name_ar AS therapist_name
             FROM physio_referrals r
             JOIN patients p ON p.id = r.patient_id
             JOIN encounters e ON e.id = r.encounter_id
             JOIN users u1 ON u1.id = r.referred_by
             LEFT JOIN users u2 ON u2.id = r.assigned_therapist_id
            WHERE r.facility_id = $1
            ORDER BY CASE r.status WHEN 'referred' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                     CASE r.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
                     r.created_at DESC
            LIMIT 150`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT s.*, p.full_name_ar AS patient_name, p.mrn,
                  r.referral_no, r.body_region, r.modality_plan,
                  u.full_name_ar AS therapist_name
             FROM physio_sessions s
             JOIN physio_referrals r ON r.id = s.referral_id
             JOIN patients p ON p.id = s.patient_id
             JOIN users u ON u.id = s.therapist_id
            WHERE s.facility_id = $1
            ORDER BY CASE s.status WHEN 'scheduled' THEN 0 ELSE 1 END,
                     s.scheduled_at DESC
            LIMIT 150`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT e.id, e.encounter_no, e.patient_id, e.chief_complaint, e.started_at,
                  p.full_name_ar AS patient_name, p.mrn, d.name_ar AS dept_name
             FROM encounters e
             JOIN patients p ON p.id = e.patient_id
             JOIN departments d ON d.id = e.department_id
            WHERE e.facility_id = $1 AND e.status = 'open'
            ORDER BY e.started_at DESC
            LIMIT 100`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT DISTINCT u.id, u.full_name_ar, u.job_title_ar
             FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $1
            WHERE u.is_active = true AND ur.role_id = 'physiotherapist'
            ORDER BY u.full_name_ar`,
          [auth.activeFacilityId],
        ),
        db.query<any>(
          `SELECT
             (SELECT COUNT(*)::int FROM physio_referrals WHERE facility_id = $1 AND status = 'referred') AS pending_referrals,
             (SELECT COUNT(*)::int FROM physio_referrals WHERE facility_id = $1 AND status = 'active') AS active_plans,
             (SELECT COUNT(*)::int FROM physio_sessions WHERE facility_id = $1 AND status = 'scheduled') AS scheduled_sessions,
             (SELECT COUNT(*)::int FROM physio_sessions WHERE facility_id = $1 AND status = 'completed') AS completed_sessions,
             (SELECT ROUND(AVG(pain_before - pain_after)::numeric, 1)::float8
                FROM physio_sessions
               WHERE facility_id = $1 AND status = 'completed' AND pain_before IS NOT NULL AND pain_after IS NOT NULL) AS avg_pain_drop`,
          [auth.activeFacilityId],
        ),
      ]);

      const st = stats.rows[0] ?? {};
      return {
        totals: {
          pendingReferrals: Number(st.pending_referrals ?? 0),
          activePlans: Number(st.active_plans ?? 0),
          scheduledSessions: Number(st.scheduled_sessions ?? 0),
          completedSessions: Number(st.completed_sessions ?? 0),
          avgPainDrop: Number(st.avg_pain_drop ?? 0),
        },
        referrals: referrals.rows.map((r: any) => ({
          ...r,
          modality_plan_ar: PHYSIO_MODALITY_AR[r.modality_plan] ?? r.modality_plan,
        })),
        sessions: sessions.rows.map((s: any) => ({
          ...s,
          modality_plan_ar: PHYSIO_MODALITY_AR[s.modality_plan] ?? s.modality_plan,
          tolerance_ar: s.patient_tolerance ? (TOLERANCE_AR[s.patient_tolerance] ?? s.patient_tolerance) : null,
        })),
        openEncounters: openEncounters.rows,
        therapists: therapists.rows,
      };
    });
  });

  app.get('/api/physio/referrals/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const refRes = await db.query<any>(
        `SELECT r.*, p.full_name_ar AS patient_name, p.mrn, p.date_of_birth, p.sex,
                e.encounter_no, u1.full_name_ar AS referred_by_name, u2.full_name_ar AS therapist_name
           FROM physio_referrals r
           JOIN patients p ON p.id = r.patient_id
           JOIN encounters e ON e.id = r.encounter_id
           JOIN users u1 ON u1.id = r.referred_by
           LEFT JOIN users u2 ON u2.id = r.assigned_therapist_id
          WHERE r.id = $1 AND r.facility_id = $2`,
        [id, auth.activeFacilityId],
      );
      const referral = refRes.rows[0];
      if (!referral) throw notFound('تحويل العلاج الطبيعي غير موجود');

      const sessions = await db.query(
        `SELECT s.*, u.full_name_ar AS therapist_name
           FROM physio_sessions s
           JOIN users u ON u.id = s.therapist_id
          WHERE s.referral_id = $1
          ORDER BY s.session_number ASC`,
        [id],
      );

      return {
        referral: {
          ...referral,
          modality_plan_ar: PHYSIO_MODALITY_AR[referral.modality_plan] ?? referral.modality_plan,
        },
        sessions: sessions.rows.map((s: any) => ({
          ...s,
          tolerance_ar: s.patient_tolerance ? (TOLERANCE_AR[s.patient_tolerance] ?? s.patient_tolerance) : null,
        })),
      };
    });
  });

  app.post('/api/physio/referrals', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.refer');
    const b = parse(
      z.object({
        encounterId: zId,
        diagnosisSummary: z.string().trim().min(5).max(1000),
        bodyRegion: z.string().trim().min(2).max(120),
        modalityPlan: z.enum(MODALITIES),
        precautions: z.string().max(500).optional(),
        totalSessions: z.number().int().min(1).max(60).default(6),
        priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
        assignedTherapistId: zId.optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await db.query<any>(`SELECT * FROM encounters WHERE id = $1 AND facility_id = $2`, [b.encounterId, auth.activeFacilityId]);
        const encounter = enc.rows[0];
        if (!encounter) throw notFound('الزيارة السريرية غير موجودة');
        if (encounter.status !== 'open') throw conflict('لا يمكن إنشاء تحويل علاج طبيعي على زيارة مغلقة');
        const patient = await loadPatientOr404(db, encounter.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'physio_refer' });

        const adm = await db.query<{ id: string }>(
          `SELECT id FROM admissions WHERE encounter_id = $1 AND status = 'active' LIMIT 1`,
          [b.encounterId],
        );

        const id = crypto.randomUUID();
        const referralNo = await nextDocumentNo(db, auth.activeFacilityId, 'physio_ref', 'PTR');
        await db.query(
          `INSERT INTO physio_referrals (
             id, facility_id, referral_no, patient_id, encounter_id, admission_id,
             diagnosis_summary, body_region, modality_plan, precautions,
             total_sessions, priority, referred_by, assigned_therapist_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            id,
            auth.activeFacilityId,
            referralNo,
            encounter.patient_id,
            b.encounterId,
            adm.rows[0]?.id ?? null,
            b.diagnosisSummary,
            b.bodyRegion,
            b.modalityPlan,
            b.precautions ?? null,
            b.totalSessions,
            b.priority,
            auth.user.id,
            b.assignedTherapistId ?? null,
          ],
        );
        reply.code(201);
        return { id, referralNo, patientId: encounter.patient_id, status: 'referred' };
      },
      (r) => ({
        action: 'physio.referral.create',
        entityType: 'physio_referral',
        entityId: r.id,
        patientId: r.patientId,
        detail: { referralNo: r.referralNo, bodyRegion: b.bodyRegion, modalityPlan: b.modalityPlan, totalSessions: b.totalSessions },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/physio/referrals/:id/assess', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        initialAssessment: z.string().trim().min(5).max(2000),
        rehabGoals: z.string().trim().min(5).max(1500),
        baselinePainScore: z.number().int().min(0).max(10),
        baselineMobilityScore: z.number().int().min(1).max(10),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT * FROM physio_referrals WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const refRow = res.rows[0];
        if (!refRow) throw notFound('تحويل العلاج الطبيعي غير موجود');
        if (['completed', 'cancelled'].includes(refRow.status)) {
          throw conflict('لا يمكن تعديل خطة علاج طبيعي مغلقة');
        }
        await db.query(
          `UPDATE physio_referrals
              SET status = 'active',
                  assigned_therapist_id = COALESCE(assigned_therapist_id, $1),
                  initial_assessment = $2,
                  rehab_goals = $3,
                  baseline_pain_score = $4,
                  baseline_mobility_score = $5,
                  assessed_at = COALESCE(assessed_at, now())
            WHERE id = $6`,
          [auth.user.id, b.initialAssessment, b.rehabGoals, b.baselinePainScore, b.baselineMobilityScore, id],
        );
        return { ok: true, status: 'active' };
      },
      () => ({
        action: 'physio.referral.assess',
        entityType: 'physio_referral',
        entityId: id,
        detail: { baselinePainScore: b.baselinePainScore, baselineMobilityScore: b.baselineMobilityScore },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/physio/referrals/:id/sessions', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        scheduledAt: z.string().optional(),
        durationMinutes: z.number().int().min(15).max(180).default(45),
        fee: z.number().min(0).max(10_000).default(180),
      }),
      req.body ?? {},
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const refRes = await db.query<any>(
          `SELECT * FROM physio_referrals WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const refRow = refRes.rows[0];
        if (!refRow) throw notFound('تحويل العلاج الطبيعي غير موجود');
        if (['completed', 'cancelled'].includes(refRow.status)) {
          throw conflict('لا يمكن جدولة جلسة على تحويل مغلق');
        }
        const seqRes = await db.query<{ next_num: number }>(
          `SELECT COALESCE(MAX(session_number), 0)::int + 1 AS next_num
             FROM physio_sessions WHERE referral_id = $1 AND status <> 'cancelled'`,
          [id],
        );
        const sessionNumber = Number(seqRes.rows[0]?.next_num ?? 1);
        if (sessionNumber > Number(refRow.total_sessions)) {
          throw conflict(`تم الوصول إلى الحد الأقصى للجلسات المقررة (${refRow.total_sessions})`);
        }

        const sessionId = crypto.randomUUID();
        const sessionNo = await nextDocumentNo(db, auth.activeFacilityId, 'physio_sess', 'PTS');
        await db.query(
          `INSERT INTO physio_sessions (
             id, facility_id, session_no, referral_id, patient_id, session_number,
             scheduled_at, duration_minutes, fee, therapist_id
           ) VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8, $9, $10)`,
          [
            sessionId,
            auth.activeFacilityId,
            sessionNo,
            id,
            refRow.patient_id,
            sessionNumber,
            b.scheduledAt ?? null,
            b.durationMinutes,
            b.fee,
            auth.user.id,
          ],
        );
        if (refRow.status === 'referred') {
          await db.query(`UPDATE physio_referrals SET status = 'active', assigned_therapist_id = COALESCE(assigned_therapist_id, $1) WHERE id = $2`, [auth.user.id, id]);
        }
        reply.code(201);
        return { id: sessionId, sessionNo, sessionNumber, status: 'scheduled' };
      },
      (r) => ({
        action: 'physio.session.schedule',
        entityType: 'physio_session',
        entityId: r.id,
        detail: { referralId: id, sessionNo: r.sessionNo, sessionNumber: r.sessionNumber },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/physio/sessions/:id/complete', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'physio.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        modalitiesPerformed: z.array(z.enum(MODALITIES)).min(1),
        painBefore: z.number().int().min(0).max(10),
        painAfter: z.number().int().min(0).max(10),
        romNotes: z.string().trim().min(3).max(1000),
        patientTolerance: z.enum(['excellent', 'good', 'fair', 'poor']).default('good'),
        progressNotes: z.string().trim().min(5).max(1500),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const sRes = await db.query<any>(
          `SELECT s.*, r.encounter_id, r.total_sessions, r.completed_sessions, r.body_region, r.referral_no
             FROM physio_sessions s
             JOIN physio_referrals r ON r.id = s.referral_id
            WHERE s.id = $1 AND s.facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const sess = sRes.rows[0];
        if (!sess) throw notFound('جلسة العلاج الطبيعي غير موجودة');
        if (sess.status !== 'scheduled') throw conflict('تم إتمام أو إلغاء هذه الجلسة مسبقًا');

        await db.query(
          `UPDATE physio_sessions
              SET status = 'completed',
                  modalities_performed = $1,
                  pain_before = $2,
                  pain_after = $3,
                  rom_notes = $4,
                  patient_tolerance = $5,
                  progress_notes = $6,
                  therapist_id = $7,
                  performed_at = now()
            WHERE id = $8`,
          [b.modalitiesPerformed, b.painBefore, b.painAfter, b.romNotes, b.patientTolerance, b.progressNotes, auth.user.id, id],
        );

        const nextDone = Number(sess.completed_sessions) + 1;
        const planFinished = nextDone >= Number(sess.total_sessions);
        await db.query(
          `UPDATE physio_referrals
              SET completed_sessions = $1,
                  status = CASE WHEN $2 THEN 'completed' ELSE 'active' END,
                  closed_at = CASE WHEN $2 THEN now() ELSE closed_at END
            WHERE id = $3`,
          [nextDone, planFinished, sess.referral_id],
        );

        const charge = await ensureCharge(db, {
          facilityId: sess.facility_id,
          patientId: sess.patient_id,
          encounterId: sess.encounter_id,
          category: 'procedure',
          description: `جلسة علاج طبيعي #${sess.session_number} (${sess.body_region}) — ${sess.session_no}`,
          referenceType: 'physio_session',
          referenceId: sess.id,
          quantity: 1,
          unitPrice: Number(sess.fee),
          createdBy: auth.user.id,
        });

        return {
          ok: true,
          status: 'completed',
          completedSessions: nextDone,
          planFinished,
          invoiceId: charge.invoiceId,
          fee: Number(sess.fee),
        };
      },
      (r) => ({
        action: 'physio.session.complete',
        entityType: 'physio_session',
        entityId: id,
        detail: {
          painBefore: b.painBefore,
          painAfter: b.painAfter,
          completedSessions: r.completedSessions,
          planFinished: r.planFinished,
          invoiceId: r.invoiceId,
        },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/physio/referrals/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['physio.refer', 'physio.perform']);
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(400) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT * FROM physio_referrals WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const refRow = res.rows[0];
        if (!refRow) throw notFound('تحويل العلاج الطبيعي غير موجود');
        if (['completed', 'cancelled'].includes(refRow.status)) {
          throw conflict('الخطة التأهيلية مكتملة أو ملغاة مسبقًا');
        }
        await db.query(
          `UPDATE physio_sessions SET status = 'cancelled', cancel_reason = $1 WHERE referral_id = $2 AND status = 'scheduled'`,
          [b.reason, id],
        );
        await db.query(
          `UPDATE physio_referrals SET status = 'cancelled', cancel_reason = $1, closed_at = now() WHERE id = $2`,
          [b.reason, id],
        );
        return { ok: true, status: 'cancelled' };
      },
      () => ({
        action: 'physio.referral.cancel',
        entityType: 'physio_referral',
        entityId: id,
        reason: b.reason,
        ip: req.ip,
      }),
    );
  });
}
