import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger';
  busy?: boolean;
  size?: 'sm' | 'md';
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  busy = false,
  size = 'md',
  className = '',
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const baseClass =
    variant === 'danger' ? 'btn-danger' : variant === 'ghost' ? 'btn-ghost' : 'btn-primary';
  const sizeClass = size === 'sm' ? 'text-xs px-2.5 py-1.5' : '';

  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`${baseClass} ${sizeClass} ${className}`.trim()}
      {...rest}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      )}
      {children}
    </button>
  );
}
