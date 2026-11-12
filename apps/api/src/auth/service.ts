import crypto from 'node:crypto';
import { getDb } from '../db';
import { config } from '../config';
import {
  decryptField,
  encryptField,
  hashPassword,
  hmacToken,
  randomToken,
  sha256Hex,
  verifyPassword,
  timingSafeEqual,
} from '../lib/crypto';
import { AppError, forbidden, tooMany, unauthorized } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import type { AuthContext } from './context';

export interface LoginResult {
  token: string;
  csrfToken: string;
  mfaRequired: boolean;
  mfaEnrollmentRequired: boolean;
}

function sessionTtl() {
  const cfg = config();
  const idle = new Date(Date.now() + cfg.SESSION_IDLE_MINUTES * 60_000).toISOString();
  const absolute = new Date(Date.now() + cfg.SESSION_ABSOLUTE_HOURS * 3_600_000).toISOString();
  return { idle, absolute };
}

export async function createSession(opts: {
  userId: string;
  facilityId: string;
  mfaVerified: boolean;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; csrfToken: string; sessionId: string }> {
  const db = await getDb();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const sessionId = crypto.randomUUID();
  const { idle, absolute } = sessionTtl();
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, facility_id, ip, user_agent,
       mfa_verified, idle_expires_at, absolute_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [sessionId, opts.userId, hmacToken(token), csrfToken, opts.facilityId, opts.ip ?? null, opts.userAgent ?? null, opts.mfaVerified, idle, absolute],
  );
  return { token, csrfToken, sessionId };
}

interface LoginRow {
  id: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | null;
  mfa_enabled: boolean;
  mfa_enforced: boolean;
  mfa_secret_enc: string | null;
}

