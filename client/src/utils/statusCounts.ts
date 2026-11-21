/**
 * The filtered total a keyset page reported, derived from its per-status counts.
 *
 * The server computes those counts with the SAME filter fragment as the page it
 * returned (branch + status + search + dates), so their sum is the size of the
 * population the cursor walk is paging. The counts ride on the pager's `meta`,
 * which is cleared when the query changes — so the total can never outlive the
 * filter that produced it.
 */
export function sumStatusCounts(counts: Record<string, number> | null | undefined): number {
  let total = 0;
  for (const value of Object.values(counts || {})) total += Number(value) || 0;
  return total;
}
