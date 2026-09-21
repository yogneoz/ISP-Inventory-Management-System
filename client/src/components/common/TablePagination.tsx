import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

/**
 * Client-side pagination for data lists.
 *
 * Pair with <TablePagination /> to render a compact pager under any <table>.
 * `resetKeys` should contain the *filter* primitives (search text, status,
 * date range...) so the page snaps back to 1 whenever filters change.
 */
export interface ClientPagination<T> {
  page: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
  rangeStart: number;
  rangeEnd: number;
  pagedItems: T[];
  canPaginate: boolean;
  setPage: (p: number) => void;
  setPageSize: (s: number) => void;
}

export function useClientPagination<T>(
  items: T[],
  defaultPageSize = 15,
  resetKeys: unknown[] = []
): ClientPagination<T> {
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // Snap back to page 1 whenever the filters change.
  useEffect(() => {
    setPageState(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetKeys);

  const totalItems = items.length;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const pagedItems = items.slice(startIdx, startIdx + pageSize);

  return {
    page: safePage,
    pageCount,
    pageSize,
    totalItems,
    rangeStart: totalItems === 0 ? 0 : startIdx + 1,
    rangeEnd: Math.min(startIdx + pageSize, totalItems),
    pagedItems,
    canPaginate: totalItems > pageSize,
    setPage: (p) => setPageState(Math.min(Math.max(1, p), pageCount)),
    setPageSize: (s) => {
      setPageSize(s);
      setPageState(1);
    },
  };
}

function pageWindow(page: number, pageCount: number): (number | 'gap-l' | 'gap-r')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages: (number | 'gap-l' | 'gap-r')[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) pages.push('gap-l');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < pageCount - 1) pages.push('gap-r');
  pages.push(pageCount);
  return pages;
}

interface TablePaginationProps {
  page: number;
  pageCount: number;
  totalItems: number;
  rangeStart: number;
  rangeEnd: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange?: (s: number) => void;  className?: string;
  /** Hide the rows-per-page selector (e.g. inside small panels). */
  hidePageSize?: boolean;
}

export function TablePagination({
  page,
  pageCount,
  totalItems,
  rangeStart,
  rangeEnd,
  pageSize,
  onPageChange,
  onPageSizeChange,  className = '',
  hidePageSize = false,
}: TablePaginationProps) {
  if (totalItems === 0) return null;
  const singlePage = totalItems <= pageSize;

  const btnBase = 'border-slate-200 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700/60';
  const btnDisabled = 'border-slate-100 text-slate-300 cursor-not-allowed dark:border-slate-800 dark:text-slate-600 dark:cursor-not-allowed';
  const activeBtn = 'bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-600';

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400 ${className}`}
    >
      <span>
        Showing <strong className="text-slate-700 dark:text-slate-200">{rangeStart}</strong>–
        <strong className="text-slate-700 dark:text-slate-200">{rangeEnd}</strong> of{' '}
        <strong className="text-slate-700 dark:text-slate-200">{totalItems.toLocaleString('en-IN')}</strong>{' '}
        {totalItems === 1 ? 'record' : 'records'}
      </span>

      <div className="flex items-center gap-3">
        {!hidePageSize && onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            Rows
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className={`rounded-md border px-1.5 py-1 text-[11px] font-medium outline-none cursor-pointer bg-white border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200`}
            >
              {[10, 15, 25, 50, 100].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}

        {!singlePage && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onPageChange(1)}
              disabled={page <= 1}
              aria-label="First page"
              className={`h-6 w-6 inline-flex items-center justify-center rounded-md border transition-colors ${
                page <= 1 ? btnDisabled : btnBase
              }`}
            >
              <ChevronsLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              aria-label="Previous page"
              className={`h-6 w-6 inline-flex items-center justify-center rounded-md border transition-colors ${
                page <= 1 ? btnDisabled : btnBase
              }`}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>

            {pageWindow(page, pageCount).map((p, i) =>
              typeof p === 'number' ? (
                <button
                  key={`${p}-${i}`}
                  type="button"
                  onClick={() => onPageChange(p)}
                  className={`h-6 min-w-[1.5rem] px-1 inline-flex items-center justify-center rounded-md border text-[11px] font-semibold transition-colors ${
                    p === page ? activeBtn : btnBase
                  }`}
                >
                  {p}
                </button>
              ) : (
                <span key={`gap-${i}`} className="px-0.5 text-slate-400">
                  …
                </span>
              )
            )}

            <button
              type="button"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= pageCount}
              aria-label="Next page"
              className={`h-6 w-6 inline-flex items-center justify-center rounded-md border transition-colors ${
                page >= pageCount ? btnDisabled : btnBase
              }`}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onPageChange(pageCount)}
              disabled={page >= pageCount}
              aria-label="Last page"
              className={`h-6 w-6 inline-flex items-center justify-center rounded-md border transition-colors ${
                page >= pageCount ? btnDisabled : btnBase
              }`}
            >
              <ChevronsRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
