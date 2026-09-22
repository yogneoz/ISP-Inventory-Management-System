/**
 * Unit tests for the inventory repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TXN_INSERT_NOW_SQL,
  miscPulloutTxnParams,
  buildStockListQuery,
  STOCK_FIND_BY_ID_SQL,
  STOCK_UPSERT_LEVELS_SQL,
  stockUpsertLevelsParams,
  STOCK_UPSERT_REORDER_SQL,
  stockUpsertReorderParams,
  STOCK_RECONCILE_UPSERT_SQL,
  stockReconcileUpsertParams,
  TXN_INSERT_ON_CONFLICT_SQL,
  txnInsertOnConflictParams,
  DAMAGE_RECORD_ADJUSTMENT_SQL,
  damageAdjustmentParams,
  DAMAGE_RECORD_AUDIT_SHORTAGE_SQL,
  damageAuditShortageParams,
  DAMAGE_RECORD_CANCEL_SQL,
  buildAssetListQuery,
  ASSET_UPSERT_SQL,
  assetUpsertParams,
  ASSET_SET_STATUS_SQL,
  buildStockOperationListQuery,
  STOCK_OPERATION_INSERT_SQL,
  stockOperationInsertParams,
  STOCK_DAMAGE_APPLY_SQL,
  STOCK_RELEASE_DAMAGED_SQL,
  STOCK_CONSUME_QOH_SQL,
  STOCK_REVERSE_DAMAGE_SQL,
  STOCK_OPERATION_CANCEL_SQL,
  STOCK_OPERATION_FIND_FOR_RECEIVE_SQL,
  STOCK_OPERATION_SET_STATUS_SQL,
  PULLOUT_RECEIVE_STOCK_SQL,
  pulloutReceiveStockParams,
  buildCustomerDeviceListQuery,
  CDR_DUPLICATE_CHECK_SQL,
  CDR_FIND_NARROW_SQL,
  CDR_UPDATE_STATUS_SQL,
  CDR_UPSERT_SQL,
  CDR_EXCHANGE_INSERT_SQL,
  customerDeviceInsertParams,
  CDR_ASSIGNMENT_STOCK_SQL,
  cdrAssignmentStockParams,
  CDR_CUSTOMER_COUNT_UPSERT_SQL,
  customerCountUpsertParams,
  buildSerialLookupSql,
  buildSerialLogQuery,
  SERIAL_LOG_FIND_BY_DEVICE_SQL,
  SERIAL_LOG_UPDATE_SQL,
  serialLogUpdateParams,
  SERIAL_LOG_INSERT_SQL,
  serialLogInsertParams,
} from '../server/src/models/inventory.repo';
import { MISC_PULLOUT_TXN_SQL } from '../server/src/models/misc.repo';
import type { TransactionLog } from '../client/src/types';

/** Max placeholder index used by a SQL string, e.g. $7 → 7. */
function maxPlaceholder(sql: string): number {
  const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : 0;
}

const baseTxn: TransactionLog = {
  id: 'txn-1',
  transactionNumber: 'TXN-12345',
  productId: 'p1',
  productSku: 'SKU-1',
  productName: 'ONU',
  branchId: 'WH001',
  changeType: 'DAMAGE',
  quantityBefore: 4,
  quantityChanged: -1,
  quantityAfter: 3,
  unitCost: 3500,
  referenceDocId: 'OP-1',
  timestampAD: '2026-09-22T00:00:00.000Z',
  timestampBS: '2083-04-22 BS',
};

describe('stock list / lookup', () => {
  test('buildStockListQuery orders by branch then product; filters concrete branches', () => {
    const { sql, params } = buildStockListQuery('BR02');
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY branch_id, product_id$/);
    assert.deepEqual(params, ['BR02']);
    const all = buildStockListQuery('ALL');
    assert.ok(!all.sql.includes(' WHERE '));
    assert.deepEqual(all.params, []);
    assert.ok(all.sql.includes('"quantityOnHand"') && all.sql.includes('"lastUpdated"'));
  });

  test('STOCK_FIND_BY_ID_SQL reads the eight non-timestamp columns', () => {
    assert.match(STOCK_FIND_BY_ID_SQL, / FROM inventory_stock WHERE id = \$1$/);
    assert.ok(!STOCK_FIND_BY_ID_SQL.includes('last_updated'));
  });
});

