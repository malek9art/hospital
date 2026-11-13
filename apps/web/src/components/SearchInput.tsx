import { useId } from 'react';

export interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'بحث…',
  label,
  ariaLabel,
  className = '',
}: SearchInputProps) {
  const inputId = useId();
  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className="label">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        <input
          id={inputId}
          type="search"
          value={value}
          aria-label={label ? undefined : ariaLabel ?? placeholder}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="input pe-9"
        />
        {value && (
          <button
            type="button"
            aria-label="مسح البحث"
            onClick={() => onChange('')}
            className="absolute end-2 text-slate-400 hover:text-slate-700 px-1.5 py-1 text-xs cursor-pointer"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
