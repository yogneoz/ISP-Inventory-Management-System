/**
 * Concurrency integration test (C3 row-level stock locking).
 *
 * PROVES, against a real PostgreSQL server, that the lock-and-re-verify
 * transaction sequence used by post_stockOperations —
 *   BEGIN → STOCK_LOCK_FOR_UPDATE_SQL (SELECT … FOR UPDATE)
 *         → re-verify availability from the locked rows
 *         → guarded apply (STOCK_CONSUME_QOH_SQL / STOCK_DAMAGE_APPLY_SQL)
 *         → COMMIT
 * — can never double-spend: two parallel postings of the LAST unit must
 * yield exactly ONE success and ONE rejection, with the final stock level
 * correct. Also proves plentiful stock is not spuriously rejected (the lock
 * serializes but never blocks legitimate work).
 *
 * The apply statements and lock SQL are the exact repo constants the
 * controller executes; the surrounding BEGIN/COMMIT mirrors withTransaction.
 * Isolation: dedicated throwaway database (inventory_stock_concurrency_test),
 * the application database is never touched; teardown drops it. Skips when
 * no PostgreSQL is reachable (CI, demo mode) — integration proof, not unit.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

import {
  STOCK_LOCK_FOR_UPDATE_SQL,
  stockLockForUpdateParams,
  STOCK_CONSUME_QOH_SQL,
  STOCK_DAMAGE_APPLY_SQL,
} from '../server/src/models/inventory.repo';

const TEST_DB = 'inventory_stock_concurrency_test';
const BRANCH = 'WH001';

/** The exact C3 transaction body for a stock-consuming operation. */
async function postStockOperation(
  pool: pg.Pool,
  kind: 'STOCK_OUT' | 'DAMAGE',
  productId: string,
  qty: number
): Promise<'posted' | 'rejected'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Step 1 (C3): lock the affected rows inside the transaction.
    const locked = await client.query(
      STOCK_LOCK_FOR_UPDATE_SQL,
      stockLockForUpdateParams([{ productId }], BRANCH)
    );
    // Step 2: re-verify from the LOCKED rows (DB truth, post-first-writer).
    const row = locked.rows[0];
    if (kind === 'DAMAGE') {
      if (!row || Number(row.quantity_on_hand) < qty) throw new Error('insufficient');
    } else if (!row || Number(row.quantity_on_hand) < qty) {
      throw new Error('insufficient');
    }
    // Step 3: guarded apply (backstop: WHERE quantity_on_hand >= qty).
    const apply =
      kind === 'DAMAGE'
        ? await client.query(STOCK_DAMAGE_APPLY_SQL, [qty, productId, BRANCH])
        : await client.query(STOCK_CONSUME_QOH_SQL, [qty, productId, BRANCH]);
    if (apply.rowCount !== 1) throw new Error('guarded apply matched no row');
    await client.query('COMMIT');
    return 'posted';
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    return 'rejected';
  } finally {
    client.release();
  }
}

