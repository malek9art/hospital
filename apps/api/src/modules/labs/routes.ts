import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited } from '../../lib/tenant';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { conflict, notFound } from '../../lib/errors';

function computeFlag(value: number, t: any): string {
  if (t.critical_low !== null && value <= Number(t.critical_low)) return 'critical_low';
  if (t.critical_high !== null && value >= Number(t.critical_high)) return 'critical_high';
  if (t.ref_low !== null && value < Number(t.ref_low)) return 'low';
  if (t.ref_high !== null && value > Number(t.ref_high)) return 'high';
  return 'normal';
}

async function labItemContext(db: any, itemId: string) {
  const res = await db.query(
    `SELECT li.*, lo.patient_id, lo.facility_id AS order_facility, lo.priority, lo.encounter_id, lo.order_no,
            p.full_name_ar AS patient_name, p.mrn, t.name_ar AS test_name, t.unit, t.ref_low, t.ref_high,
            t.critical_low, t.critical_high
       FROM lab_order_items li
       JOIN lab_orders lo ON lo.id = li.order_id
       JOIN patients p ON p.id = lo.patient_id
       JOIN lab_tests t ON t.code = li.test_code
      WHERE li.id = $1`,
    [itemId],
  );
  const item = res.rows[0];
  if (!item) throw notFound('بند التحليل غير موجود');
  return item;
}

