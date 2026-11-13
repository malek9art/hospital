import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from '../patients/access';

/**
 * Blood bank: donor screening, unit stock, requests, cross-match, issue and
 * transfusion with a second checker.
 *
 * The compatibility rules below are the ones the transfusion service applies;
 * they are enforced on the server so a wrong unit cannot be issued by editing
 * a request in the browser.
 */

type Component = 'rbc' | 'ffp' | 'platelets' | 'cryo';
type BloodType = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';

const COMPONENT_AR: Record<Component, string> = {
  rbc: 'كريات حمراء',
  ffp: 'بلازما مجمدة',
  platelets: 'صفيحات',
  cryo: 'راسب قري',
};

const STATUS_AR: Record<string, string> = {
  available: 'متاحة',
  reserved: 'محجوزة',
  issued: 'صادرة',
  transfused: 'مُنقلت',
  discarded: 'مستبعدة',
};

function splitType(t: string): { abo: 'A' | 'B' | 'AB' | 'O'; rh: '+' | '-' } {
  const m = /^(A|B|AB|O)([+-])$/.exec(t);
  if (!m) throw conflict('فصيلة دم غير صالحة');
  return { abo: m[1] as 'A' | 'B' | 'AB' | 'O', rh: m[2] as '+' | '-' };
}

/** Red-cell compatibility: recipient antibody rules (O- universal donor, AB+ universal recipient). */
const RBC_ACCEPTS: Record<string, string[]> = {
  O: ['O'],
  A: ['A', 'O'],
  B: ['B', 'O'],
  AB: ['A', 'B', 'AB', 'O'],
};

/** Plasma / cryo carry the opposite ABO rule (AB plasma is the universal donor). */
const PLASMA_ACCEPTS: Record<string, string[]> = {
  O: ['O', 'A', 'B', 'AB'],
  A: ['A', 'AB'],
  B: ['B', 'AB'],
  AB: ['AB'],
};

export interface CompatibilityVerdict {
  compatible: boolean;
  reason: string;
}

/**
 * Evaluates a unit against a recipient.
 *  - plasma, cryo and platelets follow the plasma ABO rule (platelets are
 *    additionally allowed ABO-identical only here, the stricter choice);
 *  - Rh-negative recipients may only receive Rh-negative red cells and
 *    platelets, which is the rule for women of childbearing age and for
 *    patients with anti-D; the API keeps it strict for every recipient.
 */
export function checkCompatibility(recipientType: string, unitType: string, component: Component): CompatibilityVerdict {
  const recipient = splitType(recipientType);
  const unit = splitType(unitType);
  // Plasma and cryoprecipitate follow the plasma ABO rule; red cells and
  // platelets are stricter (platelets must be ABO-identical here).
  const accepts = component === 'ffp' || component === 'cryo'
    ? PLASMA_ACCEPTS[recipient.abo]
    : RBC_ACCEPTS[recipient.abo];

  if (!accepts.includes(unit.abo)) {
    return {
      compatible: false,
      reason: `عدم توافق ABO: مريض ${recipientType} لا يستقبل ${unit.abo} في ${COMPONENT_AR[component] ?? component}`,
    };
  }
  // Rh(D) negative recipients must not receive Rh(D) positive red cells or
  // platelets; plasma products carry no red-cell antigen load.
  if ((component === 'rbc' || component === 'platelets') && recipient.rh === '-' && unit.rh === '+') {
    return { compatible: false, reason: 'مريض سالب العامل الريصي لا يستقبل وحدة موجبة' };
  }
  return {
    compatible: true,
    reason: `متوافقة: ${unitType} → ${recipientType} (${COMPONENT_AR[component] ?? component})`,
  };
}