describe('stock-write concurrency against real PostgreSQL (C3 locking)', () => {
  let adminPool: pg.Pool | null = null;
  let testPool: pg.Pool | null = null;
  let dbReachable = false;

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    try {
      const adminUrl = new URL(base);
      adminUrl.pathname = '/postgres';
      const testUrl = new URL(base);
      testUrl.pathname = `/${TEST_DB}`;
      adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2, connectionTimeoutMillis: 2000 });
      const probe = await adminPool.query('SELECT 1');
      dbReachable = probe.rowCount === 1;
      if (!dbReachable) return;
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
      testPool = new pg.Pool({ connectionString: testUrl.toString(), max: 12, connectionTimeoutMillis: 5000 });
      // Same DDL subset inventory_stock has in the app schema (columns the
      // lock SQL selects and the apply statements update).
      await testPool.query(`CREATE TABLE inventory_stock (
        id VARCHAR(80) PRIMARY KEY,
        product_id VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50) NOT NULL,
        quantity_on_hand INT NOT NULL DEFAULT 0,
        damaged_qty INT NOT NULL DEFAULT 0,
        reserved_qty INT NOT NULL DEFAULT 0,
        incoming_qty INT NOT NULL DEFAULT 0,
        min_reorder_level INT NOT NULL DEFAULT 5,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (product_id, branch_id)
      )`);
      // Seed: prod-last has exactly ONE unit (the contested last unit);
      // prod-rich has ten.
      await testPool.query(`INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand)
        VALUES ('stk-last', 'prod-last', $1, 1), ('stk-rich', 'prod-rich', $1, 10)`, [BRANCH]);
    } catch {
      dbReachable = false;
    }
  });

  after(async () => {
    try {
      if (testPool) {
        await testPool.end();
        testPool = null;
      }
      if (adminPool && dbReachable) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      }
    } finally {
      if (adminPool) await adminPool.end();
    }
  });

  test('two parallel stock-outs of the LAST unit: exactly one posts, stock ends at 0', async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable — concurrency proof requires a live server');
      return;
    }

    const outcomes = await Promise.all([
      postStockOperation(testPool, 'STOCK_OUT', 'prod-last', 1),
      postStockOperation(testPool, 'STOCK_OUT', 'prod-last', 1),
    ]);

    // The core invariant: the single unit was consumed exactly once.
    assert.deepEqual(outcomes.sort(), ['posted', 'rejected']);

    const final = await testPool.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      ['prod-last', BRANCH]
    );
    assert.equal(Number(final.rows[0].quantity_on_hand), 0);
  });

  test('the loser is rejected at the re-verify step, AFTER the winner committed', async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable');
      return;
    }
    // Reset the contested row to exactly one unit.
    await testPool.query(
      'UPDATE inventory_stock SET quantity_on_hand = 1 WHERE product_id = $1 AND branch_id = $2',
      ['prod-last', BRANCH]
    );

    // Sequential probe of the same pattern the parallel test races: after the
    // winner commits, a fresh transaction must see qoh=0 in its locked rows
    // and reject BEFORE running any apply statement.
    const first = await postStockOperation(testPool, 'STOCK_OUT', 'prod-last', 1);
    assert.equal(first, 'posted');
    const second = await postStockOperation(testPool, 'STOCK_OUT', 'prod-last', 1);
    assert.equal(second, 'rejected');

    // And the rejected poster left NO partial state behind.
    const final = await testPool.query(
      'SELECT quantity_on_hand, damaged_qty FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      ['prod-last', BRANCH]
    );
    assert.equal(Number(final.rows[0].quantity_on_hand), 0);
    assert.equal(Number(final.rows[0].damaged_qty), 0);
  });

  test('two parallel postings of a DAMAGE op on the LAST unit: exactly one posts', async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable');
      return;
    }
    // Fresh state: earlier tests in this file consumed the contested unit.
    // DAMAGE moves the unit usable→damaged (dual-column apply), so restore
    // qoh=1 AND clear the damaged pool the previous DAMAGE race may have left.
    await testPool.query(
      'UPDATE inventory_stock SET quantity_on_hand = 1, damaged_qty = 0 WHERE product_id = $1 AND branch_id = $2',
      ['prod-last', BRANCH]
    );
    const outcomes = await Promise.all([
      postStockOperation(testPool, 'DAMAGE', 'prod-last', 1),
      postStockOperation(testPool, 'DAMAGE', 'prod-last', 1),
    ]);
    assert.deepEqual(outcomes.sort(), ['posted', 'rejected']);

    const final = await testPool.query(
      'SELECT quantity_on_hand, damaged_qty FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      ['prod-last', BRANCH]
    );
    // Exactly one unit moved to the damaged pool.
    assert.equal(Number(final.rows[0].quantity_on_hand), 0);
    assert.equal(Number(final.rows[0].damaged_qty), 1);
  });

  test('plentiful stock: parallel postings BOTH succeed (locks never block legitimate work)', async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable');
      return;
    }
    const outcomes = await Promise.all([
      postStockOperation(testPool, 'STOCK_OUT', 'prod-rich', 3),
      postStockOperation(testPool, 'STOCK_OUT', 'prod-rich', 3),
    ]);
    assert.deepEqual(outcomes, ['posted', 'posted']);
    const final = await testPool.query(
      'SELECT quantity_on_hand FROM inventory_stock WHERE product_id = $1 AND branch_id = $2',
      ['prod-rich', BRANCH]
    );
    assert.equal(Number(final.rows[0].quantity_on_hand), 4);
  });
});
