/**
 * Payroll → ledger, driven through the real HTTP routes against PostgreSQL.
 *
 * Payroll is the last operational domain that had no ledger presence. The
 * claims pinned here are the ones a payroll row without a journal cannot meet:
 *
 *   1. the employee master is a branch-scoped, separately addressable record;
 *   2. a posted run writes one balanced journal — gross salary expense debited,
 *      net/TDS/SSF/advance/loan credited — plus EMPLOYEE subledger rows;
 *   3. TDS and SSF control accounts reconcile to those subledger rows per
 *      employee, and the employee ledger reads the same entries;
 *   4. a second run for the same branch+period is refused with nothing written;
 *   5. paying the run clears salary payable per employee against cash and the
 *      payment cannot be repeated;
 *   6. a closed period refuses the run and rolls the whole document back.
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
import { ensureReferenceData } from './fixtures/referenceData';

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

const BR = 'pay-test-branch';
const RUN_DATE = '2026-09-30';
const PERIOD = '2026-09';
/** Far enough from every other suite's month that closing it cannot leak. */
const CLOSED_PERIOD = '2027-06';
const CLOSED_RUN_DATE = '2027-06-30';

const ADMIN = {
  id: 'pay-admin',
  email: 'pay-admin@example.com',
  name: 'PAY Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const INVENTORY_MANAGER = {
  id: 'pay-inv-manager',
  email: 'pay-inv-manager@example.com',
  name: 'PAY Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: BR,
  allowedBranchIds: [BR],
  canSwitchUser: false,
} as any;

