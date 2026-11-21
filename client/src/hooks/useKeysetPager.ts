import { useCallback, useEffect, useRef, useState } from 'react';

/** One keyset page as the register APIs return it (items or legacy data). */
export interface KeysetPage<T, M = unknown> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  meta?: M;
}

export interface KeysetPager<T, M = unknown> {
  rows: T[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
  scopeError: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  reload: () => void;
  /**
   * Re-read the CURRENT query and keep the reader where they are: the pages
   * already fetched are re-walked from their cursor chain and swapped in one
   * commit. `reload` starts over at page 1; this does not.
   */
  refresh: () => void;
  loadMore: () => void;
  /** Rows per cursor page, fixed by the first page (0 before it lands). */
  pageSize: number;
  /**
   * Metadata of the page the CURRENT query returned (e.g. per-status counts).
   * Dropped in the render that adopts a new `resetKey` and while a reload is in
   * flight, so a register can never show a previous filter's totals over this
   * filter's rows.
   */
  meta: M | null;
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
 * Append-only reader for a signed keyset endpoint.
 *
 * The first request omits the cursor and sends a bounded limit; every
 * "Load more" sends the previous page's opaque `nextCursor`. The rows already
 * loaded are never re-read, so inserts committed between requests cannot shift
 * the window and make a row appear twice or disappear.
 *
 * Numbered pages are a separate concern — see `useKeysetPageView`.
 */
export function useKeysetPager<T extends { id: string }, M = unknown>({
  fetchPage,
  resetKey,
  enabled = true,
  refreshKey = '',
  onPage,
}: UseKeysetPagerOptions<T, M>): KeysetPager<T, M> {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [scopeError, setScopeError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
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
  // Mirror of `rows` for the append path, which merges inside an async callback.
  const rowsRef = useRef<T[]>([]);
  // Mirror of `pageSize` for the refresh path, which runs outside render.
  const pageSizeRef = useRef(0);

  const seq = useRef(0);
  const fetchRef = useRef(fetchPage);
  const onPageRef = useRef(onPage);
  fetchRef.current = fetchPage;
  onPageRef.current = onPage;

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    const mine = ++seq.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setLoadingMore(false);
      rowsRef.current = [];
      setRows([]);
      setHasMore(false);
      setNextCursor(null);
      // A new query invalidates every total the previous one reported.
      setMeta(null);
    }
    setError('');
    setScopeError(false);
    try {
      const result = await fetchRef.current(cursor);
      if (mine !== seq.current) return;
      const nextRows = append ? appendKeysetRows(rowsRef.current, result.items) : result.items;
      rowsRef.current = nextRows;
      setRows(nextRows);
      // The first page fixes the page size for the whole walk: every later page
      // is fetched with the same bounded limit, so page n covers a fixed slice.
      if (!append && result.items.length > 0) {
        pageSizeRef.current = result.items.length;
        setPageSize(result.items.length);
      }
      setNextCursor(result.nextCursor);
      setHasMore(Boolean(result.hasMore && result.nextCursor));
      setMeta((result.meta ?? null) as M | null);
      onPageRef.current?.(result);
    } catch (err: any) {
      if (mine !== seq.current) return;
      setError(err?.message || 'The register could not be loaded.');
      setScopeError(isScopeRequiredError(err));
      setHasMore(false);
      setNextCursor(null);
      if (!append) {
        rowsRef.current = [];
        setRows([]);
        setMeta(null);
      }
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  /**
   * Re-read the same query without losing the reader's place.
   *
   * Page N+1 needs page N's anchor, so holding page k means re-walking the
   * cursor chain from the first page up to k — the same number of requests the
   * reader made to get there, never LIMIT/OFFSET. The fresh walk replaces the
   * old one in a single commit: clearing the rows first would clamp the view to
   * page 1 for a frame, which is the jump this exists to prevent. On error the
   * rows stay, because the query did not change and the page on screen is still
   * the best answer to it.
   */
  const refresh = useCallback(() => {
    if (!enabled) return;
    void (async () => {
      const mine = ++seq.current;
      const size = pageSizeRef.current;
      const depth = size > 0 ? Math.max(1, Math.ceil(rowsRef.current.length / size)) : 1;
      setLoading(true);
      setLoadingMore(false);
      setError('');
      setScopeError(false);
      try {
        const collected: T[] = [];
        let firstSize = 0;
        let cursor: string | null = null;
        let more = false;
        let last: KeysetPage<T, M> | null = null;
        for (let page = 0; page < depth; page++) {
          const result = await fetchRef.current(cursor);
          if (mine !== seq.current) return;
          if (page === 0) firstSize = result.items.length;
          collected.push(...result.items);
          last = result;
          more = Boolean(result.hasMore && result.nextCursor);
          cursor = result.nextCursor;
          if (!more) break;
        }
        rowsRef.current = collected;
        setRows(collected);
        // The first page still fixes the page size; a short last page must not.
        if (firstSize > 0) {
          pageSizeRef.current = firstSize;
          setPageSize(firstSize);
        }
        if (last) {
          setNextCursor(last.nextCursor);
          setHasMore(more);
          setMeta((last.meta ?? null) as M | null);
          onPageRef.current?.(last);
        }
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
  }, [enabled]);

  const queryKeyRef = useRef(resetKey);
  const refreshKeyRef = useRef(refreshKey);

  useEffect(() => {
    if (!enabled) {
      seq.current++;
      rowsRef.current = [];
      setRows([]);
      setHasMore(false);
      setNextCursor(null);
      setError('');
      setScopeError(false);
      setMeta(null);
      setLoading(false);
      setLoadingMore(false);
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
  }, [enabled, load, refresh, refreshKey, resetKey]);

  const reload = useCallback(() => {
    if (enabled) void load(null, false);
  }, [enabled, load]);

  const loadMore = useCallback(() => {
    if (!enabled || loading || loadingMore || !hasMore || !nextCursor) return;
    void load(nextCursor, true);
  }, [enabled, hasMore, load, loading, loadingMore, nextCursor]);

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
  };
}
