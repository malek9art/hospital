export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface StatusDef {
  ar: string;
  en: string;
  tone: StatusTone;
  symbol: string;
}

/**
 * Unified clinical, operational, and financial status map.
 * Every status carries both text and a geometric/typographic symbol so status
 * meaning never relies on colour alone (WCAG 1.4.1).
 */
export const STATUS_MAP: Record<string, StatusDef> = {
  // Appointments & Encounters
  booked: { ar: 'محجوز', en: 'Booked', tone: 'info', symbol: '●' },
  checked_in: { ar: 'حضر', en: 'Checked in', tone: 'info', symbol: '●' },
  in_consultation: { ar: 'في الاستشارة', en: 'In consultation', tone: 'warning', symbol: '◆' },
  in_progress: { ar: 'قيد التنفيذ', en: 'In progress', tone: 'warning', symbol: '◆' },
  completed: { ar: 'مكتمل', en: 'Completed', tone: 'success', symbol: '✓' },
  cancelled: { ar: 'ملغى', en: 'Cancelled', tone: 'danger', symbol: '✕' },
  no_show: { ar: 'لم يحضر', en: 'No show', tone: 'danger', symbol: '✕' },
  open: { ar: 'مفتوحة', en: 'Open', tone: 'warning', symbol: '●' },
  active: { ar: 'نشط', en: 'Active', tone: 'success', symbol: '✓' },
  closed: { ar: 'مغلقة', en: 'Closed', tone: 'neutral', symbol: '■' },

  // Lab & Radiology
  ordered: { ar: 'مطلوب', en: 'Ordered', tone: 'warning', symbol: '●' },
  collected: { ar: 'تم جمع العينة', en: 'Collected', tone: 'info', symbol: '◆' },
  performed: { ar: 'تم التصوير', en: 'Performed', tone: 'info', symbol: '◆' },
  reported: { ar: 'مسودة تقرير', en: 'Reported', tone: 'warning', symbol: '◆' },
  resulted: { ar: 'نتيجة مسجلة', en: 'Resulted', tone: 'warning', symbol: '◆' },
  verified: { ar: 'معتمدة', en: 'Verified', tone: 'success', symbol: '✓' },
  final: { ar: 'نهائي معتمد', en: 'Final', tone: 'success', symbol: '✓' },
  draft: { ar: 'مسودة', en: 'Draft', tone: 'neutral', symbol: '○' },
  urgent: { ar: 'عاجل', en: 'Urgent', tone: 'warning', symbol: '!' },
  stat: { ar: 'فوري حرج', en: 'STAT', tone: 'danger', symbol: '‼' },
  routine: { ar: 'روتيني', en: 'Routine', tone: 'neutral', symbol: '○' },
  high: { ar: 'مرتفع', en: 'High', tone: 'warning', symbol: '↑' },
  low: { ar: 'منخفض', en: 'Low', tone: 'warning', symbol: '↓' },
  critical_high: { ar: 'حرج مرتفع', en: 'Critical High', tone: 'danger', symbol: '▲' },
  critical_low: { ar: 'حرج منخفض', en: 'Critical Low', tone: 'danger', symbol: '▼' },

  // Dental, Physiotherapy & Medical Stores
  planned: { ar: 'مخطط', en: 'Planned', tone: 'info', symbol: '●' },
  referred: { ar: 'مُحال للتقييم', en: 'Referred', tone: 'warning', symbol: '◆' },
  partially_issued: { ar: 'صرف جزئي', en: 'Partially Issued', tone: 'warning', symbol: '◐' },
  low_stock: { ar: 'نقص مخزون', en: 'Low Stock', tone: 'danger', symbol: '!' },

  // Pharmacy & Billing
  issued: { ar: 'صادرة', en: 'Issued', tone: 'info', symbol: '●' },
  partially_dispensed: { ar: 'صرف جزئي', en: 'Partial', tone: 'warning', symbol: '◐' },
  dispensed: { ar: 'مصروفة', en: 'Dispensed', tone: 'success', symbol: '✓' },
  paid: { ar: 'مدفوعة', en: 'Paid', tone: 'success', symbol: '✓' },
  partially_paid: { ar: 'مدفوعة جزئيًا', en: 'Partially paid', tone: 'warning', symbol: '◐' },
  void: { ar: 'ملغاة', en: 'Void', tone: 'danger', symbol: '✕' },

  // Nutrition
  prepared: { ar: 'محضّرة', en: 'Prepared', tone: 'info', symbol: '◆' },
  delivered: { ar: 'مُسلَّمة', en: 'Delivered', tone: 'info', symbol: '●' },
  consumed: { ar: 'مستهلكة', en: 'Consumed', tone: 'success', symbol: '✓' },
  refused: { ar: 'مرفوضة', en: 'Refused', tone: 'danger', symbol: '✕' },
  stopped: { ar: 'متوقفة', en: 'Stopped', tone: 'neutral', symbol: '■' },

  // Blood bank
  available: { ar: 'متاحة', en: 'Available', tone: 'success', symbol: '✓' },
  reserved: { ar: 'محجوزة', en: 'Reserved', tone: 'warning', symbol: '◆' },
  transfused: { ar: 'مُنقلة', en: 'Transfused', tone: 'success', symbol: '✓' },
  discarded: { ar: 'مستبعدة', en: 'Discarded', tone: 'danger', symbol: '✕' },
  pending: { ar: 'قيد الانتظار', en: 'Pending', tone: 'warning', symbol: '○' },
  crossmatched: { ar: 'مطابقة', en: 'Crossmatched', tone: 'info', symbol: '✓' },
  stopped_reaction: { ar: 'أُوقف لتفاعل', en: 'Stopped (reaction)', tone: 'danger', symbol: '!' },
  stopped_other: { ar: 'أُوقف لسبب آخر', en: 'Stopped (other)', tone: 'warning', symbol: '■' },

  // CSSD & IPC
  dirty: { ar: 'ملوّثة', en: 'Dirty', tone: 'danger', symbol: '!' },
  washing: { ar: 'قيد الغسل', en: 'Washing', tone: 'warning', symbol: '◆' },
  packed: { ar: 'مغلّفة', en: 'Packed', tone: 'info', symbol: '●' },
  sterilizing: { ar: 'قيد التعقيم', en: 'Sterilizing', tone: 'warning', symbol: '◆' },
  released: { ar: 'معقّمة جاهزة', en: 'Released', tone: 'success', symbol: '✓' },
  used: { ar: 'مستخدمة', en: 'Used', tone: 'neutral', symbol: '■' },
  returned: { ar: 'مُعادة', en: 'Returned', tone: 'warning', symbol: '↺' },
  quarantined: { ar: 'محجوزة احترازيًا', en: 'Quarantined', tone: 'danger', symbol: '!' },
  recalled: { ar: 'مسحوبة', en: 'Recalled', tone: 'danger', symbol: '✕' },
  running: { ar: 'جارية', en: 'Running', tone: 'info', symbol: '◆' },
  passed: { ar: 'ناجحة', en: 'Passed', tone: 'success', symbol: '✓' },
  failed: { ar: 'فاشلة', en: 'Failed', tone: 'danger', symbol: '✕' },
  approved: { ar: 'معتمدة', en: 'Approved', tone: 'success', symbol: '✓' },
  suspected: { ar: 'مشتبهة', en: 'Suspected', tone: 'warning', symbol: '?' },
  confirmed: { ar: 'مؤكدة', en: 'Confirmed', tone: 'danger', symbol: '!' },
  excluded: { ar: 'مستبعدة', en: 'Excluded', tone: 'neutral', symbol: '✕' },

  // HR & Governance
  implemented: { ar: 'منفذ', en: 'Implemented', tone: 'success', symbol: '✓' },
  partial: { ar: 'جزئي', en: 'Partial', tone: 'warning', symbol: '◐' },
  not_implemented: { ar: 'غير منفذ', en: 'Not implemented', tone: 'neutral', symbol: '○' },
  on_leave: { ar: 'في إجازة', en: 'On leave', tone: 'warning', symbol: '◆' },
  suspended: { ar: 'موقوف', en: 'Suspended', tone: 'danger', symbol: '!' },
  terminated: { ar: 'منتهي الخدمة', en: 'Terminated', tone: 'neutral', symbol: '■' },
  rejected: { ar: 'مرفوض', en: 'Rejected', tone: 'danger', symbol: '✕' },
  expired: { ar: 'منتهية الصلاحية', en: 'Expired', tone: 'danger', symbol: '!' },
  expiring_soon: { ar: 'قريبة الانتهاء', en: 'Expiring soon', tone: 'warning', symbol: '!' },
  valid: { ar: 'سارية', en: 'Valid', tone: 'success', symbol: '✓' },
  pending_verification: { ar: 'بانتظار التحقق', en: 'Pending verification', tone: 'warning', symbol: '○' },
  revoked: { ar: 'مسحوبة', en: 'Revoked', tone: 'danger', symbol: '✕' },
  scheduled: { ar: 'مجدولة', en: 'Scheduled', tone: 'info', symbol: '●' },
  absent: { ar: 'متغيب', en: 'Absent', tone: 'danger', symbol: '✕' },
  inactive: { ar: 'غير نشط', en: 'Inactive', tone: 'neutral', symbol: '■' },
};

export const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-emerald-50 text-emerald-800 border border-emerald-200',
  warning: 'bg-amber-50 text-amber-800 border border-amber-200',
  danger: 'bg-rose-50 text-rose-800 border border-rose-200',
  info: 'bg-sky-50 text-sky-800 border border-sky-200',
  neutral: 'bg-slate-100 text-slate-700 border border-slate-200',
};
