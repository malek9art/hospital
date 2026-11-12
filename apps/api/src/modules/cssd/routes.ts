import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

/**
 * CSSD (central sterile services) and infection prevention & control.
 *
 * Sterile packs follow dirty → washing → packed → sterilizing → released →
 * issued → used → returned, with quarantine/recall as terminal safety states.
 *
 * Rules enforced here (and mirrored in database triggers):
 *  - a pack joins exactly one load, while packed, and one cycle per set;
 *  - the operator of a sterilization load cannot approve it;
 *  - a pack is only released from an approved load with a passed biological
 *    indicator, and only before expiry;
 *  - a failed load quarantines its packs; a recall marks every pack of the load
 *    and preserves the case linkage for patient follow-up;
 *  - infection cases move suspected → confirmed/excluded once, with a reviewer;
 *  - hand-hygiene observations are append-only audit evidence.
 *
 * Limits: no autoclave integration (indicators are entered manually), no
 * instrument-level tracking inside a set, and no automated outbreak detection.
 */

export const PACK_STATUS_AR: Record<string, string> = {
  dirty: 'ملوّثة', washing: 'قيد الغسل', packed: 'مغلّفة', sterilizing: 'قيد التعقيم',
  released: 'معقّمة ومخزّنة', issued: 'مصروفة', used: 'مستخدمة', returned: 'مُعادة',
  quarantined: 'محجوزة احترازيًا', recalled: 'مسحوبة',
};
export const PRECAUTION_AR: Record<string, string> = {
  contact: 'ملامسة', droplet: 'رذاذ', airborne: 'هوائي', protective: 'حماية عكسية',
};
export const CASE_TYPE_AR: Record<string, string> = {
  cauti: 'عدوى بولية مرتبطة بالقسطرة', clabsi: 'عدوى دم مرتبطة بالخط الوريدي',
  vap: 'التهاب رئة مرتبط بالتنفس الصناعي', ssi: 'عدوى موضع جراحي',
  cdi: 'عدوى المطثية العسيرة', mrsa: 'عدوى المكورات العنقودية المقاومة', other: 'أخرى',
};
export const MOMENT_AR: Record<string, string> = {
  before_patient: 'قبل لمس المريض', before_aseptic: 'قبل إجراء معقّم',
  after_body_fluid: 'بعد التعرض لسوائل الجسم', after_patient: 'بعد لمس المريض',
  after_surroundings: 'بعد محيط المريض',
};
export const METHOD_AR: Record<string, string> = { steam: 'بخار', plasma: 'بلازما', eto: 'أكسيد الإيثيلين' };
export const CATEGORY_AR: Record<string, string> = {
  minor: 'جراحة صغرى', laparotomy: 'فتح بطن', orthopedic: 'عظام', dressing: 'ضمادات', endoscopy: 'مناظير', other: 'أخرى',
};

/** Shelf life after release, by packaging type (documented in the API/UI). */
export const SHELF_LIFE_DAYS: Record<string, number> = { wrap: 30, container: 90 };

export function shelfLifeDays(packaging: string) {
  return SHELF_LIFE_DAYS[packaging] ?? 30;
}

function isExpired(pack: any) {
  return pack.expires_at ? new Date(pack.expires_at).getTime() <= Date.now() : false;
}

