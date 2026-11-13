import { hasAny, type Me } from '../api';

export type PageKey =
  | 'dashboard'
  | 'patients'
  | 'appointments'
  | 'clinic'
  | 'emergency'
  | 'inpatient'
  | 'nursing'
  | 'surgery'
  | 'icu'
  | 'bloodbank'
  | 'nutrition'
  | 'cssd'
  | 'lab'
  | 'radiology'
  | 'pharmacy'
  | 'billing'
  | 'hr'
  | 'reports'
  | 'audit'
  | 'admin'
  | 'modules'
  | 'portal';

export type NavGroupKey = 'overview' | 'clinical' | 'operations' | 'financial' | 'governance';

export interface NavItem {
  key: PageKey;
  group: NavGroupKey;
  labelAr: string;
  labelEn: string;
  perms: readonly string[];
  /** SVG path `d` attribute (24x24 viewBox) */
  icon: string;
  /** Optional hide flag until module is registered on backend */
  requiresPermPresent?: boolean;
}

export const NAV_GROUPS: Record<NavGroupKey, { ar: string; en: string }> = {
  overview: { ar: 'نظرة عامة', en: 'Overview' },
  clinical: { ar: 'الرعاية السريرية', en: 'Clinical Care' },
  operations: { ar: 'التشغيل والمساندة الطبية', en: 'Clinical Operations' },
  financial: { ar: 'المالية والتقارير', en: 'Finance & Reports' },
  governance: { ar: 'الإدارة والحوكمة', en: 'Administration & Governance' },
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'dashboard',
    group: 'overview',
    labelAr: 'لوحة القيادة',
    labelEn: 'Dashboard',
    perms: ['report.read'],
    icon: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  },
  {
    key: 'patients',
    group: 'clinical',
    labelAr: 'المرضى والسجل الطبي',
    labelEn: 'Patients & EMR',
    perms: ['patient.read'],
    icon: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  },
  {
    key: 'appointments',
    group: 'clinical',
    labelAr: 'المواعيد والاستقبال',
    labelEn: 'Appointments',
    perms: ['appointment.read'],
    icon: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z',
  },
  {
    key: 'clinic',
    group: 'clinical',
    labelAr: 'العيادة الخارجية',
    labelEn: 'Outpatient Clinic',
    perms: ['clinical.encounter.read'],
    icon: 'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z',
  },
  {
    key: 'emergency',
    group: 'clinical',
    labelAr: 'الطوارئ والفرز',
    labelEn: 'Emergency & Triage',
    perms: ['emergency.triage'],
    icon: 'M12 2L1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z',
  },
  {
    key: 'inpatient',
    group: 'clinical',
    labelAr: 'التنويم والأسرّة',
    labelEn: 'Inpatient & Beds',
    perms: ['inpatient.admit', 'inpatient.bed.manage'],
    icon: 'M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9a4 4 0 00-4-4z',
  },
  {
    key: 'nursing',
    group: 'clinical',
    labelAr: 'التمريض',
    labelEn: 'Nursing',
    perms: ['nursing.read'],
    icon: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  },
  {
    key: 'surgery',
    group: 'clinical',
    labelAr: 'العمليات والتخدير',
    labelEn: 'Surgery & Anesthesia',
    perms: ['surgery.read'],
    icon: 'M14.06 9.02l.92.92L5.92 19H5v-.92l9.06-9.06M17.66 3c-.25 0-.51.1-.7.29l-1.83 1.83 3.75 3.75 1.83-1.83a.996.996 0 000-1.41l-2.34-2.34c-.2-.2-.45-.29-.71-.29zm-3.6 3.19L3 17.25V21h3.75L17.81 9.94l-3.75-3.75z',
  },
  {
    key: 'icu',
    group: 'clinical',
    labelAr: 'العناية المركزة',
    labelEn: 'Intensive Care (ICU)',
    perms: ['icu.read'],
    icon: 'M3 13h2l2-5 4 10 3-7 2 2h5v-2h-4l-3-3-3 7-4-10-3 6H3v2z',
  },
  {
    key: 'lab',
    group: 'operations',
    labelAr: 'المختبر',
    labelEn: 'Laboratory',
    perms: ['lab.sample.collect', 'lab.result.verify'],
    icon: 'M7 2v2h1v5.17L4.23 16.7A2 2 0 006.02 20h11.96a2 2 0 001.79-3.3L16 9.17V4h1V2H7zm4 8.5V4h2v6.5l3.5 7H7.5l3.5-7z',
  },
  {
    key: 'radiology',
    group: 'operations',
    labelAr: 'الأشعة والتصوير',
    labelEn: 'Radiology',
    perms: ['radiology.read', 'radiology.perform', 'radiology.report', 'radiology.verify'],
    icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a7 7 0 016.93 6H15a3 3 0 00-6 0H5.07A7 7 0 0112 5zm0 14a7 7 0 01-6.93-6H9a3 3 0 006 0h3.93A7 7 0 0112 19z',
  },
  {
    key: 'pharmacy',
    group: 'operations',
    labelAr: 'الصيدلية',
    labelEn: 'Pharmacy',
    perms: ['pharmacy.prescription.read'],
    icon: 'M4.22 11.29l7.07-7.07a5 5 0 017.07 7.07l-7.07 7.07a5 5 0 01-7.07-7.07zm9.9-4.24l-4.24 4.24 4.24 4.24 4.24-4.24a3 3 0 00-4.24-4.24z',
  },
  {
    key: 'bloodbank',
    group: 'operations',
    labelAr: 'بنك الدم',
    labelEn: 'Blood Bank',
    perms: ['bloodbank.read'],
    icon: 'M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z',
  },
  {
    key: 'nutrition',
    group: 'operations',
    labelAr: 'التغذية الطبية',
    labelEn: 'Clinical Nutrition',
    perms: ['nutrition.read', 'nutrition.kitchen'],
    icon: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z',
  },
  {
    key: 'cssd',
    group: 'operations',
    labelAr: 'التعقيم ومكافحة العدوى',
    labelEn: 'CSSD & IPC',
    perms: ['cssd.read', 'infection.read'],
    icon: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z',
  },
  {
    key: 'billing',
    group: 'financial',
    labelAr: 'الفوترة والمدفوعات',
    labelEn: 'Billing & Payments',
    perms: ['billing.invoice.read'],
    icon: 'M14 2H6a2 2 0 00-2 2v16l4-2 4 2 4-2 4 2V8l-6-6zm2 13H8v-2h8v2zm0-4H8V9h8v2z',
  },
  {
    key: 'reports',
    group: 'financial',
    labelAr: 'التقارير والتصدير',
    labelEn: 'Reports & Export',
    perms: ['report.read'],
    icon: 'M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z',
  },
  {
    key: 'hr',
    group: 'governance',
    labelAr: 'الموارد البشرية',
    labelEn: 'Human Resources',
    perms: ['hr.read', 'hr.self'],
    icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  },
  {
    key: 'admin',
    group: 'governance',
    labelAr: 'المستخدمون والجلسات',
    labelEn: 'Users & Sessions',
    perms: ['admin.users.read', 'admin.sessions.manage', 'admin.facility.manage'],
    icon: 'M12 15.5A3.5 3.5 0 018.5 12 3.5 3.5 0 0112 8.5a3.5 3.5 0 013.5 3.5 3.5 3.5 0 01-3.5 3.5zm7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63a.5.5 0 00.12-.64l-2-3.46a.5.5 0 00-.61-.22l-2.49 1a7.03 7.03 0 00-1.69-.98l-.38-2.65A.488.488 0 0014 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 00-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66z',
  },
  {
    key: 'audit',
    group: 'governance',
    labelAr: 'سجل التدقيق',
    labelEn: 'Audit Trail',
    perms: ['audit.read'],
    icon: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  },
  {
    key: 'modules',
    group: 'governance',
    labelAr: 'حالة الوحدات',
    labelEn: 'Module Status',
    perms: ['patient.read', 'report.read', 'audit.read'],
    icon: 'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',
  },
  {
    key: 'portal',
    group: 'overview',
    labelAr: 'بوابة المريض',
    labelEn: 'Patient Portal',
    perms: ['portal.self'],
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z',
  },
];

const PAGE_SET = new Set<string>(NAV_ITEMS.map((n) => n.key));

export function isKnownPage(page: string): page is PageKey {
  return PAGE_SET.has(page);
}

export function canAccessPage(auth: Me | null, page: PageKey): boolean {
  const item = NAV_ITEMS.find((n) => n.key === page);
  if (!item) return false;
  return hasAny(auth, item.perms);
}

export function allowedNavItems(auth: Me | null): NavItem[] {
  if (!auth) return [];
  return NAV_ITEMS.filter((n) => hasAny(auth, n.perms));
}

export function findNavItem(key: string): NavItem | undefined {
  return NAV_ITEMS.find((n) => n.key === key);
}

export function defaultPageForUser(auth: Me): PageKey {
  const first = allowedNavItems(auth)[0];
  return first ? first.key : 'modules';
}

export const defaultLandingPage = defaultPageForUser;

