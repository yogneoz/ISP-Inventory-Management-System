/**
 * SCALE-3 — `serial_log` is monthly-partitioned with its three case-insensitive
 * keys moved into the document identity registry.
 *
 * The register is one row per device serial for the life of the unit and is read
 * on every deploy/exchange/damage/return, so it grows the way the operational
 * register did. Migration 0036 converts it to RANGE partitions by `created_at`
 * (the document date every insert already carries) with a DEFAULT catch-all.
 *
 * The three old uniques — `uq_serial_log_device_serial`,
 * `uq_serial_log_pon_serial`, `uq_serial_log_mac_address`, all
 * `lower(trim(col))` partial uniques — cannot live on a partitioned table, so
 * they are registered as the SERIAL / PON / MAC roles of
 * `document_identity_registry` by `enforce_document_identity()`.
 *
 * PROVES, against a real PostgreSQL when one is reachable:
 *   1. the parent is partitioned by `created_at`, the partition key is NOT NULL
 *      and in the primary key, and no unique index still claims a serial key;
 *   2. every existing row's non-blank keys are registered, one row per role;
 *   3. a one-month read prunes to that month's child and never reads DEFAULT;
 *   4. the register's insert-if-absent contract is unchanged: a serial, PON or
 *      MAC already held by another row (case/space-insensitively) inserts NO
 *      row, exactly like `INSERT ... ON CONFLICT DO NOTHING` did, and the
 *      surviving row is what the follow-up update touches;
 *   5. the correction flow can still rename a serial (the registry claim moves
 *      with it) but a rename onto a held serial raises 23505, the old unique
 *      index's behaviour;
 *   6. the partition date is immovable (no silent reparent into another month);
 *   7. a month can be emptied, releasing its keys, and detached.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  describeSerialLogPartitions,
  provisionSerialLogPartitions,
  serialLogPartitionStatus,
} from '../server/src/boot/serialLogPartitions';
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
const TEST_MONTH = '203403';
const PREFIX = 's3part-';

async function ensureMonth() {
  await replayOnContention('Serial-log partition DDL', () =>
    pool!.query('SELECT ensure_serial_log_month_partition($1::date)', ['2034-03-01'])
  );
}

/** Insert through the register's real write shape: insert-if-absent. */
async function insertSerial(
  id: string,
  serial: string,
  pon: string | null,
  mac: string | null,
  day = '05'
) {
  return pool!.query(
    `INSERT INTO serial_log (id, device_serial, pon_serial, mac_address, product_name, status, source_type, created_at)
     VALUES ($1, $2, $3, $4, 'SCALE-3 fixture', 'IN_STOCK', 'PURCHASE', ($5)::timestamptz)
     ON CONFLICT DO NOTHING`,
    [id, serial, pon, mac, `2034-03-${day}T00:00:00Z`]
  );
}

/**
 * Run a statement that must fail, on its own connection and transaction, so a
 * failed statement never poisons the statements the rest of the test needs.
 */
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
    .query(
      `DELETE FROM serial_log
        WHERE created_at >= TIMESTAMPTZ '2034-03-01 00:00:00+00'
          AND created_at < TIMESTAMPTZ '2034-04-01 00:00:00+00'`
    )
    .catch(() => undefined);
  await pool.query(`DROP TABLE IF EXISTS serial_log_${TEST_MONTH}`).catch(() => undefined);
}

