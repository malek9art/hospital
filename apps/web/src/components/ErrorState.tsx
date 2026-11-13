import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ title = 'تعذّر إتمام الطلب', message, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50/90 p-4 text-rose-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
    >
      <div className="space-y-0.5">
        <p className="text-sm font-bold flex items-center gap-1.5">
          <span aria-hidden="true">⚠</span>
          <span>{title}</span>
        </p>
        <p className="text-xs sm:text-sm text-rose-800">{message}</p>
      </div>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry} className="shrink-0 border-rose-300 text-rose-900">
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}
