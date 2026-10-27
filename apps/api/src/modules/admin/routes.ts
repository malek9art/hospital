import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, PageQuery, zId } from '../../lib/validation';
import { requireAuth, requirePermission, activeFacility } from '../../auth/context';
import { withTenant, withTenantAudited } from '../../lib/tenant';
import { getDb } from '../../db';
import { verifyAuditChain, writeAudit } from '../../lib/audit';
import { hashPassword } from '../../lib/crypto';
import { conflict, forbidden, notFound } from '../../lib/errors';

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/users', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.users.read');
    const q = parse(PageQuery.extend({ search: z.string().max(120).optional() }), req.query);
    return withTenant(auth, async (db) => {
      const params: unknown[] = [auth.activeFacilityId];
      let filter = '';
      if (q.search) { params.push(`%${q.search}%`); filter = `AND (u.full_name_ar ILIKE $2 OR u.email ILIKE $2)`; }
      const rows = await db.query(
        `SELECT DISTINCT u.id, u.email, u.full_name_ar, u.job_title_ar, u.is_active, u.mfa_enabled, u.last_login_at,
                array_agg(ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL) AS roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.facility_id = $1
           JOIN user_facilities uf ON uf.user_id = u.id AND uf.facility_id = $1
          WHERE true ${filter}
          GROUP BY u.id ORDER BY u.full_name_ar LIMIT $${params.length + 1}`,
        [...params, (q.limit ?? 25)],
      );
      return { items: rows.rows };
    });
  });

  app.post('/api/admin/users', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.users.manage');
    const b = parse(
      z.object({
        email: z.string().email(),
        fullNameAr: z.string().min(3).max(200),
        fullNameEn: z.string().min(2).max(200),
        jobTitleAr: z.string().max(120).optional(),
        roleId: z.string().min(2).max(50),
        departmentId: zId.optional(),
        temporaryPassword: z.string().min(12).max(200),
      }),
      req.body,
    );
    const facility = activeFacility(auth);
    const db0 = await getDb();
    if (b.roleId === 'system_admin' && !auth.user.is_super_admin) throw forbidden('إسناد دور مدير النظام يتطلب مشرفًا عامًا');
    const role = await db0.query('SELECT id FROM roles WHERE id = $1', [b.roleId]);
    if (!role.rows[0]) throw notFound('الدور غير موجود');
    const existing = await db0.query('SELECT id FROM users WHERE lower(email) = lower($1)', [b.email]);
    if (existing.rows[0]) throw conflict('البريد الإلكتروني مستخدم مسبقًا');
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(b.temporaryPassword);
    return withTenantAudited(
      auth,
      async (db) => {
        await db.query(
          `INSERT INTO users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, must_change_password)
           VALUES ($1, lower($2), $3, $4, $5, $6, true)`,
          [userId, b.email, passwordHash, b.fullNameAr, b.fullNameEn, b.jobTitleAr ?? null],
        );
        await db.query('INSERT INTO user_facilities (user_id, facility_id) VALUES ($1,$2)', [userId, facility.id]);
        await db.query(
          'INSERT INTO user_roles (user_id, role_id, facility_id, department_id, assigned_by) VALUES ($1,$2,$3,$4,$5)',
          [userId, b.roleId, facility.id, b.departmentId ?? null, auth.user.id],
        );
        reply.code(201);
        return { id: userId, email: b.email };
      },
      () => ({ action: 'admin.user.create', entityType: 'user', entityId: userId, detail: { email: b.email, roleId: b.roleId }, ip: req.ip }),
    );
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.users.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const b = parse(z.object({ isActive: z.boolean().optional(), mfaEnforced: z.boolean().optional() }), req.body);
    if (id === auth.user.id && b.isActive === false) throw conflict('لا يمكنك تعطيل حسابك الحالي');
    return withTenantAudited(
      auth,
      async (db) => {
        const user = await db.query('SELECT id FROM users WHERE id = $1', [id]);
        if (!user.rows[0]) throw notFound('المستخدم غير موجود');
        if (b.isActive !== undefined) await db.query('UPDATE users SET is_active = $1, updated_at = now() WHERE id = $2', [b.isActive, id]);
        if (b.mfaEnforced !== undefined) await db.query('UPDATE users SET mfa_enforced = $1 WHERE id = $2', [b.mfaEnforced, id]);
        if (b.isActive === false) await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'تعطيل الحساب' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
        return { ok: true };
      },
      () => ({ action: 'admin.user.update', entityType: 'user', entityId: id, detail: b, ip: req.ip }),
    );
  });

  app.get('/api/admin/roles', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.users.read');
    const db = await getDb();
    const roles = await db.query(`SELECT r.*, (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id)::int AS users FROM roles r ORDER BY r.id`);
    const perms = await db.query(
      `SELECT rp.role_id, rp.permission_code, p.module, p.desc_ar FROM role_permissions rp JOIN permissions p ON p.code = rp.permission_code ORDER BY p.module`,
    );
    return { roles: roles.rows, permissions: perms.rows };
  });

  app.get('/api/audit', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'audit.read');
    const q = parse(
      PageQuery.extend({
        action: z.string().max(80).optional(),
        actorUserId: zId.optional(),
        patientId: zId.optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const where: string[] = ['(facility_id = $1 OR facility_id IS NULL)'];
      const params: unknown[] = [auth.activeFacilityId];
      if (q.action) { params.push(`%${q.action}%`); where.push(`action ILIKE $${params.length}`); }
      if (q.actorUserId) { params.push(q.actorUserId); where.push(`actor_user_id = $${params.length}`); }
      if (q.patientId) { params.push(q.patientId); where.push(`patient_id = $${params.length}`); }
      if (q.from) { params.push(q.from); where.push(`created_at >= $${params.length}::date`); }
      if (q.to) { params.push(q.to); where.push(`created_at < ($${params.length}::date + interval '1 day')`); }
      const rows = await db.query(
        `SELECT a.*, u.full_name_ar AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit ?? 25, ((q.page ?? 1) - 1) * (q.limit ?? 25)],
      );
      const total = await db.query<{ count: string }>(`SELECT count(*) FROM audit_log WHERE ${where.join(' AND ')}`, params);
      return { items: rows.rows, total: Number(total.rows[0]?.count ?? 0), page: (q.page ?? 1), limit: q.limit ?? 25 };
    });
  });

  app.get('/api/audit/verify', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'audit.read');
    const db = await getDb();
    const result = await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) => verifyAuditChain(q));
    await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) =>
      writeAudit(q, {
        actorUserId: auth.user.id,
        facilityId: auth.activeFacilityId,
        action: 'audit.chain.verify',
        entityType: 'audit_log',
        outcome: result.ok ? 'success' : 'failure',
        detail: { checked: result.checked, ok: result.ok },
        ip: req.ip,
      }),
    );
    return result;
  });

  app.get('/api/admin/sessions', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.sessions.manage');
    const db = await getDb();
    const rows = await db.query(
      `SELECT s.id, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.revoked_at, s.revoked_reason,
              u.full_name_ar, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen_at DESC LIMIT 100`,
    );
    return { items: rows.rows };
  });

  app.post('/api/admin/sessions/:id/revoke', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.sessions.manage');
    const { id } = parse(z.object({ id: zId }), req.params);
    const db = await getDb();
    const res = await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'إبطال إداري' WHERE id = $1 AND revoked_at IS NULL`, [id]);
    if (res.rowCount === 0) throw notFound('الجلسة غير موجودة أو مبطة');
    await db.asRole('hms_app', { 'app.facility_ids': '' }, (q) =>
      writeAudit(q, { actorUserId: auth.user.id, facilityId: auth.activeFacilityId, action: 'admin.session.revoke', entityType: 'session', entityId: id, ip: req.ip }),
    );
    return { ok: true };
  });

  app.get('/api/admin/facilities', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'admin.facility.manage');
    const db = await getDb();
    const rows = await db.query('SELECT * FROM facilities ORDER BY name_ar');
    const stats = await db.query(
      `SELECT facility_id, count(*)::int AS users FROM user_facilities GROUP BY facility_id`,
    );
    return { items: rows.rows, stats: stats.rows };
  });
}
