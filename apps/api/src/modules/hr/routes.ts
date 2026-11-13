import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { parse, zId } from '../../lib/validation';
import {
  hasPermission,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../../auth/context';
import { nextDocumentNo, withTenant, withTenantAudited } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { decryptField, encryptField, maskId, maskPhone } from '../../lib/crypto';
import type { Queryable } from '../../db';

/**
 * Human Resources, Medical Licensing (SCFHS/MOH), Duty Roster & Leave Management.
 *
 * Governance & Clinical Safety rules enforced here (and mirrored in SQL triggers):
 *  - Clinical practitioners (physician, nursing, allied_health) cannot be scheduled
 *    onto a shift unless they hold an active, verified, non-expired SCFHS or MOH license.
 *  - Separation of duties: the user who records a credential cannot verify it.
 *  - Separation of duties: a requester (or the employee themselves) cannot approve
 *    or reject their own leave request.
 *  - Terminated employees, revoked credentials, completed/cancelled shifts, and
 *    reviewed leave requests are immutable; no HR rows are ever deleted.
 *
 * Honest scope limits: no payroll calculation, bank WPS/GOSI integration, or
 * biometric attendance hardware integration.
 */

export const CATEGORY_AR: Record<string, string> = {
  physician: 'أطباء',
  nursing: 'تمريض',
  allied_health: 'ممارسون صحيون مساندون',
  administrative: 'إداريون',
  support: 'خدمات مساندة',
};

export const CREDENTIAL_TYPE_AR: Record<string, string> = {
  scfhs: 'تصنيف الهيئة السعودية للتخصصات الصحية (SCFHS)',
  bls: 'دعم الحياة الأساسي (BLS)',
  acls: 'دعم الحياة القلبي المتقدم (ACLS)',
  moh_license: 'ترخيص مزاولة وزارة الصحة',
  board: 'زمالة / بورد تخصصي',
  other: 'شهادة مهنية أخرى',
};

export const SHIFT_TYPE_AR: Record<string, string> = {
  morning: 'صباحية (07:00–15:00)',
  evening: 'مسائية (15:00–23:00)',
  night: 'ليلية (23:00–07:00)',
  on_call: 'مناوبة استدعاء (On-Call)',
};

export const LEAVE_TYPE_AR: Record<string, string> = {
  annual: 'إجازة سنوية',
  sick: 'إجازة مرضية',
  emergency: 'إجازة اضطرارية',
  maternity: 'إجازة أمومة',
  study: 'إجازة دراسية / مؤتمر علمي',
  unpaid: 'إجازة بدون راتب',
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD');

const CreateEmployeeSchema = z.object({
  userId: zId.optional().nullable(),
  fullNameAr: z.string().trim().min(3, 'الاسم الثلاثي مطلوب').max(200),
  fullNameEn: z.string().trim().max(200).optional().nullable(),
  category: z.enum(['physician', 'nursing', 'allied_health', 'administrative', 'support']),
  jobTitleAr: z.string().trim().min(2).max(160),
  departmentId: zId.optional().nullable(),
  employmentType: z.enum(['full_time', 'part_time', 'locum', 'contractor']).default('full_time'),
  hireDate: isoDate,
  nationalId: z.string().trim().regex(/^[0-9]{10}$/, 'رقم الهوية/الإقامة 10 أرقام').optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
});

const EmployeeStatusSchema = z.object({
  status: z.enum(['active', 'on_leave', 'suspended', 'terminated']),
  reason: z.string().trim().max(400).optional(),
});

const RecordCredentialSchema = z.object({
  credentialType: z.enum(['scfhs', 'bls', 'acls', 'moh_license', 'board', 'other']),
  licenseNo: z.string().trim().min(3).max(80),
  issuingBody: z.string().trim().min(2).max(160),
  issuedDate: isoDate,
  expiryDate: isoDate,
  notes: z.string().trim().max(400).optional(),
});

const ReasonSchema = z.object({
  reason: z.string().trim().min(5, 'السبب الموثق مطلوب (5 أحرف على الأقل)').max(400),
});

const CreateShiftSchema = z.object({
  employeeId: zId,
  departmentId: zId.optional().nullable(),
  shiftDate: isoDate,
  shiftType: z.enum(['morning', 'evening', 'night', 'on_call']),
  notes: z.string().trim().max(300).optional(),
});

const CreateLeaveSchema = z.object({
  employeeId: zId.optional(),
  leaveType: z.enum(['annual', 'sick', 'emergency', 'maternity', 'study', 'unpaid']),
  startDate: isoDate,
  endDate: isoDate,
  reason: z.string().trim().min(5, 'سبب الإجازة مطلوب (5 أحرف على الأقل)').max(400),
});

const ReviewLeaveSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(400).optional(),
});

