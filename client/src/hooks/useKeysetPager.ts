import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** One keyset page as the register APIs return it (items or legacy data). */
export interface KeysetPage<T, M = unknown> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  meta?: M;
}

export interface KeysetPager<T, M = unknown> {
  /** Every row of every page fetched so far, in page order. */
  rows: T[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  scopeError: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  reload: () => void;
  /**
   * Re-read the page on screen and keep the reader where they are: one request,
   * from that page's own cursor anchor. The later pages keep their numbers (and
   * the rows already read) and are re-read one at a time when they are opened.
   * `reload` starts over at page 1; this does not.
   */
  refresh: () => void;
  loadMore: () => void;
  /** Rows per cursor page, fixed by the first page (0 before it lands). */
  pageSize: number;
  /** 1-based page on screen (clamped to the pages fetched so far). */
  page: number;
  /** Pages fetched so far — the numbers a footer can offer. */
  pageCount: number;
  /** Rows of the current page only — what a register table should render. */
  pageRows: T[];
  /** 1-based index of the first row on this page (0 when empty). */
  rowStart: number;
  /** 1-based index of the last row on this page (0 when empty). */
  rowEnd: number;
  /** Show a fetched page, or fetch the next cursor page when it is pageCount+1. */
  goToPage: (page: number) => void;
  /**
   * Metadata of the page the CURRENT query returned (e.g. per-status counts).
   * Dropped in the render that adopts a new `resetKey` and while a reload is in
   * flight, so a register can never show a previous filter's totals over this
   * filter's rows.
   */
  meta: M | null;
}

/** One fetched page, with the anchor the server published for the next one. */
interface LoadedPage<T> {
  rows: T[];
  /** Cursor after this page's last row (null = the walk ends here). */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * True when a page BEFORE it was re-read after this page was fetched, so its
   * rows may no longer be the ones that follow that page. It keeps its number
   * and its rows; it is re-read when the reader opens it.
   */
  stale: boolean;
}

export function isScopeRequiredError(err: any): boolean {
  return (
    err?.body?.code === 'SCOPE_REQUIRED' ||
    err?.code === 'SCOPE_REQUIRED' ||
    err?.response?.code === 'SCOPE_REQUIRED'
  );
}

/** Append without ever rendering the same row id twice (a retry or overlap). */
export function appendKeysetRows<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((row) => row.id));
  const next = current.slice();
  for (const row of incoming) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    next.push(row);
  }
  return next;
}

interface UseKeysetPagerOptions<T, M> {
  fetchPage: (cursor: string | null) => Promise<KeysetPage<T, M>>;
  /** Any string that changes when the filters/branch/date scope change. */
  resetKey: string;
  enabled?: boolean;
  /**
   * Changes when the SAME query must be re-read (an SSE tick, a post-mutation
   * reload). Unlike `resetKey` it holds the current page, so filters, branch
   * and dates belong in `resetKey` and refresh tokens belong here.
   */
  refreshKey?: string | number;
  onPage?: (page: KeysetPage<T, M>) => void;
}

/**
 * Paged reader for a signed keyset endpoint.
 *
 * The first request omits the cursor and sends a bounded limit; every next page
 * sends the previous page's opaque `nextCursor`. Rows already loaded are never
 * re-read by an append, so inserts committed between requests cannot shift the
 * window and make a row appear twice or disappear.
 *
 * Pages are kept as separate slices, each with the anchor the server published
 * for the page after it (`nextCursor`). A page's start anchor is therefore the
 * PREVIOUS page's `nextCursor`, never a stored offset — which is what lets one
 * page be re-read on its own, with a single request and without LIMIT/OFFSET.
 *
 * Numbered pages are exposed here (and mirrored by `useKeysetPageView`).
 */
