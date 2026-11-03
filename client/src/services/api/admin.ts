import type {
  CompanyProfile,
  Category,
  ProductGroup,
  UnitOfMeasure,
  LocationRecord,
} from '../../types';
import { fetchJson } from './http';

// Admin recalculation / repair utilities
export async function recalculateFixedAssets(): Promise<{ message: string; updated: number }> {
  return fetchJson('/api/admin/recalculate/fixed-assets', { method: 'POST' });
}

export async function recalculateLiveStock(): Promise<{ message: string; updated: number }> {
  return fetchJson('/api/admin/recalculate/live-stock', { method: 'POST' });
}

export async function recalculateLedgerBalances(): Promise<{ message: string; updated: number; skipped: number }> {
  return fetchJson('/api/admin/recalculate/ledger-balances', { method: 'POST' });
}

/**
 * SER-2: the serial register converges only on demand now (boot no longer
 * inserts rows). Idempotent — a converged register answers 0 / 0.
 */
export async function reconcileSerialRegister(): Promise<{ converged: number; inserted: number; upgraded: number; message: string }> {
  return fetchJson('/api/admin/recalculate/serial-register', { method: 'POST' });
}

export async function rebuildBsDayRecords(): Promise<{ success: boolean; pgSynced: boolean; years: number; regeneratedRecords: number; message: string }> {
  return fetchJson('/api/admin/recalculate/bs-day-records', { method: 'POST' });
}

export async function repairFiscalYearLinks(): Promise<{ success: boolean; totalFixed: number; perTable: Record<string, number>; message: string }> {
  return fetchJson('/api/admin/repair/fiscal-year-links', { method: 'POST' });
}

/**
 * What the demo-clear endpoint reports back. The row counts are the server's
 * own numbers, and `superAdminCount` is the one the UI must act on: when it is
 * 0, the account this session is signed in as was demo data too, so continuing
 * would mean operating as a user row that no longer exists.
 */
export interface ClearDemoDataResult {
  message: string;
  removedRows: Record<string, number>;
  totalRemoved: number;
  demoFiscalYearsDeleted: number;
  demoFiscalYearsSkipped: number;
  bsDayRecordsRelinked: number;
  userCount: number;
  superAdminCount: number;
}

export async function clearDemoData(): Promise<ClearDemoDataResult> {
  return fetchJson('/api/admin/clear-demo-data', {
    method: 'POST',
  });
}

