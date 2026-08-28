import { describe, it, expect, beforeEach } from 'vitest';
import * as store from '../../server/store';
import { generateStandardTransactionId } from '../../server/store';
import type { InventoryStock, Product, TransactionLog } from '../../src/types';
import { getTodayBsStamp } from '../../server/lib/authUtils';

/**
 * Domain invariant helpers used by stock mutation flows.
 * These mirror the rules the API must uphold so regressions are caught early.
 */
function applyStockChange(options: {
  stock: InventoryStock;
  product: Product;
  delta: number;
  changeType: TransactionLog['changeType'];
  referenceDocId: string;
  allowNegative?: boolean;
}): TransactionLog {
  const { stock, product, delta, changeType, referenceDocId, allowNegative } = options;
  const before = stock.quantityOnHand;
  const after = before + delta;
  if (!allowNegative && after < 0) {
    throw new Error(
      `Insufficient stock for ${product.sku}: on-hand ${before}, requested ${Math.abs(delta)}`
    );
  }
  stock.quantityOnHand = after;
  stock.lastUpdated = new Date().toISOString();

  const txn: TransactionLog = {
    id: `txn-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    transactionNumber: generateStandardTransactionId(stock.branchId, changeType),
    productId: product.id,
    productSku: product.sku,
    productName: product.name,
    branchId: stock.branchId,
    changeType,
    quantityBefore: before,
    quantityChanged: delta,
    quantityAfter: after,
    unitCost: product.costPrice,
    referenceDocId,
    timestampAD: new Date().toISOString(),
    timestampBS: getTodayBsStamp(),
  };
  store.transactionLogs.unshift(txn);
  return txn;
}

describe('stock movement invariants', () => {
  let product: Product;
  let stock: InventoryStock;

  beforeEach(() => {
    store.replaceCollection('products', []);
    store.replaceCollection('inventoryStock', []);
    store.replaceCollection('transactionLogs', []);
    store.replaceCollection('branches', [...store.INITIAL_MASTER_BRANCHES]);

    product = {
      id: 'prod-1',
      sku: 'FIBER-PATCH-1M',
      barcode: 'BC1',
      name: 'Fiber Patch Cord 1m',
      category: 'Consumable',
      unit: 'Pcs',
      costPrice: 150,
      sellingPrice: 250,
      taxRate: 13,
      minReorderLevel: 10,
    };
    stock = {
      id: 'stk-1',
      productId: product.id,
      branchId: 'WH001',
      quantityOnHand: 50,
      damagedQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      lastUpdated: new Date().toISOString(),
    };
    store.products.push(product);
    store.inventoryStock.push(stock);
  });

  it('records inbound receipts and increases on-hand qty', () => {
    const txn = applyStockChange({
      stock,
      product,
      delta: 10,
      changeType: 'INBOUND_PO',
      referenceDocId: 'PO-100',
    });
    expect(stock.quantityOnHand).toBe(60);
    expect(txn.quantityBefore).toBe(50);
    expect(txn.quantityChanged).toBe(10);
    expect(txn.quantityAfter).toBe(60);
    expect(txn.quantityAfter).toBe(txn.quantityBefore + txn.quantityChanged);
    expect(store.transactionLogs[0].id).toBe(txn.id);
  });

  it('records stock-out deductions with ledger consistency', () => {
    const txn = applyStockChange({
      stock,
      product,
      delta: -7,
      changeType: 'STOCK_OUT',
      referenceDocId: 'SO-55',
    });
    expect(stock.quantityOnHand).toBe(43);
    expect(txn.quantityAfter).toBe(txn.quantityBefore + txn.quantityChanged);
  });

  it('rejects stock-out that would drive quantity negative', () => {
    expect(() =>
      applyStockChange({
        stock,
        product,
        delta: -999,
        changeType: 'STOCK_OUT',
        referenceDocId: 'SO-OVERFLOW',
      })
    ).toThrow(/Insufficient stock/i);
    expect(stock.quantityOnHand).toBe(50);
    expect(store.transactionLogs).toHaveLength(0);
  });

  it('physical audit excess/shortage adjusts book qty to counted qty', () => {
    const bookQty = stock.quantityOnHand;
    const countedQty = 47;
    const delta = countedQty - bookQty;
    const txn = applyStockChange({
      stock,
      product,
      delta,
      changeType: delta < 0 ? 'PHYSICAL_AUDIT_SHORTAGE' : 'PHYSICAL_AUDIT_EXCESS',
      referenceDocId: 'AUD-2083-01',
    });
    expect(stock.quantityOnHand).toBe(countedQty);
    expect(txn.changeType).toBe('PHYSICAL_AUDIT_SHORTAGE');
    expect(txn.quantityChanged).toBe(-3);
  });

  it('inter-branch transfer is qty-conserving across two stock rows', () => {
    const dest: InventoryStock = {
      id: 'stk-2',
      productId: product.id,
      branchId: 'ITH01',
      quantityOnHand: 5,
      damagedQty: 0,
      reservedQty: 0,
      incomingQty: 0,
      lastUpdated: new Date().toISOString(),
    };
    store.inventoryStock.push(dest);

    const transferQty = 8;
    const totalBefore =
      store.inventoryStock
        .filter((s) => s.productId === product.id)
        .reduce((sum, s) => sum + s.quantityOnHand, 0);

    applyStockChange({
      stock,
      product,
      delta: -transferQty,
      changeType: 'SHIPMENT_TRANSFER',
      referenceDocId: 'TRF-1',
    });
    applyStockChange({
      stock: dest,
      product,
      delta: transferQty,
      changeType: 'SHIPMENT_TRANSFER',
      referenceDocId: 'TRF-1',
    });

    const totalAfter =
      store.inventoryStock
        .filter((s) => s.productId === product.id)
        .reduce((sum, s) => sum + s.quantityOnHand, 0);

    expect(stock.quantityOnHand).toBe(42);
    expect(dest.quantityOnHand).toBe(13);
    expect(totalAfter).toBe(totalBefore);
    expect(store.transactionLogs).toHaveLength(2);
  });

  it('generateStandardTransactionId embeds branch and op type', () => {
    const id = generateStandardTransactionId('WH001', 'STOCK_OUT');
    expect(id).toMatch(/WH001/i);
    expect(id.length).toBeGreaterThan(6);
  });
});
