export interface TabOption<K extends string = string> {
  key: K;
  label: string;
  count?: number;
}

export function Tabs<K extends string>({
  tabs,
  items,
  active,
  onChange,
  ariaLabel = 'تبويبات القسم',
}: {
  tabs?: readonly TabOption<K>[];
  items?: readonly TabOption<K>[];
  active: K;
  onChange: (key: K) => void;
  ariaLabel?: string;
}) {
  const list = tabs ?? items ?? [];
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex flex-wrap gap-1.5 p-1 rounded-xl bg-slate-100 border border-slate-200 no-print"
    >
      {list.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.key)}
            className={`min-h-[38px] px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition cursor-pointer flex items-center gap-1.5 ${
              selected
                ? 'bg-brand-700 text-white shadow-xs'
                : 'text-slate-700 hover:bg-white/80'
            }`}
          >
            <span>{t.label}</span>
            {t.count !== undefined && (
              <span
                className={`text-[11px] rounded-full px-1.5 py-0.5 ${
                  selected ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
