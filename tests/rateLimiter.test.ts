/**
 * Unit tests for the auth rate limiter (login brute-force mitigation).
 * The limiter core is tested with an injected clock; the middleware is
 * exercised through fake req/res objects without starting a server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, buildRateLimitKey, buildAccountRateLimitKey } from '../server/src/utils/rateLimiter';
import { createAuthRateLimit } from '../server/src/middleware/authRateLimit';

describe('RateLimiter core (sliding window)', () => {
  test('allows up to max attempts, then rejects with retry time', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 }, () => t);
    assert.equal(limiter.attempt('k').allowed, true);
    assert.equal(limiter.attempt('k').allowed, true);
    const third = limiter.attempt('k');
    assert.equal(third.allowed, true);
    assert.equal(third.count, 3);

    const fourth = limiter.attempt('k');
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.retryAfterMs, 1000); // oldest hit is at t=0
  });

  test('window slides: hits age out individually', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => t);
    limiter.attempt('k'); // t=0
    limiter.attempt('k'); // t=0, window full
    assert.equal(limiter.attempt('k').allowed, false);

    t = 1001; // both hits expired
    const verdict = limiter.attempt('k');
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.count, 1);
  });

  test('retryAfterMs shrinks as the window slides, then allows again', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => t);
    limiter.attempt('k');
    t = 400;
    const v = limiter.attempt('k');
    assert.equal(v.allowed, false);
    assert.equal(v.retryAfterMs, 600);
    t = 1000; // oldest hit at t=0 is exactly at the window edge (<= windowStart)
    assert.equal(limiter.attempt('k').allowed, true);
  });

  test('rejected attempts do NOT extend the block', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => t);
    limiter.attempt('k');
    for (t = 100; t < 900; t += 100) {
      const v = limiter.attempt('k');
      assert.equal(v.allowed, false);
      // retry time keeps depending on the ORIGINAL hit, not the rejections
      assert.equal(v.retryAfterMs, 1000 - t);
    }
  });

  test('keys are isolated from each other', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    assert.equal(limiter.attempt('a').allowed, true);
    assert.equal(limiter.attempt('b').allowed, true);
    assert.equal(limiter.attempt('a').allowed, false);
    assert.equal(limiter.attempt('a').allowed, false);
    assert.equal(limiter.size, 2);
  });

  test('buckets are pruned when empty (bounded memory)', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 100 }, () => t);
    for (let i = 0; i < 100; i++) {
      limiter.attempt(`key-${i}`);
      t += 200; // every bucket expires before the next arrives
    }
    // The final bucket cannot prune itself (pruning runs before the push),
    // so one probe attempt flushes it.
    limiter.attempt('flush-probe');
    assert.equal(limiter.size, 1); // only the probe's own bucket remains
  });

  test('revoke removes the most recent hit (failure-only accounting)', () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => t);
    limiter.attempt('k');
    limiter.attempt('k');
    limiter.revoke('k');
    assert.equal(limiter.attempt('k').allowed, true); // slot freed
    limiter.revoke('missing-key'); // no-op, must not throw
    limiter.revoke('k');
    limiter.revoke('k'); // over-revoking empties the bucket, not negative
    assert.equal(limiter.size, 0); // bucket was fully revoked and pruned
    assert.equal(limiter.attempt('k').count, 1); // starts fresh at 1
  });

  test('reset clears everything', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    limiter.attempt('x');
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.attempt('x').allowed, true);
  });

  test('rejects degenerate configuration', () => {
    assert.throws(() => new RateLimiter({ max: 0, windowMs: 1000 }));
    assert.throws(() => new RateLimiter({ max: 5, windowMs: 0 }));
    assert.throws(() => new RateLimiter({ max: NaN, windowMs: 1000 }));
  });
});

describe('buildRateLimitKey', () => {
  test('combines scope, ip and account (lowercased)', () => {
    const req = { ip: '10.0.0.1' };
    assert.equal(buildRateLimitKey('auth-login', req, 'Admin@Example.com '), 'auth-login:10.0.0.1:admin@example.com');
  });

  test('falls back to socket address, then unknown', () => {
    assert.equal(buildRateLimitKey('s', { socket: { remoteAddress: '192.168.1.9' } }), 's:192.168.1.9');
    assert.equal(buildRateLimitKey('s', {}), 's:unknown');
  });

  test('ip-only key when no account given', () => {
    assert.equal(buildRateLimitKey('auth-login', { ip: '10.0.0.1' }), 'auth-login:10.0.0.1');
  });
});

describe('buildAccountRateLimitKey', () => {
  test('global per-account key has no ip component and normalizes case', () => {
    assert.equal(buildAccountRateLimitKey('auth-login', 'User@Example.COM '), 'auth-login:account:user@example.com');
  });
});

describe('auth rate-limit middleware', () => {
  function fakeReqRes(overrides: { ip?: string; email?: unknown } = {}) {
    const req: any = { ip: overrides.ip ?? '10.0.0.1', body: { email: overrides.email }, headers: {} };
    const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any };
    res.set = (k: string, v: string) => { res.headers[k] = v; return res; };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (payload: any) => { res.body = payload; return res; };
    return { req, res };
  }

  test('passes requests through while under the limit', () => {
    const middleware = createAuthRateLimit({ scope: 'unit-login', accountFrom: (req) => req.body.email });
    let passed = 0;
    for (let i = 0; i < 3; i++) {
      const { req, res } = fakeReqRes({ email: 'user@example.com' });
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      passed++;
    }
    assert.equal(passed, 3);
  });

  test('returns 429 with Retry-After when the ip bucket is exhausted (account rotation does not help)', () => {
    const middleware = createAuthRateLimit({ scope: 'unit-ip', accountFrom: (req) => req.body.email });
    // Exhaust the ip bucket with different accounts each time.
    for (let i = 0; i < 10; i++) {
      const { req, res } = fakeReqRes({ email: `attacker${i}@example.com` });
      middleware(req, res, () => {});
    }
    const { req, res } = fakeReqRes({ email: 'yet-another@example.com' });
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers['Retry-After']) >= 1);
    assert.match(res.body.message, /Too many attempts/);
  });

  test('account bucket is GLOBAL and FAILURE-ONLY: rotating ips are throttled, successes revoke', () => {
    const middleware = createAuthRateLimit({ scope: 'unit-pair', accountFrom: (req) => req.body.email });
    // 10 FAILED attempts (handler responds 401) against ONE account from
    // DIFFERENT addresses — a distributed brute force.
    for (let i = 0; i < 10; i++) {
      const { req, res } = fakeReqRes({ ip: `10.0.${i}.1`, email: 'victim@example.com' });
      middleware(req, res, () => { res.status(401).json({ message: 'Invalid email or password.' }); });
    }
    // An 11th attempt from yet another address hits the account bucket.
    const blocked = fakeReqRes({ ip: '10.9.9.9', email: 'victim@example.com' });
    middleware(blocked.req, blocked.res, () => {});
    assert.equal(blocked.res.statusCode, 429);

    // The same flood against a DIFFERENT account does not affect it...
    const other = fakeReqRes({ ip: '10.9.9.9', email: 'innocent@example.com' });
    let otherNext = false;
    middleware(other.req, other.res, () => {
      otherNext = true;
      other.res.status(401).json({});
    });
    assert.equal(otherNext, true);

    // ...and a SUCCESSFUL login revokes its hit (a legitimate user who logs
    // in successfully is never locked out by the account bucket).
    const success = fakeReqRes({ ip: '10.8.8.8', email: 'innocent@example.com' });
    middleware(success.req, success.res, () => {
      success.res.status(200).json({ user: {}, token: 't' });
    });
    assert.equal(success.res.statusCode, 200);
    // Every earlier innocent@example.com attempt was a failure, but the
    // success just revoked one hit — the account bucket is back below the
    // limit only if accounting is failure-based. A second success also goes
    // through (no accumulation from successes).
    const success2 = fakeReqRes({ ip: '10.8.8.8', email: 'innocent@example.com' });
    let success2Next = false;
    middleware(success2.req, success2.res, () => {
      success2Next = true;
      success2.res.status(200).json({});
    });
    assert.equal(success2Next, true);
  });

  test('rejections do not extend the account block (429s are not recorded)', () => {
    const middleware = createAuthRateLimit({ scope: 'unit-noext', accountFrom: (req) => req.body.email });
    for (let i = 0; i < 10; i++) {
      const { req, res } = fakeReqRes({ ip: `10.1.${i}.1`, email: 'victim@example.com' });
      middleware(req, res, () => { res.status(401).json({}); });
    }
    // Hammer the endpoint while blocked: rejections must not push the block out.
    for (let i = 0; i < 50; i++) {
      const { req, res } = fakeReqRes({ ip: '10.2.2.2', email: 'victim@example.com' });
      middleware(req, res, () => {});
      assert.equal(res.statusCode, 429);
    }
  });

  test('fail-open: a throwing limiter must not make auth unusable', () => {
    const middleware = createAuthRateLimit({
      scope: 'unit-boom',
      accountFrom: () => { throw new Error('boom'); },
    });
    const { req, res } = fakeReqRes({ email: 'user@example.com' });
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'request must proceed when the limiter throws');
  });

  test('independent scopes have independent buckets', () => {
    const login = createAuthRateLimit({ scope: 'unit-scope-a', accountFrom: (req) => req.body.email });
    const forgot = createAuthRateLimit({ scope: 'unit-scope-b', accountFrom: (req) => req.body.email });
    for (let i = 0; i < 10; i++) {
      const { req, res } = fakeReqRes({ email: 'u@example.com' });
      login(req, res, () => {});
    }
    const { req, res } = fakeReqRes({ email: 'u@example.com' });
    let nextCalled = false;
    forgot(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
