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
  ['admin.users.read', 'admin', 'عرض المستخدمين'],
  ['admin.users.manage', 'admin', 'إدارة المستخدمين'],
  ['admin.roles.manage', 'admin', 'إدارة الأدوار'],
  ['admin.facility.manage', 'admin', 'إدارة المنشآت'],
  ['admin.sessions.manage', 'admin', 'إدارة الجلسات'],
  ['admin.settings.manage', 'admin', 'إدارة الإعدادات'],
  ['audit.read', 'audit', 'الاطلاع على سجل التدقيق'],
  ['report.read', 'reports', 'عرض التقارير'],
  ['report.export', 'reports', 'تصدير التقارير'],
  ['portal.self', 'portal', 'بوابة المريض'],
];

const ALL = PERMISSIONS.map((p) => p[0]);
const ROLE_PERMS: Record<string, string[]> = {
  system_admin: ['admin.users.read', 'admin.users.manage', 'admin.roles.manage', 'admin.facility.manage', 'admin.sessions.manage', 'admin.settings.manage', 'audit.read', 'report.read'],
  hospital_director: ['report.read', 'report.export', 'billing.invoice.read', 'audit.read', 'admin.sessions.manage', 'admin.users.read', 'patient.read', 'appointment.read'],
  department_manager: ['patient.read', 'patient.chart.clinical', 'appointment.read', 'appointment.create', 'appointment.update', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.diagnose', 'clinical.note.write', 'clinical.prescription.create', 'clinical.order.create', 'clinical.vitals.write', 'lab.result.verify', 'billing.invoice.read', 'report.read', 'report.export'],
  physician: ['patient.read', 'patient.create', 'patient.update', 'patient.chart.clinical', 'patient.break_glass', 'appointment.read', 'appointment.update', 'clinical.encounter.read', 'clinical.encounter.create', 'clinical.note.write', 'clinical.diagnose', 'clinical.vitals.write', 'clinical.order.create', 'clinical.prescription.create', 'pharmacy.prescription.read', 'billing.invoice.read', 'report.read'],
  nurse: ['patient.read', 'patient.chart.clinical', 'appointment.read', 'appointment.checkin', 'clinical.encounter.read', 'clinical.vitals.write', 'clinical.note.write', 'lab.sample.collect', 'pharmacy.prescription.read', 'report.read'],
  receptionist: ['patient.read', 'patient.create', 'patient.chart.administrative', 'appointment.read', 'appointment.create', 'appointment.update', 'appointment.checkin', 'billing.invoice.read', 'billing.payment.record'],
  records_officer: ['patient.read', 'patient.create', 'patient.update', 'patient.merge', 'patient.chart.administrative', 'appointment.read', 'report.read'],
  lab_tech: ['patient.read', 'patient.chart.clinical', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify', 'lab.critical.ack', 'clinical.encounter.read'],
  pharmacist: ['patient.read', 'patient.chart.clinical', 'pharmacy.prescription.read', 'pharmacy.dispense', 'pharmacy.stock.manage', 'billing.invoice.read'],
  accountant: ['patient.read', 'patient.chart.administrative', 'billing.invoice.read', 'billing.invoice.create', 'billing.payment.record', 'billing.invoice.void', 'billing.discount.apply', 'insurance.claim.manage', 'report.read', 'report.export'],
  auditor: ['audit.read', 'report.read', 'admin.users.read'],
  patient: ['portal.self'],
};

const ROLES: [string, string, string][] = [
  ['system_admin', 'مدير النظام', 'System administrator'],
  ['hospital_director', 'الإدارة التنفيذية', 'Executive management'],
  ['department_manager', 'مدير قسم', 'Department manager'],
  ['physician', 'طبيب', 'Physician'],
  ['nurse', 'تمريض', 'Nurse'],
  ['receptionist', 'استقبال', 'Receptionist'],
  ['records_officer', 'السجلات الطبية', 'Medical records'],
  ['lab_tech', 'فني مختبر', 'Lab technician'],
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
  ];
  const deptIds: Record<string, string> = {};
  for (const [code, ar, en, type] of deptDefs) {
    const id = crypto.randomUUID();
    deptIds[code] = id;
    await db.query('INSERT INTO departments (id, facility_id, code, name_ar, name_en, dept_type) VALUES ($1,$2,$3,$4,$5,$6)', [id, facilityId, code, ar, en, type]);
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
    reception: await hashPassword('Reception#Demo2026'),
    records: await hashPassword('Records#Demo2026'),
    lab: await hashPassword('Lab#Demo2026'),
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
    ['reception@demo.hms', 'عبدالله الشهري', 'Abdullah Alshehri', 'موظف استقبال', 'receptionist', password.reception, 'ADM'],
    ['records@demo.hms', 'نورة السبيعي', 'Noura Alsubaie', 'أخصائي سجلات طبية', 'records_officer', password.records, 'ADM'],
    ['lab@demo.hms', 'فهد الدوسري', 'Fahad Aldosari', 'فني مختبر', 'lab_tech', password.lab, 'LAB'],
    ['lab2@demo.hms', 'هند الغامدي', 'Hind Alghamdi', 'أخصائية مختبر', 'lab_tech', password.lab, 'LAB'],
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
    await db.query('INSERT INTO drugs (id, code, name_ar, name_en, form, strength, price, is_controlled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, code, ar, en, form, strength, price, controlled]);
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
  for (const [ward, label, count] of [[wardId, 'G', 4], [icuId, 'ICU', 2]] as const) {
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

  // Seeded documents use fixed numbers; move sequences past them so the first
  // live document cannot collide with demo data.
  for (const name of ['appointment', 'mrn', 'encounter', 'lab_order', 'prescription', 'invoice', 'claim']) {
    await db.query(
      `INSERT INTO number_sequences (facility_id, name, next_value) VALUES ($1,$2,10)
       ON CONFLICT (facility_id, name) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, 10)`,
      [facilityId, name],
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