describe('serial register partitions', () => {
  after(async () => {
    await cleanupMonth();
    if (pool && dbReachable) await pool.end();
  });

  test('the register is partitioned by its document date and the keys are registry-backed', { skip: skipNoDb }, async () => {
    const kind = await pool!.query(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'serial_log'`
    );
    assert.equal(kind.rows[0]?.relkind, 'p', 'serial_log must be a partitioned parent');

    const pk = await pool!.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'serial_log'::regclass AND contype = 'p'`
    );
    assert.match(pk.rows[0].def, /PRIMARY KEY \(id, created_at\)/, 'the partition key must be in the primary key');

    const notNull = await pool!.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'serial_log' AND column_name = 'created_at'`
    );
    assert.equal(notNull.rows[0].is_nullable, 'NO', 'the partition key cannot be NULL');

    const uniqueIndexes = await pool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'serial_log' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'`
    );
    assert.deepEqual(
      uniqueIndexes.rows.map((row: any) => row.indexname),
      ['serial_log_pkey'],
      'only the primary key may be unique; the three serial uniques moved to the registry'
    );

    // The rows this file writes, never the whole register: a fresh database has
    // no register rows until a test puts some there, and the other files in the
    // same shard write rows of their own in parallel.
    await ensureMonth();
    await insertSerial(`${PREFIX}r`, 'S3PART-SERIAL-R', 'S3PART-PON-R', 'AA:BB:CC:00:00:0R');
    await insertSerial(`${PREFIX}s`, 'S3PART-SERIAL-S', null, null);

    const roles = await pool!.query(
      `SELECT key_role, count(*)::int AS n FROM document_identity_registry
        WHERE document_type = 'SERIAL_LOG' AND id LIKE $1 GROUP BY key_role ORDER BY key_role`,
      [`${PREFIX}%`]
    );
    assert.deepEqual(roles.rows.map((row: any) => row.key_role), ['MAC', 'PON', 'SERIAL']);

    // One registry key per non-blank value, exactly what the partial uniques
    // governed — counted over this file's own rows.
    const parity = await pool!.query(
      `SELECT (SELECT count(*)::int FROM serial_log WHERE id LIKE '${PREFIX}%' AND btrim(device_serial) <> '') AS serials,
              (SELECT count(*)::int FROM serial_log WHERE id LIKE '${PREFIX}%' AND btrim(coalesce(pon_serial, '')) <> '') AS pons,
              (SELECT count(*)::int FROM serial_log WHERE id LIKE '${PREFIX}%' AND btrim(coalesce(mac_address, '')) <> '') AS macs,
              (SELECT count(*)::int FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND id LIKE '${PREFIX}%' AND key_role = 'SERIAL') AS reg_serials,
              (SELECT count(*)::int FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND id LIKE '${PREFIX}%' AND key_role = 'PON') AS reg_pons,
              (SELECT count(*)::int FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND id LIKE '${PREFIX}%' AND key_role = 'MAC') AS reg_macs`
    );
    assert.ok(parity.rows[0].serials > 0 && parity.rows[0].pons > 0 && parity.rows[0].macs > 0, 'the fixture writes all three keys');
    assert.deepEqual(parity.rows[0], {
      serials: parity.rows[0].reg_serials,
      pons: parity.rows[0].reg_pons,
      macs: parity.rows[0].reg_macs,
      reg_serials: parity.rows[0].reg_serials,
      reg_pons: parity.rows[0].reg_pons,
      reg_macs: parity.rows[0].reg_macs,
    });
  });

  test('a one-month read prunes to that month and never touches DEFAULT', { skip: skipNoDb }, async () => {
    // The month is this file's own fixture month. Reading "the newest row in the
    // table" made the pruning proof depend on rows another file happened to
    // leave behind, so a fresh CI database had nothing to plan against.
    await cleanupMonth();
    await ensureMonth();
    await insertSerial(`${PREFIX}p`, 'S3PART-SERIAL-P', 'S3PART-PON-P', 'AA:BB:CC:00:00:0P');
    const month = '2034-03';
    const start = `${month}-01`;
    const boundary = new Date(`${start}T00:00:00Z`);
    boundary.setUTCMonth(boundary.getUTCMonth() + 1);
    const next = boundary.toISOString().slice(0, 10);

    await pool!.query('BEGIN');
    try {
      await pool!.query('SET LOCAL enable_seqscan = off');
      const plan = await pool!.query(
        `EXPLAIN (COSTS OFF) SELECT count(*) FROM serial_log
          WHERE created_at >= TIMESTAMPTZ '${start} 00:00:00+00'
            AND created_at <  TIMESTAMPTZ '${next} 00:00:00+00'`
      );
      const text = plan.rows.map((row: any) => Object.values(row)[0]).join('\n');
      const touched = [...new Set(text.match(/serial_log_[0-9]{6}/g) || [])];
      assert.deepEqual(touched, [`serial_log_${month.replace('-', '')}`], `one month, one child:\n${text}`);
      assert.doesNotMatch(text, /serial_log_default/, 'the catch-all is never read for a dated month');
    } finally {
      await pool!.query('ROLLBACK');
    }
  });

  test('a serial, PON or MAC already held inserts no row, and the survivor updates in place', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      const first = await insertSerial(`${PREFIX}a`, 'S3PART-SERIAL-A', 'S3PART-PON-A', 'AA:BB:CC:00:00:0A');
      assert.equal(first.rowCount, 1, 'the first serial is registered');

      const serialDup = await insertSerial(`${PREFIX}b`, '  s3part-serial-a  ', 'S3PART-PON-B', 'AA:BB:CC:00:00:0B', '06');
      const ponDup = await insertSerial(`${PREFIX}c`, 'S3PART-SERIAL-C', ' s3part-pon-a ', 'AA:BB:CC:00:00:0C', '07');
      const macDup = await insertSerial(`${PREFIX}d`, 'S3PART-SERIAL-D', 'S3PART-PON-D', 'aa:bb:cc:00:00:0a', '08');
      assert.equal(serialDup.rowCount, 0, 'a reused serial inserts no row (case/trim-insensitive)');
      assert.equal(ponDup.rowCount, 0, 'a reused PON inserts no row');
      assert.equal(macDup.rowCount, 0, 'a reused MAC inserts no row');

      const rows = await pool!.query(
        `SELECT count(*)::int AS n FROM serial_log WHERE lower(btrim(device_serial)) = 's3part-serial-a'`
      );
      assert.equal(rows.rows[0].n, 1, 'exactly one row owns the serial');

      const owners = await pool!.query(
        `SELECT id FROM document_identity_registry
          WHERE document_type = 'SERIAL_LOG' AND key_role = 'SERIAL' AND business_key = 's3part-serial-a'`
      );
      assert.deepEqual(
        owners.rows.map((row: any) => row.id),
        [`${PREFIX}a`],
        'the key is never handed to a second row'
      );

      // The register's write paths do insert-if-absent and then update the
      // surviving row by its case-insensitive serial: unchanged.
      const updated = await pool!.query(
        `UPDATE serial_log SET status = 'DAMAGED', updated_at = NOW()
          WHERE lower(trim(device_serial)) = lower(trim($1))`,
        ['S3PART-SERIAL-A']
      );
      assert.equal(updated.rowCount, 1, 'the survivor is updated in place');
      const survivor = await pool!.query(
        `SELECT status, id FROM serial_log WHERE lower(btrim(device_serial)) = 's3part-serial-a'`
      );
      assert.equal(survivor.rows.length, 1, 'still one row after the update');
      assert.equal(survivor.rows[0].status, 'DAMAGED');

      const resend = await insertSerial(`${PREFIX}a`, 'S3PART-SERIAL-A', 'S3PART-PON-A', 'AA:BB:CC:00:00:0A');
      assert.equal(resend.rowCount, 0, 're-sending the same id inserts nothing');
    } finally {
      await cleanupMonth();
    }
  });

  test('a correction may rename a serial, but not onto one that is already held', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertSerial(`${PREFIX}e`, 'S3PART-SERIAL-E', 'S3PART-PON-E', null);
      await insertSerial(`${PREFIX}f`, 'S3PART-SERIAL-F', 'S3PART-PON-F', null);

      const rename = await pool!.query(`UPDATE serial_log SET device_serial = 'S3PART-SERIAL-E2' WHERE id = $1`, [
        `${PREFIX}e`,
      ]);
      assert.equal(rename.rowCount, 1, 'the correction flow can rename');
      const moved = await pool!.query(
        `SELECT business_key FROM document_identity_registry
          WHERE document_type = 'SERIAL_LOG' AND key_role = 'SERIAL' AND id = $1`,
        [`${PREFIX}e`]
      );
      assert.deepEqual(moved.rows.map((row: any) => row.business_key), ['s3part-serial-e2'], 'the claim moved with the row');
      const released = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry
          WHERE document_type = 'SERIAL_LOG' AND key_role = 'SERIAL' AND business_key = 's3part-serial-e'`
      );
      assert.equal(released.rows[0].n, 0, 'the old claim is released');

      const clash = await expectFailure(`UPDATE serial_log SET device_serial = 'S3PART-SERIAL-F' WHERE id = $1`, [
        `${PREFIX}e`,
      ]);
      assert.ok(clash, 'renaming onto a held serial must fail');
      assert.equal(clash.code, '23505', `expected a unique violation, got ${clash.code}: ${clash.message}`);
    } finally {
      await cleanupMonth();
    }
  });

  test('the partition date cannot move, and the DEFAULT child is reported', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertSerial(`${PREFIX}g`, 'S3PART-SERIAL-G', 'S3PART-PON-G', null);
      const move = await expectFailure(
        `UPDATE serial_log SET created_at = TIMESTAMPTZ '2034-05-01 00:00:00+00' WHERE id = $1`,
        [`${PREFIX}g`]
      );
      assert.ok(move, 'moving the partition date must be refused');
      assert.match(String(move.message), /cannot move to another created_at/, 'the message names the partition key');
    } finally {
      await cleanupMonth();
    }

    const now = new Date('2034-03-15T00:00:00Z');
    const report = await provisionSerialLogPartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
    try {
      // The fixture month was detached by the cleanup above, so provisioning
      // recreates it together with the rest of the window.
      assert.deepEqual(report.created, ['203403', '203404'], 'the missing months are created');
      assert.deepEqual(report.missing, [], 'no gap remains in the window');
      assert.match(describeSerialLogPartitions(report), /window 203403/);
      const again = await provisionSerialLogPartitions(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.deepEqual(again.created, [], 'a second run is a no-op');
      const status = await serialLogPartitionStatus(pool!, { now, monthsBehind: 0, monthsAhead: 1 });
      assert.equal(typeof status.defaultRows, 'number', 'the DEFAULT child is counted');
      const ownMonthDefault = await pool!.query(
        `SELECT count(*)::int AS n FROM serial_log_default
          WHERE created_at >= TIMESTAMPTZ '2034-03-01 00:00:00+00'
            AND created_at <  TIMESTAMPTZ '2034-04-01 00:00:00+00'`
      );
      assert.equal(ownMonthDefault.rows[0].n, 0, 'a provisioned month never falls through to DEFAULT');
    } finally {
      await pool!.query('DROP TABLE IF EXISTS serial_log_203404').catch(() => undefined);
      await cleanupMonth();
    }
  });

  test('a month can be emptied and detached, releasing its registry keys', { skip: skipNoDb }, async () => {
    await cleanupMonth();
    await ensureMonth();
    try {
      await insertSerial(`${PREFIX}h`, 'S3PART-SERIAL-H', 'S3PART-PON-H', 'AA:BB:CC:00:00:0H'.replace('H', '9'));
      const before = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND id = $1`,
        [`${PREFIX}h`]
      );
      assert.equal(before.rows[0].n, 3, 'the row holds its three keys');

      await pool!.query(
        `DELETE FROM serial_log
          WHERE created_at >= TIMESTAMPTZ '2034-03-01 00:00:00+00'
            AND created_at <  TIMESTAMPTZ '2034-04-01 00:00:00+00'`
      );
      const after = await pool!.query(
        `SELECT count(*)::int AS n FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND id = $1`,
        [`${PREFIX}h`]
      );
      assert.equal(after.rows[0].n, 0, 'deleting the month releases its keys');

      await pool!.query(`DROP TABLE serial_log_${TEST_MONTH}`);
      const gone = await pool!.query('SELECT to_regclass($1) AS reg', [`serial_log_${TEST_MONTH}`]);
      assert.equal(gone.rows[0].reg, null, 'the month child is detached');
    } finally {
      await cleanupMonth();
    }
  });
});
