/**
 * AUD-1 merge for the Physical Stock Audit grid.
 *
 * The grid is seeded from live data (`products` + the `stock` bootstrap slice),
 * and that seed is recomputed on every background stock movement. Before this
 * helper the screen replaced the whole grid whenever the seed changed, which
 * silently discarded counts the operator had typed and re-marked every row as
 * counted at book value.
 *
 * `mergeCountRows` keeps the operator's own fields (`countedQty`, `isCounted`,
 * `varianceReason`, `customReason`) for rows the caller reports as touched,
 * while adopting the fresh seed for everything else — new book quantities,
 * product metadata, and added or removed products. Untouched rows deliberately
 * follow the seed: an uncounted row must keep showing "matches the book", not
 * a variance against a book quantity the operator never saw.
 *
 * The returned array is the SAME reference as `previous` when nothing moved,
 * so a seed change that alters nothing cannot churn the grid.
 */

/** The fields this merge treats as operator-owned, plus the seed's own key. */
export interface MergeableCountRow {
  productId: string;
  bookQty: number;
  countedQty: number | '';
  isCounted: boolean;
  varianceReason: string;
  customReason?: string;
}

/** Shallow, order-sensitive equality for two row lists. */
export function sameCountRows<T extends MergeableCountRow>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as unknown as Record<string, unknown>;
    const right = b[i] as unknown as Record<string, unknown>;
    if (left === right) continue;
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    for (const key of leftKeys) {
      if (!Object.is(left[key], right[key])) return false;
    }
  }
  return true;
}

/**
 * Merge a freshly computed seed into the grid as it stands.
 *
 * @param previous the grid as it stands (may hold operator edits)
 * @param seed the fresh rows (new book quantities / pending-request prefill)
 * @param isTouched which product ids the operator has edited this session
 */
export function mergeCountRows<T extends MergeableCountRow>(
  previous: T[],
  seed: T[],
  isTouched: (productId: string) => boolean
): T[] {
  const previousById = new Map(previous.map((row) => [row.productId, row]));
  const next = seed.map((seedRow) => {
    const old = previousById.get(seedRow.productId);
    if (!old || !isTouched(seedRow.productId)) return seedRow;
    return {
      ...seedRow,
      countedQty: old.countedQty,
      isCounted: old.isCounted,
      varianceReason: old.varianceReason,
      customReason: old.customReason,
    } as T;
  });
  return sameCountRows(previous, next) ? previous : next;
}
