/**
 * Deterministic periods for comparative statements.
 *
 * A flow statement compares equal-length windows: the prior window ends the
 * day before the current `from`, and contains exactly the same number of
 * calendar days as the current `from`..`to` window. It can never overlap the
 * current period. A balance sheet is point-in-time, so its prior column is the
 * end of the immediately preceding fiscal year (the day before the current
 * fiscal-year start).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ComparativeWindow {
  from: string;
  to: string;
  /** Inclusive calendar-day count in each window. */
  days: number;
}

function parseAD(value: string | null | undefined): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utc;
}

function formatAD(utc: number): string {
  return new Date(utc).toISOString().slice(0, 10);
}

export function addDaysAD(date: string, days: number): string | null {
  const parsed = parseAD(date);
  if (parsed === null) return null;
  return formatAD(parsed + days * DAY_MS);
}

/** Number of calendar days in the inclusive window, or null for bad input. */
export function inclusiveDays(from: string, to: string): number | null {
  const start = parseAD(from);
  const end = parseAD(to);
  if (start === null || end === null || end < start) return null;
  return Math.round((end - start) / DAY_MS) + 1;
}

/**
 * Equal-length immediately preceding window. `null` means the current report
 * has no usable start date (for example a from-inception statement), so no
 * prior period can be asserted.
 */
export function precedingEqualWindow(
  from: string | null | undefined,
  to: string | null | undefined
): ComparativeWindow | null {
  if (!from || !to) return null;
  const days = inclusiveDays(from, to);
  if (days === null) return null;
  const priorTo = addDaysAD(from, -1);
  const priorFrom = priorTo ? addDaysAD(priorTo, -(days - 1)) : null;
  if (!priorTo || !priorFrom) return null;
  return { from: priorFrom, to: priorTo, days };
}

/**
 * Balance-sheet prior date: fiscal-year start minus one day. If the caller has
 * no fiscal-year start, fall back to the same calendar date one year earlier;
 * a leap day becomes 28 February, deterministically.
 */
export function priorBalanceSheetDate(
  fiscalYearStartAD: string | null | undefined,
  asOf: string | null | undefined
): string | null {
  const start = parseAD(fiscalYearStartAD);
  const current = parseAD(asOf);
  if (start !== null && current !== null && start <= current) {
    return formatAD(start - DAY_MS);
  }
  if (current === null) return null;
  const date = new Date(current);
  const year = date.getUTCFullYear() - 1;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return formatAD(Date.UTC(year, month, day));
}
