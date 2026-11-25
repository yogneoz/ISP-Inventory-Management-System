/**
 * Transaction-retry counters — the monitoring half of the deadlock replay.
 *
 * The runner replays deadlock (40P01) and serialization-failure (40001)
 * victims, so a retry is expected behaviour; the counters make a rising rate
 * visible on `GET /api/health` without reading the log. These tests drive the
 * real `withTransaction` over a fake pooled connection, so no database is
 * needed (the health route is registered before the auth/DB gates).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pgPool } from '../server/db';
import { withReadReplay, withTransaction } from '../server/src/db/transactions';
import {
  resetTransactionRetryMetrics,
  transactionRetryMetrics,
} from '../server/src/db/transactionMetrics';

/** Swap the pool's connect() for a client whose queries all succeed. */
function stubPool() {
  const original = pgPool.connect;
  pgPool.connect = async () =>
    ({
      query: async () => ({ rows: [] }),
      release: () => {},
    }) as any;
  return () => {
    pgPool.connect = original;
  };
}

function abort(code: string, message = 'aborted') {
  return Object.assign(new Error(message), { code });
}

describe('transaction-retry counters', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    resetTransactionRetryMetrics();
    restore = stubPool();
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  test('a deadlock victim is replayed and counted as a deadlock retry', async () => {
    let attempts = 0;
    const result = await withTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw abort('40P01', 'deadlock detected');
      return 'committed';
    });

    assert.equal(result, 'committed');
    assert.equal(attempts, 2, 'the aborted attempt must be replayed exactly once');
    const metrics = transactionRetryMetrics();
    assert.equal(metrics.total, 1);
    assert.equal(metrics.deadlock, 1);
    assert.equal(metrics.serializationFailure, 0);
    assert.equal(metrics.lastCode, '40P01');
    assert.ok(metrics.lastRetryAt, 'the last retry must be timestamped');
  });

  test('a serialization failure is counted separately from a deadlock', async () => {
    let attempts = 0;
    await withTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw abort('40001', 'could not serialize access');
    });

    const metrics = transactionRetryMetrics();
    assert.equal(attempts, 2);
    assert.equal(metrics.total, 1);
    assert.equal(metrics.deadlock, 0);
    assert.equal(metrics.serializationFailure, 1);
    assert.equal(metrics.lastCode, '40001');
  });

  test('a statement read replays a deadlock victim through the same loop', async () => {
    let attempts = 0;
    const statement = await withReadReplay(async () => {
      attempts += 1;
      if (attempts === 1) throw abort('40P01', 'deadlock detected');
      return { totals: { closingDebit: 700 } };
    });

    assert.equal(statement.totals.closingDebit, 700, 'the replayed read returns its own result');
    assert.equal(attempts, 2, 'the deadlocked read must be replayed exactly once');
    // Same counters as the write path: a read victim is still contention.
    const metrics = transactionRetryMetrics();
    assert.equal(metrics.total, 1);
    assert.equal(metrics.deadlock, 1);
    assert.equal(metrics.lastCode, '40P01');
  });

  test('an ordinary database error is not retried and not counted', async () => {
    let attempts = 0;
    await assert.rejects(
      withTransaction(async () => {
        attempts += 1;
        throw abort('23505', 'duplicate key value');
      }),
      /duplicate key value/
    );

    assert.equal(attempts, 1, 'only deadlocks and serialization failures are replayable');
    const metrics = transactionRetryMetrics();
    assert.equal(metrics.total, 0);
    assert.equal(metrics.lastRetryAt, null);
    assert.equal(metrics.lastCode, null);
  });

  test('a transaction that deadlocks every time gives up after three attempts', async () => {
    let attempts = 0;
    await assert.rejects(
      withTransaction(async () => {
        attempts += 1;
        throw abort('40P01', 'deadlock detected');
      }),
      /deadlock detected/
    );

    assert.equal(attempts, 3);
    // Two retries were attempted; the third failure is thrown, not retried.
    const metrics = transactionRetryMetrics();
    assert.equal(metrics.total, 2);
    assert.equal(metrics.deadlock, 2);
  });

  test('GET /api/health reports the counters', async () => {
    let attempts = 0;
    await withTransaction(async () => {
      attempts += 1;
      if (attempts === 1) throw abort('40P01', 'deadlock detected');
    });
    assert.equal(attempts, 2);

    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const app = createApp();
    registerAllRoutes(app);
    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body: any = await res.json();
      assert.equal(body.status, 'ok');
      const reported = body.transactionRetries;
      assert.equal(reported.total, 1);
      assert.equal(reported.deadlock, 1);
      assert.equal(reported.serializationFailure, 0);
      assert.equal(reported.lastCode, '40P01');
      assert.equal(reported.lastRetryAt, transactionRetryMetrics().lastRetryAt);
    } finally {
      server.close();
    }
  });
});
