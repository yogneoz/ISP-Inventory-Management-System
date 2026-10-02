/**
 * SSE domain → paged-register refresh mapping.
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
 *   CPE flows (CUSTOMER_DEVICES), asset deploy/restock (ASSETS) and
 *   purchase-return serial flips (PROCUREMENT) all write serial_log rows.
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
  SHIPMENTS: ['purchaseOrders'],
  CUSTOMER_DEVICES: ['serialLog'],
  ASSETS: ['serialLog'],
};
