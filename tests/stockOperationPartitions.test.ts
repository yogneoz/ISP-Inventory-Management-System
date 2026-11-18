/**
 * SCALE-3 — `stock_operations` is monthly-partitioned with a registry-backed
 * business key.
 *
 * The table is the operational register: every pullout, damage report, disposal,
 * stock-out and consumable issue is a row here, and the screens read it branch-
 * and month-scoped. Migration 0035 converts it to RANGE partitions by `date_ad`
 * and moves `reference_number`'s global uniqueness to
 * `document_identity_registry`, because a partitioned unique constraint must
 * contain the partition key.
 *
 * PROVES, against a real PostgreSQL when one is reachable:
 *   1. the parent is partitioned by `date_ad`, the primary key carries the
 *      partition key, and no unique constraint claims `reference_number` alone;
 *   2. every existing row has its key registered, so the conversion did not
 *      detach identity from the data;
 *   3. a one-month read prunes to that month's child and never reads DEFAULT;
 *   4. the duplicate-reference write path still rejects a second document with
 *      the same reference (the old UNIQUE column's exact behaviour);
 *   5. the `ON CONFLICT (id, date_ad)` upsert the write path uses updates in
 *      place instead of duplicating, and the identity trigger permits the
 *      re-send;
 *   6. a date edit or a reference edit is refused — a row must never be
 *      silently reparented into another month;
 *   7. the retention path is viable: deleting a month's rows releases their
 *      registry keys and the child can be detached.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  describeStockOperationPartitions,
  provisionStockOperationPartitions,
  stockOperationPartitionStatus,
} from '../server/src/boot/stockOperationPartitions';
import { STOCK_OPERATION_INSERT_SQL, stockOperationInsertParams } from '../server/src/models/inventory.repo';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (partition DDL)';

/** A month no fixture data uses, so the test can create and drop it safely. */
const TEST_MONTH = '2033-05';
const TEST_KEY = '203305';
const PREFIX = 'sop-scale3-';

function opRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `${PREFIX}${Math.random().toString(36).slice(2, 10)}`,
    referenceNumber: `${PREFIX}REF-${Math.random().toString(36).slice(2, 8)}`,
    type: 'MANUAL_ADJUSTMENT',
    branchId: null,
    destinationWarehouseId: null,
    dateAD: `${TEST_MONTH}-12`,
    dateBS: '2090-01-29 BS',
    reason: 'SCALE-3 partition fixture',
    status: 'LOGGED',
    ...overrides,
  };
}

async function insertOp(row: ReturnType<typeof opRow>) {
  return pool!.query(
    STOCK_OPERATION_INSERT_SQL,
    stockOperationInsertParams({ ...row, fiscalYear: null } as any, row.type as string, 0, '[]')
  );
}

async function dropTestMonth() {
  if (!pool || !dbReachable) return;
  await pool.query(`DELETE FROM stock_operations WHERE date_ad >= DATE '${TEST_MONTH}-01' AND date_ad < DATE '2033-06-01'`).catch(() => undefined);
  await pool.query(`DROP TABLE IF EXISTS stock_operations_${TEST_KEY}`).catch(() => undefined);
}

