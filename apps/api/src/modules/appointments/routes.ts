import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, PageQuery, zId } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant, withTenantAudited, nextDocumentNo } from '../../lib/tenant';
import { conflict, forbidden, notFound } from '../../lib/errors';

const BookSchema = z.object({
  patientId: zId,
  departmentId: zId,
  doctorId: zId,
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  durationMinutes: z.number().int().min(5).max(120).default(15),
  reason: z.string().max(300).optional(),
});

export async function appointmentRoutes(app: FastifyInstance) {
  app.get('/api/appointments', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'appointment.read');
    const q = parse(
      PageQuery.extend({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.string().optional(),
        departmentId: zId.optional(),
        doctorId: zId.optional(),
        patientId: zId.optional(),
      }),
      req.query,
    );
    return withTenant(auth, async (db) => {
      const where: string[] = ['a.facility_id = $1'];
      const params: unknown[] = [auth.activeFacilityId];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.date) add(`a.scheduled_at::date = ?::date`, q.date);
      if (q.status) add('a.status = ?', q.status);
      if (q.departmentId) add('a.department_id = ?', q.departmentId);
      if (q.doctorId) add('a.doctor_id = ?', q.doctorId);
      if (q.patientId) add('a.patient_id = ?', q.patientId);
      // Doctors only see their own list unless they hold a management role.
      const isAdminLike = auth.roles.some((r) => ['receptionist', 'system_admin', 'hospital_director', 'department_manager'].includes(r.role_id));
      if (auth.roles.some((r) => r.role_id === 'physician') && !isAdminLike && !q.patientId) {
        add('a.doctor_id = ?', auth.user.id);
      }
      const rows = await db.query(
        `SELECT a.*, p.mrn, p.full_name_ar AS patient_name, p.date_of_birth, p.sex,
                d.name_ar AS department_name, u.full_name_ar AS doctor_name
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           JOIN departments d ON d.id = a.department_id
           JOIN users u ON u.id = a.doctor_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.scheduled_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit ?? 25, ((q.page ?? 1) - 1) * (q.limit ?? 25)],
      );
      const total = await db.query<{ count: string }>(`SELECT count(*) FROM appointments a WHERE ${where.join(' AND ')}`, params);
      return {
        items: rows.rows.map((r: any) => ({
          id: r.id,
          appointmentNo: r.appointment_no,
          patientId: r.patient_id,
          patientName: r.patient_name,
          mrn: r.mrn,
          department: r.department_name,
          departmentId: r.department_id,
          doctor: r.doctor_name,
          doctorId: r.doctor_id,
          scheduledAt: r.scheduled_at,
          durationMinutes: r.duration_minutes,
          status: r.status,
          reason: r.reason,
          checkedInAt: r.checked_in_at,
        })),
        total: Number(total.rows[0]?.count ?? 0),
        page: (q.page ?? 1),
        limit: (q.limit ?? 25),
      };
    });
  });

  app.post('/api/appointments', async (req, reply) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'appointment.create');
    const body = parse(BookSchema, req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const patient = await db.query('SELECT id, facility_id FROM patients WHERE id = $1 AND status = $2', [body.patientId, 'active']);
        if (!patient.rows[0]) throw notFound('المريض غير موجود أو غير نشط');
        const scheduled = new Date(body.scheduledAt);
        if (scheduled.getTime() < Date.now() - 60_000) throw conflict('لا يمكن حجز موعد في الماضي');
        const doctor = await db.query(
          `SELECT u.id FROM users u
             JOIN user_roles ur ON ur.user_id = u.id
            WHERE u.id = $1 AND ur.facility_id = $2 AND u.is_active = true AND ur.role_id IN ('physician','department_manager')`,
          [body.doctorId, auth.activeFacilityId],
        );
        if (!doctor.rows[0]) throw notFound('الطبيب غير متاح في هذه المنشأة');
        const dept = await db.query('SELECT id FROM departments WHERE id = $1 AND is_active = true', [body.departmentId]);
        if (!dept.rows[0]) throw notFound('القسم غير موجود');
        const clash = await db.query(
          `SELECT id FROM appointments WHERE doctor_id = $1 AND scheduled_at = $2 AND status IN ('booked','checked_in','in_consultation')`,
          [body.doctorId, scheduled.toISOString()],
        );
        if (clash.rows[0]) throw conflict('الطبيب محجوز في هذا الوقت');
        const id = crypto.randomUUID();
        const appointmentNo = await nextDocumentNo(db, auth.activeFacilityId, 'appointment', 'APT');
        await db.query(
          `INSERT INTO appointments (id, facility_id, appointment_no, patient_id, department_id, doctor_id,
             scheduled_at, duration_minutes, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, auth.activeFacilityId, appointmentNo, body.patientId, body.departmentId, body.doctorId, scheduled.toISOString(), body.durationMinutes, body.reason ?? null, auth.user.id],
        );
        reply.code(201);
        return { id, appointmentNo, scheduledAt: scheduled.toISOString() };
      },
      (r) => ({
        action: 'appointment.create',
        entityType: 'appointment',
        entityId: r.id,
        patientId: body.patientId,
        detail: { appointmentNo: r.appointmentNo, doctorId: body.doctorId },
        ip: req.ip,
      }),
    );
  });

  app.post('/api/appointments/:id/check-in', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'appointment.checkin');
    const { id } = parse(z.object({ id: zId }), req.params);
    return withTenantAudited(
      auth,
      async (db) => {
        const row = await db.query<{ status: string; patient_id: string; scheduled_at: string }>(
          'SELECT status, patient_id, scheduled_at FROM appointments WHERE id = $1',
          [id],
        );
        const appt = row.rows[0];
        if (!appt) throw notFound('الموعد غير موجود');
        if (appt.status !== 'booked') throw conflict(`لا يمكن تسجيل حضور موعد بحالة ${appt.status}`);
        await db.query(`UPDATE appointments SET status = 'checked_in', checked_in_at = now(), updated_at = now() WHERE id = $1`, [id]);
        return { ok: true };
      },
      () => ({ action: 'appointment.checkin', entityType: 'appointment', entityId: id, ip: req.ip }),
    );
  });

  app.post('/api/appointments/:id/cancel', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'appointment.update');
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(z.object({ reason: z.string().min(3).max(300) }), req.body);
    return withTenantAudited(
      auth,
      async (db) => {
        const row = await db.query<{ status: string; patient_id: string }>('SELECT status, patient_id FROM appointments WHERE id = $1', [id]);
        const appt = row.rows[0];
        if (!appt) throw notFound('الموعد غير موجود');
        if (!['booked', 'checked_in'].includes(appt.status)) throw conflict('لا يمكن إلغاء هذا الموعد في حالته الحالية');
        await db.query(
          `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $1, updated_at = now() WHERE id = $2`,
          [body.reason, id],
        );
        return { ok: true };
      },
      () => ({ action: 'appointment.cancel', entityType: 'appointment', entityId: id, reason: body.reason, ip: req.ip }),
    );
  });

  app.get('/api/reception/queue', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'appointment.read');
    return withTenant(auth, async (db) => {
      const rows = await db.query(
        `SELECT a.id, a.appointment_no, a.status, a.scheduled_at, a.checked_in_at, p.mrn, p.full_name_ar AS patient_name,
                u.full_name_ar AS doctor_name, d.name_ar AS department_name
           FROM appointments a
           JOIN patients p ON p.id = a.patient_id
           JOIN users u ON u.id = a.doctor_id
           JOIN departments d ON d.id = a.department_id
          WHERE a.facility_id = $1 AND a.scheduled_at::date = current_date
            AND a.status IN ('booked','checked_in','in_consultation')
          ORDER BY a.scheduled_at ASC`,
        [auth.activeFacilityId],
      );
      return {
        items: rows.rows.map((r: any) => ({
          id: r.id,
          appointmentNo: r.appointment_no,
          patientName: r.patient_name,
          mrn: r.mrn,
          doctor: r.doctor_name,
          department: r.department_name,
          departmentId: r.department_id,
          scheduledAt: r.scheduled_at,
          checkedInAt: r.checked_in_at,
          status: r.status,
        })),
      };
    });
  });
}