interface EmployeeRow {
  id: string;
  facility_id: string;
  user_id: string | null;
  employee_no: string;
  full_name_ar: string;
  full_name_en: string | null;
  category: string;
  job_title_ar: string;
  department_id: string | null;
  department_name?: string | null;
  user_email?: string | null;
  employment_type: string;
  hire_date: string;
  status: string;
  status_reason: string | null;
  national_id_enc: string | null;
  phone_enc: string | null;
  verified_licenses?: number;
  nearest_expiry?: string | null;
}

function mapEmployeeDto(r: EmployeeRow) {
  const nid = decryptField(r.national_id_enc, `hr_employees.national_id_enc:${r.id}`);
  const phone = decryptField(r.phone_enc, `hr_employees.phone_enc:${r.id}`);
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email ?? null,
    employeeNo: r.employee_no,
    fullNameAr: r.full_name_ar,
    fullNameEn: r.full_name_en,
    category: r.category,
    categoryAr: CATEGORY_AR[r.category] ?? r.category,
    jobTitleAr: r.job_title_ar,
    departmentId: r.department_id,
    departmentName: r.department_name ?? null,
    employmentType: r.employment_type,
    hireDate: r.hire_date,
    status: r.status,
    statusReason: r.status_reason,
    nationalIdMasked: maskId(nid),
    phoneMasked: maskPhone(phone),
    verifiedLicenses: Number(r.verified_licenses ?? 0),
    nearestExpiry: r.nearest_expiry ?? null,
  };
}

