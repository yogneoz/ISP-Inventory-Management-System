import type { GlobalSearchResults } from '../../types';
import { fetchJson } from './http';

/** TRIM-1: bounded, branch/FY-scoped quick search. Never sends whole slices. */
export async function searchGlobal(
  query: string,
  branchId?: string
): Promise<{ query: string; results: GlobalSearchResults; total: number; limit: number }> {
  const params = new URLSearchParams({ q: query });
  if (branchId) params.set('branchId', branchId);
  return fetchJson(`/api/global-search?${params.toString()}`);
}