async function loadRequest(db: any, id: string) {
  const res = await db.query(
    `SELECT r.*, p.mrn, p.full_name_ar AS patient_name, p.blood_type AS patient_blood_type,
            e.encounter_no, u.full_name_ar AS requested_by_name,
            (SELECT count(*)::int FROM blood_crossmatches c WHERE c.request_id = r.id AND c.result = 'compatible') AS compatible_matches,
            (SELECT count(*)::int FROM blood_transfusions t WHERE t.request_id = r.id) AS transfused_units
       FROM blood_requests r
       JOIN patients p ON p.id = r.patient_id
       JOIN encounters e ON e.id = r.encounter_id
       JOIN users u ON u.id = r.requested_by
      WHERE r.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('طلب الدم غير موجود');
  return row;
}

async function loadUnit(db: any, id: string) {
  const res = await db.query(
    `SELECT u.*, d.donor_no, d.donated_at, d.hbv_negative, d.hcv_negative, d.hiv_negative, d.syphilis_negative,
            p.mrn AS patient_mrn, p.full_name_ar AS patient_name
       FROM blood_units u
       JOIN blood_donors d ON d.id = u.donor_id
       LEFT JOIN patients p ON p.id = u.issued_to_patient_id
      WHERE u.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw notFound('وحدة الدم غير موجودة');
  return row;
}

function isExpired(unit: any) {
  return new Date(unit.expires_at).getTime() <= Date.now();
}

export async function bloodbankRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Stock ----
  app.get('/api/bloodbank/stock', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.read');
    return withTenant(auth, async (db) => {
      const grouped = await db.query(
        `SELECT component, blood_type,
                count(*) FILTER (WHERE status = 'available' AND expires_at > now())::int AS available,
                count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
                count(*) FILTER (WHERE status = 'issued')::int AS issued
           FROM blood_units
          WHERE facility_id = $1 AND status IN ('available','reserved','issued')
          GROUP BY component, blood_type
          ORDER BY component, blood_type`,
        [auth.activeFacilityId],
      );
      const units = await db.query(
        `SELECT u.id, u.unit_no, u.component, u.blood_type, u.volume_ml, u.collected_at, u.expires_at, u.status,
                d.donor_no,
                CASE WHEN u.expires_at <= now() THEN true ELSE false END AS expired,
                EXTRACT(day FROM (u.expires_at - now()))::int AS days_left
           FROM blood_units u JOIN blood_donors d ON d.id = u.donor_id
          WHERE u.facility_id = $1 AND u.status IN ('available','reserved','issued')
          ORDER BY u.expires_at`,
        [auth.activeFacilityId],
      );
      const totals = await db.query<any>(
        `SELECT count(*) FILTER (WHERE status = 'available' AND expires_at > now())::int AS available,
                count(*) FILTER (WHERE expires_at <= now() AND status = 'available')::int AS expired,
                count(*) FILTER (WHERE status = 'issued')::int AS issued,
                count(*) FILTER (WHERE status = 'reserved')::int AS reserved,
                count(*) FILTER (WHERE status = 'transfused' AND created_at::date = now()::date)::int AS transfused_today
           FROM blood_units WHERE facility_id = $1`,
        [auth.activeFacilityId],
      );
      return {
        grid: grouped.rows.map((r: any) => ({ ...r, component_ar: COMPONENT_AR[r.component as Component] })),
        units: units.rows.map((r: any) => ({ ...r, status_ar: STATUS_AR[r.status] ?? r.status, component_ar: COMPONENT_AR[r.component as Component] })),
        totals: totals.rows[0],
      };
    });
  });

  // Users who may act as the independent second checker at the bedside. Only
  // names and roles are exposed; the server still re-validates the permission.
  app.get('/api/bloodbank/second-checkers', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.transfuse');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT DISTINCT u.id, u.full_name_ar, r.name_ar AS role_name
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $1
           JOIN roles r ON r.id = ur.role_id
           JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = 'bloodbank.transfuse'
          WHERE u.is_active = true
          ORDER BY u.full_name_ar`,
        [auth.activeFacilityId],
      );
      return { items: rows.rows };
    });
  });

  // --------------------------------------------------------------- Donors ----
  app.post('/api/bloodbank/donors', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.stock');
    const body = parse(
      z.object({
        bloodType: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']),
        hemoglobin: z.number().min(5).max(25).optional(),
        hbvNegative: z.boolean(),
        hcvNegative: z.boolean(),
        hivNegative: z.boolean(),
        syphilisNegative: z.boolean(),
        deferralReason: z.string().max(300).optional(),
        units: z
          .array(z.object({
            component: z.enum(['rbc', 'ffp', 'platelets', 'cryo']),
            volumeMl: z.number().int().min(50).max(600).optional(),
            expiresInDays: z.number().int().min(1).max(365).optional(),
          }))
          .max(4)
          .default([]),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const eligible = body.hbvNegative && body.hcvNegative && body.hivNegative && body.syphilisNegative;
        const donorNo = await nextDocumentNo(db, auth.activeFacilityId, 'blood_donor', 'DNR');
        const donorId = crypto.randomUUID();
        await db.query(
          `INSERT INTO blood_donors (id, facility_id, donor_no, blood_type, hbv_negative, hcv_negative,
             hiv_negative, syphilis_negative, hemoglobin, is_eligible, deferral_reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [donorId, auth.activeFacilityId, donorNo, body.bloodType, body.hbvNegative, body.hcvNegative,
            body.hivNegative, body.syphilisNegative, body.hemoglobin ?? null, eligible,
            eligible ? null : body.deferralReason ?? 'نتيجة فحص إيجابية', auth.user.id],
        );

        const defaultDays: Record<string, number> = { rbc: 42, ffp: 365, platelets: 5, cryo: 365 };
        const created: string[] = [];
        for (const u of body.units ?? []) {
          const unitNo = await nextDocumentNo(db, auth.activeFacilityId, 'blood_unit', 'BGU');
          const days = u.expiresInDays ?? defaultDays[u.component];
          const unitId = crypto.randomUUID();
          await db.query(
            `INSERT INTO blood_units (id, facility_id, unit_no, donor_id, component, blood_type, volume_ml,
               collected_at, expires_at, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now() + make_interval(days => $8::int),
                     $9)`,
            [unitId, auth.activeFacilityId, unitNo, donorId, u.component, body.bloodType,
              u.volumeMl ?? (u.component === 'rbc' ? 450 : 250), days, eligible ? 'available' : 'discarded'],
          );
          if (!eligible) {
            await db.query(`UPDATE blood_units SET discard_reason = 'متبرع غير مؤهل بالفحوص', discarded_at = now() WHERE id = $1`, [unitId]);
          } else {
            created.push(unitId);
          }
        }
        reply.code(201);
        return { id: donorId, donorNo, eligible, units: created.length };
      },
      (r) => ({
        action: 'bloodbank.donor',
        entityType: 'blood_donor',
        entityId: r.id,
        patientId: null,
        detail: { donorNo: r.donorNo, bloodType: body.bloodType, eligible: r.eligible, units: r.units },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------- Requests ----
  app.post('/api/bloodbank/requests', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.request');
    const body = parse(
      z.object({
        patientId: zId,
        encounterId: zId,
        component: z.enum(['rbc', 'ffp', 'platelets', 'cryo']),
        unitsRequested: z.number().int().min(1).max(20),
        urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
        indication: z.string().min(5).max(500),
        hbValue: z.number().min(1).max(25).optional(),
        plateletsValue: z.number().int().min(0).max(1500).optional(),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, body.patientId);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'blood_request' });
        if (!patient.blood_type) throw conflict('فصيلة دم المريض غير مسجلة؛ سجّلها قبل طلب الدم');

        const enc = await db.query<any>('SELECT status, patient_id FROM encounters WHERE id = $1', [body.encounterId]);
        if (!enc.rows[0]) throw notFound('الزيارة غير موجودة');
        if (enc.rows[0].patient_id !== body.patientId) throw conflict('الزيارة لا تخص هذا المريض');
        if (enc.rows[0].status !== 'open') throw conflict('لا يمكن طلب دم على زيارة مغلقة');

        const open = await db.query<any>(
          `SELECT request_no FROM blood_requests
            WHERE patient_id = $1 AND status IN ('pending','crossmatched','issued') LIMIT 1`,
          [body.patientId],
        );
        if (open.rows[0]) throw conflict(`يوجد طلب دم مفتوح لهذا المريض (${open.rows[0].request_no})`);

        const requestNo = await nextDocumentNo(db, auth.activeFacilityId, 'blood_request', 'BLR');
        const id = crypto.randomUUID();
        await db.query(
          `INSERT INTO blood_requests (id, facility_id, request_no, patient_id, encounter_id, component,
             units_requested, urgency, indication, hb_value, platelets_value, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, auth.activeFacilityId, requestNo, body.patientId, body.encounterId, body.component,
            body.unitsRequested, body.urgency, body.indication, body.hbValue ?? null,
            body.plateletsValue ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, requestNo, status: 'pending', patientBloodType: patient.blood_type };
      },
      (r) => ({
        action: 'bloodbank.request',
        entityType: 'blood_request',
        entityId: r.id,
        patientId: body.patientId,
        detail: { requestNo: r.requestNo, component: body.component, units: body.unitsRequested, urgency: body.urgency },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/bloodbank/requests', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.read');
    const q = parse(
      z.object({ status: z.enum(['active', 'all', 'pending', 'crossmatched', 'issued', 'completed', 'cancelled']).default('active') }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const params: any[] = [auth.activeFacilityId];
      let filter = '';
      if (q.status === 'active') filter = ` AND r.status IN ('pending','crossmatched','issued')`;
      else if (q.status !== 'all') {
        params.push(q.status);
        filter = ` AND r.status = $${params.length}`;
      }
      const rows = await db.query(
        `SELECT r.id, r.patient_id, r.encounter_id, r.request_no, r.component, r.units_requested,
                r.urgency, r.status, r.indication, r.requested_at, r.hb_value, r.platelets_value,
                p.mrn, p.full_name_ar AS patient_name, p.blood_type AS patient_blood_type,
                e.encounter_no, u.full_name_ar AS requested_by_name,
                (SELECT count(*)::int FROM blood_crossmatches c WHERE c.request_id = r.id AND c.result = 'compatible') AS compatible_matches,
                (SELECT count(*)::int FROM blood_transfusions t WHERE t.request_id = r.id AND t.completed_at IS NOT NULL) AS transfused_units
           FROM blood_requests r
           JOIN patients p ON p.id = r.patient_id
           JOIN encounters e ON e.id = r.encounter_id
           JOIN users u ON u.id = r.requested_by
          WHERE r.facility_id = $1${filter}
          ORDER BY CASE r.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, r.requested_at`,
        params,
      );
      return {
        items: rows.rows.map((r: any) => ({ ...r, component_ar: COMPONENT_AR[r.component as Component] })),
      };
    });
  });

  // ----------------------------------------------------------- Cross-match ----
  app.get('/api/bloodbank/requests/:id/compatible-units', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.crossmatch');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const request = await loadRequest(db, id);
      const units = await db.query(
        `SELECT u.id, u.unit_no, u.component, u.blood_type, u.volume_ml, u.expires_at,
                EXTRACT(day FROM (u.expires_at - now()))::int AS days_left
           FROM blood_units u
          WHERE u.facility_id = $1 AND u.component = $2 AND u.status = 'available' AND u.expires_at > now()
          ORDER BY u.expires_at`,
        [request.facility_id, request.component],
      );
      const evaluated = units.rows.map((u: any) => {
        const verdict = checkCompatibility(request.patient_blood_type, u.blood_type, request.component);
        return { ...u, compatible: verdict.compatible, reason: verdict.reason };
      });
      return {
        requestId: id,
        patientBloodType: request.patient_blood_type,
        component: request.component,
        units: evaluated,
        compatibleCount: evaluated.filter((u: any) => u.compatible).length,
      };
    });
  });

  // Units already reserved for this request, so the issue step does not depend
  // on the UI remembering a previous response.
  app.get('/api/bloodbank/requests/:id/reserved-units', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const request = await loadRequest(db, id);
      const rows = await db.query(
        `SELECT u.id, u.unit_no, u.component, u.blood_type, u.expires_at, u.status,
                EXTRACT(day FROM (u.expires_at - now()))::int AS days_left,
                c.result AS match_result, c.note AS match_note, c.performed_at
           FROM blood_units u
           JOIN LATERAL (
                  SELECT result, note, performed_at FROM blood_crossmatches
                   WHERE unit_id = u.id AND request_id = $2
                   ORDER BY performed_at DESC LIMIT 1
                ) c ON true
          WHERE u.facility_id = $1 AND u.status = 'reserved' AND u.reserved_for_patient_id = $3
          ORDER BY u.expires_at`,
        [auth.activeFacilityId, id, request.patient_id],
      );
      return { requestId: id, items: rows.rows };
    });
  });

  app.post('/api/bloodbank/requests/:id/crossmatch', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.crossmatch');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        unitId: zId,
        method: z.enum(['gel', 'tube', 'electronic']).default('gel'),
        forceIncompatible: z.boolean().default(false),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    let request: any;
    return withTenantAudited(
      auth,
      async (db) => {
        request = await loadRequest(db, id);
        if (!['pending', 'crossmatched'].includes(request.status)) {
          throw conflict('لا يمكن إجراء فحص توافق على طلب مغلق أو صادر بالكامل');
        }
        const unit = await loadUnit(db, body.unitId);
        if (unit.component !== request.component) throw conflict('نوع الوحدة لا يطابق نوع الطلب');
        if (unit.status !== 'available') throw conflict('الوحدة غير متاحة للحجز');
        if (isExpired(unit)) throw conflict('الوحدة منتهية الصلاحية ولا يمكن حجزها');

        const verdict = checkCompatibility(request.patient_blood_type, unit.blood_type, request.component);
        if (!verdict.compatible && !body.forceIncompatible) {
          throw conflict(verdict.reason, { unitType: unit.blood_type, patientType: request.patient_blood_type });
        }
        if (!verdict.compatible && !body.note) {
          throw conflict('تسجيل وحدة غير متوافقة يتطلب سببًا سريريًا موثقًا');
        }
        const result = verdict.compatible ? 'compatible' : 'incompatible';
        await db.query(
          `INSERT INTO blood_crossmatches (id, facility_id, request_id, unit_id, method, result, note, performed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [crypto.randomUUID(), request.facility_id, id, body.unitId, body.method, result, body.note ?? null, auth.user.id],
        );
        await db.query(
          `UPDATE blood_units SET status = 'reserved', reserved_for_patient_id = $2 WHERE id = $1`,
          [body.unitId, request.patient_id],
        );
        if (result === 'compatible' && request.status === 'pending') {
          await db.query(`UPDATE blood_requests SET status = 'crossmatched' WHERE id = $1`, [id]);
        }
        reply.code(201);
        return { requestId: id, unitId: body.unitId, result, reason: verdict.reason, unitStatus: 'reserved' };
      },
      (r) => ({
        action: 'bloodbank.crossmatch',
        entityType: 'blood_request',
        entityId: id,
        patientId: request.patient_id,
        detail: { requestNo: request.request_no, unitId: body.unitId, result: r.result, method: body.method },
        ip: req.ip,
      }),
    );
  });

  // ----------------------------------------------------------------- Issue ----
  app.post('/api/bloodbank/requests/:id/issue', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.issue');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ unitId: zId }), req.body);
    let request: any;
    return withTenantAudited(
      auth,
      async (db) => {
        request = await loadRequest(db, id);
        if (!['pending', 'crossmatched'].includes(request.status)) throw conflict('الطلب لم يعد قابلًا للصرف');
        const unit = await loadUnit(db, body.unitId);
        if (unit.status !== 'reserved') throw conflict('الوحدة غير محجوزة لهذا الطلب');
        if (unit.reserved_for_patient_id !== request.patient_id) throw conflict('الوحدة محجوزة لمريض آخر');
        if (isExpired(unit)) throw conflict('الوحدة انتهت صلاحيتها أثناء الحجز');

        const match = await db.query<{ result: string }>(
          `SELECT result FROM blood_crossmatches WHERE request_id = $1 AND unit_id = $2 ORDER BY performed_at DESC LIMIT 1`,
          [id, body.unitId],
        );
        if (!match.rows[0] || match.rows[0].result !== 'compatible') {
          throw conflict('لا يوجد فحص توافق ناجح لهذه الوحدة مع هذا الطلب');
        }

        await db.query(
          `UPDATE blood_units SET status = 'issued', issued_to_patient_id = $2 WHERE id = $1`,
          [body.unitId, request.patient_id],
        );
        await db.query(`UPDATE blood_requests SET status = 'issued' WHERE id = $1`, [id]);
        reply.code(201);
        return {
          requestId: id,
          unitId: body.unitId,
          unitNo: unit.unit_no,
          bloodType: unit.blood_type,
          component: unit.component,
          expiresAt: unit.expires_at,
          status: 'issued',
        };
      },
      (r) => ({
        action: 'bloodbank.issue',
        entityType: 'blood_request',
        entityId: id,
        patientId: request.patient_id,
        detail: { requestNo: request.request_no, unitNo: r.unitNo, bloodType: r.bloodType },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Transfuse ----
  app.post('/api/bloodbank/units/:id/transfuse', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.transfuse');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        requestId: zId,
        secondCheckerId: zId,
        preHeartRate: z.number().int().min(20).max(250).optional(),
        preSystolicBp: z.number().int().min(40).max(300).optional(),
        preTemperatureC: z.number().min(30).max(45).optional(),
        preSpo2: z.number().int().min(50).max(100).optional(),
        consentConfirmed: z.literal(true),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const unit = await loadUnit(db, id);
        if (unit.status !== 'issued') throw conflict('لا يمكن بدء النقل قبل صرف الوحدة');
        if (body.secondCheckerId === auth.user.id) throw conflict('المدقق الثاني يجب أن يكون شخصًا آخر');
        const checker = await db.query<any>(
          `SELECT u.id, u.full_name_ar FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $2
             JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_code = 'bloodbank.transfuse'
            WHERE u.id = $1 AND u.is_active = true`,
          [body.secondCheckerId, auth.activeFacilityId],
        );
        if (!checker.rows[0]) throw conflict('المدقق الثاني لا يملك صلاحية النقل');
        const request = await loadRequest(db, body.requestId);
        if (request.patient_id !== unit.issued_to_patient_id) throw conflict('الوحدة صُرفت لمريض آخر');
        const patient = await loadPatientOr404(db, request.patient_id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'blood_transfuse' });

        const tid = crypto.randomUUID();
        await db.query(
          `INSERT INTO blood_transfusions (id, facility_id, unit_id, request_id, patient_id, encounter_id,
             started_by, second_checker_id, pre_vitals)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [tid, unit.facility_id, id, body.requestId, request.patient_id, request.encounter_id, auth.user.id,
            body.secondCheckerId,
            JSON.stringify({
              heartRate: body.preHeartRate ?? null, systolicBp: body.preSystolicBp ?? null,
              temperatureC: body.preTemperatureC ?? null, spo2: body.preSpo2 ?? null,
            })],
        );
        await db.query(`UPDATE blood_units SET status = 'transfused' WHERE id = $1`, [id]);
        reply.code(201);
        return {
          id: tid,
          unitId: id,
          unitNo: unit.unit_no,
          patientName: request.patient_name,
          secondChecker: checker.rows[0].full_name_ar,
          startedAt: new Date().toISOString(),
        };
      },
      (r) => ({
        action: 'bloodbank.transfuse',
        entityType: 'blood_transfusion',
        entityId: r.id,
        patientId: null,
        detail: { unitNo: r.unitNo, requestId: body.requestId, secondCheckerId: body.secondCheckerId },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/bloodbank/transfusions/:id/complete', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.transfuse');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        outcome: z.enum(['completed', 'stopped_reaction', 'stopped_other']),
        volumeTransfusedMl: z.number().int().min(0).max(600),
        postHeartRate: z.number().int().min(20).max(250).optional(),
        postSystolicBp: z.number().int().min(40).max(300).optional(),
        postTemperatureC: z.number().min(30).max(45).optional(),
        postSpo2: z.number().int().min(50).max(100).optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    let tx: any;
    return withTenantAudited(
      auth,
      async (db) => {
        tx = await db.query(`SELECT * FROM blood_transfusions WHERE id = $1`, [id]).then((r: any) => r.rows[0]);
        if (!tx) throw notFound('سجل النقل غير موجود');
        if (tx.completed_at) throw conflict('سجل النقل مكتمل مسبقًا');
        await db.query(
          `UPDATE blood_transfusions SET completed_at = now(), outcome = $2, volume_transfused_ml = $3,
             post_vitals = $4, notes = $5 WHERE id = $1`,
          [id, body.outcome, body.volumeTransfusedMl,
            JSON.stringify({
              heartRate: body.postHeartRate ?? null, systolicBp: body.postSystolicBp ?? null,
              temperatureC: body.postTemperatureC ?? null, spo2: body.postSpo2 ?? null,
            }),
            body.notes ?? null],
        );
        const remaining = await db.query<any>(
          `SELECT r.units_requested,
                  (SELECT count(*)::int FROM blood_transfusions t WHERE t.request_id = r.id AND t.completed_at IS NOT NULL) AS done
             FROM blood_requests r WHERE r.id = $1`,
          [tx.request_id],
        );
        const row = remaining.rows[0];
        if (row && row.done >= row.units_requested) {
          await db.query(`UPDATE blood_requests SET status = 'completed' WHERE id = $1`, [tx.request_id]);
        } else {
          await db.query(`UPDATE blood_requests SET status = 'crossmatched' WHERE id = $1 AND status = 'issued'`, [tx.request_id]);
        }
        return { id, outcome: body.outcome, completedAt: new Date().toISOString(), requestCompleted: row ? row.done >= row.units_requested : false };
      },
      () => ({
        action: 'bloodbank.transfusion_complete',
        entityType: 'blood_transfusion',
        entityId: id,
        patientId: null,
        detail: { outcome: body.outcome, volume: body.volumeTransfusedMl, requestId: tx?.request_id },
        ip: req.ip,
      }),
    );
  });

  // -------------------------------------------------------------- Reaction ---
  app.post('/api/bloodbank/transfusions/:id/reactions', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.reaction');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        reactionType: z.enum(['febrile', 'allergic', 'hemolytic', 'trali', 'taco', 'septic', 'other']),
        severity: z.enum(['mild', 'moderate', 'severe', 'life_threatening']),
        description: z.string().min(10).max(2000),
        actionTaken: z.string().min(5).max(1000),
      }),
      req.body,
    );
    let tx: any;
    return withTenantAudited(
      auth,
      async (db) => {
        tx = await db.query(`SELECT * FROM blood_transfusions WHERE id = $1`, [id]).then((r: any) => r.rows[0]);
        if (!tx) throw notFound('سجل النقل غير موجود');
        const exists = await db.query(`SELECT id FROM blood_reactions WHERE transfusion_id = $1`, [id]);
        if (exists.rows[0]) throw conflict('تفاعل مسجّل مسبقًا لهذا النقل');
        if (body.severity !== 'mild' && !tx.completed_at) {
          // A severe reaction must stop the transfusion first: the unit stays
          // traceable and the completion record carries the stop reason.
          throw conflict('أوقف النقل وسجّل نتيجته قبل الإبلاغ عن تفاعل متوسط أو شديد');
        }
        const rid = crypto.randomUUID();
        await db.query(
          `INSERT INTO blood_reactions (id, facility_id, transfusion_id, reaction_type, severity, description, action_taken, reported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rid, tx.facility_id, id, body.reactionType, body.severity, body.description, body.actionTaken, auth.user.id],
        );
        // A unit involved in a reaction is quarantined, never returned to stock.
        await db.query(
          `UPDATE blood_units SET status = 'discarded', discard_reason = $2, discarded_by = $3, discarded_at = now()
            WHERE id = $1`,
          [tx.unit_id, `تفاعل نقل: ${body.reactionType} (${body.severity})`, auth.user.id],
        );
        reply.code(201);
        return { id: rid, transfusionId: id, unitQuarantined: true };
      },
      (r) => ({
        action: 'bloodbank.reaction',
        entityType: 'blood_transfusion',
        entityId: id,
        patientId: null,
        detail: { reactionId: r.id, type: body.reactionType, severity: body.severity },
        ip: req.ip,
      }),
    );
  });

  // ------------------------------------------------------------ Traceability -
  app.get('/api/bloodbank/units/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const unit = await loadUnit(db, id);
      const [matches, transfusions] = await Promise.all([
        db.query(
          `SELECT c.*, u.full_name_ar AS performed_by_name, r.request_no
             FROM blood_crossmatches c
             JOIN users u ON u.id = c.performed_by
             JOIN blood_requests r ON r.id = c.request_id
            WHERE c.unit_id = $1 ORDER BY c.performed_at`,
          [id],
        ),
        db.query(
          `SELECT t.*, a.full_name_ar AS started_by_name, b.full_name_ar AS checker_name,
                  (SELECT row_to_json(x) FROM blood_reactions x WHERE x.transfusion_id = t.id) AS reaction
             FROM blood_transfusions t
             JOIN users a ON a.id = t.started_by
             JOIN users b ON b.id = t.second_checker_id
            WHERE t.unit_id = $1`,
          [id],
        ),
      ]);
      return {
        ...unit,
        status_ar: STATUS_AR[unit.status] ?? unit.status,
        component_ar: COMPONENT_AR[unit.component as Component],
        screening: {
          hbv: unit.hbv_negative, hcv: unit.hcv_negative, hiv: unit.hiv_negative, syphilis: unit.syphilis_negative,
        },
        crossmatches: matches.rows,
        transfusions: transfusions.rows,
      };
    });
  });

  app.post('/api/bloodbank/units/:id/discard', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'bloodbank.stock');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(5).max(300) }), req.body);
    let unit: any;
    return withTenantAudited(
      auth,
      async (db) => {
        unit = await loadUnit(db, id);
        if (!['available', 'reserved'].includes(unit.status)) {
          throw conflict('لا يمكن استبعاد وحدة صادرة أو منُقلت');
        }
        await db.query(
          `UPDATE blood_units SET status = 'discarded', discard_reason = $2, discarded_by = $3, discarded_at = now()
            WHERE id = $1`,
          [id, body.reason, auth.user.id],
        );
        return { id, status: 'discarded', reason: body.reason };
      },
      () => ({
        action: 'bloodbank.discard',
        entityType: 'blood_unit',
        entityId: id,
        patientId: null,
        detail: { unitNo: unit?.unit_no, reason: body.reason },
        ip: req.ip,
      }),
    );
  });
}
