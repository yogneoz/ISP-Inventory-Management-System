/**
 * Unit tests for the shipments repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shipmentUpsertParams,
  shipmentQtySent,
  shipmentIncomingDestParams,
  shipmentReceiveStockParams,
  SHIPMENT_LIST_SQL,
  SHIPMENT_UPSERT_SQL,
  SHIPMENT_FIND_FOR_CANCEL_SQL,
} from '../server/src/models/shipments.repo';

describe('shipmentUpsertParams', () => {
  test('fills 13 columns with documented defaults', () => {
    const sh = {
      id: 'sh-1', trackingCode: 'ST-1', sourceBranchId: 'WH001', sourceBranchName: 'Warehouse',
      destinationBranchId: 'BR01', destinationBranchName: 'Branch 1',
      dispatchDateAD: '2026-01-01', dispatchDateBS: '2083-04-10 BS',
      status: 'IN_TRANSIT', items: [{ productId: 'p1' }],
    };
    assert.deepEqual(shipmentUpsertParams(sh), [
      'sh-1', 'ST-1', 'INTER_BRANCH', 'WH001', 'Warehouse', 'BR01', 'Branch 1',
      '2026-01-01', '2083-04-10 BS', null, 'IN_TRANSIT', '', '[{"productId":"p1"}]',
    ]);
  });

  test('keeps provided type and accepts both estimatedArrival spellings', () => {
    const base = { id: 's', trackingCode: 't', dispatchDateAD: '', dispatchDateBS: '', status: 'IN_TRANSIT', items: [] };
    assert.equal(shipmentUpsertParams({ ...base, type: 'RETURN' }, )[2], 'RETURN');
    assert.equal(shipmentUpsertParams({ ...base, estimatedArrivalAD: '2026-02-01' })[9], '2026-02-01');
    assert.equal(shipmentUpsertParams({ ...base, estimatedArrivalAd: '2026-02-02' })[9], '2026-02-02');
  });

  test('upsert SQL only syncs status and items on conflict', () => {
    assert.match(SHIPMENT_UPSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET\s*\n\s*status = EXCLUDED\.status,\s*\n\s*items = EXCLUDED\.items;/);
  });
});

describe('shipmentQtySent', () => {
  test('prefers quantitySent, then quantity, then defaults to 1', () => {
    assert.equal(shipmentQtySent({ quantitySent: 5, quantity: 9 }), 5);
    assert.equal(shipmentQtySent({ quantity: 9 }), 9);
    assert.equal(shipmentQtySent({}), 1);
    assert.equal(shipmentQtySent({ quantitySent: 0, quantity: 0 }), 1);
  });
});

describe('stock param builders', () => {
  test('shipmentIncomingDestParams builds deterministic destination stock id', () => {
    assert.deepEqual(
      shipmentIncomingDestParams('BR01', { productId: 'p1', quantity: 4 }),
      ['stk-br01-p1', 'p1', 'BR01', 4]
    );
    assert.equal(shipmentIncomingDestParams('BR01', { productId: 'p1', quantitySent: 3 })[3], 3);
  });

  test('shipmentReceiveStockParams uses quantityReceived with sent/1 fallbacks', () => {
    assert.deepEqual(
      shipmentReceiveStockParams('BR01', { productId: 'p2', quantityReceived: 7 }),
      ['stk-br01-p2', 'p2', 'BR01', 7]
    );
    assert.equal(shipmentReceiveStockParams('BR01', { productId: 'p2', quantitySent: 3 })[3], 3);
    assert.equal(shipmentReceiveStockParams('BR01', { productId: 'p2' })[3], 1);
  });
});

describe('query constants', () => {
  test('list SQL selects all aliased columns ordered by created_at DESC', () => {
    for (const alias of ['"trackingCode"', '"dispatchDateAD"', '"hasDiscrepancy"', '"receivedDateBS"']) {
      assert.ok(SHIPMENT_LIST_SQL.includes(alias), `missing ${alias}`);
    }
    assert.match(SHIPMENT_LIST_SQL, / FROM shipments ORDER BY created_at DESC$/);
  });

  test('cancel lookup locks the row with FOR UPDATE and matches by id or tracking code', () => {
    assert.match(SHIPMENT_FIND_FOR_CANCEL_SQL, / WHERE id = \$1 OR tracking_code = \$1 FOR UPDATE$/);
    assert.ok(SHIPMENT_FIND_FOR_CANCEL_SQL.includes('"sourceBranchId"'));
    assert.ok(SHIPMENT_FIND_FOR_CANCEL_SQL.includes('"destinationBranchId"'));
  });
});
