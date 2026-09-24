/**
 * Server-side money computation (C1).
 *
 * All arithmetic here is pure JavaScript — the database only stores the
 * resulting numbers via parameterized SQL. These helpers exist so that write
 * endpoints never trust client-supplied aggregates (totalValue, grandTotal,
 * taxAmount, ...): quantities, unit prices, per-line discounts and tax rates
 * are the only legitimate business inputs; everything else is recomputed.
 *
 * Money values are rounded to 2 decimal places (paisa) at the aggregate level
 * to keep floating-point noise out of stored totals.
 */

/** Parse a value into a finite number, falling back to `fallback`. */
export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Round a money amount to 2 decimal places. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Clamp a value into [min, max] (both inclusive). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Total value of a stock operation: the sum over items of quantity × unit
 * cost, where each unit cost is resolved with the SAME chain the movement
 * ledger uses (item.unitCost → item.costPerUnit → op costPerUnit → product
 * costPrice → 0). Never trusts a client-supplied per-item totalValue.
 */
export function computeOperationTotalValue(
  items: any[],
  resolveUnitCost: (item: any) => number
): number {
  return roundMoney(
    items.reduce((sum, item) => sum + Math.abs(num(item.quantity)) * num(resolveUnitCost(item)), 0)
  );
}

/** Legacy single-line stock operation total: |quantityChanged| × costPerUnit. */
export function computeLegacyOperationTotalValue(quantityChanged: unknown, costPerUnit: unknown): number {
  return roundMoney(Math.abs(num(quantityChanged)) * num(costPerUnit));
}

/** Whether an invoice/order line is VAT-taxable. */
function isTaxableLine(item: any): boolean {
  if (item.taxRate !== undefined && item.taxRate !== null) return num(item.taxRate) > 0;
  return !item.isTaxExempt;
}

/** Effective VAT rate percent for a taxable line (defaults to 13% Nepal VAT). */
function taxRateFor(item: any): number {
  const rate = num(item.taxRate);
  return rate > 0 ? rate : 13;
}

export interface BillTotals {
  /** Σ quantity × unitPrice before any discount. */
  grossSubtotal: number;
  /** Total discount actually applied (bill-level clamped, or Σ line discounts). */
  discount: number;
  /** grossSubtotal − discount. */
  netSubtotal: number;
  /** Net portion subject to VAT. */
  taxableAmount: number;
  /** Net portion exempt from VAT. */
  nonTaxableAmount: number;
  /** VAT amount. */
  vatAmount: number;
  /** netSubtotal + vatAmount. */
  grandTotal: number;
}

/**
 * Recompute purchase-invoice / purchase-order totals from line primitives.
 *
 * Per line: gross = quantity × unitPrice; discount is either
 *   - bill-level (when `discountInput` is provided): clamped to [0, gross
 *     subtotal] and allocated across lines proportionally to each line's
 *     gross share (matching the client's allocation), or
 *   - per-line (item.discount), clamped to [0, line gross];
 * then net = gross − line discount. VAT applies only to lines with a positive
 * taxRate (non-exempt), at the line's own rate (13% fallback).
 */
export function computeBillTotals(items: any[], discountInput?: number): BillTotals {
  const lines = (items || []).map((item) => {
    const gross = num(item.quantity) * num(item.unitPrice);
    return { gross, taxable: isTaxableLine(item), rate: taxRateFor(item), discount: num(item.discount) };
  });

  const grossSubtotal = lines.reduce((s, l) => s + l.gross, 0);

  let lineDiscounts: number[];
  let discount: number;
  if (discountInput !== undefined) {
    // Bill-level discount: clamp to [0, grossSubtotal], allocate proportionally.
    const applied = clamp(num(discountInput), 0, grossSubtotal);
    lineDiscounts = lines.map((l) =>
      l.gross > 0 && grossSubtotal > 0 ? (l.gross / grossSubtotal) * applied : 0
    );
    discount = applied;
  } else {
    lineDiscounts = lines.map((l) => clamp(l.discount, 0, l.gross));
    discount = lineDiscounts.reduce((s, d) => s + d, 0);
  }

  let taxableAmount = 0;
  let nonTaxableAmount = 0;
  let vatAmount = 0;
  lines.forEach((line, i) => {
    const net = Math.max(0, line.gross - lineDiscounts[i]);
    if (line.taxable) {
      taxableAmount += net;
      vatAmount += (net * line.rate) / 100;
    } else {
      nonTaxableAmount += net;
    }
  });

  const netSubtotal = grossSubtotal - discount;
  return {
    grossSubtotal: roundMoney(grossSubtotal),
    discount: roundMoney(discount),
    netSubtotal: roundMoney(netSubtotal),
    taxableAmount: roundMoney(taxableAmount),
    nonTaxableAmount: roundMoney(nonTaxableAmount),
    vatAmount: roundMoney(vatAmount),
    grandTotal: roundMoney(netSubtotal + vatAmount),
  };
}
