import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation';
import { requireAuth, requirePermission } from '../../auth/context';
import { withTenant } from '../../lib/tenant';
import { writeAudit } from '../../lib/audit';

/**
 * CSV cells are neutralised against spreadsheet formula injection: a value that
 * begins with = + - @ TAB CR is prefixed with a single quote so Excel/Sheets
 * treats it as text. This matters because patient names/notes are user input.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r;]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: Record<string, unknown>[], columns: { key: string; ar: string }[]): string {
  const header = columns.map((c) => csvCell(c.ar)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(',')).join('\r\n');
  // UTF-8 BOM so Excel renders Arabic correctly.
  return `\uFEFF${header}\r\n${body}\r\n`;
}

const RangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

interface ReportDef {
  key: string;
  ar: string;
  permission: string;
  columns: { key: string; ar: string }[];
  sql: (facilityId: string, from: string, to: string) => { text: string; values: unknown[] };
}

const REPORTS: ReportDef[] = [
  {
    key: 'visits',
    ar: 'الزيارات',
    permission: 'report.read',
    columns: [
      { key: 'encounter_no', ar: 'رقم الزيارة' },
      { key: 'mrn', ar: 'رقم الملف' },
      { key: 'patient_name', ar: 'المريض' },
      { key: 'encounter_type', ar: 'نوع الزيارة' },
      { key: 'department', ar: 'القسم' },
      { key: 'doctor', ar: 'الطبيب' },
      { key: 'started_at', ar: 'البداية' },
      { key: 'closed_at', ar: 'الإغلاق' },
      { key: 'status', ar: 'الحالة' },
      { key: 'disposition', ar: 'المصير' },
    ],
    sql: (facilityId, from, to) => ({
      text: `SELECT e.encounter_no, p.mrn, p.full_name_ar AS patient_name, e.encounter_type,
                    d.name_ar AS department, u.full_name_ar AS doctor, e.started_at, e.closed_at, e.status, e.disposition
               FROM encounters e
               JOIN patients p ON p.id = e.patient_id
               JOIN departments d ON d.id = e.department_id
               LEFT JOIN users u ON u.id = e.doctor_id
              WHERE e.facility_id = $1 AND e.started_at::date BETWEEN $2::date AND $3::date
              ORDER BY e.started_at DESC LIMIT 5000`,
      values: [facilityId, from, to],
    }),
  },
  {
    key: 'lab-results',
    ar: 'نتائج المختبر المعتمدة',
    permission: 'report.read',
    columns: [
      { key: 'order_no', ar: 'رقم الطلب' },
      { key: 'mrn', ar: 'رقم الملف' },
      { key: 'patient_name', ar: 'المريض' },
      { key: 'test_code', ar: 'رمز التحليل' },
      { key: 'test_name', ar: 'التحليل' },
      { key: 'value', ar: 'النتيجة' },
      { key: 'unit', ar: 'الوحدة' },
      { key: 'flag', ar: 'التصنيف' },
      { key: 'verified_at', ar: 'الاعتماد' },
    ],
    sql: (facilityId, from, to) => ({
      text: `SELECT lo.order_no, p.mrn, p.full_name_ar AS patient_name, li.test_code, t.name_ar AS test_name,
                    COALESCE(lr.value_numeric::text, lr.value_text) AS value, lr.unit, lr.flag, lr.verified_at
               FROM lab_results lr
               JOIN lab_order_items li ON li.id = lr.order_item_id
               JOIN lab_orders lo ON lo.id = li.order_id
               JOIN lab_tests t ON t.code = li.test_code
               JOIN patients p ON p.id = lo.patient_id
              WHERE lr.facility_id = $1 AND lr.verified_at::date BETWEEN $2::date AND $3::date
              ORDER BY lr.verified_at DESC LIMIT 5000`,
      values: [facilityId, from, to],
    }),
  },
  {
    key: 'revenue',
    ar: 'الإيرادات والتحصيل',
    permission: 'report.finance',
    columns: [
      { key: 'invoice_no', ar: 'الفاتورة' },
      { key: 'mrn', ar: 'رقم الملف' },
      { key: 'patient_name', ar: 'المريض' },
      { key: 'status', ar: 'الحالة' },
      { key: 'subtotal', ar: 'قبل الخصم' },
      { key: 'discount', ar: 'الخصم' },
      { key: 'total', ar: 'الإجمالي' },
      { key: 'paid_amount', ar: 'المدفوع' },
      { key: 'outstanding', ar: 'المتبقي' },
      { key: 'created_at', ar: 'التاريخ' },
    ],
    sql: (facilityId, from, to) => ({
      text: `SELECT i.invoice_no, p.mrn, p.full_name_ar AS patient_name, i.status, i.subtotal, i.discount, i.total,
                    i.paid_amount, (i.total - i.paid_amount) AS outstanding, i.created_at
               FROM invoices i JOIN patients p ON p.id = i.patient_id
              WHERE i.facility_id = $1 AND i.created_at::date BETWEEN $2::date AND $3::date AND i.status <> 'void'
              ORDER BY i.created_at DESC LIMIT 5000`,
      values: [facilityId, from, to],
    }),
  },
  {
    key: 'occupancy',
    ar: 'إشغال الأسرّة',
    permission: 'inpatient.bed.manage',
    columns: [
      { key: 'ward', ar: 'الجناح' },
      { key: 'room_no', ar: 'الغرفة' },
      { key: 'bed_no', ar: 'السرير' },
      { key: 'status', ar: 'الحالة' },
      { key: 'patient_name', ar: 'المريض' },
      { key: 'mrn', ar: 'رقم الملف' },
      { key: 'admitted_at', ar: 'تاريخ الدخول' },
    ],
    sql: (facilityId) => ({
      text: `SELECT w.name_ar AS ward, r.room_no, b.bed_no, b.status, p.full_name_ar AS patient_name, p.mrn, a.admitted_at
               FROM beds b JOIN rooms r ON r.id = b.room_id JOIN wards w ON w.id = b.ward_id
               LEFT JOIN admissions a ON a.bed_id = b.id AND a.status = 'active'
               LEFT JOIN patients p ON p.id = a.patient_id
              WHERE b.facility_id = $1 ORDER BY w.name_ar, r.room_no, b.bed_no`,
      values: [facilityId],
    }),
  },
];

function today(daysBack = 30) {
  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/api/reports', async (req) => {
    const auth = requireAuth(req);
    requirePermission(auth, 'report.read');
    return { reports: REPORTS.map((r) => ({ key: r.key, ar: r.ar, columns: r.columns.map((c) => c.ar) })) };
  });

  app.get('/api/reports/:key', async (req, reply) => {
    const auth = requireAuth(req);
    const { key } = parse(z.object({ key: z.string().max(40) }), req.params);
    const q = parse(RangeQuery, req.query);
    const def = REPORTS.find((r) => r.key === key);
    if (!def) return reply.code(404).send({ error: { code: 'not_found', message: 'التقرير غير معروف' } });
    requirePermission(auth, def.permission);
    const range = { from: q.from ?? today().from, to: q.to ?? today().to };
    if (range.from > range.to) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'تاريخ البداية بعد تاريخ النهاية' } });
    }
    if (q.format === 'csv') requirePermission(auth, 'report.export');

    return withTenant(auth, async (db) => {
      const { text, values } = def.sql(auth.activeFacilityId, range.from, range.to);
      const rows = await db.query<Record<string, unknown>>(text, values);

      if (q.format === 'csv') {
        // Every export is audited with row count and range (data-exfiltration trail).
        await writeAudit(db, {
          facilityId: auth.activeFacilityId,
          actorUserId: auth.user.id,
          actorRole: auth.roles[0]?.role_id ?? null,
          action: 'report.export',
          entityType: 'report',
          entityId: def.key,
          detail: { rows: rows.rows.length, from: range.from, to: range.to, format: 'csv' },
          ip: req.ip,
        });
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="hms-${def.key}-${range.from}-${range.to}.csv"`)
          .header('Cache-Control', 'no-store');
        return reply.send(toCsv(rows.rows, def.columns));
      }

      await writeAudit(db, {
        facilityId: auth.activeFacilityId,
        actorUserId: auth.user.id,
        actorRole: auth.roles[0]?.role_id ?? null,
        action: 'report.view',
        entityType: 'report',
        entityId: def.key,
        detail: { rows: rows.rows.length, from: range.from, to: range.to },
        ip: req.ip,
      });
      return { key: def.key, title: def.ar, range, columns: def.columns, rows: rows.rows, total: rows.rows.length };
    });
  });
}
