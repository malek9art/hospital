import { STATUS_MAP, TONE_CLASSES, type StatusTone } from '../lib/statusMap';
import { usePreferences } from '../lib/preferences';

export interface BadgeProps {
  value: string;
  tone?: StatusTone;
  label?: string;
  className?: string;
}

export function Badge({ value, tone, label, className = '' }: BadgeProps) {
  const { prefs } = usePreferences();
  const mapped = STATUS_MAP[value];
  const resolvedTone: StatusTone = tone ?? mapped?.tone ?? 'neutral';
  const symbol = mapped?.symbol ?? '●';
  const text = label ?? (mapped ? (prefs.language === 'en' ? mapped.en : mapped.ar) : value);

  return (
    <span className={`badge ${TONE_CLASSES[resolvedTone]} ${className}`.trim()}>
      <span aria-hidden="true" className="text-[10px] leading-none opacity-80">
        {symbol}
      </span>
      <span>{text}</span>
    </span>
  );
}
