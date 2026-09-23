import type {
  FiscalYear,
  FiscalYearOpeningStockResponse,
  VendorOpeningBalanceResponse,
} from '../../types';
import { fetchJson } from './http';

// Fiscal Years
export async function getFiscalYears(): Promise<FiscalYear[]> {
  return fetchJson('/api/fiscal-years');
}

export async function setCurrentFiscalYear(id: string): Promise<FiscalYear[]> {
  return fetchJson(`/api/fiscal-years/${id}/set-current`, {
    method: 'POST',
  });
}

export async function updateFiscalYear(fiscalYear: FiscalYear): Promise<FiscalYear> {
  return fetchJson(`/api/fiscal-years/${fiscalYear.id}`, {
    method: 'PUT',
    body: JSON.stringify(fiscalYear),
  });
}

export async function createFiscalYear(input: {
  code: string;
  startDateAD: string;
  endDateAD: string;
  startDateBS: string;
  endDateBS: string;
}): Promise<FiscalYear> {
  return fetchJson('/api/fiscal-years', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function closeFiscalYear(
  id: string,
  credentials?: { adminEmail: string; adminPassword: string }
): Promise<FiscalYear> {
  return fetchJson(`/api/fiscal-years/${id}/close`, {
    method: 'POST',
    body: JSON.stringify(credentials || {}),
  });
}

export async function reopenFiscalYear(
  id: string,
  credentials?: { adminEmail: string; adminPassword: string }
): Promise<FiscalYear> {
  return fetchJson(`/api/fiscal-years/${id}/reopen`, {
    method: 'POST',
    body: JSON.stringify(credentials || {}),
  });
}

export async function initializeFiscalYearOpeningStock(
  id: string
): Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }> {
  return fetchJson(`/api/fiscal-years/${id}/initialize-opening-stock`, { method: 'POST' });
}

// Opening-Stock Register (Fiscal Year)
export async function getFiscalYearOpeningStock(id: string): Promise<FiscalYearOpeningStockResponse> {
  return fetchJson(`/api/fiscal-years/${id}/opening-stock`);
}

export async function adjustFiscalYearOpeningStock(
  id: string,
  rows: Array<{
    productId: string;
    branchId: string;
    quantityOnHand: number;
    damagedQty: number;
    unitCost: number;
  }>
): Promise<{ applied: number; created: number; message: string }> {
  return fetchJson(`/api/fiscal-years/${id}/opening-stock`, {
    method: 'PUT',
    body: JSON.stringify({ rows }),
  });
}

// Fiscal-Year Vendor Opening Balances (Vendor Ledger roll-forward)
export async function getVendorOpeningBalances(id: string): Promise<VendorOpeningBalanceResponse> {
  return fetchJson(`/api/fiscal-years/${id}/vendor-opening-balances`);
}

export async function adjustVendorOpeningBalances(
  id: string,
  rows: Array<{
    supplierId: string;
    branchId: string;
    openingBalance: number;
  }>
): Promise<{ applied: number; created: number; message: string }> {
  return fetchJson(`/api/fiscal-years/${id}/vendor-opening-balances`, {
    method: 'PUT',
    body: JSON.stringify({ rows }),
  });
}

export async function rollForwardVendorOpenings(
  id: string
): Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }> {
  return fetchJson(`/api/fiscal-years/${id}/roll-forward-vendor-openings`, { method: 'POST' });
}

export async function deleteFiscalYear(id: string): Promise<{ message: string; id: string }> {
  return fetchJson(`/api/fiscal-years/${id}`, {
    method: 'DELETE',
  });
}

// Bikram Sambat (BS) Calendar PostgreSQL API
export async function getBsCalendarYears(): Promise<{ yearBS: number; daysInMonths: number[]; startAD: string }[]> {
  return fetchJson('/api/bs-calendar/years');
}

export async function getBsDayRecords(yearBS?: number | string, monthBS?: number | string, search?: string): Promise<any[]> {
  const params = new URLSearchParams();
  if (yearBS && yearBS !== 'ALL') params.append('yearBS', String(yearBS));
  if (monthBS && monthBS !== 'ALL') params.append('monthBS', String(monthBS));
  if (search && search.trim()) params.append('search', search.trim());
  const queryString = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/bs-calendar/days${queryString}`);
}

// Single-day lookup against the bs_day_records table (PostgreSQL authoritative,
// in-memory fallback). Returns found=false when the AD date has no seeded BS record.
export async function getBsDayRecordByAdDate(adDateStr: string): Promise<{
  found: boolean;
  source?: string;
  adDate?: string | null;
  record?: any;
  message?: string;
}> {
  const params = new URLSearchParams({ adDate: adDateStr });
  return fetchJson(`/api/bs-calendar/day?${params.toString()}`);
}

export async function seedBsCalendarYear(yearBS: number, daysInMonths: number[], customStartAD?: string, onlyIfNew?: boolean): Promise<{ success: boolean; skipped?: boolean; pgSynced?: boolean; message: string }> {
  return fetchJson('/api/bs-calendar/seed', {
    method: 'POST',
    body: JSON.stringify({ yearBS, daysInMonths, customStartAD, onlyIfNew }),
  });
}

// Batch (multi-year) seed of the BS calendar month arrays. Seeds every
// provided year in one request, expanding the day-by-day bs_day_records
// lookup table for all of them. Accepts an array of { yearBS, daysInMonths,
// customStartAD? } objects.
export async function seedBsCalendarYearsBulk(years: { yearBS: number; daysInMonths: number[]; customStartAD?: string }[], onlyIfNew?: boolean): Promise<{
  success: boolean;
  pgSynced?: boolean;
  seededCount?: number;
  skippedYears?: number[];
  message: string;
}> {
  return fetchJson('/api/bs-calendar/seed-bulk', {
    method: 'POST',
    body: JSON.stringify({ years, onlyIfNew }),
  });
}

export async function syncBsDayRange(dayRecords: any[]): Promise<{ success: boolean; pgSynced?: boolean; count: number; message: string }> {
  return fetchJson('/api/bs-calendar/sync-range', {
    method: 'POST',
    body: JSON.stringify({ dayRecords }),
  });
}

// Update an existing BS year's month-length config / AD start date, then
// regenerate its day-by-day records (and those of subsequent years whose
// start date shifts) in bs_day_records.
export async function updateBsCalendarYear(
  yearBS: number,
  payload: { daysInMonths?: number[]; startAD?: string; recalculateNextStartAD?: boolean }
): Promise<{ success: boolean; pgSynced?: boolean; affectedYears?: number[]; regeneratedRecords?: number; message: string }> {
  return fetchJson(`/api/bs-calendar/years/${yearBS}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// Financial Summary
export async function getFinancialSummary(branchId?: string, fiscalYearId?: string): Promise<import('../../types').FinancialSummary> {
  const params = new URLSearchParams();
  if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
  if (fiscalYearId) params.set('fiscalYearId', fiscalYearId);
  const query = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/reports/financial-summary${query}`);
}
