/**
 * Warranty claims / RMA client API.
 *
 * The server owns the state machine, branch scope and every stock/ledger
 * consequence. The browser only sends the chosen transition and the fields
 * that transition needs.
 */
import type {
  WarrantyClaimDetail,
  WarrantyClaimPage,
  WarrantyClaimStatus,
  WarrantyRecoveryPage,
} from '../../types';
import { fetchJson, getActiveBranchId } from './http';

export interface WarrantyClaimQuery {
  branchId?: string;
  query?: string;
  status?: string;
  open?: boolean;
  coverageType?: 'VENDOR' | 'SELLER';
}

export interface WarrantyClaimCreateInput {
  coverageType: 'VENDOR' | 'SELLER';
  serialNumber: string;
  reportedDateAD: string;
  symptom: string;
  vendorName?: string;
  vendorClaimRef?: string;
  expectedCredit?: number;
  notes?: string;
}

export interface WarrantyClaimTransitionInput {
  status: WarrantyClaimStatus;
  note?: string;
  dateAD?: string;
  vendorName?: string;
  vendorClaimRef?: string;
  expectedCredit?: number;
  receivedCredit?: number;
  creditNoteNo?: string;
  postCreditJournal?: boolean;
  replacementSerial?: string;
  rmaReference?: string;
  notes?: string;
}

export interface WarrantyRecoveryQuery extends WarrantyClaimQuery {
  onlyShortfall?: boolean;
  outstandingRma?: boolean;
}

function claimQueryString(params: WarrantyClaimQuery, page: number, pageSize: number): string {
  const search = new URLSearchParams();
  const branchId =
    params.branchId && params.branchId !== 'ALL' ? params.branchId : getActiveBranchId();
  if (branchId && branchId !== 'ALL') search.append('branchId', branchId);
  if (params.query) search.append('query', params.query);
  if (params.status && params.status !== 'ALL') search.append('status', params.status);
  if (params.open) search.append('open', '1');
  if (params.coverageType) search.append('coverageType', params.coverageType);
  search.append('page', String(page));
  search.append('pageSize', String(pageSize));
  return `?${search.toString()}`;
}

export async function fetchWarrantyClaims(
  params: WarrantyClaimQuery = {},
  page = 1,
  pageSize = 15
): Promise<WarrantyClaimPage> {
  return fetchJson(`/api/warranty-claims${claimQueryString(params, page, pageSize)}`);
}

export async function fetchWarrantyClaim(id: string): Promise<WarrantyClaimDetail> {
  return fetchJson(`/api/warranty-claims/${encodeURIComponent(id)}`);
}

export async function fetchWarrantyRecovery(
  params: WarrantyRecoveryQuery = {},
  page = 1,
  pageSize = 15
): Promise<WarrantyRecoveryPage> {
  const search = new URLSearchParams();
  const branchId =
    params.branchId && params.branchId !== 'ALL' ? params.branchId : getActiveBranchId();
  if (branchId && branchId !== 'ALL') search.append('branchId', branchId);
  if (params.query) search.append('query', params.query);
  if (params.coverageType) search.append('coverageType', params.coverageType);
  if (params.onlyShortfall) search.append('onlyShortfall', '1');
  if (params.outstandingRma) search.append('outstandingRma', '1');
  search.append('page', String(page));
  search.append('pageSize', String(pageSize));
  return fetchJson(`/api/warranty-claims/recovery?${search.toString()}`);
}

export async function createWarrantyClaim(
  input: WarrantyClaimCreateInput
): Promise<WarrantyClaimDetail> {
  return fetchJson('/api/warranty-claims', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function transitionWarrantyClaim(
  id: string,
  input: WarrantyClaimTransitionInput
): Promise<WarrantyClaimDetail> {
  return fetchJson(`/api/warranty-claims/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
