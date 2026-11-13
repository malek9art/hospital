import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export interface FieldProps {
  label?: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: (id: string, errId?: string) => ReactNode;
  className?: string;
}

export function Field({ label, required, hint, error, htmlFor, children, className = '' }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const errId = error ? `${id}-err` : hint ? `${id}-hint` : undefined;

  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="label">
          {label}
          {required && <span className="text-rose-600 ms-0.5" aria-hidden="true">*</span>}
        </label>
      )}
      {children(id, errId)}
      {error ? (
        <p id={errId} role="alert" className="text-[11px] text-rose-700 font-medium mt-1">
          {error}
        </p>
      ) : hint ? (
        <p id={errId} className="text-[11px] text-slate-500 mt-1">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  wrapperClassName?: string;
}

export function Input({ label, hint, error, required, wrapperClassName, className = '', ...rest }: InputProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={wrapperClassName}>
      {(id, errId) => (
        <input
          id={id}
          required={required}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errId}
          className={`input ${className}`.trim()}
          {...rest}
        />
      )}
    </Field>
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  wrapperClassName?: string;
  children: ReactNode;
}

export function Select({ label, hint, error, required, wrapperClassName, className = '', children, ...rest }: SelectProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={wrapperClassName}>
      {(id, errId) => (
        <select
          id={id}
          required={required}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errId}
          className={`input ${className}`.trim()}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  wrapperClassName?: string;
}

export function Textarea({ label, hint, error, required, wrapperClassName, className = '', ...rest }: TextareaProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={wrapperClassName}>
      {(id, errId) => (
        <textarea
          id={id}
          required={required}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={errId}
          className={`input ${className}`.trim()}
          {...rest}
        />
      )}
    </Field>
  );
}
