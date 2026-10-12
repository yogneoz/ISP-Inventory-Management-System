/**
 * Demo-mode (no-PG) finance ledger coverage + cost-price valuation basis.
 *
 * The PG transaction paths write transaction_logs rows for every invoice and
 * return. When PostgreSQL is down, the handlers take a non-DB code path that
 * used to move in-memory stock WITHOUT writing any movement-ledger row — so
 * the ledger went empty on every demo-mode create even though stock changed.
 * These tests exercise the real controller functions against the in-memory
 * mirror (setPgConnected(false)) and assert a ledger row is written with the
 * TRUE before/after balance and the PRODUCT cost price as unit_cost (the
 * same basis the financial matrices value stock at) — not the document's
 * selling/credit price.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  setBranches,
  setProducts,
  setInventoryStock,
  setPurchaseInvoices,
  setSalesInvoices,
  setPurchaseReturns,
  setSalesReturns,
  setSuppliers,
  setDocNumberConfigs,
  setPgConnected,
  setTransactionLogs,
  transactionLogs,
  inventoryStock,
  purchaseReturns,
  salesReturns,
} from '../server/src/app';
import { buildBsDayRecordsForYear, setInMemoryBsDayRecords } from '../server/src/config/bsCalendar';
import { post_purchaseReturns, post_purchaseReturnCancel } from '../server/src/controllers/procurement.controller';
import { post_salesReturns, post_salesReturnCancel } from '../server/src/controllers/sales.controller';
import { replayLedgerBalances, LedgerReplayRow } from '../server/src/models/txnLogRows';
import { resolveLedgerUnitCost } from '../server/src/utils/money';
import { INITIAL_MASTER_BRANCHES } from '../server/src/config/seedData';

function fakeRes() {
  const out: any = { statusCode: 200, body: null };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (payload: any) => { out.body = payload; return out; };
  return out;
}

const DATE_AD = '2026-09-24';

describe('demo-mode (no-PG) finance ledger rows', () => {
  before(() => {
    setPgConnected(false);
    setBranches(INITIAL_MASTER_BRANCHES);
    setSuppliers([{ id: 'sup-1', name: 'Example Supplier 1' } as any]);
    setProducts([
      { id: 'prod-1', name: 'Router', sku: 'RTR', costPrice: 100, requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' },
      { id: 'prod-2', name: 'ONU', sku: 'ONU', costPrice: 40, requiresSerialTracking: false, trackingType: 'QUANTITY_ONLY' },
    ] as any[]);
    setInventoryStock([
      { id: 'stk-wh001-prod-1', productId: 'prod-1', branchId: 'WH001', quantityOnHand: 50, damagedQty: 0, reservedQty: 0, incomingQty: 0, minReorderLevel: 5, lastUpdated: '' },
      { id: 'stk-wh001-prod-2', productId: 'prod-2', branchId: 'WH001', quantityOnHand: 50, damagedQty: 0, reservedQty: 0, incomingQty: 0, minReorderLevel: 5, lastUpdated: '' },
    ] as any[]);
    // Seed the in-memory BS calendar for the whole BS-2083 AD year
    // (2026-04-14 → 2027-04-13) so bsDateOr400 can derive both the fixture
    // return date AND today's cancel date without PostgreSQL (demo mode).
    setInMemoryBsDayRecords(
      buildBsDayRecordsForYear(2083, [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], '2026-04-14') as any[]
    );
    setPurchaseInvoices([]);
    setSalesInvoices([]);
    setPurchaseReturns([]);
    setSalesReturns([]);
    setTransactionLogs([]);
    setDocNumberConfigs([]);
  });

  test('resolveLedgerUnitCost: costPrice wins over document price; falls back to unitPrice when costPrice is absent', () => {
    const products = [{ id: 'p1', costPrice: 100 }] as any[];
    // Cost price is the valuation basis even when the document price differs.
    assert.equal(resolveLedgerUnitCost(products, { productId: 'p1', unitPrice: 999 }), 100);
    // No costPrice on the product -> fall back to the document unit price.
    assert.equal(resolveLedgerUnitCost([{ id: 'p1' }] as any[], { productId: 'p1', unitPrice: 250 }), 250);
    // Unknown product -> document price, then 0.
    assert.equal(resolveLedgerUnitCost([] as any[], { productId: 'ghost', unitPrice: 75 }), 75);
    assert.equal(resolveLedgerUnitCost([] as any[], { productId: 'ghost' }), 0);
  });

  test('purchase return (POSTED) writes a PURCHASE_RETURN row with true before/after and cost-price unit_cost', async () => {
    const req: any = {
      body: {
        originalInvoiceId: 'pi-src-1',
        branchId: 'WH001',
        returnDateAD: DATE_AD,
        items: [{ productId: 'prod-1', productName: 'Router', sku: 'RTR', quantity: 5, unitPrice: 999 }],
      },
      headers: {},
    };
    setPurchaseInvoices([{ id: 'pi-src-1', invoiceNumber: 'PI-SRC-1' } as any]);
    const res = fakeRes();
    await post_purchaseReturns(req, res);
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, 'POSTED');

    const row = transactionLogs.find((t) => t.changeType === 'PURCHASE_RETURN');
    assert.ok(row, 'a PURCHASE_RETURN ledger row must be written in demo mode');
    assert.equal(row!.quantityChanged, -5);
    assert.equal(row!.quantityBefore, 50, 'before = QOH before the deduction');
    assert.equal(row!.quantityAfter, 45, 'after = QOH after the deduction');
    // unit_cost uses the PRODUCT cost price (100), NOT the document price (999).
    assert.equal(row!.unitCost, 100);
    // The in-memory stock mirror actually moved.
    const stk = inventoryStock.find((s) => s.productId === 'prod-1' && s.branchId === 'WH001');
    assert.equal(stk!.quantityOnHand, 45);
  });

  test('purchase return cancel (POSTED) writes a compensating PURCHASE_RETURN_CANCELLED row that nets back', async () => {
    const ret = purchaseReturns[0];
    const req: any = { params: { id: ret.id }, body: { reason: 'test' }, headers: {} };
    const res = fakeRes();
    await post_purchaseReturnCancel(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const row = transactionLogs.find((t) => t.changeType === 'PURCHASE_RETURN_CANCELLED');
    assert.ok(row, 'a compensating PURCHASE_RETURN_CANCELLED row must be written');
    assert.equal(row!.quantityChanged, 5, 'cancel restores the deducted units');
    assert.equal(row!.quantityAfter, 50, 'net quantity returns to the starting level');
    assert.equal(row!.unitCost, 100);
    const stk = inventoryStock.find((s) => s.productId === 'prod-1' && s.branchId === 'WH001');
    assert.equal(stk!.quantityOnHand, 50, 'stock fully restored');
  });

  test('sales return (POSTED, restockable) writes a SALES_RETURN row crediting stock with cost-price unit_cost', async () => {
    const req: any = {
      body: {
        originalInvoiceId: 'si-src-1',
        branchId: 'WH001',
        returnDateAD: DATE_AD,
        restockable: true,
        items: [{ productId: 'prod-2', productName: 'ONU', sku: 'ONU', quantity: 3, unitPrice: 500 }],
      },
      headers: {},
    };
    setSalesInvoices([{ id: 'si-src-1', invoiceNumber: 'SI-SRC-1' } as any]);
    const res = fakeRes();
    await post_salesReturns(req, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));

    const row = transactionLogs.find((t) => t.changeType === 'SALES_RETURN');
    assert.ok(row, 'a SALES_RETURN ledger row must be written in demo mode');
    assert.equal(row!.quantityChanged, 3, 'restock credits stock');
    assert.equal(row!.quantityBefore, 50);
    assert.equal(row!.quantityAfter, 53);
    // unit_cost uses the PRODUCT cost price (40), NOT the credit/selling price (500).
    assert.equal(row!.unitCost, 40);
    const stk = inventoryStock.find((s) => s.productId === 'prod-2' && s.branchId === 'WH001');
    assert.equal(stk!.quantityOnHand, 53);
  });

  test('sales return cancel (POSTED, restockable) writes a compensating SALES_RETURN_CANCELLED row that nets back', async () => {
    const ret = salesReturns[0];
    const req: any = { params: { id: ret.id }, body: { reason: 'test' }, headers: {} };
    const res = fakeRes();
    await post_salesReturnCancel(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));

    const row = transactionLogs.find((t) => t.changeType === 'SALES_RETURN_CANCELLED');
    assert.ok(row, 'a compensating SALES_RETURN_CANCELLED row must be written');
    assert.equal(row!.quantityChanged, -3, 'cancel re-deducts the restocked units');
    assert.equal(row!.quantityAfter, 50, 'net quantity returns to the starting level');
    assert.equal(row!.unitCost, 40);
    const stk = inventoryStock.find((s) => s.productId === 'prod-2' && s.branchId === 'WH001');
    assert.equal(stk!.quantityOnHand, 50, 'stock fully reversed');
  });
});

describe('replayLedgerBalances — legacy placeholder backfill', () => {
  function row(id: string, productId: string, changeType: string, quantityChanged: number, timestampAD: string): LedgerReplayRow {
    return { id, productId, branchId: 'WH001', changeType, quantityChanged, timestampAD };
  }

  test('reconstructs true before/after for placeholder rows by replaying deltas in time order', () => {
    // Placeholder rows: stored before = 0, after = |changed| — the fake
    // "Qty Before" the audit flagged. The deltas are faithful, so true
    // balances are recoverable regardless of the bogus absolutes.
    const result = replayLedgerBalances([
      row('txn-1', 'prod-1', 'PURCHASE_INVOICE', 50, '2026-09-01T00:00:00Z'),
      row('txn-2', 'prod-1', 'SALES_INVOICE', -20, '2026-09-05T00:00:00Z'),
      row('txn-3', 'prod-1', 'SALES_RETURN', 3, '2026-09-10T00:00:00Z'),
    ]);
    const byId = new Map(result.updates.map((u) => [u.id, u]));
    assert.equal(byId.get('txn-1')!.quantityBefore, 0);
    assert.equal(byId.get('txn-1')!.quantityAfter, 50);
    assert.equal(byId.get('txn-2')!.quantityBefore, 50);
    assert.equal(byId.get('txn-2')!.quantityAfter, 30);
    assert.equal(byId.get('txn-3')!.quantityBefore, 30);
    assert.equal(byId.get('txn-3')!.quantityAfter, 33);
    assert.equal(result.skipped, 0);
    assert.equal(result.groups, 1);
  });

  test('DAMAGE is a quantity_on_hand delta (subtracts QOH); DISPOSAL routes to the damaged pool', () => {
    const result = replayLedgerBalances([
      row('txn-1', 'prod-1', 'PURCHASE_INVOICE', 10, '2026-09-01T00:00:00Z'),
      row('txn-2', 'prod-1', 'DAMAGE', -4, '2026-09-02T00:00:00Z'),
      row('txn-3', 'prod-1', 'DISPOSAL', -2, '2026-09-03T00:00:00Z'),
    ]);
    const byId = new Map(result.updates.map((u) => [u.id, u]));
    // DAMAGE consumes QOH: 10 → 6.
    assert.equal(byId.get('txn-2')!.quantityBefore, 10);
    assert.equal(byId.get('txn-2')!.quantityAfter, 6);
    // DISPOSAL carries the DAMAGED-pool before/after, starting from an empty
    // pool: 0 → 0 (clamped), and must NOT touch the QOH balance (still 6).
    assert.equal(byId.get('txn-3')!.quantityBefore, 0);
    assert.equal(byId.get('txn-3')!.quantityAfter, 0);
  });

  test('is idempotent: replaying an already-correct ledger reproduces the same balances', () => {
    const input = [
      row('txn-1', 'prod-1', 'PURCHASE_INVOICE', 50, '2026-09-01T00:00:00Z'),
      row('txn-2', 'prod-1', 'SALES_INVOICE', -20, '2026-09-05T00:00:00Z'),
    ];
    const first = replayLedgerBalances(input);
    const second = replayLedgerBalances(input);
    assert.deepEqual(second.updates, first.updates);
  });

  test('clamps at zero so a historical sign inconsistency cannot surface negative stock', () => {
    const result = replayLedgerBalances([
      row('txn-1', 'prod-1', 'SALES_INVOICE', -30, '2026-09-01T00:00:00Z'),
    ]);
    assert.equal(result.updates[0].quantityBefore, 0);
    assert.equal(result.updates[0].quantityAfter, 0);
  });

  test('groups by (product, branch) — independent running balances, and rows without a product are skipped', () => {
    const result = replayLedgerBalances([
      row('txn-1', 'prod-1', 'PURCHASE_INVOICE', 10, '2026-09-01T00:00:00Z'),
      row('txn-2', 'prod-2', 'PURCHASE_INVOICE', 7, '2026-09-01T00:00:00Z'),
      { ...row('txn-3', 'prod-1', 'SALES_INVOICE', -4, '2026-09-02T00:00:00Z'), branchId: null },
    ]);
    const byId = new Map(result.updates.map((u) => [u.id, u]));
    assert.equal(byId.size, 2, 'skipped row must not produce an update');
    // prod-2 has its own balance, unaffected by prod-1's movement.
    assert.equal(byId.get('txn-2')!.quantityAfter, 7);
    assert.equal(byId.get('txn-1')!.quantityAfter, 10);
    assert.equal(result.groups, 2);
    assert.equal(result.skipped, 1);
  });

  test('does not mutate the input rows', () => {
    const input = [row('txn-1', 'prod-1', 'SALES_INVOICE', -30, '2026-09-01T00:00:00Z')];
    const before = JSON.stringify(input);
    replayLedgerBalances(input);
    assert.equal(JSON.stringify(input), before);
  });
});

describe('ledger change_type pool-routing guard', () => {
  /**
   * Exhaustive pool classification per schema change_type. Any type added to
   * scripts/schema.sql's transaction_logs_change_type_check without a line
   * here fails the parity assertion below — and any type routed to the wrong
   * pool fails the behavioral assertion. DISPOSAL is the only damaged-pool
   * delta (post_stockOperations reads its before from damaged_qty; quantity_on_hand
   * never held those units); every other type moves quantity_on_hand.
   */
  const POOL_BY_CHANGE_TYPE: Record<string, 'QOH' | 'DAMAGED'> = {
    INBOUND_PO: 'QOH',
    PURCHASE_INVOICE: 'QOH',
    SALES_INVOICE: 'QOH',
    PURCHASE_RETURN: 'QOH',
    SALES_RETURN: 'QOH',
    STOCK_ADJUSTMENT: 'QOH',
    MANUAL_ADJUSTMENT: 'QOH',
    DAMAGE: 'QOH',
    DAMAGE_REVERSED: 'QOH',
    DISPOSAL: 'DAMAGED',
    PHYSICAL_AUDIT_EXCESS: 'QOH',
    PHYSICAL_AUDIT_SHORTAGE: 'QOH',
    PULLOUT: 'QOH',
    CONSUMABLE_ISSUE: 'QOH',
    STOCK_OUT: 'QOH',
    TRANSFER_OUT: 'QOH',
    TRANSFER_IN: 'QOH',
    SALE: 'QOH',
    RETURN: 'QOH',
    TRANSFER_CANCELLED: 'QOH',
    TRANSFER_RECEIPT_CANCELLED: 'QOH',
    SALES_INVOICE_CANCELLED: 'QOH',
    PURCHASE_INVOICE_CANCELLED: 'QOH',
    PURCHASE_RETURN_CANCELLED: 'QOH',
    SALES_RETURN_CANCELLED: 'QOH',
  };

  /** The effective CHECK constraint: schema.sql DROPs + re-ADDs it three
   * times as the union grew; the LAST body is the one in force. */
  function schemaChangeTypes(): string[] {
    const schema = fs.readFileSync(new URL('../scripts/schema.sql', import.meta.url), 'utf8');
    const bodies = [...schema.matchAll(/ADD CONSTRAINT transaction_logs_change_type_check CHECK \(([^)]*)\)/g)];
    assert.ok(bodies.length > 0, 'schema.sql must define transaction_logs_change_type_check');
    const last = bodies[bodies.length - 1][1];
    return [...last.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  }

  test('expectation table ↔ schema CHECK constraint parity (no unclassified or phantom types)', () => {
    const schemaTypes = schemaChangeTypes();
    const tableTypes = Object.keys(POOL_BY_CHANGE_TYPE).sort();
    const unclassified = schemaTypes.filter((t) => !(t in POOL_BY_CHANGE_TYPE));
    const phantoms = tableTypes.filter((t) => !schemaTypes.includes(t));
    assert.deepEqual(unclassified, [], 'schema change_type(s) missing from the pool-routing table');
    assert.deepEqual(phantoms, [], 'pool-routing table lists change_type(s) the schema does not allow');
    assert.deepEqual(tableTypes, schemaTypes, 'pool-routing table must classify exactly the schema change_types');
  });

  test('every schema change_type reads the pool its classification names', () => {
    for (const [changeType, pool] of Object.entries(POOL_BY_CHANGE_TYPE)) {
      // Seed the QOH pool with +10, then move −1 under test. A QOH type must
      // read before = 10; a damaged-pool type must read before = 0 (the seed
      // never touched the damaged pool) and clamp after to 0.
      const result = replayLedgerBalances([
        { id: 'txn-seed', productId: 'prod-1', branchId: 'WH001', changeType: 'PURCHASE_INVOICE', quantityChanged: 10, timestampAD: '2026-09-01T00:00:00Z' },
        { id: 'txn-under-test', productId: 'prod-1', branchId: 'WH001', changeType, quantityChanged: -1, timestampAD: '2026-09-02T00:00:00Z' },
      ]);
      const underTest = result.updates.find((u) => u.id === 'txn-under-test');
      assert.ok(underTest, `${changeType} produced no balance update`);
      const expectedBefore = pool === 'DAMAGED' ? 0 : 10;
      assert.equal(underTest!.quantityBefore, expectedBefore, `${changeType} must read the ${pool} pool (before)`);
      assert.equal(underTest!.quantityAfter, Math.max(0, expectedBefore - 1), `${changeType} must apply its delta to the ${pool} pool (after)`);
    }
  });
});
