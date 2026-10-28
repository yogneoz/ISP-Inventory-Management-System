/**
 * Line-quantity rule — one ceiling for the browser and the server (AUD-3,
 * QTY-1).
 *
 * AUD-3 capped the value the operator types. Every serial-tracked line keeps
 * one slot per unit, and those slot arrays are produced either by a
 * `while (slots.length < qty) push(...)` pad or by `Array.from({ length: qty })`
 * at render, so an unclamped nine-digit quantity built millions of objects on
 * the keystroke and froze the tab. The screens clamp through
 * `clampLineQuantity` here.
 *
 * QTY-1 enforces the same rule at the API. A POST that never went through the
 * UI (a script, an older bundle, a hand-crafted request) could still carry an
 * arbitrarily large or fractional line quantity into stock and the ledger —
 * the ceiling existed only in the UI. `lineQuantityRefusal` is the refusal
 * every line-item write endpoint reads, so the API now refuses what the UI
 * would never send instead of silently rewriting it. Lines whose magnitude is
 * already bounded by real state — a return against an existing invoice, a bill
 * matched to a purchase order, a draw against a stock pool — pass
 * `max: Number.POSITIVE_INFINITY` and stay bounded by that document or pool.
 *
 * 1000 units per line is far above any real ISP line — a shipment of a
 * thousand routers is already a container — while keeping the transient
 * allocation trivial.
 */

/** Ceiling for one line's quantity. */
export const MAX_LINE_QUANTITY = 1000;

/**
 * Whole-number line quantity inside `[min, max]`. Unreadable input (`''`,
 * `'abc'`, `NaN`, `null`) reads as `min`, fractions floor, and anything
 * outside clamps to the nearer bound.
 */
export function parseLineQuantity(
  value: unknown,
  min: number,
  max: number = Number.POSITIVE_INFINITY
): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Integer line quantity inside [1, MAX_LINE_QUANTITY] (or `[1, max]`).
 *
 * Accepts anything a number input or a patch object can carry: `''`, `'abc'`,
 * `NaN` and `null` all read as 1 (never 0, never NaN — a NaN quantity would
 * poison totals downstream), fractions floor, and anything above the ceiling
 * clamps to it.
 */
export function clampLineQuantity(value: unknown, max: number = MAX_LINE_QUANTITY): number {
  return parseLineQuantity(value, 1, max);
}

export interface LineQuantityRefusalOptions {
  /** Signed range `[-max, max]` instead of `[min, max]` (manual adjustments). */
  allowSigned?: boolean;
  /** Allow 0 (`[0, max]`) — a zero-delta manual adjustment is a no-op. */
  allowZero?: boolean;
  /** Ceiling; `Infinity` for lines bounded by an existing document or pool. */
  max?: number;
  /** Name used in the refusal message (product name or id). */
  label?: string;
}

/**
 * Refusal message for a line quantity that is not a whole number inside its
 * allowed range, or `null` when it is valid. This is the API-side twin of
 * `clampLineQuantity`: the UI clamps what the operator types, the server
 * refuses anything that bypassed the UI.
 */
export function lineQuantityRefusal(
  value: unknown,
  options: LineQuantityRefusalOptions = {}
): string | null {
  const max = options.max ?? MAX_LINE_QUANTITY;
  const label = options.label ? ` for ${options.label}` : '';
  const min = options.allowSigned ? -max : options.allowZero ? 0 : 1;
  const bounds = Number.isFinite(max) ? `between ${min} and ${max}` : `of at least ${min}`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return `Line quantity${label} must be a whole number ${bounds}.`;
  }
  if (parsed < min || parsed > max) {
    return `Line quantity${label} must be ${bounds} (received ${parsed}).`;
  }
  return null;
}
