/**
 * SSE domain → paged-register refresh mapping + the SSE handler's
 * burst → refresh-plan decision.
 *
 * The paged registers (Serial Log, Purchase Orders, Purchase Invoices and
 * the consumable register inside StockOperations) fetch their own
 * server-paged data, so the bootstrap slices the SSE handler re-fetches
 * don't cover them. App.tsx's SSE handler bumps the matching counter in
 * its `registerRefresh` state for every domain in this map, which re-runs
 * the register's current paged fetch.
 *
 * Standalone (no imports) so the unit tests can pin the wiring without
 * pulling in the App component.
 */

/** The paged-register refresh counters App.tsx keeps in `registerRefresh`. */
export type RegisterRefreshKey =
  | 'serialLog'
  | 'purchaseOrders'
  | 'purchaseInvoices'
  | 'consumableRegister';

/**
 * Domain → registers to re-fetch. Deliberately a superset: an extra
 * paged GET is harmless, a missed event leaves a register stale.
 *
 * - serialLog: stock mutations (STOCK), stock operations incl. damage
 *   quarantine and reversals (STOCK_OPERATIONS), serial edits (SERIALS),
 *   CPE flows (CUSTOMER_DEVICES), asset deploy/restock (ASSETS),
 *   purchase-return serial flips (PROCUREMENT) and sales-return serial
 *   flips (SALES) all write serial_log rows.
 * - purchaseOrders: procurement document events (PROCUREMENT) and goods
 *   receipts (SHIPMENTS).
 * - purchaseInvoices: procurement invoice/payment events (PROCUREMENT).
 * - consumableRegister: the CONSUMABLE_ISSUE-filtered stock-operations
 *   register; only stock-operation events create or reverse those rows
 *   (STOCK_OPERATIONS).
 */
export const DOMAIN_REGISTER_KEYS: Record<string, RegisterRefreshKey[]> = {
  STOCK: ['serialLog'],
  STOCK_OPERATIONS: ['serialLog', 'consumableRegister'],
  SERIALS: ['serialLog'],
  PROCUREMENT: ['serialLog', 'purchaseOrders', 'purchaseInvoices'],
  SALES: ['serialLog'],
  SHIPMENTS: ['purchaseOrders'],
  CUSTOMER_DEVICES: ['serialLog'],
  ASSETS: ['serialLog'],
};

/**
 * Advance every paged-register counter by one. App.tsx's full
 * bootstrap refresh (the header's manual "Refresh realtime stock
 * and logs" button, and every action handler that calls it) uses
 * this so the self-fetching registers re-run their current paged
 * fetch alongside the bootstrap slices — those slices alone don't
 * cover the registers' server-paged data.
 *
 * Pure: returns a new record and never mutates its input.
 */
export function bumpAllRegisterRefresh(
  prev: Record<RegisterRefreshKey, number>
): Record<RegisterRefreshKey, number> {
  return {
    serialLog: prev.serialLog + 1,
    purchaseOrders: prev.purchaseOrders + 1,
    purchaseInvoices: prev.purchaseInvoices + 1,
    consumableRegister: prev.consumableRegister + 1,
  };
}

/**
 * Result of flushing one debounced SSE burst, exactly as App.tsx's
 * debounced handler resolves it: a single recognized domain refreshes
 * just that domain's slices (targeted); anything else re-bootstraps
 * the whole app (full).
 */
export type SseFlushPlan =
  | { mode: 'targeted'; domains: string[] }
  | { mode: 'full' };

/**
 * Accumulates SSE event domains across a debounce window the way
 * App.tsx's debounced SSE handler does, then resolves the window to
 * its refresh plan when the debounce fires.
 *
 * - Events that all carry the same domain keep that domain; two
 *   different domains — or any event without one — collapse the
 *   window into a mixed burst.
 * - flush() resolves a single recognized domain to a targeted plan
 *   and everything else (mixed burst, unrecognized domain, empty
 *   window) to the full-bootstrap plan, so an unknown server event
 *   can never leave the UI stale. The full-bootstrap path runs
 *   refreshAllData, which bumps every paged-register counter via
 *   bumpAllRegisterRefresh above.
 * - flush() resets the accumulator, so the next debounce window
 *   starts clean.
 *
 * Extracted from App.tsx's SSE effect so the burst → plan decision
 * (including the full-bootstrap fallback) is testable without
 * mounting the App component. App.tsx passes its own
 * DOMAIN_STATE_KEYS predicate, so that map stays the single source
 * of truth for which domains are recognized.
 */
export class SseDomainBurst {
  private lastDomain: string | null = null;

  observe(domain: string | undefined): void {
    if (domain) {
      this.lastDomain =
        this.lastDomain === null || this.lastDomain === domain
          ? domain
          : 'MULTI';
    } else {
      this.lastDomain = 'MULTI';
    }
  }

  flush(isKnownDomain: (domain: string) => boolean): SseFlushPlan {
    const domain =
      this.lastDomain === 'MULTI' || !this.lastDomain ? null : this.lastDomain;
    this.lastDomain = null;
    return domain && isKnownDomain(domain)
      ? { mode: 'targeted', domains: [domain] }
      : { mode: 'full' };
  }
}
