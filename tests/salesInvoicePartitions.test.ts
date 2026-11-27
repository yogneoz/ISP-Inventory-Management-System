/**
 * SCALE-3 — `sales_invoices` is monthly-partitioned with its invoice number in
 * the document identity registry and its three inbound keys anchored there too.
 *
 * The sales register is read month- and branch-scoped, and a closed year has to
 * be prunable, so migration 0039 converts it to RANGE partitions by
 * `invoice_date_ad` with a DEFAULT catch-all — the same shape as
 * stock_operations and serial_log.
 *
 * It is the one conversion with inbound foreign keys:
 *   sales_returns.original_invoice_id          (SET NULL)
 *   customer_payments.invoice_id               (SET NULL)
 *   customer_payment_allocations.invoice_id    (RESTRICT)
 * A foreign key cannot reference `(id)` once the primary key carries the
 * partition key, so the children gained `document_type`/`key_role` columns that
 * default to the invoice's PRIMARY registry row and point at
 * `document_identity_registry (document_type, key_role, id)` — the ledger's
 * gl_journals_registry pattern.
 *
 * PROVES, against a real PostgreSQL when one is reachable:
 *   1. the parent is partitioned by `invoice_date_ad`, the key is in the primary
 *      key, `invoice_number` is no longer a unique index, and every legacy
 *      number is registered (one PRIMARY row per invoice);
 *   2. a one-month read prunes to that month's child and never reads DEFAULT;
 *   3. a reused invoice number is refused with 23505 (the old UNIQUE column's
 *      behaviour) and an invoice number cannot be renamed;
 *   4. updates by id or number still work in place (the cancel/payment paths),
 *      and the partition date is immovable;
 *   5. every inbound key still resolves: a payment on the invoice blocks
 *      nothing, deleting the invoice sets the payment's invoice_id to NULL, and
 *      an allocation on it refuses the delete (RESTRICT);
 *   6. a month can be emptied, releasing its registry keys, and detached.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  describeSalesInvoicePartitions,
  provisionSalesInvoicePartitions,
  salesInvoicePartitionStatus,
} from '../server/src/boot/salesInvoicePartitions';
import { replayOnContention } from '../server/src/db/transactions';

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
const TEST_MONTH = '203504';
const TEST_KEY = '203504';
const PREFIX = 'si3-';

/**
 * Create the fixture month the way the posting path does.
 *
 * The app replays this collision on both sides — withTransaction for the write,
 * withReadReplay for a statement read — but a direct call has no such loop, and
 * two suites provisioning neighbouring months at the same moment is exactly the
 * 40P01 that reddened the CI test-suite job. Same policy here: same codes, same
 * three attempts, same backoff, so the fixture is no longer the exposed party.
 */
async function ensureMonth() {
  await replayOnContention('Sales-invoice partition DDL', () =>
    pool!.query('SELECT ensure_sales_invoice_month_partition($1::date)', ['2035-04-01'])
  );
}

async function insertInvoice(id: string, number: string, day = '10') {
  return pool!.query(
    `INSERT INTO sales_invoices (id, invoice_number, customer_name, invoice_date_ad, invoice_date_bs, grand_total, items)
     VALUES ($1, $2, 'SCALE-3 fixture', ($3)::date, '2092-01-01', 0, '[]'::jsonb)`,
    [id, number, `2035-04-${day}`]
  );
}

async function expectFailure(sql: string, params: unknown[] = []): Promise<any> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql, params);
    await client.query('ROLLBACK');
    return null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return error;
  } finally {
    client.release();
  }
}

async function cleanupMonth() {
  if (!pool || !dbReachable) return;
  await pool
    .query(`DELETE FROM sales_invoices WHERE invoice_date_ad >= DATE '2035-04-01' AND invoice_date_ad < DATE '2035-05-01'`)
    .catch(() => undefined);
  await pool.query(`DROP TABLE IF EXISTS sales_invoices_${TEST_KEY}`).catch(() => undefined);
}

