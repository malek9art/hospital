import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, idempotent } from '../../lib/tenant';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';
import { ensureCharge } from '../billing/service';
import { conflict, notFound } from '../../lib/errors';
import { normalize } from '../../lib/crypto';

export async function pharmacyRoutes(app: FastifyInstance) {
  app.get('/api/pharmacy/prescriptions', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'pharmacy.prescription.read');
    const { status } = parse(z.object({ status: z.enum(['issued', 'partially_dispensed', 'dispensed', 'cancelled', 'all']).default('issued') }), req.query);
    return withTenant(auth, async (db) => {
      const params: unknown[] = [auth.activeFacilityId];
      let filter = '';
      if (status !== 'all') {
        params.push(status);
        filter = `AND p.status = $2`;
      }
      const rows = await db.query(
        `SELECT p.id, p.prescription_no, p.status, p.prescribed_at, pat.mrn, pat.full_name_ar AS patient_name,
                u.full_name_ar AS prescriber,
                json_agg(json_build_object('id', pi.id, 'drug', d.name_ar, 'dose', pi.dose, 'frequency', pi.frequency,
                  'quantity', pi.quantity, 'status', pi.status)) AS items
           FROM prescriptions p
           JOIN patients pat ON pat.id = p.patient_id
           JOIN prescription_items pi ON pi.prescription_id = p.id
           JOIN drugs d ON d.id = pi.drug_id
           JOIN users u ON u.id = p.prescribed_by
          WHERE p.facility_id = $1 ${filter}
          GROUP BY p.id, pat.mrn, pat.full_name_ar, u.full_name_ar
          ORDER BY p.prescribed_at ASC LIMIT 100`,
        params,
      );
      return { items: rows.rows };
    });
  });

  app.get('/api/pharmacy/prescriptions/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'pharmacy.prescription.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const rx = await db.query<any>(
        `SELECT p.*, pat.full_name_ar AS patient_name, pat.mrn, pat.date_of_birth, pat.sex
           FROM prescriptions p JOIN patients pat ON pat.id = p.patient_id WHERE p.id = $1`,
        [id],
      );
      const row = rx.rows[0];
      if (!row) throw notFound('الوصفة غير موجودة');
      const items = await db.query<any>(
        `SELECT pi.*, d.name_ar AS drug_name, d.name_en, d.form, d.strength
           FROM prescription_items pi JOIN drugs d ON d.id = pi.drug_id WHERE pi.prescription_id = $1 ORDER BY pi.id`,
        [id],
      );
      const allergies = await db.query(`SELECT allergen, severity, reaction FROM patient_allergies WHERE patient_id = $1 AND is_active = true`, [row.patient_id]);
      const warnings: { type: string; severity: string; message: string }[] = [];
      for (const item of items.rows) {
        for (const a of allergies.rows as any[]) {
          const allergen = normalize(a.allergen);
          if (allergen.length > 2 && (normalize(item.drug_name).includes(allergen) || normalize(item.name_en).includes(allergen))) {
            warnings.push({ type: 'allergy', severity: 'major', message: `حساسية مسجلة (${a.allergen}) تتعارض مع ${item.drug_name}` });
          }
        }
      }
      const codes = items.rows.map((i: any) => i.drug_id);
      if (items.rows.length > 1) {
        const ids = items.rows.map((i: any) => i.drug_id);
        const inter = await db.query<any>(
          `SELECT di.severity, di.description, da.name_ar AS drug_a, db2.name_ar AS drug_b
             FROM drug_interactions di
             JOIN drugs da ON da.code = di.drug_a_code
             JOIN drugs db2 ON db2.code = di.drug_b_code
            WHERE da.id = ANY($1::uuid[]) AND db2.id = ANY($1::uuid[])`,
          [ids],
        );
        for (const i of inter.rows) {
          warnings.push({ type: 'interaction', severity: i.severity, message: `${i.drug_a} + ${i.drug_b}: ${i.description}` });
        }
      }
      const stock = await db.query(
        `SELECT b.id, b.batch_no, b.expiry_date, b.qty_on_hand, d.name_ar AS drug_name, d.id AS drug_id
           FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
          WHERE b.facility_id = $1 AND b.qty_on_hand > 0 AND d.id = ANY($2::uuid[]) ORDER BY b.expiry_date ASC`,
        [auth.activeFacilityId, codes.length ? codes : [crypto.randomUUID()]],
      );
      return { prescription: row, items: items.rows, allergies: allergies.rows, warnings, stock: stock.rows };
    });
  });

  app.post(
    '/api/pharmacy/dispense',
    async (req) => {
      const auth = requireAuth(req);
      requirePermission(auth, 'pharmacy.dispense');
      const b = parse(
        z.object({
          prescriptionId: zId,
          items: z.array(z.object({ itemId: zId, quantity: z.number().positive().max(10000) })).min(1),
          overrideReason: z.string().min(10).max(500).optional(),
          acknowledgedWarnings: z.boolean().default(false),
        }),
        req.body,
      );
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      return withTenant(auth, async (db) => {
        const rx = await db.query<any>(
          `SELECT p.*, pat.full_name_ar AS patient_name FROM prescriptions p JOIN patients pat ON pat.id = p.patient_id WHERE p.id = $1`,
          [b.prescriptionId],
        );
        const prescription = rx.rows[0];
        if (!prescription) throw notFound('الوصفة غير موجودة');
        if (prescription.status === 'cancelled') throw conflict('الوصفة ملغاة');
        const patient = await loadPatientOr404(db, prescription.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'dispense' });

        const drugRows = await db.query<any>(
          `SELECT pi.*, d.name_ar, d.is_controlled FROM prescription_items pi JOIN drugs d ON d.id = pi.drug_id
            WHERE pi.prescription_id = $1 AND pi.id = ANY($2::uuid[])`,
          [b.prescriptionId, b.items.map((i) => i.itemId)],
        );
        if (drugRows.rows.length !== b.items.length) throw notFound('أحد بنود الوصفة غير موجود');
        const allergies = await db.query<any>(`SELECT allergen FROM patient_allergies WHERE patient_id = $1 AND is_active = true`, [prescription.patient_id]);
        let severe = false;
        for (const item of drugRows.rows) {
          for (const a of allergies.rows) {
            const allergen = normalize(a.allergen);
            if (allergen.length > 2 && (normalize(item.name_ar).includes(allergen))) severe = true;
          }
        }
        if (severe && (!b.acknowledgedWarnings || !b.overrideReason)) {
          throw conflict('تحذير حساسية خطير: يلزم تأكيد صريح مع سبب موثق', { warnings: ['allergy'], requiresOverride: true });
        }

        return idempotent(
          db,
          { key: idempotencyKey, userId: auth.user.id, endpoint: 'pharmacy.dispense', body: b },
          async () => {
            const dispensed: { itemId: string; batches: { batchId: string; quantity: number }[] }[] = [];
            for (const line of b.items) {
              const item = drugRows.rows.find((d) => d.id === line.itemId);
              if (!item) throw notFound('بند الوصفة غير موجود');
              if (item.status !== 'pending') throw conflict(`بند ${item.name_ar} تم صرفه مسبقًا`);
              let remaining = line.quantity;
              const batches = await db.query<any>(
                `SELECT id, qty_on_hand, batch_no, expiry_date FROM drug_batches
                  WHERE facility_id = $1 AND drug_id = $2 AND qty_on_hand > 0 AND expiry_date >= current_date
                  ORDER BY expiry_date ASC FOR UPDATE`,
                [prescription.facility_id, item.drug_id],
              );
              const used: { batchId: string; quantity: number }[] = [];
              for (const batch of batches.rows) {
                if (remaining <= 0) break;
                const take = Math.min(Number(batch.qty_on_hand), remaining);
                if (take <= 0) continue;
                await db.query(`UPDATE drug_batches SET qty_on_hand = qty_on_hand - $1 WHERE id = $2`, [take, batch.id]);
                await db.query(
                  `INSERT INTO dispenses (id, facility_id, prescription_item_id, drug_batch_id, quantity, dispensed_by)
                   VALUES ($1,$2,$3,$4,$5,$6)`,
                  [crypto.randomUUID(), prescription.facility_id, item.id, batch.id, take, auth.user.id],
                );
                await db.query(
                  `INSERT INTO stock_movements (facility_id, drug_id, batch_id, movement_type, quantity, reference_type, reference_id, performed_by)
                   VALUES ($1,$2,$3,'dispense',$4,'prescription_item',$5,$6)`,
                  [prescription.facility_id, item.drug_id, batch.id, -take, item.id, auth.user.id],
                );
                used.push({ batchId: batch.id, quantity: take });
                remaining -= take;
              }
              if (remaining > 0.001) throw conflict(`المخزون غير كافٍ لصرف ${item.name_ar}. المتاح: ${line.quantity - remaining}`);
              await db.query(`UPDATE prescription_items SET status = 'dispensed' WHERE id = $1`, [item.id]);
              await ensureCharge(db, {
                facilityId: prescription.facility_id,
                patientId: prescription.patient_id,
                encounterId: prescription.encounter_id,
                category: 'pharmacy',
                description: `صرف ${item.name_ar}`,
                referenceType: 'prescription_item',
                referenceId: item.id,
                quantity: line.quantity,
                unitPrice: Number(item.price),
                createdBy: auth.user.id,
              });
              dispensed.push({ itemId: item.id, batches: used });
            }
            const pending = await db.query<{ count: string }>(
              `SELECT count(*) FROM prescription_items WHERE prescription_id = $1 AND status = 'pending'`,
              [b.prescriptionId],
            );
            await db.query(`UPDATE prescriptions SET status = $1 WHERE id = $2`, [
              Number(pending.rows[0]?.count ?? 0) === 0 ? 'dispensed' : 'partially_dispensed',
              b.prescriptionId,
            ]);
            return { ok: true, dispensed, replayed: false };
          },
        ).then(async (result) => {
          if (!result.replayed) {
            const { writeAudit } = await import('../../lib/audit');
            await writeAudit(db, {
              facilityId: prescription.facility_id,
              actorUserId: auth.user.id,
              actorRole: auth.roles[0]?.role_id ?? null,
              action: 'pharmacy.dispense',
              entityType: 'prescription',
              entityId: b.prescriptionId,
              patientId: prescription.patient_id,
              reason: b.overrideReason ?? null,
              detail: { items: b.items, acknowledgedWarnings: b.acknowledgedWarnings },
              ip: req.ip,
            });
          }
          return result;
        });
      });
    },
  );

  app.get('/api/pharmacy/stock', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'pharmacy.stock.manage');
    const { search } = parse(z.object({ search: z.string().max(120).optional() }), req.query);
    return withTenant(auth, async (db) => {
      const params: unknown[] = [auth.activeFacilityId];
      let filter = '';
      if (search) {
        params.push(`%${search}%`);
        filter = `AND (d.name_ar ILIKE $2 OR b.batch_no ILIKE $2)`;
      }
      const rows = await db.query(
        `SELECT b.id, d.id AS drug_id, d.name_ar, d.name_en, d.form, d.strength, b.batch_no, b.expiry_date,
                b.qty_on_hand, d.price,
                COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.batch_id = b.id), 0) AS moved
           FROM drug_batches b JOIN drugs d ON d.id = b.drug_id
          WHERE b.facility_id = $1 ${filter}
          ORDER BY d.name_ar, b.expiry_date ASC LIMIT 300`,
        params,
      );
      return { items: rows.rows };
    });
  });

  app.post('/api/pharmacy/stock/receive', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'pharmacy.stock.manage');
    const b = parse(
      z.object({
        drugId: zId,
        batchNo: z.string().min(1).max(60),
        expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        quantity: z.number().positive().max(1_000_000),
        unitCost: z.number().min(0).default(0),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        if (new Date(b.expiryDate).getTime() < Date.now()) throw conflict('لا يمكن استلام دفعة منتهية الصلاحية');
        const existing = await db.query<{ id: string; qty_on_hand: string }>(
          `SELECT id, qty_on_hand FROM drug_batches WHERE facility_id = $1 AND drug_id = $2 AND batch_no = $3 AND expiry_date = $4`,
          [auth.activeFacilityId, b.drugId, b.batchNo, b.expiryDate],
        );
        let batchId = existing.rows[0]?.id;
        if (batchId) {
          await db.query(`UPDATE drug_batches SET qty_on_hand = qty_on_hand + $1, unit_cost = $2 WHERE id = $3`, [b.quantity, b.unitCost, batchId]);
        } else {
          batchId = crypto.randomUUID();
          await db.query(
            `INSERT INTO drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [batchId, auth.activeFacilityId, b.drugId, b.batchNo, b.expiryDate, b.quantity, b.unitCost],
          );
        }
        await db.query(
          `INSERT INTO stock_movements (facility_id, drug_id, batch_id, movement_type, quantity, reference_type, performed_by, note)
           VALUES ($1,$2,$3,'receipt',$4,'manual_receipt',$5,$6)`,
          [auth.activeFacilityId, b.drugId, batchId, b.quantity, auth.user.id, `استلام دفعة ${b.batchNo}`],
        );
        reply.code(201);
        return { batchId };
      },
      (r) => ({ action: 'stock.receive', entityType: 'drug_batch', entityId: r.batchId, detail: { drugId: b.drugId, quantity: b.quantity, batchNo: b.batchNo }, ip: req.ip }),
    );
  });

  app.get('/api/pharmacy/movements', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'pharmacy.stock.manage');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT m.id, m.movement_type, m.quantity, m.created_at, d.name_ar AS drug_name, b.batch_no, u.full_name_ar AS performed_by
           FROM stock_movements m JOIN drugs d ON d.id = m.drug_id
           LEFT JOIN drug_batches b ON b.id = m.batch_id
           LEFT JOIN users u ON u.id = m.performed_by
          WHERE m.facility_id = $1 ORDER BY m.created_at DESC LIMIT 200`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows };
    });
  });
}