export function useKeysetPager<T extends { id: string }, M = unknown>({
  fetchPage,
  resetKey,
  enabled = true,
  refreshKey = '',
  onPage,
}: UseKeysetPagerOptions<T, M>): KeysetPager<T, M> {
  const [pages, setPages] = useState<LoadedPage<T>[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [scopeError, setScopeError] = useState(false);
  const [pageSize, setPageSize] = useState(0);
  const [meta, setMeta] = useState<M | null>(null);
  // Figures belong to the query that produced them, so they are dropped in the
  // very render that adopts a new resetKey — not one commit later in an effect,
  // which would pair the new filter with the previous filter's totals for a
  // frame. (Same render-phase reset as useClientPagination.)
  const [metaKey, setMetaKey] = useState(resetKey);
  if (metaKey !== resetKey) {
    setMetaKey(resetKey);
    setMeta(null);
  }
  // Mirror of `pages` for the async paths, which run outside render.
  const pagesRef = useRef<LoadedPage<T>[]>([]);
  // Mirror of `pageSize` for the refresh path, which runs outside render.
  const pageSizeRef = useRef(0);

  // The page is a property of the walk, so it lives here rather than in the
  // numbered view: a same-query refresh has to know which page the reader is on
  // before it can pick that page's anchor.
  const [requestedPage, setRequestedPage] = useState(1);
  const pageCount = Math.max(1, pages.length);
  // Clamped during render, so a query that shrinks the walk shows page 1 in the
  // same commit, and a page that becomes reachable again is restored.
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageRows = pages[page - 1]?.rows ?? [];
  const rowsBefore = useMemo(
    () => pages.slice(0, page - 1).reduce((total, entry) => total + entry.rows.length, 0),
    [pages, page]
  );
  const rows = useMemo(() => pages.flatMap((entry) => entry.rows), [pages]);
  const lastPage = pages[pages.length - 1];
  const nextCursor = lastPage?.nextCursor ?? null;
  const hasMore = Boolean(lastPage?.hasMore && lastPage?.nextCursor);
  // Read by `refresh`, which runs outside render.
  const pageRef = useRef(1);
  pageRef.current = page;

  const seq = useRef(0);
  const fetchRef = useRef(fetchPage);
  const onPageRef = useRef(onPage);
  fetchRef.current = fetchPage;
  onPageRef.current = onPage;

  const commit = useCallback((next: LoadedPage<T>[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  /** One fetch, packaged as a page of the walk. */
  const toPage = useCallback(
    (items: T[], result: KeysetPage<T, M>): LoadedPage<T> => ({
      rows: items,
      nextCursor: result.nextCursor ?? null,
      hasMore: Boolean(result.hasMore && result.nextCursor),
      stale: false,
    }),
    []
  );

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const mine = ++seq.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadingMore(false);
        commit([]);
        // A new query invalidates every total the previous one reported.
        setMeta(null);
      }
      setError('');
      setScopeError(false);
      try {
        const result = await fetchRef.current(cursor);
        if (mine !== seq.current) return;
        const base = append ? pagesRef.current : [];
        // A page holds ONLY its own rows, so drop anything already loaded
        // (a retry or an overlapping anchor) instead of merging it in: the
        // flat `rows` view already concatenates every page.
        const seen = new Set(base.flatMap((entry) => entry.rows.map((row) => row.id)));
        const items = append
          ? result.items.filter((row) => row?.id && !seen.has(row.id))
          : result.items;
        if (append && items.length === 0) {
          // "Nothing follows that anchor" is the end of the walk, not a page:
          // appending it would number a blank page at the end. Record the
          // server's own answer on the page before it instead, so the footer
          // stops offering a next page and the same cursor is never re-asked.
          const lastIndex = base.length - 1;
          commit(
            lastIndex >= 0
              ? [
                  ...base.slice(0, lastIndex),
                  { ...base[lastIndex], nextCursor: null, hasMore: false },
                ]
              : base
          );
        } else {
          commit([...base, toPage(items, result)]);
        }
        // The first page fixes the page size for the whole walk: every later
        // page is fetched with the same bounded limit.
        if (!append && result.items.length > 0) {
          pageSizeRef.current = result.items.length;
          setPageSize(result.items.length);
        }
        setMeta((result.meta ?? null) as M | null);
        onPageRef.current?.(result);
      } catch (err: any) {
        if (mine !== seq.current) return;
        setError(err?.message || 'The register could not be loaded.');
        setScopeError(isScopeRequiredError(err));
        if (!append) {
          commit([]);
          setMeta(null);
        }
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [commit, toPage]
  );

  /**
   * Re-read ONE page of the walk, from its own cursor anchor: the `nextCursor`
   * the page before it published.
   *
   * Page N's anchor is published by page N-1, and a signed anchor is a position
   * (not an offset), so it stays valid for a later read of the same query. That
   * is why holding page 5 costs a single request instead of the five a re-walk
   * from page 1 needs — and the keyset contract is untouched.
   *
   * Pages BEFORE the re-read one are untouched; they are the pages whose
   * `nextCursor` that anchor came from, so the chain stays consistent forwards.
   * Pages AFTER it are flagged `stale`: they may no longer hold the rows that
   * follow the page that just changed. They keep their number and their rows —
   * the walk keeps its depth — and each is re-read by the same one-request read
   * when the reader opens it.
   *
   * The page's rows are replaced in a single commit (clearing first would clamp
   * the view to page 1 for a frame), and on error the rows stay: the query did
   * not change and the page on screen is still the best answer to it.
   */
  const readPage = useCallback(
    (target: number) => {
      if (!enabled) return;
      void (async () => {
        const mine = ++seq.current;
        const current = pagesRef.current;
        const index = Math.max(1, Math.min(target, Math.max(1, current.length)));
        const cursor = index === 1 ? null : current[index - 2]?.nextCursor ?? null;
        setLoading(true);
        setLoadingMore(false);
        setError('');
        setScopeError(false);
        try {
          const result = await fetchRef.current(cursor);
          if (mine !== seq.current) return;
          if (result.items.length === 0) {
            // The page came back empty: nothing follows the anchor of the page
            // before it, so the walk ENDS there. Keeping it would leave a blank
            // page numbered in the walk (and offer an empty page at the end),
            // and the pages after it cannot be anchored consistently any more.
            // The reader is clamped to the last page that still has rows.
            const next = current.slice(0, index - 1);
            if (next.length > 0) {
              next[next.length - 1] = {
                ...next[next.length - 1],
                nextCursor: result.nextCursor ?? null,
                hasMore: Boolean(result.hasMore && result.nextCursor),
              };
            }
            commit(next);
          } else {
            const next = current.slice();
            next[index - 1] = toPage(result.items, result);
            for (let i = index; i < next.length; i++) {
              next[i] = { ...next[i], stale: true };
            }
            commit(next);
          }
          // The first page fixes the page size; a short page never re-derives it.
          if (pageSizeRef.current === 0 && result.items.length > 0) {
            pageSizeRef.current = result.items.length;
            setPageSize(result.items.length);
          }
          setMeta((result.meta ?? null) as M | null);
          onPageRef.current?.(result);
        } catch (err: any) {
          if (mine !== seq.current) return;
          setError(err?.message || 'The register could not be refreshed.');
          setScopeError(isScopeRequiredError(err));
        } finally {
          if (mine === seq.current) {
            setLoading(false);
            setLoadingMore(false);
          }
        }
      })();
    },
    [commit, enabled, toPage]
  );

  const refresh = useCallback(() => {
    readPage(pageRef.current);
  }, [readPage]);

  const queryKeyRef = useRef(resetKey);
  const refreshKeyRef = useRef(refreshKey);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      commit([]);
      setError('');
      setScopeError(false);
      setMeta(null);
      setLoading(false);
      setLoadingMore(false);
      setRequestedPage(1);
      queryKeyRef.current = resetKey;
      refreshKeyRef.current = refreshKey;
      return;
    }
    if (queryKeyRef.current !== resetKey) {
      // A different query starts at page 1 and makes a pending refresh moot.
      queryKeyRef.current = resetKey;
      refreshKeyRef.current = refreshKey;
      void load(null, false);
      return;
    }
    if (refreshKeyRef.current !== refreshKey) {
      // Same query, fresh read: hold the page the reader is on.
      refreshKeyRef.current = refreshKey;
      refresh();
      return;
    }
    void load(null, false);
  }, [commit, enabled, load, refresh, refreshKey, resetKey]);

  const reload = useCallback(() => {
    if (enabled) void load(null, false);
  }, [enabled, load]);

  const loadMore = useCallback(() => {
    if (!enabled || loading || loadingMore || !hasMore || !nextCursor) return;
    void load(nextCursor, true);
  }, [enabled, hasMore, load, loading, loadingMore, nextCursor]);

  const goToPage = useCallback(
    (target: number) => {
      const wanted = Math.floor(Number(target));
      if (!Number.isFinite(wanted) || wanted < 1) return;
      if (wanted <= pageCount) {
        setRequestedPage(wanted);
        // A page whose predecessor changed is re-read when it is opened, not
        // before: one request, only for the page the reader actually asks for.
        const entry = pagesRef.current[wanted - 1];
        if (entry?.stale && !loading && !loadingMore) readPage(wanted);
        return;
      }
      // Only one page ahead exists: page N+1's cursor is published by page N.
      if (wanted === pageCount + 1 && hasMore && !loading && !loadingMore) {
        setRequestedPage(wanted);
        loadMore();
      }
    },
    [hasMore, loadMore, loading, loadingMore, pageCount, readPage]
  );

  return {
    rows,
    loading,
    loadingMore,
    error,
    scopeError,
    hasMore,
    nextCursor,
    reload,
    refresh,
    loadMore,
    pageSize,
    meta,
    page,
    pageCount,
    pageRows,
    rowStart: pageRows.length === 0 ? 0 : rowsBefore + 1,
    rowEnd: pageRows.length === 0 ? 0 : rowsBefore + pageRows.length,
    goToPage,
  };
}
