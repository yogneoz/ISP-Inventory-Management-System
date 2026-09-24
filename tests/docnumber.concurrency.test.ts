/**
 * Concurrency integration test (C2 / post_generateNext atomic claim).
 *
 * PROVES, against a real PostgreSQL server, that two or more parallel
 * claimers of DOC_NUMBER_CONFIG_CLAIM_SQL — the exact statement
 * post_generateNext executes when incrementing — can never observe the same
 * sequence number, and that the issued numbers form a gapless, duplicate-free
 * range (every number issued exactly once).
 *
 * Isolation: the test creates a dedicated throwaway database
 * (inventory_concurrency_test), never touches the application database
 * (inventory_db), and drops the throwaway in teardown. When no PostgreSQL is
 * reachable the tests are skipped, so environments without a database (CI,
 * demo mode) stay green — this is an integration proof, not a unit test.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

import { DOC_NUMBER_CONFIG_CLAIM_SQL } from '../server/src/models/admin.repo';

const TEST_DB = 'inventory_concurrency_test';
const PARALLEL_CALLERS = 24; // well above pg's default pool max of 10, so queued claims genuinely interleave

/** Parse DATABASE_URL and swap the database for the throwaway one. */
function testDbUrl(): string | null {
  const base = process.env.DATABASE_URL;
  if (!base) return null;
  try {
    const u = new URL(base);
    u.pathname = `/${TEST_DB}`;
    return u.toString();
  } catch {
    return null;
  }
}

describe('doc-number concurrency against real PostgreSQL', () => {
  let adminPool: pg.Pool | null = null; // connects to the 'postgres' DB for CREATE/DROP
  let testPool: pg.Pool | null = null; // connects to the throwaway test DB
  let dbReachable = false;

  before(async () => {
    const url = testDbUrl();
    if (!url) return;
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    try {
      adminPool = new pg.Pool({ connectionString: adminUrl.toString(), max: 2, connectionTimeoutMillis: 2000 });
      const probe = await adminPool.query('SELECT 1');
      dbReachable = probe.rowCount === 1;
      if (!dbReachable) return;
      // Throwaway database: drop stale runs, then create fresh.
      await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      await adminPool.query(`CREATE DATABASE ${TEST_DB}`);
      testPool = new pg.Pool({ connectionString: url, max: PARALLEL_CALLERS + 4, connectionTimeoutMillis: 5000 });
      // Same DDL subset document_number_configs has in the app schema.
      await testPool.query(`CREATE TABLE document_number_configs (
        id VARCHAR(50) PRIMARY KEY,
        document_type VARCHAR(150) NOT NULL,
        prefix VARCHAR(50) DEFAULT '',
        suffix VARCHAR(50) DEFAULT '',
        min_digits INT DEFAULT 4,
        starting_number INT DEFAULT 1,
        next_number INT DEFAULT 1,
        reset_every_fiscal_year BOOLEAN DEFAULT TRUE,
        notes TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )`);
      await testPool.query(
        `INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number)
         VALUES ('PI', 'Purchase Invoice', 'PI', '', 4, 1, 1)`
      );
    } catch (_e) {
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

  test(`${PARALLEL_CALLERS} parallel claims return ${PARALLEL_CALLERS} distinct, gapless numbers`, async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable — concurrency proof requires a live server');
      return;
    }

    // Fire all claims at once; the pool queues them so connections are
    // genuinely concurrent (each claim is its own implicit transaction).
    const results = await Promise.all(
      Array.from({ length: PARALLEL_CALLERS }, () =>
        testPool!.query(DOC_NUMBER_CONFIG_CLAIM_SQL, ['PI'])
      )
    );

    const befores = results.map((r) => Number(r.rows[0].next_number_before));
    const afters = results.map((r) => Number(r.rows[0].next_number_after));
    const formats = results.map((r) => `${r.rows[0].prefix}${String(r.rows[0].next_number_before).padStart(Number(r.rows[0].min_digits) || 4, '0')}${r.rows[0].suffix}`);

    // 1. No duplicate numbers — the core invariant. (Sort a COPY for the
    //    message: Array.prototype.sort mutates in place, which would
    //    desynchronize befores from the completion-ordered afters below.)
    assert.equal(new Set(befores).size, PARALLEL_CALLERS, `duplicates issued: ${[...befores].sort((a, b) => a - b)}`);

    // 2. Gapless coverage: the set of consumed numbers is exactly 1..N
    //    (counter started at 1), proving no number was skipped or double-spent.
    const sorted = [...befores].sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: PARALLEL_CALLERS }, (_, i) => i + 1));

    // 3. Every claimer observed a strictly consistent before/after pair
    //    (after = before + 1) — no torn reads.
    for (let i = 0; i < PARALLEL_CALLERS; i++) {
      assert.equal(afters[i], befores[i] + 1);
    }

    // 4. Formatted document numbers are unique too (what the UI shows).
    assert.equal(new Set(formats).size, PARALLEL_CALLERS);

    // 5. The counter ends exactly at N+1: total increments == number of callers.
    const final = await testPool.query('SELECT next_number FROM document_number_configs WHERE id = $1', ['PI']);
    assert.equal(Number(final.rows[0].next_number), PARALLEL_CALLERS + 1);
  });

  test('two sequential batches continue without overlap (no reuse across batches)', async (t) => {
    if (!dbReachable || !testPool) {
      t.skip('PostgreSQL not reachable');
      return;
    }
    const batch1 = await Promise.all(
      Array.from({ length: 5 }, () => testPool!.query(DOC_NUMBER_CONFIG_CLAIM_SQL, ['PI']))
    );
    const batch2 = await Promise.all(
      Array.from({ length: 5 }, () => testPool!.query(DOC_NUMBER_CONFIG_CLAIM_SQL, ['PI']))
    );
    const all = [...batch1, ...batch2].map((r) => Number(r.rows[0].next_number_before));
    assert.equal(new Set(all).size, 10, `cross-batch duplicates: ${all.sort((a, b) => a - b)}`);
  });
});
