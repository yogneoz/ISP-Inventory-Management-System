/**
 * SCALE-3 — the read/write split and its replication lag guard.
 *
 * These tests pin the two safety rules the split depends on, so removing or
 * inverting the guard fails here rather than silently serving stale reads:
 *
 *   1. a replica-eligible read goes to the replica only while the measured lag
 *      is within `REPLICA_MAX_LAG_MS` and the request has not written;
 *   2. every other case — lag too high, replica unreachable, replica erroring
 *      mid-read, no replica configured, request already wrote — sends the read
 *      to the primary.
 *
 * The live demonstration (`scripts/verify_read_routing.ts`) runs the same router
 * against a real streaming standby; these are the unit-level invariants that
 * make that demonstration meaningful.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPLICA_MAX_LAG_MS,
  REPLICA_HEALTH_SQL,
  createReadRouter,
  decideReadTarget,
  isWriteStatement,
  parseReplicaHealth,
  requestWrote,
  resolveReadRouting,
  runWithReadContext,
  markRequestWrote,
  type ReplicaHealth,
} from '../server/src/db/readRouting';

const healthy = (overrides: Partial<ReplicaHealth> = {}): ReplicaHealth => ({
  reachable: true,
  inRecovery: true,
  lagMs: 40,
  lagBytes: 1024,
  probedAt: Date.now(),
  ...overrides,
});

/**
 * A pool double that records the statements it was given. The primary answers a
 * read with `replica: false`; a replica double answers the health probe with a
 * current standby row and any other read with `replica: true`, so the assertion
 * "which database answered" is the real one.
 */
function pool(name: 'primary' | 'replica', error?: Error) {
  const calls: string[] = [];
  return {
    calls,
    async query(text: string) {
      calls.push(text);
      if (error) throw error;
      if (name === 'replica' && text.includes('pg_is_in_recovery() AS in_recovery')) {
        return { rows: [{ in_recovery: true, receive_lsn: '0/2', replay_lsn: '0/2', lag_bytes: '0', lag_ms: '0' }] };
      }
      return { rows: [{ replica: name === 'replica' }] };
    },
  };
}

