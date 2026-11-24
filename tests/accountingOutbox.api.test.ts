/**
 * The accounting outbox — the queue `accountingOutboxStatus` always named and
 * nothing ever filled.
 *
 * Pin:
 *   1. submitting a claim queues it as PENDING_APPROVAL and the mobile response
 *      reports that real status (it used to hardcode `QUEUED`);
 *   2. approving the claim flips the row to QUEUED in the same transaction as
 *      the decision;
 *   3. flushing posts ONE balanced journal (Dr salary expense / Cr salary
 *      payable), marks the row POSTED with its journal, and a second flush posts
 *      nothing;
 *   4. rejecting a claim cancels its outbox row, so the flusher never posts a
 *      refused reimbursement.
 */
import { purgeAuditLogs } from './support/purgeAuditLogs';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import dotenv from 'dotenv';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { submitClaim } from '../server/src/services/mobile.service';
import { decideClaim } from '../server/src/services/approvalInbox.service';
import { flushAccountingOutbox } from '../server/src/services/accountingOutbox.service';

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
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (outbox writes)';

const BRANCH = 'out-test-branch';
const CLAIMANT = 'out-test-emp-claimant';
const APPROVER = 'out-test-emp-approver';
const APPROVER_USER = {
  id: 'out-test-user',
  email: 'out-test-approver@example.com',
  name: 'Outbox Approver',
  role: 'BRANCH_MANAGER',
  branchId: BRANCH,
  allowedBranchIds: [BRANCH],
  canSwitchUser: false,
} as any;
const REQUEST = { user: APPROVER_USER, headers: {}, ip: '127.0.0.1', method: 'POST', originalUrl: '/api/v1/workplace/approvals' } as any;

const employee = (id: string, name: string) => ({ id, name, branch_id: BRANCH, employee_code: id });

