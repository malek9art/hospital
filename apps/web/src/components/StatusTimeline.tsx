export interface TimelineStep {
  key: string;
  label: string;
}

export function StatusTimeline({
  steps,
  currentKey,
  alertLabel,
}: {
  steps: readonly TimelineStep[];
  currentKey: string;
  alertLabel?: string | null;
}) {
  const activeIdx = steps.findIndex((s) => s.key === currentKey);

  return (
    <div aria-label="مراحل الحالة" className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {steps.map((step, idx) => {
        const done = activeIdx > idx;
        const current = activeIdx === idx;
        return (
          <div key={step.key} className="flex items-center gap-1">
            {idx > 0 && <span aria-hidden="true" className="text-slate-300">←</span>}
            <span
              aria-current={current ? 'step' : undefined}
              className={`rounded-full px-2 py-0.5 font-semibold border ${
                current
                  ? 'bg-brand-700 text-white border-brand-700'
                  : done
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : 'bg-slate-50 text-slate-500 border-slate-200'
              }`}
            >
              {done ? '✓ ' : current ? '● ' : ''}
              {step.label}
            </span>
          </div>
        );
      })}
      {alertLabel && (
        <span className="rounded-full px-2 py-0.5 font-semibold bg-rose-100 text-rose-800 border border-rose-300">
          ⚠ {alertLabel}
        </span>
      )}
    </div>
  );
}
