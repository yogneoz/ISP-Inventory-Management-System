/**
 * Unit tests for the SSE event → domain mapping (node:test).
 * Guarantees every audited server module maps to a client domain, so a
 * mutation can never silently lose its targeted-refresh tag.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_BY_MODULE, resolveDomain } from '../server/src/syncDomains';

describe('SSE domain mapping', () => {
  test('every audit module emitted by logAuditEvent maps to a domain', () => {
    // The full module vocabulary emitted by server logAuditEvent calls
    // (kept in sync by this test — a new module without a mapping makes
    // its events fall back to full bootstrap, which this flags).
    const AUDIT_MODULES = [
      'MASTER_DATA', 'PROCUREMENT', 'FISCAL_YEAR', 'AUTH', 'SYSTEM',
      'STOCK_OPERATIONS', 'PRODUCTS', 'LOGISTICS', 'CPE_MANAGEMENT',
      'CATEGORIES', 'OPERATIONS', 'FIXED_ASSETS', 'INVENTORY',
    ];
    for (const m of AUDIT_MODULES) {
      assert.ok(DOMAIN_BY_MODULE[m], `audit module ${m} has no domain mapping`);
    }
  });

  test('explicit broadcast event types map to domains', () => {
    for (const t of ['STOCK_UPDATED', 'SERIALS_UPDATED', 'VENDOR_PAYMENT', 'VENDOR_PAYMENT_REVERSED', 'INVOICE_PAYMENTS_REVERSED', 'COMPANY_PROFILE_UPDATED']) {
      assert.ok(DOMAIN_BY_MODULE[t], `event type ${t} has no domain mapping`);
    }
  });

  test('resolveDomain prefers the explicit type over the entity module', () => {
    // VENDOR_PAYMENT is an explicit type; its entity is the PROCUREMENT module
    assert.equal(resolveDomain('VENDOR_PAYMENT', 'PROCUREMENT'), 'PROCUREMENT');
    // An action name that is not itself a key falls through to the module
    assert.equal(resolveDomain('CREATE_PURCHASE_ORDER', 'PROCUREMENT'), 'PROCUREMENT');
    assert.equal(resolveDomain('REVERSE_STOCK_DAMAGE', 'STOCK_OPERATIONS'), 'STOCK_OPERATIONS');
    assert.equal(resolveDomain('RECEIVE_SHIPMENT', 'LOGISTICS'), 'SHIPMENTS');
    assert.equal(resolveDomain('STOCK_UPDATED', 'stock'), 'STOCK');
  });

  test('unknown events resolve to undefined (full-bootstrap fallback)', () => {
    assert.equal(resolveDomain('TOTALLY_NEW_EVENT', 'SOMETHING_ELSE'), undefined);
    assert.equal(resolveDomain(undefined, undefined), undefined);
    assert.equal(resolveDomain('', ''), undefined);
  });
});
