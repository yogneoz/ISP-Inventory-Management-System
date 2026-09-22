/**
 * Unit tests for the misc repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DB_STATUS_PROBE_SQL,
  buildAuditTrailQuery,
  buildTransactionLogQuery,
  buildApprovalRequestQuery,
  AR_INSERT_SQL,
  arInsertParams,
  AR_FIND_BY_ID_SQL,
  AR_SELECT_PREFIX_SHORT,
  AR_FIND_BY_ANY_ID_SQL,
  AR_CLOSE_OUT_SQL,
  arCloseOutParams,
  AR_APPROVE_SQL,
  AR_SHIPMENT_CANCEL_SQL,
  AR_SHIPMENT_RESTORE_SOURCE_SQL,
  AR_SHIPMENT_RELEASE_DEST_SQL,
  CDR_SET_STATUS_SQL,
  MISC_PULLOUT_STOCK_UPSERT_SQL,
  miscPulloutStockParams,
  MISC_PULLOUT_TXN_SQL,
  miscPulloutTxnParams,
  AUDIT_RECONCILE_STOCK_SQL,
  auditReconcileStockParams,
} from '../server/src/models/misc.repo';
import { SHIPMENT_CANCEL_RESTORE_SOURCE_SQL, SHIPMENT_CANCEL_RELEASE_DEST_SQL } from '../server/src/models/shipments.repo';
import type { ApprovalRequest, TransactionLog } from '../client/src/types';

/** Max placeholder index used by a SQL string, e.g. $7 → 7. */
function maxPlaceholder(sql: string): number {
  const matches = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return matches.length ? Math.max(...matches) : 0;
}

const baseApproval: ApprovalRequest = {
  id: 'apr-1',
  requestNumber: 'APR-2083-001',
  type: 'CUSTOMER_DEVICE_STATUS',
  targetId: '',
  customerName: '',
  deviceSerial: '',
  productName: '',
  currentStatus: '',
  requestedStatus: '',
  requestedByRole: 'SUPER_ADMIN',
  requestedByEmail: '',
  requestedByName: '',
  branchId: '',
  reason: '',
  status: 'PENDING',
  requestedAtAD: '',
  requestedAtBS: '',
};

describe('buildAuditTrailQuery', () => {
  test('unfiltered + limited SQL and param ordering', () => {
    const { sql, params } = buildAuditTrailQuery('ALL', 50);
    assert.match(sql, / FROM audit_logs ORDER BY timestamp_ad DESC LIMIT \$1$/);
    assert.ok(!sql.includes(' WHERE '));
    assert.deepEqual(params, [50]);
  });

  test('branch filter uses $1 and pushes limit to $2', () => {
    const { sql, params } = buildAuditTrailQuery('BR02', '25');
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY timestamp_ad DESC LIMIT \$2$/);
    assert.deepEqual(params, ['BR02', 25]);
  });

  test('no params without branch or limit', () => {
    const { sql, params } = buildAuditTrailQuery();
    assert.match(sql, / FROM audit_logs ORDER BY timestamp_ad DESC$/);
    assert.deepEqual(params, []);
  });
});

describe('buildTransactionLogQuery', () => {
  test('combines branch and product filters in order', () => {
    const { sql, params } = buildTransactionLogQuery('BR01', 'p1', 10);
    assert.match(sql, / WHERE branch_id = \$1 AND product_id = \$2 ORDER BY timestamp_ad DESC LIMIT \$3$/);
    assert.deepEqual(params, ['BR01', 'p1', 10]);
  });

  test('ALL filters are ignored; limit still lands last', () => {
    const { sql, params } = buildTransactionLogQuery('ALL', 'ALL', 5);
    assert.ok(!sql.includes(' WHERE '));
    assert.match(sql, / ORDER BY timestamp_ad DESC LIMIT \$1$/);
    assert.deepEqual(params, [5]);
  });

  test('selects the aliased log columns', () => {
    const { sql } = buildTransactionLogQuery();
    for (const alias of ['"transactionNumber"', '"quantityBefore"', '"timestampBS"']) {
      assert.ok(sql.includes(alias), `missing ${alias}`);
    }
  });
});

describe('buildApprovalRequestQuery', () => {
  test('filters by branch and string status; orders by requested_at_ad DESC', () => {
    const { sql, params } = buildApprovalRequestQuery('BR03', 'PENDING');
    assert.match(sql, / WHERE branch_id = \$1 AND status = \$2 ORDER BY requested_at_ad DESC$/);
    assert.deepEqual(params, ['BR03', 'PENDING']);
  });

  test('non-string status values are ignored', () => {
    const { sql, params } = buildApprovalRequestQuery('ALL', 42 as unknown as string);
    assert.ok(!sql.includes(' WHERE '));
    assert.deepEqual(params, []);
  });
});

