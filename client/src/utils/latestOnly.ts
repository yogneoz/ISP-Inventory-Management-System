/**
 * Latest-only sequence guard for self-fetching screens (DF-08).
 *
 * A screen whose fetch is keyed by a selection (party, fiscal year) can have
 * two requests in flight when the user switches quickly. Responses are not
 * guaranteed to settle in request order, so the older request can land last
 * and paint the previously selected party/year, or clear the current rows with
 * its own failure.
 *
 * Each fetch takes a ticket before awaiting (`begin()`), and every state write
 * that belongs to that request is gated on `isCurrent(ticket)`. Beginning a
 * newer request invalidates every earlier ticket, so only the newest request
 * may paint data, raise an error or settle the loading flag.
 *
 * Standalone (no imports) so it can be unit-tested without a DOM and used by
 * every screen without pulling in React.
 */
export interface LatestOnly {
  /** Starts a new request: returns its ticket and invalidates older tickets. */
  begin(): number;
  /** True while `ticket` is still the newest request started. */
  isCurrent(ticket: number): boolean;
}

export function createLatestOnly(): LatestOnly {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isCurrent: (ticket: number) => ticket === latest,
  };
}
