import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission, requireAnyPermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';

const WAREHOUSE_TYPES = ['main', 'medical_supplies', 'surgical', 'dental', 'lab', 'rehab', 'general'] as const;
const ITEM_CATEGORIES = [
  'consumables',
  'ppe',
  'surgical_supplies',
  'lab_reagents',
  'dental_supplies',
  'physio_supplies',
  'radiology_supplies',
  'general',
] as const;

export const WAREHOUSE_TYPE_AR: Record<string, string> = {
  main: 'المستودع الطبي الرئيسي',
  medical_supplies: 'مستودع المستهلكات الطبية',
  surgical: 'مستودع العمليات والجراحة',
  dental: 'مستودع عيادة الأسنان',
  lab: 'مستودع المحاليل والمختبرات',
  rehab: 'مستودع العلاج الطبيعي',
  general: 'مستودع الإمداد العام',
};

export const ITEM_CATEGORY_AR: Record<string, string> = {
  consumables: 'مستهلكات طبية',
  ppe: 'معدات وقاية شخصية (PPE)',
  surgical_supplies: 'مستلزمات جراحية وعمليات',
  lab_reagents: 'كواشف ومحاليل مخبرية',
  dental_supplies: 'مستلزمات طب الأسنان',
  physio_supplies: 'مستلزمات العلاج الطبيعي',
  radiology_supplies: 'مستلزمات الأشعة والصبغات',
  general: 'إمداد تشغيلي عام',
};

