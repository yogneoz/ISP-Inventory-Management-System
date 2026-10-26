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
 *     bootstrap response omits exactly those three keys and the unread
 *     vendorPayments array, while financialSummary (aggregated in SQL since
 *     BOOT-1) remains, and each key is served by the bootstrap/local slice
 *     endpoint the deferred hydration and the SSE targeted refresh both use.
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
import { ensureReferenceData } from './fixtures/referenceData';

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
const UNSHIPPED_PAYMENTS = 'vendorPayments';

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
    // Scope the check to the response payload. BOOT-1 removed those ledger
    // queries from the fan-out entirely, so this guard now also pins that no
    // serialized ledger key comes back through a differently named binding.
    const payload = controller.slice(
      controller.lastIndexOf('return res.json({'),
      controller.lastIndexOf('} catch')
    );
    for (const pattern of [
      /purchaseOrders:\s*pgPurchaseOrders/,
      /purchaseInvoices:\s*pgInvoices/,
      /stockOperations:\s*pgOps/,
    ]) {
      assert.ok(
        !pattern.test(payload),
        `bootstrap response serializes a trimmed ledger again (${pattern}) — remove it from the payload and keep consumers on deferred slices`
      );
    }
    // BOOT-1 moved the summary to aggregate SQL, so the ledger fetches no
    // longer exist; the summary itself must still be present.
    assert.ok(
      /fetchFinancialSummaryFromDb\(pgPool, \{/.test(controller),
      'financialSummary must be served by the aggregate SQL producer'
    );
    assert.ok(
      !/fetchTable\(pool, BOOTSTRAP_TABLES\.(purchaseOrders|purchaseInvoices|stockOperations|vendorPayments|shipments)/.test(
        fs.readFileSync(path.join(ROOT, 'server/src/models/bootstrap.repo.ts'), 'utf8')
      ),
      'the bootstrap fan-out must not read an unshipped ledger again'
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
      // GET /api/bootstrap scopes its payload to the active fiscal year, so the
      // reference data a booted install has (fiscal-year master + branch master)
      // must exist: against a schema-only CI database the controller had no
      // fiscal year to scope to and answered 503.
      await ensureReferenceData(pool!);
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

    test('GET /api/bootstrap omits the three ledgers and vendorPayments but keeps financialSummary', { skip: skipNoDb }, async () => {
      const { status, json } = await get('/api/bootstrap');
      assert.equal(status, 200);
      assert.ok(json && typeof json === 'object', 'bootstrap must return a JSON object');
      for (const key of TRIMMED_KEYS) {
        assert.ok(!(key in json), `bootstrap payload still ships '${key}' — trim it and rely on deferred slices`);
      }
      assert.ok(!(UNSHIPPED_PAYMENTS in json), 'the client never read vendorPayments; it must not ship');
      assert.ok('financialSummary' in json, 'financialSummary must stay in the payload (computed server-side)');
      assert.ok(Array.isArray(json.stock), 'the rest of the payload must be intact');
      // VOL-3: the transfer register pages its own reads and the shell/KPI
      // surfaces read the scoped overview, so the fiscal year's dispatch
      // history no longer enters the login payload.
      assert.ok(!('shipments' in json), 'shipments must be served by /api/shipments/page + /overview, not bootstrap');
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
