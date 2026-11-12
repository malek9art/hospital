import { getDb } from './index';
import { hashPassword, encryptField, blindIndex } from '../lib/crypto';
import { writeAudit } from '../lib/audit';

// Synthetic demo data only. No real patient information is used.
const PERMISSIONS: [string, string, string][] = [
  ['patient.read', 'patients', 'عرض قائمة المرضى'],
  ['patient.create', 'patients', 'تسجيل مرضى'],
  ['patient.update', 'patients', 'تعديل بيانات مريض'],
  ['patient.chart.clinical', 'patients', 'الاطلاع على السجل السريري'],
  ['patient.chart.administrative', 'patients', 'الاطلاع على البيانات الإدارية'],
  ['patient.merge', 'patients', 'دمج ملفات المرضى'],
  ['patient.break_glass', 'patients', 'الوصول الطارئ'],
  ['appointment.read', 'appointments', 'عرض المواعيد'],
  ['appointment.create', 'appointments', 'حجز مواعيد'],
  ['appointment.update', 'appointments', 'تعديل/إلغاء مواعيد'],
  ['appointment.checkin', 'appointments', 'تسجيل حضور'],
  ['clinical.encounter.read', 'clinical', 'عرض الزيارات'],
  ['clinical.encounter.create', 'clinical', 'فتح/إغلاق زيارة'],
  ['clinical.note.write', 'clinical', 'كتابة ملاحظات'],
  ['clinical.diagnose', 'clinical', 'تسجيل تشخيص'],
  ['clinical.vitals.write', 'clinical', 'تسجيل علامات حيوية'],
  ['clinical.order.create', 'clinical', 'طلب تحاليل'],
  ['clinical.prescription.create', 'clinical', 'وصف أدوية'],
  ['lab.sample.collect', 'lab', 'جمع العينات'],
  ['lab.result.enter', 'lab', 'إدخال النتائج'],
  ['lab.result.verify', 'lab', 'اعتماد النتائج'],
  ['lab.result.amend', 'lab', 'تصحيح النتائج'],
  ['lab.critical.ack', 'lab', 'معالجة القيم الحرجة'],
  ['pharmacy.prescription.read', 'pharmacy', 'عرض الوصفات'],
  ['pharmacy.dispense', 'pharmacy', 'صرف الأدوية'],
  ['pharmacy.stock.manage', 'pharmacy', 'إدارة المخزون'],
  ['billing.invoice.read', 'billing', 'عرض الفواتير'],
  ['billing.invoice.create', 'billing', 'إنشاء فواتير'],
  ['billing.payment.record', 'billing', 'تحصيل مدفوعات'],
  ['billing.invoice.void', 'billing', 'إلغاء فواتير'],
  ['billing.discount.apply', 'billing', 'تطبيق خصومات'],
  ['insurance.claim.manage', 'insurance', 'إدارة المطالبات'],
  ['inpatient.admit', 'inpatient', 'تنويم المرضى'],
  ['inpatient.discharge', 'inpatient', 'خروج المرضى'],
  ['inpatient.bed.manage', 'inpatient', 'إدارة الأسرة'],
  ['emergency.triage', 'emergency', 'فرز وتشغيل الطوارئ'],
  ['radiology.order', 'radiology', 'طلب أشعة'],
  ['radiology.read', 'radiology', 'عرض طلبات وتقارير الأشعة'],
  ['radiology.perform', 'radiology', 'تنفيذ التصوير'],
  ['radiology.report', 'radiology', 'كتابة تقرير الأشعة'],
  ['radiology.verify', 'radiology', 'اعتماد تقرير الأشعة'],
  ['radiology.critical.ack', 'radiology', 'استلام النتائج الحرجة'],
  ['nursing.read', 'nursing', 'عرض لوحة التمريض'],
  ['nursing.mar.administer', 'nursing', 'تسجيل إعطاء الأدوية وإتمام مهام الرعاية'],
  ['nursing.careplan.manage', 'nursing', 'إنشاء وإغلاق خطط الرعاية'],
  ['nursing.handover.write', 'nursing', 'كتابة تسليم المناوبة'],
  ['nursing.witness', 'nursing', 'الشهادة على إعطاء الأدوية عالية الخطورة'],
  ['surgery.read', 'surgery', 'عرض جدول العمليات والملف الجراحي'],
  ['surgery.schedule', 'surgery', 'جدولة العمليات وإلغاؤها'],
  ['surgery.perform', 'surgery', 'بدء العملية وإغلاقها وتوقيع المسار الجراحي'],
  ['surgery.checklist', 'surgery', 'إتمام قوائم التحقق الجراحية وتسجيل الإفاقة'],
  ['anesthesia.perform', 'anesthesia', 'تسجيل قوائم ما قبل التخدير وقياسات التخدير'],
  ['icu.read', 'icu', 'عرض لوحة العناية المركزة والملف'],
  ['icu.chart', 'icu', 'تسجيل علامات حيوية وSOFA وحزمة الرعاية اليومية'],
  ['icu.ventilator', 'icu', 'إدارة إعدادات التنفس الصناعي'],
  ['icu.manage', 'icu', 'فتح إقامة عناية مركزة'],
  ['icu.discharge', 'icu', 'إغلاق إقامة العناية المركزة'],
  ['bloodbank.read', 'bloodbank', 'عرض مخزون الدم والطلبات وتتبع الوحدات'],
  ['bloodbank.request', 'bloodbank', 'طلب وحدات دم للمريض'],
  ['bloodbank.crossmatch', 'bloodbank', 'إجراء فحص التوافق وحجز الوحدات'],
  ['bloodbank.issue', 'bloodbank', 'صرف وحدات الدم للجناح'],
  ['bloodbank.transfuse', 'bloodbank', 'بدء النقل والتحقق الثاني وإغلاقه'],
  ['bloodbank.reaction', 'bloodbank', 'الإبلاغ عن تفاعلات نقل الدم'],
  ['bloodbank.stock', 'bloodbank', 'تسجيل المتبرعين والوحدات واستبعادها'],
  ['nutrition.read', 'nutrition', 'عرض لوحة التغذية وملف المريض الغذائي'],
  ['nutrition.screen', 'nutrition', 'إجراء فحص خطر التغذية (تمريض)'],
  ['nutrition.assess', 'nutrition', 'تقييم التغذية والمتابعة (أخصائي تغذية)'],
  ['nutrition.order', 'nutrition', 'إصدار أمر التغذية وتوليد وجبات اليوم'],
  ['nutrition.kitchen', 'nutrition', 'تحضير وتسليم صواني الوجبات'],
  ['nutrition.intake', 'nutrition', 'تسجيل ما تناوله المريض'],
  ['nutrition.tube', 'nutrition', 'أوامر التغذية الأنبوبية والوريدية وإيقافها'],
  ['cssd.read', 'cssd', 'عرض لوحة التعقيم والأطقم والحزم'],
  ['cssd.manage', 'cssd', 'تعريف الأطقم واستلام الحزم الملوّثة'],
  ['cssd.reprocess', 'cssd', 'الغسل والتغليف وتجهيز دورات التعقيم'],
  ['cssd.sterilize', 'cssd', 'تسجيل نتيجة دورة التعقيم والمؤشرات'],
  ['cssd.release', 'cssd', 'اعتماد الدورة والإفراج عن الحزم (شخص مختلف عن المنفذ)'],
  ['cssd.issue', 'cssd', 'صرف الحزم المعقمة وربطها بالعمليات وسحبها'],
  ['infection.read', 'infection', 'عرض لوحة مكافحة العدوى وأوامر العزل'],
  ['infection.isolate', 'infection', 'إصدار أوامر العزل وإنهاؤها'],
  ['infection.surveillance', 'infection', 'تسجيل حالات الاشتباه بالعدوى المرتبطة بالرعاية'],
  ['infection.confirm', 'infection', 'مراجعة واعتماد أو استبعاد حالات العدوى (شخص مختلف عن المسجل)'],
  ['infection.audit', 'infection', 'تدقيق نظافة الأيدي'],
  ['admin.users.read', 'admin', 'عرض المستخدمين'],
  ['admin.users.manage', 'admin', 'إدارة المستخدمين'],
  ['admin.roles.manage', 'admin', 'إدارة الأدوار'],
  ['admin.facility.manage', 'admin', 'إدارة المنشآت'],
  ['admin.sessions.manage', 'admin', 'إدارة الجلسات'],
  ['admin.settings.manage', 'admin', 'إدارة الإعدادات'],
  ['audit.read', 'audit', 'الاطلاع على سجل التدقيق'],
  ['report.read', 'reports', 'عرض التقارير'],
  ['report.export', 'reports', 'تصدير التقارير'],
  ['report.finance', 'reports', 'تقارير مالية على مستوى المنشأة'],
  ['portal.self', 'portal', 'بوابة المريض'],
];

