import { useState } from 'react';

/**
 * Keeps a SERVER-paged register on page 1 when its filters change (DF-12).
 *
 * The old shape was two effects: the page fetch ran for whatever page was in
 * state, then a second effect set the page back to 1 — so one filter change
 * issued two requests (the stale page, then page 1), and every mount paid for
 * a reset effect that could not change anything.
 *
 * This snaps the page DURING RENDER (React's "adjusting state when a prop
 * changes" pattern, the same one `useClientPagination` uses), so the reset
 * lands in the same commit as the new filter values and the fetch effect —
 * whose loader is rebuilt with page 1 — runs exactly once. Nothing is
 * dispatched on mount or on a re-render that leaves the filters alone.
 *
 * The previous key is STATE, not a ref: React discards these updates with the
 * aborted render pass, so an interrupted render retries the comparison instead
 * of recording a key whose page reset never happened.
 *
 * `filterKey` must encode only the filters: putting the page in it would make
 * paging reset itself.
 */
export function useFilterPageReset(
  filterKey: string,
  page: number,
  setPage: (page: number) => void
): void {
  const [previousKey, setPreviousKey] = useState(filterKey);
  if (previousKey === filterKey) return;
  setPreviousKey(filterKey);
  if (page !== 1) setPage(1);
}
