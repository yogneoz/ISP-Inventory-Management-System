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

/**
 * Why a requested/default fiscal year could not be resolved. The two failures
 * are DIFFERENT problems with different HTTP answers (see
 * selectBootstrapFiscalYear), and neither of them is a database outage —
 * conflating them with one was what made GET /api/bootstrap report a 503
 * "PostgreSQL became unavailable" whenever the fiscal-year master was
 * unusable, pointing operators at the wrong subsystem entirely.
 */
export type FiscalYearScopeFailure =
  /** The caller named a fiscal-year id that does not exist. */
  | { ok: false; reason: 'not-found'; requestedId: string }
  /** fiscal_years is empty: nothing is configured at all. */
  | { ok: false; reason: 'none-configured' }
  /** Rows exist, but none carries is_current: there is no default view. */
  | { ok: false; reason: 'none-current' };

/** The resolved fiscal year, or the reason none could be resolved. */
export type FiscalYearScope = { ok: true; fiscalYear: any } | FiscalYearScopeFailure;

/**
 * Resolves the fiscal year the bootstrap payload is scoped to.
 *
 * An explicit request is honored only when it EXISTS: silently falling back to
 * another year would serve a view the caller did not ask for, and a crash on
 * `undefined.id` would be reported as a database failure. With no explicit
 * request the current fiscal year is the default (pickCurrentFiscalYear), and
 * when no year is flagged current the caller must be told so instead of being
 * handed an unscoped, every-year payload.
 */
export function selectBootstrapFiscalYear(years: any[], requestedId?: string): FiscalYearScope {
  if (requestedId) {
    const requested = (years || []).find((fy: any) => fy && fy.id === requestedId);
    if (!requested) return { ok: false, reason: 'not-found', requestedId };
    return { ok: true, fiscalYear: requested };
  }
  const current = pickCurrentFiscalYear(years);
  if (current) return { ok: true, fiscalYear: current };
  return { ok: false, reason: years && years.length === 0 ? 'none-configured' : 'none-current' };
}

/**
 * A BS boundary label as stored in fiscal_years.start_date_bs/end_date_bs:
 * 'YYYY-MM-DD' with an optional trailing ' BS' (the calendar-derived form).
 *
 * Parsing is deliberately shape-only (year 2000-2200, month 1-12, day 1-32):
 * whether a given day exists in that BS month is the calendar's question, and
 * the calendar is what decides the day. What this rejects is anything that
 * could never be a BS date, so a typo can no longer be stored as a boundary
 * label and later be read back as if the calendar had produced it.
 */
export interface BsBoundary {
  yearBS: number;
  monthBS: number;
  dayBS: number;
}

export function parseBsLabel(value: unknown): BsBoundary | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s*BS)?$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const boundary = { yearBS: Number(match[1]), monthBS: Number(match[2]), dayBS: Number(match[3]) };
  if (boundary.yearBS < 2000 || boundary.yearBS > 2200) return null;
  if (boundary.monthBS < 1 || boundary.monthBS > 12) return null;
  if (boundary.dayBS < 1 || boundary.dayBS > 32) return null;
  return boundary;
}

/**
 * Nepal's fiscal year runs Shrawan 1 (BS month 4, day 1) to Ashadh end
 * (BS month 3) of the following BS year. Returns null when either label cannot
 * be parsed at all — an unreadable label is a validation error, not a
 * convention violation, so the caller must not report it as one.
 *
 * Advisory only: a mid-year transition period is legitimate (a company moving
 * onto the software in Magh), so callers warn rather than refuse.
 */
export function isStandardNepaliFiscalPeriod(startLabel: unknown, endLabel: unknown): boolean | null {
  const start = parseBsLabel(startLabel);
  const end = parseBsLabel(endLabel);
  if (!start || !end) return null;
  return start.monthBS === 4 && start.dayBS === 1 && end.monthBS === 3;
}

/** Every BS year the two boundary labels touch, ascending and de-duplicated.
 *  This is the set of bs_calendar_years the period's labels depend on. */
export function bsYearsSpannedBy(startLabel: unknown, endLabel: unknown): number[] {
  const start = parseBsLabel(startLabel);
  const end = parseBsLabel(endLabel);
  if (!start || !end) return [];
  const first = Math.min(start.yearBS, end.yearBS);
  const last = Math.max(start.yearBS, end.yearBS);
  if (last - first > 10) return [];
  return Array.from({ length: last - first + 1 }, (_v, i) => first + i);
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
