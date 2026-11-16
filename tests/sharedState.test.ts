/**
 * SCALE-1 — two independent "workers" share one store.
 *
 * These are the multi-worker proofs, not the single-process fallbacks:
 *   1. a rate-limit budget consumed on worker A is enforced on worker B;
 *   2. revocation changes the fingerprint visible to B, not only A;
 *   3. a lock acquired on A is refused on B and its fencing token advances;
 *   4. an SSE event published by A reaches a client on B;
 *   5. a failing shared limiter fails closed instead of silently admitting.
 *
 * The store is a MemorySharedStore in Redis mode: independent limiter/session/
 * bus instances exercise the same shared contract without requiring a Redis
 * daemon on the test host. The Redis implementation uses the same Lua/ZSET
 * operations in sharedStore.ts.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemorySharedStore, configureSharedStore, isRedisSharedState, getSharedStore } from '../server/src/state/sharedStore';
import { SharedRateLimiter } from '../server/src/state/sharedRateLimiter';
import { sessionFingerprint } from '../server/src/middleware/auth';
import { rememberSessionVersion, sessionStillValidShared } from '../server/src/state/sessionVersion';
import { createSharedLock, withStartupLeadership } from '../server/src/state/sharedLock';
import { createAuthRateLimit } from '../server/src/middleware/authRateLimit';
import { createSseBus, createSseHub } from '../server/src/realtime/sse';

let store: MemorySharedStore;

beforeEach(() => {
  store = new MemorySharedStore('redis');
  configureSharedStore(store);
});

afterEach(async () => {
  await store.close();
  configureSharedStore(new MemorySharedStore());
});

describe('SCALE-1 shared rate limits', () => {
  test('a budget consumed on worker A is enforced on worker B', async () => {
    const a = new SharedRateLimiter(store, { max: 3, windowMs: 60_000 });
    const b = new SharedRateLimiter(store, { max: 3, windowMs: 60_000 });
    assert.equal((await a.attempt('auth-login:10.0.0.1')).allowed, true);
    assert.equal((await a.attempt('auth-login:10.0.0.1')).allowed, true);
    assert.equal((await b.attempt('auth-login:10.0.0.1')).allowed, true);
    const blocked = await b.attempt('auth-login:10.0.0.1');
    assert.equal(blocked.allowed, false, 'worker B must see worker A attempts');
    assert.equal(blocked.count, 3);
    assert.ok(blocked.retryAfterMs > 0);
  });

  test('a shared release clears the bucket for every worker', async () => {
    const a = new SharedRateLimiter(store, { max: 1, windowMs: 60_000 });
    const b = new SharedRateLimiter(store, { max: 1, windowMs: 60_000 });
    await a.attempt('auth-login:10.0.0.2');
    assert.equal((await b.attempt('auth-login:10.0.0.2')).allowed, false);
    await a.clearMatching((key) => key === 'auth-login:10.0.0.2');
    assert.equal((await b.attempt('auth-login:10.0.0.2')).allowed, true);
  });

  test('shared state is reported as Redis-backed', () => {
    assert.equal(isRedisSharedState(), true);
    assert.equal(getSharedStore().kind, 'redis');
  });

  test('a failing shared limiter throws so auth can fail closed', async () => {
    const broken = new MemorySharedStore('redis');
    broken.rateAttempt = async () => { throw new Error('redis down'); };
    const limiter = new SharedRateLimiter(broken, { max: 1, windowMs: 60_000 });
    await assert.rejects(() => limiter.attempt('auth-login:10.0.0.3'), /redis down/);
  });

  test('the middleware budget is shared across two worker instances', async () => {
    const workerA = createAuthRateLimit({ scope: 'shared-login', accountFrom: (req: any) => req.body.email });
    const workerB = createAuthRateLimit({ scope: 'shared-login', accountFrom: (req: any) => req.body.email });
    const res = () => {
      const r: any = { statusCode: 200, headers: {}, body: undefined };
      r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
      r.status = (c: number) => { r.statusCode = c; return r; };
      r.json = (b: any) => { r.body = b; return r; };
      return r;
    };
    for (let i = 0; i < 10; i++) {
      const r = res();
      workerA({ ip: '10.9.0.1', body: { email: `fill${i}@example.com` }, headers: {} } as any, r, () => {});
      await new Promise((tick) => setImmediate(tick));
    }
    const blocked = res();
    let passed = false;
    workerB({ ip: '10.9.0.1', body: { email: 'another@example.com' }, headers: {} } as any, blocked, () => { passed = true; });
    await new Promise((tick) => setImmediate(tick));
    assert.equal(passed, false, 'worker B must inherit worker A\'s address budget');
    assert.equal(blocked.statusCode, 429);
  });
});

describe('SCALE-1 shared session revocation', () => {
  const user: any = {
    id: 'u-scale-1',
    email: 'scale@example.com',
    password: 'scrypt$salt$hash',
    role: 'CASHIER' as const,
    branchId: 'b1',
    allowedBranchIds: [],
    canSwitchUser: false,
    status: 'active',
  };
  const oldToken = { id: user.id, ver: sessionFingerprint(user) };

  test('a fingerprint written on worker A is checked on worker B', async () => {
    await rememberSessionVersion(user);
    assert.equal(await sessionStillValidShared(oldToken, [user]), true);

    const demolished = { ...user, role: 'FRONT_DESK' as const };
    const newToken = { id: user.id, ver: sessionFingerprint(demolished) };
    await rememberSessionVersion(demolished);
    // Worker B has a stale local cache row, but Redis is the authority: the
    // old token fails and the token minted after the role change succeeds.
    assert.equal(await sessionStillValidShared(oldToken, [demolished]), false);
    assert.equal(await sessionStillValidShared(newToken, [demolished]), true);
  });

  test('a deactivated row is refused before any shared lookup', async () => {
    assert.equal(
      await sessionStillValidShared(oldToken, [{ ...user, status: 'inactive' }]),
      false
    );
  });
});

describe('SCALE-1 locks and fencing', () => {
  test('only one of two booting workers runs the startup job', async () => {
    let runs = 0;
    const job = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'done';
    };
    const [a, b] = await Promise.all([
      withStartupLeadership('schema-test', job),
      withStartupLeadership('schema-test', job),
    ]);
    assert.equal(runs, 1, 'the follower must skip the duplicate job');
    assert.deepEqual([a.leader, b.leader].sort(), [false, true]);
  });
  test('a lock acquired on A is refused on B and fences each owner', async () => {
    const a = createSharedLock();
    const b = createSharedLock();
    const leaseA = await a.acquire('demo-clear', 60_000);
    assert.ok(leaseA, 'A acquires the free lock');
    assert.equal(await b.acquire('demo-clear', 60_000), null, 'B must not enter the same job');
    assert.equal(leaseA.fencingToken, 1);

    assert.equal(await a.release(leaseA!), true);
    const leaseB = await b.acquire('demo-clear', 60_000);
    assert.ok(leaseB, 'B acquires after A releases');
    assert.equal(leaseB.fencingToken, 2, 'fencing token advances, so a late A cannot win');
    await b.release(leaseB!);
  });

  test('a non-owner cannot release a lock', async () => {
    const a = createSharedLock();
    const lease = await a.acquire('retention', 60_000);
    assert.ok(lease);
    assert.equal(await a.release({ ...lease!, owner: 'someone-else' }), false);
    assert.equal(await a.release(lease!), true);
  });
});

describe('SCALE-1 SSE fan-out', () => {
  test('a write on worker A reaches a client on worker B', async () => {
    const hubA = createSseHub();
    const hubB = createSseHub();
    const busA = createSseBus(hubA, store, 'worker-a');
    const busB = createSseBus(hubB, store, 'worker-b');
    await busA.startSubscriber();
    await busB.startSubscriber();

    const writes: string[] = [];
    hubB.clients.add({ write: (chunk: string) => { writes.push(chunk); } } as any);
    busA.broadcastChange({ type: 'SALE_CREATED', entity: 'SALES', branchId: 'b1' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(writes.length, 1, 'B must receive A\'s event through the shared channel');
    assert.match(writes[0], /SALE_CREATED/);
    assert.match(writes[0], /"domain"/);
    assert.match(writes[0], /"dataVersion"/);
  });
});
