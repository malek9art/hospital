import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation';
import { requireAuth, requirePermission, hasPermission } from '../../auth/context';
import { withTenant } from '../../lib/tenant';

const DashboardQuery = z.object({
  days: z.coerce.number().int().refine((n) => n === 7 || n === 30, 'الفترة المتاحة 7 أو 30 يومًا').default(7),
});

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'report.read');
    const q = parse(DashboardQuery, req.query ?? {});
    const days = q.days ?? 7;
    const spanDays = days - 1;

    return withTenant(auth, async (db) => {
      const [cards, byDepartment, weekly, trend, bedsByStatus, bedsByWard, notifications, extraAlerts] = await Promise.all([
        db.query(
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
        ),
        db.query(
          `SELECT d.name_ar, count(e.id)::int AS visits
             FROM departments d LEFT JOIN encounters e ON e.department_id = d.id AND e.started_at::date = current_date
            WHERE d.facility_id = $1 GROUP BY d.id, d.name_ar ORDER BY visits DESC`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  (SELECT count(*) FROM encounters e WHERE e.facility_id = $1 AND e.started_at::date = d.day)::int AS visits,
                  (SELECT count(*) FROM appointments a WHERE a.facility_id = $1 AND a.scheduled_at::date = d.day)::int AS appointments
             FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') AS d(day)`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  (SELECT count(*) FROM encounters e WHERE e.facility_id = $1 AND e.started_at::date = d.day)::int AS visits,
                  (SELECT count(*) FROM encounters e WHERE e.facility_id = $1 AND e.started_at::date = d.day)::int AS encounters,
                  (SELECT count(*) FROM appointments a WHERE a.facility_id = $1 AND a.scheduled_at::date = d.day)::int AS appointments,
                  (SELECT count(*) FROM admissions adm WHERE adm.facility_id = $1 AND adm.admitted_at::date = d.day)::int AS admissions,
                  (SELECT COALESCE(sum(inv.paid_amount), 0)::numeric FROM invoices inv WHERE inv.facility_id = $1 AND inv.created_at::date = d.day)::float8 AS collected
             FROM generate_series(current_date - ($2 || ' days')::interval, current_date, interval '1 day') AS d(day)`,
          [auth.activeFacilityId, String(spanDays)],
        ),
        db.query<{ status: string; count: number }>(
          `SELECT status, count(*)::int AS count
             FROM beds WHERE facility_id = $1 GROUP BY status`,
          [auth.activeFacilityId],
        ),
        db.query<{ ward_name: string; ward_type: string; total: number; occupied: number; available: number; cleaning: number; maintenance: number }>(
          `SELECT w.name_ar AS ward_name, w.ward_type,
                  count(b.id)::int AS total,
                  count(b.id) FILTER (WHERE b.status = 'occupied')::int AS occupied,
                  count(b.id) FILTER (WHERE b.status = 'available')::int AS available,
                  count(b.id) FILTER (WHERE b.status = 'cleaning')::int AS cleaning,
                  count(b.id) FILTER (WHERE b.status = 'maintenance')::int AS maintenance
             FROM wards w LEFT JOIN beds b ON b.ward_id = w.id
            WHERE w.facility_id = $1 AND w.is_active = true
            GROUP BY w.id, w.name_ar, w.ward_type
            ORDER BY w.name_ar`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT id, subject, body, created_at, related_type, related_id FROM notifications_outbox
            WHERE facility_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT 8`,
          [auth.activeFacilityId],
        ),
        db.query(
          `SELECT
             (SELECT count(*)::int FROM imaging_reports WHERE facility_id = $1 AND status = 'final' AND is_critical = true AND acknowledged_at IS NULL) AS critical_imaging,
             (SELECT count(*)::int FROM cssd_packs WHERE facility_id = $1 AND status IN ('quarantined','recalled')) AS quarantined_packs,
             (SELECT count(*)::int FROM infection_cases WHERE facility_id = $1 AND status = 'suspected') AS suspected_infections,
             (SELECT count(*)::int FROM invoices WHERE facility_id = $1 AND status IN ('open','partially_paid')) AS open_invoices,
             (SELECT count(*)::int FROM hr_credentials WHERE facility_id = $1 AND status = 'verified' AND expiry_date BETWEEN current_date AND current_date + 30) AS expiring_credentials,
             (SELECT count(*)::int FROM (
                SELECT i.id
                  FROM inventory_items i
                  LEFT JOIN inventory_stock s ON s.item_id = i.id AND (s.expiry_date IS NULL OR s.expiry_date >= current_date)
                 WHERE i.facility_id = $1 AND i.is_active = true
                 GROUP BY i.id, i.reorder_level
                HAVING COALESCE(SUM(s.qty_on_hand), 0) <= i.reorder_level
             ) low_items) AS low_inventory,
             (SELECT count(*)::int FROM inventory_requisitions WHERE facility_id = $1 AND status = 'pending') AS pending_store_reqs,
             (SELECT count(*)::int FROM physio_referrals WHERE facility_id = $1 AND status = 'referred') AS pending_physio`,
          [auth.activeFacilityId],
        ),
      ]);

      const row = (cards.rows[0] ?? {}) as Record<string, unknown>;
      const ex = (extraAlerts.rows[0] ?? {}) as Record<string, unknown>;
      const statusCounts: Record<string, number> = { available: 0, occupied: 0, cleaning: 0, maintenance: 0 };
      for (const s of bedsByStatus.rows) statusCounts[s.status] = Number(s.count);

      const criticalLabCount = Number(row.critical_alerts ?? 0);
      const criticalImgCount = Number(ex.critical_imaging ?? 0);
      const quarantinedPacks = Number(ex.quarantined_packs ?? 0);
      const suspectedInfections = Number(ex.suspected_infections ?? 0);
      const expiringBatches = Number(row.expiring_batches ?? 0);
      const pendingRx = Number(row.pending_prescriptions ?? 0);
      const openInvoices = Number(ex.open_invoices ?? 0);
      const expiringCredentials = Number(ex.expiring_credentials ?? 0);
      const lowInventory = Number(ex.low_inventory ?? 0);
      const pendingStoreReqs = Number(ex.pending_store_reqs ?? 0);
      const pendingPhysio = Number(ex.pending_physio ?? 0);

      const actionableAlerts = [
        criticalLabCount > 0 && {
          key: 'critical_labs',
          title: 'نتائج مختبر حرجة بانتظار الإقرار',
          count: criticalLabCount,
          severity: 'danger',
          route: '#/lab',
          perm: 'lab.critical.ack',
        },
        criticalImgCount > 0 && {
          key: 'critical_imaging',
          title: 'تقارير أشعة حرجة غير مستلمة',
          count: criticalImgCount,
          severity: 'danger',
          route: '#/radiology',
          perm: 'radiology.read',
        },
        quarantinedPacks > 0 && {
          key: 'cssd_quarantined',
          title: 'حزم تعقيم محجوزة أو مسحوبة',
          count: quarantinedPacks,
          severity: 'warning',
          route: '#/cssd',
          perm: 'cssd.read',
        },
        suspectedInfections > 0 && {
          key: 'infection_suspected',
          title: 'حالات عدوى مشتبهة بانتظار المراجعة',
          count: suspectedInfections,
          severity: 'warning',
          route: '#/cssd',
          perm: 'infection.read',
        },
        lowInventory > 0 && {
          key: 'low_inventory',
          title: 'أصناف مخزنية دون حد إعادة الطلب',
          count: lowInventory,
          severity: 'warning',
          route: '#/inventory',
          perm: 'inventory.read',
        },
        pendingStoreReqs > 0 && {
          key: 'pending_store_reqs',
          title: 'طلبات صرف مخزني للأقسام بانتظار التجهيز',
          count: pendingStoreReqs,
          severity: 'info',
          route: '#/inventory',
          perm: 'inventory.read',
        },
        pendingPhysio > 0 && {
          key: 'pending_physio',
          title: 'تحويلات علاج طبيعي بانتظار التقييم',
          count: pendingPhysio,
          severity: 'info',
          route: '#/physiotherapy',
          perm: 'physio.read',
        },
        expiringBatches > 0 && {
          key: 'expiring_drugs',
          title: 'دفعات أدوية تنتهي خلال ٩٠ يومًا',
          count: expiringBatches,
          severity: 'warning',
          route: '#/pharmacy',
          perm: 'pharmacy.prescription.read',
        },
        expiringCredentials > 0 && {
          key: 'expiring_credentials',
          title: 'تراخيص مزاولة صحية تنتهي خلال ٣٠ يومًا',
          count: expiringCredentials,
          severity: 'warning',
          route: '#/hr',
          perm: 'hr.read',
        },
        pendingRx > 0 && {
          key: 'pending_rx',
          title: 'وصفات طبية بانتظار الصرف',
          count: pendingRx,
          severity: 'info',
          route: '#/pharmacy',
          perm: 'pharmacy.prescription.read',
        },
        openInvoices > 0 && {
          key: 'open_invoices',
          title: 'فواتير مفتوحة بانتظار التحصيل',
          count: openInvoices,
          severity: 'info',
          route: '#/billing',
          perm: 'billing.invoice.read',
        },
      ].filter((x): x is Exclude<typeof x, false> => Boolean(x));

      return {
        days,
        kpis: {
          appointmentsToday: Number(row.appointments_today ?? 0),
          encountersToday: Number(row.encounters_today ?? 0),
          openEncounters: Number(row.open_encounters ?? 0),
          pendingLabs: Number(row.pending_labs ?? 0),
          criticalAlerts: criticalLabCount,
          pendingPrescriptions: pendingRx,
          bedsTotal: Number(row.beds_total ?? 0),
          bedsOccupied: Number(row.beds_occupied ?? 0),
          bedsAvailable: statusCounts.available ?? 0,
          bedsCleaning: statusCounts.cleaning ?? 0,
          bedsMaintenance: statusCounts.maintenance ?? 0,
          occupancyPct: Number(row.beds_total) ? Math.round((Number(row.beds_occupied) / Number(row.beds_total)) * 100) : 0,
          collectedToday: Number(row.collected_today ?? 0),
          outstanding: Number(row.outstanding ?? 0),
          expiringBatches,
        },
        bedsByStatus: statusCounts,
        bedsByWard: bedsByWard.rows,
        byDepartment: byDepartment.rows,
        weekly: weekly.rows,
        trend: trend.rows,
        actionableAlerts,
        notifications: notifications.rows,
        capabilities: {
          clinical: hasPermission(auth, 'patient.chart.clinical'),
          finance: hasPermission(auth, 'billing.invoice.read'),
        },
      };
    });
  });
}
