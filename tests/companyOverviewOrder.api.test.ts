/**
 * Company Overview role card order — real HTTP + PostgreSQL.
 *
 * The order is role-scoped: a Front Desk save may not rewrite the Auditor
 * order, a malformed order is refused, and a role that cannot open Company
 * Overview cannot change its order. The stored map is read back through the
 * same settings response the bootstrap and settings screens use.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { DEFAULT_COMPANY_OVERVIEW_CARD_ORDER } from '../shared/companyOverview';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const FRONT_DESK = {
  id: 'co-order-frontdesk',
  email: 'co-order-frontdesk@example.com',
  name: 'CO Order Front Desk',
  role: 'FRONT_DESK',
  branchId: 'BRH01',
  allowedBranchIds: ['BRH01'],
  canSwitchUser: false,
} as any;
const AUDITOR = { ...FRONT_DESK, id: 'co-order-auditor', email: 'co-order-auditor@example.com', role: 'AUDITOR' } as any;
const SELF_SERVICE = { ...FRONT_DESK, id: 'co-order-self', email: 'co-order-self@example.com', role: 'HR_SELF_SERVICE' } as any;
const SUPER = { ...FRONT_DESK, id: 'co-order-super', email: 'co-order-super@example.com', role: 'SUPER_ADMIN' } as any;

const TOKENS = {
  frontdesk: issueAuthToken(FRONT_DESK),
  auditor: issueAuthToken(AUDITOR),
  selfService: issueAuthToken(SELF_SERVICE),
  super: issueAuthToken(SUPER),
};

describe('Company Overview role card order API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let original: string | null = null;

  async function request(method: 'GET' | 'PUT' | 'DELETE', path: string, token: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  before(async () => {
    if (pool) {
      const existing = await pool.query(
        "SELECT setting_value FROM app_settings WHERE setting_key = 'companyOverviewCardOrderByRole'"
      );
      original = existing.rows[0]?.setting_value ?? null;
    }
    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      if (original === null) {
        await pool.query("DELETE FROM app_settings WHERE setting_key = 'companyOverviewCardOrderByRole'");
      } else {
        await pool.query(
          "UPDATE app_settings SET setting_value = $1 WHERE setting_key = 'companyOverviewCardOrderByRole'",
          [original]
        );
      }
      await pool.end();
    }
  });

  test('saves the caller role and preserves another role’s order', async () => {
    const frontDeskOrder = [
      'sales',
      'warehouse',
      'hr',
      'finance',
      'inventory',
      'procurement',
      'liquidity',
      'budget',
    ];
    const saved = await request('PUT', '/api/company-overview/card-order', TOKENS.frontdesk, {
      cardOrder: frontDeskOrder,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json.cardOrder, frontDeskOrder);

    const auditorOrder = [
      'hr',
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
      'sales',
    ];
    const savedAuditor = await request('PUT', '/api/company-overview/card-order', TOKENS.auditor, {
      cardOrder: auditorOrder,
    });
    assert.equal(savedAuditor.status, 200, JSON.stringify(savedAuditor.json));

    const settings = await request('GET', '/api/settings', TOKENS.super);
    assert.equal(settings.status, 200, JSON.stringify(settings.json));
    const stored = JSON.parse(settings.json.appSettings.companyOverviewCardOrderByRole);
    assert.deepEqual(stored.FRONT_DESK, frontDeskOrder);
    assert.deepEqual(stored.AUDITOR, auditorOrder);
  });

  test('resets only the caller role back to the default sequence', async () => {
    const frontDeskOrder = [
      'sales',
      'warehouse',
      'hr',
      'finance',
      'inventory',
      'procurement',
      'liquidity',
      'budget',
    ];
    const auditorOrder = [
      'hr',
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
      'sales',
    ];
    assert.equal(
      (await request('PUT', '/api/company-overview/card-order', TOKENS.frontdesk, {
        cardOrder: frontDeskOrder,
      })).status,
      200
    );
    assert.equal(
      (await request('PUT', '/api/company-overview/card-order', TOKENS.auditor, {
        cardOrder: auditorOrder,
      })).status,
      200
    );

    const reset = await request('DELETE', '/api/company-overview/card-order', TOKENS.frontdesk);
    assert.equal(reset.status, 200, JSON.stringify(reset.json));
    assert.deepEqual(reset.json.cardOrder, DEFAULT_COMPANY_OVERVIEW_CARD_ORDER);

    const settings = await request('GET', '/api/settings', TOKENS.super);
    const stored = JSON.parse(settings.json.appSettings.companyOverviewCardOrderByRole);
    assert.equal(stored.FRONT_DESK, undefined, 'the Front Desk saved order is cleared');
    assert.deepEqual(stored.AUDITOR, auditorOrder, 'the Auditor order is preserved');
  });

  test('refuses a malformed order and a role with no Company Overview access', async () => {
    const malformed = await request('PUT', '/api/company-overview/card-order', TOKENS.frontdesk, {
      cardOrder: ['sales', 'sales'],
    });
    assert.equal(malformed.status, 400, JSON.stringify(malformed.json));

    const forbidden = await request('PUT', '/api/company-overview/card-order', TOKENS.selfService, {
      cardOrder: ['finance', 'inventory', 'procurement', 'warehouse', 'liquidity', 'budget', 'sales', 'hr'],
    });
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.json));
  });
});
