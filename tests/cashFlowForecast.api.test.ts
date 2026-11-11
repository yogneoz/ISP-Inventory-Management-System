/**
 * Forward cash-flow forecast — real HTTP + PostgreSQL.
 *
 * The suite posts a real opening cash journal, creates persisted recurring
 * templates and unpaid payroll runs, and drives the manual-input CRUD routes.
 * It then proves the weekly math, source tie-outs, branch isolation, closed
 * period exclusions, CSV detail and authentication gates against the actual
 * route stack.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase, type ThrowawayDatabase } from './fixtures/throwawayDatabase';

dotenv.config();

const TEST_DB = 'inventory_cash_flow_forecast_test';
const BR_A = 'CFFA';
const BR_B = 'CFFB';
const AS_OF = '2026-11-02';

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

const USERS = {
  super: { id: 'cff-super', email: 'cff-super@example.com', name: 'CFF Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  branchA: { id: 'cff-accountant-a', email: 'cff-accountant-a@example.com', name: 'CFF Accountant A', role: 'ACCOUNTANT', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  frontdesk: { id: 'cff-frontdesk', email: 'cff-frontdesk@example.com', name: 'CFF Front Desk', role: 'FRONT_DESK', branchId: BR_A, allowedBranchIds: [BR_A], canSwitchUser: false },
  empty: { id: 'cff-empty', email: 'cff-empty@example.com', name: 'CFF Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

describe('cash-flow forecast inputs (real HTTP + throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  let throwaway: ThrowawayDatabase | null = null;
  let port = 0;
  let closeServer: (() => Promise<void>) | null = null;
  let tokens = {} as Record<keyof typeof USERS, string>;
  let cashId = '';
  let salesId = '';
  let periodOctId = '';
  let periodNovId = '';
  let closedManualId = '';

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    pathName: string,
    token?: string,
    body?: unknown
  ) {
    const res = await fetch('http://127.0.0.1:' + port + pathName, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
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

  const get = (pathName: string, token?: string) => request('GET', pathName, token);
  const post = (pathName: string, token: string | undefined, body: unknown) =>
    request('POST', pathName, token, body);
  const patch = (pathName: string, token: string | undefined, body: unknown) =>
    request('PATCH', pathName, token, body);
  const del = (pathName: string, token: string | undefined) =>
    request('DELETE', pathName, token);

  async function findPeriod(key: string) {
    const res = await get('/api/accounting/periods', tokens.super);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return (res.json as any[]).find((period) => period.periodKey === key) || null;
  }

  async function ensureOpenPeriod(key: string) {
    let period = await findPeriod(key);
    if (!period) {
      const created = await post('/api/accounting/periods', tokens.super, { periodKey: key });
      assert.ok([201, 409].includes(created.status), JSON.stringify(created.json));
      period = await findPeriod(key);
    }
    assert.ok(period, `period ${key} must exist`);
    if (period.status === 'CLOSED') {
      const reopened = await post(`/api/accounting/periods/${period.id}/reopen`, tokens.super, {});
      assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
      period = await findPeriod(key);
    }
    return period;
  }

  async function createManual(input: Record<string, unknown>) {
    const res = await post('/api/accounting/cash-flow/manual-inputs', tokens.super, input);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
  }

  async function createRecurring(code: string, branchId: string, startDateAD: string, amount: number) {
    const res = await post('/api/accounting/recurring-templates', tokens.super, {
      code,
      name: `CFF ${code}`,
      description: `CFF forecast source ${code}`,
      branchId,
      frequency: 'MONTHLY',
      startDateAD,
      endDateAD: '2027-12-31',
      lines: [
        {
          accountId: salesId,
          side: 'DEBIT',
          amountFormula: String(amount),
          memo: 'CFF forecast source',
        },
        {
          accountId: cashId,
          side: 'CREDIT',
          amountFormula: String(amount),
          memo: 'CFF forecast source',
        },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json;
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

    await ensureReferenceData(throwaway.pool, AS_OF);
    const octoberDays = Array.from(
      { length: 31 },
      (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`
    );
    await ensureBsDayRecords(throwaway.pool, octoberDays);

    for (const branchId of [BR_A, BR_B]) {
      await throwaway.pool.query(
        `INSERT INTO branches (id, code, name, location, active, allow_procurement, allow_warehouse_transfer, is_demo)
         VALUES ($1, $1, $1, 'Test', TRUE, TRUE, TRUE, FALSE)`,
        [branchId]
      );
    }

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));
    tokens = Object.fromEntries(
      Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
    ) as Record<keyof typeof USERS, string>;

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    closeServer = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    cashId = defaults.json.defaults.CASH.accountId;
    salesId = defaults.json.defaults.SALES.accountId;

    const october = await ensureOpenPeriod('2026-10');
    const november = await ensureOpenPeriod('2026-11');
    periodOctId = october.id;
    periodNovId = november.id;

    const opening = await post('/api/accounting/journals', tokens.super, {
      journalDateAD: '2026-10-31',
      branchId: BR_A,
      memo: 'CFF opening cash',
      lines: [
        { accountId: cashId, debit: 1000, credit: 0, memo: 'CFF opening cash' },
        { accountId: salesId, debit: 0, credit: 1000, memo: 'CFF opening cash' },
      ],
    });
    assert.equal(opening.status, 201, JSON.stringify(opening.json));

    const closedManual = await createManual({
      branchId: BR_A,
      expectedDateAD: '2026-10-20',
      direction: 'OUTFLOW',
      amountFormula: '700',
      description: 'CFF October closed manual',
    });
    closedManualId = closedManual.id;

    await createRecurring('CFF-REC-A', BR_A, '2026-11-10', 300);
    await createRecurring('CFF-REC-CLOSED', BR_A, '2026-10-20', 400);
    await createRecurring('CFF-REC-B', BR_B, '2026-11-15', 250);

    await throwaway.pool.query(
      `INSERT INTO payroll_runs
         (id, run_no, branch_id, period_key, run_date_ad, run_date_bs, gross_total, net_total, status)
       SELECT v.id, v.run_no, v.branch_id, v.period_key, v.run_date_ad, b.bs_date || ' BS',
              v.gross_total, v.net_total, v.status
       FROM (VALUES
         ('cff-pay-a', 'CFF-PAY-A', $1, '2026-11', '2026-11-13'::date, 600, 500, 'POSTED'),
         ('cff-pay-a-draft', 'CFF-PAY-A-DRAFT', $1, '2026-10', '2026-11-14'::date, 1200, 999, 'DRAFT'),
         ('cff-pay-a-paid', 'CFF-PAY-A-PAID', $1, '2026-09', '2026-11-15'::date, 900, 777, 'PAID'),
         ('cff-pay-b', 'CFF-PAY-B', $2, '2026-11', '2026-11-20'::date, 500, 400, 'APPROVED')
       ) AS v(id, run_no, branch_id, period_key, run_date_ad, gross_total, net_total, status)
       JOIN bs_day_records b ON b.ad_date = v.run_date_ad`,
      [BR_A, BR_B]
    );

    await createManual({
      branchId: BR_A,
      expectedDateAD: '2026-11-12',
      direction: 'OUTFLOW',
      amountFormula: '1000*1.1',
      description: 'CFF manual A',
    });
    await createManual({
      branchId: BR_B,
      expectedDateAD: '2026-11-18',
      direction: 'OUTFLOW',
      amountFormula: '200',
      description: 'CFF manual B',
    });

    // Closing October is the only way to prove the forecast excludes a stored
    // input; the POST refusal is exercised separately below.
    await throwaway.pool.query(
      "UPDATE gl_periods SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [periodOctId]
    );
  });

  after(async () => {
    if (closeServer) await closeServer();
    try {
      const db = await import('../server/db');
      if (db.realPoolInstance) await db.realPoolInstance.end();
    } catch {
      /* best effort — the drop below forces the issue if this fails */
    }
    if (throwaway) {
      await throwaway.pool.end().catch(() => undefined);
      await dropThrowawayDatabase(throwaway.adminPool, TEST_DB);
    }
  });

  test('manual inputs validate safe formulas, closed periods and branch ownership', async () => {
    const created = await post('/api/accounting/cash-flow/manual-inputs', tokens.branchA, {
      branchId: BR_A,
      expectedDateAD: '2026-11-20',
      direction: 'INFLOW',
      amountFormula: '500+100',
      description: 'CFF CRUD input',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.amount, 600);
    assert.equal(created.json.branchId, BR_A);
    assert.match(created.json.expectedDateBS, /BS$/);
    const id = created.json.id;

    const list = await get(`/api/accounting/cash-flow/manual-inputs?branchId=${BR_A}`, tokens.branchA);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.count, 3);
    assert.ok(list.json.inputs.some((input: any) => input.id === id && input.amount === 600));

    const updated = await patch(`/api/accounting/cash-flow/manual-inputs/${id}`, tokens.branchA, {
      amountFormula: '700*2',
      direction: 'OUTFLOW',
      description: 'CFF CRUD input updated',
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.amount, 1400);
    assert.equal(updated.json.direction, 'OUTFLOW');

    assert.equal((await del(`/api/accounting/cash-flow/manual-inputs/${id}`, tokens.branchA)).status, 200);
    const afterDelete = await get(`/api/accounting/cash-flow/manual-inputs?branchId=${BR_A}`, tokens.branchA);
    assert.equal(afterDelete.json.count, 2);
    assert.ok(!afterDelete.json.inputs.some((input: any) => input.id === id));

    const badFormula = await post('/api/accounting/cash-flow/manual-inputs', tokens.branchA, {
      branchId: BR_A,
      expectedDateAD: '2026-11-20',
      direction: 'OUTFLOW',
      amountFormula: '1/0',
      description: 'CFF divide by zero',
    });
    assert.equal(badFormula.status, 400, JSON.stringify(badFormula.json));
    assert.match(badFormula.json.message, /divides by zero/i);

    const closedCreate = await post('/api/accounting/cash-flow/manual-inputs', tokens.branchA, {
      branchId: BR_A,
      expectedDateAD: '2026-10-15',
      direction: 'OUTFLOW',
      amountFormula: '100',
      description: 'CFF closed create',
    });
    assert.equal(closedCreate.status, 409, JSON.stringify(closedCreate.json));
    assert.match(closedCreate.json.message, /closed/i);

    const closedUpdate = await patch(`/api/accounting/cash-flow/manual-inputs/${closedManualId}`, tokens.branchA, {
      amountFormula: '750',
    });
    assert.equal(closedUpdate.status, 409, JSON.stringify(closedUpdate.json));

    const foreignBranch = await post('/api/accounting/cash-flow/manual-inputs', tokens.branchA, {
      branchId: BR_B,
      expectedDateAD: '2026-11-20',
      direction: 'OUTFLOW',
      amountFormula: '100',
      description: 'CFF foreign branch',
    });
    assert.equal(foreignBranch.status, 403, JSON.stringify(foreignBranch.json));

    const foreignRead = await get(`/api/accounting/cash-flow/manual-inputs?branchId=${BR_B}`, tokens.branchA);
    assert.equal(foreignRead.status, 403, JSON.stringify(foreignRead.json));

    assert.equal((await get('/api/accounting/statements/cash-flow/forecast')).status, 401);
    assert.equal((await get('/api/accounting/statements/cash-flow/forecast', tokens.frontdesk)).status, 403);
    assert.equal((await post('/api/accounting/cash-flow/manual-inputs', undefined, {})).status, 401);
  });

  test('forecast buckets recurring journals, unpaid payroll and manual inputs with source tie-outs', async () => {
    const res = await get(
      `/api/accounting/statements/cash-flow/forecast?asOf=${AS_OF}&branchId=${BR_A}&weeks=4&minCash=0`,
      tokens.branchA
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = res.json;

    assert.equal(data.branchId, BR_A);
    assert.equal(data.openingCash, 1000);
    assert.equal(data.buckets.length, 4);
    assert.equal(data.buckets[0].inflows, 0);
    assert.equal(data.buckets[0].outflows, 0);
    assert.equal(data.buckets[1].key, 'W2');
    assert.equal(data.buckets[1].outflows, 1900);
    assert.equal(data.buckets[1].closingCash, -900);
    assert.equal(data.buckets[2].outflows, 400);
    assert.equal(data.buckets[2].closingCash, -1300);
    assert.equal(data.totalInflows, 0);
    assert.equal(data.totalOutflows, 2300);
    assert.equal(data.netCashFlow, -2300);
    assert.equal(data.closingCash, -1300);
    assert.equal(data.warning, true);
    assert.equal(data.firstBreach.bucketKey, 'W2');

    assert.equal(data.sources.recurring.scheduledCount, 3);
    assert.equal(data.sources.recurring.scheduledAmount, 1100);
    assert.equal(data.sources.recurring.includedCount, 2);
    assert.equal(data.sources.recurring.includedAmount, 700);
    assert.equal(data.sources.recurring.closedPeriodExcluded.count, 1);
    assert.equal(data.sources.recurring.closedPeriodExcluded.amount, 400);
    assert.equal(data.sources.payroll.scheduledCount, 1);
    assert.equal(data.sources.payroll.includedAmount, 500);
    assert.equal(data.sources.manual.scheduledCount, 2);
    assert.equal(data.sources.manual.scheduledAmount, 1800);
    assert.equal(data.sources.manual.includedCount, 1);
    assert.equal(data.sources.manual.includedAmount, 1100);
    assert.equal(data.sources.manual.closedPeriodExcluded.count, 1);
    assert.equal(data.sources.manual.closedPeriodExcluded.amount, 700);

    const recurringItems = data.items.filter((item: any) => item.source === 'RECURRING');
    assert.equal(recurringItems.length, 2);
    assert.deepEqual(
      recurringItems.map((item: any) => item.amount).sort((a: number, b: number) => a - b),
      [300, 400]
    );
    const payrollItem = data.items.find((item: any) => item.source === 'PAYROLL');
    assert.equal(payrollItem.documentNo, 'CFF-PAY-A');
    assert.equal(payrollItem.amount, 500);
    assert.ok(!data.items.some((item: any) => item.documentNo === 'CFF-PAY-A-DRAFT'));
    assert.ok(!data.items.some((item: any) => item.documentNo === 'CFF-PAY-A-PAID'));
    const manualItem = data.items.find((item: any) => item.source === 'MANUAL');
    assert.equal(manualItem.amount, 1100);
    assert.equal(manualItem.documentNo, null);
    assert.ok(!data.items.some((item: any) => item.description === 'CFF October closed manual'));
    assert.deepEqual(data.beyondHorizon.payroll, { count: 0, amount: 0 });
    assert.equal(data.manualInputs.length, 2);
    assert.ok(data.manualInputs.some((input: any) => input.id === closedManualId && input.closedPeriod));

    const csv = await fetch(
      `http://127.0.0.1:${port}/api/accounting/statements/cash-flow/forecast/export?asOf=${AS_OF}&branchId=${BR_A}&weeks=4&minCash=0`,
      { headers: { authorization: `Bearer ${tokens.branchA}` } }
    );
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') || '', /cash-flow-forecast-2026-11-02\.csv/);
    const text = await csv.text();
    assert.match(text, /Recurring in,Recurring out,Payroll out,Manual in,Manual out/);
    assert.match(text, /Source summary,Scheduled count/);
    assert.match(text, /CFF manual A/);
    assert.match(text, /CFF October closed manual/);
  });

  test('branch and company-wide scopes keep every source isolated', async () => {
    const branchB = await get(
      `/api/accounting/statements/cash-flow/forecast?asOf=${AS_OF}&branchId=${BR_B}&weeks=4`,
      tokens.super
    );
    assert.equal(branchB.status, 200, JSON.stringify(branchB.json));
    assert.equal(branchB.json.openingCash, 0);
    assert.equal(branchB.json.totalOutflows, 850);
    assert.equal(branchB.json.closingCash, -850);
    assert.equal(branchB.json.items.length, 3);
    assert.ok(branchB.json.items.every((item: any) => item.partyName.includes('B') || item.source === 'PAYROLL'));
    assert.ok(branchB.json.items.some((item: any) => item.source === 'RECURRING' && item.amount === 250));
    assert.ok(branchB.json.items.some((item: any) => item.source === 'PAYROLL' && item.amount === 400));
    assert.ok(branchB.json.items.some((item: any) => item.source === 'MANUAL' && item.amount === 200));

    const branchA = await get(
      `/api/accounting/statements/cash-flow/forecast?asOf=${AS_OF}&branchId=${BR_A}&weeks=4`,
      tokens.super
    );
    assert.equal(branchA.status, 200, JSON.stringify(branchA.json));
    assert.ok(!branchA.json.items.some((item: any) => item.amount === 200 && item.source === 'MANUAL'));
    assert.ok(!branchA.json.items.some((item: any) => item.amount === 250));
    assert.ok(!branchA.json.items.some((item: any) => item.amount === 400 && item.source === 'PAYROLL'));

    const all = await get(
      `/api/accounting/statements/cash-flow/forecast?asOf=${AS_OF}&weeks=4`,
      tokens.super
    );
    assert.equal(all.status, 200, JSON.stringify(all.json));
    assert.equal(all.json.openingCash, 1000);
    assert.equal(all.json.totalOutflows, 3150);
    assert.equal(all.json.closingCash, -2150);
    assert.equal(all.json.sources.recurring.scheduledCount, 4);
    assert.equal(all.json.sources.manual.scheduledCount, 3);
    assert.equal(all.json.sources.payroll.scheduledCount, 2);

    const empty = await get(
      `/api/accounting/statements/cash-flow/forecast?asOf=${AS_OF}&weeks=4`,
      tokens.empty
    );
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.openingCash, 0);
    assert.deepEqual(empty.json.items, []);
    assert.equal(empty.json.manualInputs.length, 0);
  });
});
