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
