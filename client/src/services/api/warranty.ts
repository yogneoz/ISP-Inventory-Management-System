/**
 * WTY-6: the two warranty registers and their audited correction.
 *
 * Both reads hit the WTY-1 coverage API, which owns branch scoping, the
 * server-computed state and the exact stored expiry. The browser never
 * reconstructs a warranty end date from a term, and the correction PATCH is
 * the only write: a supersede + audit, not an in-place overwrite.
 */
import type { WarrantyCoveragePage, WarrantyCoverageRow } from '../../types';
import { fetchJson, getActiveBranchId } from './http';

export interface WarrantyRegisterQuery {
  /** 'ALL' / empty means the account's whole scope, resolved server-side. */
  branchId?: string;
  query?: string;
  /** VALID | EXPIRING_SOON | EXPIRED | RETURNED; omit or ALL for every current state. */
  status?: string;
  /** VENDOR: CPE | FIXED_ASSET. SELLER: CPE | SOLD_PRODUCT. */
  category?: string;
  startFrom?: string;
  startTo?: string;
  /** `true` reads every filtered row (CSV export), ignoring page/pageSize. */
  all?: boolean;
}

export interface WarrantyCorrectionInput {
  startDateAD: string;
  endDateAD: string;
  /** The catalogue term snapshot; the exact dates above are authoritative. */
  termMonths?: number | null;
  notes?: string | null;
}

function warrantyQueryString(
  params: WarrantyRegisterQuery,
  page: number,
  pageSize: number
): string {
  const search = new URLSearchParams();
  const branchId =
    params.branchId && params.branchId !== 'ALL' ? params.branchId : getActiveBranchId();
  if (branchId && branchId !== 'ALL') search.append('branchId', branchId);
  if (params.query) search.append('query', params.query);
  if (params.status && params.status !== 'ALL') search.append('status', params.status);
  if (params.category && params.category !== 'ALL') search.append('category', params.category);
  if (params.startFrom) search.append('startFrom', params.startFrom);
  if (params.startTo) search.append('startTo', params.startTo);
  if (params.all) search.append('all', '1');
  search.append('page', String(page));
  search.append('pageSize', String(pageSize));
  const queryString = search.toString();
  return queryString ? `?${queryString}` : '';
}

/** The inbound side: what our suppliers owe us on each purchased unit. */
export async function fetchVendorWarranties(
  params: WarrantyRegisterQuery = {},
  page = 1,
  pageSize = 15
): Promise<WarrantyCoveragePage> {
  return fetchJson(`/api/warranties/vendor${warrantyQueryString(params, page, pageSize)}`);
}

/** The outbound side: the promise we made to each customer or assignee. */
export async function fetchSellerWarranties(
  params: WarrantyRegisterQuery = {},
  page = 1,
  pageSize = 15
): Promise<WarrantyCoveragePage> {
  return fetchJson(`/api/warranties/seller${warrantyQueryString(params, page, pageSize)}`);
}

/**
 * Corrects the stored period. The server supersedes the current row, audits
 * the change and returns the replacement — so callers must refetch, never
 * assume the returned row keeps the old id.
 */
export async function updateWarrantyCoverage(
  id: string,
  input: WarrantyCorrectionInput
): Promise<WarrantyCoverageRow> {
  return fetchJson(`/api/warranties/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
