/**
 * C1 end-to-end verification: write endpoints must recompute financial
 * aggregates server-side and IGNORE tampered client-supplied totals.
 *
 * Exercises the real controller functions with fake req/res objects and the
 * in-memory mirror state (PostgreSQL down = demo mode, so the handlers take
 * the same non-DB code path the C1 recompute lives in — and withTransaction
 * is never reached, keeping the test hermetic).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setBranches,
  setProducts,
  setInventoryStock,
  setStockOperations,
  setPurchaseOrders,
  setPurchaseInvoices,
  setSuppliers,
  setDocNumberConfigs,
  setPgConnected,
  setTransactionLogs,
} from '../server/src/app';
import { post_stockOperations } from '../server/src/controllers/inventory.controller';
import { post_purchaseOrders, post_purchaseInvoices } from '../server/src/controllers/procurement.controller';
import { INITIAL_MASTER_BRANCHES } from '../server/src/config/seedData';

function fakeRes() {
  const out: any = { statusCode: 200, body: null };
  out.status = (code: number) => { out.statusCode = code; return out; };
  out.json = (payload: any) => { out.body = payload; return out; };
  return out;
}

describe('C1 end-to-end: tampered client aggregates are recomputed server-side', () => {
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
    setStockOperations([]);
    setPurchaseOrders([]);
    setPurchaseInvoices([]);
    setTransactionLogs([]);
    setDocNumberConfigs([]);
  });

  test('stock operation: client totalValue is ignored, total = Σ qty × resolved cost', async () => {
    const req: any = {
      body: {
        type: 'DAMAGE',
        branchId: 'WH001',
        dateAD: '2026-09-24',
        items: [
          { productId: 'prod-1', productName: 'Router', quantity: 2, unitCost: 100, totalValue: 999999 },
          { productId: 'prod-2', productName: 'ONU', quantity: 3, unitCost: 40, totalValue: 1 },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_stockOperations(req, res);
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    // 2×100 + 3×40 = 320, NOT 1,000,000
    assert.equal(res.body.totalValue, 320);
    assert.equal(res.body.dateBS.endsWith('BS'), true);
  });

  test('stock operation: tampered totalValue on ONE line only cannot inflate the total', async () => {
    const req: any = {
      body: {
        type: 'STOCK_OUT',
        branchId: 'WH001',
        dateAD: '2026-09-24',
        items: [
          { productId: 'prod-1', quantity: 1, unitCost: 100, totalValue: 5000000 },
          { productId: 'prod-2', quantity: 1, unitCost: 40 },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_stockOperations(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.totalValue, 140);
  });

  test('purchase order: tampered header totals and per-line subtotal/taxAmount are ignored', async () => {
    const req: any = {
      body: {
        supplierName: 'Example Supplier 1',
        branchId: 'WH001',
        orderDateAD: '2026-09-24',
        // tampered header aggregates
        subtotalAmount: 1,
        taxAmount: 1,
        totalAmount: 1,
        items: [
          { productId: 'prod-1', productName: 'Router', quantity: 10, unitPrice: 100, taxRate: 13, isTaxExempt: false, subtotal: 999, taxAmount: 999 },
          { productId: 'prod-2', productName: 'ONU', quantity: 5, unitPrice: 40, taxRate: 0, isTaxExempt: true, subtotal: 999, taxAmount: 999 },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_purchaseOrders(req, res);
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    // gross 1000 + 200; net = same (no discount); VAT = 13% of 1000 = 130
    assert.equal(res.body.subtotalAmount, 1200);
    assert.equal(res.body.taxAmount, 130);
    assert.equal(res.body.totalAmount, 1330);
  });

  test('purchase invoice: tampered grandTotal/taxableAmount/vatAmount are ignored; totalDiscount is honored but clamped', async () => {
    const req: any = {
      body: {
        invoiceNumber: 'PI-TAMPER-1',
        supplierName: 'Example Supplier 1',
        branchId: 'WH001',
        invoiceDateAD: '2026-09-24',
        // tampered financial aggregates
        taxableAmount: 1,
        vatAmount: 1,
        nonTaxableAmount: 1,
        grandTotal: 1,
        subtotalAmount: 1,
        // legitimate business input: a 13% bill-level discount on 1200 gross
        totalDiscount: 156,
        items: [
          { productId: 'prod-1', productName: 'Router', quantity: 10, unitPrice: 100, taxRate: 13, isTaxExempt: false },
          { productId: 'prod-2', productName: 'ONU', quantity: 5, unitPrice: 40, taxRate: 0, isTaxExempt: true },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_purchaseInvoices(req, res);
    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    // gross 1200, discount 156 (proportional: 1000→130, 200→26), net 1044
    assert.equal(res.body.subtotalAmount, 1044);
    assert.equal(res.body.taxableAmount, 870);
    assert.equal(res.body.nonTaxableAmount, 174);
    assert.equal(res.body.vatAmount, 113.1);
    assert.equal(res.body.grandTotal, 1157.1);
  });

  test('purchase invoice: over-gross and negative discounts are clamped, tampered aggregates still ignored', async () => {
    const req: any = {
      body: {
        invoiceNumber: 'PI-TAMPER-2',
        supplierName: 'Example Supplier 1',
        branchId: 'WH001',
        invoiceDateAD: '2026-09-24',
        taxableAmount: 1,
        vatAmount: 1,
        nonTaxableAmount: 1,
        grandTotal: 1,
        subtotalAmount: 1,
        totalDiscount: -500, // negative → clamped to 0
        items: [
          { productId: 'prod-1', productName: 'Router', quantity: 2, unitPrice: 100, taxRate: 13, isTaxExempt: false },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_purchaseInvoices(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.subtotalAmount, 200);
    assert.equal(res.body.taxableAmount, 200);
    assert.equal(res.body.vatAmount, 26);
    assert.equal(res.body.grandTotal, 226);
  });

  test('purchase invoice: discount larger than gross is clamped to gross → zero totals', async () => {
    const req: any = {
      body: {
        invoiceNumber: 'PI-TAMPER-3',
        supplierName: 'Example Supplier 1',
        branchId: 'WH001',
        invoiceDateAD: '2026-09-24',
        grandTotal: 1,
        totalDiscount: 999999,
        items: [
          { productId: 'prod-1', productName: 'Router', quantity: 1, unitPrice: 100, taxRate: 13, isTaxExempt: false },
        ],
      },
      headers: {},
    };
    const res = fakeRes();
    await post_purchaseInvoices(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.grandTotal, 0);
    assert.equal(res.body.vatAmount, 0);
  });
});