async function loadPack(db: any, id: string) {
  const res = await db.query(
    `SELECT p.*, s.name_ar AS set_name, s.code AS set_code, s.instrument_count,
            l.load_no, l.autoclave_code, l.method, l.cycle_no, l.biological_indicator,
            l.chemical_indicator, l.status AS load_status, l.approved_at, l.recalled_at AS load_recalled_at,
            c.case_no, c.procedure_name
       FROM cssd_packs p
       JOIN cssd_instrument_sets s ON s.id = p.set_id
       LEFT JOIN cssd_sterilization_loads l ON l.id = p.load_id
       LEFT JOIN surgical_cases c ON c.id = p.issued_to_case_id
      WHERE p.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('حزمة التعقيم غير موجودة');
  return row;
}

async function activeIsolation(db: any, patientId: string) {
  const res = await db.query(
    `SELECT * FROM infection_isolations WHERE patient_id = $1 AND ended_at IS NULL`,
    [patientId],
  );
  return res.rows[0] ?? null;
}

export async function cssdRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Board ----
  app.get('/api/cssd/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.read');
    return withTenant(auth, async (db) => {
      const packs = await db.query(
        `SELECT p.id, p.pack_no, p.status, p.packaging, p.cycle_count, p.released_at, p.expires_at,
                p.issued_to, p.issued_at, p.recall_reason,
                s.name_ar AS set_name, s.code AS set_code, s.instrument_count,
                l.load_no, l.method, l.autoclave_code, l.biological_indicator, l.status AS load_status,
                c.case_no, c.procedure_name,
                CASE WHEN p.expires_at IS NOT NULL AND p.expires_at <= now() THEN true ELSE false END AS expired,
                EXTRACT(day FROM (p.expires_at - now()))::int AS days_left
           FROM cssd_packs p
           JOIN cssd_instrument_sets s ON s.id = p.set_id
           LEFT JOIN cssd_sterilization_loads l ON l.id = p.load_id
           LEFT JOIN surgical_cases c ON c.id = p.issued_to_case_id
          WHERE p.facility_id = $1
          ORDER BY CASE p.status
                     WHEN 'quarantined' THEN 0 WHEN 'recalled' THEN 1 WHEN 'released' THEN 2
                     WHEN 'issued' THEN 3 WHEN 'sterilizing' THEN 4 WHEN 'packed' THEN 5
                     ELSE 6 END, p.expires_at NULLS LAST`,
        [auth.activeFacilityId],
      );
      const loads = await db.query(
        `SELECT l.*, u.full_name_ar AS operator_name, a.full_name_ar AS approver_name,
                (SELECT count(*)::int FROM cssd_packs p WHERE p.load_id = l.id) AS packs_actual
           FROM cssd_sterilization_loads l
           JOIN users u ON u.id = l.operator_id
           LEFT JOIN users a ON a.id = l.approved_by
          WHERE l.facility_id = $1
          ORDER BY l.started_at DESC LIMIT 30`,
        [auth.activeFacilityId],
      );
      const sets = await db.query(
        `SELECT s.*,
                (SELECT count(*)::int FROM cssd_packs p WHERE p.set_id = s.id AND p.status NOT IN ('returned','recalled')) AS live_packs
           FROM cssd_instrument_sets s
          WHERE s.facility_id = $1 AND s.is_active = true
          ORDER BY s.name_ar`,
        [auth.activeFacilityId],
      );
      const totals = await db.query<any>(
        `SELECT count(*) FILTER (WHERE status IN ('dirty','washing','packed'))::int AS in_process,
                count(*) FILTER (WHERE status = 'sterilizing')::int AS sterilizing,
                count(*) FILTER (WHERE status = 'released')::int AS released,
                count(*) FILTER (WHERE status = 'issued')::int AS issued,
                count(*) FILTER (WHERE status = 'released' AND expires_at <= now())::int AS expired,
                count(*) FILTER (WHERE status = 'quarantined')::int AS quarantined,
                count(*) FILTER (WHERE status = 'recalled')::int AS recalled
           FROM cssd_packs WHERE facility_id = $1`,
        [auth.activeFacilityId],
      );
      return {
        packs: packs.rows.map((p: any) => ({
          ...p,
          status_ar: PACK_STATUS_AR[p.status] ?? p.status,
          shelf_life_days: shelfLifeDays(p.packaging),
        })),
        loads: loads.rows.map((l: any) => ({ ...l, method_ar: METHOD_AR[l.method] ?? l.method })),
        sets: sets.rows.map((s: any) => ({ ...s, category_ar: CATEGORY_AR[s.category] ?? s.category })),
        totals: totals.rows[0],
      };
    });
  });

  // ----------------------------------------------------------- Instrument ----
  app.post('/api/cssd/sets', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.manage');
    const body = parse(
      z.object({
        code: z.string().min(2).max(40),
        nameAr: z.string().min(3).max(120),
        category: z.enum(['minor', 'laparotomy', 'orthopedic', 'dressing', 'endoscopy', 'other']),
        instrumentCount: z.number().int().min(1).max(500),
        department: z.string().max(80).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const duplicate = await db.query(`SELECT id FROM cssd_instrument_sets WHERE facility_id = $1 AND code = $2`,
          [auth.activeFacilityId, body.code]);
        if (duplicate.rows[0]) throw conflict('رمز الطقم مستخدم مسبقًا');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, auth.activeFacilityId, body.code, body.nameAr, body.category, body.instrumentCount,
            body.department ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, code: body.code, nameAr: body.nameAr };
      },
      (r) => ({
        action: 'cssd.set.create', entityType: 'cssd_instrument_set', entityId: r.id, patientId: null,
        detail: { code: body.code, category: body.category, instruments: body.instrumentCount }, ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------- Receiving ---
  app.post('/api/cssd/packs', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.reprocess');
    const body = parse(
      z.object({
        setId: zId,
        packaging: z.enum(['wrap', 'container']).default('wrap'),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const set = await db.query(`SELECT * FROM cssd_instrument_sets WHERE id = $1 AND is_active = true`, [body.setId]);
        if (!set.rows[0]) throw notFound('طقم الأدوات غير موجود أو غير مفعّل');
        const live = await db.query(
          `SELECT pack_no, status FROM cssd_packs WHERE set_id = $1
            AND status NOT IN ('returned','recalled') LIMIT 1`,
          [body.setId],
        );
        if (live.rows[0]) {
          throw conflict(`الطقم داخل دورة تعقيم مفتوحة (${String(live.rows[0].pack_no)} — ${PACK_STATUS_AR[String(live.rows[0].status)]})`);
        }
        // A returned pack re-enters the cycle with an incremented counter instead
        // of creating a duplicate identity for the same physical set.
        const returned = await db.query(
          `SELECT id, cycle_count FROM cssd_packs WHERE set_id = $1 AND status = 'returned'
            ORDER BY returned_at DESC LIMIT 1`,
          [body.setId],
        );
        if (returned.rows[0]) {
          await db.query(
            `UPDATE cssd_packs SET status = 'dirty', load_id = NULL, released_at = NULL, expires_at = NULL,
               issued_to = NULL, issued_to_case_id = NULL, issued_by = NULL, issued_at = NULL,
               used_at = NULL, cycle_count = cycle_count + 1, notes = COALESCE($2, notes)
             WHERE id = $1`,
            [returned.rows[0].id, body.notes ?? null],
          );
          reply.code(201);
          return { id: returned.rows[0].id, packNo: null, reused: true, cycleCount: Number(returned.rows[0].cycle_count) + 1 };
        }
        const packNo = await nextDocumentNo(db, auth.activeFacilityId, 'cssd_pack', 'CSS');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO cssd_packs (id, facility_id, pack_no, set_id, packaging, notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, auth.activeFacilityId, packNo, body.setId, body.packaging, body.notes ?? null],
        );
        reply.code(201);
        return { id, packNo, reused: false, status: 'dirty' };
      },
      (r) => ({
        action: 'cssd.pack.receive', entityType: 'cssd_pack', entityId: (r as { id: string }).id, patientId: null,
        detail: { packNo: (r as { packNo?: string | null }).packNo ?? null, reused: r.reused, setId: body.setId }, ip: req.ip,
      }),
    );
  });

  app.post('/api/cssd/packs/:id/wash', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.reprocess');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const pack = await loadPack(db, id);
        if (pack.status !== 'dirty') throw conflict('لا يمكن غسل حزمة ليست بحالة «ملوّثة»');
        await db.query(`UPDATE cssd_packs SET status = 'washing', washed_by = $2, washed_at = now() WHERE id = $1`,
          [id, auth.user.id]);
        return { id, status: 'washing' };
      },
      () => ({ action: 'cssd.pack.wash', entityType: 'cssd_pack', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  app.post('/api/cssd/packs/:id/pack', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.reprocess');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const pack = await loadPack(db, id);
        if (pack.status !== 'washing') throw conflict('يجب إتمام الغسل قبل التغليف');
        await db.query(`UPDATE cssd_packs SET status = 'packed', packed_by = $2, packed_at = now() WHERE id = $1`,
          [id, auth.user.id]);
        return { id, status: 'packed' };
      },
      () => ({ action: 'cssd.pack.pack', entityType: 'cssd_pack', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  // ------------------------------------------------------------- Loads -------
  app.post('/api/cssd/loads', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.sterilize');
    const body = parse(
      z.object({
        autoclaveCode: z.string().min(1).max(40),
        method: z.enum(['steam', 'plasma', 'eto']),
        packIds: z.array(zId).min(1).max(40),
        temperatureC: z.number().min(100).max(200).optional(),
        pressureBar: z.number().min(-1).max(5).optional(),
        durationMin: z.number().int().min(1).max(600).optional(),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const lastCycle = await db.query<{ next: number }>(
          `SELECT COALESCE(max(cycle_no), 0) + 1 AS next FROM cssd_sterilization_loads
            WHERE facility_id = $1 AND autoclave_code = $2`,
          [auth.activeFacilityId, body.autoclaveCode],
        );
        const cycleNo = Number(lastCycle.rows[0]?.next ?? 1);
        const loadNo = await nextDocumentNo(db, auth.activeFacilityId, 'cssd_load', 'CSL');
        const id = crypto.randomUUID();
        const packs: any[] = [];
        for (const packId of body.packIds) {
          const pack = await loadPack(db, packId);
          if (pack.status !== 'packed') {
            throw conflict(`الحزمة ${pack.pack_no} ليست مغلّفة (الحالة: ${PACK_STATUS_AR[pack.status]})`);
          }
          packs.push(pack);
        }
        await db.query(
          `INSERT INTO cssd_sterilization_loads (id, facility_id, load_no, autoclave_code, method, cycle_no,
             temperature_c, pressure_bar, duration_min, pack_count, operator_id, result_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, auth.activeFacilityId, loadNo, body.autoclaveCode, body.method, cycleNo,
            body.temperatureC ?? null, body.pressureBar ?? null, body.durationMin ?? null,
            packs.length, auth.user.id, body.notes ?? null],
        );
        for (const pack of packs) {
          await db.query(`UPDATE cssd_packs SET status = 'sterilizing', load_id = $2 WHERE id = $1`, [pack.id, id]);
        }
        reply.code(201);
        return { id, loadNo, cycleNo, packCount: packs.length, status: 'running', methodAr: METHOD_AR[body.method] };
      },
      (r) => ({
        action: 'cssd.load.start', entityType: 'cssd_sterilization_load', entityId: r.id, patientId: null,
        detail: { loadNo: r.loadNo, autoclave: body.autoclaveCode, cycle: r.cycleNo, packs: r.packCount }, ip: req.ip,
      }),
    );
  });

  app.post('/api/cssd/loads/:id/result', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.sterilize');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        chemicalIndicator: z.enum(['pass', 'fail']),
        biologicalIndicator: z.enum(['pass', 'fail']),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    let outcome: 'passed' | 'failed' = 'passed';
    return withTenantAudited(
      auth,
      async (db) => {
        const load = await db.query(`SELECT * FROM cssd_sterilization_loads WHERE id = $1`, [id]);
        const row = load.rows[0];
        if (!row) throw notFound('دورة التعقيم غير موجودة');
        if (row.status !== 'running') throw conflict('سُجّلت نتيجة هذه الدورة مسبقًا');
        outcome = body.chemicalIndicator === 'pass' && body.biologicalIndicator === 'pass' ? 'passed' : 'failed';
        await db.query(
          `UPDATE cssd_sterilization_loads
              SET status = $2, chemical_indicator = $3, biological_indicator = $4,
                  result_notes = $5, resulted_at = now()
            WHERE id = $1`,
          [id, outcome, body.chemicalIndicator, body.biologicalIndicator, body.notes ?? null],
        );
        if (outcome === 'failed') {
          // Every pack of a failed load is quarantined; it can never be issued.
          await db.query(
            `UPDATE cssd_packs SET status = 'quarantined',
               notes = COALESCE(notes || ' | ', '') || 'حجز احترازي: فشل مؤشر الدورة ' || $2
             WHERE load_id = $1 AND status IN ('sterilizing','released')`,
            [id, row.load_no],
          );
        }
        return {
          id,
          status: outcome,
          packsReleased: 0,
          note: outcome === 'failed'
            ? 'فشل المؤشر: حُجزت كل حزم الدورة ولا تُصرف حتى تُعتمد دورة جديدة'
            : 'النتيجة سليمة؛ تحتاج اعتماد شخص آخر قبل الإفراج المخزني',
        };
      },
      () => ({
        action: 'cssd.load.result', entityType: 'cssd_sterilization_load', entityId: id, patientId: null,
        detail: { outcome, chemical: body.chemicalIndicator, biological: body.biologicalIndicator }, ip: req.ip,
      }),
    );
  });

  app.post('/api/cssd/loads/:id/approve', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.release');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const load = await db.query(`SELECT * FROM cssd_sterilization_loads WHERE id = $1`, [id]);
        const row = load.rows[0];
        if (!row) throw notFound('دورة التعقيم غير موجودة');
        if (row.status === 'approved') throw conflict('الدورة معتمدة مسبقًا');
        if (row.status !== 'passed') {
          throw conflict('لا يمكن اعتماد دورة لم تنجح مؤشراتها');
        }
        if (row.operator_id === auth.user.id) {
          throw conflict('مشغّل الدورة لا يعتمدها؛ يلزم اعتماد شخص آخر (فصل مهام)');
        }
        await db.query(
          `UPDATE cssd_sterilization_loads SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
          [id, auth.user.id],
        );
        const packs = await db.query(
          `SELECT id, packaging FROM cssd_packs WHERE load_id = $1 AND status = 'sterilizing'`,
          [id],
        );
        for (const pack of packs.rows) {
          await db.query(
            `UPDATE cssd_packs SET status = 'released', released_at = now(),
               expires_at = now() + make_interval(days => $2::int)
             WHERE id = $1`,
            [pack.id, shelfLifeDays(String(pack.packaging))],
          );
        }
        return { id, status: 'approved', packsReleased: packs.rows.length };
      },
      (r) => ({
        action: 'cssd.load.approve', entityType: 'cssd_sterilization_load', entityId: id, patientId: null,
        detail: { packs: r.packsReleased }, ip: req.ip,
      }),
    );
  });

  app.post('/api/cssd/loads/:id/recall', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.release');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const load = await db.query(`SELECT * FROM cssd_sterilization_loads WHERE id = $1`, [id]);
        const row = load.rows[0];
        if (!row) throw notFound('دورة التعقيم غير موجودة');
        if (row.recalled_at) throw conflict('الدورة مسحوبة مسبقًا');
        const packs = await db.query(
          `SELECT id, pack_no, status, issued_to, issued_to_case_id FROM cssd_packs
            WHERE load_id = $1 AND status IN ('released','issued','used','quarantined')`,
          [id],
        );
        await db.query(
          `UPDATE cssd_sterilization_loads SET recalled_at = now(), recalled_by = $2, recall_reason = $3 WHERE id = $1`,
          [id, auth.user.id, body.reason],
        );
        for (const pack of packs.rows) {
          await db.query(`UPDATE cssd_packs SET status = 'recalled', recall_reason = $2 WHERE id = $1`,
            [pack.id, body.reason]);
        }
        const affected = packs.rows.filter((p: any) => p.issued_to_case_id || p.status === 'issued');
        return {
          id,
          recalledPacks: packs.rows.length,
          affectedCases: affected.map((p: any) => ({ packNo: p.pack_no, caseId: p.issued_to_case_id, issuedTo: p.issued_to })),
          note: 'يجب إبلاغ فريق الجراحة ومكافحة العدوى بالحالات المتأثرة',
        };
      },
      (r) => ({
        action: 'cssd.load.recall', entityType: 'cssd_sterilization_load', entityId: id, patientId: null,
        detail: { reason: body.reason, packs: r.recalledPacks, affectedCases: r.affectedCases.length }, ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------------- Issue ----
  app.post('/api/cssd/packs/:id/issue', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        issuedTo: z.string().min(2).max(120),
        caseId: zId.optional(),
      }),
      req.body,
    );
    let pack: any;
    return withTenantAudited(
      auth,
      async (db) => {
        pack = await loadPack(db, id);
        if (pack.status !== 'released') throw conflict(`لا يمكن صرف حزمة بحالة «${PACK_STATUS_AR[pack.status]}»`);
        if (pack.load_status !== 'approved') throw conflict('الدورة لم تُعتمد بعد ولا يجوز صرف حزمها');
        if (isExpired(pack)) throw conflict('الحزمة منتهية الصلاحية؛ أعد تعقيمها');
        if (body.caseId) {
          const surgicalCase = await db.query(`SELECT id, case_no, status FROM surgical_cases WHERE id = $1`, [body.caseId]);
          if (!surgicalCase.rows[0]) throw notFound('العملية الجراحية غير موجودة');
          if (['completed', 'cancelled'].includes(String(surgicalCase.rows[0].status))) {
            throw conflict('لا يمكن ربط حزمة بعملية مكتملة أو ملغاة');
          }
        }
        await db.query(
          `UPDATE cssd_packs SET status = 'issued', issued_to = $2, issued_to_case_id = $3,
             issued_by = $4, issued_at = now() WHERE id = $1`,
          [id, body.issuedTo, body.caseId ?? null, auth.user.id],
        );
        return {
          id, packNo: pack.pack_no, status: 'issued', issuedTo: body.issuedTo,
          expiresAt: pack.expires_at,
        };
      },
      () => ({
        action: 'cssd.pack.issue', entityType: 'cssd_pack', entityId: id, patientId: null,
        detail: { packNo: pack?.pack_no, issuedTo: body.issuedTo, caseId: body.caseId ?? null }, ip: req.ip,
      }),
    );
  });

  app.post('/api/cssd/packs/:id/use', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const pack = await loadPack(db, id);
        if (pack.status !== 'issued') throw conflict('لا يمكن تسجيل الاستخدام قبل الصرف');
        await db.query(`UPDATE cssd_packs SET status = 'used', used_at = now() WHERE id = $1`, [id]);
        return { id, status: 'used' };
      },
      () => ({ action: 'cssd.pack.use', entityType: 'cssd_pack', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  app.post('/api/cssd/packs/:id/return', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.reprocess');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const pack = await loadPack(db, id);
        if (!['used', 'issued'].includes(pack.status)) throw conflict('لا يمكن إعادة حزمة لم تُستخدم');
        await db.query(`UPDATE cssd_packs SET status = 'returned', returned_at = now() WHERE id = $1`, [id]);
        return { id, status: 'returned', nextStep: 'استلام دورة جديدة عبر «استلام حزمة ملوّثة»' };
      },
      () => ({ action: 'cssd.pack.return', entityType: 'cssd_pack', entityId: id, patientId: null, detail: {}, ip: req.ip }),
    );
  });

  app.get('/api/cssd/packs/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'cssd.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const pack = await loadPack(db, id);
      return {
        ...pack,
        status_ar: PACK_STATUS_AR[pack.status] ?? pack.status,
        method_ar: pack.method ? METHOD_AR[pack.method] ?? pack.method : null,
        shelf_life_days: shelfLifeDays(pack.packaging),
        expired: isExpired(pack),
      };
    });
  });
}

export async function infectionRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Board ----
  app.get('/api/infection/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.read');
    return withTenant(auth, async (db) => {
      const isolations = await db.query(
        `SELECT i.*, p.mrn, p.full_name_ar AS patient_name, a.admission_no,
                w.name_ar AS ward_name, r.room_no, b.bed_no, u.full_name_ar AS ordered_by_name
           FROM infection_isolations i
           JOIN patients p ON p.id = i.patient_id
           LEFT JOIN admissions a ON a.id = i.admission_id
           LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id
           LEFT JOIN wards w ON w.id = b.ward_id
           JOIN users u ON u.id = i.ordered_by
          WHERE i.facility_id = $1 AND i.ended_at IS NULL
          ORDER BY CASE i.precaution WHEN 'airborne' THEN 0 WHEN 'protective' THEN 1 WHEN 'droplet' THEN 2 ELSE 3 END,
                   i.started_at`,
        [auth.activeFacilityId],
      );
      const cases = await db.query(
        `SELECT ic.*, p.mrn, p.full_name_ar AS patient_name, a.admission_no,
                u.full_name_ar AS reported_by_name, v.full_name_ar AS reviewed_by_name
           FROM infection_cases ic
           JOIN patients p ON p.id = ic.patient_id
           LEFT JOIN admissions a ON a.id = ic.admission_id
           JOIN users u ON u.id = ic.reported_by
           LEFT JOIN users v ON v.id = ic.reviewed_by
          WHERE ic.facility_id = $1 AND ic.onset_date >= current_date - 90
          ORDER BY ic.onset_date DESC`,
        [auth.activeFacilityId],
      );
      const hygiene = await db.query(
        `SELECT unit,
                sum(opportunities)::int AS opportunities,
                sum(compliant)::int AS compliant,
                round(100.0 * sum(compliant) / NULLIF(sum(opportunities), 0), 1) AS compliance_pct
           FROM hand_hygiene_audits
          WHERE facility_id = $1 AND observed_date >= current_date - 30
          GROUP BY unit ORDER BY compliance_pct NULLS LAST`,
        [auth.activeFacilityId],
      );
      const totals = await db.query<any>(
        `SELECT (SELECT count(*)::int FROM infection_isolations WHERE facility_id = $1 AND ended_at IS NULL) AS active_isolations,
                (SELECT count(*)::int FROM infection_cases WHERE facility_id = $1 AND status = 'suspected') AS suspected_cases,
                (SELECT count(*)::int FROM infection_cases WHERE facility_id = $1 AND status = 'confirmed'
                   AND onset_date >= current_date - 30) AS confirmed_30d,
                (SELECT COALESCE(round(100.0 * sum(compliant) / NULLIF(sum(opportunities), 0), 1), 0)
                   FROM hand_hygiene_audits WHERE facility_id = $1 AND observed_date >= current_date - 30) AS hygiene_compliance_30d`,
        [auth.activeFacilityId],
      );
      return {
        isolations: isolations.rows.map((i: any) => ({ ...i, precaution_ar: PRECAUTION_AR[i.precaution] ?? i.precaution })),
        cases: cases.rows.map((c: any) => ({ ...c, case_type_ar: CASE_TYPE_AR[c.case_type] ?? c.case_type })),
        hygiene: hygiene.rows,
        totals: totals.rows[0],
      };
    });
  });

  // ------------------------------------------------------------- Isolation ---
  app.post('/api/infection/isolations', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.isolate');
    const body = parse(
      z.object({
        patientId: zId,
        admissionId: zId.optional(),
        precaution: z.enum(['contact', 'droplet', 'airborne', 'protective']),
        organism: z.string().max(120).optional(),
        reason: z.string().min(5).max(500),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, body.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'infection_isolation' });
        let admissionId: string | null = null;
        if (body.admissionId) {
          const adm = await db.query(`SELECT id, patient_id, status FROM admissions WHERE id = $1`, [body.admissionId]);
          if (!adm.rows[0]) throw notFound('التنويم غير موجود');
          if (adm.rows[0].patient_id !== body.patientId) throw conflict('التنويم لا يخص هذا المريض');
          admissionId = body.admissionId;
        } else {
          const active = await db.query(
            `SELECT id FROM admissions WHERE patient_id = $1 AND status = 'active' LIMIT 1`,
            [body.patientId],
          );
          admissionId = (active.rows[0]?.id as string | undefined) ?? null;
        }
        const existing = await activeIsolation(db, body.patientId);
        if (existing) {
          throw conflict(`يوجد أمر عزل نشط بالفعل (${PRECAUTION_AR[existing.precaution]})؛ أنهِه قبل تغييره`);
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO infection_isolations (id, facility_id, patient_id, admission_id, precaution, organism, reason, ordered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, auth.activeFacilityId, body.patientId, admissionId, body.precaution, body.organism ?? null,
            body.reason, auth.user.id],
        );
        reply.code(201);
        return { id, precaution: body.precaution, precautionAr: PRECAUTION_AR[body.precaution], startedAt: new Date().toISOString() };
      },
      (r) => ({
        action: 'infection.isolation.start', entityType: 'infection_isolation', entityId: r.id,
        patientId: body.patientId, detail: { precaution: body.precaution, organism: body.organism ?? null }, ip: req.ip,
      }),
    );
  });

  app.post('/api/infection/isolations/:id/end', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.isolate');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const iso = await db.query(`SELECT * FROM infection_isolations WHERE id = $1`, [id]);
        if (!iso.rows[0]) throw notFound('أمر العزل غير موجود');
        if (iso.rows[0].ended_at) throw conflict('أمر العزل منتهٍ مسبقًا');
        await db.query(
          `UPDATE infection_isolations SET ended_at = now(), ended_by = $2, end_reason = $3 WHERE id = $1`,
          [id, auth.user.id, body.reason],
        );
        return { id, ended: true, reason: body.reason };
      },
      () => ({
        action: 'infection.isolation.end', entityType: 'infection_isolation', entityId: id, patientId: null,
        detail: { reason: body.reason }, ip: req.ip,
      }),
    );
  });

  // --------------------------------------------------------- HAI reporting ---
  app.post('/api/infection/cases', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.surveillance');
    const body = parse(
      z.object({
        patientId: zId,
        admissionId: zId.optional(),
        caseType: z.enum(['cauti', 'clabsi', 'vap', 'ssi', 'cdi', 'mrsa', 'other']),
        organism: z.string().max(120).optional(),
        onsetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        deviceDays: z.number().int().min(0).max(365).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, body.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'infection_case' });
        if (new Date(body.onsetDate).getTime() > Date.now() + 86_400_000) throw conflict('تاريخ البدء في المستقبل');
        let admissionId: string | null = null;
        if (body.admissionId) {
          const adm = await db.query(`SELECT patient_id FROM admissions WHERE id = $1`, [body.admissionId]);
          if (!adm.rows[0]) throw notFound('التنويم غير موجود');
          if (adm.rows[0].patient_id !== body.patientId) throw conflict('التنويم لا يخص هذا المريض');
          admissionId = body.admissionId;
        }
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO infection_cases (id, facility_id, patient_id, admission_id, case_type, organism, onset_date,
             device_days, notes, reported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, auth.activeFacilityId, body.patientId, admissionId, body.caseType, body.organism ?? null,
            body.onsetDate, body.deviceDays ?? null, body.notes ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, caseType: body.caseType, status: 'suspected', caseTypeAr: CASE_TYPE_AR[body.caseType] };
      },
      (r) => ({
        action: 'infection.case.report', entityType: 'infection_case', entityId: r.id, patientId: body.patientId,
        detail: { caseType: body.caseType, onsetDate: body.onsetDate }, ip: req.ip,
      }),
    );
  });

  app.post('/api/infection/cases/:id/review', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.confirm');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ decision: z.enum(['confirmed', 'excluded']), note: z.string().min(5).max(500) }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const row = await db.query(`SELECT * FROM infection_cases WHERE id = $1`, [id]);
        if (!row.rows[0]) throw notFound('حالة العدوى غير موجودة');
        if (row.rows[0].status !== 'suspected') throw conflict('الحالة تمت مراجعتها مسبقًا');
        if (row.rows[0].reported_by === auth.user.id) {
          throw conflict('مُبلّغ الحالة لا يعتمدها؛ يلزم مراجع آخر (فصل مهام)');
        }
        await db.query(
          `UPDATE infection_cases SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
          [id, body.decision, auth.user.id, body.note],
        );
        return { id, status: body.decision, note: body.note };
      },
      () => ({
        action: 'infection.case.review', entityType: 'infection_case', entityId: id, patientId: null,
        detail: { decision: body.decision }, ip: req.ip,
      }),
    );
  });

  // ---------------------------------------------------------- Hand hygiene ---
  app.post('/api/infection/hand-hygiene', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'infection.audit');
    const body = parse(
      z.object({
        unit: z.string().min(2).max(80),
        moment: z.enum(['before_patient', 'before_aseptic', 'after_body_fluid', 'after_patient', 'after_surroundings']),
        opportunities: z.number().int().min(1).max(100),
        compliant: z.number().int().min(0).max(100),
        observedRole: z.enum(['physician', 'nurse', 'tech', 'other']),
        notes: z.string().max(500).optional(),
      }),
      req.body,
    );
    if (body.compliant > body.opportunities) throw conflict('عدد الفرص الملتزم بها أكبر من إجمالي الفرص');
    return withTenantAudited(
      auth,
      async (db) => {
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO hand_hygiene_audits (id, facility_id, unit, moment, opportunities, compliant, observed_role,
             observer_id, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, auth.activeFacilityId, body.unit, body.moment, body.opportunities, body.compliant,
            body.observedRole, auth.user.id, body.notes ?? null],
        );
        reply.code(201);
        return {
          id,
          compliancePct: Math.round((100 * body.compliant) / body.opportunities),
          momentAr: MOMENT_AR[body.moment],
        };
      },
      (r) => ({
        action: 'infection.hand_hygiene', entityType: 'hand_hygiene_audit', entityId: r.id, patientId: null,
        detail: { unit: body.unit, moment: body.moment, opportunities: body.opportunities, compliant: body.compliant }, ip: req.ip,
      }),
    );
  });
}
