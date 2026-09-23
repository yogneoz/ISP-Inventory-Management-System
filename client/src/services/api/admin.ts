import type {
  CompanyProfile,
  Category,
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

export async function rebuildBsDayRecords(): Promise<{ success: boolean; pgSynced: boolean; years: number; regeneratedRecords: number; message: string }> {
  return fetchJson('/api/admin/recalculate/bs-day-records', { method: 'POST' });
}

export async function repairFiscalYearLinks(): Promise<{ success: boolean; totalFixed: number; perTable: Record<string, number>; message: string }> {
  return fetchJson('/api/admin/repair/fiscal-year-links', { method: 'POST' });
}

export async function clearDemoData(): Promise<{ message: string }> {
  return fetchJson('/api/admin/clear-demo-data', {
    method: 'POST',
  });
}

// Company Profile API
export async function getCompanyProfile(): Promise<CompanyProfile> {
  return fetchJson('/api/company-profile');
}

export async function updateCompanyProfile(profile: Partial<CompanyProfile>): Promise<CompanyProfile> {
  return fetchJson('/api/company-profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
}

export async function getPermissionsMatrix(): Promise<Record<string, Record<string, boolean>>> {
  return fetchJson('/api/permissions');
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

export async function updateLocation(id: string, location: Partial<LocationRecord>): Promise<LocationRecord> {
  return fetchJson(`/api/locations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(location),
  });
}

export async function deleteLocation(id: string): Promise<{ success: boolean }> {
  return fetchJson(`/api/locations/${id}`, {
    method: 'DELETE',
  });
}
