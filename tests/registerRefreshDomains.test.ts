/**
 * Unit tests for the SSE domain → paged-register refresh mapping
 * (node:test). Pins which self-fetching paged registers (Serial Log,
 * Purchase Orders, Purchase Invoices, the consumable register inside
 * StockOperations) re-run their fetch for each SSE domain, so a
 * register can never silently miss a mutation the bootstrap slices
 * don't cover.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_REGISTER_KEYS } from '../client/src/utils/registerRefreshDomains';
import { DOMAIN_BY_MODULE } from '../server/src/syncDomains';

// The complete register vocabulary kept in App.tsx's registerRefresh state.
const REGISTER_KEYS = ['serialLog', 'purchaseOrders', 'purchaseInvoices', 'consumableRegister'];

// Server domains whose mutations never touch any of the four paged
// registers: they refresh bootstrap slices only. Kept in sync by the
// "declared no-register" test below — a new server domain must either
// gain a DOMAIN_REGISTER_KEYS entry or be listed here.
const NO_REGISTER_DOMAINS = [
  'MASTER_DATA', 'CATEGORIES', 'PRODUCTS', 'FISCAL', 'USERS',
  'APPROVALS', 'RECALC', 'COMPANY_PROFILE',
];

describe('SSE domain → register refresh mapping', () => {
  test('each domain refreshes exactly the registers its mutations touch', () => {
    // Serial Log: every domain that writes serial_log rows (stock
    // mutations, stock operations incl. quarantine + reversals, serial
    // edits, purchase-return serial flips, CPE flows, asset moves).
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK_OPERATIONS, ['serialLog', 'consumableRegister']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SERIALS, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.PROCUREMENT, ['serialLog', 'purchaseOrders', 'purchaseInvoices']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SHIPMENTS, ['purchaseOrders']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.CUSTOMER_DEVICES, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.ASSETS, ['serialLog']);
  });

  test('consumableRegister is refreshed only by stock-operation events', () => {
    // Only STOCK_OPERATIONS create or reverse CONSUMABLE_ISSUE rows
    // (CREATE_STOCK_CONSUMABLE_ISSUE, REVERSE_CONSUMABLE_ISSUE, ...).
    const sources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('consumableRegister'))
      .map(([domain]) => domain);
    assert.deepEqual(sources, ['STOCK_OPERATIONS']);
  });

  test('purchase document registers are refreshed only by procurement and shipment events', () => {
    const poSources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('purchaseOrders'))
      .map(([domain]) => domain);
    assert.deepEqual(poSources, ['PROCUREMENT', 'SHIPMENTS']);
    const piSources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('purchaseInvoices'))
      .map(([domain]) => domain);
    assert.deepEqual(piSources, ['PROCUREMENT']);
  });

  test('every mapped value is a known register key', () => {
    for (const [domain, regs] of Object.entries(DOMAIN_REGISTER_KEYS)) {
      assert.ok(regs.length > 0, `domain ${domain} maps to no registers`);
      for (const reg of regs) {
        assert.ok(REGISTER_KEYS.includes(reg), `domain ${domain} maps to unknown register ${reg}`);
      }
    }
  });

  test('domains that never touch the paged registers are deliberately absent', () => {
    for (const domain of NO_REGISTER_DOMAINS) {
      assert.equal(DOMAIN_REGISTER_KEYS[domain], undefined, `domain ${domain} should not refresh any paged register`);
    }
  });

  test('every domain the server can broadcast is either register-mapped or declared no-register', () => {
    // The full broadcast vocabulary resolveDomain can produce. Adding a
    // new server domain without a decision here fails the test.
    for (const domain of Object.values(DOMAIN_BY_MODULE)) {
      if (DOMAIN_REGISTER_KEYS[domain] === undefined) {
        assert.ok(NO_REGISTER_DOMAINS.includes(domain), `domain ${domain} needs a DOMAIN_REGISTER_KEYS entry (or an explicit no-register decision in this test)`);
      }
    }
  });
});
