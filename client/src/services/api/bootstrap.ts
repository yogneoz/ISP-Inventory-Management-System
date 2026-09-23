import type { BootstrapState } from '../../types';
import { fetchJson } from './http';

// Unified Bootstrap for zero-lag instant UI loading & sync
export async function getBootstrapState(branchId?: string, fiscalYearId?: string): Promise<BootstrapState> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.append('branchId', branchId);
  if (fiscalYearId) params.append('fiscalYearId', fiscalYearId);
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetchJson<BootstrapState>(`/api/bootstrap${queryString}`);
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
