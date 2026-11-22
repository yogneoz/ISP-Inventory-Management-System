import type { KeysetPager } from './useKeysetPager';

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

/**
 * Numbered pages for a signed-keyset register.
 *
 * A cursor is opaque: page N+1 cannot be requested until page N has returned its
 * anchor, so the numbers cover every page already fetched (sliced locally, no
 * request) plus exactly one forward step — the next cursor page.
 *
 * The page state itself lives in `useKeysetPager`, because the same page has to
 * be known by a same-query refresh: it re-reads the page on screen from that
 * page's cursor checkpoint, and the view alone cannot tell it which page that
 * is. This stays as the view over the walk so every numbered register and the
 * shared footer keep reading one shape.
 */
export function useKeysetPageView<T, M = unknown>(pager: KeysetPager<T, M>): KeysetPageView<T> {
  return {
    page: pager.page,
    pageCount: pager.pageCount,
    pageRows: pager.pageRows,
    rowStart: pager.rowStart,
    rowEnd: pager.rowEnd,
    goToPage: pager.goToPage,
  };
}
