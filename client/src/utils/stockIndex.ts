/**
 * Stock lookup indexes (STOCK-1).
 *
 * The bootstrap stock array is read once per (product, branch) pair. Doing that
 * with `stock.find(...)` inside a products × branches loop is quadratic in the
 * array length: at the measured model of 2,000 products × 20 branches (40,000
 * rows) the Branch Stock screen spent ~38 s per pass in its render body and the
 * Physical Stock Audit matrix recomputed the same scan on every count edit.
 *
 * These helpers build the index once — O(rows) — and answer each pair in O(1).
 * They are pure, so a screen just memoises the index on `stock`.
 *
 * Duplicate rows: `Array.prototype.find` returns the FIRST match, so the index
 * keeps the first row per pair as well. A screen must keep reading the same row
 * it read before the index existed; silently switching to a later duplicate
 * would change quantities, not just speed.
 */

/** The only fields the key needs; both are required on every stock row. */
export interface StockRowLike {
  productId: string;
  branchId: string;
}

/** A stock row as the screens read it (numbers may arrive as strings from SQL). */
export interface StockRow extends StockRowLike {
  quantityOnHand?: number | string | null;
  damagedQty?: number | string | null;
}

/**
 * Key for a (product, branch) pair. The NUL separator cannot occur in an id, so
 * `p1|b2` and `p1|b2` can never collide with a different split of the same text.
 */
export function stockPairKey(productId: string, branchId: string): string {
  return `${productId}\u0000${branchId}`;
}

/**
 * Indexes rows by a string key, keeping the FIRST row per key (find semantics).
 * Generic so a screen can index its audit rows the same way.
 */
export function indexFirstBy<T>(rows: readonly T[], keyOf: (row: T) => string): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}

/**
 * Groups rows by a string key. Used where a screen needs the rows themselves
 * (a product's per-branch stock list), not just one quantity.
 */
export function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Groups stock rows by product id (the per-product branch list). */
export function groupStockByProduct<T extends StockRowLike>(rows: readonly T[]): ReadonlyMap<string, T[]> {
  return groupBy(rows, (row) => row.productId);
}

/** Indexes stock rows by (product, branch) for O(1) quantity lookups. */
export function indexStockByProductBranch<T extends StockRowLike>(rows: readonly T[]): ReadonlyMap<string, T> {
  return indexFirstBy(rows, (row) => stockPairKey(row.productId, row.branchId));
}

/** The row for a (product, branch) pair, or undefined when the pair has none. */
export function stockRowAt<T>(
  index: ReadonlyMap<string, T>,
  productId: string,
  branchId: string
): T | undefined {
  return index.get(stockPairKey(productId, branchId));
}

/**
 * On-hand quantity for a pair, 0 when the pair has no row — the same value the
 * screens computed as `item ? Number(item.quantityOnHand) : 0`.
 */
export function stockOnHandAt<T extends StockRow>(
  index: ReadonlyMap<string, T>,
  productId: string,
  branchId: string
): number {
  const row = stockRowAt(index, productId, branchId);
  return row ? Number(row.quantityOnHand) : 0;
}

/**
 * Damaged quantity for a pair, 0 when absent — the same value the screens
 * computed as `st ? Number(st.damagedQty) || 0 : 0` (so a missing or
 * non-numeric field is 0, not NaN).
 */
export function stockDamagedAt<T extends StockRow>(
  index: ReadonlyMap<string, T>,
  productId: string,
  branchId: string
): number {
  const row = stockRowAt(index, productId, branchId);
  return row ? Number(row.damagedQty) || 0 : 0;
}