export async function login(email: string, password: string, ip: string, userAgent: string): Promise<LoginResult> {
  const db = await getDb();
  const cfg = config();
  const res = await db.query<LoginRow>(
    `SELECT id, email, password_hash, is_active, failed_login_count, locked_until, mfa_enabled, mfa_enforced, mfa_secret_enc
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const user = res.rows[0];
  const generic = new Error('بيانات الدخول غير صحيحة');

  if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await recordLoginAudit(db, null, email, ip, userAgent, 'denied', 'الحساب مقفل مؤقتًا');
    throw tooMany('الحساب مقفل مؤقتًا بسبب محاولات دخول فاشلة. حاول لاحقًا.');
  }

  const ok = user ? await verifyPassword(user.password_hash, password) : await verifyPassword(DUMMY_HASH, password);
  if (!user || !ok || !user.is_active) {
    if (user) {
      const failures = user.failed_login_count + 1;
      const locked = failures >= cfg.LOGIN_MAX_ATTEMPTS
        ? new Date(Date.now() + cfg.LOGIN_LOCK_MINUTES * 60_000).toISOString()
        : null;
      await db.query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3', [
        locked ? 0 : failures,
        locked,
        user.id,
      ]);
      await recordLoginAudit(db, user.id, email, ip, userAgent, 'denied', locked ? 'قفل الحساب بعد محاولات فاشلة' : 'كلمة مرور غير صحيحة');
    } else {
      await recordLoginAudit(db, null, email, ip, userAgent, 'denied', 'حساب غير موجود');
    }
    throw new AppError(401, 'invalid_credentials', generic.message);
  }

  await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const facilities = await db.query<{ facility_id: string }>(
    'SELECT facility_id FROM user_facilities WHERE user_id = $1 LIMIT 1',
    [user.id],
  );
  const patientRow = await db.query<{ patient_id: string | null }>('SELECT patient_id FROM users WHERE id = $1', [user.id]);
  if (!facilities.rows[0] && !patientRow.rows[0]?.patient_id) {
    throw forbidden('الحساب غير مرتبط بأي منشأة');
  }
  const facilityId = facilities.rows[0]?.facility_id
    ?? (await db.query<{ facility_id: string }>('SELECT facility_id FROM patients WHERE id = $1', [patientRow.rows[0]!.patient_id!])).rows[0]!.facility_id;

  const mfaVerified = !user.mfa_enabled;
  const session = await createSession({
    userId: user.id,
    facilityId,
    mfaVerified,
    ip,
    userAgent,
  });
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await recordLoginAudit(db, user.id, email, ip, userAgent, 'success', user.mfa_enabled ? 'تم إرسال تحدي MFA' : 'تسجيل دخول');

  return {
    token: session.token,
    csrfToken: session.csrfToken,
    mfaRequired: user.mfa_enabled && !mfaVerified,
    mfaEnrollmentRequired: user.mfa_enforced && !user.mfa_enabled,
  };
}

const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3g2mS8HnBr1n0zs1sZ2i8r3O0nQ2Fbq0i1b9G3Qx0yM';

async function recordLoginAudit(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string | null,
  email: string,
  ip: string,
  userAgent: string,
  outcome: 'success' | 'denied',
  reason: string,
) {
  await db.asRole('hms_app', { 'app.facility_ids': '' }, async (q) => {
    await writeAudit(q, {
      actorUserId: userId,
      action: 'auth.login',
      entityType: 'user',
      entityId: userId,
      outcome,
      reason: `${reason} (${email})`,
      ip,
      userAgent,
    });
  });
}

export async function verifyMfaForSession(auth: AuthContext, code: string) {
  const db = await getDb();
  const row = await db.query<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(
    'SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1',
    [auth.user.id],
  );
  const secret = decryptField(row.rows[0]?.mfa_secret_enc, `users.mfa_secret_enc:${auth.user.id}`);
  if (!secret) throw new AppError(400, 'mfa_not_configured', 'لم يتم إعداد MFA لهذا الحساب');
  const clean = code.replace(/[\s-]/g, '');
  let valid = verifyTotp(secret, clean);
  if (!valid) valid = await consumeRecoveryCode(auth.user.id, clean);
  if (!valid) throw new AppError(401, 'invalid_mfa_code', 'رمز التحقق غير صحيح');
  await db.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [auth.sessionId]);
  await db.asRole('hms_app', { 'app.facility_ids': '' }, async (q) => {
    await writeAudit(q, {
      actorUserId: auth.user.id,
      action: 'auth.mfa.verify',
      entityType: 'session',
      entityId: auth.sessionId,
      outcome: 'success',
    });
  });
}

export async function startMfaSetup(auth: AuthContext) {
  const secret = generateTotpSecret();
  const encrypted = encryptField(secret, `users.mfa_secret_enc:${auth.user.id}`);
  const db = await getDb();
  await db.query('UPDATE users SET mfa_secret_enc = $1, mfa_enabled = false WHERE id = $2', [encrypted, auth.user.id]);
  return { secret, otpauth: otpauthUrl(secret, auth.user.email) };
}

export async function confirmMfaSetup(auth: AuthContext, code: string) {
  const db = await getDb();
  const row = await db.query<{ mfa_secret_enc: string | null }>('SELECT mfa_secret_enc FROM users WHERE id = $1', [auth.user.id]);
  const secret = decryptField(row.rows[0]?.mfa_secret_enc, `users.mfa_secret_enc:${auth.user.id}`);
  if (!secret) throw new AppError(400, 'mfa_not_configured', 'ابدأ إعداد MFA أولًا');
  if (!verifyTotp(secret, code)) throw new AppError(400, 'invalid_mfa_code', 'رمز التحقق غير صحيح');
  const codes = Array.from({ length: 8 }, () => randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase());
  await db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [auth.user.id]);
  await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [auth.user.id]);
  for (const c of codes) {
    await db.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [auth.user.id, sha256Hex(c)]);
  }
  await db.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [auth.sessionId]);
  await db.asRole('hms_app', { 'app.facility_ids': '' }, async (q) => {
    await writeAudit(q, {
      actorUserId: auth.user.id,
      action: 'auth.mfa.enrolled',
      entityType: 'user',
      entityId: auth.user.id,
      outcome: 'success',
    });
  });
  return { recoveryCodes: codes };
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  if (!/^[A-Z0-9]{10}$/.test(code)) return false;
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    'SELECT id FROM user_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
    [userId, sha256Hex(code)],
  );
  if (!res.rows[0]) return false;
  await db.query('UPDATE user_recovery_codes SET used_at = now() WHERE id = $1', [res.rows[0].id]);
  return true;
}

export async function revokeSession(sessionId: string, userId: string, reason: string) {
  const db = await getDb();
  await db.query(
    'UPDATE sessions SET revoked_at = now(), revoked_reason = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL',
    [reason, sessionId, userId],
  );
}

export function csrfMatches(expected: string, provided: string | undefined) {
  if (!provided) return false;
  return timingSafeEqual(expected, provided);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const db = await getDb();
  const row = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!row.rows[0] || !(await verifyPassword(row.rows[0].password_hash, currentPassword))) {
    throw unauthorized('كلمة المرور الحالية غير صحيحة');
  }
  const hash = await hashPassword(newPassword);
  await db.query(
    'UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = now(), updated_at = now() WHERE id = $2',
    [hash, userId],
  );
  await db.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $$password changed$$ WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function listSessions(userId: string, currentSessionId: string) {
  const db = await getDb();
  const res = await db.query(
    `SELECT id, ip, user_agent, created_at, last_seen_at, idle_expires_at, revoked_at, revoked_reason,
            (id = $2) AS is_current
       FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId, currentSessionId],
  );
  return res.rows;
}
