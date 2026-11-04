/**
 * Bill-term arithmetic shared by the API and the invoice forms.
 *
 * A term's `dueDays` is counted from the invoice date: 0 means due on the
 * invoice date, 30 means 30 days later. Dates are handled as UTC calendar
 * dates so a timezone offset can never move a due date by a day.
 */

/** Upper bound for a typed term; ten years is already an extreme credit line. */
export const MAX_BILL_TERM_DAYS = 3650;

/** True when `value` is a real calendar date in YYYY-MM-DD form. */
export function isValidADDate(value: unknown): value is string {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Add whole days to an AD calendar date. Returns null when the source date or
 * the day count is invalid, so callers never persist a fabricated due date.
 */
export function addDaysAD(dateAD: string, days: number): string | null {
  if (!isValidADDate(dateAD)) return null;
  const count = Math.trunc(Number(days));
  if (!Number.isFinite(count) || count < 0 || count > MAX_BILL_TERM_DAYS) return null;
  const [year, month, day] = dateAD.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Due date for a term's day count, or null when the inputs are invalid. */
export function computeDueDateAD(invoiceDateAD: string, dueDays: number): string | null {
  return addDaysAD(invoiceDateAD, dueDays);
}
