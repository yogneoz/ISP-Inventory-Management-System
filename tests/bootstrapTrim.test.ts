/**
 * Bootstrap trim — stockOperations / purchaseOrders / purchaseInvoices no
 * longer ship in the GET /api/bootstrap payload (bootstrap trim continuation,
 * consumer-driven step).
 *
 * PROVES:
 *  1. SOURCE (no DB needed): the bootstrap controller no longer serializes
 *     the three ledger keys, and App.tsx wires the deferred slice hydration
 *     (DEFERRED_BOOTSTRAP_SLICES + a hydrateDeferredSlices call inside the
 *     full-bootstrap path) that keeps their wholesale consumers — dashboard
 *     KPIs, FY closing wizard, PI PO dropdown, movement ledger, StockOperations
 *     panels, global search — fed through GET /api/bootstrap/local.
 *  2. HTTP (real app + real PostgreSQL, skips without DATABASE_URL): the
 *     bootstrap response omits exactly those three keys while financialSummary
 *     (which still COMPUTES from them server-side) remains, and each key is
 *     served by the bootstrap/local slice endpoint the deferred hydration and
 *     the SSE targeted refresh both use.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

dotenv.config();

const ROOT = path.resolve('.');

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const TRIMMED_KEYS = ['stockOperations', 'purchaseOrders', 'purchaseInvoices'] as const;

const SUPER_USER = {
  id: 'bt-super', email: 'bt-super@example.com', name: 'BT Test',
  role: 'SUPER_ADMIN', branchId: 'WH001',
  allowedBranchIds: ['WH001'], canSwitchUser: false,
} as any;

describe('bootstrap trim: three ledgers out of the payload, deferred slices keep consumers fed', () => {
  test('source: bootstrap controller no longer serializes the three ledger keys', () => {
    const controller = fs.readFileSync(
      path.join(ROOT, 'server/src/controllers/bootstrap.controller.ts'),
      'utf8'
    );
    for (const pattern of [
      /purchaseOrders:\s*pgPurchaseOrders/,
      /purchaseInvoices:\s*pgInvoices/,
      /stockOperations:\s*pgOps/,
    ]) {
      assert.ok(
        !pattern.test(controller),
        `bootstrap response serializes a trimmed ledger again (${pattern}) — remove it from the payload and keep consumers on deferred slices`
      );
    }
    // The server-side financialSummary still COMPUTES from these tables, so
    // the underlying operational fetch must stay in place.
    assert.ok(
      /financialSummary/.test(controller),
      'financialSummary computation must remain in the bootstrap controller'
    );
  });

  test('source: App.tsx hydrates the deferred slices through the full-bootstrap path', () => {
    const app = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
    const sliceLine = app
      .split(/\r?\n/)
      .find((line) => line.includes('DEFERRED_BOOTSTRAP_SLICES = ['));
    assert.ok(sliceLine, 'App.tsx must declare DEFERRED_BOOTSTRAP_SLICES');
    for (const key of TRIMMED_KEYS) {
      assert.ok(
        sliceLine.includes(`'${key}'`),
        `DEFERRED_BOOTSTRAP_SLICES is missing '${key}' — its consumers would go stale`
      );
    }
    assert.ok(
      /hydrateDeferredSlices\(requestBranchId/.test(app),
      'refreshAllData must call hydrateDeferredSlices after applying the (now ledger-less) bootstrap payload'
    );
    assert.ok(
      /api\s*\n?\s*\.getLocalFor\(key, branchId, fiscalYearId\)/.test(app) ||
        /getLocalFor\(key, branchId, fiscalYearId\)/.test(app),
      'deferred hydration must go through getLocalFor (the same /api/bootstrap/local endpoint the SSE refresh uses)'
    );
  });

  describe('HTTP against real PostgreSQL', () => {
    let port = 0;
    let close: (() => Promise<void>) | null = null;
    const token = issueAuthToken(SUPER_USER);

    before(async () => {
      if (!dbReachable) return;
      const app = createApp();
      registerAllRoutes(app);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as any).port;
      close = () => new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
    });

    after(async () => {
      if (close) await close();
      if (pool && dbReachable) await pool.end();
    });

    async function get(urlPath: string) {
      const res = await fetch('http://127.0.0.1:' + port + urlPath, {
        headers: { authorization: 'Bearer ' + token },
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
      return { status: res.status, json };
    }

    test('GET /api/bootstrap omits the three ledgers but keeps financialSummary', { skip: skipNoDb }, async () => {
      const { status, json } = await get('/api/bootstrap');
      assert.equal(status, 200);
      assert.ok(json && typeof json === 'object', 'bootstrap must return a JSON object');
      for (const key of TRIMMED_KEYS) {
        assert.ok(!(key in json), `bootstrap payload still ships '${key}' — trim it and rely on deferred slices`);
      }
      assert.ok('financialSummary' in json, 'financialSummary must stay in the payload (computed server-side)');
      assert.ok(Array.isArray(json.stock), 'the rest of the payload must be intact');
      assert.ok(Array.isArray(json.shipments), 'the rest of the payload must be intact');
    });

    for (const key of TRIMMED_KEYS) {
      test(`GET /api/bootstrap/local?key=${key} still serves the deferred slice`, { skip: skipNoDb }, async () => {
        const { status, json } = await get(`/api/bootstrap/local?key=${key}`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(json?.[key]), `bootstrap/local must return the '${key}' rows for deferred hydration`);
        assert.ok(typeof json?.dataVersion === 'number', 'slice responses must carry dataVersion');
      });
    }
  });
});
