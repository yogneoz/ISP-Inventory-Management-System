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
      if (!append && result.items.length > 0) setPageSize(result.items.length);
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
      return;
    }
    void load(null, false);
  }, [enabled, load, resetKey]);

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
    loadMore,
    pageSize,
    meta,
  };
}