const ALL = PERMISSIONS.map((p) => p[0]);
const ROLE_PERMS: Record<string, string[]> = {
  system_admin: ['admin.users.read', 'admin.users.manage', 'admin.roles.manage', 'admin.facility.manage', 'admin.sessions.manage', 'admin.settings.manage', 'audit.read', 'report.read'],
  hospital_director: ['report.read', 'report.export', 'report.finance', 'billing.invoice.read', 'audit.read', 'admin.sessions.manage', 'admin.users.read', 'patient.read', 'appointment.read'],
  surgeon: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.note.write', 'clinical.diagnose', 'clinical.order.create', 'clinical.prescription.create', 'clinical.vitals.write', 'inpatient.admit', 'inpatient.discharge', 'surgery.read', 'surgery.schedule', 'surgery.perform', 'radiology.order', 'radiology.read', 'billing.invoice.read', 'nursing.read', 'cssd.read', 'cssd.issue'],
  anesthesiologist: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.note.write', 'clinical.order.create', 'clinical.vitals.write', 'surgery.read', 'surgery.checklist', 'anesthesia.perform', 'radiology.read', 'cssd.read'],
  or_nurse: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.vitals.write', 'surgery.read', 'surgery.checklist', 'nursing.read', 'cssd.read', 'cssd.issue'],
  intensivist: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.note.write', 'clinical.diagnose', 'clinical.order.create', 'clinical.prescription.create', 'clinical.vitals.write', 'inpatient.admit', 'inpatient.discharge', 'inpatient.bed.manage', 'icu.read', 'icu.chart', 'icu.ventilator', 'icu.manage', 'icu.discharge', 'radiology.order', 'radiology.read', 'nursing.read', 'surgery.read', 'bloodbank.read', 'bloodbank.request', 'bloodbank.reaction', 'nutrition.read', 'nutrition.intake'],
  icu_nurse: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.vitals.write', 'clinical.note.write', 'pharmacy.prescription.read', 'icu.read', 'icu.chart', 'icu.ventilator', 'nursing.read', 'nursing.mar.administer', 'nursing.witness', 'bloodbank.read', 'bloodbank.transfuse', 'bloodbank.reaction', 'nutrition.read', 'nutrition.intake', 'infection.read', 'cssd.read'],
  dietitian: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'nutrition.read', 'nutrition.assess', 'nutrition.order', 'nutrition.tube', 'report.read'],
  kitchen_staff: ['patient.read', 'patient.chart.administrative', 'nutrition.kitchen'],
  cssd_tech: ['patient.read', 'patient.chart.administrative', 'clinical.encounter.read', 'cssd.read', 'cssd.manage', 'cssd.reprocess', 'cssd.sterilize', 'cssd.release', 'cssd.issue', 'report.read'],
  infection_control: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'clinical.note.write', 'infection.read', 'infection.isolate', 'infection.surveillance', 'infection.confirm', 'infection.audit', 'cssd.read', 'report.read', 'report.export'],
  blood_bank_tech: ['patient.read', 'patient.chart.administrative', 'clinical.encounter.read', 'bloodbank.read', 'bloodbank.crossmatch', 'bloodbank.issue', 'bloodbank.stock', 'bloodbank.reaction', 'report.read'],
  department_manager: ['patient.read', 'patient.chart.clinical', 'appointment.read', 'appointment.create', 'appointment.update', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.diagnose', 'clinical.note.write', 'clinical.prescription.create', 'clinical.order.create', 'clinical.vitals.write', 'lab.result.verify', 'radiology.read', 'radiology.order', 'radiology.critical.ack', 'billing.invoice.read', 'report.read', 'report.export', 'inpatient.admit', 'inpatient.discharge', 'inpatient.bed.manage', 'nursing.read', 'nursing.careplan.manage', 'surgery.read', 'surgery.schedule', 'bloodbank.read', 'bloodbank.request', 'bloodbank.reaction'],
  physician: ['patient.read', 'patient.create', 'patient.update', 'patient.chart.clinical', 'patient.break_glass', 'appointment.read', 'appointment.update', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.note.write', 'clinical.diagnose', 'clinical.vitals.write', 'clinical.order.create', 'clinical.prescription.create', 'pharmacy.prescription.read', 'billing.invoice.read', 'report.read', 'inpatient.admit', 'inpatient.discharge', 'inpatient.bed.manage', 'emergency.triage', 'radiology.order', 'radiology.read', 'radiology.critical.ack', 'nursing.read', 'surgery.read', 'surgery.schedule', 'bloodbank.read', 'bloodbank.request'],
  nurse: ['patient.read', 'patient.chart.clinical', 'appointment.read', 'appointment.checkin', 'clinical.encounter.read', 'clinical.vitals.write', 'clinical.note.write', 'lab.sample.collect', 'pharmacy.prescription.read', 'report.read', 'inpatient.bed.manage', 'emergency.triage', 'radiology.read', 'nursing.read', 'nursing.mar.administer', 'nursing.careplan.manage', 'nursing.handover.write', 'nursing.witness', 'bloodbank.read', 'bloodbank.transfuse', 'bloodbank.reaction', 'nutrition.read', 'nutrition.screen', 'nutrition.intake', 'cssd.read', 'infection.read', 'infection.isolate', 'infection.surveillance', 'infection.audit'],
  receptionist: ['patient.read', 'patient.create', 'patient.chart.administrative', 'appointment.read', 'appointment.create', 'appointment.update', 'appointment.checkin', 'billing.invoice.read', 'billing.payment.record'],
  records_officer: ['patient.read', 'patient.create', 'patient.update', 'patient.merge', 'patient.chart.administrative', 'appointment.read', 'report.read', 'report.export'],
  lab_tech: ['patient.read', 'patient.chart.clinical', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'lab.critical.ack', 'clinical.encounter.read'],
  radiology_tech: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'radiology.read', 'radiology.perform'],
  radiologist: ['patient.read', 'patient.chart.clinical', 'clinical.encounter.read', 'radiology.read', 'radiology.report', 'radiology.verify'],
  pharmacist: ['patient.read', 'patient.chart.clinical', 'pharmacy.prescription.read', 'pharmacy.dispense', 'pharmacy.stock.manage', 'billing.invoice.read'],
  accountant: ['patient.read', 'patient.chart.administrative', 'billing.invoice.read', 'billing.invoice.create', 'billing.payment.record', 'billing.invoice.void', 'billing.discount.apply', 'insurance.claim.manage', 'report.read', 'report.export', 'report.finance'],
  auditor: ['audit.read', 'report.read', 'report.export', 'report.finance', 'admin.users.read', 'nursing.read'],
  patient: ['portal.self'],
};

const ROLES: [string, string, string][] = [
  ['system_admin', 'مدير النظام', 'System administrator'],
  ['hospital_director', 'الإدارة التنفيذية', 'Executive management'],
  ['department_manager', 'مدير قسم', 'Department manager'],
  ['physician', 'طبيب', 'Physician'],
  ['nurse', 'تمريض', 'Nurse'],
  ['surgeon', 'جراح', 'Surgeon'],
  ['anesthesiologist', 'طبيب تخدير', 'Anesthesiologist'],
  ['or_nurse', 'تمريض عمليات', 'Operating-room nurse'],
  ['intensivist', 'طبيب عناية مركزة', 'Intensivist'],
  ['icu_nurse', 'تمريض عناية مركزة', 'ICU nurse'],
  ['blood_bank_tech', 'فني بنك دم', 'Blood bank technologist'],
  ['dietitian', 'أخصائي تغذية', 'Clinical dietitian'],
  ['kitchen_staff', 'موظف تغذية', 'Nutrition services'],
  ['cssd_tech', 'فني تعقيم', 'CSSD technician'],
  ['infection_control', 'مكافحة العدوى', 'Infection prevention & control'],
  ['receptionist', 'استقبال', 'Receptionist'],
  ['records_officer', 'السجلات الطبية', 'Medical records'],
  ['lab_tech', 'فني مختبر', 'Lab technician'],
  ['radiology_tech', 'فني أشعة', 'Radiology technologist'],
  ['radiologist', 'استشاري أشعة', 'Radiologist'],
  ['pharmacist', 'صيدلي', 'Pharmacist'],
  ['accountant', 'محاسب', 'Accountant'],
  ['auditor', 'مدقق', 'Auditor'],
  ['patient', 'مريض', 'Patient'],
];

