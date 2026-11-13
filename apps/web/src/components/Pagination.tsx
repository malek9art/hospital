import { Button } from './Button';

export interface PaginationProps {
  page: number;
  limit: number;
  total: number;
  onPageChange: (nextPage: number) => void;
}

export function Pagination({ page, limit, total, onPageChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="ترقيم الصفحات"
      className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100 text-xs text-slate-600 no-print"
    >
      <span>
        صفحة <strong>{page}</strong> من <strong>{totalPages}</strong> (الإجمالي {total})
      </span>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          السابق
        </Button>
        <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          التالي
        </Button>
      </div>
    </nav>
  );
}