describe('arInsertParams', () => {
  test('fills all 20 columns with documented defaults', () => {
    const params = arInsertParams(baseApproval);
    assert.equal(params.length, 20);
    assert.deepEqual(params, [
      'apr-1', 'APR-2083-001', 'CUSTOMER_DEVICE_STATUS',
      null,            // targetId '' → null
      '', '', '', '',  // customer/customerCode/device/pon
      '',              // productName
      'ACTIVE',        // currentStatus '' → 'ACTIVE'
      '',              // requestedStatus
      'SUPER_ADMIN',   // requestedByRole passed through
      '', '',          // byEmail, byName
      null,            // branchId '' → null
      '',              // branchName
      '',              // reason
      false,           // restockQtyOnApproval
      'PENDING',       // status literal
      '',              // requestedAtBS passed through (fixture is empty)
    ]);
  });

  test('keeps provided values and coerces restock flag to boolean', () => {
    const params = arInsertParams({
      ...baseApproval,
      targetId: 'cdr-9',
      currentStatus: 'ACTIVE',
      branchId: 'BR01',
      restockQtyOnApproval: true,
      requestedAtBS: '2083-04-22 BS',
    });
    assert.equal(params[3], 'cdr-9');
    assert.equal(params[9], 'ACTIVE');
    assert.equal(params[14], 'BR01');
    assert.equal(params[17], true);
    assert.equal(params[18], 'PENDING');
    assert.equal(params[19], '2083-04-22 BS');
  });

  test('AR_INSERT_SQL placeholder count matches the param list', () => {
    assert.equal(maxPlaceholder(AR_INSERT_SQL), arInsertParams(baseApproval).length);
  });
});

describe('approval lookups', () => {
  test('AR_FIND_BY_ID_SQL is the short column set scoped by id', () => {
    assert.ok(AR_FIND_BY_ID_SQL.startsWith(AR_SELECT_PREFIX_SHORT));
    assert.match(AR_FIND_BY_ID_SQL, / WHERE id = \$1$/);
    assert.ok(AR_FIND_BY_ID_SQL.includes('"requestedStatus"'));
    assert.ok(!AR_FIND_BY_ID_SQL.includes('"processedByEmail"'));
  });

  test('AR_FIND_BY_ANY_ID_SQL selects every column', () => {
    assert.equal(AR_FIND_BY_ANY_ID_SQL, 'SELECT * FROM approval_requests WHERE id = $1');
  });
});

describe('arCloseOutParams', () => {
  test('7 params with id last; missing rejection reason becomes null', () => {
    const params = arCloseOutParams({ ...baseApproval, status: 'REJECTED' });
    assert.equal(params.length, 7);
    assert.equal(params[0], 'REJECTED');
    assert.equal(params[5], null);
    assert.equal(params[6], 'apr-1');
  });

  test('keeps a provided rejection reason and processedAtBS', () => {
    const params = arCloseOutParams({
      ...baseApproval,
      status: 'CANCELLED',
      processedAtBS: '2083-04-22 BS',
      rejectionReason: 'wrong entry',
    });
    assert.equal(params[4], '2083-04-22 BS');
    assert.equal(params[5], 'wrong entry');
  });

  test('close-out SQL takes 7 placeholders, approve SQL 6', () => {
    assert.equal(maxPlaceholder(AR_CLOSE_OUT_SQL), 7);
    assert.equal(maxPlaceholder(AR_APPROVE_SQL), 6);
    assert.ok(AR_CLOSE_OUT_SQL.includes('rejection_reason = $6'));
    assert.ok(!AR_APPROVE_SQL.includes('rejection_reason'));
  });
});

