import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, PageQuery, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, idempotent, nextDocumentNo } from '../../lib/tenant';
import { applyPayment, recalculateInvoice } from './service';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

export async function billingRoutes(app: FastifyInstance) {
  app.get('/api/billing/invoices', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.invoice.read');
    const q = parse(
      PageQuery.extend({ status: z.string().optional(), patientId: zId.optional(), search: z.string().max(80).optional() }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const where = ['i.facility_id = $1'];
      const params: unknown[] = [auth.activeFacilityId];
      if (q.status) { params.push(q.status); where.push(`i.status = $${params.length}`); }
      if (q.patientId) { params.push(q.patientId); where.push(`i.patient_id = $${params.length}`); }
      if (q.search) { params.push(`%${q.search}%`); where.push(`(i.invoice_no ILIKE $${params.length} OR p.mrn ILIKE $${params.length} OR p.full_name_ar ILIKE $${params.length})`); }
      const rows = await db.query(
        `SELECT i.id, i.invoice_no, i.status, i.total, i.paid_amount, i.currency, i.created_at,
                p.mrn, p.full_name_ar AS patient_name,
                (SELECT count(*) FROM payments pay WHERE pay.invoice_id = i.id) AS payment_count
           FROM invoices i JOIN patients p ON p.id = i.patient_id
          WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit ?? 25, ((q.page ?? 1) - 1) * (q.limit ?? 25)],
      );
      const total = await db.query<{ count: string }>(
        `SELECT count(*) FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${where.join(' AND ')}`, params);
      return { items: rows.rows, total: Number(total.rows[0]?.count ?? 0), page: (q.page ?? 1), limit: q.limit ?? 25 };
    });
  });

  app.get('/api/billing/invoices/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.invoice.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const inv = await db.query<any>(
        `SELECT i.*, p.full_name_ar AS patient_name, p.mrn FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE i.id = $1`,
        [id],
      );
      const invoice = inv.rows[0];
      if (!invoice) throw notFound('الفاتورة غير موجودة');
      const [items, payments, claims] = await Promise.all([
        db.query(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at`, [id]),
        db.query(`SELECT id, amount, method, reference, received_at, status FROM payments WHERE invoice_id = $1 ORDER BY received_at DESC`, [id]),
        db.query(`SELECT id, claim_no, status, claimed_amount, approved_amount, submitted_at, decided_at, rejection_reason FROM insurance_claims WHERE invoice_id = $1`, [id]),
      ]);
      return { invoice, items: items.rows, payments: payments.rows, claims: claims.rows };
    });
  });

  app.post('/api/billing/invoices/:id/payments', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.payment.record');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        amount: z.number().positive().max(1_000_000),
        method: z.enum(['cash', 'card', 'transfer', 'insurance', 'online']),
        reference: z.string().max(120).optional(),
      }),
      req.body,
    );
    const key = req.headers['idempotency-key'] as string | undefined;
    return withTenant(auth, async (db) => {
      const result = await idempotent(db, { key, userId: auth.user.id, endpoint: 'billing.payment', body: { id, ...b } }, async () => {
        try {
          return await applyPayment(db, id, b.amount, b.method, b.reference ?? null, auth.user.id);
        } catch (err) {
          const message = (err as Error).message;
          if (message === 'INVOICE_NOT_FOUND') throw notFound('الفاتورة غير موجودة');
          if (message === 'INVOICE_VOID') throw conflict('لا يمكن تحصيل فاتورة ملغاة');
          if (message === 'OVERPAYMENT') throw conflict('المبلغ يتجاوز رصيد الفاتورة');
          throw err;
        }
      });
      if (!(result as any).replayed) {
        const { writeAudit } = await import('../../lib/audit');
        const invoice = await db.query<{ patient_id: string }>('SELECT patient_id FROM invoices WHERE id = $1', [id]);
        await writeAudit(db, {
          facilityId: auth.activeFacilityId,
          actorUserId: auth.user.id,
          actorRole: auth.roles[0]?.role_id ?? null,
          action: 'billing.payment.record',
          entityType: 'invoice',
          entityId: id,
          patientId: invoice.rows[0]?.patient_id ?? null,
          detail: { amount: b.amount, method: b.method, idempotencyKey: key ?? null },
          ip: req.ip,
        });
      }
      reply.code(201);
      return result;
    });
  });

  app.post('/api/billing/invoices/:id/void', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.invoice.void');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ reason: z.string().min(10).max(500) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const inv = await db.query<any>('SELECT status, paid_amount FROM invoices WHERE id = $1', [id]);
        const invoice = inv.rows[0];
        if (!invoice) throw notFound('الفاتورة غير موجودة');
        if (invoice.status === 'void') throw conflict('الفاتورة ملغاة مسبقًا');
        if (Number(invoice.paid_amount) > 0) throw conflict('لا يمكن إلغاء فاتورة مدفوعة — استخدم استردادًا موثقًا');
        await db.query(`UPDATE invoices SET status = 'void', void_reason = $1 WHERE id = $2`, [b.reason, id]);
        return { ok: true };
      },
      () => ({ action: 'billing.invoice.void', entityType: 'invoice', entityId: id, reason: b.reason, ip: req.ip }),
    );
  });

  app.post('/api/billing/invoices/:id/claims', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'insurance.claim.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ policyId: zId, claimedAmount: z.number().positive() }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const inv = await db.query<any>('SELECT * FROM invoices WHERE id = $1', [id]);
        if (!inv.rows[0]) throw notFound('الفاتورة غير موجودة');
        const policy = await db.query<any>('SELECT * FROM insurance_policies WHERE id = $1 AND patient_id = $2', [b.policyId, inv.rows[0].patient_id]);
        if (!policy.rows[0]) throw notFound('بوليصة التأمين غير مرتبطة بهذا المريض');
        const claimId = crypto.randomUUID();
        const claimNo = await nextDocumentNo(db, auth.activeFacilityId, 'claim', 'CLM');
        await db.query(
          `INSERT INTO insurance_claims (id, facility_id, claim_no, invoice_id, policy_id, claimed_amount, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [claimId, auth.activeFacilityId, claimNo, id, b.policyId, b.claimedAmount, auth.user.id],
        );
        reply.code(201);
        return { id: claimId, claimNo, status: 'draft', note: 'لم تُرسل المطالبة لأي جهة خارجية — تكامل الدفع/التأمين غير مهيأ في هذه البيئة.' };
      },
      (r) => ({ action: 'insurance.claim.create', entityType: 'insurance_claim', entityId: r.id, detail: { claimNo: r.claimNo }, ip: req.ip }),
    );
  });

  app.get('/api/billing/summary', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'billing.invoice.read');
    return withTenant(auth, async (db) => {
      const res = await db.query(
        `SELECT
           COALESCE(sum(total) FILTER (WHERE created_at::date = current_date AND status <> 'void'), 0) AS today_billed,
           COALESCE(sum(paid_amount) FILTER (WHERE created_at::date = current_date), 0) AS today_collected,
           COALESCE(sum(total - paid_amount) FILTER (WHERE status IN ('open','partially_paid')), 0) AS outstanding,
           count(*) FILTER (WHERE status IN ('open','partially_paid')) AS open_invoices
         FROM invoices WHERE facility_id = $1`,
        [auth.activeFacilityId],
      );
      return res.rows[0];
    });
  });
}
