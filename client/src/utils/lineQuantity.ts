/**
 * Line-quantity ceiling + clamp — AUD-3.
 *
 * Every serial-tracked line keeps one slot per unit, and those slot arrays are
 * produced either by a `while (slots.length < qty) push(...)` pad or by
 * `Array.from({ length: qty })` at render. Nothing capped `qty`: a nine-digit
 * quantity typed into a quantity cell built millions of slot objects on the
 * keystroke and froze the tab (a hang the operator cannot cancel), and the
 * `Array.from` render path is the same hazard one step later.
 *
 * The ceiling is applied where a quantity enters a line — the number input's
 * parse, or the update handler that writes the line — so the state, the stock
 * badge, the slot count and the submit payload all agree; the pad loops take
 * their bound from the same helper so no caller can reintroduce an unbounded
 * pad. `Math.max(1, …)` in those handlers covered the bottom of the range
 * only, and `Number('')`/`Number('abc')` still read as 1 (or 0), unchanged.
 *
 * 1000 units per line is far above any real ISP line — a shipment of a
 * thousand routers is already a container — while keeping the transient
 * allocation trivial.
 */

/** Ceiling for one line's quantity. */
export const MAX_LINE_QUANTITY = 1000;

/**
 * Integer line quantity inside [1, MAX_LINE_QUANTITY].
 *
 * Accepts anything a number input or a patch object can carry: `''`, `'abc'`,
 * `NaN` and `null` all read as 1 (never 0, never NaN — a NaN quantity would
 * poison totals downstream), fractions floor, and anything above the ceiling
 * clamps to it.
 */
export function clampLineQuantity(value: unknown, max: number = MAX_LINE_QUANTITY): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, 1), max);
}
