/**
 * OPS-2 — bootstrap ETag and 304 before the queries.
 *
 * PROVES, over real HTTP against a real PostgreSQL:
 *   1. the first GET is 200 with a weak ETag derived from the payload version
 *      and the personal scope, plus Cache-Control private/no-cache and
 *      Vary: Authorization, Accept-Encoding;
 *   2. the same GET with If-None-Match is 304, has an empty body, keeps the
 *      same ETag, is not compressed, and executes NO bootstrap query;
 *   3. a stale or missing validator gets the full 200 payload again;
 *   4. a different branch scope gets a different validator;
 *   5. a real write (PUT /api/company-profile) bumps stateVersion through the
 *      single post-write middleware, so the same GET with the old validator
 *      returns 200 with a new ETag and the changed company profile.
 *
 * The 304-without-a-query assertion wraps pgPool.query for exactly that
 * request; it does not rely on timing or a sleep.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';
import * as db from '../server/db';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (real bootstrap payload)';

const SUPER_USER = {
  id: 'etag-super',
  email: 'etag-super@example.com',
  name: 'ETag Test',
  role: 'SUPER_ADMIN',
  branchId: 'WH001',
  allowedBranchIds: ['WH001'],
  canSwitchUser: false,
} as any;

describe('GET /api/bootstrap — ETag and conditional requests', () => {
  let server: http.Server | null = null;
  let port = 0;
  const token = issueAuthToken(SUPER_USER);
  const base = () => `http://127.0.0.1:${port}`;

  before(async () => {
    if (!dbReachable) return;
    await ensureReferenceData(pool!);
    const app = createApp();
    registerAllRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server!.address() as any).port;
  });

  after(async () => {
    if (server) {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (pool && dbReachable) await pool.end();
  });

  async function request(
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // a non-JSON body is itself a finding; the raw text is returned
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  let firstEtag = '';
  let firstPayload: any = null;

  test('first GET: 200, weak ETag, private/no-cache, Vary for auth and compression', { skip: skipNoDb }, async () => {
    const res = await request('/api/bootstrap');
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(res.json && typeof res.json === 'object');

    firstEtag = res.headers.get('etag') || '';
    firstPayload = res.json;
    assert.match(firstEtag, /^W\/"[^"]+"$/, 'ETag must be a weak validator');
    assert.match(firstEtag, /^W\/"\d+-[0-9a-f]{40}"$/, 'ETag = stateVersion + sha1(scope)');

    const cacheControl = (res.headers.get('cache-control') || '').toLowerCase();
    assert.match(cacheControl, /private/);
    assert.match(cacheControl, /no-cache/);

    const vary = (res.headers.get('vary') || '').toLowerCase();
    assert.match(vary, /authorization/);
    assert.match(vary, /accept-encoding/);
  });

  test('matching If-None-Match: 304, empty body, same ETag, no query, not compressed', { skip: skipNoDb }, async () => {
    assert.ok(firstEtag, 'the first GET must have produced an ETag');

    const originalQuery = db.pgPool.query;
    let queries = 0;
    (db.pgPool as any).query = function (...args: any[]) {
      queries += 1;
      return (originalQuery as any).apply(db.pgPool as any, args);
    };
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request('/api/bootstrap', { headers: { 'if-none-match': firstEtag } });
    } finally {
      (db.pgPool as any).query = originalQuery;
    }

    assert.equal(res.status, 304, res.text.slice(0, 200));
    assert.equal(res.text, '', '304 must carry no body');
    assert.equal(res.headers.get('etag'), firstEtag);
    assert.equal(res.headers.get('content-encoding'), null, '304 must not be compressed');
    assert.equal(queries, 0, 'the validator must be checked before the first bootstrap query');
  });

  test('stale If-None-Match: full 200 payload with the current validator', { skip: skipNoDb }, async () => {
    const res = await request('/api/bootstrap', { headers: { 'if-none-match': 'W/"stale-value"' } });
    assert.equal(res.status, 200);
    assert.ok(res.json && typeof res.json === 'object');
    assert.equal(res.headers.get('etag'), firstEtag);
    assert.ok(res.text.length > 0);
  });

  test('a different branch or fiscal-year scope gets a different validator', { skip: skipNoDb }, async () => {
    const branchRes = await request('/api/bootstrap?branchId=WH001');
    assert.equal(branchRes.status, 200);
    const branchEtag = branchRes.headers.get('etag');
    assert.ok(branchEtag);
    assert.notEqual(branchEtag, firstEtag, 'the ETag must include branchId');

    const fiscalYearId = firstPayload?.fiscalYears?.[0]?.id;
    if (fiscalYearId) {
      const fyRes = await request(`/api/bootstrap?fiscalYearId=${encodeURIComponent(fiscalYearId)}`);
      assert.equal(fyRes.status, 200);
      assert.ok(fyRes.headers.get('etag'));
      assert.notEqual(fyRes.headers.get('etag'), firstEtag, 'the ETag must include fiscalYearId');
    }
  });

  test('a real write bumps stateVersion: old validator -> 200, new ETag, changed payload', { skip: skipNoDb }, async () => {
    const before = await request('/api/bootstrap');
    assert.equal(before.status, 200);
    const oldEtag = before.headers.get('etag') || '';
    const originalName = before.json?.companyProfile?.name;
    assert.ok(oldEtag);
    assert.equal(typeof originalName, 'string');

    const newName = `OPS-2 ETag ${Date.now()}`;
    const write = await request('/api/company-profile', {
      method: 'PUT',
      body: JSON.stringify({ name: newName }),
    });
    assert.equal(write.status, 200, write.text.slice(0, 300));

    // The bump is attached to the response's finish event; flush the event
    // loop rather than sleeping.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const after = await request('/api/bootstrap', { headers: { 'if-none-match': oldEtag } });
    assert.equal(after.status, 200, 'a write must invalidate the cached validator');
    const newEtag = after.headers.get('etag') || '';
    assert.ok(newEtag);
    assert.notEqual(newEtag, oldEtag);
    assert.equal(after.json?.companyProfile?.name, newName, 'the payload must reflect the write');

    // Leave the shared test database as it was found.
    await request('/api/company-profile', {
      method: 'PUT',
      body: JSON.stringify({ name: originalName }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
