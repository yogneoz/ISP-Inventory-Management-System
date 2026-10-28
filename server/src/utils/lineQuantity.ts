/**
 * Line-quantity guard for the write endpoints (QTY-1).
 *
 * The refusal message comes from the shared rule
 * ([shared/lineQuantity.ts](../../../shared/lineQuantity.ts)), so the API and
 * the screens enforce the same ceiling and the same whole-number requirement.
 * Callers decide the shape: `quantityOf` reads the field off a line, `uncapped`
 * marks lines whose magnitude is already bounded by an existing document or
 * stock pool, and `allowSigned` / `allowZero` cover manual adjustments.
 */
import { lineQuantityRefusal, MAX_LINE_QUANTITY } from '../../../shared/lineQuantity';

export interface LineQuantityGuardOptions {
  /**
   * Reads the raw quantity off a line; defaults to `item.quantity`. Deliberately
   * not named `valueOf`: every object inherits `Object.prototype.valueOf`, so
   * an options bag would always answer that name and the default reader would
   * silently never run.
   */
  quantityOf?: (item: any) => unknown;
  /** Label for the refusal message; defaults to `productName || productId`. */
  labelOf?: (item: any) => string;
  /** Signed range `[-max, max]`, zero allowed (manual adjustments). */
  allowSigned?: boolean;
  /** Allow 0 (`[0, max]`). */
  allowZero?: boolean;
  /** Lines bounded by an existing invoice, PO line or stock pool. */
  uncapped?: boolean;
}

/**
 * First refusal among the lines, or `null` when every line quantity is valid.
 * Endpoints return it as `400 { message }` before any write.
 */
export function firstLineQuantityRefusal(
  items: any[],
  options: LineQuantityGuardOptions = {}
): string | null {
  const quantityOf = options.quantityOf || ((item: any) => item?.quantity);
  const labelOf =
    options.labelOf || ((item: any) => String(item?.productName || item?.productId || 'line item'));
  for (const item of items) {
    const refusal = lineQuantityRefusal(quantityOf(item), {
      allowSigned: options.allowSigned,
      allowZero: options.allowZero,
      max: options.uncapped ? Number.POSITIVE_INFINITY : MAX_LINE_QUANTITY,
      label: labelOf(item),
    });
    if (refusal) return refusal;
  }
  return null;
}
