/**
 * STOCK-1 — the stock index must answer exactly what the scan answered.
 *
 * The screens replaced `stock.find((st) => st.productId === … && st.branchId ===
 * …)` with a Map lookup. Speed is the reason, but parity is the contract: the
 * same pair must yield the same row, duplicates must still resolve to the FIRST
 * match (as `find` does), and a missing pair must still total 0 rather than NaN.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupStockByProduct,
  indexFirstBy,
  indexStockByProductBranch,
  stockDamagedAt,
  stockOnHandAt,
  stockPairKey,
  stockRowAt,
  type StockRow,
} from '../client/src/utils/stockIndex';

const row = (productId: string, branchId: string, quantityOnHand: number | string = 0, damagedQty: number | string = 0): StockRow => ({
  productId,
  branchId,
  quantityOnHand,
  damagedQty,
});

/** The pre-STOCK-1 lookup, kept here as the oracle. */
const findRow = <T extends StockRow>(rows: readonly T[], productId: string, branchId: string) =>
  rows.find((st) => st.productId === productId && st.branchId === branchId);

describe('STOCK-1 — stock index parity', () => {
  test('returns the row for a (product, branch) pair', () => {
    const rows = [row('p1', 'b1', 12), row('p1', 'b2', 7), row('p2', 'b1', 3)];
    const index = indexStockByProductBranch(rows);
    assert.equal(stockRowAt(index, 'p1', 'b2'), rows[1]);
  });

  test('a pair with no stock row is undefined, and its quantities are 0 (never NaN)', () => {
    const index = indexStockByProductBranch([row('p1', 'b1', 12)]);
    assert.equal(stockRowAt(index, 'p2', 'b1'), undefined);
    assert.equal(stockOnHandAt(index, 'p2', 'b1'), 0);
    assert.equal(stockDamagedAt(index, 'p2', 'b1'), 0);
  });

  test('duplicate pairs keep the FIRST row, exactly like Array.find', () => {
    const rows = [row('p1', 'b1', 5), row('p1', 'b1', 99)];
    const index = indexStockByProductBranch(rows);
    assert.equal(findRow(rows, 'p1', 'b1'), rows[0], 'oracle: find returns the first');
    assert.equal(stockRowAt(index, 'p1', 'b1'), rows[0]);
    assert.equal(stockOnHandAt(index, 'p1', 'b1'), 5, 'the later duplicate must not win');
  });

  test('agrees with find on every pair of a mixed fixture', () => {
    const rows: StockRow[] = [];
    for (const p of ['p1', 'p2', 'p3']) {
      for (const b of ['b1', 'b2']) {
        // p2/b2 deliberately has no row, so the missing case is exercised too.
        if (p === 'p2' && b === 'b2') continue;
        rows.push(row(p, b, `${(p.length + b.length) * 3}`, 1));
      }
    }
    // A duplicate in the middle of the array must not change any answer.
    rows.splice(2, 0, row('p1', 'b1', 999));

    const index = indexStockByProductBranch(rows);
    for (const p of ['p1', 'p2', 'p3']) {
      for (const b of ['b1', 'b2']) {
        assert.equal(stockRowAt(index, p, b), findRow(rows, p, b), `${p}/${b}`);
        const expectedQty = (() => {
          const item = findRow(rows, p, b);
          return item ? Number(item.quantityOnHand) : 0;
        })();
        assert.equal(stockOnHandAt(index, p, b), expectedQty, `quantity ${p}/${b}`);
      }
    }
  });

  test('numeric strings from SQL read the same as numbers', () => {
    const index = indexStockByProductBranch([row('p1', 'b1', '14', '2')]);
    assert.equal(stockOnHandAt(index, 'p1', 'b1'), 14);
    assert.equal(stockDamagedAt(index, 'p1', 'b1'), 2);
  });

  test('a row present but missing a quantity field keeps the old NaN/0 split', () => {
    // The pre-STOCK-1 screens did `item ? Number(item.quantityOnHand) : 0` for
    // on-hand and `st ? Number(st.damagedQty) || 0 : 0` for damaged. A missing
    // on-hand field therefore produced NaN (not 0) — parity means it still does,
    // so a bad row stays visible instead of silently reading as empty stock.
    const rows = [{ productId: 'p1', branchId: 'b1' }];
    const index = indexStockByProductBranch(rows);
    assert.ok(Number.isNaN(stockOnHandAt(index, 'p1', 'b1')));
    assert.equal(stockDamagedAt(index, 'p1', 'b1'), 0);
  });

  test('pair keys cannot collide across a separator in the ids', () => {
    assert.notEqual(stockPairKey('p1', 'b1'), stockPairKey('p1\u0000b1', ''));
    const index = indexStockByProductBranch([row('p1', 'b1', 1), row('p1\u0000b1', '', 2)]);
    assert.equal(stockOnHandAt(index, 'p1', 'b1'), 1);
    assert.equal(stockOnHandAt(index, 'p1\u0000b1', ''), 2);
  });

  test('groupStockByProduct keeps every branch row for a product, in input order', () => {
    const rows = [row('p1', 'b2', 2), row('p2', 'b1', 9), row('p1', 'b1', 1)];
    const groups = groupStockByProduct(rows);
    assert.deepEqual(
      groups.get('p1')?.map((r) => r.branchId),
      ['b2', 'b1'],
      'groups must preserve the input order, so a screen lists branches as it did with filter()'
    );
    assert.equal(groups.get('p2')?.length, 1);
    assert.equal(groups.get('p3'), undefined);
  });

  test('indexFirstBy keeps the first row per key for the audit-row index too', () => {
    const auditRows = [
      { productId: 'p1', countedQty: 4 },
      { productId: 'p1', countedQty: 9 },
      { productId: 'p2', countedQty: 2 },
    ];
    const index = indexFirstBy(auditRows, (r) => r.productId);
    assert.equal(index.get('p1')?.countedQty, 4);
    assert.equal(index.get('p2')?.countedQty, 2);
    assert.equal(index.get('p3'), undefined);
  });
});