describe('misc.repo SQL constants', () => {
  test('DB_STATUS_PROBE_SQL reports database, version and public table count', () => {
    assert.match(DB_STATUS_PROBE_SQL, /SELECT current_database\(\), version\(\)/);
    assert.match(DB_STATUS_PROBE_SQL, /information_schema\.tables WHERE table_schema = 'public'/);
  });

  test('CDR_SET_STATUS_SQL matches by id or device serial', () => {
    assert.equal(
      CDR_SET_STATUS_SQL,
      'UPDATE customer_device_records SET status = $1 WHERE id = $2 OR device_serial = $3'
    );
  });

  test('AR_SHIPMENT_CANCEL_SQL is the narrow id-scoped cancel', () => {
    assert.equal(AR_SHIPMENT_CANCEL_SQL, 'UPDATE shipments SET status = $1, notes = $2 WHERE id = $3');
  });

  test('approval cancel stock SQL is consistent with the shipments repo', () => {
    assert.equal(AR_SHIPMENT_RESTORE_SOURCE_SQL, SHIPMENT_CANCEL_RESTORE_SOURCE_SQL);
    assert.equal(AR_SHIPMENT_RELEASE_DEST_SQL, SHIPMENT_CANCEL_RELEASE_DEST_SQL);
  });

  test('pull-out upsert adds exactly one unit on conflict', () => {
    assert.match(MISC_PULLOUT_STOCK_UPSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET quantity_on_hand = inventory_stock\.quantity_on_hand \+ 1/);
    assert.equal(maxPlaceholder(MISC_PULLOUT_STOCK_UPSERT_SQL), 7);
  });

  test('pull-out txn insert stamps timestamp_ad server-side', () => {
    assert.match(MISC_PULLOUT_TXN_SQL, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, NOW\(\), \$13\)/);
    assert.equal(maxPlaceholder(MISC_PULLOUT_TXN_SQL), 13);
  });

  test('audit reconcile sets the absolute counted quantity', () => {
    assert.match(AUDIT_RECONCILE_STOCK_SQL, /ON CONFLICT \(id\) DO UPDATE SET quantity_on_hand = EXCLUDED\.quantity_on_hand/);
    assert.equal(maxPlaceholder(AUDIT_RECONCILE_STOCK_SQL), 4);
  });
});

describe('miscPulloutStockParams', () => {
  test('deterministic row with quantity defaults for optional counters', () => {
    assert.deepEqual(
      miscPulloutStockParams({ id: 'stk-wh001-p1', productId: 'p1', branchId: 'WH001', quantityOnHand: 3, reservedQty: 0, incomingQty: 0, lastUpdated: '' }),
      ['stk-wh001-p1', 'p1', 'WH001', 3, 0, 0, 0]
    );
  });

  test('provided damaged/reserved/incoming pass through', () => {
    const params = miscPulloutStockParams({
      id: 'x', productId: 'p', branchId: 'B', quantityOnHand: 1,
      damagedQty: 2, reservedQty: 3, incomingQty: 4, lastUpdated: '',
    });
    assert.deepEqual(params.slice(4), [2, 3, 4]);
  });
});

describe('miscPulloutTxnParams', () => {
  const txn: TransactionLog = {
    id: 'txn-1',
    transactionNumber: 'TXN-12345',
    productId: 'p1',
    productSku: 'SKU-1',
    productName: 'ONU',
    branchId: 'WH001',
    changeType: 'PULLOUT',
    quantityBefore: 4,
    quantityChanged: 1,
    quantityAfter: 5,
    unitCost: 3500,
    referenceDocId: 'APR-2083-001',
    timestampAD: '2026-09-22T00:00:00.000Z',
    timestampBS: '2083-04-22 BS',
  };

  test('13 params: log fields then timestampBS last (timestamp_ad is NOW() server-side)', () => {
    const params = miscPulloutTxnParams(txn);
    assert.equal(params.length, 13);
    assert.deepEqual(params.slice(0, 10), [
      'txn-1', 'TXN-12345', 'p1', 'SKU-1', 'ONU', 'WH001', 'PULLOUT', 4, 1, 5,
    ]);
    assert.equal(params[10], 3500);
    assert.equal(params[11], 'APR-2083-001');
    assert.equal(params[12], '2083-04-22 BS');
  });

  test('optional referenceDocId may be undefined', () => {
    const params = miscPulloutTxnParams({ ...txn, referenceDocId: undefined });
    assert.equal(params[11], undefined);
  });
});

describe('auditReconcileStockParams', () => {
  test('builds deterministic stock id and coerces counted quantity', () => {
    assert.deepEqual(
      auditReconcileStockParams('WH001', { productId: 'p1', countedQty: '7' }),
      ['stk-wh001-p1', 'p1', 'WH001', 7]
    );
  });

  test('missing counted quantity reconciles to zero', () => {
    assert.equal(auditReconcileStockParams('WH001', { productId: 'p1' })[3], 0);
  });

  test('lowercases the branch segment of the stock id', () => {
    assert.equal(auditReconcileStockParams('BR-X1', { productId: 'p2' })[0], 'stk-br-x1-p2');
  });
});
