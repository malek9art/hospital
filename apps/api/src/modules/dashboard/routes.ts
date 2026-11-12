import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission, hasPermission } from '../../auth/context';
import { withTenant } from '../../lib/tenant';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'report.read');
    return withTenant(auth, async (db) => {
      const cards = await db.query(
        `SELECT
          (SELECT count(*) FROM appointments WHERE facility_id = $1 AND scheduled_at::date = current_date AND status IN ('booked','checked_in','in_consultation')) AS appointments_today,
          (SELECT count(*) FROM encounters WHERE facility_id = $1 AND started_at::date = current_date) AS encounters_today,
          (SELECT count(*) FROM encounters WHERE facility_id = $1 AND status = 'open') AS open_encounters,
          (SELECT count(*) FROM lab_order_items WHERE facility_id = $1 AND status IN ('ordered','collected')) AS pending_labs,
          (SELECT count(*) FROM critical_alerts WHERE facility_id = $1 AND acknowledged_at IS NULL) AS critical_alerts,
          (SELECT count(*) FROM prescriptions WHERE facility_id = $1 AND status IN ('issued','partially_dispensed')) AS pending_prescriptions,
          (SELECT count(*) FROM beds WHERE facility_id = $1) AS beds_total,
          (SELECT count(*) FROM beds WHERE facility_id = $1 AND status = 'occupied') AS beds_occupied,
          (SELECT COALESCE(sum(paid_amount),0) FROM invoices WHERE facility_id = $1 AND created_at::date = current_date) AS collected_today,
          (SELECT COALESCE(sum(total - paid_amount),0) FROM invoices WHERE facility_id = $1 AND status IN ('open','partially_paid')) AS outstanding,
          (SELECT count(*) FROM drug_batches WHERE facility_id = $1 AND qty_on_hand > 0 AND expiry_date < current_date + interval '90 days') AS expiring_batches`,
        [auth.activeFacilityId],
      );
      const byDepartment = await db.query(
        `SELECT d.name_ar, count(e.id)::int AS visits
           FROM departments d LEFT JOIN encounters e ON e.department_id = d.id AND e.started_at::date = current_date
          WHERE d.facility_id = $1 GROUP BY d.id, d.name_ar ORDER BY visits DESC`,
        [auth.activeFacilityId],
      );
      const weekly = await db.query(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                (SELECT count(*) FROM encounters e WHERE e.facility_id = $1 AND e.started_at::date = d.day)::int AS visits,
                (SELECT count(*) FROM appointments a WHERE a.facility_id = $1 AND a.scheduled_at::date = d.day)::int AS appointments
           FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') AS d(day)`,
        [auth.activeFacilityId],
      );
      const notifications = await db.query(
        `SELECT id, subject, body, created_at, related_type, related_id FROM notifications_outbox
          WHERE facility_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT 8`,
        [auth.activeFacilityId],
      );
      const row: any = cards.rows[0] ?? {};
      return {
        kpis: {
          appointmentsToday: Number(row.appointments_today),
          encountersToday: Number(row.encounters_today),
          openEncounters: Number(row.open_encounters),
          pendingLabs: Number(row.pending_labs),
          criticalAlerts: Number(row.critical_alerts),
          pendingPrescriptions: Number(row.pending_prescriptions),
          bedsTotal: Number(row.beds_total),
          bedsOccupied: Number(row.beds_occupied),
          occupancyPct: Number(row.beds_total) ? Math.round((Number(row.beds_occupied) / Number(row.beds_total)) * 100) : 0,
          collectedToday: Number(row.collected_today),
          outstanding: Number(row.outstanding),
          expiringBatches: Number(row.expiring_batches),
        },
        byDepartment: byDepartment.rows,
        weekly: weekly.rows,
        notifications: notifications.rows,
        capabilities: {
          clinical: hasPermission(auth, 'patient.chart.clinical'),
          finance: hasPermission(auth, 'billing.invoice.read'),
        },
      };
    });
  });
}