async function loadEmployeeOr404(db: Queryable, id: string, facilityId: string): Promise<EmployeeRow> {
  const res = await db.query<EmployeeRow>(
    `SELECT * FROM hr_employees WHERE id = $1 AND facility_id = $2`,
    [id, facilityId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('ملف الموظف غير موجود');
  return row;
}

export async function hrRoutes(app: FastifyInstance) {
  // -------------------------------------------------------------- HR Board ----
  app.get('/api/hr/board', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.read');

    return withTenant(auth, async (db) => {
      const [totalsRes, empRes, credRes, shiftRes, leaveRes] = await Promise.all([
        db.query<{
          active_employees: number;
          clinicians_count: number;
          verified_credentials: number;
          expiring_30d: number;
          unverified_or_expired: number;
          pending_leaves: number;
          today_shifts: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM hr_employees WHERE facility_id = $1 AND status = 'active') AS active_employees,
             (SELECT count(*)::int FROM hr_employees WHERE facility_id = $1 AND status = 'active' AND category IN ('physician','nursing','allied_health')) AS clinicians_count,
             (SELECT count(*)::int FROM hr_credentials WHERE facility_id = $1 AND status = 'verified' AND expiry_date >= current_date) AS verified_credentials,
             (SELECT count(*)::int FROM hr_credentials WHERE facility_id = $1 AND status = 'verified' AND expiry_date BETWEEN current_date AND current_date + 30) AS expiring_30d,
             (SELECT count(*)::int FROM hr_credentials WHERE facility_id = $1 AND (status IN ('pending_verification','revoked') OR expiry_date < current_date)) AS unverified_or_expired,
             (SELECT count(*)::int FROM hr_leave_requests WHERE facility_id = $1 AND status = 'pending') AS pending_leaves,
             (SELECT count(*)::int FROM hr_shifts WHERE facility_id = $1 AND shift_date = current_date AND status IN ('scheduled','checked_in','completed')) AS today_shifts`,
          [auth.activeFacilityId],
        ),
        db.query<EmployeeRow>(
          `SELECT e.*, e.hire_date::text AS hire_date, d.name_ar AS department_name, u.email AS user_email,
                  (SELECT count(*)::int FROM hr_credentials c WHERE c.employee_id = e.id AND c.status = 'verified' AND c.expiry_date >= current_date) AS verified_licenses,
                  (SELECT min(c.expiry_date)::text FROM hr_credentials c WHERE c.employee_id = e.id AND c.status = 'verified') AS nearest_expiry
             FROM hr_employees e
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN users u ON u.id = e.user_id
            WHERE e.facility_id = $1
            ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'on_leave' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, e.employee_no`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT c.id, c.employee_id, c.credential_type, c.license_no, c.issuing_body,
                  c.issued_date::text AS issued_date, c.expiry_date::text AS expiry_date,
                  c.status, c.recorded_by, c.verified_by, c.verified_at, c.revoke_reason, c.notes,
                  e.employee_no, e.full_name_ar AS employee_name, e.category,
                  rec.full_name_ar AS recorded_by_name, ver.full_name_ar AS verified_by_name,
                  (c.expiry_date - current_date)::int AS days_left,
                  (c.expiry_date < current_date) AS is_expired
             FROM hr_credentials c
             JOIN hr_employees e ON e.id = c.employee_id
             JOIN users rec ON rec.id = c.recorded_by
             LEFT JOIN users ver ON ver.id = c.verified_by
            WHERE c.facility_id = $1
            ORDER BY CASE WHEN c.status = 'pending_verification' THEN 0 WHEN c.expiry_date < current_date + 30 THEN 1 ELSE 2 END, c.expiry_date ASC`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT s.id, s.employee_id, s.department_id, s.shift_date::text AS shift_date, s.shift_type,
                  s.status, s.checked_in_at, s.completed_at, s.cancel_reason, s.notes,
                  e.employee_no, e.full_name_ar AS employee_name, e.job_title_ar,
                  d.name_ar AS department_name
             FROM hr_shifts s
             JOIN hr_employees e ON e.id = s.employee_id
             LEFT JOIN departments d ON d.id = s.department_id
            WHERE s.facility_id = $1 AND s.shift_date >= current_date - 7
            ORDER BY s.shift_date ASC, CASE s.shift_type WHEN 'morning' THEN 0 WHEN 'evening' THEN 1 WHEN 'night' THEN 2 ELSE 3 END`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT l.id, l.request_no, l.employee_id, l.leave_type,
                  l.start_date::text AS start_date, l.end_date::text AS end_date,
                  l.days_count, l.reason, l.status, l.requested_by, l.reviewed_by, l.reviewed_at, l.review_note,
                  e.employee_no, e.full_name_ar AS employee_name, e.user_id AS employee_user_id,
                  req.full_name_ar AS requested_by_name, rev.full_name_ar AS reviewed_by_name
             FROM hr_leave_requests l
             JOIN hr_employees e ON e.id = l.employee_id
             JOIN users req ON req.id = l.requested_by
             LEFT JOIN users rev ON rev.id = l.reviewed_by
            WHERE l.facility_id = $1
            ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.created_at DESC`,
          [auth.activeFacilityId],
        ),
      ]);

      const credentials = credRes.rows.map((c) => {
        const row = c as Record<string, unknown>;
        return {
          ...row,
          credential_type_ar: CREDENTIAL_TYPE_AR[String(row.credential_type)] ?? String(row.credential_type),
        };
      });

      const shifts = shiftRes.rows.map((s) => {
        const row = s as Record<string, unknown>;
        return {
          ...row,
          shift_type_ar: SHIFT_TYPE_AR[String(row.shift_type)] ?? String(row.shift_type),
        };
      });

      const leaves = leaveRes.rows.map((l) => {
        const row = l as Record<string, unknown>;
        return {
          ...row,
          leave_type_ar: LEAVE_TYPE_AR[String(row.leave_type)] ?? String(row.leave_type),
        };
      });

      const expiringLicenses = credentials.filter(
        (c) => Number((c as Record<string, unknown>).days_left ?? 999) <= 30 && (c as Record<string, unknown>).status !== 'revoked',
      );

      return {
        totals: totalsRes.rows[0] ?? {},
        employees: empRes.rows.map(mapEmployeeDto),
        credentials,
        expiringLicenses,
        shifts,
        leaves,
      };
    });
  });

  // ------------------------------------------------------- Self-Service Me ----
  app.get('/api/hr/me', async (req) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['hr.self', 'hr.read']);

    return withTenant(auth, async (db) => {
      const empRes = await db.query<EmployeeRow>(
        `SELECT e.*, e.hire_date::text AS hire_date, d.name_ar AS department_name, u.email AS user_email
           FROM hr_employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN users u ON u.id = e.user_id
          WHERE e.facility_id = $1 AND e.user_id = $2`,
        [auth.activeFacilityId, auth.user.id],
      );
      const emp = empRes.rows[0];
      if (!emp) {
        return { employee: null, credentials: [], shifts: [], leaves: [] };
      }

      const [credRes, shiftRes, leaveRes] = await Promise.all([
        db.query(
          `SELECT id, credential_type, license_no, issuing_body, issued_date::text AS issued_date,
                  expiry_date::text AS expiry_date, status, (expiry_date - current_date)::int AS days_left
             FROM hr_credentials WHERE employee_id = $1 ORDER BY expiry_date ASC`,
          [emp.id],
        ),
        db.query(
          `SELECT s.id, s.shift_date::text AS shift_date, s.shift_type, s.status, s.checked_in_at, s.completed_at,
                  d.name_ar AS department_name
             FROM hr_shifts s LEFT JOIN departments d ON d.id = s.department_id
            WHERE s.employee_id = $1 AND s.shift_date >= current_date - 7
            ORDER BY s.shift_date ASC`,
          [emp.id],
        ),
        db.query(
          `SELECT id, request_no, leave_type, start_date::text AS start_date, end_date::text AS end_date,
                  days_count, reason, status, review_note, created_at
             FROM hr_leave_requests WHERE employee_id = $1 ORDER BY created_at DESC`,
          [emp.id],
        ),
      ]);

      return {
        employee: mapEmployeeDto(emp),
        credentials: credRes.rows.map((c) => {
          const row = c as Record<string, unknown>;
          return { ...row, credential_type_ar: CREDENTIAL_TYPE_AR[String(row.credential_type)] ?? String(row.credential_type) };
        }),
        shifts: shiftRes.rows.map((s) => {
          const row = s as Record<string, unknown>;
          return { ...row, shift_type_ar: SHIFT_TYPE_AR[String(row.shift_type)] ?? String(row.shift_type) };
        }),
        leaves: leaveRes.rows.map((l) => {
          const row = l as Record<string, unknown>;
          return { ...row, leave_type_ar: LEAVE_TYPE_AR[String(row.leave_type)] ?? String(row.leave_type) };
        }),
      };
    });
  });

  // -------------------------------------------------------- Create Employee ----
  app.post('/api/hr/employees', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.manage');
    const body = parse(CreateEmployeeSchema, req.body);

    const created = await withTenantAudited(
      auth,
      async (db) => {
        if (body.userId) {
          const dupUser = await db.query(
            `SELECT id, employee_no FROM hr_employees WHERE facility_id = $1 AND user_id = $2`,
            [auth.activeFacilityId, body.userId],
          );
          if (dupUser.rowCount) {
            throw conflict('هذا الحساب مرتبط بملف موظف قائم بالفعل', { employeeNo: dupUser.rows[0]?.employee_no });
          }
        }

        const id = crypto.randomUUID();
        const employeeNo = await nextDocumentNo(db, auth.activeFacilityId, 'hr_employee', 'EMP');
        const nidEnc = body.nationalId ? encryptField(body.nationalId, `hr_employees.national_id_enc:${id}`) : null;
        const phoneEnc = body.phone ? encryptField(body.phone, `hr_employees.phone_enc:${id}`) : null;

        await db.query(
          `INSERT INTO hr_employees (
             id, facility_id, user_id, employee_no, full_name_ar, full_name_en,
             category, job_title_ar, department_id, employment_type, hire_date,
             national_id_enc, phone_enc, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            id,
            auth.activeFacilityId,
            body.userId ?? null,
            employeeNo,
            body.fullNameAr,
            body.fullNameEn ?? null,
            body.category,
            body.jobTitleAr,
            body.departmentId ?? null,
            body.employmentType,
            body.hireDate,
            nidEnc,
            phoneEnc,
            auth.user.id,
          ],
        );

        return { id, employeeNo, fullNameAr: body.fullNameAr, category: body.category };
      },
      (res) => ({
        action: 'hr.employee.create',
        entityType: 'hr_employee',
        entityId: res.id,
        detail: { employeeNo: res.employeeNo, category: res.category },
      }),
    );

    return reply.code(201).send(created);
  });

  // ------------------------------------------------ Transition Employee Status --
  app.patch('/api/hr/employees/:id/status', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(EmployeeStatusSchema, req.body);

    if ((body.status === 'suspended' || body.status === 'terminated') && (!body.reason || body.reason.trim().length < 5)) {
      throw conflict('إيقاف الموظف أو إنهاء خدمته يتطلب سببًا موثقًا (5 أحرف على الأقل)');
    }

    return withTenantAudited(
      auth,
      async (db) => {
        const emp = await loadEmployeeOr404(db, id, auth.activeFacilityId);
        if (emp.status === 'terminated') {
          throw conflict('سجل الموظف منتهي الخدمة مجمد ولا يمكن تعديله');
        }
        await db.query(
          `UPDATE hr_employees SET status = $1, status_reason = $2, updated_at = now() WHERE id = $3`,
          [body.status, body.reason?.trim() ?? null, id],
        );
        return { id, employeeNo: emp.employee_no, status: body.status };
      },
      (res) => ({
        action: 'hr.employee.status',
        entityType: 'hr_employee',
        entityId: res.id,
        reason: body.reason,
        detail: { employeeNo: res.employeeNo, status: res.status },
      }),
    );
  });

  // ----------------------------------------------------- Record Credential ----
  app.post('/api/hr/employees/:id/credentials', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.manage');
    const { id: employeeId } = parse(z.object({ id: zId }), req.params);
    const body = parse(RecordCredentialSchema, req.body);

    if (body.expiryDate <= body.issuedDate) {
      throw conflict('تاريخ انتهاء الترخيص يجب أن يكون بعد تاريخ الإصدار');
    }

    const created = await withTenantAudited(
      auth,
      async (db) => {
        const emp = await loadEmployeeOr404(db, employeeId, auth.activeFacilityId);
        if (emp.status === 'terminated') {
          throw conflict('لا يمكن إضافة ترخيص لموظف منتهي الخدمة');
        }
        const dup = await db.query(
          `SELECT id FROM hr_credentials WHERE facility_id = $1 AND credential_type = $2 AND license_no = $3`,
          [auth.activeFacilityId, body.credentialType, body.licenseNo],
        );
        if (dup.rowCount) {
          throw conflict('رقم الترخيص مسجل مسبقًا لنفس نوع الشهادة في هذه المنشأة');
        }

        const credId = crypto.randomUUID();
        await db.query(
          `INSERT INTO hr_credentials (
             id, facility_id, employee_id, credential_type, license_no, issuing_body,
             issued_date, expiry_date, status, recorded_by, notes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_verification',$9,$10)`,
          [
            credId,
            auth.activeFacilityId,
            employeeId,
            body.credentialType,
            body.licenseNo,
            body.issuingBody,
            body.issuedDate,
            body.expiryDate,
            auth.user.id,
            body.notes ?? null,
          ],
        );

        return { id: credId, employeeId, licenseNo: body.licenseNo, credentialType: body.credentialType, status: 'pending_verification' };
      },
      (res) => ({
        action: 'hr.credential.record',
        entityType: 'hr_credential',
        entityId: res.id,
        detail: { employeeId: res.employeeId, credentialType: res.credentialType, licenseNo: res.licenseNo },
      }),
    );

    return reply.code(201).send(created);
  });

  // ---------------------------------------- Verify Credential (SoD Enforced) --
  app.post('/api/hr/credentials/:id/verify', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.credentials.verify');
    const { id } = parse(z.object({ id: zId }), req.params);

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{
          id: string;
          status: string;
          recorded_by: string;
          license_no: string;
          expired: boolean;
        }>(
          `SELECT id, status, recorded_by, license_no, (expiry_date < current_date) AS expired
             FROM hr_credentials WHERE id = $1 AND facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const cred = res.rows[0];
        if (!cred) throw notFound('الترخيص المهني غير موجود');
        if (cred.status !== 'pending_verification') {
          throw conflict('لا يمكن اعتماد ترخيص ليس في حالة بانتظار التحقق');
        }
        if (cred.recorded_by === auth.user.id) {
          throw conflict('فصل المهام: لا يجوز لمسجّل الترخيص اعتماده بنفسه؛ يتطلب مشرفًا آخر');
        }
        if (cred.expired) {
          throw conflict('لا يمكن اعتماد ترخيص منتهي الصلاحية');
        }

        await db.query(
          `UPDATE hr_credentials SET status = 'verified', verified_by = $1, verified_at = now() WHERE id = $2`,
          [auth.user.id, id],
        );
        return { id, licenseNo: cred.license_no, status: 'verified' };
      },
      (res) => ({
        action: 'hr.credential.verify',
        entityType: 'hr_credential',
        entityId: res.id,
        detail: { licenseNo: res.licenseNo },
      }),
    );
  });

  // ----------------------------------------------------- Revoke Credential ----
  app.post('/api/hr/credentials/:id/revoke', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.credentials.verify');
    const { id } = parse(z.object({ id: zId }), req.params);
    const { reason } = parse(ReasonSchema, req.body);

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{ id: string; status: string; license_no: string }>(
          `SELECT id, status, license_no FROM hr_credentials WHERE id = $1 AND facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const cred = res.rows[0];
        if (!cred) throw notFound('الترخيص المهني غير موجود');
        if (cred.status === 'revoked') {
          throw conflict('الترخيص مسحوب مسبقًا ولا يمكن تعديله');
        }
        await db.query(
          `UPDATE hr_credentials SET status = 'revoked', revoke_reason = $1 WHERE id = $2`,
          [reason, id],
        );
        return { id, licenseNo: cred.license_no, status: 'revoked' };
      },
      (res) => ({
        action: 'hr.credential.revoke',
        entityType: 'hr_credential',
        entityId: res.id,
        reason,
        detail: { licenseNo: res.licenseNo },
      }),
    );
  });

  // -------------------------------------------------------- Schedule Shift ----
  app.post('/api/hr/shifts', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.roster.manage');
    const body = parse(CreateShiftSchema, req.body);

    const created = await withTenantAudited(
      auth,
      async (db) => {
        const emp = await loadEmployeeOr404(db, body.employeeId, auth.activeFacilityId);
        if (emp.status === 'suspended' || emp.status === 'terminated') {
          throw conflict('لا يمكن جدولة مناوبة لموظف موقوف أو منتهي الخدمة');
        }

        // Block scheduling during approved leave
        const onLeave = await db.query<{ request_no: string }>(
          `SELECT request_no FROM hr_leave_requests
            WHERE employee_id = $1 AND status = 'approved' AND $2::date BETWEEN start_date AND end_date`,
          [emp.id, body.shiftDate],
        );
        if (onLeave.rowCount) {
          throw conflict(`الموظف في إجازة معتمدة (${onLeave.rows[0]?.request_no}) خلال تاريخ المناوبة`);
        }

        // Clinical Safety Gate: practitioners MUST hold a valid verified SCFHS/MOH license covering shiftDate
        if (['physician', 'nursing', 'allied_health'].includes(emp.category)) {
          const validLic = await db.query(
            `SELECT id FROM hr_credentials
              WHERE employee_id = $1
                AND credential_type IN ('scfhs', 'moh_license')
                AND status = 'verified'
                AND expiry_date >= $2::date
              LIMIT 1`,
            [emp.id, body.shiftDate],
          );
          if (!validLic.rowCount) {
            throw conflict(
              'حاجز سلامة الممارسة الصحية: لا يجوز جدولة ممارس صحي دون ترخيص مزاولة (SCFHS / وزارة الصحة) معتمد وساري المفعول في تاريخ المناوبة',
            );
          }
        }

        const dup = await db.query(
          `SELECT id FROM hr_shifts
            WHERE employee_id = $1 AND shift_date = $2::date AND shift_type = $3 AND status <> 'cancelled'`,
          [emp.id, body.shiftDate, body.shiftType],
        );
        if (dup.rowCount) {
          throw conflict('توجد مناوبة مجدولة بالفعل لهذا الموظف في نفس اليوم والفترة');
        }

        const shiftId = crypto.randomUUID();
        await db.query(
          `INSERT INTO hr_shifts (
             id, facility_id, employee_id, department_id, shift_date, shift_type, notes, created_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            shiftId,
            auth.activeFacilityId,
            emp.id,
            body.departmentId ?? emp.department_id ?? null,
            body.shiftDate,
            body.shiftType,
            body.notes ?? null,
            auth.user.id,
          ],
        );

        return { id: shiftId, employeeNo: emp.employee_no, shiftDate: body.shiftDate, shiftType: body.shiftType, status: 'scheduled' };
      },
      (res) => ({
        action: 'hr.shift.schedule',
        entityType: 'hr_shift',
        entityId: res.id,
        detail: { employeeNo: res.employeeNo, shiftDate: res.shiftDate, shiftType: res.shiftType },
      }),
    );

    return reply.code(201).send(created);
  });

  // ------------------------------------------------ Shift Check-in / Complete --
  app.post('/api/hr/shifts/:id/checkin', async (req) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['hr.roster.manage', 'hr.self']);
    const { id } = parse(z.object({ id: zId }), req.params);

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{ id: string; status: string; user_id: string | null }>(
          `SELECT s.id, s.status, e.user_id
             FROM hr_shifts s JOIN hr_employees e ON e.id = s.employee_id
            WHERE s.id = $1 AND s.facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const shift = res.rows[0];
        if (!shift) throw notFound('المناوبة غير موجودة');
        if (!hasPermission(auth, 'hr.roster.manage') && shift.user_id !== auth.user.id) {
          throw forbidden('لا يمكنك تسجيل حضور مناوبة تخص موظفًا آخر');
        }
        if (shift.status !== 'scheduled') {
          throw conflict('تسجيل الحضور متاح فقط للمناوبات المجدولة');
        }
        await db.query(`UPDATE hr_shifts SET status = 'checked_in', checked_in_at = now() WHERE id = $1`, [id]);
        return { id, status: 'checked_in' };
      },
      (res) => ({ action: 'hr.shift.checkin', entityType: 'hr_shift', entityId: res.id }),
    );
  });

  app.post('/api/hr/shifts/:id/complete', async (req) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['hr.roster.manage', 'hr.self']);
    const { id } = parse(z.object({ id: zId }), req.params);

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{ id: string; status: string; user_id: string | null }>(
          `SELECT s.id, s.status, e.user_id
             FROM hr_shifts s JOIN hr_employees e ON e.id = s.employee_id
            WHERE s.id = $1 AND s.facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const shift = res.rows[0];
        if (!shift) throw notFound('المناوبة غير موجودة');
        if (!hasPermission(auth, 'hr.roster.manage') && shift.user_id !== auth.user.id) {
          throw forbidden('لا يمكنك إنهاء مناوبة تخص موظفًا آخر');
        }
        if (shift.status !== 'checked_in') {
          throw conflict('إنهاء المناوبة يتطلب تسجيل الحضور أولًا');
        }
        await db.query(`UPDATE hr_shifts SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
        return { id, status: 'completed' };
      },
      (res) => ({ action: 'hr.shift.complete', entityType: 'hr_shift', entityId: res.id }),
    );
  });

  app.post('/api/hr/shifts/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.roster.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const { reason } = parse(ReasonSchema, req.body);

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM hr_shifts WHERE id = $1 AND facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const shift = res.rows[0];
        if (!shift) throw notFound('المناوبة غير موجودة');
        if (shift.status === 'completed' || shift.status === 'cancelled') {
          throw conflict('لا يمكن إلغاء مناوبة مكتملة أو ملغاة مسبقًا');
        }
        await db.query(
          `UPDATE hr_shifts SET status = 'cancelled', cancel_reason = $1 WHERE id = $2`,
          [reason, id],
        );
        return { id, status: 'cancelled' };
      },
      (res) => ({ action: 'hr.shift.cancel', entityType: 'hr_shift', entityId: res.id, reason }),
    );
  });

  // ------------------------------------------------------- Leave Requests ----
  app.post('/api/hr/leaves', async (req, reply) => {
    const auth = requireAuth(req);
    requireAnyPermission(auth, ['hr.manage', 'hr.self']);
    const body = parse(CreateLeaveSchema, req.body);

    if (body.endDate < body.startDate) {
      throw conflict('تاريخ نهاية الإجازة يجب ألا يسبق تاريخ البداية');
    }

    const created = await withTenantAudited(
      auth,
      async (db) => {
        let emp: EmployeeRow;
        if (body.employeeId && hasPermission(auth, 'hr.manage')) {
          emp = await loadEmployeeOr404(db, body.employeeId, auth.activeFacilityId);
        } else {
          const selfRes = await db.query<EmployeeRow>(
            `SELECT * FROM hr_employees WHERE facility_id = $1 AND user_id = $2`,
            [auth.activeFacilityId, auth.user.id],
          );
          if (!selfRes.rows[0]) {
            throw forbidden('لا يوجد ملف موظف مرتبط بحسابك الحالي لتقديم طلب إجازة ذاتي');
          }
          if (body.employeeId && body.employeeId !== selfRes.rows[0].id) {
            throw forbidden('لا تملك صلاحية تقديم إجازة نيابة عن موظف آخر');
          }
          emp = selfRes.rows[0];
        }

        if (emp.status === 'terminated') {
          throw conflict('لا يمكن تسجيل طلب إجازة لموظف منتهي الخدمة');
        }

        const overlap = await db.query<{ request_no: string }>(
          `SELECT request_no FROM hr_leave_requests
            WHERE employee_id = $1 AND status IN ('pending','approved')
              AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
          [emp.id, body.startDate, body.endDate],
        );
        if (overlap.rowCount) {
          throw conflict(`يوجد طلب إجازة متداخل (${overlap.rows[0]?.request_no}) لنفس الموظف في هذه الفترة`);
        }

        const startMs = Date.parse(`${body.startDate}T00:00:00Z`);
        const endMs = Date.parse(`${body.endDate}T00:00:00Z`);
        const daysCount = Math.round((endMs - startMs) / 86_400_000) + 1;
        if (daysCount < 1 || daysCount > 180) {
          throw conflict('مدة الإجازة يجب أن تتراوح بين يوم واحد و180 يومًا');
        }

        const id = crypto.randomUUID();
        const requestNo = await nextDocumentNo(db, auth.activeFacilityId, 'hr_leave', 'LVR');
        await db.query(
          `INSERT INTO hr_leave_requests (
             id, facility_id, request_no, employee_id, leave_type, start_date, end_date,
             days_count, reason, status, requested_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
          [
            id,
            auth.activeFacilityId,
            requestNo,
            emp.id,
            body.leaveType,
            body.startDate,
            body.endDate,
            daysCount,
            body.reason,
            auth.user.id,
          ],
        );

        return { id, requestNo, employeeId: emp.id, daysCount, status: 'pending' };
      },
      (res) => ({
        action: 'hr.leave.request',
        entityType: 'hr_leave_request',
        entityId: res.id,
        detail: { requestNo: res.requestNo, daysCount: res.daysCount },
      }),
    );

    return reply.code(201).send(created);
  });

  app.post('/api/hr/leaves/:id/review', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'hr.leave.approve');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(ReviewLeaveSchema, req.body);

    if (body.decision === 'rejected' && (!body.note || body.note.trim().length < 5)) {
      throw conflict('رفض طلب الإجازة يتطلب تدوين مبرر لا يقل عن 5 أحرف');
    }

    return withTenantAudited(
      auth,
      async (db) => {
        const res = await db.query<{
          id: string;
          request_no: string;
          employee_id: string;
          employee_user_id: string | null;
          requested_by: string;
          status: string;
          active_today: boolean;
        }>(
          `SELECT l.id, l.request_no, l.employee_id, e.user_id AS employee_user_id,
                  l.requested_by, l.status,
                  (current_date BETWEEN l.start_date AND l.end_date) AS active_today
             FROM hr_leave_requests l
             JOIN hr_employees e ON e.id = l.employee_id
            WHERE l.id = $1 AND l.facility_id = $2`,
          [id, auth.activeFacilityId],
        );
        const lv = res.rows[0];
        if (!lv) throw notFound('طلب الإجازة غير موجود');
        if (lv.status !== 'pending') {
          throw conflict('تم البت في طلب الإجازة مسبقًا ولا يمكن تعديل القرار');
        }
        if (lv.requested_by === auth.user.id || lv.employee_user_id === auth.user.id) {
          throw conflict('فصل المهام: لا يجوز للموظف أو مقدم الطلب اعتماد أو رفض إجازته بنفسه');
        }

        await db.query(
          `UPDATE hr_leave_requests
              SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
            WHERE id = $4`,
          [body.decision, auth.user.id, body.note?.trim() ?? null, id],
        );

        if (body.decision === 'approved' && lv.active_today) {
          await db.query(
            `UPDATE hr_employees SET status = 'on_leave', updated_at = now()
              WHERE id = $1 AND status = 'active'`,
            [lv.employee_id],
          );
        }

        return { id, requestNo: lv.request_no, status: body.decision };
      },
      (res) => ({
        action: 'hr.leave.review',
        entityType: 'hr_leave_request',
        entityId: res.id,
        reason: body.note,
        detail: { requestNo: res.requestNo, decision: res.status },
      }),
    );
  });
}
