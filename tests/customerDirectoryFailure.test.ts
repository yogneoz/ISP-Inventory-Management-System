/**
 * Customer directory failure-path regressions (found by the 500-user retest).
 *
 * Two behaviours were wrong under a 500-request burst and are pinned here:
 *
 *  1. A CONNECT TIMEOUT IS NOT A DISCONNECT. pg-pool raises "timeout exceeded
 *     when trying to connect" when no client frees up within
 *     connectionTimeoutMillis. That error carries no SQLSTATE, so the old
 *     `!sqlState` fallback classified it as a broken connection, cleared the
 *     global PostgreSQL flag and answered 503 to every later request until a
 *     re-probe. The pool was merely busy: one request may fail, the flag must
 *     stay up.
 *
 *  2. NO DEMO ROWS ON A FAILED READ. GET /api/customers is the only customer
 *     read in the app. When the read failed while PostgreSQL was connected the
 *     handler fell through to the in-memory demo directory and answered 200
 *     with a plausible but wrong 80-customer list. It must answer a retryable
 *     503 instead, and only use the demo rows in demo mode (no database).
 *
 * The flag and 503 cases need a reachable PostgreSQL because they hold the
 * pool's only connection to force a real acquire timeout; they skip without
 * one, like the other database-backed suites. The classification table needs
 * no database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Set before importing the pool: a single connection (so holding it starves
// the next query) and a short acquire timeout (so the test does not wait 2 s).
// The same value also bounds the first connection's handshake, so it cannot be
// so short that a healthy local PostgreSQL fails to connect. dotenv does not
// overwrite variables already present, so these win over .env.
process.env.PG_POOL_MAX = '1';
process.env.PG_CONNECT_TIMEOUT_MS = '1000';

const {
  pgPool,
  realPoolInstance,
  setIsPgConnected,
  getIsPgConnected,
  isConnectionLevelFailure,
} = await import('../server/db');
const { setPgConnected } = await import('../server/src/app');
const { get_customers } = await import('../server/src/controllers/masterdata.controller');

// Resolved at module load, not in a before() hook: the skip option below is
// evaluated when the test is registered, so a hook that flips the flag later
// would leave every case permanently skipped.
let dbReachable = false;
if (realPoolInstance) {
  try {
    const client = await realPoolInstance.connect();
    client.release();
    dbReachable = true;
  } catch {
    dbReachable = false;
  }
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (forces a real pool acquire timeout)';

const SUPER_USER = { role: 'SUPER_ADMIN', branchId: 'FPBR', allowedBranchIds: [] };

describe('isConnectionLevelFailure — what counts as a lost database', () => {
  test('a pg-pool acquire timeout is NOT a disconnect', () => {
    assert.equal(
      isConnectionLevelFailure(new Error('timeout exceeded when trying to connect')),
      false,
      'a saturated pool must not be reported as a lost connection'
    );
  });

  test('broken sockets and server shutdown are disconnects', () => {
    assert.equal(isConnectionLevelFailure(Object.assign(new Error('terminating connection'), { code: '08006' })), true);
    assert.equal(isConnectionLevelFailure(Object.assign(new Error('starting up'), { code: '08001' })), true);
    assert.equal(isConnectionLevelFailure(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isConnectionLevelFailure(new Error('connect ECONNREFUSED 127.0.0.1:5432')), true);
    assert.equal(isConnectionLevelFailure(new Error('read ECONNRESET')), true);
  });

  test('a cancelled statement or a SQL error is not a disconnect', () => {
    assert.equal(
      isConnectionLevelFailure(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })),
      false,
      '57014 is a statement timeout, not a broken socket'
    );
    assert.equal(isConnectionLevelFailure(Object.assign(new Error('foreign key violation'), { code: '23503' })), false);
  });

  test('an unrecognised failure stays conservative: assume the connection is gone', () => {
    assert.equal(isConnectionLevelFailure(new Error('something else entirely')), true);
  });
});

describe('pgPool — connection flag under pool saturation', () => {
  test('a pool acquire timeout leaves the database marked as connected', { skip: skipNoDb }, async () => {
    setIsPgConnected(true);
    const held = await realPoolInstance.connect();
    let message = '';
    try {
      await pgPool.query('SELECT 1');
      assert.fail('the held connection should have starved the pool');
    } catch (err: any) {
      message = String(err?.message || '');
    } finally {
      held.release();
    }

    assert.match(message, /timeout exceeded when trying to connect/i);
    assert.equal(
      getIsPgConnected(),
      true,
      'one request may fail, but the global flag must stay up so the next request can use the pool'
    );
  });
});

describe('GET /api/customers — failed read', () => {
  test('answers a retryable 503, never the in-memory demo directory', { skip: skipNoDb }, async () => {
    setPgConnected(true);
    setIsPgConnected(true);

    const held = await realPoolInstance.connect();
    let statusCode = 200;
    let body: any = null;
    const res: any = {
      status(code: number) { statusCode = code; return res; },
      json(payload: any) { body = payload; return res; },
    };

    try {
      await get_customers({ query: { page: '1', pageSize: '15' }, user: SUPER_USER } as any, res);
    } finally {
      held.release();
    }

    assert.equal(statusCode, 503, 'a failed read is retryable, not a 200 with stand-in rows');
    assert.match(String(body?.message || ''), /temporarily unavailable/i);
    assert.equal(body?.data, undefined, 'the demo directory must not stand in for the national one');
    assert.equal(body?.totalItems, undefined);
    assert.equal(Array.isArray(body), false);
  });
});
