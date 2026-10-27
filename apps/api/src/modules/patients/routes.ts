import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, PageQuery, zId } from '../../lib/validation';
import { requireAuth, requirePermission, activeFacility, hasPermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { blindIndex, decryptField, encryptField, maskId, maskPhone, normalize } from '../../lib/crypto';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { authorizeChartAccess, loadPatientOr404 } from './access';
import { writeAudit } from '../../lib/audit';

const PatientInput = z.object({
  fullNameAr: z.string().trim().min(3, 'الاسم مطلوب').max(200),
  fullNameEn: z.string().trim().max(200).optional().nullable(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sex: z.enum(['male', 'female', 'other']),
  nationalId: z.string().trim().regex(/^[0-9]{10}$/, 'الهوية يجب أن تكون 10 أرقام').optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().email().max(200).optional().nullable().or(z.literal('')),
  nationality: z.string().max(60).optional().nullable(),
  maritalStatus: z.enum(['single', 'married', 'divorced', 'widowed']).optional().nullable(),
  bloodType: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  nextOfKinName: z.string().max(120).optional().nullable(),
  nextOfKinPhone: z.string().max(20).optional().nullable(),
  acknowledgeDuplicate: z.boolean().optional(),
});

function dto(row: any, reveal: boolean) {
  const nid = reveal ? decryptField(row.national_id_enc, `patients.national_id_enc:${row.id}`) : null;
  const phone = reveal ? decryptField(row.phone_enc, `patients.phone_enc:${row.id}`) : null;
  return {
    id: row.id,
    mrn: row.mrn,
    fullNameAr: row.full_name_ar,
    fullNameEn: row.full_name_en,
    dateOfBirth: row.date_of_birth,
    sex: row.sex,
    nationalIdMasked: maskId(nid ?? (row.national_id_enc ? '****' : null)),
    phoneMasked: maskPhone(phone ?? (row.phone_enc ? '****' : null)),
    nationalId: reveal ? nid : undefined,
    phone: reveal ? phone : undefined,
    email: row.email,
    nationality: row.nationality,
    bloodType: row.blood_type,
    status: row.status,
    duplicateOfId: row.duplicate_of_id,
    createdAt: row.created_at,
    version: row.version,
  };
}

export async function patientRoutes(app: FastifyInstance) {
  app.get('/api/patients', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.read');
    const q = parse(
      PageQuery.extend({
        search: z.string().max(120).optional(),
        includeMerged: z.coerce.boolean().default(false),
      }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const conditions = ['facility_id = $1'];
      const params: unknown[] = [auth.activeFacilityId];
      if (!q.includeMerged) conditions.push(`status <> 'merged'`);
      if (q.search && q.search.trim()) {
        params.push(`%${normalize(q.search)}%`);
        conditions.push(
          `(regexp_replace(lower(full_name_ar), '\\s+', ' ', 'g') LIKE $${params.length} OR mrn ILIKE $${params.length})`,
        );
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const total = await db.query<{ count: string }>(`SELECT count(*) FROM patients ${where}`, params);
      const rows = await db.query(
        `SELECT * FROM patients ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit ?? 25, ((q.page ?? 1) - 1) * (q.limit ?? 25)],
      );
      await writeAudit(db, {
        facilityId: auth.activeFacilityId,
        actorUserId: auth.user.id,
        actorRole: auth.roles[0]?.role_id ?? null,
        action: 'patient.list',
        entityType: 'patient',
        detail: { search: q.search ?? null, page: (q.page ?? 1), count: rows.rows.length },
        ip: req.ip,
      });
      return {
        items: rows.rows.map((r) => dto(r, false)),
        total: Number(total.rows[0]?.count ?? 0),
        page: (q.page ?? 1),
        limit: (q.limit ?? 25),
      };
    });
  });

  app.post('/api/patients', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.create');
    const body = parse(PatientInput, req.body);
    const facility = activeFacility(auth);

    return withTenantAudited(
      auth,
      async (db) => {
        const nidHash = body.nationalId ? blindIndex(body.nationalId) : null;
        if (nidHash) {
          const dup = await db.query(
            `SELECT id, mrn, full_name_ar, date_of_birth FROM patients
              WHERE national_id_hash = $1 AND status <> 'merged'`,
            [nidHash],
          );
          if (dup.rows[0]) {
            throw conflict('يوجد مريض مسجل بنفس رقم الهوية', {
              candidates: dup.rows.map((c: any) => ({ id: c.id, mrn: c.mrn, fullNameAr: c.full_name_ar })),
              field: 'nationalId',
            });
          }
        }
        const fuzzy = await db.query(
          `SELECT id, mrn, full_name_ar, date_of_birth FROM patients
            WHERE facility_id = $1 AND date_of_birth = $2 AND status <> 'merged'
              AND regexp_replace(lower(full_name_ar), '\\s+', ' ', 'g') = $3
            LIMIT 5`,
          [facility.id, body.dateOfBirth, normalize(body.fullNameAr)],
        );
        if (fuzzy.rows.length > 0 && !body.acknowledgeDuplicate) {
          throw conflict('يوجد مريض محتمل بنفس الاسم وتاريخ الميلاد. راجع السجلات قبل المتابعة.', {
            candidates: fuzzy.rows.map((c: any) => ({ id: c.id, mrn: c.mrn, fullNameAr: c.full_name_ar, dateOfBirth: c.date_of_birth })),
            requiresAcknowledgement: true,
          });
        }

        const id = crypto.randomUUID();
        const mrn = await nextDocumentNo(db, facility.id, 'mrn', 'MRN');
        await db.query(
          `INSERT INTO patients (id, facility_id, mrn, national_id_enc, national_id_hash, full_name_ar, full_name_en,
             date_of_birth, sex, phone_enc, email, address_enc, nationality, marital_status, blood_type,
             next_of_kin_name, next_of_kin_phone_enc, created_by, duplicate_of_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            id,
            facility.id,
            mrn,
            body.nationalId ? encryptField(body.nationalId, `patients.national_id_enc:${id}`) : null,
            nidHash,
            body.fullNameAr,
            body.fullNameEn || null,
            body.dateOfBirth,
            body.sex,
            body.phone ? encryptField(body.phone, `patients.phone_enc:${id}`) : null,
            body.email || null,
            body.address ? encryptField(body.address, `patients.address_enc:${id}`) : null,
            body.nationality || null,
            body.maritalStatus || null,
            body.bloodType || null,
            body.nextOfKinName || null,
            body.nextOfKinPhone ? encryptField(body.nextOfKinPhone, `patients.next_of_kin_phone_enc:${id}`) : null,
            auth.user.id,
            fuzzy.rows[0]?.id ?? null,
          ],
        );
        const row = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
        reply.code(201);
        return { patient: dto(row.rows[0], true) };
      },
      (result) => ({
        action: 'patient.create',
        entityType: 'patient',
        entityId: result.patient.id,
        patientId: result.patient.id,
        detail: { mrn: result.patient.mrn, duplicateOf: result.patient.duplicateOfId },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/patients/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const patient = await loadPatientOr404(db, id);
      const clinical = hasPermission(auth, 'patient.chart.clinical');
      const scope = clinical ? 'clinical' : 'administrative';
      const { basis } = await authorizeChartAccess(db, auth, patient, scope, { ip: req.ip, accessType: 'chart_view' });

      const base = dto(patient, !auth.isPortal);
      const allergies = await db.query(
        `SELECT id, allergen, reaction, severity, is_active, created_at FROM patient_allergies
          WHERE patient_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      const conditions = clinical
        ? (await db.query(
            `SELECT id, icd10_code, description, onset_date, status FROM patient_conditions WHERE patient_id = $1 ORDER BY created_at DESC`,
            [id],
          )).rows
        : [];
      const encounters = clinical
        ? (await db.query(
            `SELECT e.id, e.encounter_no, e.encounter_type, e.status, e.started_at, e.closed_at,
                    e.chief_complaint, d.name_ar AS department, u.full_name_ar AS doctor
               FROM encounters e
               JOIN departments d ON d.id = e.department_id
               LEFT JOIN users u ON u.id = e.doctor_id
              WHERE e.patient_id = $1 ORDER BY e.started_at DESC LIMIT 20`,
            [id],
          )).rows
        : [];
      const notes = clinical
        ? (await db.query(
            `SELECT n.id, n.note_type, n.subjective, n.objective, n.assessment, n.plan, n.signed_at, n.created_at,
                    u.full_name_ar AS author
               FROM clinical_notes n LEFT JOIN users u ON u.id = n.author_id
              WHERE n.patient_id = $1 ORDER BY n.created_at DESC LIMIT 10`,
            [id],
          )).rows
        : [];
      const diagnoses = clinical
        ? (await db.query(
            `SELECT id, icd10_code, description, diagnosis_type, created_at FROM diagnoses
              WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [id],
          )).rows
        : [];
      const vitals = clinical
        ? (await db.query(
            `SELECT * FROM vitals WHERE patient_id = $1 ORDER BY recorded_at DESC LIMIT 10`,
            [id],
          )).rows
        : [];
      const labs = clinical
        ? (await db.query(
            `SELECT lo.id, lo.order_no, lo.status, lo.priority, lo.ordered_at,
                    json_agg(json_build_object('testCode', li.test_code, 'status', li.status,
                      'value', lr.value_numeric, 'flag', lr.flag, 'verifiedAt', lr.verified_at)) AS items
               FROM lab_orders lo
               JOIN lab_order_items li ON li.order_id = lo.id
               LEFT JOIN lab_results lr ON lr.order_item_id = li.id
              WHERE lo.patient_id = $1 GROUP BY lo.id ORDER BY lo.ordered_at DESC LIMIT 10`,
            [id],
          )).rows
        : [];
      const prescriptions = (await db.query(
        `SELECT p.id, p.prescription_no, p.status, p.prescribed_at, u.full_name_ar AS prescriber,
                json_agg(json_build_object('drug', dr.name_ar, 'dose', pi.dose, 'frequency', pi.frequency,
                  'durationDays', pi.duration_days, 'quantity', pi.quantity, 'status', pi.status)) AS items
           FROM prescriptions p
           JOIN prescription_items pi ON pi.prescription_id = p.id
           JOIN drugs dr ON dr.id = pi.drug_id
           LEFT JOIN users u ON u.id = p.prescribed_by
          WHERE p.patient_id = $1 GROUP BY p.id, u.full_name_ar ORDER BY p.prescribed_at DESC LIMIT 10`,
        [id],
      )).rows;
      const invoices = (await db.query(
        `SELECT id, invoice_no, status, total, paid_amount, currency, created_at FROM invoices
          WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      )).rows;
      const admissions = (await db.query(
        `SELECT a.id, a.admission_no, a.status, a.admitted_at, a.discharged_at, b.bed_no, r.room_no, w.name_ar AS ward
           FROM admissions a LEFT JOIN beds b ON b.id = a.bed_id
           LEFT JOIN rooms r ON r.id = b.room_id LEFT JOIN wards w ON w.id = b.ward_id
          WHERE a.patient_id = $1 ORDER BY a.admitted_at DESC LIMIT 5`,
        [id],
      )).rows;

      return {
        patient: base,
        access: { basis, scope },
        allergies: allergies.rows,
        conditions,
        encounters,
        notes,
        diagnoses,
        vitals,
        labs,
        prescriptions,
        invoices,
        admissions,
      };
    });
  });

  app.patch('/api/patients/:id', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.update');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      PatientInput.partial().extend({ version: z.number().int().positive() }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, id);
        await authorizeChartAccess(db, auth, patient, 'administrative', { ip: req.ip, accessType: 'chart_update' });
        if (patient.version !== body.version) throw conflict('تم تعديل الملف من مستخدم آخر. أعد تحميل البيانات.');
        const updates: string[] = [];
        const params: unknown[] = [];
        const set = (col: string, value: unknown) => {
          params.push(value);
          updates.push(`${col} = $${params.length}`);
        };
        if (body.fullNameAr !== undefined) set('full_name_ar', body.fullNameAr);
        if (body.fullNameEn !== undefined) set('full_name_en', body.fullNameEn || null);
        if (body.dateOfBirth !== undefined) set('date_of_birth', body.dateOfBirth);
        if (body.sex !== undefined) set('sex', body.sex);
        if (body.phone !== undefined) set('phone_enc', body.phone ? encryptField(body.phone, `patients.phone_enc:${id}`) : null);
        if (body.email !== undefined) set('email', body.email || null);
        if (body.address !== undefined) set('address_enc', body.address ? encryptField(body.address, `patients.address_enc:${id}`) : null);
        if (body.nationality !== undefined) set('nationality', body.nationality);
        if (body.maritalStatus !== undefined) set('marital_status', body.maritalStatus);
        if (body.bloodType !== undefined) set('blood_type', body.bloodType);
        if (body.nextOfKinName !== undefined) set('next_of_kin_name', body.nextOfKinName);
        if (body.nationalId !== undefined && body.nationalId) {
          set('national_id_enc', encryptField(body.nationalId, `patients.national_id_enc:${id}`));
          set('national_id_hash', blindIndex(body.nationalId));
        }
        if (updates.length === 0) throw conflict('لا توجد حقول للتعديل');
        set('version', patient.version + 1);
        set('updated_at', new Date().toISOString());
        params.push(id);
        await db.query(`UPDATE patients SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        const row = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
        reply.code(200);
        return { patient: dto(row.rows[0], true) };
      },
      (result) => ({
        action: 'patient.update',
        entityType: 'patient',
        entityId: id,
        patientId: id,
        detail: { fields: Object.keys(body).filter((k) => k !== 'version') },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/patients/:id/allergies', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.note.write');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({
        allergen: z.string().min(2).max(120),
        reaction: z.string().max(200).optional(),
        severity: z.enum(['mild', 'moderate', 'severe', 'anaphylaxis']),
      }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'allergy_add' });
        const allergyId = crypto.randomUUID();
        await db.query(
          `INSERT INTO patient_allergies (id, facility_id, patient_id, allergen, reaction, severity, noted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [allergyId, patient.facility_id, id, body.allergen, body.reaction ?? null, body.severity, auth.user.id],
        );
        reply.code(201);
        return { id: allergyId };
      },
      (r) => ({ action: 'patient.allergy.added', entityType: 'patient', entityId: id, patientId: id, detail: { allergyId: r.id }, ip: req.ip }),
    );
  });

  app.post('/api/patients/:id/conditions', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'clinical.diagnose');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ icd10Code: z.string().min(3).max(10), description: z.string().min(2).max(250), onsetDate: z.string().optional() }),
      req.body,
    );
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, id);
        await authorizeChartAccess(db, auth, patient, 'clinical', { ip: req.ip, accessType: 'condition_add' });
        const conditionId = crypto.randomUUID();
        await db.query(
          `INSERT INTO patient_conditions (id, facility_id, patient_id, icd10_code, description, onset_date, noted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [conditionId, patient.facility_id, id, body.icd10Code, body.description, body.onsetDate ?? null, auth.user.id],
        );
        reply.code(201);
        return { id: conditionId };
      },
      (r) => ({ action: 'patient.condition.added', entityType: 'patient', entityId: id, patientId: id, detail: { conditionId: r.id }, ip: req.ip }),
    );
  });

  app.post('/api/patients/:id/break-glass', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.break_glass');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(10, 'يجب توضيح سبب الوصول (10 أحرف على الأقل)').max(500) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await loadPatientOr404(db, id);
        const grantId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        await db.query(
          `INSERT INTO break_glass_grants (id, user_id, facility_id, patient_id, reason, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [grantId, auth.user.id, patient.facility_id, id, body.reason, expiresAt],
        );
        await db.query(
          `INSERT INTO notifications_outbox (facility_id, channel, recipient, subject, body, patient_id, related_type, related_id)
           VALUES ($1,'in_app',NULL,'تنبيه وصول طارئ','تم استخدام صلاحية وصول طارئ إلى الملف ' || $2, $3, 'break_glass', $4)`,
          [patient.facility_id, patient.mrn, id, grantId],
        );
        reply.code(201);
        return { grantId, expiresAt };
      },
      (r) => ({
        action: 'patient.break_glass',
        entityType: 'patient',
        entityId: id,
        patientId: id,
        reason: body.reason,
        detail: { grantId: r.grantId, expiresAt: r.expiresAt, reviewRequired: true },
        ip: req.ip,
        outcome: 'success',
      }),
    );
  });

  app.post('/api/patients/:id/merge', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'patient.merge');
    const { id: targetId } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ sourceId: zId, reason: z.string().min(10).max(500) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        if (body.sourceId === targetId) throw conflict('لا يمكن دمج المريض مع نفسه');
        const target = await loadPatientOr404(db, targetId);
        const source = await loadPatientOr404(db, body.sourceId);
        if (target.facility_id !== source.facility_id) throw forbidden('لا يمكن دمج ملفين من منشأتين مختلفتين');
        if (source.status === 'merged') throw conflict('الملف المصدر مدموج مسبقًا');
        const counts: Record<string, number> = {};
        for (const table of [
          'appointments', 'encounters', 'vitals', 'clinical_notes', 'diagnoses', 'lab_orders',
          'prescriptions', 'invoices', 'patient_allergies', 'patient_conditions', 'consents',
          'admissions', 'insurance_policies', 'critical_alerts',
        ]) {
          const res = await db.query(`UPDATE ${table} SET patient_id = $1 WHERE patient_id = $2`, [targetId, body.sourceId]);
          counts[table] = res.rowCount;
        }
        await db.query(
          `UPDATE patients SET status = 'merged', duplicate_of_id = $1, version = version + 1, updated_at = now() WHERE id = $2`,
          [targetId, body.sourceId],
        );
        return { mergedInto: targetId, counts };
      },
      (r) => ({
        action: 'patient.merge',
        entityType: 'patient',
        entityId: targetId,
        patientId: targetId,
        reason: body.reason,
        detail: { sourceId: body.sourceId, moved: r.counts },
        ip: req.ip,
      }),
    );
  });

  app.get('/api/patients/:id/access-log', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'audit.read');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT pal.id, pal.access_type, pal.access_basis, pal.created_at, pal.ip,
                u.full_name_ar AS user_name
           FROM patient_access_log pal LEFT JOIN users u ON u.id = pal.user_id
          WHERE pal.patient_id = $1 ORDER BY pal.created_at DESC LIMIT 100`,
        [id],
      );
      if (rows.rows.length === 0) await loadPatientOr404(db, id);
      return { items: rows.rows };
    });
  });
}
