import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  pushToast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  pushToast: () => {},
  success: () => {},
  error: () => {},
  info: () => {},
});

let seq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = seq++;
      setItems((prev) => [...prev.slice(-4), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 6500 : 4000);
    },
    [dismiss],
  );

  const success = useCallback((m: string) => pushToast(m, 'success'), [pushToast]);
  const error = useCallback((m: string) => pushToast(m, 'error'), [pushToast]);
  const info = useCallback((m: string) => pushToast(m, 'info'), [pushToast]);

  return (
    <ToastContext.Provider value={{ pushToast, success, error, info }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 start-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none no-print"
      >
        {items.map((t) => {
          const style =
            t.kind === 'error'
              ? 'bg-rose-900 text-white border-rose-700'
              : t.kind === 'success'
                ? 'bg-emerald-900 text-white border-emerald-700'
                : 'bg-slate-900 text-white border-slate-700';
          const icon = t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : '●';
          return (
            <div
              key={t.id}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto rounded-xl border px-3.5 py-2.5 text-xs sm:text-sm shadow-lg flex items-start justify-between gap-2 ${style}`}
            >
              <span className="flex items-start gap-2">
                <span aria-hidden="true" className="font-bold">
                  {icon}
                </span>
                <span>{t.message}</span>
              </span>
              <button
                type="button"
                aria-label="إغلاق الإشعار"
                onClick={() => dismiss(t.id)}
                className="opacity-75 hover:opacity-100 px-1 text-xs cursor-pointer"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Inline banner kept for explicit persistent page alerts alongside live toasts. */
export function Msg({ text, kind = 'error' }: { text: string | null; kind?: 'error' | 'ok' }) {
  if (!text) return null;
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`rounded-lg px-3.5 py-2.5 text-sm mb-3 flex items-start gap-2 ${
        kind === 'error'
          ? 'bg-rose-50 text-rose-800 border border-rose-200'
          : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
      }`}
    >
      <span aria-hidden="true" className="font-bold">
        {kind === 'error' ? '⚠' : '✓'}
      </span>
      <span>{text}</span>
    </div>
  );
}
