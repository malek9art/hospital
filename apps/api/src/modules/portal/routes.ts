import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../auth/context';
import { withTenant } from '../../lib/tenant';
import { forbidden } from '../../lib/errors';

export async function portalRoutes(app: FastifyInstance) {
  app.get('/api/portal/summary', async (req) => {
    const auth = requireAuth(req);
    if (!auth.isPortal || !auth.user.patient_id) throw forbidden('هذه البوابة متاحة لحسابات المرضى فقط');
    return withTenant(auth, async (db) => {
      // RLS (hms_portal policies) restricts every row to this patient.
      const patient = await db.query(
        `SELECT id, mrn, full_name_ar, date_of_birth, sex, blood_type FROM patients WHERE id = $1`,
        [auth.user.patient_id],
      );
      const appointments = await db.query(
        `SELECT a.id, a.appointment_no, a.scheduled_at, a.status, d.name_ar AS department, u.full_name_ar AS doctor
           FROM appointments a JOIN departments d ON d.id = a.department_id JOIN portal_clinicians u ON u.id = a.doctor_id
          ORDER BY a.scheduled_at DESC LIMIT 20`,
      );
      const results = await db.query(
        `SELECT lr.id, lr.value_numeric, lr.value_text, lr.unit, lr.flag, lr.verified_at, t.name_ar AS test_name
           FROM lab_results lr
           JOIN lab_order_items li ON li.id = lr.order_item_id
           JOIN lab_orders lo ON lo.id = li.order_id
           JOIN lab_tests t ON t.code = li.test_code
          WHERE lr.verified_at IS NOT NULL ORDER BY lr.verified_at DESC LIMIT 30`,
      );
      const prescriptions = await db.query(
        `SELECT p.prescription_no, p.status, p.prescribed_at,
                json_agg(json_build_object('drug', d.name_ar, 'dose', pi.dose, 'frequency', pi.frequency,
                  'durationDays', pi.duration_days, 'status', pi.status)) AS items
           FROM prescriptions p JOIN prescription_items pi ON pi.prescription_id = p.id
           JOIN drugs d ON d.id = pi.drug_id
          GROUP BY p.id ORDER BY p.prescribed_at DESC LIMIT 10`,
      );
      const invoices = await db.query(
        `SELECT invoice_no, status, total, paid_amount, currency, created_at FROM invoices ORDER BY created_at DESC LIMIT 10`,
      );
      const allergies = await db.query(`SELECT allergen, severity FROM patient_allergies WHERE is_active = true`);
      return {
        patient: patient.rows[0],
        appointments: appointments.rows,
        results: results.rows,
        prescriptions: prescriptions.rows,
        invoices: invoices.rows,
        allergies: allergies.rows,
        notice: 'تُعرض النتائج المعتمدة فقط. لا يمكن تعديل البيانات من البوابة.',
      };
    });
  });
}
