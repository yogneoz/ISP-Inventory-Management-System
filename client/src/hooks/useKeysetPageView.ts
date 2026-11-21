import { useCallback, useState } from 'react';

/** Numbered view over the pages a cursor walk has already fetched. */
export interface KeysetPageView<T> {
  /** 1-based page on screen (clamped to the pages fetched so far). */
  page: number;
  /** Pages fetched so far — the numbers the footer can offer. */
  pageCount: number;
  /** Rows of the current page only — what a register table should render. */
  pageRows: T[];
  /** 1-based index of the first row on this page (0 when empty). */
  rowStart: number;
  /** 1-based index of the last row on this page (0 when empty). */
  rowEnd: number;
  /** Show a fetched page, or fetch the next cursor page when it is pageCount+1. */
  goToPage: (page: number) => void;
}

interface CursorWalk<T> {
  rows: T[];
  /** Rows per cursor page, fixed by the first page (0 before it lands). */
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * Numbered pages for a signed-keyset register.
 *
 * A cursor is opaque: page N+1 cannot be requested until page N has returned
 * its anchor. So the numbers cover every page already fetched (sliced locally,
 * no request) plus exactly one forward step — the next cursor page. That is why
 * this is a view over `useKeysetPager` rather than a second source of rows: the
 * append-only registers that never show page numbers do not carry it.
 */
export function useKeysetPageView<T>({
  rows,
  pageSize,
  hasMore,
  loading,
  loadingMore,
  loadMore,
}: CursorWalk<T>): KeysetPageView<T> {
  const [requested, setRequested] = useState(1);
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  // Clamp during render, so a new query that shrinks the walk back to one page
  // shows page 1 in the same commit instead of a page that no longer exists.
  const page = Math.min(Math.max(1, requested), pageCount);
  const offset = (page - 1) * pageSize;
  const pageRows = pageSize > 0 ? rows.slice(offset, offset + pageSize) : rows;

  const goToPage = useCallback(
    (target: number) => {
      const wanted = Math.floor(Number(target));
      if (!Number.isFinite(wanted) || wanted < 1) return;
      if (wanted <= pageCount) {
        setRequested(wanted);
        return;
      }
      // Only one page ahead exists: page N+1's cursor is published by page N.
      if (wanted === pageCount + 1 && hasMore && !loading && !loadingMore) {
        setRequested(wanted);
        loadMore();
      }
    },
    [hasMore, loadMore, loading, loadingMore, pageCount]
  );

  return {
    page,
    pageCount,
    pageRows,
    rowStart: pageRows.length === 0 ? 0 : offset + 1,
    rowEnd: pageRows.length === 0 ? 0 : offset + pageRows.length,
    goToPage,
  };
}
