/**
 * ACC-6 — default trade groups and the chart health report.
 *
 * Real Express app against a throwaway PostgreSQL database. The suite pins:
 *   - Trade Receivables / Trade Payables are groups in the one hierarchy, with
 *     the AR/AP control ledgers underneath them (no per-customer GL account);
 *   - chart health reports a posted subledger row that lost its book link;
 *   - provider settlement reconciliation is a required month-end close task.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';

dotenv.config();

const TEST_DB = 'inventory_acc6_chart_test';
const BRANCH = 'WH001';
const JOURNAL_DATE = '2026-11-02';
const PARTY_ID = 'ACC6-CUST';

let appDbReachable = false;
if (process.env.DATABASE_URL) {
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    appDbReachable = true;
  } catch {
    appDbReachable = false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
const skipNoDb = !appDbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

describe('ACC-6 chart governance (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let throwaway: ThrowawayDatabase | null = null;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let token = '';
  let arId = '';
  let salesId = '';
  let periodId = '';

  async function request(method: 'GET' | 'POST', pathName: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + pathName, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  before(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) return;
    throwaway = await createThrowawayDatabase(base, TEST_DB);
    process.env.DATABASE_URL = throwaway.url;

    const { createApp, registerAllRoutes } = await import('../server/src/app');
    const { realPoolInstance, ensurePostgresConnection } = await import('../server/db');
    realPoolInstance?.on?.('error', () => undefined);
    assert.equal(await ensurePostgresConnection(), true, 'the throwaway database must be reachable');

    const { ensureReferenceData, ensureBsDayRecords } = await import('./fixtures/referenceData');
    const { issueAuthToken } = await import('../server/src/middleware/auth');
    const { setPermissionMatrix } = await import('../server/src/state/runtimeState');
    const { DEFAULT_PERMISSIONS_MATRIX } = await import('../client/src/utils/permissionMatrixData');

    await ensureReferenceData(throwaway.pool, JOURNAL_DATE);
    const novemberDays = Array.from(
      { length: 30 },
      (_, index) => `2026-11-${String(index + 1).padStart(2, '0')}`
    );
    await ensureBsDayRecords(throwaway.pool, novemberDays);
    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    token = issueAuthToken({
      id: 'acc6-super',
      email: 'acc6-super@example.com',
      name: 'ACC6 Super',
      role: 'SUPER_ADMIN',
      branchId: 'ALL',
      allowedBranchIds: [],
      canSwitchUser: false,
    } as any);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    closeServer = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const defaults = await request('GET', '/api/accounting/posting-defaults');
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    arId = defaults.json.defaults.AR_CONTROL.accountId;
    salesId = defaults.json.defaults.SALES.accountId;

    const createdPeriod = await request('POST', '/api/accounting/periods', { periodKey: '2026-11' });
    assert.equal(createdPeriod.status, 201, JSON.stringify(createdPeriod.json));
    periodId = createdPeriod.json.id;
    assert.ok(periodId, 'the close checklist needs a concrete period');
  });

  after(async () => {
    if (closeServer) await closeServer();
    if (throwaway) await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
  });

  test('the default chart nests AR and AP controls under trade groups', async () => {
    const groups = (await request('GET', '/api/accounting/groups')).json as any[];
    const accounts = (await request('GET', '/api/accounting/accounts?includeInactive=1')).json as any[];

    const receivables = groups.find((group) => group.code === '1110');
    const payables = groups.find((group) => group.code === '2110');
    assert.ok(receivables, 'Trade Receivables must be a group');
    assert.ok(payables, 'Trade Payables must be a group');
    assert.equal(receivables.name, 'Trade Receivables');
    assert.equal(payables.name, 'Trade Payables');
    assert.equal(receivables.parentId, groups.find((group) => group.code === '1000').id);
    assert.equal(payables.parentId, groups.find((group) => group.code === '2000').id);

    const ar = accounts.find((account) => account.code === '1100');
    const ap = accounts.find((account) => account.code === '2100');
    assert.equal(ar.groupCode, '1110');
    assert.equal(ap.groupCode, '2110');
    assert.equal(ar.isControl, true);
    assert.equal(ap.isControl, true);
    assert.equal(
      accounts.some((account) => account.code.startsWith('CUST-')),
      false,
      'customers must never become GL accounts'
    );
  });

  test('chart health reports an unlinked posted subledger row', async () => {
    const clean = await request('GET', '/api/accounting/chart-health');
    assert.equal(clean.status, 200, JSON.stringify(clean.json));
    assert.equal(clean.json.unlinkedSubledgerRows.count, 0);
    assert.deepEqual(clean.json.unlinkedSubledgerRows.rows, []);

    const posted = await request('POST', '/api/accounting/journals', {
      journalDateAD: JOURNAL_DATE,
      branchId: BRANCH,
      memo: 'ACC-6 health probe',
      sourceType: 'SALES_INVOICE',
      sourceId: 'acc6-health-1',
      lines: [
        { accountId: arId, debit: 50, credit: 0, subledgerType: 'CUSTOMER', partyId: PARTY_ID, partyName: 'ACC6 Customer' },
        { accountId: salesId, debit: 0, credit: 50 },
      ],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));

    await throwaway!.pool.query(
      `UPDATE gl_subledger_entries SET subledger_id = NULL
       WHERE account_id = $1 AND party_id = $2`,
      [arId, PARTY_ID]
    );

    const health = await request('GET', '/api/accounting/chart-health');
    assert.equal(health.status, 200, JSON.stringify(health.json));
    assert.ok(health.json.unlinkedSubledgerRows.count >= 1);
    assert.equal(health.json.unlinkedSubledgerRows.amount, 50);
    assert.ok(
      health.json.unlinkedSubledgerRows.rows.some((row: any) =>
        row.partyId === PARTY_ID && row.accountCode === '1100' && row.debit === 50
      ),
      JSON.stringify(health.json.unlinkedSubledgerRows.rows)
    );
    assert.ok(health.json.totals.unlinkedSubledgerRows >= 1);
  });

  test('month-end close requires inventory and PSP reconciliation', async () => {
    const checklist = await request('GET', `/api/accounting/periods/${periodId}/checklist`);
    assert.equal(checklist.status, 200, JSON.stringify(checklist.json));
    const inventory = checklist.json.tasks.find((task: any) => task.taskCode === 'INVENTORY_RECONCILE');
    const psp = checklist.json.tasks.find((task: any) => task.taskCode === 'PSP_RECONCILE');
    assert.ok(inventory, 'inventory/GL reconciliation must be on the close checklist');
    assert.ok(psp, 'PSP reconciliation must be on the close checklist');
    assert.equal(inventory.required, true);
    assert.equal(psp.required, true);
  });
});