describe('stock upserts', () => {
  const stk = {
    id: 'stk-wh001-p1', productId: 'p1', branchId: 'WH001',
    quantityOnHand: 3, damagedQty: 1, reservedQty: 0, incomingQty: 2, minReorderLevel: 5,
  };

  test('levels upsert stamps NOW() server-side and refreshes qty/damaged/reorder', () => {
    assert.match(STOCK_UPSERT_LEVELS_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, NOW\(\)\)/);
    assert.match(STOCK_UPSERT_LEVELS_SQL, /quantity_on_hand = EXCLUDED\.quantity_on_hand/);
    assert.match(STOCK_UPSERT_LEVELS_SQL, /damaged_qty = EXCLUDED\.damaged_qty/);
    assert.match(STOCK_UPSERT_LEVELS_SQL, /min_reorder_level = EXCLUDED\.min_reorder_level/);
    assert.equal(maxPlaceholder(STOCK_UPSERT_LEVELS_SQL), 8);
    assert.deepEqual(stockUpsertLevelsParams({ ...stk, minReorderLevel: undefined }), [
      'stk-wh001-p1', 'p1', 'WH001', 3, 1, 0, 2, 5,
    ]);
  });

  test('reorder upsert only refreshes min_reorder_level on conflict', () => {
    assert.match(STOCK_UPSERT_REORDER_SQL, /ON CONFLICT \(id\) DO UPDATE SET min_reorder_level = \$8$/);
    assert.equal(maxPlaceholder(STOCK_UPSERT_REORDER_SQL), 8);
    assert.deepEqual(stockUpsertReorderParams(stk), [
      'stk-wh001-p1', 'p1', 'WH001', 3, 1, 0, 2, 5,
    ]);
  });

  test('reconcile upsert sets the absolute counted quantity', () => {
    assert.match(STOCK_RECONCILE_UPSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET quantity_on_hand = EXCLUDED\.quantity_on_hand;/);
    assert.equal(maxPlaceholder(STOCK_RECONCILE_UPSERT_SQL), 7);
    assert.deepEqual(stockReconcileUpsertParams(stk), [
      'stk-wh001-p1', 'p1', 'WH001', 3, 1, 0, 2,
    ]);
  });
});

describe('transaction-log inserts', () => {
  test('NOW()-stamped insert is the misc.repo canonical text (single source)', () => {
    assert.equal(TXN_INSERT_NOW_SQL, MISC_PULLOUT_TXN_SQL);
    assert.equal(TXN_INSERT_NOW_SQL, miscPulloutTxnParams(baseTxn).length >= 13 ? TXN_INSERT_NOW_SQL : TXN_INSERT_NOW_SQL);
    assert.match(TXN_INSERT_NOW_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, NOW\(\), \$13\)/);
  });

  test('idempotent 14-bind insert binds timestamp_ad explicitly', () => {
    assert.equal(maxPlaceholder(TXN_INSERT_ON_CONFLICT_SQL), 14);
    assert.match(TXN_INSERT_ON_CONFLICT_SQL, /ON CONFLICT \(id\) DO NOTHING$/);
    assert.deepEqual(txnInsertOnConflictParams(baseTxn), [
      'txn-1', 'TXN-12345', 'p1', 'SKU-1', 'ONU', 'WH001', 'DAMAGE',
      4, -1, 3, 3500, 'OP-1', '2026-09-22T00:00:00.000Z', '2083-04-22 BS',
    ]);
  });
});

