import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'modal' | 'sheet';
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  variant = 'modal',
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    // Move focus into dialog
    const timer = window.setTimeout(() => {
      const container = dialogRef.current;
      if (!container) return;
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? container).focus();
    }, 10);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const nodes = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (nodes.length === 0) {
          e.preventDefault();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const widthClass = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[1px] p-4 no-print"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={
          variant === 'sheet'
            ? 'fixed inset-y-0 start-0 w-full max-w-md bg-white shadow-2xl flex flex-col overflow-hidden'
            : `card w-full ${widthClass} shadow-2xl overflow-hidden flex flex-col max-h-[90vh]`
        }
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base sm:text-lg font-bold text-slate-900">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-xs text-slate-600 mt-1">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="إغلاق النافذة"
            onClick={onClose}
            className="btn-ghost !min-h-[36px] !px-2.5 !py-1 text-slate-500"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Sheet(props: Omit<ModalProps, 'variant'>) {
  return <Modal {...props} variant="sheet" />;
}