export async function seedDatabase(opts: { force?: boolean } = {}) {
  const db = await getDb();
  const existing = await db.query<{ count: string }>('SELECT count(*) FROM facilities');
  if (Number(existing.rows[0]?.count ?? 0) > 0 && !opts.force) {
    return { seeded: false, reason: 'already_seeded' };
  }

  const facilityId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  await db.query(
    `INSERT INTO facilities (id, code, name_ar, name_en) VALUES ($1,'OBR','المستشفى السعودي الميداني - العبر','Saudi Field Hospital - Obar')`,
    [facilityId],
  );
  await db.query(
    `INSERT INTO facilities (id, code, name_ar, name_en) VALUES ($1,'JED','فرع جدة','Jeddah Branch')`,
    [branchId],
  );

  const deptDefs: [string, string, string, string][] = [
    ['GEN', 'الطب العام', 'General Medicine', 'outpatient'],
    ['ER', 'الطوارئ', 'Emergency', 'emergency'],
    ['LAB', 'المختبر', 'Laboratory', 'lab'],
    ['PHR', 'الصيدلية', 'Pharmacy', 'pharmacy'],
    ['ADM', 'الإدارة', 'Administration', 'administration'],
    ['INP', 'التنويم', 'Inpatient', 'inpatient'],
    ['RAD', 'الأشعة', 'Radiology', 'radiology'],
    ['OR', 'العمليات والتخدير', 'Operating theatres', 'surgery'],
  ];
  const deptIds: Record<string, string> = {};
  for (const [code, ar, en, type] of deptDefs) {
    const id = crypto.randomUUID();
    deptIds[code] = id;
    await db.query('INSERT INTO departments (id, facility_id, code, name_ar, name_en, dept_type) VALUES ($1,$2,$3,$4,$5,$6)', [id, facilityId, code, ar, en, type]);
  }

  const theatreIds: Record<string, string> = {};
  for (const [code, ar, en] of [['OR-1', 'غرفة عمليات ١', 'Theatre 1'], ['OR-2', 'غرفة عمليات ٢', 'Theatre 2']] as const) {
    const id = crypto.randomUUID();
    theatreIds[code] = id;
    await db.query(
      `INSERT INTO operating_theatres (id, facility_id, dept_id, code, name_ar, name_en) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, facilityId, deptIds.OR, code, ar, en],
    );
  }

  for (const [code, ar, en] of ROLES) {
    await db.query('INSERT INTO roles (id, name_ar, name_en) VALUES ($1,$2,$3)', [code, ar, en]);
  }
  for (const [code, module, ar] of PERMISSIONS) {
    await db.query('INSERT INTO permissions (code, module, desc_ar) VALUES ($1,$2,$3)', [code, module, ar]);
  }
  for (const [role, perms] of Object.entries(ROLE_PERMS)) {
    for (const p of perms) {
      await db.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)', [role, p]);
    }
  }

  const password = {
    admin: await hashPassword('Admin#Demo2026'),
    director: await hashPassword('Director#Demo2026'),
    doctor: await hashPassword('Doctor#Demo2026'),
    nurse: await hashPassword('Nurse#Demo2026'),
    surgeon: await hashPassword('Surgeon#Demo2026'),
    anesthesia: await hashPassword('Anesthesia#Demo2026'),
    icu: await hashPassword('ICU#Demo2026'),
    blood: await hashPassword('Blood#Demo2026'),
    nutrition: await hashPassword('Nutrition#Demo2026'),
    kitchen: await hashPassword('Kitchen#Demo2026'),
    cssd: await hashPassword('CSSD#Demo2026'),
    infection: await hashPassword('Infection#Demo2026'),
    reception: await hashPassword('Reception#Demo2026'),
    records: await hashPassword('Records#Demo2026'),
    lab: await hashPassword('Lab#Demo2026'),
    radiology: await hashPassword('Radiology#Demo2026'),
    pharma: await hashPassword('Pharma#Demo2026'),
    account: await hashPassword('Account#Demo2026'),
    auditor: await hashPassword('Auditor#Demo2026'),
    patient: await hashPassword('Patient#Demo2026'),
  };

  const users: [string, string, string, string, string, string, string | null][] = [
    ['admin@demo.hms', 'مدير النظام', 'System Admin', 'مدير النظام', 'system_admin', password.admin, 'ADM'],
    ['director@demo.hms', 'د. خالد العتيبي', 'Dr. Khalid Alotaibi', 'المدير التنفيذي', 'hospital_director', password.director, 'ADM'],
    ['dr.ahmed@demo.hms', 'د. أحمد الحربي', 'Dr. Ahmed Alharbi', 'استشاري طب باطني', 'physician', password.doctor, 'GEN'],
    ['dr.sara@demo.hms', 'د. سارة القحطاني', 'Dr. Sara Alqahtani', 'استشارية طوارئ', 'physician', password.doctor, 'ER'],
    ['nurse@demo.hms', 'مريم الزهراني', 'Mariam Alzahrani', 'ممرضة أولى', 'nurse', password.nurse, 'INP'],
    ['nurse2@demo.hms', 'ليلى العمري', 'Layla Alamri', 'ممرضة مناوبة', 'nurse', password.nurse, 'INP'],
    ['surgeon@demo.hms', 'د. عبدالله الغامدي', 'Dr. Abdullah Alghamdi', 'استشاري جراحة عامة', 'surgeon', password.surgeon, 'OR'],
    ['anesthesia@demo.hms', 'د. هدى المطيري', 'Dr. Huda Almutairi', 'استشارية تخدير', 'anesthesiologist', password.anesthesia, 'OR'],
    ['ornurse@demo.hms', 'سارة الدوسري', 'Sara Aldosari', 'ممرضة غرفة عمليات', 'or_nurse', password.nurse, 'OR'],
    ['intensivist@demo.hms', 'د. فيصل الحربي', 'Dr. Faisal Alharbi', 'استشاري عناية مركزة', 'intensivist', password.icu, 'INP'],
    ['icunurse@demo.hms', 'أمل الجهني', 'Amal Aljohani', 'ممرضة عناية مركزة', 'icu_nurse', password.icu, 'INP'],
    ['bloodbank@demo.hms', 'نورة الحربي', 'Noura Alharbi', 'فنية بنك دم', 'blood_bank_tech', password.blood, 'LAB'],
    ['dietitian@demo.hms', 'هيفاء الزهراني', 'Haifa Alzahrani', 'أخصائية تغذية علاجية', 'dietitian', password.nutrition, 'INP'],
    ['kitchen@demo.hms', 'ماجد الشهري', 'Majed Alshehri', 'مسؤول خدمات التغذية', 'kitchen_staff', password.kitchen, 'INP'],
    ['cssd@demo.hms', 'عمر باوزير', 'Omar Bawazir', 'فني تعقيم مركزي', 'cssd_tech', password.cssd, 'OR'],
    ['cssd2@demo.hms', 'خديجة عسيري', 'Khadija Asiri', 'مشرفة التعقيم المركزي', 'cssd_tech', password.cssd, 'OR'],
    ['infection@demo.hms', 'د. رقية الأنصاري', 'Dr. Ruqaya Alansari', 'استشارية مكافحة العدوى', 'infection_control', password.infection, 'INP'],
    ['reception@demo.hms', 'عبدالله الشهري', 'Abdullah Alshehri', 'موظف استقبال', 'receptionist', password.reception, 'ADM'],
    ['records@demo.hms', 'نورة السبيعي', 'Noura Alsubaie', 'أخصائي سجلات طبية', 'records_officer', password.records, 'ADM'],
    ['lab@demo.hms', 'فهد الدوسري', 'Fahad Aldosari', 'فني مختبر', 'lab_tech', password.lab, 'LAB'],
    ['lab2@demo.hms', 'هند الغامدي', 'Hind Alghamdi', 'أخصائية مختبر', 'lab_tech', password.lab, 'LAB'],
    ['radiology@demo.hms', 'طلال البلوي', 'Talal Albalawi', 'فني أشعة', 'radiology_tech', password.radiology, 'RAD'],
    ['radiologist@demo.hms', 'د. منى الشريف', 'Dr. Mona Alsharif', 'استشارية أشعة', 'radiologist', password.radiology, 'RAD'],
    ['pharmacist@demo.hms', 'ريم المالكي', 'Reem Almalki', 'صيدلانية', 'pharmacist', password.pharma, 'PHR'],
    ['accountant@demo.hms', 'سلمان القحطاني', 'Salman Alqahtani', 'محاسب', 'accountant', password.account, 'ADM'],
    ['auditor@demo.hms', 'لمى الحمد', 'Lama Alhamd', 'مدققة داخلية', 'auditor', password.auditor, 'ADM'],
  ];
  const userIds: Record<string, string> = {};
  for (const [email, nameAr, nameEn, title, role, hash, dept] of users) {
    const id = crypto.randomUUID();
    userIds[role + ':' + email] = id;
    await db.query(
      `INSERT INTO users (id, email, password_hash, full_name_ar, full_name_en, job_title_ar, must_change_password, mfa_enforced)
       VALUES ($1,$2,$3,$4,$5,$6,false,false)`,
      [id, email, hash, nameAr, nameEn, title],
    );
    await db.query('INSERT INTO user_facilities (user_id, facility_id) VALUES ($1,$2)', [id, facilityId]);
    if (role === 'system_admin' || role === 'hospital_director') {
      await db.query('INSERT INTO user_facilities (user_id, facility_id) VALUES ($1,$2)', [id, branchId]);
    }
    await db.query('INSERT INTO user_roles (user_id, role_id, facility_id, department_id) VALUES ($1,$2,$3,$4)', [id, role, facilityId, dept ? deptIds[dept] : null]);
  }
  const patientUserId = crypto.randomUUID();
  await db.query(
    `INSERT INTO users (id, email, password_hash, full_name_ar, full_name_en, must_change_password) VALUES ($1,$2,$3,$4,$5,false)`,
    [patientUserId, 'patient@demo.hms', password.patient, 'محمد العسيري', 'Mohammed Alaseeri'],
  );
  await db.query('INSERT INTO user_facilities (user_id, facility_id) VALUES ($1,$2)', [patientUserId, facilityId]);
  await db.query('INSERT INTO user_roles (user_id, role_id, facility_id) VALUES ($1,$2,$3)', [patientUserId, 'patient', facilityId]);

  // ---------------------------------------------------------------- Patients --
  const patientDefs: [string, string, string, string, string, string, string][] = [
    ['محمد علي العسيري', 'Mohammed Alaseeri', '1985-04-12', 'male', '1000000001', 'O+', '0501234567'],
    ['فاطمة حسن الشهري', 'Fatimah Alshehri', '1992-09-03', 'female', '1000000002', 'A+', '0559876543'],
    ['سعيد ناصر القحطاني', 'Saeed Alqahtani', '1968-01-25', 'male', '1000000003', 'B+', '0533334444'],
    ['خالد مبارك الدوسري', 'Khalid Aldosari', '1957-03-18', 'male', '1000000004', 'A-', '0567778888'],
    ['نوف عبدالعزيز الشمري', 'Nouf Alshammari', '1990-11-22', 'female', '1000000005', 'O-', '0572223333'],
  ];
  const patientIds: string[] = [];
  for (let i = 0; i < patientDefs.length; i++) {
    const [nameAr, nameEn, dob, sex, nid, blood, phone] = patientDefs[i];
    const id = crypto.randomUUID();
    patientIds.push(id);
    await db.query(
      `INSERT INTO patients (id, facility_id, mrn, national_id_enc, national_id_hash, full_name_ar, full_name_en,
         date_of_birth, sex, phone_enc, blood_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, facilityId, `MRN-${String(i + 1).padStart(4, '0')}`, encryptField(nid, `patients.national_id_enc:${id}`), blindIndex(nid),
        nameAr, nameEn, dob, sex, encryptField(phone, `patients.phone_enc:${id}`), blood, userIds['records_officer:records@demo.hms']],
    );
  }
  await db.query('UPDATE users SET patient_id = $1 WHERE id = $2', [patientIds[0], patientUserId]);
  await db.query(
    `INSERT INTO patient_allergies (id, facility_id, patient_id, allergen, reaction, severity, noted_by)
     VALUES ($1,$2,$3,'أموكسيسيلين','طفح جلدي وتورم (حساسية بنسلين)','severe',$4)`,
    [crypto.randomUUID(), facilityId, patientIds[0], userIds['physician:dr.ahmed@demo.hms']],
  );
  await db.query(
    `INSERT INTO patient_conditions (id, facility_id, patient_id, icd10_code, description, onset_date, noted_by)
     VALUES ($1,$2,$3,'E11.9','داء السكري من النوع الثاني',$4,$5)`,
    [crypto.randomUUID(), facilityId, patientIds[0], '2019-05-01', userIds['physician:dr.ahmed@demo.hms']],
  );
  await db.query(
    `INSERT INTO insurance_policies (id, facility_id, patient_id, payer_name, policy_no_enc, policy_no_hash, coverage_pct, valid_from)
     VALUES ($1,$2,$3,'شركة تأمين تجريبية',$4,$5,80,current_date - interval '90 days')`,
    [crypto.randomUUID(), facilityId, patientIds[0], 'placeholder', blindIndex('POL-0001')],
  );

  // --------------------------------------------------------------- Catalogue --
  const labTests: [string, string, string, string, string, number, number, number, number, number][] = [
    ['718-7', 'الهيموغلوبين', 'Hemoglobin', 'blood', 'g/dL', 13, 17, 7, 20, 25],
    ['6690-2', 'كرات الدم البيضاء', 'WBC', 'blood', '10^3/uL', 4, 11, 1.5, 30, 25],
    ['2345-7', 'الغلوكوز صائم', 'Fasting Glucose', 'blood', 'mg/dL', 70, 110, 40, 500, 20],
    ['2160-0', 'الكرياتينين', 'Creatinine', 'blood', 'mg/dL', 0.6, 1.3, 0.2, 6, 25],
    ['4548-4', 'الهيموغلوبين السكري', 'HbA1c', 'blood', '%', 4, 5.7, null as any, 12, 60],
  ];
  for (const t of labTests) {
    await db.query(
      `INSERT INTO lab_tests (code, name_ar, name_en, specimen, unit, ref_low, ref_high, critical_low, critical_high, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      t,
    );
    await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, 'pricing.consultation', '{"amount":150}') ON CONFLICT DO NOTHING`, [facilityId]);
    await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, 'pricing.bed_day', '{"amount":400}') ON CONFLICT DO NOTHING`, [facilityId]);
    await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, 'pricing.er_visit', '{"amount":200}') ON CONFLICT DO NOTHING`, [facilityId]);
    await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, 'pricing.surgery_case', '{"amount":3500}') ON CONFLICT DO NOTHING`, [facilityId]);
    await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, 'pricing.anesthesia_case', '{"amount":1200}') ON CONFLICT DO NOTHING`, [facilityId]);
    for (const [modality, amount] of Object.entries({ xray: 150, ct: 650, mri: 1100, us: 300, mammography: 400, fluoroscopy: 500 })) {
      await db.query(`INSERT INTO app_settings (facility_id, key, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [facilityId, `pricing.imaging_${modality}`, JSON.stringify({ amount })]);
    }
  }

  const drugs: [string, string, string, string, string, number, boolean][] = [
    ['DRG-PARA', 'باراسيتامول 500 ملغ', 'Paracetamol 500mg', 'tablet', '500mg', 5, false],
    ['DRG-AMOX', 'أموكسيسيلين 500 ملغ', 'Amoxicillin 500mg', 'capsule', '500mg', 18, false],
    ['DRG-IBU', 'إيبوبروفين 400 ملغ', 'Ibuprofen 400mg', 'tablet', '400mg', 8, false],
    ['DRG-WARF', 'وارفارين 5 ملغ', 'Warfarin 5mg', 'tablet', '5mg', 22, true],
    ['DRG-ASP', 'أسبرين 81 ملغ', 'Aspirin 81mg', 'tablet', '81mg', 7, false],
    ['DRG-METF', 'ميتفورمين 500 ملغ', 'Metformin 500mg', 'tablet', '500mg', 12, false],
  ];
  const drugIds: Record<string, string> = {};
  for (const [code, ar, en, form, strength, price, controlled] of drugs) {
    const id = crypto.randomUUID();
    drugIds[code] = id;
    // Controlled medicines are high-alert: nursing requires a second witness.
    await db.query(
      'INSERT INTO drugs (id, code, name_ar, name_en, form, strength, price, is_controlled, is_high_alert) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [id, code, ar, en, form, strength, price, controlled],
    );
    await db.query(
      `INSERT INTO drug_batches (id, facility_id, drug_id, batch_no, expiry_date, qty_on_hand, unit_cost)
       VALUES ($1,$2,$3,$4,current_date + interval '400 days',$5,$6)`,
      [crypto.randomUUID(), facilityId, id, `B-${code.slice(4)}-001`, 500, price * 0.7],
    );
  }
  await db.query(
    `INSERT INTO drug_interactions (id, drug_a_code, drug_b_code, severity, description)
     VALUES ($1,'DRG-WARF','DRG-ASP','major','زيادة خطر النزف عند الجمع بين الوارفارين والأسبرين')`,
    [crypto.randomUUID()],
  );

  // -------------------------------------------------------------- Beds/wards --
  const wardId = crypto.randomUUID();
  await db.query(`INSERT INTO wards (id, facility_id, name_ar, name_en, ward_type) VALUES ($1,$2,'جناح عام','General Ward','general')`, [wardId, facilityId]);
  const icuId = crypto.randomUUID();
  await db.query(`INSERT INTO wards (id, facility_id, name_ar, name_en, ward_type) VALUES ($1,$2,'العناية المركزة','ICU','icu')`, [icuId, facilityId]);
  for (const [ward, label, count] of [[wardId, 'G', 4], [icuId, 'ICU', 4]] as const) {
    for (let i = 1; i <= count; i++) {
      const roomId = crypto.randomUUID();
      await db.query(`INSERT INTO rooms (id, facility_id, ward_id, room_no, room_type) VALUES ($1,$2,$3,$4,'standard')`, [roomId, facilityId, ward, `${label}-0${i}`]);
      await db.query(`INSERT INTO beds (id, facility_id, ward_id, room_id, bed_no) VALUES ($1,$2,$3,$4,'A')`, [crypto.randomUUID(), facilityId, ward, roomId]);
    }
  }

  // ------------------------------------------------------------ Appointments --
  const appointmentId = crypto.randomUUID();
  await db.query(
    `INSERT INTO appointments (id, facility_id, appointment_no, patient_id, department_id, doctor_id, scheduled_at, reason, created_by)
     VALUES ($1,$2,'APT-000001',$3,$4,$5, date_trunc('hour', now()) + interval '1 hour', 'متابعة ضغط وسكري',$6)`,
    [appointmentId, facilityId, patientIds[1], deptIds.GEN, userIds['physician:dr.ahmed@demo.hms'], userIds['receptionist:reception@demo.hms']],
  );
  await db.query(
    `INSERT INTO appointments (id, facility_id, appointment_no, patient_id, department_id, doctor_id, scheduled_at, reason, created_by)
     VALUES ($1,$2,'APT-000002',$3,$4,$5, now() - interval '2 days', 'مراجعة نتائج',$6)`,
    [crypto.randomUUID(), facilityId, patientIds[2], deptIds.GEN, userIds['physician:dr.ahmed@demo.hms'], userIds['receptionist:reception@demo.hms']],
  );

  // ---------------------------------------------- Historical completed journey --
  // Gives the chart, pharmacy, billing and patient portal realistic history:
  // one closed encounter with verified labs, a dispensed prescription and a
  // fully paid invoice. All synthetic.
  {
    const uid = (email: string) => Object.entries(userIds).find(([k]) => k.endsWith(':' + email))![1];
    const doctor = uid('dr.ahmed@demo.hms');
    const labTech1 = uid('lab@demo.hms');
    const labTech2 = uid('lab2@demo.hms');
    const pharmacist = uid('pharmacist@demo.hms');
    const accountant = uid('accountant@demo.hms');
    const patientId = patientIds[0];

    const encounterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
         status, chief_complaint, started_at, closed_at, disposition, created_by)
       VALUES ($1,$2,'ENC-000001',$3,'outpatient',$4,$5,'closed','عطش شديد وتعب عام', now() - interval '10 days',
               now() - interval '10 days' + interval '45 minutes', 'متابعة في العيادة', $5)`,
      [encounterId, facilityId, patientId, deptIds.GEN, doctor],
    );
    await db.query(
      `INSERT INTO vitals (id, facility_id, patient_id, encounter_id, recorded_by, recorded_at, temperature_c,
         heart_rate, systolic_bp, diastolic_bp, spo2, weight_kg)
       VALUES ($1,$2,$3,$4,$5, now() - interval '10 days', 37.1, 88, 128, 82, 98, 84.5)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, doctor],
    );
    await db.query(
      `INSERT INTO clinical_notes (id, facility_id, patient_id, encounter_id, note_type, subjective, objective,
         assessment, plan, author_id, signed_at)
       VALUES ($1,$2,$3,$4,'consultation','عطش وتبول متكرر خلال الأسبوعين الماضيين',
         'ضغط 128/82، حرارة 37.1، وزن 84.5','ارتفاع سكر الدم على خلفية داء سكري من النوع الثاني',
         'تعديل جرعة الميتفورمين ومتابعة بعد أسبوعين', $5, now() - interval '10 days')`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, doctor],
    );
    await db.query(
      `INSERT INTO diagnoses (id, facility_id, patient_id, encounter_id, icd10_code, description, diagnosis_type, recorded_by)
       VALUES ($1,$2,$3,$4,'E11.9','داء السكري من النوع الثاني','primary',$5)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, doctor],
    );

    // Invoice exists before any charge line is attached (FK integrity).
    const invoiceId = crypto.randomUUID();
    await db.query(
      `INSERT INTO invoices (id, facility_id, invoice_no, patient_id, encounter_id, status, created_by, created_at)
       VALUES ($1,$2,'INV-000001',$3,$4,'open',$5, now() - interval '10 days')`,
      [invoiceId, facilityId, patientId, encounterId, accountant],
    );
    let subtotal = 0;
    const addCharge = async (category: string, description: string, refType: string, refId: string, qty: number, price: number) => {
      const lineTotal = qty * price;
      subtotal += lineTotal;
      await db.query(
        `INSERT INTO invoice_items (id, facility_id, invoice_id, category, description, reference_type, reference_id,
           quantity, unit_price, line_total, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - interval '10 days')`,
        [crypto.randomUUID(), facilityId, invoiceId, category, description, refType, refId, qty, price, lineTotal],
      );
    };

    const labOrderId = crypto.randomUUID();
    await db.query(
      `INSERT INTO lab_orders (id, facility_id, order_no, patient_id, encounter_id, ordered_by, ordered_at, priority, status)
       VALUES ($1,$2,'LAB-000001',$3,$4,$5, now() - interval '10 days', 'routine', 'completed')`,
      [labOrderId, facilityId, patientId, encounterId, doctor],
    );
    const labLines: [string, number, string, number, string][] = [
      ['718-7', 14.2, 'normal', 25, 'g/dL'],
      ['2345-7', 168, 'high', 20, 'mg/dL'],
    ];
    for (const [code, value, flag, price, unit] of labLines) {
      const itemId = crypto.randomUUID();
      const resultId = crypto.randomUUID();
      await db.query(
        `INSERT INTO lab_order_items (id, facility_id, order_id, test_code, status, specimen_barcode, collected_by,
           collected_at, verified_by, verified_at, price)
         VALUES ($1,$2,$3,$4,'verified',$5,$6, now() - interval '10 days', $7, now() - interval '9 days', $8)`,
        [itemId, facilityId, labOrderId, code, `SPC-LAB-000001-${code}`, labTech1, labTech2, price],
      );
      await db.query(
        `INSERT INTO lab_results (id, facility_id, order_item_id, value_numeric, unit, flag, resulted_by, resulted_at,
           verified_by, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '10 days', $8, now() - interval '9 days')`,
        [resultId, facilityId, itemId, value, unit, flag, labTech1, labTech2],
      );
      await addCharge('lab', `تحليل ${code}`, 'lab_item', itemId, 1, price);
    }

    const metformin = drugIds['DRG-METF'];
    const batch = await db.query<{ id: string }>(
      `SELECT id FROM drug_batches WHERE facility_id = $1 AND drug_id = $2 ORDER BY expiry_date LIMIT 1`,
      [facilityId, metformin],
    );
    const prescriptionId = crypto.randomUUID();
    const rxItemId = crypto.randomUUID();
    await db.query(
      `INSERT INTO prescriptions (id, facility_id, prescription_no, patient_id, encounter_id, prescribed_by,
         prescribed_at, status)
       VALUES ($1,$2,'RX-000001',$3,$4,$5, now() - interval '10 days', 'dispensed')`,
      [prescriptionId, facilityId, patientId, encounterId, doctor],
    );
    await db.query(
      `INSERT INTO prescription_items (id, facility_id, prescription_id, drug_id, dose, route, frequency,
         duration_days, quantity, status, price)
       VALUES ($1,$2,$3,$4,'500mg','فموي','مرتين يوميًا',30,60,'dispensed',12)`,
      [rxItemId, facilityId, prescriptionId, metformin],
    );
    if (batch.rows[0]) {
      await db.query(
        `INSERT INTO dispenses (id, facility_id, prescription_item_id, drug_batch_id, quantity, dispensed_by, dispensed_at)
         VALUES ($1,$2,$3,$4,60,$5, now() - interval '10 days')`,
        [crypto.randomUUID(), facilityId, rxItemId, batch.rows[0].id, pharmacist],
      );
      await db.query(`UPDATE drug_batches SET qty_on_hand = qty_on_hand - 60 WHERE id = $1`, [batch.rows[0].id]);
      await db.query(
        `INSERT INTO stock_movements (facility_id, drug_id, batch_id, movement_type, quantity, reference_type, reference_id, performed_by, created_at)
         VALUES ($1,$2,$3,'dispense',-60,'prescription_item',$4,$5, now() - interval '10 days')`,
        [facilityId, metformin, batch.rows[0].id, rxItemId, pharmacist],
      );
      await addCharge('pharmacy', 'صرف ميتفورمين 500 ملغ', 'prescription_item', rxItemId, 60, 12);
    }
    await addCharge('consultation', 'أتعاب استشارة طبية', 'encounter_consultation', encounterId, 1, 150);

    await db.query(
      `UPDATE invoices SET subtotal = $1, total = $1, paid_amount = $1, status = 'paid' WHERE id = $2`,
      [subtotal, invoiceId],
    );
    await db.query(
      `INSERT INTO payments (id, facility_id, invoice_id, amount, method, received_by, received_at)
       VALUES ($1,$2,$3,$4,'card',$5, now() - interval '10 days')`,
      [crypto.randomUUID(), facilityId, invoiceId, subtotal, accountant],
    );
  }

  // ---------------------------------------------------------- ER demo visit --
  {
    const doctor = Object.entries(userIds).find(([k]) => k.endsWith(':dr.sara@demo.hms'))![1];
    const erDept = deptIds.ER;
    const patientId = patientIds[2];
    const encounterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
         status, chief_complaint, triage_level, started_at, created_by)
       VALUES ($1,$2,'ENC-000002',$3,'emergency',$4,$5,'open','ألم صدري حاد يمتد للذراع', 2, now() - interval '35 minutes', $5)`,
      [encounterId, facilityId, patientId, erDept, doctor],
    );
    await db.query(
      `INSERT INTO vitals (id, facility_id, patient_id, encounter_id, recorded_by, recorded_at, heart_rate,
         systolic_bp, diastolic_bp, spo2, temperature_c)
       VALUES ($1,$2,$3,$4,$5, now() - interval '35 minutes', 104, 148, 92, 95, 37.2)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, doctor],
    );
    await db.query(
      `INSERT INTO triage_records (id, facility_id, patient_id, encounter_id, level, chief_complaint, arrived_at, triaged_by)
       VALUES ($1,$2,$3,$4,2,'ألم صدري حاد يمتد للذراع', now() - interval '35 minutes', $5)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, doctor],
    );
  }


  // ------------------------------------------------------- Nursing demo ward --
  // An admitted patient with an active, dispensed prescription, one overdue dose,
  // a high-alert medicine awaiting a witnessed dose, a care plan and a handover.
  {
    const nurse1 = userIds['nurse:nurse@demo.hms'];
    const nurse2 = userIds['nurse2:nurse2@demo.hms'];
    const doctor = userIds['physician:dr.ahmed@demo.hms'];
    const patientId = patientIds[3];

    const bed = await db.query<{ id: string }>(
      `SELECT b.id FROM beds b JOIN wards w ON w.id = b.ward_id
        WHERE b.facility_id = $1 AND b.status = 'available' ORDER BY w.ward_type DESC, b.bed_no LIMIT 1`,
      [facilityId],
    );
    const bedId = bed.rows[0]?.id ?? null;

    const encounterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
         status, chief_complaint, started_at, created_by)
       VALUES ($1,$2,'ENC-000003',$3,'inpatient',$4,$5,'open','متابعة قصور قلب ومضاد تخثر', now() - interval '2 days', $5)`,
      [encounterId, facilityId, patientId, deptIds.INP, doctor],
    );
    const admissionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO admissions (id, facility_id, admission_no, patient_id, encounter_id, bed_id, attending_doctor_id,
         admitted_by, admitted_at, status)
       VALUES ($1,$2,'ADM-000002',$3,$4,$5,$6,$6, now() - interval '2 days', 'active')`,
      [admissionId, facilityId, patientId, encounterId, bedId, doctor],
    );
    if (bedId) await db.query(`UPDATE beds SET status = 'occupied' WHERE id = $1`, [bedId]);

    await db.query(
      `INSERT INTO vitals (id, facility_id, patient_id, encounter_id, recorded_by, recorded_at, heart_rate,
         systolic_bp, diastolic_bp, spo2, temperature_c, pain_score)
       VALUES ($1,$2,$3,$4,$5, now() - interval '3 hours', 88, 132, 78, 94, 37.6, 4)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, nurse1],
    );

    const prescriptionId = crypto.randomUUID();
    await db.query(
      `INSERT INTO prescriptions (id, facility_id, prescription_no, patient_id, encounter_id, prescribed_by,
         prescribed_at, status)
       VALUES ($1,$2,'RX-000002',$3,$4,$5, now() - interval '2 days', 'dispensed')`,
      [prescriptionId, facilityId, patientId, encounterId, doctor],
    );

    const items: [string, string, string, string, number, number][] = [
      ['DRG-PARA', '500mg', 'فموي', 'كل 8 ساعات', 8, 5],
      ['DRG-WARF', '5mg', 'فموي', 'مرة يوميًا', 24, 22],
    ];
    const itemIds: string[] = [];
    for (const [code, dose, route, frequency, intervalHours, price] of items) {
      const itemId = crypto.randomUUID();
      itemIds.push(itemId);
      await db.query(
        `INSERT INTO prescription_items (id, facility_id, prescription_id, drug_id, dose, route, frequency,
           duration_days, quantity, status, price, interval_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,14,28,'dispensed',$8,$9)`,
        [itemId, facilityId, prescriptionId, drugIds[code], dose, route, frequency, price, intervalHours],
      );
      const batch = await db.query<{ id: string }>(
        `SELECT id FROM drug_batches WHERE facility_id = $1 AND drug_id = $2 ORDER BY expiry_date LIMIT 1`,
        [facilityId, drugIds[code]],
      );
      if (batch.rows[0]) {
        await db.query(
          `INSERT INTO dispenses (id, facility_id, prescription_item_id, drug_batch_id, quantity, dispensed_by, dispensed_at)
           VALUES ($1,$2,$3,$4,28,$5, now() - interval '2 days')`,
          [crypto.randomUUID(), facilityId, itemId, batch.rows[0].id, userIds['pharmacist:pharmacist@demo.hms']],
        );
        await db.query(`UPDATE drug_batches SET qty_on_hand = qty_on_hand - 28 WHERE id = $1`, [batch.rows[0].id]);
      }
    }

    // Paracetamol was given 8h45m ago -> next dose is 45 minutes overdue.
    await db.query(
      `INSERT INTO medication_administrations (id, facility_id, patient_id, encounter_id, admission_id,
         prescription_item_id, scheduled_for, administered_at, status, dose_given, route, identity_verified,
         allergy_checked, administered_by)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '8 hours 45 minutes', now() - interval '8 hours 45 minutes',
               'given','500mg','فموي',true,true,$7)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, admissionId, itemIds[0], nurse1],
    );
    // Warfarin (high alert) was given 20h ago with a second nurse as witness.
    await db.query(
      `INSERT INTO medication_administrations (id, facility_id, patient_id, encounter_id, admission_id,
         prescription_item_id, scheduled_for, administered_at, status, dose_given, route, identity_verified,
         allergy_checked, administered_by, witness_by)
       VALUES ($1,$2,$3,$4,$5,$6, now() - interval '20 hours', now() - interval '20 hours',
               'given','5mg','فموي',true,true,$7,$8)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, admissionId, itemIds[1], nurse1, nurse2],
    );

    const planId = crypto.randomUUID();
    await db.query(
      `INSERT INTO care_plans (id, facility_id, patient_id, encounter_id, admission_id, title, nursing_diagnosis,
         goals, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'خطة رعاية قصور القلب','خطر عدم استقرار الحالة نتيجة الاحتباس السوائل',
               'توازن السوائل، وزن يومي، وتقييم ضيق النفس كل 4 ساعات وحماية من النزف', $6, now() - interval '2 days')`,
      [planId, facilityId, patientId, encounterId, admissionId, nurse1],
    );
    const tasks: [string, string, number | null][] = [
      ['قياس الوزن وتسجيل توازن السوائل', "now() - interval '30 minutes'", 24],
      ['تقييم ضيق النفس ومعدل التنفس', "now() + interval '2 hours'", 4],
      ['تقييم علامات النزف (وارفارين)', "now() + interval '6 hours'", 12],
    ];
    for (const [description, dueAt, frequencyHours] of tasks) {
      await db.query(
        `INSERT INTO care_plan_tasks (id, facility_id, care_plan_id, description, due_at, frequency_hours)
         VALUES ($1,$2,$3,$4, ${dueAt}, $5)`,
        [crypto.randomUUID(), facilityId, planId, description, frequencyHours],
      );
    }

    await db.query(
      `INSERT INTO shift_handovers (id, facility_id, patient_id, encounter_id, admission_id, shift, patient_condition,
         situation, background, assessment, recommendation, from_user_id, to_user_id, handed_over_at)
       VALUES ($1,$2,$3,$4,$5,'night','improving','المريض هادئ، ألم صدري أقل من أمس بعد المسكن',
               'قصور قلب مزمن، بدأ وارفارين قبل يومين، وظائف الكلى آخر تحليل طبيعية',
               'ضغط 132/78 ونبض 88 وتشبع 94%، لا علامات نزف ظاهرة',
               'متابعة جرعة الوارفارين مع شاهد، وزن صباحي، ومراجعة INR قبل الخروج', $6,$7, now() - interval '6 hours')`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, admissionId, nurse1, nurse2],
    );
  }

  // -------------------------------------------------------------- Surgery ----
  // One elective case booked for the afternoon, so the theatre board, the WHO
  // checklist, the anaesthesia record and the recovery flow can be exercised.
  {
    const surgeon = userIds['surgeon:surgeon@demo.hms'];
    const anesthetist = userIds['anesthesiologist:anesthesia@demo.hms'];
    const patientId = patientIds[4];
    const encounterId = crypto.randomUUID();
    await db.query(
      `INSERT INTO encounters (id, facility_id, encounter_no, patient_id, encounter_type, department_id, doctor_id,
         status, chief_complaint, started_at, created_by)
       VALUES ($1,$2,'ENC-000004',$3,'outpatient',$4,$5,'open','ألم مراري متكرر مع حصوات في المرارة', now() - interval '1 day', $5)`,
      [encounterId, facilityId, patientId, deptIds.OR, surgeon],
    );
    await db.query(
      `INSERT INTO surgical_cases (id, facility_id, case_no, patient_id, encounter_id, theatre_id, procedure_name,
         procedure_code, laterality, priority, anesthesia_type, surgeon_id, anesthesiologist_id, scheduled_at,
         estimated_minutes, notes, created_by)
       VALUES ($1,$2,'SUR-000001',$3,$4,$5,'استئصال المرارة بالمنظار','0FT44ZZ','none','elective','general',
               $6,$7, now() + interval '2 hours', 90, 'مريض صائم منذ منتصف الليل، تحاليل التخثر طبيعية', $6)`,
      [crypto.randomUUID(), facilityId, patientId, encounterId, theatreIds['OR-1'], surgeon, anesthetist],
    );
  }

  // ------------------------------------------------------------------- ICU ----
  // The cardiac patient admitted to the ICU bed gets a live ICU stay with a
  // charted observation, high-flow oxygen settings, today's care bundle and a
  // SOFA score computed from the same values the API would use.
  {
    const intensivist = userIds['intensivist:intensivist@demo.hms'];
    const icuNurse = userIds['icu_nurse:icunurse@demo.hms'];
    const adm = await db.query<{ id: string; patient_id: string; encounter_id: string; bed_id: string }>(
      `SELECT id, patient_id, encounter_id, bed_id FROM admissions WHERE admission_no = 'ADM-000002'`,
    );
    const admission = adm.rows[0];
    if (admission) {
      const stayId = crypto.randomUUID();
      await db.query(
        `INSERT INTO icu_stays (id, facility_id, stay_no, admission_id, patient_id, encounter_id, bed_id,
           intensivist_id, opened_by, opened_at)
         VALUES ($1,$2,'ICU-000001',$3,$4,$5,$6,$7,$7, now() - interval '2 days')`,
        [stayId, facilityId, admission.id, admission.patient_id, admission.encounter_id, admission.bed_id, intensivist],
      );
      await db.query(
        `INSERT INTO icu_observations (id, facility_id, stay_id, recorded_at, heart_rate, systolic_bp, diastolic_bp,
           resp_rate, spo2, temperature_c, gcs, rass, urine_ml, glucose, notes, recorded_by)
         VALUES
           ($1,$2,$3, now() - interval '4 hours', 88, 132, 78, 22, 94, 37.6, 15, -1, 380, 118, 'مستقر على أكسجين عالي التدفق', $4),
           ($5,$2,$3, now() - interval '1 hour', 92, 128, 74, 24, 92, 37.8, 15, -1, 260, 126, 'زيادة بسيطة في معدل التنفس، لا ضيق واضح', $4)`,
        [crypto.randomUUID(), facilityId, stayId, icuNurse, crypto.randomUUID()],
      );
      await db.query(
        `INSERT INTO icu_ventilator_settings (id, facility_id, stay_id, mode, fio2_pct, peep_cmh2o, set_rate, reason, recorded_by, recorded_at)
         VALUES ($1,$2,$3,'hfnc',40,5,24,'دعم تنفسي بعد تدهور تشبع الأكسجين', $4, now() - interval '2 days')`,
        [crypto.randomUUID(), facilityId, stayId, intensivist],
      );
      await db.query(
        `INSERT INTO icu_daily_goals (id, facility_id, stay_id, goal_date, sedation_target, head_of_bed_elevated,
           vap_bundle, dvt_prophylaxis, stress_ulcer_prophylaxis, nutrition_plan, early_mobility, notes, created_by)
         VALUES ($1,$2,$3, current_date, true, true, true, true, true, true, false,
                 'مريض بلا تنبيب: الاستمرار على HFNC وتقييم الفطام بعد استقرار التشبع', $4)`,
        [crypto.randomUUID(), facilityId, stayId, icuNurse],
      );
      const sofa = {
        respiration: 2, coagulation: 0, liver: 0, cardiovascular: 0, cns: 0, renal: 1,
        detail: {
          respiration: 'PaO2/FiO2 = 225 مع دعم تنفسي', coagulation: 'الصفيحات 180 ×10³/µL',
          liver: 'البيليروبين 0.8 mg/dL', cardiovascular: 'MAP 78', cns: 'GCS 15', renal: 'الكرياتينين 1.4 mg/dL',
        },
      };
      await db.query(
        `INSERT INTO icu_scores (id, facility_id, stay_id, kind, components, total, recorded_by, recorded_at)
         VALUES ($1,$2,$3,'sofa',$4,3,$5, now() - interval '1 hour')`,
        [crypto.randomUUID(), facilityId, stayId, JSON.stringify(sofa), intensivist],
      );
    }
  }

  // --------------------------------------------------------------- Nutrition --
  // The ICU patient (A-) is screened, assessed and on a diabetic diet with a
  // breakfast tray already delivered (so nursing can record intake) and the
  // remaining trays for today still queued for the kitchen.
  {
    const nurse = userIds['nurse:nurse@demo.hms'];
    const dietitian = userIds['dietitian:dietitian@demo.hms'];
    const kitchen = userIds['kitchen_staff:kitchen@demo.hms'];
    const adm = await db.query<{ id: string; patient_id: string; encounter_id: string }>(
      `SELECT id, patient_id, encounter_id FROM admissions WHERE admission_no = 'ADM-000002'`,
    );
    const admission = adm.rows[0];
    if (admission) {
      const screeningId = crypto.randomUUID();
      const bmi = 23.2;
      await db.query(
        `INSERT INTO nutrition_screenings (id, facility_id, patient_id, admission_id, encounter_id, screening_date,
           weight_kg, height_cm, bmi, weight_loss_pct, intake_reduction, disease_severity, age_years, score,
           risk_level, action_taken, notes, recorded_by, recorded_at)
         VALUES ($1,$2,$3,$4,$5, current_date - 1, 74, 178.5, $6, 6, 'mild', 'moderate', 68, 6, 'high',
                 'تحويل لأخصائي التغذية العلاجية خلال ٢٤ ساعة', 'نقص شهية منذ التنويم مع فقد وزن بسيط', $7,
                 now() - interval '1 day')`,
        [screeningId, facilityId, admission.patient_id, admission.id, admission.encounter_id, bmi, nurse],
      );

      const assessmentId = crypto.randomUUID();
      await db.query(
        `INSERT INTO nutrition_assessments (id, facility_id, patient_id, admission_id, screening_id,
           weight_kg, height_cm, bmi, ideal_weight_kg, energy_target_kcal, protein_target_g, fluid_limit_ml,
           recommended_energy_kcal, recommended_protein_g, nutrition_diagnosis, plan, assessed_by, assessed_at)
         VALUES ($1,$2,$3,$4,$5, 74, 178.5, $6, 66.3, 1850, 89, 2000, 1850, 88.8,
                 'سوء تغذية متوسط مع مرض حاد (قصور قلب وسكري) وفق فحص NRS-2002',
                 'حمية سكرية ١٨٥٠ كيلوكالوري و٨٩ غرام بروتين موزعة على ثلاث وجبات ووجبة خفيفة، مع مراقبة السكر بعد الوجبات واستكمال الحساب اليومي للطاقة.',
                 $7, now() - interval '1 day' + interval '2 hours')`,
        [assessmentId, facilityId, admission.patient_id, admission.id, screeningId, bmi, dietitian],
      );

      const dietOrderId = crypto.randomUUID();
      await db.query(
        `INSERT INTO nutrition_diet_orders (id, facility_id, patient_id, admission_id, encounter_id, order_no,
           assessment_id, diet_type, texture, restrictions, energy_target_kcal, protein_target_g, fluid_limit_ml,
           allergen_snapshot, ordered_by, started_at, notes)
         VALUES ($1,$2,$3,$4,$5,'NUT-000001',$6,'diabetic','normal','{diabetic,low_sodium}',1850,89,2000,
                 '[]'::jsonb, $7, now() - interval '1 day' + interval '2 hours',
                 'تجنّب السكريات البسيطة ومتابعة سكر الدم قبل الوجبات')`,
        [dietOrderId, facilityId, admission.patient_id, admission.id, admission.encounter_id, assessmentId, dietitian],
      );

      const share: [string, number, number][] = [['breakfast', 25, 0], ['lunch', 35, 1], ['dinner', 30, 2], ['snack', 10, 3]];
      let trayNo = 1;
      for (const [meal, pct, idx] of share) {
        const trayId = crypto.randomUUID();
        const delivered = idx === 0;
        await db.query(
          `INSERT INTO nutrition_trays (id, facility_id, diet_order_id, patient_id, admission_id, tray_no, tray_date,
             meal, status, kcal_planned, protein_planned_g, prepared_by, prepared_at, delivered_by, delivered_at, notes)
           VALUES ($1,$2,$3,$4,$5,$6, current_date, $7, $8, $9, $10, $11, now() - interval '3 hours',
             $12, $13, $14)`,
          [trayId, facilityId, dietOrderId, admission.patient_id, admission.id, `TRY-${String(trayNo++).padStart(6, '0')}`,
            meal, delivered ? 'delivered' : 'ordered', Math.round((1850 * pct) / 100),
            Math.round(((89 * pct) / 100) * 10) / 10, kitchen, delivered ? kitchen : null,
            delivered ? new Date().toISOString() : null, `حصة ${pct}% من هدف اليوم`],
        );
      }

      // A second in-house patient with a lactose allergy, so the API can prove
      // that a diet order without the matching restriction is refused.
      const lactoseAllergy = await db.query(`SELECT id FROM patient_allergies WHERE patient_id = $1`, [patientIds[2]]);
      if (!lactoseAllergy.rows[0]) {
        await db.query(
          `INSERT INTO patient_allergies (id, facility_id, patient_id, allergen, reaction, severity, noted_by)
           VALUES ($1,$2,$3,'حليب البقر','إسهال وغازات بعد تناول الحليب','moderate',$4)`,
          [crypto.randomUUID(), facilityId, patientIds[2], userIds['physician:dr.ahmed@demo.hms']],
        );
      }
    }
  }

  // -------------------------------------------------------------- Blood bank --
  // Synthetic donations covering compatible and deliberately incompatible
  // units, plus one open request for the ICU patient (A-) so the cross-match,
  // issue and transfusion chain can be walked end to end.
  {
    const tech = userIds['blood_bank_tech:bloodbank@demo.hms'];
    const donorPlan: { no: string; type: string; units: [string, number][] }[] = [
      { no: 'DNR-000001', type: 'O-', units: [['rbc', 2]] },
      { no: 'DNR-000002', type: 'A-', units: [['rbc', 2], ['ffp', 1]] },
      { no: 'DNR-000003', type: 'A+', units: [['rbc', 2]] },
      { no: 'DNR-000004', type: 'O+', units: [['rbc', 2]] },
      { no: 'DNR-000005', type: 'B+', units: [['rbc', 1], ['platelets', 1]] },
      { no: 'DNR-000006', type: 'AB+', units: [['ffp', 2]] },
      { no: 'DNR-000007', type: 'A-', units: [['platelets', 1]] },
    ];
    const componentDays: Record<string, number> = { rbc: 42, ffp: 365, platelets: 5, cryo: 365 };
    let unitSeq = 1;
    for (const d of donorPlan) {
      const donorId = crypto.randomUUID();
      await db.query(
        `INSERT INTO blood_donors (id, facility_id, donor_no, blood_type, hemoglobin, created_by, donated_at)
         VALUES ($1,$2,$3,$4,14.2,$5, now() - interval '3 days')`,
        [donorId, facilityId, d.no, d.type, tech],
      );
      for (const [component, count] of d.units) {
        for (let i = 0; i < count; i++) {
          await db.query(
            `INSERT INTO blood_units (id, facility_id, unit_no, donor_id, component, blood_type, volume_ml,
               collected_at, expires_at, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '3 days',
                     now() - interval '3 days' + make_interval(days => $8::int), 'available')`,
            [crypto.randomUUID(), facilityId, `BGU-${String(unitSeq++).padStart(6, '0')}`, donorId,
              component, d.type, component === 'rbc' ? 450 : 250, componentDays[component]],
          );
        }
      }
    }

    const icu = await db.query<{ patient_id: string; encounter_id: string }>(
      `SELECT patient_id, encounter_id FROM admissions WHERE admission_no = 'ADM-000002'`,
    );
    if (icu.rows[0]) {
      await db.query(
        `INSERT INTO blood_requests (id, facility_id, request_no, patient_id, encounter_id, component,
           units_requested, urgency, indication, hb_value, requested_by, requested_at)
         VALUES ($1,$2,'BLR-000001',$3,$4,'rbc',2,'urgent',
                 'هبوط الهيموغلوبين إلى 7.1 مع أعراض فقر دم وقصور قلب', 7.1, $5, now() - interval '2 hours')`,
        [crypto.randomUUID(), facilityId, icu.rows[0].patient_id, icu.rows[0].encounter_id,
          userIds['intensivist:intensivist@demo.hms']],
      );
    }
  }

  // ------------------------------------------------------- CSSD / infection --
  // A realistic sterile-services day: two packs from an approved load (one is
  // already issued to the booked cholecystectomy), a running cycle, a failed
  // cycle whose pack is quarantined, packs mid-reprocessing and one returned
  // pack. Infection control has an active isolation, surveillance cases in all
  // three states and a month of hand-hygiene observations.
  {
    const tech = userIds['cssd_tech:cssd@demo.hms'];
    const supervisor = userIds['cssd_tech:cssd2@demo.hms'];
    const ipc = userIds['infection_control:infection@demo.hms'];

    const setDefs: [string, string, string, number, string][] = [
      ['CSS-SET-01', 'طقم جراحة عامة أساسي', 'laparotomy', 42, 'OR'],
      ['CSS-SET-02', 'طقم استئصال مرارة بالمنظار', 'laparotomy', 28, 'OR'],
      ['CSS-SET-03', 'طقم جراحة عظام صغرى', 'orthopedic', 55, 'OR'],
      ['CSS-SET-04', 'طقم تضميد جروح', 'dressing', 12, 'INP'],
      ['CSS-SET-05', 'طقم ولادة', 'other', 24, 'OR'],
      ['CSS-SET-06', 'طقم جراحة عامة احتياطي', 'laparotomy', 40, 'OR'],
      ['CSS-SET-07', 'طقم قسطرة قلبية', 'endoscopy', 18, 'OR'],
    ];
    const setIds: Record<string, string> = {};
    for (const [code, nameAr, category, count, dept] of setDefs) {
      const id = crypto.randomUUID();
      setIds[code] = id;
      await db.query(
        `INSERT INTO cssd_instrument_sets (id, facility_id, code, name_ar, category, instrument_count, department, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, facilityId, code, nameAr, category, count, dept, supervisor],
      );
    }

    const loadDefs: {
      id: string; no: string; autoclave: string; cycle: number; packs: number;
      status: string; chemical: string; biological: string; agoHours: number; approved?: boolean;
    }[] = [
      { id: crypto.randomUUID(), no: 'CSL-000001', autoclave: 'STM-01', cycle: 5, packs: 2, status: 'approved',
        chemical: 'pass', biological: 'pass', agoHours: 52, approved: true },
      { id: crypto.randomUUID(), no: 'CSL-000002', autoclave: 'STM-02', cycle: 12, packs: 1, status: 'running',
        chemical: 'pass', biological: 'pending', agoHours: 2 },
      { id: crypto.randomUUID(), no: 'CSL-000003', autoclave: 'STM-01', cycle: 6, packs: 1, status: 'failed',
        chemical: 'pass', biological: 'fail', agoHours: 26 },
    ];
    for (const l of loadDefs) {
      await db.query(
        `INSERT INTO cssd_sterilization_loads (id, facility_id, load_no, autoclave_code, method, cycle_no,
           temperature_c, pressure_bar, duration_min, pack_count, status, chemical_indicator, biological_indicator,
           result_notes, operator_id, started_at, resulted_at, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,'steam',$5,134,2.1,18,$6,$7,$8,$9,$10,$11,
                 now() - make_interval(hours => $12::int),
                 $13, $14, $15)`,
        [l.id, facilityId, l.no, l.autoclave, l.cycle, l.packs, l.status, l.chemical, l.biological,
          l.status === 'failed' ? 'فشل المؤشر البيولوجي في عينة اليوم، أُعيدت الدورة بعد صيانة المصيدة' : null,
          tech, l.agoHours, l.status === 'running' ? null : new Date(Date.now() - (l.agoHours - 1) * 3600_000).toISOString(),
          l.approved ? supervisor : null,
          l.approved ? new Date(Date.now() - (l.agoHours - 2) * 3600_000).toISOString() : null],
      );
    }
    const [load1, load2, load3] = loadDefs.map((l) => l.id);

    const surgical = await db.query<{ id: string }>(`SELECT id FROM surgical_cases WHERE case_no = 'SUR-000001'`);
    const caseId = surgical.rows[0]?.id ?? null;

    type Pack = {
      no: string; set: string; status: string; packaging: string; cycle: number; load?: string;
      expiresDays?: number; releasedHours?: number; caseLinked?: boolean; usedHours?: number; returnedHours?: number;
    };
    const packDefs: Pack[] = [
      { no: 'CSS-000001', set: 'CSS-SET-02', status: 'issued', packaging: 'container', cycle: 3, load: load1,
        expiresDays: 28, releasedHours: 50, caseLinked: true },
      { no: 'CSS-000002', set: 'CSS-SET-01', status: 'released', packaging: 'wrap', cycle: 2, load: load1,
        expiresDays: 27, releasedHours: 50 },
      { no: 'CSS-000003', set: 'CSS-SET-03', status: 'sterilizing', packaging: 'container', cycle: 4, load: load2 },
      { no: 'CSS-000004', set: 'CSS-SET-04', status: 'washing', packaging: 'wrap', cycle: 1 },
      { no: 'CSS-000005', set: 'CSS-SET-05', status: 'dirty', packaging: 'wrap', cycle: 2 },
      { no: 'CSS-000006', set: 'CSS-SET-06', status: 'used', packaging: 'container', cycle: 7,
        usedHours: 20, releasedHours: 90 },
      { no: 'CSS-000007', set: 'CSS-SET-07', status: 'quarantined', packaging: 'wrap', cycle: 1, load: load3 },
    ];
    for (const pk of packDefs) {
      const id = crypto.randomUUID();
      const released = pk.releasedHours != null ? new Date(Date.now() - pk.releasedHours * 3600_000).toISOString() : null;
      await db.query(
        `INSERT INTO cssd_packs (id, facility_id, pack_no, set_id, load_id, status, packaging, cycle_count,
           washed_by, washed_at, packed_by, packed_at, released_at, expires_at, issued_to, issued_to_case_id,
           issued_by, issued_at, used_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 CASE WHEN $6 IN ('washing') THEN NULL ELSE now() - interval '3 hours' END, $9::uuid,
                 CASE WHEN $6 IN ('dirty','washing') THEN NULL ELSE now() - interval '2 hours' END,
                 $10,
                 CASE WHEN $11::int IS NULL THEN NULL ELSE now() + make_interval(days => $11::int) END,
                 CASE WHEN $6 = 'issued' THEN 'غرفة العمليات 1' ELSE NULL END,
                 $12::uuid,
                 CASE WHEN $6 = 'issued' THEN $13::uuid ELSE NULL END,
                 CASE WHEN $6 = 'issued' THEN now() - interval '90 minutes' ELSE NULL END,
                 CASE WHEN $14::int IS NULL THEN NULL ELSE now() - make_interval(hours => $14::int) END,
                 $15)`,
        [id, facilityId, pk.no, setIds[pk.set], pk.load ?? null, pk.status, pk.packaging, pk.cycle, tech,
          released ? new Date(Date.now() - (pk.releasedHours! - 1) * 3600_000).toISOString() : null,
          pk.expiresDays ?? null, pk.caseLinked ? caseId : null, pk.caseLinked ? supervisor : null,
          pk.usedHours ?? null,
          pk.status === 'quarantined' ? 'حجز احترازي بعد فشل المؤشر البيولوجي للدورة CSL-000003' : null],
      );
    }

    const adm = await db.query<{ id: string; patient_id: string }>(
      `SELECT id, patient_id FROM admissions WHERE admission_no = 'ADM-000002'`,
    );
    const icuAdmission = adm.rows[0];
    if (icuAdmission) {
      await db.query(
        `INSERT INTO infection_isolations (id, facility_id, patient_id, admission_id, precaution, organism, reason,
           started_at, ordered_by)
         VALUES ($1,$2,$3,$4,'contact','Clostridioides difficile (مشتبه)',
                 'إسهال مائي منذ ٢٤ ساعة بعد مضادات حيوية واسعة الطيف، عينة toxin قيد الفحص', now() - interval '20 hours', $5)`,
        [crypto.randomUUID(), facilityId, icuAdmission.patient_id, icuAdmission.id, ipc],
      );
      await db.query(
        `INSERT INTO infection_isolations (id, facility_id, patient_id, admission_id, precaution, organism, reason,
           started_at, ordered_by, ended_at, ended_by, end_reason)
         VALUES ($1,$2,$3,$4,'droplet','MRSA',
                 'نتيجة مسحة أنفية إيجابية عند الدخول، مع جروح مفتوحة', now() - interval '12 days', $5,
                 now() - interval '9 days', $5, 'تكررت المسحة سلبياً مرتين متتاليتين وأُوقف العزل حسب السياسة')`,
        [crypto.randomUUID(), facilityId, icuAdmission.patient_id, icuAdmission.id, ipc],
      );

      const caseDefs: [string, string, string, string][] = [
        ['clabsi', 'Staphylococcus epidermidis', 'عينة من القسطرة المركزية موجبة بعد ٩ أيام من الإدخال', 'suspected'],
        ['cauti', 'Escherichia coli', 'زرع بول موجب مع أعراض بيلة وحمى بعد قسطرة بولية', 'confirmed'],
        ['vap', '', 'تحسن بعد ٤٨ ساعة من إيقاف المضاد الحيوي؛ لا دليل على التهاب رئوي', 'excluded'],
      ];
      let onsetOffset = 6;
      for (const [caseType, organism, note, status] of caseDefs) {
        const reportedAt = new Date(Date.now() - onsetOffset * 86_400_000).toISOString();
        await db.query(
          `INSERT INTO infection_cases (id, facility_id, patient_id, admission_id, case_type, organism, onset_date,
             device_days, status, reported_by, reported_at, reviewed_by, reviewed_at, review_note)
           VALUES ($1,$2,$3,$4,$5,$6, current_date - $7::int, 9, $8, $9, $10, $11, $12, $13)`,
          [crypto.randomUUID(), facilityId, icuAdmission.patient_id, icuAdmission.id, caseType,
            organism || null, onsetOffset, status, userIds['nurse:nurse@demo.hms'], reportedAt,
            status === 'suspected' ? null : ipc,
            status === 'suspected' ? null : new Date(Date.now() - (onsetOffset - 2) * 86_400_000).toISOString(),
            status === 'suspected' ? null : note],
        );
        onsetOffset += 5;
      }

      const units: [string, string][] = [['العناية المركزة', 'ICU'], ['الباطنة', 'INP'], ['الطوارئ', 'ER']];
      let day = 1;
      for (const [unit] of units) {
        for (let i = 0; i < 8; i++) {
          const opportunities = 20;
          const compliant = [17, 18, 16, 19, 15, 18, 20, 17][(i + day) % 8];
          await db.query(
            `INSERT INTO hand_hygiene_audits (id, facility_id, unit, moment, opportunities, compliant,
               observed_role, observed_date, observer_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7, current_date - $8::int, $9)`,
            [crypto.randomUUID(), facilityId, unit,
              ['before_patient', 'before_aseptic', 'after_body_fluid', 'after_patient', 'after_surroundings'][i % 5],
              opportunities, compliant, ['nurse', 'physician', 'tech'][i % 3], day, ipc],
          );
          day += 1;
        }
      }
    }
  }

  // Seeded documents use fixed numbers, so move each sequence past the highest
  // demo number. The floor is derived from the seeded rows rather than a magic
  // constant: a fixed floor broke silently once a module seeded more records
  // (13 blood units) than the constant assumed, and the first live record hit a
  // UNIQUE violation. Table/column names are constants, never user input.
  const sequenceSources: [string, string, string, string][] = [
    ['appointment', 'appointments', 'appointment_no', 'APT'],
    ['mrn', 'patients', 'mrn', 'MRN'],
    ['er_mrn', 'patients', 'mrn', 'ER'],
    ['encounter', 'encounters', 'encounter_no', 'ENC'],
    ['lab_order', 'lab_orders', 'order_no', 'LAB'],
    ['prescription', 'prescriptions', 'prescription_no', 'RX'],
    ['invoice', 'invoices', 'invoice_no', 'INV'],
    ['claim', 'insurance_claims', 'claim_no', 'CLM'],
    ['admission', 'admissions', 'admission_no', 'ADM'],
    ['surgery', 'surgical_cases', 'case_no', 'SUR'],
    ['icu_stay', 'icu_stays', 'stay_no', 'ICU'],
    ['imaging', 'imaging_orders', 'order_no', 'IMG'],
    ['blood_donor', 'blood_donors', 'donor_no', 'DNR'],
    ['blood_unit', 'blood_units', 'unit_no', 'BGU'],
    ['blood_request', 'blood_requests', 'request_no', 'BLR'],
    ['nutrition_order', 'nutrition_diet_orders', 'order_no', 'NUT'],
    ['nutrition_tray', 'nutrition_trays', 'tray_no', 'TRY'],
    ['cssd_pack', 'cssd_packs', 'pack_no', 'CSS'],
    ['cssd_load', 'cssd_sterilization_loads', 'load_no', 'CSL'],
  ];
  for (const [name, table, column, prefix] of sequenceSources) {
    const max = await db.query<{ next: number }>(
      `SELECT COALESCE(max(NULLIF(regexp_replace(${column}, '\\D', '', 'g'), '')::int), 0) + 1 AS next
         FROM ${table} WHERE ${column} LIKE '${prefix}-%'`,
    );
    await db.query(
      `INSERT INTO number_sequences (facility_id, name, next_value) VALUES ($1,$2,$3)
       ON CONFLICT (facility_id, name) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, $3)`,
      [facilityId, name, Math.max(1, Number(max.rows[0]?.next ?? 1))],
    );
  }

  await writeAudit(
    { query: db.query.bind(db) } as any,
    {
      facilityId,
      action: 'system.seed',
      entityType: 'system',
      detail: { facilities: 2, users: users.length + 1, patients: patientDefs.length, synthetic: true },
    },
  );

  return { seeded: true, facilityId, branchId, patientIds, users: users.length + 1 };
}
