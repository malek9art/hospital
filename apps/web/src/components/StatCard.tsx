import type { ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'brand' | 'info';
  href?: string;
}

const TONE_BORDER: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'border-slate-200',
  success: 'border-emerald-200 bg-emerald-50/40',
  warning: 'border-amber-200 bg-amber-50/40',
  danger: 'border-rose-200 bg-rose-50/50',
  brand: 'border-brand-200 bg-brand-50/40',
  info: 'border-sky-200 bg-sky-50/40',
};

const TONE_VALUE: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'text-slate-900',
  success: 'text-emerald-800',
  warning: 'text-amber-800',
  danger: 'text-rose-800',
  brand: 'text-brand-800',
  info: 'text-sky-800',
};

export function StatCard({ label, value, sub, tone = 'default', href }: StatCardProps) {
  const inner = (
    <>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-1 ${TONE_VALUE[tone]}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-1">{sub}</p>}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={`card p-3.5 block transition hover:border-brand-500 hover:shadow-sm ${TONE_BORDER[tone]}`}
      >
        {inner}
      </a>
    );
  }

  return <div className={`card p-3.5 ${TONE_BORDER[tone]}`}>{inner}</div>;
}
