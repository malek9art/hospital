import { dt } from '../lib/format';

export interface PollingControlProps {
  paused?: boolean;
  onTogglePause?: () => void;
  enabled?: boolean;
  onToggle?: (next: boolean) => void;
  onRefresh: () => void;
  busy?: boolean;
  lastUpdatedAt: string | null;
}

export function PollingControl({
  paused,
  onTogglePause,
  enabled,
  onToggle,
  onRefresh,
  busy = false,
  lastUpdatedAt,
}: PollingControlProps) {
  const isPaused = paused ?? (enabled !== undefined ? !enabled : false);
  const handleToggle = () => {
    if (onTogglePause) onTogglePause();
    else if (onToggle) onToggle(isPaused);
  };

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5 text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 no-print">
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-emerald-500 animate-pulse'}`}
      />
      <span className="text-slate-600">
        {lastUpdatedAt ? `آخر تحديث: ${dt(lastUpdatedAt)}` : 'تحديث تلقائي (٢٥ث)'}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        aria-label="تحديث البيانات الآن"
        className="text-brand-700 hover:underline font-semibold px-1.5 py-0.5 cursor-pointer disabled:opacity-50"
      >
        {busy ? 'جارٍ التحديث…' : 'تحديث'}
      </button>
      <button
        type="button"
        onClick={handleToggle}
        aria-pressed={isPaused}
        className="text-slate-500 hover:text-slate-800 px-1.5 py-0.5 border-s border-slate-200 cursor-pointer"
      >
        {isPaused ? 'استئناف التلقائي' : 'إيقاف مؤقت'}
      </button>
    </div>
  );
}
