import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, action, children, className = '' }: CardProps) {
  return (
    <section className={`card p-4 ${className}`.trim()}>
      {(title || action || subtitle) && (
        <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
          <div>
            {title && <h2 className="font-bold text-slate-800 text-base leading-snug">{title}</h2>}
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
