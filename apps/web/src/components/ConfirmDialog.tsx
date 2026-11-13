import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  summary?: ReactNode;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function ConfirmDialog({
  open,
  title,
  description,
  summary,
  confirmLabel = 'تأكيد التنفيذ',
  variant = 'primary',
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) setErr(null);
  }, [open]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? 'تعذّر إتمام العملية');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            تراجع
          </Button>
          <Button variant={variant} busy={busy} onClick={run}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {summary && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1 text-slate-700">
            {summary}
          </div>
        )}
        {err && (
          <div role="alert" className="rounded-lg bg-rose-50 border border-rose-200 p-2.5 text-xs text-rose-800">
            {err}
          </div>
        )}
      </div>
    </Modal>
  );
}