describe('damage-record inserts (manual adjustment + audit shortage)', () => {
  test('adjustment insert defaults status IDENTIFIED and takes 13 binds', () => {
    assert.match(DAMAGE_RECORD_ADJUSTMENT_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, 'IDENTIFIED', 0, 'GL-5120 \(Loss on Inventory Scrap & Write-off\)', 0, \$11, \$12, FALSE, \$13\)/);
    assert.equal(maxPlaceholder(DAMAGE_RECORD_ADJUSTMENT_SQL), 13);
    assert.deepEqual(
      damageAdjustmentParams({
        id: 'dmr-1', damageReference: 'DMR-1', productId: 'p1', branchId: 'WH001',
        quantityDamaged: 2, unitCost: 10, totalCost: 20, damageDateAD: '2026-09-22',
        damageDateBS: '2083-04-22 BS', damageReason: 'OTHER', approvedBy: 'a', notes: 'n', createdBy: 'c',
      }),
      ['dmr-1', 'DMR-1', 'p1', 'WH001', 2, 10, 20, '2026-09-22', '2083-04-22 BS', 'OTHER', 'a', 'n', 'c']
    );
  });

  test('audit-shortage insert pins reason OTHER and takes 12 binds', () => {
    assert.match(DAMAGE_RECORD_AUDIT_SHORTAGE_SQL, /\$9, 'OTHER', 'IDENTIFIED', 0,/);
    assert.equal(maxPlaceholder(DAMAGE_RECORD_AUDIT_SHORTAGE_SQL), 12);
    assert.deepEqual(
      damageAuditShortageParams({
        id: 'dmr-a', damageReference: 'AUDIT-1', productId: 'p1', branchId: 'B',
        quantityDamaged: 1, unitCost: 5, totalCost: 5, damageDateAD: 'd', damageDateBS: 'bs',
        approvedBy: 'aud', notes: 'n', createdBy: 'c',
      }),
      ['dmr-a', 'AUDIT-1', 'p1', 'B', 1, 5, 5, 'd', 'bs', 'aud', 'n', 'c']
    );
  });

  test('reversal cancel updates both reference and id, skipping already-cancelled rows', () => {
    assert.match(DAMAGE_RECORD_CANCEL_SQL, /WHERE \(damage_reference = \$1 OR id = \$2\) AND status <> 'CANCELLED'/);
    assert.match(DAMAGE_RECORD_CANCEL_SQL, /notes = COALESCE\(notes, ''\) \|\| ' \| REVERSED \(' \|\| \$3 \|\| '\) by ' \|\| \$4/);
  });
});

