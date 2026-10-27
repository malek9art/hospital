import type { Queryable } from '../../db';
import type { AuthContext } from '../../auth/context';
import { hasPermission, requirePermission } from '../../auth/context';
import { forbidden, notFound } from '../../lib/errors';

export type ChartScope = 'clinical' | 'administrative';

interface PatientRow {
  id: string;
  facility_id: string;
  mrn: string;
  full_name_ar: string;
  full_name_en: string | null;
  date_of_birth: string;
  sex: string;
  national_id_enc: string | null;
  phone_enc: string | null;
  email: string | null;
  address_enc: string | null;
  nationality: string | null;
  marital_status: string | null;
  blood_type: string | null;
  next_of_kin_name: string | null;
  status: string;
  created_at: string;
  duplicate_of_id: string | null;
  version: number;
  identity_status: string;
}

const RELATIONSHIP_ROLES = new Set(['physician', 'nurse', 'department_manager']);

export async function loadPatientOr404(q: Queryable, patientId: string): Promise<PatientRow> {
  const res = await q.query<PatientRow>('SELECT * FROM patients WHERE id = $1', [patientId]);
  if (!res.rows[0]) throw notFound('الملف الطبي غير موجود');
  return res.rows[0];
}

/**
 * Authorization for reading a chart. Combines RBAC (which chart scope the role
 * holds) with ABAC (an actual care relationship, or an unexpired break-glass
 * grant) and records every access in patient_access_log.
 */
export async function authorizeChartAccess(
  q: Queryable,
  auth: AuthContext,
  patient: PatientRow,
  scope: ChartScope,
  opts: { ip?: string; accessType?: string } = {},
): Promise<{ basis: string }> {
  if (auth.isPortal) {
    if (auth.user.patient_id !== patient.id) throw forbidden('لا يمكن الوصول إلى ملف مريض آخر');
    return { basis: 'portal_self' };
  }
  requirePermission(auth, scope === 'clinical' ? 'patient.chart.clinical' : 'patient.chart.administrative');

  const roleIds = new Set(auth.roles.map((r) => r.role_id));
  const needsRelationship = scope === 'clinical' && [...roleIds].some((r) => RELATIONSHIP_ROLES.has(r));
  let basis = 'role_scope';

  if (needsRelationship) {
    const grant = await q.query<{ id: string }>(
      `SELECT id FROM break_glass_grants
        WHERE user_id = $1 AND patient_id = $2 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY granted_at DESC LIMIT 1`,
      [auth.user.id, patient.id],
    );
    if (grant.rows[0]) {
      basis = 'break_glass';
    } else {
      const rel = await q.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM encounters e
            WHERE e.patient_id = $1 AND e.facility_id = $2
              AND (e.doctor_id = $3 OR e.department_id = ANY($4::uuid[]))
           UNION ALL
           SELECT 1 FROM appointments a
            WHERE a.patient_id = $1 AND a.facility_id = $2 AND a.doctor_id = $3
         ) AS exists`,
        [
          patient.id,
          patient.facility_id,
          auth.user.id,
          auth.roles.map((r) => r.department_id).filter(Boolean) as string[],
        ],
      );
      if (!rel.rows[0]?.exists) {
        throw forbidden('لا توجد علاقة علاجية موثقة مع هذا المريض. استخدم صلاحية الطوارئ (break-glass) مع تسجيل السبب.');
      }
      basis = 'care_relationship';
    }
  }

  await q.query(
    `INSERT INTO patient_access_log (facility_id, user_id, patient_id, access_type, access_basis, reason, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [patient.facility_id, auth.user.id, patient.id, opts.accessType ?? scope, basis, null, opts.ip ?? null],
  );
  return { basis };
}

export async function canAccessClinical(auth: AuthContext) {
  return hasPermission(auth, 'patient.chart.clinical');
}
