/**
 * AD range span for the BS conversion tool — AUD-5.
 *
 * `handleConvertRange` in NepaliFiscalManagement walks every day between two
 * operator-supplied AD dates and converts each one. The default is a single
 * fiscal year (~365 days), which is fine, but the inputs were never capped: a
 * multi-decade range ground the screen through tens of thousands of
 * conversions — not a hang, but a frozen tool with no way out except a reload.
 *
 * The cap is deliberately far above any real conversion (the bundled BS
 * dataset spans 2000–2100 BS, so ten years is a fraction of it) while keeping
 * the loop bounded by construction instead of by trust in the dates.
 */

/** Inclusive maximum day count for one range conversion (about ten years). */
export const MAX_BS_RANGE_DAYS = 3660;

/**
 * Inclusive day count between two AD dates, or `null` when either is not a
 * parseable date.
 *
 * Both endpoints are normalised to their UTC calendar day, so a DST boundary
 * cannot add or drop a day. A range whose end precedes its start returns a
 * value below 1; callers validate order first and render their own message, so
 * this helper does not guess which endpoint was wrong.
 */
export function adRangeDayCount(startAD: string, endAD: string): number | null {
  const start = new Date(startAD);
  const end = new Date(endAD);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((endDay - startDay) / 86_400_000) + 1;
}

/**
 * The refusal sentence for a range over `max` days, or `null` when the range
 * is acceptable. Invalid or reversed dates return `null`: the caller's own
 * validation owns those messages, and the conversion loop cannot run on them.
 */
export function bsRangeSpanRefusal(
  startAD: string,
  endAD: string,
  max: number = MAX_BS_RANGE_DAYS
): string | null {
  const days = adRangeDayCount(startAD, endAD);
  if (days === null || days < 1 || days <= max) return null;
  // The parenthetical is only true for the default cap; a caller that passes
  // its own (tests) gets the plain bound.
  const hint = max === MAX_BS_RANGE_DAYS ? ' (about ten years)' : '';
  return `This range spans ${days} days; convert at most ${max} days${hint} at a time, then run the next range.`;
}
