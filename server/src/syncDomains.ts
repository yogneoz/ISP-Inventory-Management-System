/**
 * SSE event → client domain mapping.
 *
 * Standalone (no imports) so both the server runtime and unit tests can use
 * it without pulling in the app module's DB connections.
 *
 * Every mutation broadcast reaches the client tagged with the client-state
 * `domain` it invalidates. The client refreshes ONLY that domain's bootstrap
 * slice instead of re-downloading the whole payload; unrecognized events
 * carry no `domain` and fall back to a full bootstrap refresh.
 */
export const DOMAIN_BY_MODULE: Record<string, string> = {
  // Audit modules (logAuditEvent broadcasts type=action, entity=module)
  INVENTORY: 'STOCK',
  STOCK_OPERATIONS: 'STOCK_OPERATIONS',
  PROCUREMENT: 'PROCUREMENT',
  MASTER_DATA: 'MASTER_DATA',
  CATEGORIES: 'CATEGORIES',
  PRODUCTS: 'PRODUCTS',
  FISCAL_YEAR: 'FISCAL',
  AUTH: 'USERS',
  CPE_MANAGEMENT: 'CUSTOMER_DEVICES',
  LOGISTICS: 'SHIPMENTS',
  FIXED_ASSETS: 'ASSETS',
  OPERATIONS: 'APPROVALS',
  SYSTEM: 'RECALC',
  // Explicit event types that bypass logAuditEvent
  STOCK_UPDATED: 'STOCK',
  SERIALS_UPDATED: 'SERIALS',
  VENDOR_PAYMENT: 'PROCUREMENT',
  VENDOR_PAYMENT_REVERSED: 'PROCUREMENT',
  INVOICE_PAYMENTS_REVERSED: 'PROCUREMENT',
  COMPANY_PROFILE_UPDATED: 'COMPANY_PROFILE',
};

/**
 * Resolves the client domain for a broadcast event: the explicit event type
 * wins, then the audit module. Returns undefined for unknown events, which
 * the client treats as "refresh everything".
 */
export function resolveDomain(type?: string, entity?: string): string | undefined {
  return (type && DOMAIN_BY_MODULE[type]) || (entity && DOMAIN_BY_MODULE[entity]) || undefined;
}