describe('stock operation partitions', () => {
  after(async () => {
    await dropTestMonth();
    if (pool && dbReachable) await pool.end();
  });

  test('the parent is partitioned by the operation date and the key is registry-backed', { skip: skipNoDb }, async () => {
    const kind = await pool!.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'stock_operations'`
    );
    assert.equal(kind.rows[0]?.relkind, 'p', 'stock_operations must be a partitioned parent');

    const pk = await pool!.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'stock_operations'::regclass AND contype = 'p'`
    );
    assert.match(pk.rows[0].def, /PRIMARY KEY \(id, date_ad\)/, 'the partition key must be in the primary key');

    const referenceUnique = await pool!.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'stock_operations'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE '%reference_number%'`
    );
    assert.equal(referenceUnique.rows.length, 0, 'a partitioned unique constraint cannot carry the business key alone');

    const registryUnique = await pool!.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'document_identity_registry'::regclass AND contype = 'u'`
    );
    assert.ok(
      registryUnique.rows.some((row: any) => /document_type, business_key/.test(row.def)),
      'the registry holds the global uniqueness'
    );

    // The conversion registered every legacy row: identity is not detachable
    // from the data it describes.
    const parity = await pool!.query(
      `SELECT (SELECT count(*)::int FROM stock_operations) AS ops,
              (SELECT count(*)::int FROM document_identity_registry WHERE document_type = 'STOCK_OPERATION') AS keys,
              (SELECT count(*)::int FROM stock_operations o
                 WHERE NOT EXISTS (SELECT 1 FROM document_identity_registry r
                                    WHERE r.document_type = 'STOCK_OPERATION' AND r.id = o.id)) AS unregistered`
    );
    assert.equal(parity.rows[0].unregistered, 0, 'every stock operation must carry a registry key');
    assert.equal(parity.rows[0].keys, parity.rows[0].ops, 'one registry key per operation');
  });

  test('a one-month read prunes to that month and never touches DEFAULT', { skip: skipNoDb }, async () => {
    const monthRow = await pool!.query(
      `SELECT to_char(date_ad, 'YYYY-MM') AS ym FROM stock_operations ORDER BY date_ad DESC LIMIT 1`
    );
    assert.ok(monthRow.rows.length > 0, 'the fixture database holds stock operations');
    const month = String(monthRow.rows[0].ym);
    const start = `${month}-01`;
    const boundary = new Date(`${start}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    const next = boundary.toISOString().slice(0, 10);

    await pool!.query('BEGIN');
    try {
      await pool!.query('SET LOCAL enable_seqscan = off');
      const plan = await pool!.query(
        `EXPLAIN (COSTS OFF) SELECT sum(total_value) FROM stock_operations
          WHERE date_ad >= DATE '${start}' AND date_ad < DATE '${next}'`
      );
      const text = plan.rows.map((row: any) => Object.values(row)[0]).join('\n');
      const touched = [...new Set(text.match(/stock_operations_[0-9]{6}/g) || [])];
      assert.deepEqual(touched, [`stock_operations_${month.replace('-', '')}`], `one month, one child:\n${text}`);
      assert.doesNotMatch(text, /stock_operations_default/, 'the catch-all is never read for a dated month');
    } finally {
      await pool!.query('ROLLBACK');
    }
  });

  test('the duplicate-reference write path still rejects a second document', { skip: skipNoDb }, async () => {
    await dropTestMonth();
    await pool!.query('SELECT ensure_stock_operation_month_partition($1::date)', [`${TEST_MONTH}-01`]);
    const first = opRow({ referenceNumber: `${PREFIX}KEEP-1` });
    try {
      await insertOp(first);
      const second = opRow({ referenceNumber: `${PREFIX}KEEP-1` });
      await assert.rejects(insertOp(second), /duplicate key value/, 'a reused reference must be refused');
      const rows = await pool!.query('SELECT count(*)::int AS n FROM stock_operations WHERE reference_number = $1', [
        `${PREFIX}KEEP-1`,
      ]);
      assert.equal(rows.rows[0].n, 1, 'the first document keeps the reference');
    } finally {
      await dropTestMonth();
    }
  });

  test('the upsert updates in place, and an identity edit is refused', { skip: skipNoDb }, async () => {
    await dropTestMonth();
    await pool!.query('SELECT ensure_stock_operation_month_partition($1::date)', [`${TEST_MONTH}-01`]);
    const row = opRow({ referenceNumber: `${PREFIX}UPSERT-1` });
    try {
      await insertOp(row);
      // The write path re-sends the same id (status/items sync). It must update,
      // not duplicate, and the identity trigger must allow the re-send.
      await insertOp({ ...row, status: 'DISPATCHED' });
      const rows = await pool!.query(
        'SELECT status, count(*)::int AS n FROM stock_operations WHERE id = $1 GROUP BY status',
        [row.id]
      );
      assert.equal(rows.rows.length, 1, 'the re-send must not insert a second row');
      assert.equal(rows.rows[0].status, 'DISPATCHED', 'the upsert applies the new status');
      assert.equal(rows.rows[0].n, 1);

      await assert.rejects(
        pool!.query(`UPDATE stock_operations SET date_ad = DATE '2033-06-01' WHERE id = $1`, [row.id]),
        /cannot move to another date_ad/,
        'a row must never be reparented into another month'
      );
      await assert.rejects(
        pool!.query(`UPDATE stock_operations SET reference_number = $1 WHERE id = $2`, [`${PREFIX}OTHER-1`, row.id]),
        /cannot change its reference_number/,
        'the registered business key is immutable'
      );
      const untouched = await pool!.query(
        `SELECT to_char(date_ad, 'YYYY-MM-DD') AS d, reference_number FROM stock_operations WHERE id = $1`,
        [row.id]
      );
      assert.equal(untouched.rows[0].d, row.dateAD, 'the refused edits changed nothing');
      assert.equal(untouched.rows[0].reference_number, row.referenceNumber);
    } finally {
      await dropTestMonth();
    }
  });

  test('a month can be emptied and detached, releasing its registry keys', { skip: skipNoDb }, async () => {
    await dropTestMonth();
    await pool!.query('SELECT ensure_stock_operation_month_partition($1::date)', [`${TEST_MONTH}-01`]);
    const row = opRow({ referenceNumber: `${PREFIX}RETIRE-1` });
    try {
      await insertOp(row);
      const registered = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry WHERE document_type = 'STOCK_OPERATION' AND id = $1`,
        [row.id]
      );
      assert.equal(registered.rows[0].n, 1, 'the row is registered while it exists');

      await pool!.query(`DELETE FROM stock_operations_${TEST_KEY}`);
      const released = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry WHERE document_type = 'STOCK_OPERATION' AND id = $1`,
        [row.id]
      );
      assert.equal(released.rows[0].n, 0, 'deleting the month releases its keys');

      // Detach is what retention actually does; it must not be blocked by the
      // registry or by an FK.
      await pool!.query(`DROP TABLE stock_operations_${TEST_KEY}`);
      const gone = await pool!.query('SELECT to_regclass($1) AS reg', [`stock_operations_${TEST_KEY}`]);
      assert.equal(gone.rows[0].reg, null, 'the month child is gone');
    } finally {
      await dropTestMonth();
    }
  });

  test('provisioning is idempotent and the DEFAULT child is reported', { skip: skipNoDb }, async () => {
    const now = new Date('2033-05-15T00:00:00Z');
    const report = await provisionStockOperationPartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
    try {
      assert.deepEqual(report.created, ['203305', '203306'], 'the missing months are created');
      assert.deepEqual(report.missing, [], 'no gap remains in the window');
      assert.match(describeStockOperationPartitions(report), /stock_operations|window 203305/);
      const again = await provisionStockOperationPartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.deepEqual(again.created, [], 'a second run is a no-op');
      const status = await stockOperationPartitionStatus(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.equal(typeof status.defaultRows, 'number', 'the DEFAULT child is counted');
      assert.ok(
        status.children.some((child) => child.name === `stock_operations_${TEST_KEY}`),
        'the provisioned month is reported as a child'
      );
      // Other fixtures may write outside the provisioned window; what this test
      // owns is that its own month never falls through to the catch-all and
      // that the catch-all is counted, not ignored.
      const ownMonthDefault = await pool!.query(
        `SELECT count(*)::int AS n FROM stock_operations_default
          WHERE date_ad >= DATE '2033-05-01' AND date_ad < DATE '2033-06-01'`
      );
      assert.equal(ownMonthDefault.rows[0].n, 0, 'a provisioned month never falls through to DEFAULT');
    } finally {
      await pool!.query('DROP TABLE IF EXISTS stock_operations_203306').catch(() => undefined);
      await dropTestMonth();
    }
  });
});