describe('read routing decisions (SCALE-3)', () => {
  test('a single-URL install keeps every read on the primary', () => {
    const resolved = resolveReadRouting({ DATABASE_URL: 'postgres://a/db' } as NodeJS.ProcessEnv);
    assert.equal(resolved.writeUrl, 'postgres://a/db');
    assert.equal(resolved.readUrl, '');
    assert.equal(resolved.readUrlSource, null);
    assert.deepEqual(
      decideReadTarget({ replicaConfigured: false, requestWrote: false, health: healthy(), maxLagMs: 5000 }),
      { target: 'primary', reason: 'no-replica' }
    );
  });

  test('DATABASE_WRITE_URL is the primary and DATABASE_READ_URL the replica, with the old aliases kept', () => {
    const split = resolveReadRouting({
      DATABASE_URL: 'postgres://legacy/primary',
      DATABASE_WRITE_URL: 'postgres://write/primary',
      DATABASE_READ_URL: 'postgres://read/replica',
      REPORT_DATABASE_URL: 'postgres://report/replica',
    } as NodeJS.ProcessEnv);
    assert.equal(split.writeUrl, 'postgres://write/primary');
    assert.equal(split.readUrl, 'postgres://read/replica');
    assert.equal(split.readUrlSource, 'DATABASE_READ_URL');

    const alias = resolveReadRouting({
      DATABASE_URL: 'postgres://a/db',
      REPORT_DATABASE_URL: 'postgres://report/replica',
    } as NodeJS.ProcessEnv);
    assert.equal(alias.readUrl, 'postgres://report/replica');
    assert.equal(alias.readUrlSource, 'REPORT_DATABASE_URL');

    const olderAlias = resolveReadRouting({
      DATABASE_URL: 'postgres://a/db',
      READ_REPLICA_DATABASE_URL: 'postgres://old/replica',
    } as NodeJS.ProcessEnv);
    assert.equal(olderAlias.readUrl, 'postgres://old/replica');
    assert.equal(olderAlias.readUrlSource, 'READ_REPLICA_DATABASE_URL');
  });

  test('the guard sends a lagging replica to the primary and a fresh one to the replica', () => {
    assert.deepEqual(
      decideReadTarget({ replicaConfigured: true, requestWrote: false, health: healthy({ lagMs: 400 }), maxLagMs: 5000 }),
      { target: 'replica', reason: 'replica' }
    );
    assert.deepEqual(
      decideReadTarget({ replicaConfigured: true, requestWrote: false, health: healthy({ lagMs: 5001 }), maxLagMs: 5000 }),
      { target: 'primary', reason: 'replica-lagging' }
    );
    // Exactly at the threshold is still inside it: the limit is a maximum.
    assert.equal(
      decideReadTarget({ replicaConfigured: true, requestWrote: false, health: healthy({ lagMs: 5000 }), maxLagMs: 5000 })
        .target,
      'replica'
    );
  });

  test('an unreachable replica and an unknown lag never serve a read', () => {
    assert.deepEqual(
      decideReadTarget({ replicaConfigured: true, requestWrote: false, health: null, maxLagMs: 5000 }),
      { target: 'primary', reason: 'replica-unreachable' }
    );
    assert.deepEqual(
      decideReadTarget({
        replicaConfigured: true,
        requestWrote: false,
        health: healthy({ reachable: false, error: 'ECONNREFUSED' }),
        maxLagMs: 5000,
      }),
      { target: 'primary', reason: 'replica-unreachable' }
    );
    // A read URL that is not in recovery is the source of truth: it cannot be stale.
    assert.equal(
      decideReadTarget({
        replicaConfigured: true,
        requestWrote: false,
        health: healthy({ inRecovery: false, lagMs: null }),
        maxLagMs: 5000,
      }).target,
      'replica'
    );
  });

  test('a request that has written is pinned to the primary', () => {
    assert.deepEqual(
      decideReadTarget({ replicaConfigured: true, requestWrote: true, health: healthy(), maxLagMs: 5000 }),
      { target: 'primary', reason: 'request-wrote' }
    );
    assert.equal(requestWrote(), false, 'no context outside a request');
    runWithReadContext(() => {
      assert.equal(requestWrote(), false);
      markRequestWrote();
      assert.equal(requestWrote(), true, 'a write marks the request');
    });
    assert.equal(requestWrote(), false, 'the next request starts clean');
  });

  test('writes are recognised conservatively', () => {
    for (const write of [
      'INSERT INTO sales_invoices (id) VALUES ($1)',
      '  update t set a = 1',
      'DELETE FROM t',
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
      'BEGIN',
      'TRUNCATE t',
    ]) {
      assert.equal(isWriteStatement(write), true, `${write} must mark the request as a writer`);
    }
    for (const read of ['SELECT 1', ' select * from t', 'SHOW search_path', 'EXPLAIN SELECT 1', 'TABLE t']) {
      assert.equal(isWriteStatement(read), false, `${read} is a read`);
    }
    assert.equal(isWriteStatement('-- a comment\nSELECT 1'), false, 'a leading comment is not a statement');
  });

  test('the lag probe measures pending WAL, not idle time', () => {
    assert.match(REPLICA_HEALTH_SQL, /pg_is_in_recovery\(\)/);
    assert.match(REPLICA_HEALTH_SQL, /pg_last_wal_receive_lsn\(\) IS DISTINCT FROM pg_last_wal_replay_lsn\(\)/);
    assert.match(REPLICA_HEALTH_SQL, /pg_last_xact_replay_timestamp\(\)/);
    const parsed = parseReplicaHealth(
      { in_recovery: true, lag_bytes: '2048', lag_ms: '1500.5' },
      42
    );
    assert.deepEqual(parsed, { reachable: true, inRecovery: true, lagBytes: 2048, lagMs: 1500.5, probedAt: 42 });
    const idle = parseReplicaHealth({ in_recovery: true, lag_bytes: '0', lag_ms: '0' }, 43);
    assert.equal(idle.lagMs, 0, 'an idle but caught-up replica reports zero lag');
  });

  test('the router serves the replica, and falls back to the primary when it errors mid-read', async () => {
    const primary = pool('primary');
    const replica = pool('replica');
    let serving: 'ok' | 'failing' = 'ok';
    const router = createReadRouter({
      writePool: primary,
      readPool: {
        async query(text: string) {
          if (serving === 'failing' && !text.includes('pg_is_in_recovery() AS in_recovery')) {
            throw new Error('connection terminated');
          }
          return replica.query(text);
        },
      },
      maxLagMs: 5000,
      cooldownMs: 0,
      probeIntervalMs: 0,
    });

    const result = await router.query('SELECT pg_is_in_recovery()');
    assert.equal(result.rows[0].replica, true, 'a healthy replica serves the read');
    assert.equal(router.status().lastReason, 'replica');
    assert.ok(replica.calls.length >= 2, 'the replica was probed and then used');
    assert.equal(primary.calls.length, 0, 'the primary was untouched');

    serving = 'failing';
    const fallback = await router.query('SELECT 1');
    assert.equal(fallback.rows[0].replica, false, 'the failing replica read fell back to the primary');
    assert.equal(router.status().lastReason, 'replica-error');
    assert.equal(primary.calls.length, 1, 'the fallback ran on the primary');
  });

  test('the router never probes or reads a replica that is not configured', async () => {
    const primary = pool('primary');
    const router = createReadRouter({ writePool: primary, readPool: null });
    const result = await router.query('SELECT 1');
    assert.equal(result.rows[0].replica, false);
    assert.equal(router.status().configured, false);
    assert.equal(router.status().lastReason, 'no-replica');
    assert.equal(DEFAULT_REPLICA_MAX_LAG_MS, 5000, 'the documented default threshold');
  });

  test('a request that wrote goes to the primary without touching the replica', async () => {
    const primary = pool('primary');
    const replica = pool('replica');
    const router = createReadRouter({
      writePool: primary,
      readPool: replica,
      maxLagMs: 5000,
      probeIntervalMs: 0,
    });
    const result = await runWithReadContext(async () => {
      markRequestWrote();
      return router.query('SELECT 1');
    });
    assert.equal(result.rows[0].replica, false);
    assert.equal(router.status().lastReason, 'request-wrote');
    assert.equal(replica.calls.length, 0, 'a written request must not reach the replica at all');
  });
});
