export type Lang = 'ar' | 'en';

let activeLang: Lang = 'ar';

export function setFormatLanguage(lang: Lang) {
  activeLang = lang;
}

export function getFormatLanguage(): Lang {
  return activeLang;
}

const localeOf = (lang?: Lang) => ((lang ?? activeLang) === 'en' ? 'en-SA' : 'ar-SA');

export const money = (v: number | string | null | undefined, lang?: Lang) =>
  new Intl.NumberFormat(localeOf(lang), {
    style: 'currency',
    currency: 'SAR',
    maximumFractionDigits: 2,
  }).format(Number(v ?? 0));

export const dt = (v?: string | null, lang?: Lang) => {
  if (!v) return '—';
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return String(v);
  return new Intl.DateTimeFormat(localeOf(lang), {
    dateStyle: 'medium',
    timeStyle: 'short',
    calendar: 'gregory',
  }).format(parsed);
};

export const day = (v?: string | null) => {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return String(v);
  return new Intl.DateTimeFormat('en-CA', { calendar: 'gregory' }).format(parsed);
};

export const shortDate = (v?: string | null, lang?: Lang) => {
  if (!v) return '—';
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return String(v);
  return new Intl.DateTimeFormat(localeOf(lang), {
    month: 'short',
    day: 'numeric',
    calendar: 'gregory',
  }).format(parsed);
};

export const num = (v: number | string | null | undefined, lang?: Lang) =>
  new Intl.NumberFormat(localeOf(lang)).format(Number(v ?? 0));

export const formatMoney = money;
export const formatDateTime = dt;
export const formatDate = day;
export const formatIsoDate = day;
export const formatShortDate = shortDate;
export const formatNumber = num;