describe('payroll run and payment posting (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(INVENTORY_MANAGER);
  let emp1: any = null;
  let emp2: any = null;
  let run: any = null;

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    auth = token
  ) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + auth,
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

  const get = (path: string, auth = token) => request('GET', path, undefined, auth);
  const post = (path: string, body: unknown, auth = token) => request('POST', path, body, auth);
  const patch = (path: string, body: unknown) => request('PATCH', path, body);

  async function cleanup() {
    await pool!.query(
      "DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE branch_id = $1)",
      [BR]
    );
    await pool!.query('DELETE FROM payroll_runs WHERE branch_id = $1', [BR]);
    await pool!.query(
      "DELETE FROM gl_journals WHERE branch_id = $1 AND source_type IN ('PAYROLL_RUN', 'PAYROLL_PAYMENT')",
      [BR]
    );
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'PAYT-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%pay-test-branch%'");
    await pool!.query('DELETE FROM gl_periods WHERE period_key = $1', [CLOSED_PERIOD]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              journal_date_ad::text AS "journalDateAD"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function subledgerRows(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, s.party_id AS "partyId", s.party_name AS "partyName",
              s.debit::numeric AS debit, s.credit::numeric AS credit
         FROM gl_subledger_entries s
         JOIN gl_accounts a ON a.id = s.account_id
        WHERE s.journal_id = $1
        ORDER BY a.code ASC, s.party_id ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function jobCount(table: string, where: string, params: unknown[]): Promise<number> {
    const { rows } = await pool!.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
    return Number(rows[0].count);
  }

  function employeeBody(code: string, name: string) {
    return {
      employeeCode: code,
      name,
      branchId: BR,
      department: 'Field Operations',
      designation: 'Technician',
      panNumber: `PAN-${code}`,
      ssfNumber: `SSF-${code}`,
    };
  }

  function runBody(period = PERIOD, dateAD = RUN_DATE) {
    return {
      branchId: BR,
      periodKey: period,
      runDateAD: dateAD,
      lines: [
        {
          employeeId: emp1.id,
          gross: 5000,
          tds: 500,
          ssf: 550,
          advance: 200,
          loan: 100,
        },
        {
          employeeId: emp2.id,
          gross: 4000,
          tds: 200,
          ssf: 440,
          advance: 0,
          loan: 0,
        },
      ],
    };
  }

  async function postingDefault(role: string) {
    const res = await get('/api/accounting/posting-defaults');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const found = res.json.defaults[role];
    assert.ok(found, `posting default ${role} must be seeded`);
    return found;
  }

  before(async () => {
    await ensureReferenceData(pool!, RUN_DATE);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'PAYB', 'PAY Test Branch', 'Test')`,
      [BR]
    );

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

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
      await cleanup();
      await pool.end();
    }
  });

  test('the employee master creates, lists and updates branch-scoped employees', async () => {
    const first = await post('/api/employees', employeeBody('PAYT-001', 'Pay Test One'));
    assert.equal(first.status, 201, JSON.stringify(first.json));
    emp1 = first.json;
    assert.equal(emp1.employeeCode, 'PAYT-001');
    assert.equal(emp1.branchId, BR);
    assert.equal(emp1.isActive, true);

    const second = await post('/api/employees', employeeBody('PAYT-002', 'Pay Test Two'));
    assert.equal(second.status, 201, JSON.stringify(second.json));
    emp2 = second.json;

    const duplicate = await post('/api/employees', employeeBody('PAYT-001', 'Duplicate Code'));
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already exists/i);

    const list = await get(`/api/employees?branchId=${BR}`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 2);

    const updated = await patch(`/api/employees/${emp2.id}`, { designation: 'Senior Technician' });
    assert.equal(updated.status, 200, JSON.stringify(updated.json));
    assert.equal(updated.json.designation, 'Senior Technician');
    assert.equal(updated.json.name, 'Pay Test Two');

    const search = await get(`/api/employees?branchId=${BR}&query=PAYT-002`);
    assert.equal(search.status, 200, JSON.stringify(search.json));
    assert.equal(search.json.length, 1);
    assert.equal(search.json[0].id, emp2.id);
  });

  test('a posted run writes the gross expense and every deduction to the ledger', async () => {
    const created = await post('/api/payroll-runs', runBody());
    assert.equal(created.status, 201, JSON.stringify(created.json));
    run = created.json;
    assert.equal(run.status, 'POSTED');
    assert.equal(Number(run.grossTotal), 9000);
    assert.equal(Number(run.tdsTotal), 700);
    assert.equal(Number(run.ssfTotal), 990);
    assert.equal(Number(run.advanceTotal), 200);
    assert.equal(Number(run.loanTotal), 100);
    assert.equal(Number(run.netTotal), 7010);
    assert.equal(run.lines.length, 2);
    assert.match(run.journalNo, /^MJ-/);

    const [journal] = await journalFor('PAYROLL_RUN', run.id);
    assert.ok(journal, 'a posted run must write its journal in the same transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);
    assert.equal(journal.journalDateAD, RUN_DATE);

    const lines = await journalLines(journal.id);
    const byCode = (code: string) => lines.filter((line) => line.code === code);
    assert.equal(byCode('6400').length, 1, 'salary expense is one gross debit');
    assert.equal(byCode('6400')[0].debit, 9000);
    assert.deepEqual(byCode('2320').map((line) => line.credit).sort((a, b) => a - b), [3360, 3650]);
    assert.deepEqual(byCode('2330').map((line) => line.credit).sort((a, b) => a - b), [200, 500]);
    assert.deepEqual(byCode('2340').map((line) => line.credit).sort((a, b) => a - b), [440, 550]);
    assert.deepEqual(byCode('1620').map((line) => line.credit), [200]);
    assert.deepEqual(byCode('1630').map((line) => line.credit), [100]);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 9000);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 9000);

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 8, 'five deductions for emp1, three for emp2');
    assert.ok(subledger.every((row) => row.partyId === emp1.id || row.partyId === emp2.id));
    assert.deepEqual(
      subledger.filter((row) => row.code === '2330').map((row) => row.credit).sort((a, b) => a - b),
      [200, 500]
    );

    const detail = await get(`/api/payroll-runs/${run.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json.lines.length, 2);
    assert.equal(detail.json.status, 'POSTED');

    const list = await get(`/api/payroll-runs?branchId=${BR}&periodKey=${PERIOD}`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].id, run.id);
  });

  test('TDS and SSF reconcile per employee and the employee ledger reads the same entries', async () => {
    const [tds, ssf, payable, advance, loan] = await Promise.all([
      postingDefault('TDS_PAYABLE'),
      postingDefault('SSF_PAYABLE'),
      postingDefault('SALARY_PAYABLE'),
      postingDefault('EMPLOYEE_ADVANCE'),
      postingDefault('EMPLOYEE_LOAN'),
    ]);

    const tdsRecon = await get(`/api/accounting/reconciliations?accountId=${tds.accountId}&branchId=${BR}`);
    assert.equal(tdsRecon.status, 200, JSON.stringify(tdsRecon.json));
    assert.equal(tdsRecon.json.status, 'RECONCILED');
    assert.equal(tdsRecon.json.glBalance, -700);
    assert.equal(tdsRecon.json.subledgerBalance, -700);
    assert.deepEqual(
      tdsRecon.json.parties.map((party: any) => [party.partyId, party.balance]).sort(),
      [[emp1.id, -500], [emp2.id, -200]].sort()
    );

    const ssfRecon = await get(`/api/accounting/reconciliations?accountId=${ssf.accountId}&branchId=${BR}`);
    assert.equal(ssfRecon.status, 200, JSON.stringify(ssfRecon.json));
    assert.equal(ssfRecon.json.status, 'RECONCILED');
    assert.equal(ssfRecon.json.glBalance, -990);
    assert.deepEqual(
      ssfRecon.json.parties.map((party: any) => [party.partyId, party.balance]).sort(),
      [[emp1.id, -550], [emp2.id, -440]].sort()
    );

    const payableRecon = await get(`/api/accounting/reconciliations?accountId=${payable.accountId}&branchId=${BR}`);
    assert.equal(payableRecon.json.status, 'RECONCILED');
    assert.equal(payableRecon.json.glBalance, -7010);

    const advanceRecon = await get(`/api/accounting/reconciliations?accountId=${advance.accountId}&branchId=${BR}`);
    assert.equal(advanceRecon.json.glBalance, -200);
    const loanRecon = await get(`/api/accounting/reconciliations?accountId=${loan.accountId}&branchId=${BR}`);
    assert.equal(loanRecon.json.glBalance, -100);

    const ledger = await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`);
    assert.equal(ledger.status, 200, JSON.stringify(ledger.json));
    const account = (code: string) => ledger.json.accounts.find((row: any) => row.code === code);
    assert.equal(account('2320').balance, -3650);
    assert.equal(account('2330').balance, -500);
    assert.equal(account('2340').balance, -550);
    assert.equal(account('1620').balance, -200);
    assert.equal(account('1630').balance, -100);
    assert.equal(account('2320').presentedBalance, 3650, 'a liability presents in its natural direction');
    assert.equal(ledger.json.entries.length, 5);
    assert.equal(ledger.json.totals.debit, 0);
    assert.equal(ledger.json.totals.credit, 5000);
  });

  test('a duplicate run for the same month is refused and writes nothing', async () => {
    const beforeRuns = await jobCount('payroll_runs', 'branch_id = $1', [BR]);
    const beforeJournals = await jobCount(
      'gl_journals',
      "branch_id = $1 AND source_type = 'PAYROLL_RUN'",
      [BR]
    );

    const duplicate = await post('/api/payroll-runs', runBody());
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already posted/i);

    assert.equal(await jobCount('payroll_runs', 'branch_id = $1', [BR]), beforeRuns);
    assert.equal(
      await jobCount('gl_journals', "branch_id = $1 AND source_type = 'PAYROLL_RUN'", [BR]),
      beforeJournals
    );
  });

  test('paying the run clears salary payable against cash, once', async () => {
    const paid = await post(`/api/payroll-runs/${run.id}/pay`, {
      paymentMethod: 'CASH',
      dateAD: RUN_DATE,
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.status, 'PAID');
    assert.equal(paid.json.paidDateAD, RUN_DATE);
    assert.equal(paid.json.paymentMethod, 'CASH');
    assert.match(paid.json.journalNo, /^MJ-/);

    const [journal] = await journalFor('PAYROLL_PAYMENT', run.id);
    assert.ok(journal, 'the payment must write its own journal');
    const lines = await journalLines(journal.id);
    const byCode = (code: string) => lines.filter((line) => line.code === code);
    assert.deepEqual(byCode('2320').map((line) => line.debit).sort((a, b) => a - b), [3360, 3650]);
    assert.equal(byCode('1010').length, 1);
    assert.equal(byCode('1010')[0].credit, 7010);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 7010);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 7010);

    const subledger = await subledgerRows(journal.id);
    assert.equal(subledger.length, 2, 'one salary-payable settlement per employee');
    assert.ok(subledger.every((row) => row.credit === 0 && row.debit > 0));

    const payable = await postingDefault('SALARY_PAYABLE');
    const reconciled = await get(
      `/api/accounting/reconciliations?accountId=${payable.accountId}&branchId=${BR}`
    );
    assert.equal(reconciled.json.status, 'RECONCILED');
    assert.equal(reconciled.json.glBalance, 0);
    assert.equal(reconciled.json.subledgerBalance, 0);

    const ledger = await get(`/api/employees/${emp1.id}/ledger?branchId=${BR}`);
    assert.equal(ledger.json.accounts.find((row: any) => row.code === '2320').balance, 0);
    assert.equal(ledger.json.totals.debit, 3650);
    assert.equal(ledger.json.totals.credit, 5000);

    const detail = await get(`/api/payroll-runs/${run.id}`);
    assert.equal(detail.json.status, 'PAID');
    assert.equal(detail.json.paidJournalId, journal.id);
  });

  test('a second payment is refused with no extra journal', async () => {
    const before = await jobCount(
      'gl_journals',
      "branch_id = $1 AND source_type = 'PAYROLL_PAYMENT'",
      [BR]
    );
    const again = await post(`/api/payroll-runs/${run.id}/pay`, {
      paymentMethod: 'CASH',
      dateAD: RUN_DATE,
    });
    assert.equal(again.status, 409, JSON.stringify(again.json));
    assert.match(again.json.message, /already paid/i);
    assert.equal(
      await jobCount('gl_journals', "branch_id = $1 AND source_type = 'PAYROLL_PAYMENT'", [BR]),
      before
    );
  });

  test('a closed period refuses the run and rolls the whole document back', async () => {
    const opened = await post('/api/accounting/periods', { periodKey: CLOSED_PERIOD });
    let periodId: string | null = null;
    if (opened.status === 201) {
      periodId = opened.json.id;
    } else {
      const periods = await get('/api/accounting/periods');
      periodId = periods.json.find((row: any) => row.periodKey === CLOSED_PERIOD)?.id || null;
    }
    assert.ok(periodId, 'the closed-period test needs a period row');
    const closed = await post(`/api/accounting/periods/${periodId}/close`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.json));
    assert.equal(closed.json.status, 'CLOSED');

    try {
      const refused = await post('/api/payroll-runs', runBody(CLOSED_PERIOD, CLOSED_RUN_DATE));
      assert.equal(refused.status, 409, JSON.stringify(refused.json));
      assert.match(refused.json.message, /closed/i);
      assert.equal(
        await jobCount('payroll_runs', 'branch_id = $1 AND period_key = $2', [BR, CLOSED_PERIOD]),
        0,
        'the refused run leaves no header behind'
      );
      assert.equal(
        await jobCount(
          'gl_journals',
          "branch_id = $1 AND source_type = 'PAYROLL_RUN' AND journal_date_ad = $2",
          [BR, CLOSED_RUN_DATE]
        ),
        0,
        'the refused run leaves no journal behind'
      );
    } finally {
      await post(`/api/accounting/periods/${periodId}/reopen`, {});
    }
  });

  test('payroll reads and writes are gated on the ledger permissions', async () => {
    const forbiddenRun = await post('/api/payroll-runs', runBody(), managerToken);
    assert.equal(forbiddenRun.status, 403, JSON.stringify(forbiddenRun.json));

    const forbiddenList = await get(`/api/employees?branchId=${BR}`, managerToken);
    assert.equal(forbiddenList.status, 403, JSON.stringify(forbiddenList.json));

    const forbiddenCreate = await post('/api/employees', employeeBody('PAYT-003', 'Pay Test Three'), managerToken);
    assert.equal(forbiddenCreate.status, 403, JSON.stringify(forbiddenCreate.json));
  });
});
