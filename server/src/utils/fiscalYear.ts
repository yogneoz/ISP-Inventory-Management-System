/**
 * Fiscal-year helpers extracted from app.ts (backlog item #6 — app.ts
 * extraction). Pure functions: they take their inputs as parameters and never
 * touch shared runtime state.
 *
 * toCalendarDate / pickCurrentFiscalYear were already state-free.
 * getFiscalYearCodeForDate / getFiscalYearIdForDate take the fiscal-year list
 * as a parameter; app.ts passes the shared `fiscalYears` cache through.
 */
import type { FiscalYear } from '../../../client/src/types';

// Normalizes a database date value (pg Date object, ISO datetime string, or
// 'YYYY-MM-DD' text) into a 'YYYY-MM-DD' calendar string so it can be safely
// compared against fiscal-year boundary dates. Returns '' when the value
// cannot be interpreted as a date.
export function toCalendarDate(value: any): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

// Resolves the active fiscal year for default views: prefers a year flagged
// current whose AD range contains today's date (guards against multiple rows
// being flagged is_current), falling back to the first flagged-current year.
export function pickCurrentFiscalYear(years: any[]): any | undefined {
  if (!years || years.length === 0) return undefined;
  const currentYears = years.filter((fy: any) => fy && fy.isCurrent);
  if (currentYears.length === 0) return undefined;
  const todayAD = toCalendarDate(new Date());
  const containsToday = (fy: any) => {
    const start = toCalendarDate(fy.startDateAD);
    const end = toCalendarDate(fy.endDateAD);
    return Boolean(start && end && todayAD >= start && todayAD <= end);
  };
  return currentYears.find(containsToday) || currentYears[0];
}

// Returns the fiscal-year code (e.g. '2083-84') whose AD range contains the
// given date, or '' when no fiscal year covers it. Used to stamp records with
// the correct fiscal year at write time instead of a stale hard-coded default.
export function getFiscalYearCodeForDate(dateValue: any, fiscalYears: readonly FiscalYear[]): string {
  const dateStr = toCalendarDate(dateValue);
  if (!dateStr) return '';
  for (const fiscalYear of fiscalYears) {
    const start = toCalendarDate(fiscalYear.startDateAD);
    const end = toCalendarDate(fiscalYear.endDateAD);
    if (start && end && dateStr >= start && dateStr <= end) return fiscalYear.code;
  }
  return '';
}

// Resolve the fiscal_years.id (PK) for a given AD date. Used for FK columns
// like damage_records.fiscal_year_id, which references fiscal_years(id) —
// never store the human-readable fiscal year code there.
export function getFiscalYearIdForDate(dateValue: any, fiscalYears: readonly FiscalYear[]): string | null {
  const dateStr = toCalendarDate(dateValue);
  if (!dateStr) return null;
  for (const fiscalYear of fiscalYears) {
    const start = toCalendarDate(fiscalYear.startDateAD);
    const end = toCalendarDate(fiscalYear.endDateAD);
    if (start && end && dateStr >= start && dateStr <= end) return fiscalYear.id || null;
  }
  return null;
}