describe('fixed assets', () => {
  test('buildAssetListQuery orders by created_at DESC and filters branches', () => {
    const { sql, params } = buildAssetListQuery('WH001');
    assert.match(sql, / FROM fixed_assets WHERE branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['WH001']);
    assert.ok(!buildAssetListQuery('ALL').sql.includes(' WHERE '));
  });

  test('upsert passes 21 binds and refreshes the documented columns on conflict', () => {
    assert.equal(maxPlaceholder(ASSET_UPSERT_SQL), 21);
    for (const col of ['tag_number', 'acquisition_cost', 'net_book_value', 'status', 'placed_in_service_date_ad']) {
      assert.ok(ASSET_UPSERT_SQL.includes(`${col} = EXCLUDED.${col}`), `missing conflict update for ${col}`);
    }
    // accumulated_depreciation is intentionally NOT refreshed on conflict.
    assert.ok(!ASSET_UPSERT_SQL.includes('accumulated_depreciation = EXCLUDED'));
    assert.deepEqual(assetUpsertParams({ id: 'a1', tagNumber: 'T-1', name: 'N', category: 'IT', branchId: 'WH001' }), [
      'a1', 'T-1', 'N', 'IT', 'WH001', undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  test('status update is a narrow id-scoped statement', () => {
    assert.equal(ASSET_SET_STATUS_SQL, 'UPDATE fixed_assets SET status = $1 WHERE id = $2');
  });
});

describe('stock operations', () => {
  test('list query also surfaces operations destined for the branch warehouse', () => {
    const { sql, params } = buildStockOperationListQuery('BR02');
    assert.match(sql, / WHERE branch_id = \$1 OR destination_warehouse_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['BR02']);
    assert.ok(!buildStockOperationListQuery('ALL').sql.includes(' WHERE '));
  });

  test('insert takes 20 binds and upserts only status + items on conflict', () => {
    assert.equal(maxPlaceholder(STOCK_OPERATION_INSERT_SQL), 20);
    assert.match(STOCK_OPERATION_INSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET\s*\n\s*status = EXCLUDED\.status,\s*\n\s*items = EXCLUDED\.items;/);
    const params = stockOperationInsertParams(
      { id: 'op-1', referenceNumber: 'DMG-1', branchName: 'HQ', destinationWarehouseId: 'WH001', destinationWarehouseName: 'HQ', dateAD: '2026-09-22', dateBS: '2083-04-22 BS', fiscalYear: '2083-84', status: 'LOGGED' },
      'DAMAGE', 500, '[]'
    );
    assert.equal(params[2], 'DAMAGE');
    assert.equal(params[12], 500);
    assert.equal(params[19], '[]');
  });

  test('apply variants guard on availability and stamp last_updated', () => {
    for (const sql of [STOCK_DAMAGE_APPLY_SQL, STOCK_RELEASE_DAMAGED_SQL, STOCK_CONSUME_QOH_SQL, STOCK_REVERSE_DAMAGE_SQL]) {
      assert.match(sql, /AND (quantity_on_hand|damaged_qty) >= \$1;/);
      assert.match(sql, /last_updated = CURRENT_TIMESTAMP/);
      assert.equal(maxPlaceholder(sql), 3);
    }
    assert.match(STOCK_DAMAGE_APPLY_SQL, /quantity_on_hand = quantity_on_hand - \$1, damaged_qty = damaged_qty \+ \$1/);
    assert.match(STOCK_REVERSE_DAMAGE_SQL, /quantity_on_hand = quantity_on_hand \+ \$1, damaged_qty = damaged_qty - \$1/);
  });

  test('cancel stamps updated_by/updated_at; receive locks the row FOR UPDATE', () => {
    assert.match(STOCK_OPERATION_CANCEL_SQL, /SET status = 'CANCELLED', updated_by = \$1, updated_at = CURRENT_TIMESTAMP WHERE id = \$2;/);
    assert.match(STOCK_OPERATION_FIND_FOR_RECEIVE_SQL, / WHERE id = \$1 FOR UPDATE$/);
    assert.ok(STOCK_OPERATION_FIND_FOR_RECEIVE_SQL.includes('"destinationWarehouseId"'));
    assert.equal(STOCK_OPERATION_SET_STATUS_SQL, 'UPDATE stock_operations SET status = $1 WHERE id = $2');
  });

  test('receive upsert settles incoming units keyed on (product, branch)', () => {
    assert.match(PULLOUT_RECEIVE_STOCK_SQL, /ON CONFLICT \(product_id, branch_id\) DO UPDATE SET\s*\n\s*quantity_on_hand = inventory_stock\.quantity_on_hand \+ \$4/);
    assert.equal(maxPlaceholder(PULLOUT_RECEIVE_STOCK_SQL), 4);
    assert.deepEqual(
      pulloutReceiveStockParams('WH001', { productId: 'p9', quantity: '2' }),
      ['stk-wh001-p9', 'p9', 'WH001', 2]
    );
    assert.equal(pulloutReceiveStockParams('WH001', { productId: 'p9' })[3], 1);
  });
});

describe('customer devices (CPE)', () => {
  test('list query searches six columns case-insensitively', () => {
    const { sql, params } = buildCustomerDeviceListQuery('BR01', 'FIBER');
    assert.match(sql, / WHERE branch_id = \$1 AND \(LOWER\(device_serial\) LIKE \$2/);
    assert.match(sql, / ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['BR01', '%fiber%']);
    assert.ok(!buildCustomerDeviceListQuery().sql.includes(' WHERE '));
  });

  test('duplicate probe is case/trim-insensitive and excludes the record itself', () => {
    assert.match(CDR_DUPLICATE_CHECK_SQL, /WHERE id <> \$1 AND \(UPPER\(TRIM\(device_serial\)\) = \$2 OR UPPER\(TRIM\(pon_serial\)\) = \$3\) LIMIT 1/);
  });

  test('narrow lookup omits contact/address columns; status update is narrow', () => {
    assert.match(CDR_FIND_NARROW_SQL, / FROM customer_device_records WHERE id = \$1$/);
    assert.ok(!CDR_FIND_NARROW_SQL.includes('contact_phone'));
    assert.equal(CDR_UPDATE_STATUS_SQL, 'UPDATE customer_device_records SET status = $1 WHERE id = $2');
  });

  test('shared insert builder fills 16 columns with documented defaults', () => {
    const rec = {
      id: 'cust-1', customerId: 'CUS-1', customerName: 'Ram', customerCode: 'CUS-1',
      branchId: 'BR01', productName: 'ONU', deviceSerial: 'SN1', status: 'RENTAL',
      issuedDateAD: '2026-09-22', issuedDateBS: '2083-04-22 BS',
    } as any;
    assert.deepEqual(customerDeviceInsertParams(rec), [
      'cust-1', 'CUS-1', 'Ram', 'CUS-1', '', '', 'BR01', 'ONU', 'SN1', 'SN1', null,
      'RENTAL', '2026-09-22', '2083-04-22 BS', null, '',
    ]);
    assert.equal(maxPlaceholder(CDR_UPSERT_SQL), 16);
    assert.equal(maxPlaceholder(CDR_EXCHANGE_INSERT_SQL), 16);
    assert.match(CDR_UPSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET\s*\n\s*status = EXCLUDED\.status,\s*\n\s*branch_id = EXCLUDED\.branch_id,\s*\n\s*notes = EXCLUDED\.notes;/);
    assert.ok(!CDR_EXCHANGE_INSERT_SQL.includes('ON CONFLICT'));
  });

  test('assignment stock update returns the new quantity and guards availability', () => {
    assert.match(CDR_ASSIGNMENT_STOCK_SQL, /quantity_on_hand >= \$4\s*\n\s*RETURNING quantity_on_hand/);
    assert.deepEqual(cdrAssignmentStockParams(1, 'p1', 'WH001', 1), [1, 'p1', 'WH001', 1]);
    assert.deepEqual(cdrAssignmentStockParams(-1, 'p1', 'WH001', 0), [-1, 'p1', 'WH001', 0]);
  });

  test('customer counter upserts GREATEST(0, count + delta) on customer_id conflict', () => {
    assert.match(CDR_CUSTOMER_COUNT_UPSERT_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, 'ACTIVE', \$8\)/);
    assert.match(CDR_CUSTOMER_COUNT_UPSERT_SQL, /ON CONFLICT \(customer_id\) DO UPDATE SET\s*\n\s*assigned_devices_count = GREATEST\(0, customer_records\.assigned_devices_count \+ \$8\);/);
    assert.deepEqual(
      customerCountUpsertParams({
        id: 'CUS-1', customerId: 'CUS-1', customerName: 'Ram', username: 'ram',
        contactPhone: '9800000000', branchId: 'WH001', installationAddress: 'Nepal', countDelta: 1,
      }),
      ['CUS-1', 'CUS-1', 'Ram', 'ram', '9800000000', 'WH001', 'Nepal', 1]
    );
  });
});

describe('serial lookup (three-statement resolution)', () => {
  test('builds three statements sharing one param list: register, assignments, assets', () => {
    const { params, serialLogSql, customerDeviceSql, fixedAssetSql } = buildSerialLookupSql('SN-1', []);
    assert.deepEqual(params, ['SN-1']);
    assert.match(serialLogSql, /FROM serial_log[\s\S]*LIMIT 1$/);
    assert.match(customerDeviceSql, /FROM customer_device_records[\s\S]*LIMIT 1$/);
    assert.match(fixedAssetSql, /FROM fixed_assets[\s\S]*WHERE lower\(trim\(tag_number\)\) = lower\(trim\(\$1\)\)\s*\n\s*LIMIT 1$/);
    for (const sql of [serialLogSql, customerDeviceSql]) {
      assert.match(sql, /lower\(trim\(device_serial\)\) = lower\(trim\(\$1\)\)[\s\S]*lower\(trim\(pon_serial\)\) = lower\(trim\(\$1\)\)[\s\S]*lower\(trim\(mac_address\)\) = lower\(trim\(\$1\)\)/);
    }
  });

  test('excluded values add lower(trim()) NOT-IN clauses from $2 onward', () => {
    const { params, serialLogSql, fixedAssetSql } = buildSerialLookupSql('SN-1', ['OLD-A', 'OLD-B']);
    assert.deepEqual(params, ['SN-1', 'OLD-A', 'OLD-B']);
    assert.match(serialLogSql, /AND NOT \(\s*lower\(trim\(device_serial\)\) IN \(lower\(trim\(\$2\)\), lower\(trim\(\$3\)\)\) OR\s*lower\(trim\(pon_serial\)\) IN \(lower\(trim\(\$2\)\), lower\(trim\(\$3\)\)\) OR\s*lower\(trim\(mac_address\)\) IN \(lower\(trim\(\$2\)\), lower\(trim\(\$3\)\)\)\)/);
    // Assets only carry tag_number, so the exclusion clause is tag-only.
    assert.match(fixedAssetSql, /AND NOT \(lower\(trim\(tag_number\)\) IN \(lower\(trim\(\$2\)\), lower\(trim\(\$3\)\)\)\)/);
    assert.ok(!fixedAssetSql.includes('pon_serial'));
  });
});

describe('serial log register', () => {
  test('branch scope emits an IN-list; global branch emits equality; status/query follow', () => {
    const { sql, params } = buildSerialLogQuery({
      branchScope: ['WH001', 'BR01'],
      status: 'DAMAGED',
      query: 'onu',
    });
    assert.match(sql, /WHERE 1=1 AND branch_id IN \(\$1, \$2\) AND status = \$3 AND \(LOWER\(device_serial\) LIKE \$4/);
    assert.match(sql, / ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['WH001', 'BR01', 'DAMAGED', '%onu%']);
  });

  test('global admin branch filter lands at $1 with no scope list', () => {
    const { sql, params } = buildSerialLogQuery({ globalBranchId: 'WH001' });
    assert.match(sql, /WHERE 1=1 AND branch_id = \$1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, ['WH001']);
  });

  test('ALL filters and non-string queries are ignored', () => {
    const { sql, params } = buildSerialLogQuery({ globalBranchId: 'ALL', status: 'ALL', query: 42 as unknown as string });
    assert.match(sql, /WHERE 1=1 ORDER BY created_at DESC$/);
    assert.deepEqual(params, []);
  });

  test('upsert probe matches lower(trim(device_serial)) for one-row-per-serial semantics', () => {
    assert.equal(
      SERIAL_LOG_FIND_BY_DEVICE_SQL,
      'SELECT id, history_json FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1))'
    );
  });

  test('update COALESCEs optional columns and takes 13 binds with id last', () => {
    assert.match(SERIAL_LOG_UPDATE_SQL, /pon_serial = COALESCE\(\$1, pon_serial\)/);
    assert.match(SERIAL_LOG_UPDATE_SQL, /history_json = \$11, updated_at = \$12 WHERE id = \$13/);
    assert.deepEqual(
      serialLogUpdateParams({
        ponSerial: null, macAddress: 'AA', productId: null, productName: null,
        branchId: null, customerId: null, customerName: null, status: 'IN_STOCK',
        sourceType: 'PURCHASE', sourceId: null, historyJson: '[]', updatedAt: 'now', id: 'sl-1',
      }),
      [null, 'AA', null, null, null, null, null, 'IN_STOCK', 'PURCHASE', null, '[]', 'now', 'sl-1']
    );
  });

  test('insert writes 15 binds with is_demo pinned FALSE in SQL', () => {
    assert.match(SERIAL_LOG_INSERT_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14, \$15, FALSE\)/);
    assert.deepEqual(
      serialLogInsertParams({
        id: 'sl-1', deviceSerial: 'SN', ponSerial: null, macAddress: null, productId: null,
        productName: null, branchId: null, customerId: null, customerName: null,
        status: 'IN_STOCK', sourceType: 'PURCHASE', sourceId: null, historyJson: '[]', timestamp: 'now',
      }),
      ['sl-1', 'SN', null, null, null, null, null, null, null, 'IN_STOCK', 'PURCHASE', null, '[]', 'now', 'now']
    );
  });
});
