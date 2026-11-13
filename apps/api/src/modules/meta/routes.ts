import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation';
import { requireAuth, hasPermission } from '../../auth/context';
import { withTenant } from '../../lib/tenant';

export interface ModuleStatusEntry {
  key: string;
  ar: string;
  status: 'implemented' | 'partial' | 'not_implemented';
  note: string;
  missing?: string;
  route?: string;
}

/** Single source of truth for honest module delivery status shown in the UI. */
export const MODULE_STATUS: readonly ModuleStatusEntry[] = [
  { key: 'patients', ar: 'إدارة المرضى والسجل الطبي', status: 'implemented', route: '#/patients', note: 'تسجيل، بحث، حساسية، أمراض مزمنة، دمج مدقق، سجل اطلاع', missing: 'لا يوجد ربط بالهوية الوطنية (نفاذ/أبشر) ولا ترميز SNOMED CT كامل.' },
  { key: 'appointments', ar: 'الاستقبال والمواعيد', status: 'implemented', route: '#/appointments', note: 'حجز، منع التعارض، حضور، إلغاء، قائمة انتظار', missing: 'لا توجد تذكيرات SMS/بريد إلكتروني خارجية.' },
  { key: 'opd', ar: 'العيادات الخارجية', status: 'implemented', route: '#/clinic', note: 'زيارات، علامات حيوية، SOAP، تشخيص ICD-10، أوامر، وصفات، إغلاق', missing: 'رموز ICD-10 إدخال نصي بلا قاموس ICD-10-CM كامل.' },
  { key: 'labs', ar: 'المختبرات', status: 'implemented', route: '#/lab', note: 'طلب، عينة، نتيجة، قيم حرجة، اعتماد منفصل، تصحيح مدقق', missing: 'لا يوجد ربط آلي بأجهزة التحليل المخبري (LIS/ASTM/HL7).' },
  { key: 'pharmacy', ar: 'الصيدلية', status: 'implemented', route: '#/pharmacy', note: 'صرف FEFO، مخزون ودفعات، تحذير حساسية/تداخل، منع التكرار', missing: 'لا يوجد تكامل مع نظام رصد الدوائي الوطني أو قارئ باركود خارجي.' },
  { key: 'billing', ar: 'الفوترة والمدفوعات', status: 'implemented', route: '#/billing', note: 'فواتير تلقائية، دفع idempotent، إلغاء مدقق', missing: 'لا توجد فوترة إلكترونية ضريبية (ZATCA) ولا بوابة دفع بنكي.' },
  { key: 'insurance', ar: 'التأمين', status: 'partial', route: '#/billing', note: 'بوليصات ومطالبات داخلية؛ لا يوجد ربط إلكتروني بجهة تأمين', missing: 'ينقص الربط الفعلي مع نفيس (NPHIES) أو شركات التأمين، والتحقق الآلي من الأهلية والموافقات المسبقة.' },
  { key: 'inpatient', ar: 'التنويم وإدارة الأسرة', status: 'implemented', route: '#/inpatient', note: 'تنويم بأمر طبيب، تخصيص سرير، نقل، خروج بملخص، احتساب أيام الإقامة، حالات الأسرّة', missing: 'لا توجد شاشة نداء ممرضات (Nurse Call) مدمجة.' },
  { key: 'emergency', ar: 'الطوارئ والفرز', status: 'implemented', route: '#/emergency', note: 'لوحة فرز ESI 1-5، وصول مجهول الهوية مع مطابقة لاحقة، إعادة فرز مسببة، تحويل للتنويم أو خروج/تحويل بملخص', missing: 'لا يوجد ربط مع الهلال الأحمر أو سيارات الإسعاف قبل الوصول.' },
  { key: 'nursing', ar: 'التمريض', status: 'implemented', route: '#/nursing', note: 'لوحة أسرّة، سجل إعطاء أدوية (MAR) بحقوق الإعطاء الخمسة وشاهد للأدوية عالية الخطورة، خطط رعاية بمهام مجدولة، وتسليم مناوبة SBAR', missing: 'لا يوجد ربط بمضخات الحقن الذكية أو مسح باركود سوار المريض.' },
  { key: 'radiology', ar: 'الأشعة والتقارير', status: 'partial', route: '#/radiology', note: 'طلب وتنفيذ وتقرير معتمد ونتائج حرجة — لا يوجد تكامل DICOM/PACS فعلي بعد', missing: 'ينقص خادم وعارض صور DICOM/PACS، وقوائم عمل Modality Worklist، وحساب الجرعة الإشعاعية.' },
  { key: 'surgery', ar: 'العمليات والتخدير', status: 'implemented', route: '#/surgery', note: 'جدولة غرف العمليات بمنع التعارض، قوائم التحقق العالمية (WHO) قبل التخدير وقبل الشق وبعد العملية، سجل تخدير ملحق، عدّ الأدوات والإبر، وإفاقة ألدريتي مع رسوم العملية والتخدير', missing: 'لا يوجد سحب تلقائي للعلامات الحيوية من أجهزة التخدير ولا سجل زرعات جراحية (Implants).' },
  { key: 'icu', ar: 'العناية المركزة', status: 'implemented', route: '#/icu', note: 'إقامة عناية على سرير ICU، سجل علامات حيوية وRASS/GCS ملحق، إعدادات تنفس صناعي بإصدارات، حزمة رعاية يومية، ودرجة SOFA محسوبة على الخادم', missing: 'لا يوجد ربط مباشر بأجهزة المراقبة/التنفس، ولا حساب APACHE II / SAPS.' },
  { key: 'bloodbank', ar: 'بنك الدم', status: 'implemented', route: '#/bloodbank', note: 'متبرعون مفحوصون، مخزون وحدات بتاريخ صلاحية، طلب طبي، فحص توافق ABO/Rh محسوب على الخادم، صرف، نقل بمدقق ثانٍ، وتتبع كامل مع تفاعلات وحجر الوحدة', missing: 'لا فحص أجسام مضادة غير متوقعة (Antibody Screen/Titre)، ولا ترميز ISBT 128، ولا ربط ببنك دم وطني.' },
  { key: 'nutrition', ar: 'التغذية الطبية', status: 'implemented', route: '#/nutrition', note: 'فحص تغذية تمريضي، تقييم وأهداف أخصائي التغذية، أمر تغذية مُتحقَّق من الحساسية، توليد صواني الوجبات وتتبع التحضير والتسليم والاستهلاك، وتغذية أنبوبية/وريدية بأوامر مُصدَرة', missing: 'لا قاعدة تراكيب غذائية تفصيلية ولا مخزون مطبخ؛ توزيع الطاقة ثابت ٢٥/٣٥/٣٠/١٠٪ وأهداف السعرات تقديرية.' },
  { key: 'cssd', ar: 'التعقيم ومكافحة العدوى', status: 'implemented', route: '#/cssd', note: 'دورة تعقيم كاملة (استلام ملوّث → غسل → تغليف → دورة تعقيم بمؤشرات → اعتماد من شخص آخر → إفراج بصلاحية → صرف وربط بالعملية → إعادة), سحب/حجر عند فشل المؤشر، وأوامر عزل وترصد عدوى مرتبطة بالرعاية ومراقبة نظافة الأيدي', missing: 'لا تكامل مع أجهزة الأوتوكلاف (المؤشرات يدوية)، ولا تتبع فردي للأداة داخل الطقم، وحالات العدوى وصفية بلا معدلات NHSN/CDC معدّلة.' },
  { key: 'hr', ar: 'الموارد البشرية', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية', missing: 'ينقص سجل الموظفين، التعاقدات، الرخص المهنية وتنبيهات انتهائها، جداول الورديات، الإجازات، وتقييم الأداء.' },
  { key: 'procurement', ar: 'المخازن والمشتريات', status: 'partial', route: '#/pharmacy', note: 'مخزون أدوية وحركات فقط', missing: 'ينقص كتالوج الأصناف الطبية/العامة غير الدوائية، المستودعات المتعددة، حد إعادة الطلب، ودورة الشراء (طلب شراء → أمر شراء → استلام → فاتورة مورد).' },
  { key: 'assets', ar: 'الأصول والصيانة', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية', missing: 'ينقص سجل الأجهزة الطبية والتقنية، الصيانة الوقائية الدورية، أوامر العمل التصحيحية، وتواريخ المعايرة.' },
  { key: 'quality', ar: 'الجودة والامتثال', status: 'not_implemented', note: 'خارج نطاق الدفعة الحالية', missing: 'ينقص سجل مؤشرات الجودة، التدقيقات الداخلية، تقارير الحوادث العرضية (OVR)، والإجراءات التصحيحية (CAPA).' },
  { key: 'finance', ar: 'الإدارة المالية', status: 'partial', route: '#/billing', note: 'تحصيل وفواتير؛ دفتر أستاذ ومراكز تكلفة غير مكتملة', missing: 'ينقص شجرة الحسابات، دفتر الأستاذ العام، مراكز التكلفة، سندات القبض/الصرف، والتسوية المالية.' },
  { key: 'reports', ar: 'التقارير والتصدير', status: 'partial', route: '#/reports', note: 'لوحة مؤشرات وتصدير CSV مدقق؛ PDF عبر الطباعة', missing: 'ينقص محرك توليد PDF خادمي موقّع رقميًا وجدولة إرسال التقارير الدورية.' },
  { key: 'multifacility', ar: 'إدارة الفروع', status: 'implemented', route: '#/admin', note: 'عزل بيانات بـ RLS وتبديل منشأة حسب العضوية', missing: 'لا توجد تحويلات مخزنية أو سريرية عابرة للمنشآت بعد.' },
  { key: 'portal', ar: 'بوابة المرضى', status: 'partial', route: '#/portal', note: 'اطلاع على المواعيد والنتائج المعتمدة والفواتير؛ لا حجز/دفع إلكتروني', missing: 'ينقص حجز/إلغاء المواعيد ذاتيًا، طلب تجديد الوصفات، والدفع الإلكتروني.' },
  { key: 'integrations', ar: 'التكامل والإشعارات', status: 'partial', note: 'FHIR R4 جزئي، outbox إشعارات بدون مزود بريد/SMS', missing: 'ينقص تغطية موارد FHIR الكاملة ومزوّد إرسال فعلي للبريد والرسائل القصيرة.' },
  { key: 'analytics', ar: 'التحليلات', status: 'implemented', route: '#/dashboard', note: 'مؤشرات تشغيلية حقيقية من قاعدة البيانات', missing: 'لا يوجد مستودع بيانات تاريخي (Data Warehouse) منفصل.' },
  { key: 'radiology_orders', ar: 'طلبات الأشعة', status: 'implemented', route: '#/radiology', note: 'طلب، تنفيذ، تقرير اعتماد، ورسوم', missing: 'مرتبطة بسير عمل الأشعة دون PACS.' },
];

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(80),
});

