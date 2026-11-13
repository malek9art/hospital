import { useMemo, useState, type ReactNode } from 'react';
import { usePreferences } from '../lib/preferences';
import { EmptyState } from './EmptyState';
import { TableSkeleton } from './Skeleton';

export interface ColumnDef<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  /** Hide in mobile card secondary rows if empty or auxiliary */
  mobileLabel?: string;
  isActions?: boolean;
  hideInCard?: boolean;
  className?: string;
}

export interface DataTableProps<T = any> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  rowClassName?: (row: T) => string;
  caption?: string;
  cardTitle?: (row: T) => ReactNode;
  cardSubtitle?: (row: T) => ReactNode;
  cardBadge?: (row: T) => ReactNode;
  cardActions?: (row: T) => ReactNode;
}

/**
 * Responsive clinical DataTable:
 *  - Sortable columns via accessible header buttons.
 *  - Renders clean stacked cards on mobile (< md) when tableView='auto', or always
 *    cards/table when overridden in user preferences.
 */
export function DataTable<T = any>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyTitle = 'لا توجد سجلات مطابقة',
  emptyDescription,
  rowClassName,
  caption,
  cardTitle,
  cardSubtitle,
  cardBadge,
  cardActions,
}: DataTableProps<T>) {
  const { prefs } = usePreferences();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'ar');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  if (loading) {
    return <TableSkeleton rows={5} cols={Math.min(columns.length, 6)} />;
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const showCardsClass =
    prefs.tableView === 'cards' ? 'block' : prefs.tableView === 'table' ? 'hidden' : 'block md:hidden';
  const showTableClass =
    prefs.tableView === 'table' ? 'block' : prefs.tableView === 'cards' ? 'hidden' : 'hidden md:block';

  const dataColumns = columns.filter((c) => !c.isActions && !c.hideInCard);
  const actionColumn = columns.find((c) => c.isActions);

  return (
    <div>
      {/* Mobile / Card View */}
      <div className={`${showCardsClass} space-y-2.5 no-print`}>
        {sortedRows.map((row) => {
          const extraCls = rowClassName ? rowClassName(row) : '';
          const [primaryCol, ...restCols] = dataColumns;
          const hasCustomHeader = Boolean(cardTitle || cardSubtitle || cardBadge);
          return (
            <div
              key={rowKey(row)}
              className={`rounded-xl border border-slate-200 p-3 bg-white space-y-2 ${extraCls}`.trim()}
            >
              {hasCustomHeader ? (
                <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2">
                  <div className="min-w-0">
                    {cardTitle && <div className="font-semibold text-sm text-slate-900">{cardTitle(row)}</div>}
                    {cardSubtitle && <div className="text-xs text-slate-500 mt-0.5">{cardSubtitle(row)}</div>}
                  </div>
                  {cardBadge && <div className="text-xs shrink-0">{cardBadge(row)}</div>}
                </div>
              ) : (
                primaryCol && (
                  <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2">
                    <div className="font-semibold text-sm text-slate-900">{primaryCol.render(row)}</div>
                    {restCols[0] && <div className="text-xs shrink-0">{restCols[0].render(row)}</div>}
                  </div>
                )
              )}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {(hasCustomHeader ? dataColumns : restCols.slice(1)).map((col) => (
                  <div key={col.key}>
                    <dt className="text-[11px] text-slate-500">{col.mobileLabel ?? col.header}</dt>
                    <dd className="text-slate-800 mt-0.5">{col.render(row)}</dd>
                  </div>
                ))}
              </dl>
              {cardActions ? (
                <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-1.5">{cardActions(row)}</div>
              ) : (
                actionColumn && (
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap gap-1.5">
                    {actionColumn.render(row)}
                  </div>
                )
              )}
            </div>
          );
        })}
      </div>

      {/* Desktop / Print Table View */}
      <div className={`${showTableClass} overflow-x-auto print:block`}>
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((col) => {
                const sortable = Boolean(col.sortValue);
                const isSorted = sortKey === col.key;
                const ariaSort = isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`th ${col.isActions || col.hideInCard ? 'no-print' : ''} ${col.className ?? ''}`.trim()}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 font-semibold hover:text-slate-900 cursor-pointer"
                      >
                        <span>{col.header}</span>
                        <span aria-hidden="true" className="text-[10px] text-slate-400">
                          {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const extraCls = rowClassName ? rowClassName(row) : '';
              return (
                <tr
                  key={rowKey(row)}
                  className={`hover:bg-slate-50/70 transition-colors ${extraCls}`.trim()}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`td ${col.isActions || col.hideInCard ? 'no-print' : ''} ${col.className ?? ''}`.trim()}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
