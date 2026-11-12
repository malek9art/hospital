import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';

const MODALITIES = ['xray', 'ct', 'mri', 'us', 'mammography', 'fluoroscopy'] as const;
const MODALITY_AR: Record<string, string> = {
  xray: 'أشعة سينية',
  ct: 'أشعة مقطعية',
  mri: 'رنين مغناطيسي',
  us: 'سونار',
  mammography: 'ماموغرام',
  fluoroscopy: 'أشعة fluoroscopy',
};

// Fallback list prices; per-facility app_settings (pricing.imaging_<modality>) win.
const DEFAULT_PRICES: Record<string, number> = {
  xray: 150,
  ct: 650,
  mri: 1100,
  us: 300,
  mammography: 400,
  fluoroscopy: 500,
};

async function loadOrder(db: any, id: string) {
  const res = await db.query(
    `SELECT o.*, p.full_name_ar AS patient_name, p.mrn, e.encounter_no,
            u.full_name_ar AS ordered_by_name
       FROM imaging_orders o
       JOIN patients p ON p.id = o.patient_id
       JOIN encounters e ON e.id = o.encounter_id
       JOIN users u ON u.id = o.ordered_by
      WHERE o.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('طلب الأشعة غير موجود');
  return row;
}

async function imagingPrice(db: any, facilityId: string, modality: string) {
  const row = await db.query(
    `SELECT value FROM app_settings WHERE facility_id = $1 AND key = $2`,
    [facilityId, `pricing.imaging_${modality}`],
  );
  return Number(row.rows[0]?.value?.amount ?? DEFAULT_PRICES[modality] ?? 200);
}

export async function radiologyRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------- Ordering ----
  app.post('/api/encounters/:id/imaging-orders', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.order');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        modality: z.enum(MODALITIES),
        bodyPart: z.string().min(2).max(120),
        indication: z.string().min(5).max(1000),
        priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const enc = await db.query<any>(`SELECT * FROM encounters WHERE id = $1`, [id]);
        const encounter = enc.rows[0];
        if (!encounter) throw notFound('الزيارة غير موجودة');
        if (encounter.status !== 'open') throw conflict('لا يمكن طلب أشعة على زيارة مغلقة');
        await authorizeChartAccess(db, auth, await loadPatientOr404(db, encounter.patient_id), 'clinical', {
          ip: req.ip,
          accessType: 'imaging_order',
        });
        const orderNo = await nextDocumentNo(db, auth.activeFacilityId, 'imaging', 'IMG');
        const orderId = crypto.randomUUID();
        await db.query(
          `INSERT INTO imaging_orders (id, facility_id, order_no, encounter_id, patient_id, modality, body_part,
             clinical_indication, priority, ordered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [orderId, encounter.facility_id, orderNo, id, encounter.patient_id, b.modality, b.bodyPart, b.indication, b.priority, auth.user.id],
        );
        if (b.priority === 'stat') {
          // Surface immediately on the worklist; the alert is derived, not a separate row.
          req.log.info({ orderId, priority: b.priority }, 'stat imaging order created');
        }
        reply.code(201);
        return { id: orderId, orderNo, modality: b.modality, priority: b.priority };
      },
      (r) => ({
        action: 'imaging.order',
        entityType: 'imaging_order',
        entityId: r.id,
        patientId: null,
        detail: { orderNo: r.orderNo, modality: r.modality, priority: r.priority, encounterId: id },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------- Worklist ----
  app.get('/api/radiology/worklist', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.read');
    const q = parse(
      z.object({
        status: z
          .enum(['active', 'all', 'ordered', 'in_progress', 'performed', 'reported', 'verified', 'cancelled'])
          .default('active'),
      }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const params: any[] = [auth.activeFacilityId];
      let filter = '';
      if (q.status === 'active') {
        filter = `AND o.status IN ('ordered','in_progress','performed','reported')`;
      } else if (q.status !== 'all') {
        params.push(q.status);
        filter = `AND o.status = $${params.length}`;
      }
      const rows = await db.query<any>(
        `SELECT o.id, o.order_no, o.modality, o.body_part, o.priority, o.status, o.ordered_at,
                o.performed_at, p.full_name_ar AS patient_name, p.mrn, u.full_name_ar AS ordered_by_name,
                e.encounter_no,
                (SELECT r.id FROM imaging_reports r WHERE r.order_id = o.id ORDER BY r.version DESC LIMIT 1) AS latest_report_id,
                (SELECT r.is_critical FROM imaging_reports r WHERE r.order_id = o.id ORDER BY r.version DESC LIMIT 1) AS critical,
                (SELECT count(*)::int FROM imaging_reports r WHERE r.order_id = o.id AND r.status = 'draft') AS draft_reports
           FROM imaging_orders o
           JOIN patients p ON p.id = o.patient_id
           JOIN encounters e ON e.id = o.encounter_id
           JOIN users u ON u.id = o.ordered_by
          WHERE o.facility_id = $1 ${filter}
          ORDER BY CASE o.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, o.ordered_at ASC
          LIMIT 200`,
        params,
      );
      return {
        items: rows.rows.map((r) => ({ ...r, modality_ar: MODALITY_AR[r.modality] ?? r.modality })),
        counts: rows.rows.reduce((acc: Record<string, number>, r: any) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });
  });

  app.get('/api/radiology/orders/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const order = await loadOrder(db, id);
      await authorizeChartAccess(db, auth, await loadPatientOr404(db, order.patient_id), 'clinical', {
        ip: req.ip,
        accessType: 'imaging_view',
      });
      const reports = await db.query<any>(
        `SELECT r.*, u.full_name_ar AS reported_by_name, f.full_name_ar AS finalized_by_name,
                a.full_name_ar AS acknowledged_by_name
           FROM imaging_reports r
           JOIN users u ON u.id = r.reported_by
           LEFT JOIN users f ON f.id = r.finalized_by
           LEFT JOIN users a ON a.id = r.acknowledged_by
          WHERE r.order_id = $1 ORDER BY r.version DESC`,
        [id],
      );
      return { order: { ...order, modality_ar: MODALITY_AR[order.modality] ?? order.modality }, reports: reports.rows };
    });
  });

  // ------------------------------------------------------------ Performing ---
  app.post('/api/radiology/orders/:id/start', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await loadOrder(db, id);
        if (order.status !== 'ordered') throw conflict('لا يمكن بدء الطلب في حالته الحالية');
        await db.query(`UPDATE imaging_orders SET status = 'in_progress' WHERE id = $1`, [id]);
        return { ok: true, status: 'in_progress' };
      },
      () => ({ action: 'imaging.start', entityType: 'imaging_order', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  app.post('/api/radiology/orders/:id/perform', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.perform');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await loadOrder(db, id);
        if (!['ordered', 'in_progress'].includes(order.status)) throw conflict('لا يمكن إتمام التصوير في حالته الحالية');
        await db.query(
          `UPDATE imaging_orders SET status = 'performed', performed_by = $1, performed_at = now() WHERE id = $2`,
          [auth.user.id, id],
        );
        return { ok: true, status: 'performed', performedAt: new Date().toISOString() };
      },
      () => ({ action: 'imaging.perform', entityType: 'imaging_order', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  // ------------------------------------------------------------- Reporting ---
  app.post('/api/radiology/orders/:id/reports', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.report');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        findings: z.string().min(5).max(5000),
        impression: z.string().min(5).max(2000),
        recommendation: z.string().max(2000).optional(),
        critical: z.boolean().default(false),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await loadOrder(db, id);
        if (order.status === 'cancelled') throw conflict('الطلب ملغى');
        if (!['performed', 'reported'].includes(order.status)) throw conflict('يجب إتمام التصوير قبل كتابة التقرير');
        const last = await db.query<{ version: number }>(
          `SELECT coalesce(max(version), 0) AS version FROM imaging_reports WHERE order_id = $1`,
          [id],
        );
        const version = Number(last.rows[0]?.version ?? 0) + 1;
        const previous = await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM imaging_reports WHERE order_id = $1 ORDER BY version DESC LIMIT 1`,
          [id],
        );
        if (previous.rows[0]?.status === 'draft') {
          throw conflict('يوجد تقرير مسودة غير معتمد لنفس الطلب — اعتمده أو أكمله أولًا');
        }
        const reportId = crypto.randomUUID();
        await db.query(
          `INSERT INTO imaging_reports (id, facility_id, order_id, version, findings, impression, recommendation,
             is_critical, status, reported_by, amended_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10)`,
          [reportId, order.facility_id, id, version, b.findings, b.impression, b.recommendation ?? null, b.critical,
            auth.user.id, previous.rows[0]?.id ?? null],
        );
        reply.code(201);
        return { id: reportId, version, status: 'draft' };
      },
      (r) => ({
        action: 'imaging.report.draft', entityType: 'imaging_order', entityId: id, patientId: null,
        detail: { reportId: r.id, version: r.version, critical: b.critical }, ip: req.ip,
      }),
    );
  });

  app.post('/api/radiology/reports/:id/finalize', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.verify');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const rep = await db.query<any>(`SELECT * FROM imaging_reports WHERE id = $1`, [id]);
        const report = rep.rows[0];
        if (!report) throw notFound('التقرير غير موجود');
        if (report.status !== 'draft') throw conflict('التقرير معتمد مسبقًا');
        const order = await loadOrder(db, report.order_id);
        await db.query(
          `UPDATE imaging_reports SET status = 'final', finalized_by = $1, finalized_at = now(),
             amendments = CASE WHEN amended_from IS NULL THEN amendments ELSE amendments + 1 END
           WHERE id = $2`,
          [auth.user.id, id],
        );
        await db.query(`UPDATE imaging_orders SET status = 'verified' WHERE id = $1`, [report.order_id]);
        const price = await imagingPrice(db, order.facility_id, order.modality);
        const charge = await ensureCharge(db, {
          facilityId: order.facility_id,
          patientId: order.patient_id,
          encounterId: order.encounter_id,
          category: 'radiology',
          description: `${MODALITY_AR[order.modality] ?? order.modality} — ${order.body_part}`,
          referenceType: 'imaging_order',
          referenceId: order.id,
          quantity: 1,
          unitPrice: price,
          createdBy: auth.user.id,
        });
        return {
          ok: true,
          status: 'verified',
          invoiceId: charge.invoiceId,
          fee: price,
          critical: report.is_critical,
          requiresAcknowledgement: report.is_critical,
        };
      },
      (r) => ({
        action: 'imaging.report.finalize', entityType: 'imaging_report', entityId: id, patientId: null,
        detail: { fee: r.fee, critical: r.critical, invoiceId: r.invoiceId }, ip: req.ip,
      }),
    );
  });

  app.post('/api/radiology/reports/:id/acknowledge', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.critical.ack');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ note: z.string().min(5).max(1000) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const rep = await db.query<any>(`SELECT * FROM imaging_reports WHERE id = $1`, [id]);
        const report = rep.rows[0];
        if (!report) throw notFound('التقرير غير موجود');
        if (report.status !== 'final') throw conflict('لا يمكن استلام نتيجة غير معتمدة');
        if (!report.is_critical) throw conflict('هذا التقرير ليس نتيجة حرجة');
        if (report.acknowledged_at) throw conflict('النتيجة الحرجة مُستلمة مسبقًا');
        await db.query(
          `UPDATE imaging_reports SET acknowledged_by = $1, acknowledged_at = now() WHERE id = $2`,
          [auth.user.id, id],
        );
        return { ok: true, acknowledgedAt: new Date().toISOString() };
      },
      (r) => ({
        action: 'imaging.critical.ack', entityType: 'imaging_report', entityId: id, patientId: null,
        detail: { note: b.note }, ip: req.ip,
      }),
    );
  });

  // -------------------------------------------------------------- Cancelling --
  app.post('/api/radiology/orders/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'radiology.order');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const order = await loadOrder(db, id);
        if (!['ordered', 'in_progress'].includes(order.status)) {
          throw conflict('لا يمكن إلغاء طلب بعد إتمام التصوير — صحّح التقرير بدلًا من ذلك');
        }
        await db.query(
          `UPDATE imaging_orders SET status = 'cancelled', cancel_reason = $1, cancelled_by = $2, cancelled_at = now()
            WHERE id = $3`,
          [b.reason, auth.user.id, id],
        );
        return { ok: true, status: 'cancelled' };
      },
      () => ({
        action: 'imaging.cancel', entityType: 'imaging_order', entityId: id, patientId: null,
        detail: { reason: b.reason }, ip: req.ip,
      }),
    );
  });
}