describe('sales invoice partitions', () => {
  after(async () => {
    await cleanupMonth();
    if (pool && dbReachable) await pool.end();
  });

  test('the register is partitioned by its invoice date and the number is registry-backed', { skip: skipNoDb }, async () => {
    const kind = await pool!.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'sales_invoices'`
    );
    assert.equal(kind.rows[0]?.relkind, 'p', 'sales_invoices must be a partitioned parent');

    const pk = await pool!.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'sales_invoices'::regclass AND contype = 'p'`
    );
    assert.match(pk.rows[0].def, /PRIMARY KEY \(id, invoice_date_ad\)/);

    const notNull = await pool!.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'sales_invoices' AND column_name = 'invoice_date_ad'`
    );
    assert.equal(notNull.rows[0].is_nullable, 'NO', 'the partition key cannot be NULL');

    const uniqueIndexes = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'sales_invoices' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'`
    );
    assert.deepEqual(
      uniqueIndexes.rows.map((row: any) => row.indexname),
      ['sales_invoices_pkey'],
      'the invoice_number unique index must be gone; the registry carries it'
    );

    const parity = await pool!.query(
      `SELECT (SELECT count(*)::int FROM sales_invoices) AS invoices,
              (SELECT count(*)::int FROM sales_invoices WHERE invoice_number IS NOT NULL) AS numbers,
              (SELECT count(*)::int FROM document_identity_registry
                WHERE document_type = 'SALES_INVOICE' AND key_role = 'PRIMARY') AS registered,
              (SELECT count(*)::int FROM sales_invoices i
                WHERE NOT EXISTS (SELECT 1 FROM document_identity_registry r
                                   WHERE r.document_type = 'SALES_INVOICE' AND r.key_role = 'PRIMARY'
                                     AND r.id = i.id)) AS unregistered`
    );
    assert.equal(parity.rows[0].unregistered, 0, 'every invoice carries its registry row');
    assert.equal(parity.rows[0].registered, parity.rows[0].numbers, 'one PRIMARY key per invoice number');
  });

  test('a one-month read prunes to that month and never touches DEFAULT', { skip: skipNoDb }, async () => {
    // Plan against this file's own fixture month: a fresh CI database holds no
    // invoices, and "the newest invoice in the table" would otherwise depend on
    // what another file in the shard happened to write.
    await cleanupMonth();
    await ensureMonth();
    await insertInvoice(`${PREFIX}p`, 'SI3-INV-P');
    const month = '2035-04';
    const start = `${month}-01`;
    const boundary = new Date(`${start}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    const next = boundary.toISOString().slice(0, 10);

    await pool!.query('BEGIN');
    try {
      await pool!.query('SET LOCAL enable_seqscan = off');
      const plan = await pool!.query(
        `EXPLAIN (COSTS OFF) SELECT sum(grand_total) FROM sales_invoices
          WHERE invoice_date_ad >= DATE '${start}' AND invoice_date_ad < DATE '${next}'`
      );
      const text = plan.rows.map((row: any) => Object.values(row)[0]).join('\n');
      const touched = [...new Set(text.match(/sales_invoices_[0-9]{6}/g) || [])];
      assert.deepEqual(touched, [`sales_invoices_${month.replace('-', '')}`], `one month, one child:\n${text}`);
      assert.doesNotMatch(text, /sales_invoices_default/, 'the catch-all is never read for a dated month');
    } finally {
      await pool!.query('ROLLBACK').catch(() => undefined);
      await cleanupMonth();
    }
  });

  test('a reused invoice number is refused and the number cannot be renamed', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertInvoice(`${PREFIX}a`, 'SI3-INV-1');
      const dup = await expectFailure(
        `INSERT INTO sales_invoices (id, invoice_number, customer_name, invoice_date_ad, invoice_date_bs, items)
         VALUES ($1, 'SI3-INV-1', 'SCALE-3 fixture', DATE '2035-04-11', '2092-01-02', '[]'::jsonb)`,
        [`${PREFIX}b`]
      );
      assert.ok(dup, 'a reused invoice number must be refused');
      assert.equal(dup.code, '23505', `expected a unique violation, got ${dup.code}: ${dup.message}`);

      const rows = await pool!.query(`SELECT count(*)::int AS n FROM sales_invoices WHERE invoice_number = 'SI3-INV-1'`);
      assert.equal(rows.rows[0].n, 1, 'only the first invoice holds the number');

      const rename = await expectFailure(`UPDATE sales_invoices SET invoice_number = 'SI3-INV-2' WHERE id = $1`, [
        `${PREFIX}a`,
      ]);
      assert.ok(rename, 'an invoice number must not be editable');
      assert.match(String(rename.message), /cannot change its invoice_number/);
    } finally {
      await cleanupMonth();
    }
  });

  test('updates still work in place and the partition date cannot move', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertInvoice(`${PREFIX}c`, 'SI3-INV-3');
      // The cancel and payment paths address the invoice by id OR number. Both
      // must keep working on the partitioned table.
      const cancelled = await pool!.query(
        `UPDATE sales_invoices SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
          WHERE (id = $1 OR invoice_number = $1) AND status = 'POSTED'`,
        ['SI3-INV-3']
      );
      assert.equal(cancelled.rowCount, 1, 'the update by number still lands');
      const byId = await pool!.query(`UPDATE sales_invoices SET payment_status = 'PAID' WHERE id = $1`, [`${PREFIX}c`]);
      assert.equal(byId.rowCount, 1, 'the update by id still lands');
      const row = await pool!.query(`SELECT status, payment_status FROM sales_invoices WHERE id = $1`, [`${PREFIX}c`]);
      assert.equal(row.rows[0].status, 'CANCELLED');
      assert.equal(row.rows[0].payment_status, 'PAID');

      const move = await expectFailure(
        `UPDATE sales_invoices SET invoice_date_ad = DATE '2035-05-01' WHERE id = $1`,
        [`${PREFIX}c`]
      );
      assert.ok(move, 'moving the partition date must be refused');
      assert.match(String(move.message), /cannot move to another invoice_date_ad/);
    } finally {
      await cleanupMonth();
    }
  });

  test('every inbound key still resolves through the registry anchor', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertInvoice(`${PREFIX}d`, 'SI3-INV-4');
      await insertInvoice(`${PREFIX}e`, 'SI3-INV-5');

      // A payment may name the invoice (SET NULL on delete).
      await pool!.query(
        `INSERT INTO customer_payments (id, payment_number, customer_name, invoice_id, payment_date_ad, payment_date_bs, amount)
         VALUES ('si3-pay-1', 'SI3-PAY-1', 'SCALE-3 fixture', $1, DATE '2035-04-12', '2092-01-02', 10)`,
        [`${PREFIX}d`]
      );
      // An allocation may not vanish with its invoice (RESTRICT).
      await pool!.query(
        `INSERT INTO customer_payment_allocations (id, payment_id, invoice_id, amount)
         VALUES ('si3-alloc-1', 'si3-pay-1', $1, 10)`,
        [`${PREFIX}e`]
      );

      const blocked = await expectFailure('DELETE FROM sales_invoices WHERE id = $1', [`${PREFIX}e`]);
      assert.ok(blocked, 'an allocated invoice cannot be deleted');
      // RESTRICT reports restrict_violation (23001); a plain FK violation is
      // 23503. Either way the delete must be refused by the allocation key.
      assert.ok(['23001', '23503'].includes(blocked.code), `expected a foreign-key refusal, got ${blocked.code}`);
      assert.match(String(blocked.message), /customer_payment_allocations_invoice_fk/);

      await pool!.query('DELETE FROM sales_invoices WHERE id = $1', [`${PREFIX}d`]);
      const payment = await pool!.query(
        `SELECT invoice_id, invoice_document_type FROM customer_payments WHERE id = 'si3-pay-1'`
      );
      assert.equal(payment.rows[0].invoice_id, null, 'the payment keeps existing, without the invoice');
      assert.equal(payment.rows[0].invoice_document_type, 'SALES_INVOICE', 'the anchor columns stay NOT NULL');

      // A payment naming an invoice that never existed is still refused.
      const ghost = await expectFailure(
        `INSERT INTO customer_payments (id, payment_number, customer_name, invoice_id, payment_date_ad, payment_date_bs, amount)
         VALUES ('si3-pay-2', 'SI3-PAY-2', 'SCALE-3 fixture', 'si3-no-such-invoice', DATE '2035-04-12', '2092-01-02', 5)`
      );
      assert.ok(ghost, 'a payment cannot name a missing invoice');
      assert.equal(ghost.code, '23503');

      await pool!.query(`DELETE FROM customer_payment_allocations WHERE id = 'si3-alloc-1'`);
      await pool!.query(`DELETE FROM customer_payments WHERE id = 'si3-pay-1'`);
    } finally {
      await cleanupMonth();
      await pool!.query(`DELETE FROM customer_payments WHERE id LIKE 'si3-%'`).catch(() => undefined);
    }
  });

  test('a month can be emptied and detached, releasing its registry keys', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertInvoice(`${PREFIX}f`, 'SI3-INV-6');
      const before = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry
          WHERE document_type = 'SALES_INVOICE' AND id = $1`,
        [`${PREFIX}f`]
      );
      assert.equal(before.rows[0].n, 1, 'the invoice holds its registry row');

      await pool!.query(
        `DELETE FROM sales_invoices WHERE invoice_date_ad >= DATE '2035-04-01' AND invoice_date_ad < DATE '2035-05-01'`
      );
      const after = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry
          WHERE document_type = 'SALES_INVOICE' AND id = $1`,
        [`${PREFIX}f`]
      );
      assert.equal(after.rows[0].n, 0, 'deleting the month releases its keys');

      await pool!.query(`DROP TABLE sales_invoices_${TEST_KEY}`);
      const gone = await pool!.query('SELECT to_regclass($1) AS reg', [`sales_invoices_${TEST_KEY}`]);
      assert.equal(gone.rows[0].reg, null, 'the month child is detached');
    } finally {
      await cleanupMonth();
    }
  });

  test('provisioning is idempotent and the DEFAULT child is reported', { skip: skipNoDb }, async () => {
    const now = new Date('2035-04-15T00:00:00Z');
    const report = await provisionSalesInvoicePartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
    try {
      assert.deepEqual(report.created, ['203504', '203505'], 'the missing months are created');
      assert.deepEqual(report.missing, [], 'no gap remains in the window');
      assert.match(describeSalesInvoicePartitions(report), /window 203504/);
      const again = await provisionSalesInvoicePartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.deepEqual(again.created, [], 'a second run is a no-op');
      const status = await salesInvoicePartitionStatus(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.equal(typeof status.defaultRows, 'number', 'the DEFAULT child is counted');
      const ownMonthDefault = await pool!.query(
        `SELECT count(*)::int AS n FROM sales_invoices_default
          WHERE invoice_date_ad >= DATE '2035-04-01' AND invoice_date_ad < DATE '2035-05-01'`
      );
      assert.equal(ownMonthDefault.rows[0].n, 0, 'a provisioned month never falls through to DEFAULT');
    } finally {
      await pool!.query('DROP TABLE IF EXISTS sales_invoices_203505').catch(() => undefined);
      await cleanupMonth();
    }
  });
});