// Company Profile API
export async function updateCompanyProfile(profile: Partial<CompanyProfile>): Promise<CompanyProfile> {
  return fetchJson('/api/company-profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
}

export type PermissionOverrideEffect = 'grant' | 'deny';

/** One per-user exception exactly as the API returns it. */
export interface UserPermissionOverrideRow {
  operationId: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
  /** True when the row is stored but no longer applies (read-only view). */
  expired: boolean;
}

/** One override as the replace endpoint accepts it. */
export interface UserPermissionOverrideInput {
  operationId: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
}

export interface EffectivePermissionsResponse {
  role: string;
  operations: string[];
  version: number;
}

export interface UserPermissionOverridesResponse {
  message?: string;
  userId: string;
  role: string;
  /** The role matrix's answer for every operation, before exceptions. */
  base: Record<string, boolean>;
  overrides: UserPermissionOverrideRow[];
  /** Reusable sets assigned to this user; their grants apply unless denied. */
  setIds?: string[];
  /** Resolved operations after set grants and exceptions. */
  operations: string[];
  version: number;
}

/** One account whose personal override changes a role's answer. */
export interface OperationPermissionOverrideUser {
  userId: string;
  operationId: string;
  name: string;
  email: string;
  role: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
}

/** One Users-register card's read-only access tally. */
export interface UserAccessSummary {
  userId: string;
  role: string;
  effective: number;
  total: number;
  grants: number;
  denies: number;
  setCount: number;
  nextExpiry: string | null;
  /** Effective operation ids, used by the Users register's access filter. */
  operations: string[];
}

export interface UserAccessSummariesResponse {
  users: UserAccessSummary[];
  total: number;
  version: number;
}

/** The matrix-cell drill-down response. */
export interface OperationPermissionOverridesResponse {
  operationId: string;
  role: string;
  /** The saved role default for this operation, from the enforcement cache. */
  roleAllowed: boolean;
  /** Active direct overrides that differ from the role default. */
  users: OperationPermissionOverrideUser[];
}

/** A reusable bundle of grants several users can share. */
export interface PermissionSetSummary {
  id: string;
  name: string;
  description: string;
  /** Catalogue operation ids this set grants. */
  grants: string[];
  /** User ids assigned to this set. */
  members: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PermissionSetInput {
  name: string;
  description: string;
  grants: string[];
}

/** The response of replacing one user's set memberships. */
export interface UserPermissionSetsResponse {
  message?: string;
  userId: string;
  role: string;
  base: Record<string, boolean>;
  setIds: string[];
  operations: string[];
  version: number;
}

/** The signed-in account's effective set (role matrix + its own exceptions). */
export async function getMyPermissions(): Promise<EffectivePermissionsResponse> {
  return fetchJson('/api/permissions/me');
}

/** One bulk read for every Users card; no per-card request fan-out. */
export async function getUserAccessSummaries(): Promise<UserAccessSummariesResponse> {
  return fetchJson('/api/users/access-summary');
}

export async function getUserPermissionOverrides(userId: string): Promise<UserPermissionOverridesResponse> {
  return fetchJson(`/api/users/${encodeURIComponent(userId)}/permission-overrides`);
}

export async function getOperationPermissionOverrides(
  operationId: string,
  role: string
): Promise<OperationPermissionOverridesResponse> {
  const params = new URLSearchParams({ operationId, role });
  return fetchJson(`/api/permissions/operation-overrides?${params.toString()}`);
}

export async function saveUserPermissionOverrides(
  userId: string,
  overrides: UserPermissionOverrideInput[]
): Promise<UserPermissionOverridesResponse> {
  return fetchJson(`/api/users/${encodeURIComponent(userId)}/permission-overrides`, {
    method: 'PUT',
    body: JSON.stringify({ overrides }),
  });
}

export async function getPermissionSets(): Promise<PermissionSetSummary[]> {
  const res = await fetchJson<{ sets: PermissionSetSummary[]; version: number }>('/api/permission-sets');
  return res.sets;
}

export async function createPermissionSet(input: PermissionSetInput): Promise<PermissionSetSummary> {
  const res = await fetchJson<{ set: PermissionSetSummary; version: number }>('/api/permission-sets', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return res.set;
}

export async function updatePermissionSet(
  id: string,
  input: PermissionSetInput
): Promise<PermissionSetSummary> {
  const res = await fetchJson<{ set: PermissionSetSummary; version: number }>(
    `/api/permission-sets/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify(input) }
  );
  return res.set;
}

export async function deletePermissionSet(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/permission-sets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function saveUserPermissionSets(
  userId: string,
  setIds: string[]
): Promise<UserPermissionSetsResponse> {
  return fetchJson(`/api/users/${encodeURIComponent(userId)}/permission-sets`, {
    method: 'PUT',
    body: JSON.stringify({ setIds }),
  });
}

export async function getPermissionsMatrix(): Promise<Record<string, Record<string, boolean>>> {
  // The endpoint answers { matrix }; unwrap it so callers get the matrix
  // itself and the return type matches reality.
  const res = await fetchJson<{ matrix: Record<string, Record<string, boolean>> }>('/api/permissions');
  return res.matrix;
}

export async function savePermissionsMatrix(
  matrix: Record<string, Record<string, boolean>>
): Promise<void> {
  return fetchJson('/api/permissions', {
    method: 'PUT',
    body: JSON.stringify({ matrix }),
  });
}

// Categories API
export async function getCategories(): Promise<Category[]> {
  return fetchJson('/api/categories');
}

export async function createCategory(category: Partial<Category>): Promise<Category> {
  return fetchJson('/api/categories', {
    method: 'POST',
    body: JSON.stringify(category),
  });
}

export async function updateCategory(id: string, category: Partial<Category>): Promise<Category> {
  return fetchJson(`/api/categories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(category),
  });
}

export async function deleteCategory(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/categories/${id}`, {
    method: 'DELETE',
  });
}

// Product Group API
export async function getProductGroups(): Promise<ProductGroup[]> {
  return fetchJson('/api/product-groups');
}

export async function createProductGroup(group: Partial<ProductGroup>): Promise<ProductGroup> {
  return fetchJson('/api/product-groups', {
    method: 'POST',
    body: JSON.stringify(group),
  });
}

export async function updateProductGroup(id: string, group: Partial<ProductGroup>): Promise<ProductGroup> {
  return fetchJson(`/api/product-groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(group),
  });
}

export async function deleteProductGroup(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/product-groups/${id}`, {
    method: 'DELETE',
  });
}

// UoM API
export async function getUoms(): Promise<UnitOfMeasure[]> {
  return fetchJson('/api/uom');
}

export async function createUom(uom: Partial<UnitOfMeasure>): Promise<UnitOfMeasure> {
  return fetchJson('/api/uom', {
    method: 'POST',
    body: JSON.stringify(uom),
  });
}

export async function updateUom(id: string, uom: Partial<UnitOfMeasure>): Promise<UnitOfMeasure> {
  return fetchJson(`/api/uom/${id}`, {
    method: 'PUT',
    body: JSON.stringify(uom),
  });
}

export async function deleteUom(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/uom/${id}`, {
    method: 'DELETE',
  });
}

// Locations API
export async function getLocations(branchId?: string): Promise<LocationRecord[]> {
  const query = branchId && branchId !== 'ALL' ? `?branchId=${encodeURIComponent(branchId)}` : '';
  return fetchJson(`/api/locations${query}`);
}

export async function createLocation(location: Partial<LocationRecord>): Promise<LocationRecord> {
  return fetchJson('/api/locations', {
    method: 'POST',
    body: JSON.stringify(location),
  });
}

export async function deleteLocation(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/locations/${id}`, {
    method: 'DELETE',
  });
}
