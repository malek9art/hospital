import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation';
import {
  changePassword,
  confirmMfaSetup,
  listSessions,
  login,
  revokeSession,
  startMfaSetup,
  verifyMfaForSession,
} from '../../auth/service';
import { assertSessionUsable, primaryRole, requireAuth } from '../../auth/context';
import { getDb } from '../../db';
import { config } from '../../config';
import { writeAudit } from '../../lib/audit';
import { AppError, forbidden } from '../../lib/errors';
import { COOKIE_NAME } from '../../lib/constants';

const LoginSchema = z.object({
  email: z.string().email('بريد إلكتروني غير صالح'),
  password: z.string().min(1).max(200),
});

const PasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'كلمة المرور يجب ألا تقل عن 12 حرفًا').max(200),
});

export function setSessionCookie(reply: any, token: string) {
  const cfg = config();
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.COOKIE_SECURE,
    maxAge: cfg.SESSION_ABSOLUTE_HOURS * 3600,
  });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', {
    config: { rateLimit: { max: config().AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const body = parse(LoginSchema, req.body);
    const result = await login(body.email, body.password, req.ip, req.headers['user-agent'] ?? '');
    setSessionCookie(reply, result.token);
    return {
      ok: true,
      mfaRequired: result.mfaRequired,
      mfaEnrollmentRequired: result.mfaEnrollmentRequired,
      csrfToken: result.csrfToken,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await revokeSession(req.auth.sessionId, req.auth.user.id, 'تسجيل خروج');
      const db = await getDb();
      await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) =>
        writeAudit(q, {
          actorUserId: req.auth!.user.id,
          facilityId: req.auth!.activeFacilityId,
          action: 'auth.logout',
          entityType: 'session',
          entityId: req.auth!.sessionId,
          ip: req.ip,
        }),
      );
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const auth = requireAuth(req);
    assertSessionUsable(auth, '/api/auth/me');
    return {
      user: {
        id: auth.user.id,
        email: auth.user.email,
        fullNameAr: auth.user.full_name_ar,
        fullNameEn: auth.user.full_name_en,
        jobTitle: auth.user.job_title_ar,
        preferredLanguage: auth.user.preferred_language,
        isPortal: auth.isPortal,
        patientId: auth.user.patient_id,
      },
      roles: auth.roles,
      primaryRole: primaryRole(auth),
      permissions: [...auth.permissions],
      facilities: auth.facilities,
      activeFacilityId: auth.activeFacilityId,
      mfaEnabled: auth.user.mfa_enabled,
      mfaVerified: auth.mfaVerified,
      csrfToken: auth.csrfToken,
      sessionId: auth.sessionId,
    };
  });

  app.post('/api/auth/mfa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ code: z.string().min(4).max(20) }), req.body);
    await verifyMfaForSession(auth, body.code);
    return { ok: true };
  });

  app.post('/api/auth/mfa/setup', async (req) => {
    const auth = requireAuth(req);
    if (auth.user.mfa_enabled) throw new AppError(400, 'already_enrolled', 'الحساب مفعّل عليه MFA بالفعل');
    const result = await startMfaSetup(auth);
    return result;
  });

  app.post('/api/auth/mfa/confirm', async (req) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ code: z.string().min(6).max(10) }), req.body);
    return confirmMfaSetup(auth, body.code);
  });

  app.post('/api/auth/password', async (req) => {
    const auth = requireAuth(req);
    const body = parse(PasswordSchema, req.body);
    await changePassword(auth.user.id, body.currentPassword, body.newPassword);
    const db = await getDb();
    await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) =>
      writeAudit(q, {
        actorUserId: auth.user.id,
        action: 'auth.password.changed',
        entityType: 'user',
        entityId: auth.user.id,
        ip: req.ip,
      }),
    );
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) => {
    const auth = requireAuth(req);
    const rows = await listSessions(auth.user.id, auth.sessionId);
    return { items: rows };
  });

  app.post('/api/auth/sessions/:id/revoke', async (req) => {
    const auth = requireAuth(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await revokeSession(id, auth.user.id, 'إبطال بواسطة المستخدم');
    const db = await getDb();
    await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) =>
      writeAudit(q, {
        actorUserId: auth.user.id,
        action: 'auth.session.revoked',
        entityType: 'session',
        entityId: id,
        ip: req.ip,
      }),
    );
    return { ok: true };
  });

  app.post('/api/auth/context', async (req, reply) => {
    const auth = requireAuth(req);
    const { facilityId } = parse(z.object({ facilityId: z.string().uuid() }), req.body);
    if (!auth.facilities.some((f) => f.id === facilityId)) throw forbidden('لا تملك صلاحية على هذه المنشأة');
    const db = await getDb();
    await db.query('UPDATE sessions SET facility_id = $1 WHERE id = $2', [facilityId, auth.sessionId]);
    await db.asRole('hms_app', { 'app.facility_ids': auth.facilities.map((f) => f.id).join(',') }, (q) =>
      writeAudit(q, {
        actorUserId: auth.user.id,
        facilityId,
        action: 'auth.context.switch',
        entityType: 'facility',
        entityId: facilityId,
        ip: req.ip,
      }),
    );
    reply.code(200);
    return { ok: true, facilityId };
  });
}
