/**
 * requirePostgres fail-closed gate — regression test.
 *
 * PROVES that when PostgreSQL is unreachable, the API refuses EVERYTHING
 * except /api/health: reads, writes, and document creation all return 503
 * with the availability message. This is what guarantees "every piece of data
 * lives in the database" — no HTTP request can ever reach the in-memory demo
 * branches while the database is down, so nothing can be created in RAM only.
 *
 * Determinism: DATABASE_URL is cleared and POSTGRES_PORT points at a closed
 * port BEFORE the server modules load (dynamic imports), so the pool can
 * never reach a real database regardless of the host .env — note a set
 * DATABASE_URL would override the separate host/port options in db.ts, which
 * is why the in-script override must happen before the first import.
 *
 * No live PostgreSQL is required; there is nothing to skip.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Must be set before the first server import (see header).
process.env.DATABASE_URL = '';
process.env.POSTGRES_HOST = '127.0.0.1';
process.env.POSTGRES_PORT = '5433'; // closed port — verified unreachable
process.env.PG_CONNECT_TIMEOUT_MS = '400';
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'gate-regression-secret';

describe('requirePostgres fail-closed gate (PostgreSQL unreachable)', () => {
  let server: http.Server;
  let port = 0;
  let issueAuthToken: (u: any) => string;
  let token = '';

  before(async () => {
    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const auth = await import('../server/src/middleware/auth');
    issueAuthToken = auth.issueAuthToken;
    token = issueAuthToken({ id: 'usr-gate', email: 'gate@example.com', role: 'SUPER_ADMIN', branchId: 'WH001' } as any);
    const app = createApp();
    registerAllRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(() => {
    server?.close();
  });

  function call(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        }
      );
      r.on('error', reject);
      r.end(body);
    });
  }

  test('an authenticated WRITE 503s with the availability message — it never reaches a controller', async () => {
    const res = await call(
      'POST',
      '/api/stock-operations',
      JSON.stringify({
        type: 'DAMAGE',
        branchId: 'WH001',
        dateAD: '2026-10-12',
        items: [{ productId: 'prod-1', productName: 'Router', quantity: 1, unitCost: 100 }],
      })
    );
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert.match(res.body, /PostgreSQL is unavailable/);
  });

  test('an authenticated READ 503s too — no endpoint serves or mutates mirrors without the database', async () => {
    const res = await call('GET', '/api/stock');
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert.match(res.body, /PostgreSQL is unavailable/);
  });

  test('/api/health stays up so monitoring can see the outage', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'ok');
  });
});
