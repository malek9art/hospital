export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="مسار التنقل" className="text-xs text-slate-500 mb-2 no-print">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((c, idx) => {
          const isLast = idx === items.length - 1;
          return (
            <li key={`${c.label}-${idx}`} className="flex items-center gap-1.5">
              {idx > 0 && <span aria-hidden="true" className="text-slate-300">/</span>}
              {c.href && !isLast ? (
                <a href={c.href} className="hover:text-brand-700 hover:underline">
                  {c.label}
                </a>
              ) : (
                <span aria-current={isLast ? 'page' : undefined} className={isLast ? 'font-semibold text-slate-700' : ''}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