describe('accounting outbox (PostgreSQL)', { skip: skipNoDb }, () => {
  const claims: string[] = [];

  async function submit(amount: number): Promise<string> {
    const claimId = `out-test-claim-${claims.length + 1}`;
    claims.push(claimId);
    const result = await submitClaim({ user: APPROVER_USER }, employee(CLAIMANT, 'Outbox Claimant'), {
      claimId,
      amount,
      category: 'TRAVEL',
      description: 'Taxi to the exchange',
      currency: 'NPR',
    });
    assert.equal(result.claimId, claimId);
    return claimId;
  }

  async function outbox(claimId: string) {
    return (
      await pool!.query(
        `SELECT status, amount, attempts, last_error, journal_id, journal_no, queued_at, posted_at
           FROM accounting_outbox WHERE source_type = 'EXPENSE_CLAIM' AND source_id = $1`,
        [claimId]
      )
    ).rows[0];
  }

  async function cleanup() {
    await pool!.query("DELETE FROM accounting_outbox WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM hr_expense_claims WHERE branch_id = $1", [BRANCH]);
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL inventory.allow_ledger_purge = 'on'");
      await client.query("DELETE FROM gl_journals WHERE source_type = 'EXPENSE_CLAIM' AND branch_id = $1", [BRANCH]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await pool!.query("UPDATE employees SET user_id = NULL WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM employees WHERE branch_id = $1", [BRANCH]);
    await pool!.query("DELETE FROM users WHERE id LIKE 'out-test-user%'");
    await pool!.query("DELETE FROM branches WHERE id = $1", [BRANCH]);
    await purgeAuditLogs(pool!, "DELETE FROM audit_logs WHERE branch_id = $1", [BRANCH]);
  }

  before(async () => {
    await cleanup();
    // Services write through the app pool, which refuses until boot has proven
    // the database reachable; the other API suites set the same flag.
    const { ensurePostgresConnection } = await import('../server/db');
    assert.equal(await ensurePostgresConnection(), true, 'the dev database must be reachable');
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'OUTT', 'Outbox Test', 'Test')`,
      [BRANCH]
    );
    await pool!.query(
      `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, status)
       VALUES ($1, $2, 'x', $3, 'BRANCH_MANAGER', $4, ARRAY[$4::varchar]::text[], 'active')`,
      [APPROVER_USER.id, APPROVER_USER.email, APPROVER_USER.name, BRANCH]
    );
    await pool!.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, user_id, department)
       VALUES ($1, 'OUT-C', 'Outbox Claimant', $3, NULL, 'Field'),
              ($2, 'OUT-A', 'Outbox Approver', $3, $4, 'Field')`,
      [CLAIMANT, APPROVER, BRANCH, APPROVER_USER.id]
    );
    setPermissionMatrix({ 'hr-attendance-manage': { BRANCH_MANAGER: true } } as any);
  });

  after(async () => {
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a submitted claim waits for approval and says so', async () => {
    const claimId = await submit(250.5);
    const row = await outbox(claimId);
    assert.equal(row.status, 'PENDING_APPROVAL');
    assert.equal(Number(row.amount), 250.5);
    assert.equal(row.queued_at, null);
    assert.equal(row.journal_id, null);
  });

  test('approval queues the posting, the flush posts one journal, and a re-flush posts nothing', async () => {
    const claimId = claims[0];
    const decided = await decideClaim(REQUEST, APPROVER_USER, employee(APPROVER, 'Outbox Approver'), claimId, {
      approve: true,
      note: 'Approved for reimbursement',
    });
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.accountingOutboxStatus, 'QUEUED');

    const flushed = await flushAccountingOutbox({ limit: 10, branchId: BRANCH });
    assert.equal(flushed.posted, 1, JSON.stringify(flushed.errors));
    assert.equal(flushed.failed, 0, JSON.stringify(flushed.errors));

    const row = await outbox(claimId);
    assert.equal(row.status, 'POSTED');
    assert.ok(row.journal_id, 'the posting records its journal');
    assert.ok(row.posted_at);

    const lines = await pool!.query(
      `SELECT a.code, l.debit, l.credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY a.code ASC`,
      [row.journal_id]
    );
    assert.equal(lines.rows.length, 2, 'one balanced journal');
    const debit = lines.rows.find((line) => Number(line.debit) > 0);
    const credit = lines.rows.find((line) => Number(line.credit) > 0);
    assert.equal(debit.code, '7110', 'salary expense is debited');
    assert.equal(credit.code, '5270', 'salary payable is credited');
    assert.equal(Number(debit.debit), 250.5);
    assert.equal(Number(credit.credit), 250.5);

    const journal = await pool!.query(
      `SELECT source_type, source_id FROM gl_journals WHERE id = $1`,
      [row.journal_id]
    );
    assert.equal(journal.rows[0].source_type, 'EXPENSE_CLAIM');
    assert.equal(journal.rows[0].source_id, claimId);

    const again = await flushAccountingOutbox({ limit: 10, branchId: BRANCH });
    assert.equal(again.posted, 0, 'a posted claim is no longer owed');
    assert.equal(again.remaining, 0);
  });

  test('the flush CLI proves the database on its own and posts the queued claim', async () => {
    // The service was covered, the command was not: a standalone process has no
    // boot, so the shared pool refused every query and `npm run
    // accounting-outbox:flush` answered DB_UNAVAILABLE and posted nothing.
    const claimId = await submit(120);
    const decided = await decideClaim(REQUEST, APPROVER_USER, employee(APPROVER, 'Outbox Approver'), claimId, {
      approve: true,
      note: 'Approved for the CLI',
    });
    assert.equal(decided.accountingOutboxStatus, 'QUEUED');

    const run = spawnSync('npx', ['tsx', 'scripts/accounting_outbox.ts', 'flush'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 180_000,
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.match(output, /accounting outbox flush: posted [1-9]/, output.slice(0, 600));

    const row = await outbox(claimId);
    assert.equal(row.status, 'POSTED', output.slice(0, 600));
    assert.ok(row.journal_id, 'the CLI recorded the journal it posted');
  });

  test('a rejected claim cancels its posting instead of queueing it', async () => {
    const claimId = await submit(90);
    const decided = await decideClaim(REQUEST, APPROVER_USER, employee(APPROVER, 'Outbox Approver'), claimId, {
      approve: false,
      note: 'No receipt',
    });
    assert.equal(decided.status, 'REJECTED');
    assert.equal(decided.accountingOutboxStatus, 'CANCELLED');

    const flushed = await flushAccountingOutbox({ limit: 10, branchId: BRANCH });
    assert.equal(flushed.posted, 0);

    const row = await outbox(claimId);
    assert.equal(row.status, 'CANCELLED');
    assert.equal(row.journal_id, null);

    const journals = await pool!.query(
      `SELECT count(*)::int AS n FROM gl_journals WHERE source_type = 'EXPENSE_CLAIM' AND source_id = $1`,
      [claimId]
    );
    assert.equal(journals.rows[0].n, 0, 'a rejected claim posts nothing');
  });
});