export async function inventoryRoutes(app: FastifyInstance) {
  app.get('/api/inventory/board', async (req) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['inventory.read', 'inventory.request', 'inventory.stock', 'inventory.manage', 'inventory.issue']);
    return withTenant(auth, async (db) => {
      const [warehouses, items, stock, requisitions, movements] = await Promise.all([
        db.query(
          `SELECT w.*, d.name_ar AS department_name,
                  COUNT(s.id) FILTER (WHERE s.qty_on_hand > 0)::int AS active_batches,
                  COALESCE(SUM(s.qty_on_hand * s.unit_cost), 0)::numeric(14,2) AS valuation_sar
             FROM inventory_warehouses w
             LEFT JOIN departments d ON d.id = w.department_id
             LEFT JOIN inventory_stock s ON s.warehouse_id = w.id
            WHERE w.facility_id = $1
            GROUP BY w.id, d.name_ar
            ORDER BY w.code`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT i.*,
                  COALESCE(SUM(s.qty_on_hand) FILTER (WHERE s.expiry_date IS NULL OR s.expiry_date >= current_date), 0)::float8 AS total_on_hand,
                  COALESCE(SUM(s.qty_on_hand) FILTER (WHERE s.expiry_date < current_date), 0)::float8 AS expired_qty
             FROM inventory_items i
             LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.facility_id = i.facility_id
            WHERE i.facility_id = $1 AND i.is_active = true
            GROUP BY i.id
            ORDER BY i.sku`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT s.*, w.code AS warehouse_code, w.name_ar AS warehouse_name,
                  i.sku, i.name_ar AS item_name, i.category, i.unit,
                  CASE WHEN s.expiry_date IS NOT NULL AND s.expiry_date < current_date THEN true ELSE false END AS expired,
                  CASE WHEN s.expiry_date IS NOT NULL AND s.expiry_date BETWEEN current_date AND current_date + 90 THEN true ELSE false END AS expiring_soon,
                  CASE WHEN s.expiry_date IS NOT NULL THEN (s.expiry_date - current_date)::int ELSE NULL END AS days_left
             FROM inventory_stock s
             JOIN inventory_warehouses w ON w.id = s.warehouse_id
             JOIN inventory_items i ON i.id = s.item_id
            WHERE s.facility_id = $1 AND s.qty_on_hand > 0
            ORDER BY s.expiry_date ASC NULLS LAST, i.sku ASC
            LIMIT 300`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT r.*, w.name_ar AS warehouse_name, w.code AS warehouse_code,
                  d.name_ar AS department_name, i.sku, i.name_ar AS item_name, i.unit,
                  u1.full_name_ar AS requested_by_name, u2.full_name_ar AS issued_by_name
             FROM inventory_requisitions r
             JOIN inventory_warehouses w ON w.id = r.warehouse_id
             JOIN departments d ON d.id = r.department_id
             JOIN inventory_items i ON i.id = r.item_id
             JOIN users u1 ON u1.id = r.requested_by
             LEFT JOIN users u2 ON u2.id = r.issued_by
            WHERE r.facility_id = $1
            ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
                     CASE r.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
                     r.created_at DESC
            LIMIT 150`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT m.*, w.name_ar AS warehouse_name, i.sku, i.name_ar AS item_name, i.unit,
                  s.batch_no, u.full_name_ar AS performed_by_name
             FROM inventory_movements m
             JOIN inventory_warehouses w ON w.id = m.warehouse_id
             JOIN inventory_items i ON i.id = m.item_id
             LEFT JOIN inventory_stock s ON s.id = m.stock_id
             JOIN users u ON u.id = m.performed_by
            WHERE m.facility_id = $1
            ORDER BY m.created_at DESC
            LIMIT 150`,
          [auth.activeFacilityId],
        ),
      ]);

      const enrichedItems = items.rows.map((it: any) => ({
        ...it,
        category_ar: ITEM_CATEGORY_AR[it.category] ?? it.category,
        low_stock: Number(it.total_on_hand) <= Number(it.reorder_level),
      }));

      const totalValuation = warehouses.rows.reduce((sum: number, w: any) => sum + Number(w.valuation_sar ?? 0), 0);
      const lowStockCount = enrichedItems.filter((i: any) => i.low_stock).length;
      const expiringCount = stock.rows.filter((s: any) => s.expiring_soon || s.expired).length;
      const pendingReqs = requisitions.rows.filter((r: any) => r.status === 'pending').length;

      return {
        totals: {
          warehouses: warehouses.rows.length,
          items: enrichedItems.length,
          lowStock: lowStockCount,
          expiringBatches: expiringCount,
          pendingRequisitions: pendingReqs,
          totalValuationSar: Math.round(totalValuation * 100) / 100,
        },
        warehouses: warehouses.rows.map((w: any) => ({
          ...w,
          warehouse_type_ar: WAREHOUSE_TYPE_AR[w.warehouse_type] ?? w.warehouse_type,
        })),
        items: enrichedItems,
        stock: stock.rows,
        requisitions: requisitions.rows,
        movements: movements.rows,
      };
    });
  });

  app.post('/api/inventory/warehouses', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.manage');
    const b = parse(
      z.object({
        code: z.string().trim().min(2).max(24).transform((s) => s.toUpperCase()),
        nameAr: z.string().trim().min(3).max(150),
        nameEn: z.string().trim().max(150).optional(),
        warehouseType: z.enum(WAREHOUSE_TYPES),
        departmentId: zId.optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO inventory_warehouses (id, facility_id, code, name_ar, name_en, warehouse_type, department_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, auth.activeFacilityId, b.code, b.nameAr, b.nameEn ?? null, b.warehouseType, b.departmentId ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, code: b.code };
      },
      (r) => ({
        action: 'inventory.warehouse.create',
        entityType: 'inventory_warehouse',
        entityId: r.id,
        detail: { code: b.code, nameAr: b.nameAr, warehouseType: b.warehouseType },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/items', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.manage');
    const b = parse(
      z.object({
        sku: z.string().trim().min(3).max(40).transform((s) => s.toUpperCase()),
        nameAr: z.string().trim().min(3).max(200),
        nameEn: z.string().trim().max(200).optional(),
        category: z.enum(ITEM_CATEGORIES),
        unit: z.string().trim().min(1).max(40).default('قطعة'),
        reorderLevel: z.number().min(0).max(1_000_000).default(10),
        unitCost: z.number().min(0).max(1_000_000).default(0),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO inventory_items (id, facility_id, sku, name_ar, name_en, category, unit, reorder_level, unit_cost, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, auth.activeFacilityId, b.sku, b.nameAr, b.nameEn ?? null, b.category, b.unit, b.reorderLevel, b.unitCost, auth.user.id],
        );
        reply.code(201);
        return { id, sku: b.sku };
      },
      (r) => ({
        action: 'inventory.item.create',
        entityType: 'inventory_item',
        entityId: r.id,
        detail: { sku: b.sku, nameAr: b.nameAr, category: b.category, reorderLevel: b.reorderLevel },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/stock/receive', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.stock');
    const b = parse(
      z.object({
        warehouseId: zId,
        itemId: zId,
        batchNo: z.string().trim().min(1).max(60),
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        quantity: z.number().positive().max(1_000_000),
        unitCost: z.number().min(0).max(1_000_000).optional(),
        notes: z.string().max(300).optional(),
      }),
      req.body,
    );
    const todayIso = new Date().toISOString().slice(0, 10);
    if (b.expiryDate && b.expiryDate < todayIso) {
      throw conflict('لا يمكن استلام دفعة مستلزمات منتهية الصلاحية');
    }
    return withTenantAudited(
      auth,
      async (db) => {
        const wh = await db.query(`SELECT id FROM inventory_warehouses WHERE id = $1 AND facility_id = $2`, [b.warehouseId, auth.activeFacilityId]);
        if (!wh.rows[0]) throw notFound('المستودع غير موجود');
        const item = await db.query<{ id: string; unit_cost: string }>(`SELECT id, unit_cost FROM inventory_items WHERE id = $1 AND facility_id = $2`, [b.itemId, auth.activeFacilityId]);
        if (!item.rows[0]) throw notFound('الصنف المخزني غير موجود');

        const cost = b.unitCost ?? Number(item.rows[0].unit_cost ?? 0);
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM inventory_stock WHERE warehouse_id = $1 AND item_id = $2 AND batch_no = $3 FOR UPDATE`,
          [b.warehouseId, b.itemId, b.batchNo],
        );
        let stockId = existing.rows[0]?.id;
        if (stockId) {
          await db.query(
            `UPDATE inventory_stock
                SET qty_on_hand = qty_on_hand + $1,
                    unit_cost = $2,
                    expiry_date = COALESCE($3::date, expiry_date),
                    updated_at = now()
              WHERE id = $4`,
            [b.quantity, cost, b.expiryDate ?? null, stockId],
          );
        } else {
          stockId = crypto.randomUUID();
          await db.query(
            `INSERT INTO inventory_stock (id, facility_id, warehouse_id, item_id, batch_no, expiry_date, qty_on_hand, unit_cost)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [stockId, auth.activeFacilityId, b.warehouseId, b.itemId, b.batchNo, b.expiryDate ?? null, b.quantity, cost],
          );
        }

        await db.query(
          `INSERT INTO inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reason, performed_by)
           VALUES ($1,$2,$3,$4,$5,'receipt',$6,'stock_receipt',$7,$8)`,
          [crypto.randomUUID(), auth.activeFacilityId, b.warehouseId, b.itemId, stockId, b.quantity, b.notes ?? `توريد تشغيلة ${b.batchNo}`, auth.user.id],
        );

        reply.code(201);
        return { stockId, batchNo: b.batchNo, quantity: b.quantity };
      },
      (r) => ({
        action: 'inventory.stock.receive',
        entityType: 'inventory_stock',
        entityId: r.stockId,
        detail: { warehouseId: b.warehouseId, itemId: b.itemId, batchNo: b.batchNo, quantity: b.quantity },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/stock/adjust', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.manage');
    const b = parse(
      z.object({
        stockId: zId,
        delta: z.number().refine((n) => n !== 0, 'قيمة التسوية يجب ألا تساوي صفرًا'),
        reason: z.string().trim().min(5).max(500),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const row = await db.query<any>(
          `SELECT * FROM inventory_stock WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [b.stockId, auth.activeFacilityId],
        );
        const stock = row.rows[0];
        if (!stock) throw notFound('دفعة المخزون غير موجودة');
        const nextQty = Number(stock.qty_on_hand) + b.delta;
        if (nextQty < 0) throw conflict(`لا يمكن خصم كمية تتجاوز الرصيد المتاح (${stock.qty_on_hand})`);

        await db.query(`UPDATE inventory_stock SET qty_on_hand = $1, updated_at = now() WHERE id = $2`, [nextQty, b.stockId]);
        await db.query(
          `INSERT INTO inventory_movements (id, facility_id, warehouse_id, item_id, stock_id, movement_type, quantity, reference_type, reason, performed_by)
           VALUES ($1,$2,$3,$4,$5,'adjustment',$6,'cycle_count',$7,$8)`,
          [crypto.randomUUID(), auth.activeFacilityId, stock.warehouse_id, stock.item_id, stock.id, b.delta, b.reason, auth.user.id],
        );
        return { ok: true, qtyOnHand: nextQty };
      },
      () => ({
        action: 'inventory.stock.adjust',
        entityType: 'inventory_stock',
        entityId: b.stockId,
        reason: b.reason,
        detail: { delta: b.delta },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/requisitions', async (req, reply) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['inventory.request', 'inventory.manage', 'inventory.stock']);
    const b = parse(
      z.object({
        warehouseId: zId,
        departmentId: zId,
        itemId: zId,
        qtyRequested: z.number().positive().max(100_000),
        priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
        notes: z.string().max(400).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const [wh, dept, item] = await Promise.all([
          db.query(`SELECT id FROM inventory_warehouses WHERE id = $1 AND facility_id = $2`, [b.warehouseId, auth.activeFacilityId]),
          db.query(`SELECT id FROM departments WHERE id = $1 AND facility_id = $2`, [b.departmentId, auth.activeFacilityId]),
          db.query(`SELECT id FROM inventory_items WHERE id = $1 AND facility_id = $2`, [b.itemId, auth.activeFacilityId]),
        ]);
        if (!wh.rows[0]) throw notFound('المستودع غير موجود');
        if (!dept.rows[0]) throw notFound('القسم الطالب غير موجود');
        if (!item.rows[0]) throw notFound('الصنف المطلوب غير موجود');

        const id = crypto.randomUUID();
        const reqNo = await nextDocumentNo(db, auth.activeFacilityId, 'inv_req', 'REQ');
        await db.query(
          `INSERT INTO inventory_requisitions (
             id, facility_id, req_no, warehouse_id, department_id, item_id,
             qty_requested, priority, notes, requested_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, auth.activeFacilityId, reqNo, b.warehouseId, b.departmentId, b.itemId, b.qtyRequested, b.priority, b.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, reqNo, status: 'pending' };
      },
      (r) => ({
        action: 'inventory.requisition.create',
        entityType: 'inventory_requisition',
        entityId: r.id,
        detail: { reqNo: r.reqNo, itemId: b.itemId, qtyRequested: b.qtyRequested, priority: b.priority },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/requisitions/:id/issue', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT r.*, i.name_ar AS item_name
             FROM inventory_requisitions r
             JOIN inventory_items i ON i.id = r.item_id
            WHERE r.id = $1 AND r.facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const reqRow = res.rows[0];
        if (!reqRow) throw notFound('طلب الصرف المخزني غير موجود');
        if (reqRow.status !== 'pending') throw conflict('طلب الصرف تمت معالجته مسبقًا');
        if (reqRow.requested_by === auth.user.id) {
          throw conflict('فصل المهام: لا يجوز لمقدّم طلب الصرف اعتماد وصرف طلبه بنفسه');
        }

        let remaining = Number(reqRow.qty_requested);
        const batches = await db.query<any>(
          `SELECT id, batch_no, qty_on_hand, expiry_date
             FROM inventory_stock
            WHERE facility_id = $1 AND warehouse_id = $2 AND item_id = $3
              AND qty_on_hand > 0
              AND (expiry_date IS NULL OR expiry_date >= current_date)
            ORDER BY expiry_date ASC NULLS LAST, received_at ASC
            FOR UPDATE`,
          [auth.activeFacilityId, reqRow.warehouse_id, reqRow.item_id],
        );

        const totalAvailable = batches.rows.reduce((s: number, b: any) => s + Number(b.qty_on_hand), 0);
        if (totalAvailable + 0.0001 < remaining) {
          throw conflict(`الرصيد الساري في المستودع غير كافٍ لصرف ${reqRow.item_name} (المتاح: ${totalAvailable}، المطلوب: ${remaining})`);
        }

        const usedBatches: { stockId: string; batchNo: string; quantity: number }[] = [];
        for (const batch of batches.rows) {
          if (remaining <= 0) break;
          const take = Math.min(Number(batch.qty_on_hand), remaining);
          if (take <= 0) continue;
          await db.query(`UPDATE inventory_stock SET qty_on_hand = qty_on_hand - $1, updated_at = now() WHERE id = $2`, [take, batch.id]);
          await db.query(
            `INSERT INTO inventory_movements (
               id, facility_id, warehouse_id, item_id, stock_id, movement_type,
               quantity, reference_type, reference_id, reason, performed_by
             ) VALUES ($1,$2,$3,$4,$5,'issue',$6,'inventory_requisition',$7,$8,$9)`,
            [
              crypto.randomUUID(),
              auth.activeFacilityId,
              reqRow.warehouse_id,
              reqRow.item_id,
              batch.id,
              -take,
              reqRow.id,
              `صرف مخزني للطلب ${reqRow.req_no}`,
              auth.user.id,
            ],
          );
          usedBatches.push({ stockId: batch.id, batchNo: batch.batch_no, quantity: take });
          remaining -= take;
        }

        await db.query(
          `UPDATE inventory_requisitions
              SET status = 'issued', qty_issued = $1, issued_by = $2, issued_at = now()
            WHERE id = $3`,
          [reqRow.qty_requested, auth.user.id, id],
        );

        return { ok: true, status: 'issued', batches: usedBatches };
      },
      (r) => ({
        action: 'inventory.requisition.issue',
        entityType: 'inventory_requisition',
        entityId: id,
        detail: { batches: r.batches },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/inventory/requisitions/:id/reject', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'inventory.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(400) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<any>(
          `SELECT * FROM inventory_requisitions WHERE id = $1 AND facility_id = $2 FOR UPDATE`,
          [id, auth.activeFacilityId],
        );
        const reqRow = res.rows[0];
        if (!reqRow) throw notFound('طلب الصرف المخزني غير موجود');
        if (reqRow.status !== 'pending') throw conflict('طلب الصرف تمت معالجته مسبقًا');
        await db.query(
          `UPDATE inventory_requisitions SET status = 'rejected', reject_reason = $1 WHERE id = $2`,
          [b.reason, id],
        );
        return { ok: true, status: 'rejected' };
      },
      () => ({
        action: 'inventory.requisition.reject',
        entityType: 'inventory_requisition',
        entityId: id,
        reason: b.reason,
        ip: req.ip,
      }),
    );
  });
}
