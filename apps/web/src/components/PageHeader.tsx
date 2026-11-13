import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  subtitle?: string;
  limits?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, subtitle, limits, actions }: PageHeaderProps) {
  const desc = description ?? subtitle;
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4 no-print">
      <div className="space-y-1">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">{title}</h1>
        {desc && <p className="text-xs sm:text-sm text-slate-600">{desc}</p>}
        {limits && (
          <p className="text-[11px] text-slate-500 bg-slate-100/90 border border-slate-200 rounded-md px-2.5 py-1 inline-block">
            <strong className="font-semibold text-slate-700">الحدود المعلنة:</strong> {limits}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
