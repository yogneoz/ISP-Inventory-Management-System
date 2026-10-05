/**
 * SSE domain → paged-register refresh mapping + the SSE handler's
 * burst → refresh-plan decision.
 *
 * The paged registers (Serial Log, Purchase Orders, Purchase Invoices,
 * the consumable register inside StockOperations, the shared Returns
 * Register and Sales Invoices) fetch their own server-paged data, so the
 * bootstrap slices the SSE handler re-fetches don't cover them. App.tsx's SSE handler bumps the matching counter in
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
  | 'consumableRegister'
  | 'returnsRegister'
  | 'salesInvoices'
  | 'customerDevices';

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
 * - returnsRegister: the shared Returns Register — purchase-return
 *   documents (PROCUREMENT) and sales-return documents (SALES).
 * - salesInvoices: sales invoice/payment events (SALES).
 */
export const DOMAIN_REGISTER_KEYS: Record<string, RegisterRefreshKey[]> = {
  STOCK: ['serialLog'],
  STOCK_OPERATIONS: ['serialLog', 'consumableRegister'],
  SERIALS: ['serialLog'],
  PROCUREMENT: ['serialLog', 'purchaseOrders', 'purchaseInvoices', 'returnsRegister'],
  SALES: ['serialLog', 'salesInvoices', 'returnsRegister'],
  SHIPMENTS: ['purchaseOrders'],
  CUSTOMER_DEVICES: ['serialLog', 'customerDevices'],
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
    returnsRegister: prev.returnsRegister + 1,
    salesInvoices: prev.salesInvoices + 1,
    customerDevices: prev.customerDevices + 1,
  };
}

/**
 * Result of flushing one debounced SSE burst, exactly as App.tsx's
 * debounced handler resolves it: recognized domains refresh just their
 * own slices (targeted — one or many); anything unrecognized
 * re-bootstraps the whole app (full).
 */
export type SseFlushPlan =
  | { mode: 'targeted'; domains: string[] }
  | { mode: 'full' };

/**
 * Accumulates SSE event domains across a debounce window the way
 * App.tsx's debounced SSE handler does, then resolves the window to
 * its refresh plan when the debounce fires.
 *
 * - Known domains collect into a SET, so a multi-domain burst (a
 *   save that touches both STOCK and SALES, say) resolves to a
 *   targeted plan covering exactly those domains instead of a
 *   full app re-bootstrap.
 * - flush() resolves the collected set to a targeted plan when
 *   every observed domain is recognized; any unrecognized domain —
 *   or an event without one — collapses the window to the
 *   full-bootstrap plan, so an unknown server event can never
 *   leave the UI stale. The full-bootstrap path runs
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
  private domains = new Set<string>();

  observe(domain: string | undefined): void {
    if (domain) this.domains.add(domain);
    else this.domains.add(SseDomainBurst.UNKNOWN);
  }

  flush(isKnownDomain: (domain: string) => boolean): SseFlushPlan {
    const observed = [...this.domains];
    this.domains.clear();
    if (observed.length === 0) return { mode: 'full' };
    // Deduplicate the per-domain slice lists; order is irrelevant
    // (the caller refreshes each slice independently) but keep the
    // server's insertion order for deterministic plans.
    const known = observed.filter((d) => d !== SseDomainBurst.UNKNOWN && isKnownDomain(d));
    return known.length === observed.length
      ? { mode: 'targeted', domains: [...new Set(known)] }
      : { mode: 'full' };
  }

  /** Sentinel for an event that carried no (or an unknown) domain. */
  private static readonly UNKNOWN = '__UNKNOWN__';
}
