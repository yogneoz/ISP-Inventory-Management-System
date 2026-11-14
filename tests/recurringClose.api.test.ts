/**
 * Recurring journals + month-end close — real HTTP + PostgreSQL.
 *
 * The test deliberately posts through the actual route stack and reads the
 * stored journal/runs/checklist rows back. It covers the four acceptance
 * invariants: one journal per template/date, balanced generated lines carrying
 * the template source, a close blocked by required tasks unless overridden with
 * a reason, and checklist state surviving refresh.
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
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BR = 'BRH01';
const OTHER_BR = 'WH001';
const DATE_ONE = '2027-04-15';
const DATE_TWO = '2027-05-15';
const PERIOD_ONE = '2027-04';
const PERIOD_TWO = '2027-05';
const CODE = 'RCT-RENT';
const UNUSED_CODE = 'RCT-UNUSED';

const USERS = {
  super: { id: 'rct-super', email: 'rct-super@example.com', name: 'RCT Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  branch: { id: 'rct-branch', email: 'rct-branch@example.com', name: 'RCT Branch', role: 'BRANCH_MANAGER', branchId: OTHER_BR, allowedBranchIds: [OTHER_BR], canSwitchUser: false },
  auditor: { id: 'rct-auditor', email: 'rct-auditor@example.com', name: 'RCT Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

describe('recurring journals and month-end close (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let groupId = '';
  let expenseAccount = '';
  let cashAccount = '';
  let templateId = '';
  let unusedTemplateId = '';
  let periodOneId = '';
  let periodTwoId = '';

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    token?: string,
    body?: unknown
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const post = (path: string, token: string | undefined, body: unknown) => request('POST', path, token, body);
  const patch = (path: string, token: string | undefined, body: unknown) => request('PATCH', path, token, body);
  const del = (path: string, token: string | undefined) => request('DELETE', path, token);

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

  async function cleanup() {
    if (!pool) return;
    await pool.query(
      "DELETE FROM gl_recurring_runs WHERE template_id IN (SELECT id FROM gl_recurring_templates WHERE code LIKE 'RCT-%')"
    );
    await pool.query(
      "DELETE FROM gl_journals WHERE source_type = 'RECURRING_JOURNAL' AND source_id IN (SELECT id FROM gl_recurring_templates WHERE code LIKE 'RCT-%')"
    );
    await pool.query("DELETE FROM gl_recurring_templates WHERE code LIKE 'RCT-%'");
    await pool.query(
      "DELETE FROM gl_close_checklist_items WHERE period_id IN (SELECT id FROM gl_periods WHERE period_key IN ($1, $2))",
      [PERIOD_ONE, PERIOD_TWO]
    );
    await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'RCT-%'");
    await pool.query("DELETE FROM gl_account_groups WHERE code LIKE 'RCT-%'");
    await pool.query("DELETE FROM audit_logs WHERE details LIKE '%RCT-%' OR details LIKE '%RECURRING%'");
  }

  before(async () => {
    await ensureReferenceData(pool!, DATE_ONE);
    await ensureBsDayRecords(pool!, [
      '2027-04-01', DATE_ONE, '2027-04-30',
      '2027-05-01', DATE_TWO, '2027-05-31',
    ]);
    await cleanup();

    setPermissionMatrix(JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX)));

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const group = await post('/api/accounting/groups', tokens.super, {
      code: 'RCT-EXP', name: 'RCT Expenses', accountType: 'EXPENSE', statementGroup: 'OPERATING_EXPENSE',
    });
    assert.equal(group.status, 201, JSON.stringify(group.json));
    groupId = group.json.id;

    const expense = await post('/api/accounting/accounts', tokens.super, {
      code: 'RCT-5100', name: 'RCT Office Rent', groupId,
    });
    assert.equal(expense.status, 201, JSON.stringify(expense.json));
    expenseAccount = expense.json.id;

    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    cashAccount = defaults.json.defaults.CASH.accountId;

    const one = await ensureOpenPeriod(PERIOD_ONE);
    const two = await ensureOpenPeriod(PERIOD_TWO);
    periodOneId = one.id;
    periodTwoId = two.id;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    await cleanup();
    if (pool) await pool.end();
  });

  test('creates a balanced template, previews it and generates exactly one journal per due date', async () => {
    const created = await post('/api/accounting/recurring-templates', tokens.super, {
      code: CODE,
      name: 'RCT Monthly Rent',
      description: 'RECURRING TEST rent',
      branchId: BR,
      frequency: 'MONTHLY',
      startDateAD: DATE_ONE,
      endDateAD: '2027-12-31',
      lines: [
        { accountId: expenseAccount, side: 'DEBIT', amountFormula: '1000+250', memo: 'RCT rent expense' },
        { accountId: cashAccount, side: 'CREDIT', amountFormula: '1250', memo: 'RCT rent payment' },
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    templateId = created.json.id;
    assert.equal(created.json.code, CODE);
    assert.equal(created.json.branchId, BR);
    assert.equal(created.json.nextRunDate, DATE_ONE);
    assert.equal(created.json.lines.length, 2);

    const preview = await get(`/api/accounting/recurring-templates/${templateId}/preview`, tokens.super);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.balanced, true);
    assert.equal(preview.json.totalDebit, 1250);
    assert.equal(preview.json.totalCredit, 1250);
    assert.equal(preview.json.period.periodKey, PERIOD_ONE);
    assert.equal(preview.json.canRun, true);

    const first = await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.super, {});
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.status, 'GENERATED');
    assert.equal(first.json.runDate, DATE_ONE);
    assert.equal(first.json.nextRunDate, DATE_TWO);
    assert.ok(first.json.journal?.journalNo, 'the generated run must return its journal number');

    const journal = (await pool!.query(
      `SELECT j.id, j.source_type AS "sourceType", j.source_id AS "sourceId", j.branch_id AS "branchId",
              j.status, COALESCE(SUM(l.debit), 0)::numeric AS debit,
              COALESCE(SUM(l.credit), 0)::numeric AS credit
       FROM gl_journals j JOIN gl_journal_lines l ON l.journal_id = j.id
       WHERE j.id = $1
       GROUP BY j.id, j.source_type, j.source_id, j.branch_id, j.status`,

      [first.json.journal.id]
    )).rows[0];
    assert.equal(journal.sourceType, 'RECURRING_JOURNAL');
    assert.equal(journal.sourceId, templateId);
    assert.equal(journal.branchId, BR);
    assert.equal(Number(journal.debit), 1250);
    assert.equal(Number(journal.credit), 1250);

    const second = await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.super, { date: DATE_ONE });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.status, 'ALREADY_GENERATED');
    assert.equal(second.json.journal.id, first.json.journal.id);
    const count = Number((await pool!.query(
      'SELECT COUNT(*)::int AS n FROM gl_recurring_runs WHERE template_id = $1 AND run_date = $2',
      [templateId, DATE_ONE]
    )).rows[0].n);
    assert.equal(count, 1, 'the template/date run record must be unique');

    const detail = await get(`/api/accounting/recurring-templates/${templateId}`, tokens.super);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.nextRunDate, DATE_TWO);
    assert.equal(detail.json.lastRunDate, DATE_ONE);
  });

  test('rejects an unbalanced preview/run and a branch user cannot read or run another branch template', async () => {
    const unbalanced = await post('/api/accounting/recurring-templates', tokens.super, {
      code: 'RCT-UNBAL',
      name: 'RCT Unbalanced',
      branchId: BR,
      frequency: 'MONTHLY',
      startDateAD: DATE_ONE,
      lines: [
        { accountId: expenseAccount, side: 'DEBIT', amountFormula: '100' },
        { accountId: cashAccount, side: 'CREDIT', amountFormula: '90' },
      ],
    });
    assert.equal(unbalanced.status, 201, JSON.stringify(unbalanced.json));
    const preview = await get(`/api/accounting/recurring-templates/${unbalanced.json.id}/preview`, tokens.super);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(preview.json.balanced, false);
    assert.equal(preview.json.difference, 10);
    assert.equal(preview.json.canRun, false);
    const run = await post(`/api/accounting/recurring-templates/${unbalanced.json.id}/run`, tokens.super, {});
    assert.equal(run.status, 400, JSON.stringify(run.json));
    assert.match(run.json.message, /not balanced/i);
    assert.equal((await del(`/api/accounting/recurring-templates/${unbalanced.json.id}`, tokens.super)).status, 200);

    const branchRead = await get(`/api/accounting/recurring-templates/${templateId}`, tokens.branch);
    assert.equal(branchRead.status, 403, JSON.stringify(branchRead.json));
    const branchCreate = await post('/api/accounting/recurring-templates', tokens.branch, {
      code: 'RCT-DENIED', name: 'RCT Denied', branchId: BR, frequency: 'MONTHLY',
      startDateAD: DATE_ONE,
      lines: [
        { accountId: expenseAccount, side: 'DEBIT', amountFormula: '1' },
        { accountId: cashAccount, side: 'CREDIT', amountFormula: '1' },
      ],
    });
    assert.equal(branchCreate.status, 403, JSON.stringify(branchCreate.json));
    assert.equal((await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.branch, {})).status, 403);
    assert.equal((await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.auditor, {})).status, 403);
  });

  test('checklist state persists, required tasks block close, and an override reason closes with audit', async () => {
    const checklist = await get(`/api/accounting/periods/${periodOneId}/checklist`, tokens.super);
    assert.equal(checklist.status, 200, JSON.stringify(checklist.json));
    assert.equal(checklist.json.tasks.length, 7);
    assert.ok(
      checklist.json.tasks.some((task: any) => task.taskCode === 'INVENTORY_RECONCILE'),
      'inventory valuation must be an explicit close control'
    );
    const pspTask = checklist.json.tasks.find((task: any) => task.taskCode === 'PSP_RECONCILE');
    assert.ok(pspTask, 'provider settlement reconciliation must be an explicit close control');
    assert.equal(pspTask.required, true);
    assert.equal(checklist.json.summary.requiredIncomplete, 6);
    const bankTask = checklist.json.tasks.find((task: any) => task.taskCode === 'BANK_RECONCILE');
    const agingTask = checklist.json.tasks.find((task: any) => task.taskCode === 'REVIEW_AGING');
    const accrueTask = checklist.json.tasks.find((task: any) => task.taskCode === 'ACCRUE_EXPENSES');
    const depreciationTask = checklist.json.tasks.find((task: any) => task.taskCode === 'POST_DEPRECIATION');
    assert.ok(bankTask && agingTask && accrueTask && depreciationTask);

    const saved = await patch(
      `/api/accounting/periods/${periodOneId}/checklist/${bankTask.id}`,
      tokens.super,
      { status: 'DONE', owner: 'RCT Finance', note: 'Statement matched', evidenceUrl: 'https://example.com/bank' }
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.status, 'DONE');
    assert.equal(saved.json.owner, 'RCT Finance');
    assert.equal(saved.json.evidenceUrl, 'https://example.com/bank');
    assert.ok(saved.json.completedAt);

    const refreshed = await get(`/api/accounting/periods/${periodOneId}/checklist`, tokens.super);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    assert.equal(refreshed.json.tasks.find((task: any) => task.id === bankTask.id).note, 'Statement matched');
    assert.equal(refreshed.json.summary.done, 1);

    const blocked = await post(`/api/accounting/periods/${periodOneId}/close`, tokens.super, {});
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
    assert.match(blocked.json.message, /required close tasks are incomplete/i);
    assert.equal((await findPeriod(PERIOD_ONE)).status, 'OPEN');

    const overridden = await post(`/api/accounting/periods/${periodOneId}/close`, tokens.super, {
      overrideReason: 'RCT month-end close approved by CFO',
    });
    assert.equal(overridden.status, 200, JSON.stringify(overridden.json));
    assert.equal(overridden.json.status, 'CLOSED');
    assert.equal(overridden.json.overridden, true);
    assert.ok(overridden.json.incompleteRequired.length > 0);

    const afterClose = await get(`/api/accounting/periods/${periodOneId}/checklist`, tokens.super);
    assert.equal(afterClose.status, 200, JSON.stringify(afterClose.json));
    assert.equal(afterClose.json.period.status, 'CLOSED');
    assert.equal(afterClose.json.tasks.find((task: any) => task.taskCode === 'LOCK_PERIOD').status, 'DONE');

    const audit = await pool!.query(
      "SELECT action FROM audit_logs WHERE action IN ('UPDATE_CLOSE_CHECKLIST_ITEM','CLOSE_ACCOUNTING_PERIOD_OVERRIDE')"
    );
    assert.ok(audit.rows.some((row: any) => row.action === 'UPDATE_CLOSE_CHECKLIST_ITEM'));
    assert.ok(audit.rows.some((row: any) => row.action === 'CLOSE_ACCOUNTING_PERIOD_OVERRIDE'));

    const reopened = await post(`/api/accounting/periods/${periodOneId}/reopen`, tokens.super, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    assert.equal(reopened.json.status, 'OPEN');
    const afterReopen = await get(`/api/accounting/periods/${periodOneId}/checklist`, tokens.super);
    assert.equal(afterReopen.json.tasks.find((task: any) => task.taskCode === 'LOCK_PERIOD').status, 'PENDING');
  });

  test('a closed period is skipped without advancing the schedule; reopening lets the same due date run', async () => {
    const closed = await post(`/api/accounting/periods/${periodTwoId}/close`, tokens.super, {
      overrideReason: 'RCT close before the next recurring due date',
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    const skipped = await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.super, {});
    assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
    assert.equal(skipped.json.status, 'SKIPPED');
    assert.equal(skipped.json.reason, 'PERIOD_CLOSED');
    assert.equal((await get(`/api/accounting/recurring-templates/${templateId}`, tokens.super)).json.nextRunDate, DATE_TWO);
    const runCountBefore = Number((await pool!.query(
      'SELECT COUNT(*)::int AS n FROM gl_recurring_runs WHERE template_id = $1',
      [templateId]
    )).rows[0].n);
    assert.equal(runCountBefore, 1, 'a skipped closed period must not write a run record or journal');

    const reopened = await post(`/api/accounting/periods/${periodTwoId}/reopen`, tokens.super, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.json));
    const generated = await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.super, {});
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.equal(generated.json.status, 'GENERATED');
    assert.equal(generated.json.runDate, DATE_TWO);
    assert.equal(generated.json.nextRunDate, '2027-06-15');
  });

  test('pause, delete-unused and delete-used guards are enforced', async () => {
    const paused = await patch(`/api/accounting/recurring-templates/${templateId}`, tokens.super, { active: false });
    assert.equal(paused.status, 200, JSON.stringify(paused.json));
    assert.equal(paused.json.active, false);
    assert.equal((await post(`/api/accounting/recurring-templates/${templateId}/run`, tokens.super, {})).status, 409);
    assert.equal((await patch(`/api/accounting/recurring-templates/${templateId}`, tokens.super, { active: true })).status, 200);

    const unused = await post('/api/accounting/recurring-templates', tokens.super, {
      code: UNUSED_CODE,
      name: 'RCT Unused',
      branchId: BR,
      frequency: 'MONTHLY',
      startDateAD: DATE_ONE,
      lines: [
        { accountId: expenseAccount, side: 'DEBIT', amountFormula: '1' },
        { accountId: cashAccount, side: 'CREDIT', amountFormula: '1' },
      ],
    });
    assert.equal(unused.status, 201, JSON.stringify(unused.json));
    unusedTemplateId = unused.json.id;
    assert.equal((await del(`/api/accounting/recurring-templates/${unusedTemplateId}`, tokens.super)).status, 200);
    const usedDelete = await del(`/api/accounting/recurring-templates/${templateId}`, tokens.super);
    assert.equal(usedDelete.status, 409, JSON.stringify(usedDelete.json));
    assert.match(usedDelete.json.message, /generated journals/i);
    assert.equal((await del(`/api/accounting/recurring-templates/${templateId}`, tokens.auditor)).status, 403);
  });
});
