import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../auth/context';
import { withTenant } from '../../lib/tenant';

/** Single source of truth for honest module delivery status shown in the UI. */
export const MODULE_STATUS = [
  { key: 'patients', ar: 'إدارة المرضى والسجل الطبي', status: 'implemented', note: 'تسجيل، بحث، حساسية، أمراض مزمنة، دمج مدقق، سجل اطلاع' },
  { key: 'appointments', ar: 'الاستقبال والمواعيد', status: 'implemented', note: 'حجز، منع التعارض، حضور، إلغاء، قائمة انتظار' },
  { key: 'opd', ar: 'العيادات الخارجية', status: 'implemented', note: 'زيارات، علامات حيوية، SOAP، تشخيص ICD-10، أوامر، وصفات، إغلاق' },
  { key: 'labs', ar: 'المختبرات', status: 'implemented', note: 'طلب، عينة، نتيجة، قيم حرجة، اعتماد منفصل، تصحيح مدقق' },
  { key: 'pharmacy', ar: 'الصيدلية', status: 'implemented', note: 'صرف FEFO، مخزون ودفعات، تحذير حساسية/تداخل، منع التكرار' },
  { key: 'billing', ar: 'الفوترة والمدفوعات', status: 'implemented', note: 'فواتير تلقائية، دفع idempotent، إلغاء مدقق' },
  { key: 'insurance', ar: 'التأمين', status: 'partial', note: 'بوليصات ومطالبات داخلية؛ لا يوجد ربط إلكتروني بجهة تأمين' },
  { key: 'inpatient', ar: 'التنويم والأسرة', status: 'partial', note: 'بيانات الأجنحة والأسرة موجودة؛ شاشة تنويم/نقل/خروج غير مكتملة' },
  { key: 'emergency', ar: 'الطوارئ', status: 'partial', note: 'نوع زيارة طوارئ وفرز مدعوم في البيانات؛ لوحة فرز مخصصة غير مكتملة' },
  { key: 'nursing', ar: 'التمريض', status: 'partial', note: 'علامات حيوية وملاحظات؛ خطط رعاية وتسليم مناوبات غير مكتملة' },
  { key: 'radiology', ar: 'الأشعة وPACS', status: 'not_implemented', note: 'لا يوجد تكامل DICOM/PACS فعلي' },
  { key: 'surgery', ar: 'العمليات والتخدير', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'icu', ar: 'العناية المركزة', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'bloodbank', ar: 'بنك الدم', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'nutrition', ar: 'التغذية الطبية', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'cssd', ar: 'التعقيم ومكافحة العدوى', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'hr', ar: 'الموارد البشرية', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'procurement', ar: 'المخازن والمشتريات', status: 'partial', note: 'مخزون أدوية وحركات فقط' },
  { key: 'assets', ar: 'الأصول والصيانة', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'quality', ar: 'الجودة والامتثال', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية' },
  { key: 'finance', ar: 'الإدارة المالية', status: 'partial', note: 'تحصيل وفواتير؛ دفتر أستاذ ومراكز تكلفة غير مكتملة' },
  { key: 'reports', ar: 'التقارير والتصدير', status: 'partial', note: 'لوحة مؤشرات وتصدير CSV مدقق؛ PDF عبر الطباعة' },
  { key: 'multifacility', ar: 'إدارة الفروع', status: 'implemented', note: 'عزل بيانات بـ RLS وتبديل منشأة حسب العضوية' },
  { key: 'portal', ar: 'بوابة المرضى', status: 'partial', note: 'اطلاع على المواعيد والنتائج المعتمدة والفواتير؛ لا حجز/دفع إلكتروني' },
  { key: 'integrations', ar: 'التكامل والإشعارات', status: 'partial', note: 'FHIR R4 جزئي، outbox إشعارات بدون مزود بريد/SMS' },
  { key: 'analytics', ar: 'التحليلات', status: 'implemented', note: 'مؤشرات تشغيلية حقيقية من قاعدة البيانات' },
  { key: 'radiology_orders', ar: 'طلبات الأشعة', status: 'not_implemented', note: 'غير منفذة' },
] as const;

export async function metaRoutes(app: FastifyInstance) {
  app.get('/api/meta/modules', async (req) => {
    requireAuth(req);
    return { modules: MODULE_STATUS };
  });

  app.get('/api/meta/bootstrap', async (req) => {
    const auth = requireAuth(req);
    return withTenant(auth, async (db) => {
      const [departments, doctors, tests, drugs, pricing] = await Promise.all([
        db.query(`SELECT id, code, name_ar, name_en, dept_type FROM departments WHERE is_active = true ORDER BY name_ar`),
        db.query(
          `SELECT DISTINCT u.id, u.full_name_ar, ur.department_id, ur.role_id
             FROM users u JOIN user_roles ur ON ur.user_id = u.id
            WHERE ur.facility_id = $1 AND u.is_active = true AND ur.role_id IN ('physician','department_manager')
            ORDER BY u.full_name_ar`,
          [auth.activeFacilityId],
        ),
        db.query(`SELECT code, name_ar, name_en, specimen, unit, ref_low, ref_high, price FROM lab_tests ORDER BY name_ar`),
        db.query(`SELECT id, code, name_ar, name_en, form, strength, price FROM drugs WHERE is_active = true ORDER BY name_ar`),
        db.query(`SELECT key, value FROM app_settings WHERE facility_id = $1`, [auth.activeFacilityId]),
      ]);
      return {
        departments: departments.rows,
        doctors: doctors.rows,
        labTests: tests.rows,
        drugs: drugs.rows,
        pricing: Object.fromEntries(pricing.rows.map((r: any) => [r.key, r.value])),
        serverTime: new Date().toISOString(),
      };
    });
  });
}