export interface SearchHit {
  category: 'patient' | 'appointment' | 'encounter' | 'invoice' | 'cssd' | 'hr';
  categoryAr: string;
  id: string;
  code: string;
  title: string;
  subtitle: string;
  route: string;
}

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
            WHERE ur.facility_id = $1 AND u.is_active = true AND ur.role_id IN ('physician','department_manager','surgeon','anesthesiologist')
            ORDER BY u.full_name_ar`,
          [auth.activeFacilityId],
        ),
        db.query(`SELECT code, name_ar, name_en, specimen, unit, ref_low, ref_high, price FROM lab_tests ORDER BY name_ar`),
        db.query(`SELECT id, code, name_ar, name_en, form, strength, price FROM drugs WHERE is_active = true ORDER BY name_ar`),
        db.query<{ key: string; value: unknown }>(`SELECT key, value FROM app_settings WHERE facility_id = $1`, [auth.activeFacilityId]),
      ]);
      return {
        departments: departments.rows,
        doctors: doctors.rows,
        labTests: tests.rows,
        drugs: drugs.rows,
        pricing: Object.fromEntries(pricing.rows.map((r) => [r.key, r.value])),
        serverTime: new Date().toISOString(),
      };
    });
  });

  app.get('/api/search', async (req) => {
    const auth = requireAuth(req);
    const { q } = parse(SearchQuery, req.query ?? {});
    const term = `%${q}%`;

    return withTenant(auth, async (db) => {
      const hits: SearchHit[] = [];
      const tasks: Promise<void>[] = [];

      if (hasPermission(auth, 'patient.read')) {
        tasks.push(
          db
            .query<{ id: string; mrn: string; full_name_ar: string; sex: string; date_of_birth: string }>(
              `SELECT id, mrn, full_name_ar, sex, date_of_birth::text
                 FROM patients
                WHERE facility_id = $1 AND status <> 'merged'
                  AND (mrn ILIKE $2 OR full_name_ar ILIKE $2 OR full_name_en ILIKE $2)
                ORDER BY mrn LIMIT 6`,
              [auth.activeFacilityId, term],
            )
            .then((r) => {
              for (const p of r.rows) {
                hits.push({
                  category: 'patient',
                  categoryAr: 'المرضى',
                  id: p.id,
                  code: p.mrn,
                  title: p.full_name_ar,
                  subtitle: `${p.sex === 'male' ? 'ذكر' : 'أنثى'} · ${p.date_of_birth}`,
                  route: `#/patients/${p.id}`,
                });
              }
            }),
        );
      }

      if (hasPermission(auth, 'clinical.encounter.read')) {
        tasks.push(
          db
            .query<{ id: string; encounter_no: string; full_name_ar: string; mrn: string; status: string }>(
              `SELECT e.id, e.encounter_no, p.full_name_ar, p.mrn, e.status
                 FROM encounters e JOIN patients p ON p.id = e.patient_id
                WHERE e.facility_id = $1
                  AND (e.encounter_no ILIKE $2 OR p.full_name_ar ILIKE $2 OR p.mrn ILIKE $2)
                ORDER BY e.started_at DESC LIMIT 5`,
              [auth.activeFacilityId, term],
            )
            .then((r) => {
              for (const enc of r.rows) {
                hits.push({
                  category: 'encounter',
                  categoryAr: 'الزيارات السريرية',
                  id: enc.id,
                  code: enc.encounter_no,
                  title: `${enc.full_name_ar} (${enc.mrn})`,
                  subtitle: enc.status,
                  route: `#/clinic/${enc.id}`,
                });
              }
            }),
        );
      }

      if (hasPermission(auth, 'appointment.read')) {
        tasks.push(
          db
            .query<{ id: string; appointment_no: string; full_name_ar: string; mrn: string; status: string }>(
              `SELECT a.id, a.appointment_no, p.full_name_ar, p.mrn, a.status
                 FROM appointments a JOIN patients p ON p.id = a.patient_id
                WHERE a.facility_id = $1
                  AND (a.appointment_no ILIKE $2 OR p.full_name_ar ILIKE $2 OR p.mrn ILIKE $2)
                ORDER BY a.scheduled_at DESC LIMIT 5`,
              [auth.activeFacilityId, term],
            )
            .then((r) => {
              for (const a of r.rows) {
                hits.push({
                  category: 'appointment',
                  categoryAr: 'المواعيد',
                  id: a.id,
                  code: a.appointment_no,
                  title: `${a.full_name_ar} (${a.mrn})`,
                  subtitle: a.status,
                  route: '#/appointments',
                });
              }
            }),
        );
      }

      if (hasPermission(auth, 'billing.invoice.read')) {
        tasks.push(
          db
            .query<{ id: string; invoice_no: string; full_name_ar: string; total: string; status: string }>(
              `SELECT i.id, i.invoice_no, p.full_name_ar, i.total::text, i.status
                 FROM invoices i JOIN patients p ON p.id = i.patient_id
                WHERE i.facility_id = $1
                  AND (i.invoice_no ILIKE $2 OR p.full_name_ar ILIKE $2 OR p.mrn ILIKE $2)
                ORDER BY i.created_at DESC LIMIT 5`,
              [auth.activeFacilityId, term],
            )
            .then((r) => {
              for (const inv of r.rows) {
                hits.push({
                  category: 'invoice',
                  categoryAr: 'الفواتير',
                  id: inv.id,
                  code: inv.invoice_no,
                  title: inv.full_name_ar,
                  subtitle: `${inv.total} ر.س · ${inv.status}`,
                  route: `#/billing/${inv.id}`,
                });
              }
            }),
        );
      }

      if (hasPermission(auth, 'cssd.read')) {
        tasks.push(
          db
            .query<{ id: string; pack_no: string; set_name: string; status: string }>(
              `SELECT p.id, p.pack_no, s.name_ar AS set_name, p.status
                 FROM cssd_packs p JOIN cssd_instrument_sets s ON s.id = p.set_id
                WHERE p.facility_id = $1
                  AND (p.pack_no ILIKE $2 OR s.name_ar ILIKE $2 OR s.code ILIKE $2)
                ORDER BY p.created_at DESC LIMIT 5`,
              [auth.activeFacilityId, term],
            )
            .then((r) => {
              for (const pk of r.rows) {
                hits.push({
                  category: 'cssd',
                  categoryAr: 'التعقيم',
                  id: pk.id,
                  code: pk.pack_no,
                  title: pk.set_name,
                  subtitle: pk.status,
                  route: `#/cssd/${pk.id}`,
                });
              }
            }),
        );
      }

      await Promise.all(tasks);
      return { query: q, items: hits };
    });
  });
}