export async function labRoutes(app: FastifyInstance) {
  app.get('/api/lab/worklist', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.sample.collect');
    const { status } = parse(z.object({ status: z.enum(['ordered', 'collected', 'resulted', 'verified', 'all']).default('all') }), req.query);
    return withTenant(auth, async (db) => {
      const params: unknown[] = [auth.activeFacilityId];
      let filter = '';
      if (status !== 'all') {
        params.push(status);
        filter = `AND li.status = $${params.length}`;
      }
      const rows = await db.query(
        `SELECT li.id, li.status, li.test_code, li.specimen_barcode, li.collected_at, li.verified_at,
                lo.order_no, lo.priority, lo.ordered_at, lo.patient_id, p.mrn, p.full_name_ar AS patient_name,
                t.name_ar AS test_name, t.unit, lr.value_numeric, lr.value_text, lr.flag
           FROM lab_order_items li
           JOIN lab_orders lo ON lo.id = li.order_id
           JOIN lab_tests t ON t.code = li.test_code
           JOIN patients p ON p.id = lo.patient_id
           LEFT JOIN lab_results lr ON lr.order_item_id = li.id
          WHERE li.facility_id = $1 AND li.status <> 'cancelled' ${filter}
          ORDER BY CASE lo.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, lo.ordered_at ASC
          LIMIT 200`,
        params,
      );
      return { items: rows.rows };
    });
  });

  app.post('/api/lab/items/:id/collect', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.sample.collect');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ barcode: z.string().min(4).max(64).optional() }), req.body ?? {});
    return withTenantAudited(
      auth,
      async (db) => {
        const item = await labItemContext(db, id);
        if (item.status !== 'ordered') throw conflict('لا يمكن جمع عينة في هذه الحالة');
        const barcode = b.barcode ?? `SPC-${item.order_no}-${item.test_code}-${Date.now().toString(36).toUpperCase()}`;
        await db.query(
          `UPDATE lab_order_items SET status = 'collected', specimen_barcode = $1, collected_by = $2, collected_at = now() WHERE id = $3`,
          [barcode, auth.user.id, id],
        );
        await db.query(`UPDATE lab_orders SET status = 'collected' WHERE id = (SELECT order_id FROM lab_order_items WHERE id = $1) AND status = 'ordered'`, [id]);
        return { barcode };
      },
      () => ({ action: 'lab.sample.collect', entityType: 'lab_item', entityId: id, patientId: null, ip: req.ip }),
    );
  });

  app.post('/api/lab/items/:id/result', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.result.enter');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({
        valueNumeric: z.number().optional(),
        valueText: z.string().max(500).optional(),
        comment: z.string().max(500).optional(),
      }),
      req.body,
    );
    if (b.valueNumeric === undefined && !b.valueText) throw conflict('يجب إدخال قيمة النتيجة');
    return withTenantAudited(
      auth,
      async (db) => {
        const item = await labItemContext(db, id);
        if (!['collected', 'resulted'].includes(item.status)) throw conflict('يجب جمع العينة قبل إدخال النتيجة');
        const flag = b.valueNumeric !== undefined ? computeFlag(b.valueNumeric, item) : 'normal';
        const existing = await db.query(`SELECT id FROM lab_results WHERE order_item_id = $1`, [id]);
        const resultId = existing.rows[0]?.id ?? crypto.randomUUID();
        if (existing.rows[0]) {
          await db.query(
            `UPDATE lab_results SET value_numeric = $1, value_text = $2, unit = $3, flag = $4, comment = $5,
               resulted_by = $6, resulted_at = now(), verified_by = NULL, verified_at = NULL WHERE id = $7`,
            [b.valueNumeric ?? null, b.valueText ?? null, item.unit, flag, b.comment ?? null, auth.user.id, resultId],
          );
        } else {
          await db.query(
            `INSERT INTO lab_results (id, facility_id, order_item_id, value_numeric, value_text, unit, flag, comment, resulted_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [resultId, item.order_facility, id, b.valueNumeric ?? null, b.valueText ?? null, item.unit, flag, b.comment ?? null, auth.user.id],
          );
        }
        await db.query(`UPDATE lab_order_items SET status = 'resulted' WHERE id = $1`, [id]);
        let alertCreated = false;
        if (flag === 'critical_low' || flag === 'critical_high') {
          const alertId = crypto.randomUUID();
          await db.query(
            `INSERT INTO critical_alerts (id, facility_id, patient_id, result_id, message)
             VALUES ($1,$2,$3,$4,$5)`,
            [alertId, item.order_facility, item.patient_id, resultId,
              `قيمة حرجة: ${item.test_name} = ${b.valueNumeric ?? b.valueText} ${item.unit ?? ''} (${item.patient_name} / ${item.mrn})`],
          );
          await db.query(
            `INSERT INTO notifications_outbox (facility_id, channel, subject, body, patient_id, related_type, related_id)
             VALUES ($1,'in_app','تنبيه قيمة حرجة',$2,$3,'critical_alert',$4)`,
            [item.order_facility, `${item.test_name}: ${b.valueNumeric ?? b.valueText} ${item.unit ?? ''}`, item.patient_id, alertId],
          );
          alertCreated = true;
        }
        return { resultId, flag, alertCreated };
      },
      (r) => ({
        action: 'lab.result.enter', entityType: 'lab_item', entityId: id, patientId: null,
        detail: { resultId: r.resultId, flag: r.flag, criticalAlert: r.alertCreated }, ip: req.ip,
      }),
    );
  });

  app.post('/api/lab/items/:id/verify', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.result.verify');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const item = await labItemContext(db, id);
        const result = await db.query<{ id: string; resulted_by: string; value_numeric: string | null; verified_at: string | null }>(
          `SELECT id, resulted_by, value_numeric, verified_at FROM lab_results WHERE order_item_id = $1`,
          [id],
        );
        const r = result.rows[0];
        if (!r) throw conflict('لا توجد نتيجة للمراجعة');
        if (r.verified_at) throw conflict('تم اعتماد النتيجة مسبقًا');
        if (r.resulted_by === auth.user.id) {
          throw conflict('لا يجوز اعتماد نتيجة أدخلها نفس المستخدم (فصل المهام)');
        }
        await db.query(`UPDATE lab_results SET verified_by = $1, verified_at = now() WHERE id = $2`, [auth.user.id, r.id]);
        await db.query(`UPDATE lab_order_items SET status = 'verified', verified_by = $1, verified_at = now() WHERE id = $2`, [auth.user.id, id]);
        const remaining = await db.query<{ count: string }>(
          `SELECT count(*) FROM lab_order_items WHERE order_id = $1 AND status IN ('ordered','collected','resulted')`,
          [item.order_id],
        );
        if (Number(remaining.rows[0]?.count ?? 0) === 0) {
          await db.query(`UPDATE lab_orders SET status = 'completed' WHERE id = $1`, [item.order_id]);
        }
        const patient = await loadPatientOr404(db, item.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'lab_verify' });
        return { ok: true };
      },
      () => ({ action: 'lab.result.verify', entityType: 'lab_item', entityId: id, patientId: null, ip: req.ip }),
    );
  });

  app.post('/api/lab/results/:id/amend', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.result.amend');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(
      z.object({ valueNumeric: z.number().optional(), valueText: z.string().max(500).optional(), reason: z.string().min(10).max(500) }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const row = await db.query<any>(
          `SELECT r.*, li.id AS item_id, li.order_id, lo.patient_id, t.ref_low, t.ref_high, t.critical_low, t.critical_high
             FROM lab_results r JOIN lab_order_items li ON li.id = r.order_item_id
             JOIN lab_orders lo ON lo.id = li.order_id JOIN lab_tests t ON t.code = li.test_code
            WHERE r.id = $1`,
          [id],
        );
        const result = row.rows[0];
        if (!result) throw notFound('النتيجة غير موجودة');
        if (!result.verified_at) throw conflict('لا يمكن تعديل نتيجة غير معتمدة عبر التصحيح — أعد إدخالها');
        const newFlag = b.valueNumeric !== undefined ? computeFlag(b.valueNumeric, result) : result.flag;
        await db.query(
          `INSERT INTO lab_result_amendments (id, facility_id, result_id, previous_value, new_value, reason, amended_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [crypto.randomUUID(), result.facility_id, id,
            result.value_numeric ?? result.value_text, b.valueNumeric ?? b.valueText, b.reason, auth.user.id],
        );
        await db.query(
          `UPDATE lab_results SET value_numeric = COALESCE($1, value_numeric), value_text = COALESCE($2, value_text),
             flag = $3, verified_by = $4, verified_at = now() WHERE id = $5`,
          [b.valueNumeric ?? null, b.valueText ?? null, newFlag, auth.user.id, id],
        );
        return { ok: true, flag: newFlag };
      },
      () => ({ action: 'lab.result.amend', entityType: 'lab_result', entityId: id, patientId: null, reason: b.reason, ip: req.ip }),
    );
  });

  app.get('/api/lab/alerts', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.critical.ack');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT ca.*, p.full_name_ar AS patient_name, p.mrn, u.full_name_ar AS ack_by
           FROM critical_alerts ca JOIN patients p ON p.id = ca.patient_id
           LEFT JOIN users u ON u.id = ca.acknowledged_by
          WHERE ca.facility_id = $1 ORDER BY ca.acknowledged_at NULLS FIRST, ca.created_at DESC LIMIT 100`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows };
    });
  });

  app.post('/api/lab/alerts/:id/ack', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'lab.critical.ack');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ note: z.string().min(3).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query(`UPDATE critical_alerts SET acknowledged_by = $1, acknowledged_at = now(), ack_note = $2 WHERE id = $3 AND acknowledged_at IS NULL`, [auth.user.id, b.note, id]);
        if (res.rowCount === 0) throw conflict('التنبيه غير موجود أو تمت معالجته');
        return { ok: true };
      },
      () => ({ action: 'lab.critical.ack', entityType: 'critical_alert', entityId: id, reason: b.note, ip: req.ip }),
    );
  });
}
