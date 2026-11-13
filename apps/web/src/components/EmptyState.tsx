import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="py-8 px-4 text-center rounded-lg border border-dashed border-slate-200 bg-slate-50/60">
      <div
        aria-hidden="true"
        className="w-10 h-10 mx-auto mb-2 rounded-full bg-slate-200/70 text-slate-500 grid place-items-center text-lg font-bold"
      >
        ∅
      </div>
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {description && <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{description}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
