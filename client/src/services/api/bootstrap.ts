import type { BootstrapState } from '../../types';
import { API_BASE, apiHeaders, fetchJson, getAuthToken } from './http';

/**
 * OPS-2: the last bootstrap payload and its validator, per personal scope.
 *
 * The key includes the token so switching accounts in the same tab can never
 * hand one user the previous user's cached payload. In memory only: a reload
 * starts empty and pays one full 200, which is the safe direction.
 */
type CachedBootstrap = { etag: string; payload: BootstrapState };
const bootstrapCache = new Map<string, CachedBootstrap>();

function bootstrapScopeKey(branchId?: string, fiscalYearId?: string): string {
  return `${getAuthToken() || ''}|${branchId || ''}|${fiscalYearId || ''}`;
}

// Unified Bootstrap for zero-lag instant UI loading & sync
export async function getBootstrapState(branchId?: string, fiscalYearId?: string): Promise<BootstrapState> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (fiscalYearId) params.append('fiscalYearId', fiscalYearId);
  const queryString = params.toString() ? `?${params.toString()}` : '';
  const url = `${API_BASE}/api/bootstrap${queryString}`;
  const cacheKey = bootstrapScopeKey(branchId, fiscalYearId);
  const cached = bootstrapCache.get(cacheKey);

  const headers: Record<string, string> = { ...apiHeaders() };
  if (cached) headers['If-None-Match'] = cached.etag;

  // Dedicated path rather than fetchJson: a 304 has no body, and fetchJson's
  // contract is "parse JSON or throw". Only this caller needs the sentinel.
  const res = await fetch(url, { headers });

  if (res.status === 304) {
    if (cached) return cached.payload;
    // Defensive: a 304 without a cached copy cannot be used. Ask again
    // unconditionally so the caller still gets a payload.
    bootstrapCache.delete(cacheKey);
    return getBootstrapState(branchId, fiscalYearId);
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ message: res.statusText }));
    const error = new Error(errorBody.message || `Request failed with status ${res.status}`);
    (error as any).status = res.status;
    (error as any).body = errorBody;
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('inventory_auth_expired', { detail: { message: error.message } })
      );
    }
    throw error;
  }

  const payload = (await res.json()) as BootstrapState;
  const etag = res.headers.get('etag');
  if (etag) bootstrapCache.set(cacheKey, { etag, payload });
  else bootstrapCache.delete(cacheKey);
  return payload;
}

/**
 * Fetches a single domain slice of the bootstrap state (e.g. `stock`,
 * `purchaseOrders`) for targeted real-time refreshes. Accepts the same
 * branch/fiscal-year scoping as getBootstrapState and returns `{ dataVersion,
 * slice: value }`, or `{ slice: undefined }` when the server does not expose
 * the requested key.
 */
export async function getLocalFor<T = any>(
  key: string,
  branchId?: string,
  fiscalYearId?: string
): Promise<{ dataVersion?: number; slice?: T }> {
  const params = new URLSearchParams({ key });
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (fiscalYearId) params.append('fiscalYearId', fiscalYearId);
  const data = await fetchJson<{ dataVersion?: number; [k: string]: any }>(`/api/bootstrap/local?${params.toString()}`);
  return { dataVersion: data.dataVersion, slice: data[key] };
}
