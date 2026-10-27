import type { FastifyRequest } from 'fastify';
import { getDb } from '../db';
import { config } from '../config';
import { AppError, unauthorized } from '../lib/errors';
import { hmacToken } from '../lib/crypto';

export interface FacilityRef {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  timezone: string;
  currency: string;
}
export interface AuthUser {
  id: string;
  email: string;
  full_name_ar: string;
  full_name_en: string;
  is_super_admin: boolean;
  mfa_enabled: boolean;
  mfa_enforced: boolean;
  preferred_language: string;
  patient_id: string | null;
  job_title_ar: string | null;
}
export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
  mfaVerified: boolean;
  roles: { role_id: string; facility_id: string; department_id: string | null }[];
  permissions: Set<string>;
  facilities: FacilityRef[];
  activeFacilityId: string;
  isPortal: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function loadAuthFromToken(rawToken: string | undefined): Promise<AuthContext | null> {
  if (!rawToken) return null;
  const db = await getDb();
  const cfg = config();
  const tokenHash = hmacToken(rawToken);
  const sess = await db.query<{
    id: string;
    user_id: string;
    csrf_token: string;
    facility_id: string | null;
    mfa_verified: boolean;
    idle_expires_at: string;
    absolute_expires_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id, user_id, csrf_token, facility_id, mfa_verified, idle_expires_at, absolute_expires_at, revoked_at
       FROM sessions WHERE token_hash = $1`,
    [tokenHash],
  );
  const session = sess.rows[0];
  if (!session || session.revoked_at) return null;
  const now = Date.now();
  if (new Date(session.idle_expires_at).getTime() < now || new Date(session.absolute_expires_at).getTime() < now) {
    return null;
  }

  const userRes = await db.query<AuthUser & { is_active: boolean }>(
    `SELECT id, email, full_name_ar, full_name_en, is_super_admin, mfa_enabled, mfa_enforced,
            preferred_language, patient_id, job_title_ar, is_active
       FROM users WHERE id = $1`,
    [session.user_id],
  );
  const user = userRes.rows[0];
  if (!user || !user.is_active) return null;

  const rolesRes = await db.query<{ role_id: string; facility_id: string; department_id: string | null }>(
    'SELECT role_id, facility_id, department_id FROM user_roles WHERE user_id = $1',
    [user.id],
  );
  const permsRes = await db.query<{ permission_code: string }>(
    `SELECT DISTINCT rp.permission_code
       FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1`,
    [user.id],
  );

  let facilities: FacilityRef[];
  if (user.is_super_admin) {
    facilities = (
      await db.query<FacilityRef>('SELECT id, code, name_ar, name_en, timezone, currency FROM facilities WHERE is_active = true ORDER BY name_ar')
    ).rows;
  } else if (user.patient_id) {
    facilities = (
      await db.query<FacilityRef>(
        `SELECT DISTINCT f.id, f.code, f.name_ar, f.name_en, f.timezone, f.currency
           FROM facilities f
           JOIN patients p ON p.facility_id = f.id
          WHERE p.id = $1 AND f.is_active = true`,
        [user.patient_id],
      )
    ).rows;
  } else {
    facilities = (
      await db.query<FacilityRef>(
        `SELECT f.id, f.code, f.name_ar, f.name_en, f.timezone, f.currency
           FROM facilities f JOIN user_facilities uf ON uf.facility_id = f.id
          WHERE uf.user_id = $1 AND f.is_active = true ORDER BY f.name_ar`,
        [user.id],
      )
    ).rows;
  }
  if (facilities.length === 0) return null;

  const activeFacilityId = session.facility_id && facilities.some((f) => f.id === session.facility_id)
    ? session.facility_id
    : facilities[0].id;

  // Sliding idle timeout, refreshed at most once a minute to avoid write amplification.
  const idleMs = cfg.SESSION_IDLE_MINUTES * 60_000;
  if (now - new Date(session.idle_expires_at).getTime() < idleMs - 60_000) {
    const nextIdle = new Date(now + idleMs).toISOString();
    await db.query('UPDATE sessions SET last_seen_at = now(), idle_expires_at = $1 WHERE id = $2', [nextIdle, session.id]);
  }

  return {
    user,
    sessionId: session.id,
    csrfToken: session.csrf_token,
    mfaVerified: session.mfa_verified,
    roles: rolesRes.rows,
    permissions: new Set(permsRes.rows.map((r) => r.permission_code)),
    facilities,
    activeFacilityId,
    isPortal: Boolean(user.patient_id),
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Enforces MFA gating: unverified-MFA sessions may only reach a tiny allowlist. */
export function assertSessionUsable(auth: AuthContext, path: string) {
  const allowed = ['/api/auth/mfa/verify', '/api/auth/mfa/setup', '/api/auth/logout', '/api/auth/me', '/api/auth/sessions'];
  if (auth.user.mfa_enabled && !auth.mfaVerified && !allowed.includes(path)) {
    throw new AppError(403, 'mfa_required', 'يجب إكمال التحقق متعدد العوامل');
  }
}

// NOTE: there is deliberately no "super admin bypass". Administrative accounts
// only hold administrative permissions, so a single account cannot both change
// its own privileges and read clinical records (separation of duties).
export function requirePermission(auth: AuthContext, permission: string) {
  if (!auth.permissions.has(permission)) {
    throw new AppError(403, 'forbidden', `الصلاحية المطلوبة غير متوفرة: ${permission}`);
  }
}

export function hasPermission(auth: AuthContext, permission: string) {
  return auth.permissions.has(permission);
}

export function activeFacility(auth: AuthContext): FacilityRef {
  return auth.facilities.find((f) => f.id === auth.activeFacilityId) ?? auth.facilities[0];
}

export function primaryRole(auth: AuthContext): string {
  return auth.roles[0]?.role_id ?? (auth.isPortal ? 'patient' : 'none');
}
