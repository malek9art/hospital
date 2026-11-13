import { useEffect, useId, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ReasonDialogProps {
  open: boolean;
  title: string;
  consequence?: string;
  consequenceNote?: string;
  label?: string;
  placeholder?: string;
  minLength?: number;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
  onClose: () => void;
  onSubmit?: (reason: string) => Promise<void>;
  onConfirm?: (reason: string) => Promise<void>;
}

/**
 * Clinical/Operational Reason Dialog replacing every `window.prompt`.
 * Preserves the user's draft text if a server/network error occurs and shows the
 * server error right inside the modal.
 */
export function ReasonDialog({
  open,
  title,
  consequence,
  consequenceNote,
  label = 'السبب السريري / التشغيلي الموثّق',
  placeholder = 'اكتب السبب بوضوح ليُحفظ في سجل التدقيق غير القابل للتعديل…',
  minLength = 5,
  confirmLabel = 'تأكيد وحفظ السبب',
  variant = 'danger',
  onClose,
  onSubmit,
  onConfirm,
}: ReasonDialogProps) {
  const fieldId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setServerError(null);
    }
  }, [open]);

  const trimmed = reason.trim();
  const valid = trimmed.length >= minLength;
  const desc = consequence ?? consequenceNote ?? 'سيُوثَّق هذا القرار في سجل التدقيق غير القابل للتعديل.';

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    const handler = onSubmit ?? onConfirm;
    if (!handler) return;
    setBusy(true);
    setServerError(null);
    try {
      await handler(trimmed);
      setReason('');
      onClose();
    } catch (err: any) {
      setServerError(err?.message ?? 'تعذّر تنفيذ الإجراء — تم الاحتفاظ بالنص المدخل للمحاولة مرة أخرى.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      description={desc}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button variant={variant} busy={busy} disabled={!valid} onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={handleConfirm} className="space-y-3">
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
          يُسجَّل هذا القرار مع اسمك والوقت في سجل التدقيق المقاوم للعبث ولا يمكن تعديله لاحقًا.
        </div>

        {serverError && (
          <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
            <strong>خطأ من الخادم:</strong> {serverError}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={fieldId} className="label !mb-0">
              {label} <span className="text-rose-600">*</span>
            </label>
            <span className={`text-[11px] font-mono ${valid ? 'text-emerald-700' : 'text-slate-500'}`}>
              {trimmed.length}/{minLength}+
            </span>
          </div>
          <textarea
            id={fieldId}
            rows={3}
            required
            minLength={minLength}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={placeholder}
            className="input"
          />
          {!valid && reason.length > 0 && (
            <p className="text-[11px] text-amber-700 mt-1">
              يرجى إدخال {minLength} أحرف على الأقل لتوثيق السبب بشكل كافٍ.
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}
