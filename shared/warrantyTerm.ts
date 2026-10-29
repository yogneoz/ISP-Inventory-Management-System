/**
 * Warranty term arithmetic — the one rule the capture screens, the API and the
 * two registers share.
 *
 * WTY-1: a coverage stores the exact expiry date (authoritative) plus the term
 * that produced it. "N months" is calendar-month arithmetic, not N×30 days, and
 * a month-end start clamps to the target month's last day (31 Jan + 1 month =
 * 28/29 Feb). The server prefill and the browser prefill must agree, so the
 * helper lives in shared/ and both import it.
 */

export const DEFAULT_WARRANTY_MONTHS = 12;
export const MAX_WARRANTY_MONTHS = 120;
export const EXPIRING_SOON_DAYS = 30;

export type WarrantyState = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';

const AD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in the app's canonical `YYYY-MM-DD` AD form. */
export function isAdDate(value: unknown): value is string {
  if (typeof value !== 'string' || !AD_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** `YYYY-MM-DD` for a UTC timestamp's calendar day. */
export function todayAd(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Adds calendar months to an AD date, clamping to the target month's last day.
 * Returns `null` for an invalid date or an out-of-range term, so callers can
 * turn a bad term into a field error instead of an Invalid Date.
 */
export function addCalendarMonths(dateAD: string, months: number): string | null {
  if (!isAdDate(dateAD) || !Number.isInteger(months) || months < 0 || months > MAX_WARRANTY_MONTHS) {
    return null;
  }
  const [year, month, day] = dateAD.split('-').map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

/** The expiry a product default suggests for a coverage starting on `startAD`. */
export function defaultWarrantyEnd(startAD: string, months: number = DEFAULT_WARRANTY_MONTHS): string | null {
  return addCalendarMonths(startAD, months);
}

/**
 * The one validation rule for a product's warranty term. The product form and
 * the API both call this, so a term the browser accepts can never be a term the
 * server silently clamps to 12.
 */
export function warrantyTermError(value: unknown): string | null {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_WARRANTY_MONTHS) {
    return `Warranty term must be a whole number of months between 0 and ${MAX_WARRANTY_MONTHS}.`;
  }
  return null;
}

/** A coverage needs both dates, in order, on real calendar days. */
export function isValidWarrantyRange(startAD: unknown, endAD: unknown): boolean {
  return isAdDate(startAD) && isAdDate(endAD) && endAD >= startAD;
}

/**
 * What a capture surface decided for one unit (WTY-5).
 *
 * `covered: false` is a real answer — the operator turned the warranty off —
 * and must write no row. It is deliberately distinct from a blank date on a
 * covered unit, which is an unfinished form, not "none". Without that split a
 * cleared field silently resurrects the product default.
 */
export interface CoverageResolution {
  covered: boolean;
  endDateAD: string | null;
  /** The product term that produced the expiry; null once a typed date exists. */
  termMonths: number | null;
  error: string | null;
}

/**
 * The one rule every capture path shares. `covered` is a tri-state input: an
 * explicit boolean is honoured, `undefined` keeps the pre-WTY-5 behaviour
 * (blank = derive from the product term) so an older API caller is not broken.
 */
export function resolveWarrantyCoverage(args: {
  covered?: unknown;
  endDateAD?: unknown;
  startDateAD: string;
  termMonths: number;
  label?: string;
}): CoverageResolution {
  const label = args.label || 'Warranty expiry';
  const term = Number.isFinite(args.termMonths) ? Math.trunc(args.termMonths) : 0;
  const explicit = typeof args.covered === 'boolean' ? args.covered : undefined;
  const typed = typeof args.endDateAD === 'string' ? args.endDateAD.trim() : '';

  if (explicit === false) {
    return { covered: false, endDateAD: null, termMonths: term > 0 ? term : null, error: null };
  }
  if (typed) {
    if (!isValidWarrantyRange(args.startDateAD, typed)) {
      return {
        covered: true,
        endDateAD: null,
        termMonths: null,
        error: `${label} must be a real date on or after the warranty start date.`,
      };
    }
    // A typed date is the contract, not the catalog default; a 0-month product
    // with a negotiated date must not store "0 months" beside a real expiry.
    return { covered: true, endDateAD: typed, termMonths: term > 0 ? term : null, error: null };
  }
  if (explicit === true) {
    return {
      covered: true,
      endDateAD: null,
      termMonths: null,
      error: `${label} is required, or turn the warranty off for this unit.`,
    };
  }
  if (term <= 0) return { covered: false, endDateAD: null, termMonths: null, error: null };
  const derived = addCalendarMonths(args.startDateAD, term);
  if (!derived) {
    return { covered: true, endDateAD: null, termMonths: null, error: `${label} needs a valid start date.` };
  }
  return { covered: true, endDateAD: derived, termMonths: term, error: null };
}

/** Whole days from today to the expiry; negative once expired. */
export function warrantyDaysRemaining(endAD: string, today: string = todayAd()): number | null {
  if (!isAdDate(endAD) || !isAdDate(today)) return null;
  const end = Date.parse(`${endAD}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - now) / 86_400_000);
}

/** The one status rule: > 30 days valid, 0–30 expiring, < 0 expired. */
export function warrantyStateFor(endAD: string, today: string = todayAd()): WarrantyState {
  const days = warrantyDaysRemaining(endAD, today);
  if (days === null || days < 0) return 'EXPIRED';
  return days <= EXPIRING_SOON_DAYS ? 'EXPIRING_SOON' : 'VALID';
}

/** Human label used by both registers; the state itself still comes from the server. */
export function warrantyStatusLabel(endAD: string, today: string = todayAd()): string {
  const days = warrantyDaysRemaining(endAD, today);
  if (days === null) return 'No expiry recorded';
  if (days < 0) {
    const late = Math.abs(days);
    return `Expired (${late} ${late === 1 ? 'day' : 'days'} ago)`;
  }
  if (days <= EXPIRING_SOON_DAYS) {
    return `Expiring (${days} ${days === 1 ? 'day' : 'days'} left)`;
  }
  return `Valid (${days} ${days === 1 ? 'day' : 'days'} left)`;
}
