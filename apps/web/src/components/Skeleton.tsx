export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-slate-200/80 ${className}`.trim()}
    />
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="جارٍ تحميل البيانات" className="space-y-2.5 py-2">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 pt-2 border-t border-slate-100"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className="h-5" />
          ))}
        </div>
      ))}
      <span className="sr-only">جارٍ تحميل البيانات…</span>
    </div>
  );
}

export function PageSkeleton({ cards = 4, rows = 5 }: { cards?: number; rows?: number } = {}) {
  return (
    <div role="status" aria-label="جارٍ تحميل الصفحة" className="space-y-4">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="card p-4 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="card p-4">
        <TableSkeleton rows={rows} cols={5} />
      </div>
      <span className="sr-only">جارٍ تحميل الصفحة…</span>
    </div>
  );
}
