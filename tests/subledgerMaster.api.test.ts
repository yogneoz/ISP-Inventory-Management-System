/**
 * Subledger master + chart setup health.
 *
 * Pins the contract the Subledgers and General Ledger Master screens rely on:
 *   - a book is bound to exactly one control account, and its type comes from
 *     that account;
 *   - a control account owns at most one general book and any number of party
 *     books, all keyed by the shared customer/supplier/employee master id;
 *   - Salary Payable can generate one book per employee and move that party's
 *     existing rows from the general book into its own;
 *   - a book with posted rows cannot be deleted (retire it instead);
 *   - the seeded chart is complete: every posting role is held by an active
 *     ledger, every control account has an active book, and no retired ledger
 *     keeps a role;
 *   - `POST /api/accounting/chart-defaults` is idempotent;
 *   - the register list, unlinked count and book ledger apply the same branch
 *     window, and a control account with no active book cannot post;
 *   - the extra GL-master fields survive the account API as a bounded profile.
 *
 * Fixtures are throw-away accounts/books/employees created here and removed in
 * after(). Skips the HTTP half without a reachable PostgreSQL.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';

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

const PREFIX = 'SBT-';
const CONTROL_CODE = `${PREFIX}CONTROL`;
const PLAIN_CODE = `${PREFIX}PLAIN`;
const BOOK_CODE = `${PREFIX}BOOK`;
const POSTING_CODE = `${PREFIX}POST`;
const POSTING_BOOK_CODE = `${PREFIX}POSTBOOK`;
const NOBOOK_CODE = `${PREFIX}NOBOOK`;
const EMPLOYEE_CODE = `${PREFIX}EMP`;
const EMPLOYEE_BOOK_CODE = `${PREFIX}EMP-GEN`;
const EMPLOYEE_1 = 'sbt-employee-1';
const EMPLOYEE_2 = 'sbt-employee-2';

const SUPER_USER = {
  id: 'sbt-super', email: 'sbt-super@example.com', name: 'SBT Super',
  role: 'SUPER_ADMIN', branchId: 'BR-KTM',
  allowedBranchIds: ['BR-KTM'], canSwitchUser: false,
} as any;

describe('subledger master + chart health', () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let groupId = '';
  let branchId = '';
  let customerId = '';
  let controlAccountId = '';
  let plainAccountId = '';
  let bookId = '';
  let postedJournalId = '';
  let seededReceivableAccountId = '';
  let seededReceivableBookId = '';
  const token = issueAuthToken(SUPER_USER);

  async function cleanup() {
    if (!pool) return;
    await pool.query(
      `DELETE FROM gl_journals WHERE id IN (
         SELECT se.journal_id FROM gl_subledger_entries se
         JOIN gl_accounts a ON a.id = se.account_id
         WHERE a.code LIKE 'SBT-%')`
    );
    await pool.query(
      `DELETE FROM gl_subledgers WHERE main_account_id IN (
         SELECT id FROM gl_accounts WHERE code LIKE 'SBT-%')`
    );
    await pool.query("DELETE FROM gl_accounts WHERE code LIKE 'SBT-%'");
    await pool.query("DELETE FROM employees WHERE id LIKE 'sbt-employee-%' OR employee_code LIKE 'SBT-%'");
  }

  async function call(method: string, urlPath: string, body?: any) {
    const res = await fetch('http://127.0.0.1:' + port + urlPath, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is a finding */ }
    return { status: res.status, json };
  }

  before(async () => {
    if (!dbReachable || !pool) return;
    await cleanup();
    const group = await pool.query("SELECT id FROM gl_account_groups ORDER BY code LIMIT 1");
    groupId = group.rows[0]?.id;
    assert.ok(groupId, 'the seeded chart must provide at least one group');
    const branch = await pool.query("SELECT id FROM branches WHERE id = 'BR-KTM'");
    branchId = branch.rows[0]?.id || (await pool.query('SELECT id FROM branches ORDER BY id LIMIT 1')).rows[0]?.id;
    assert.ok(branchId, 'the seeded chart must provide at least one branch');
    const customer = await pool.query(
      "SELECT customer_id FROM customer_records WHERE status = 'ACTIVE' ORDER BY customer_id LIMIT 1"
    );
    customerId = customer.rows[0]?.customer_id || '';
    assert.ok(customerId, 'the seeded data must provide an active customer');

    await pool.query(
      `INSERT INTO employees (id, employee_code, name, branch_id, is_active)
       VALUES ($1, 'SBT-EMP-1', 'SBT Employee One', $2, TRUE),
              ($3, 'SBT-EMP-2', 'SBT Employee Two', $2, TRUE)
       ON CONFLICT (id) DO UPDATE SET
         employee_code = EXCLUDED.employee_code, name = EXCLUDED.name,
         branch_id = EXCLUDED.branch_id, is_active = TRUE`,
      [EMPLOYEE_1, branchId, EMPLOYEE_2]
    );

    const seeded = await pool.query(
      "SELECT a.id AS account_id, s.id AS book_id, s.code AS book_code, a.code AS account_code " +
      "FROM gl_accounts a LEFT JOIN gl_subledgers s ON s.main_account_id = a.id AND s.party_id IS NULL " +
      "WHERE a.posting_role = 'AR_CONTROL'"
    );
    seededReceivableAccountId = seeded.rows[0]?.account_id;
    seededReceivableBookId = seeded.rows[0]?.book_id;
    assert.ok(seededReceivableAccountId, 'the seeded chart must hold the AR control account');
    assert.ok(seededReceivableBookId, 'the seeded chart must give AR its subledger book');

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
    if (pool && dbReachable) {
      await cleanup().catch(() => undefined);
      await pool.end();
    }
  });

  test('the seeded chart gives every control account a general book', { skip: skipNoDb }, async () => {
    const list = await call('GET', '/api/accounting/subledgers');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json));
    const receivable = list.json.find(
      (book: any) => book.mainAccountId === seededReceivableAccountId && book.partyId === null
    );
    assert.ok(receivable, 'the AR control account must appear with its general book');
    assert.equal(receivable.subledgerType, 'CUSTOMER');
    assert.equal(typeof receivable.glBalance, 'string');
    assert.equal(typeof receivable.subledgerBalance, 'string');
    assert.equal(typeof receivable.bookBalance, 'string');
    assert.equal(typeof receivable.entryCount, 'number');
    // Party books are legitimate: generating them moves a party's rows out of
    // the general book, which can therefore be empty while the seeded account
    // still has posted rows. Assert the account carries linked rows in any of
    // its books, not specifically in the general one.
    const arBooks = list.json.filter(
      (book: any) => book.mainAccountId === seededReceivableAccountId
    );
    assert.ok(
      arBooks.some((book: any) => book.entryCount > 0),
      'the seeded AR account must carry posted rows in at least one of its books'
    );
    const linked = await pool!.query(
      `SELECT COUNT(*)::int AS count
         FROM gl_subledger_entries se
         JOIN gl_subledgers s ON s.id = se.subledger_id
        WHERE se.account_id = $1 AND s.main_account_id = $1`,
      [seededReceivableAccountId]
    );
    assert.ok(linked.rows[0].count > 0, 'seeded subledger rows must point at a book on their account');

    const duplicateGenerals = await pool!.query(
      'SELECT main_account_id, COUNT(*)::int AS count FROM gl_subledgers WHERE party_id IS NULL GROUP BY main_account_id HAVING COUNT(*) > 1'
    );
    assert.deepEqual(duplicateGenerals.rows, [], 'a control account may own only one general book');
  });

  test('chart health reports the seeded chart as complete', { skip: skipNoDb }, async () => {
    const health = await call('GET', '/api/accounting/chart-health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json.missingPostingRoles, []);
    assert.deepEqual(health.json.controlAccountsWithoutSubledger, []);
    assert.deepEqual(health.json.inactiveAccountsHoldingRole, []);
    assert.ok(health.json.totals.controlAccounts > 0);
    assert.ok(
      health.json.totals.subledgers >= health.json.totals.controlAccounts,
      'every control account has a book; party books are additional'
    );
  });

  test('a book is bound to the control account and its shared party master', { skip: skipNoDb }, async () => {
    const control = await call('POST', '/api/accounting/accounts', {
      code: CONTROL_CODE, name: 'SBT Control', groupId, subledgerType: 'CUSTOMER',
    });
    assert.equal(control.status, 201, JSON.stringify(control.json));
    controlAccountId = control.json.id;

    const plain = await call('POST', '/api/accounting/accounts', {
      code: PLAIN_CODE, name: 'SBT Plain', groupId, subledgerType: 'NONE',
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.json));
    plainAccountId = plain.json.id;

    const onPlain = await call('POST', '/api/accounting/subledgers', {
      code: BOOK_CODE, name: 'SBT Book', mainAccountId: plainAccountId,
    });
    assert.equal(onPlain.status, 400);
    assert.match(onPlain.json.message, /not a control account/i);

    const wrongType = await call('POST', '/api/accounting/subledgers', {
      code: BOOK_CODE, name: 'SBT Book', mainAccountId: controlAccountId, subledgerType: 'SUPPLIER',
    });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.json.message, /CUSTOMER subledger/i);

    const created = await call('POST', '/api/accounting/subledgers', {
      code: BOOK_CODE, name: 'SBT Book', mainAccountId: controlAccountId, subledgerType: 'CUSTOMER',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.mainAccountId, controlAccountId);
    assert.equal(created.json.accountCode, CONTROL_CODE);
    assert.equal(created.json.partyId, null);
    bookId = created.json.id;

    const secondGeneral = await call('POST', '/api/accounting/subledgers', {
      code: `${BOOK_CODE}-2`, name: 'SBT Second', mainAccountId: controlAccountId,
    });
    assert.equal(secondGeneral.status, 409);
    assert.match(secondGeneral.json.message, /already has a general subledger/i);

    const customerBook = await call('POST', '/api/accounting/subledgers', {
      code: `${BOOK_CODE}-CUST`, name: 'SBT Customer Book',
      mainAccountId: controlAccountId, partyId: customerId,
    });
    assert.equal(customerBook.status, 201, JSON.stringify(customerBook.json));
    assert.equal(customerBook.json.partyId, customerId);

    const duplicateParty = await call('POST', '/api/accounting/subledgers', {
      code: `${BOOK_CODE}-CUST-2`, name: 'SBT Duplicate Customer',
      mainAccountId: controlAccountId, partyId: customerId,
    });
    assert.equal(duplicateParty.status, 409);
    assert.match(duplicateParty.json.message, /already has a subledger for/i);

    const unknownParty = await call('POST', '/api/accounting/subledgers', {
      code: `${BOOK_CODE}-NONE`, name: 'SBT Unknown Party',
      mainAccountId: controlAccountId, partyId: 'SBT-CUSTOMER-MISSING',
    });
    assert.equal(unknownParty.status, 400);
    assert.match(unknownParty.json.message, /No active CUSTOMER master record/i);

    const removed = await call('DELETE', `/api/accounting/subledgers/${customerBook.json.id}`);
    assert.equal(removed.status, 200);
  });

  test('a book renames and retires, but its code and history are fixed', { skip: skipNoDb }, async () => {
    const codeChange = await call('PATCH', `/api/accounting/subledgers/${bookId}`, { code: 'SBT-OTHER' });
    assert.equal(codeChange.status, 400);
    assert.match(codeChange.json.message, /code cannot be changed/i);

    const partyChange = await call('PATCH', `/api/accounting/subledgers/${bookId}`, { partyId: customerId });
    assert.equal(partyChange.status, 400);
    assert.match(partyChange.json.message, /party cannot be changed/i);

    const renamed = await call('PATCH', `/api/accounting/subledgers/${bookId}`, {
      name: 'SBT Book Renamed', isActive: false,
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.json.name, 'SBT Book Renamed');
    assert.equal(renamed.json.isActive, false);
  });

  test('a book with posted rows cannot be deleted; an empty one can', { skip: skipNoDb }, async () => {
    const all = await call('GET', '/api/accounting/subledgers');
    const usedBook = all.json.find(
      (book: any) => book.mainAccountId === seededReceivableAccountId && book.entryCount > 0
    );
    assert.ok(usedBook, 'the seeded AR account must have a book with posted rows');
    const used = await call('DELETE', `/api/accounting/subledgers/${usedBook.id}`);
    assert.equal(used.status, 409);
    assert.match(used.json.message, /Retire it instead/i);

    const empty = await call('DELETE', `/api/accounting/subledgers/${bookId}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.json.deleted, true);

    const list = await call('GET', '/api/accounting/subledgers');
    assert.ok(!list.json.some((book: any) => book.id === bookId), 'the deleted book must be gone');
  });

  test('the default chart repair is idempotent', { skip: skipNoDb }, async () => {
    const first = await call('POST', '/api/accounting/chart-defaults');
    assert.equal(first.status, 200);
    assert.equal(typeof first.json.added.groups, 'number');
    assert.equal(typeof first.json.added.accounts, 'number');
    assert.equal(typeof first.json.added.subledgers, 'number');

    const second = await call('POST', '/api/accounting/chart-defaults');
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.added, { groups: 0, accounts: 0, subledgers: 0 });
    assert.match(second.json.message, /already exists/i);
  });

  test('posting refuses a control account without an active book', { skip: skipNoDb }, async () => {
    const account = await call('POST', '/api/accounting/accounts', {
      code: NOBOOK_CODE, name: 'SBT No Book', groupId, subledgerType: 'CUSTOMER',
    });
    assert.equal(account.status, 201, JSON.stringify(account.json));

    const refused = await call('POST', '/api/accounting/journals', {
      journalDateAD: '2026-08-15', branchId,
      memo: 'SBT no book refusal',
      lines: [
        { accountId: account.json.id, debit: 10, credit: 0, subledgerType: 'CUSTOMER', partyId: 'SBT-PARTY', partyName: 'SBT Party' },
        { accountId: plainAccountId, debit: 0, credit: 10 },
      ],
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.match(refused.json.message, /no active subledger book/i);
  });

  test('posting stores the resolved book and the register follows each branch', { skip: skipNoDb }, async () => {
    const account = await call('POST', '/api/accounting/accounts', {
      code: POSTING_CODE, name: 'SBT Posting Control', groupId, subledgerType: 'CUSTOMER',
    });
    assert.equal(account.status, 201, JSON.stringify(account.json));
    const book = await call('POST', '/api/accounting/subledgers', {
      code: POSTING_BOOK_CODE, name: 'SBT Posting Book', mainAccountId: account.json.id,
    });
    assert.equal(book.status, 201, JSON.stringify(book.json));

    const posted = await call('POST', '/api/accounting/journals', {
      journalDateAD: '2026-08-15',
      branchId,
      memo: 'SBT posting linkage',
      lines: [
        {
          accountId: account.json.id, debit: 125, credit: 0, subledgerType: 'CUSTOMER',
          partyId: 'SBT-PARTY', partyName: 'SBT Party',
        },
        { accountId: plainAccountId, debit: 0, credit: 125 },
      ],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    postedJournalId = posted.json.id;

    const second = await call('POST', '/api/accounting/journals', {
      journalDateAD: '2026-08-15',
      branchId: 'BR-PKR',
      memo: 'SBT posting linkage other branch',
      lines: [
        {
          accountId: account.json.id, debit: 75, credit: 0, subledgerType: 'CUSTOMER',
          partyId: 'SBT-PARTY-B', partyName: 'SBT Party B',
        },
        { accountId: plainAccountId, debit: 0, credit: 75 },
      ],
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const journal = await call('GET', '/api/accounting/journals/' + postedJournalId);
    assert.equal(journal.status, 200);
    assert.equal(journal.json.subledgerEntries.length, 1);
    assert.equal(journal.json.subledgerEntries[0].subledgerId, book.json.id);

    const ledger = await call('GET', `/api/accounting/subledgers/${book.json.id}/entries`);
    assert.equal(ledger.status, 200, JSON.stringify(ledger.json));
    assert.equal(ledger.json.entries.length, 2);
    assert.equal(ledger.json.totals.debit, 200);
    assert.equal(ledger.json.totals.credit, 0);
    assert.equal(ledger.json.totals.balance, 200);
    assert.deepEqual(
      ledger.json.parties.map((party: any) => [party.partyId, party.balance]),
      [['SBT-PARTY', 125], ['SBT-PARTY-B', 75]]
    );
    assert.equal(ledger.json.unlinkedCount, 0);

    const ktmLedger = await call('GET', `/api/accounting/subledgers/${book.json.id}/entries?branchId=BR-KTM`);
    assert.equal(ktmLedger.status, 200);
    assert.equal(ktmLedger.json.entries.length, 1);
    assert.equal(ktmLedger.json.entries[0].partyId, 'SBT-PARTY');
    assert.equal(ktmLedger.json.totals.balance, 125);

    const pkLedger = await call('GET', `/api/accounting/subledgers/${book.json.id}/entries?branchId=BR-PKR`);
    assert.equal(pkLedger.status, 200);
    assert.equal(pkLedger.json.entries.length, 1);
    assert.equal(pkLedger.json.entries[0].partyId, 'SBT-PARTY-B');
    assert.equal(pkLedger.json.totals.balance, 75);

    const allBooks = await call('GET', '/api/accounting/subledgers');
    const companyBook = allBooks.json.find((row: any) => row.id === book.json.id);
    assert.equal(Number(companyBook.bookBalance), 200);
    assert.equal(companyBook.entryCount, 2);

    const ktmBooks = await call('GET', '/api/accounting/subledgers?branchId=BR-KTM');
    const ktmBook = ktmBooks.json.find((row: any) => row.id === book.json.id);
    assert.equal(Number(ktmBook.bookBalance), 125);
    assert.equal(ktmBook.entryCount, 1);
    assert.equal(Number(ktmBook.subledgerBalance), 125);

    const pkBooks = await call('GET', '/api/accounting/subledgers?branchId=BR-PKR');
    const pkBook = pkBooks.json.find((row: any) => row.id === book.json.id);
    assert.equal(Number(pkBook.bookBalance), 75);
    assert.equal(pkBook.entryCount, 1);
    assert.equal(Number(pkBook.subledgerBalance), 75);

    const missing = await call('GET', '/api/accounting/subledgers/gls-missing/entries');
    assert.equal(missing.status, 404);
  });

  test('Salary Payable generates one book per employee and moves existing rows', { skip: skipNoDb }, async () => {
    const profile = {
      shortName: 'SAL-PAY',
      category: 'Payable',
      customerType: 'NONE',
      billWiseAdjustment: true,
      cashBook: false,
      area: 'Head Office',
      agent: 'Payroll',
      class: 'Staff',
      creditLimit: 5000,
      overLimitAllowed: true,
      creditDays: 30,
      overDaysAllowed: false,
      taxType: 'NONE',
      institutionType: 'PARTNERSHIP',
      bankGuarantee: '',
      cashDeposit: '',
      currency: 'NPR',
      interestRate: 8.5,
    };
    const account = await call('POST', '/api/accounting/accounts', {
      code: EMPLOYEE_CODE, name: 'SBT Employee Payable', groupId,
      subledgerType: 'EMPLOYEE', masterProfile: profile,
    });
    assert.equal(account.status, 201, JSON.stringify(account.json));
    assert.deepEqual(account.json.masterProfile, profile);

    const editedProfile = { ...profile, creditLimit: 7500, class: 'Senior Staff' };
    const edited = await call('PATCH', `/api/accounting/accounts/${account.json.id}`, {
      masterProfile: editedProfile,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.deepEqual(edited.json.masterProfile, editedProfile);

    const general = await call('POST', '/api/accounting/subledgers', {
      code: EMPLOYEE_BOOK_CODE, name: 'SBT Employee General',
      mainAccountId: account.json.id,
    });
    assert.equal(general.status, 201, JSON.stringify(general.json));

    const seededRow = await call('POST', '/api/accounting/journals', {
      journalDateAD: '2026-08-20', branchId,
      memo: 'SBT employee row before generation',
      lines: [
        {
          accountId: account.json.id, debit: 0, credit: 100, subledgerType: 'EMPLOYEE',
          partyId: EMPLOYEE_1, partyName: 'SBT Employee One',
        },
        { accountId: plainAccountId, debit: 100, credit: 0 },
      ],
    });
    assert.equal(seededRow.status, 201, JSON.stringify(seededRow.json));
    assert.equal(seededRow.json.subledgerEntries?.[0]?.subledgerId ?? general.json.id, general.json.id);

    const generated = await call('POST', '/api/accounting/subledgers/generate', {
      mainAccountId: account.json.id,
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.json));
    assert.equal(generated.json.subledgerType, 'EMPLOYEE');
    assert.ok(generated.json.created >= 2, 'both fixture employees need their own book');
    assert.ok(generated.json.total >= 2);
    assert.ok(generated.json.linkedEntries >= 1, 'the employee row must move from the general book');

    const list = await call('GET', '/api/accounting/subledgers');
    const employeeBooks = list.json.filter(
      (row: any) => row.mainAccountId === account.json.id && row.partyId
    );
    const one = employeeBooks.find((row: any) => row.partyId === EMPLOYEE_1);
    const two = employeeBooks.find((row: any) => row.partyId === EMPLOYEE_2);
    assert.ok(one, 'employee one must have a party book');
    assert.ok(two, 'employee two must have a party book');
    assert.equal(Number(one.bookBalance), -100);
    assert.equal(Number(one.subledgerBalance), -100);
    assert.equal(one.unlinkedCount, 0);

    const generalRow = list.json.find((row: any) => row.id === general.json.id);
    assert.equal(Number(generalRow.bookBalance), 0);
    assert.equal(generalRow.entryCount, 0);

    const oneLedger = await call('GET', `/api/accounting/subledgers/${one.id}/entries`);
    assert.equal(oneLedger.status, 200, JSON.stringify(oneLedger.json));
    assert.equal(oneLedger.json.entries.length, 1);
    assert.equal(oneLedger.json.entries[0].partyId, EMPLOYEE_1);
    assert.equal(oneLedger.json.totals.credit, 100);

    const postedToPartyBook = await call('POST', '/api/accounting/journals', {
      journalDateAD: '2026-08-20', branchId,
      memo: 'SBT employee row after generation',
      lines: [
        {
          accountId: account.json.id, debit: 0, credit: 50, subledgerType: 'EMPLOYEE',
          partyId: EMPLOYEE_2, partyName: 'SBT Employee Two',
        },
        { accountId: plainAccountId, debit: 50, credit: 0 },
      ],
    });
    assert.equal(postedToPartyBook.status, 201, JSON.stringify(postedToPartyBook.json));
    assert.equal(postedToPartyBook.json.subledgerEntries[0].subledgerId, two.id);

    const duplicateParty = await call('POST', '/api/accounting/subledgers', {
      code: `${EMPLOYEE_BOOK_CODE}-DUP`, name: 'SBT Duplicate Employee',
      mainAccountId: account.json.id, partyId: EMPLOYEE_1,
    });
    assert.equal(duplicateParty.status, 409);
    assert.match(duplicateParty.json.message, /already has a subledger for/i);

    const unknownEmployee = await call('POST', '/api/accounting/subledgers', {
      code: `${EMPLOYEE_BOOK_CODE}-NONE`, name: 'SBT Unknown Employee',
      mainAccountId: account.json.id, partyId: 'sbt-employee-missing',
    });
    assert.equal(unknownEmployee.status, 400);
    assert.match(unknownEmployee.json.message, /No active EMPLOYEE master record/i);

    const again = await call('POST', '/api/accounting/subledgers/generate', {
      mainAccountId: account.json.id,
    });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.created, 0, 'generation is idempotent');
    assert.ok(again.json.skipped >= 2);

    const otherBranch = await call(
      'GET',
      `/api/accounting/subledgers/${one.id}/entries?branchId=BR-PKR`
    );
    assert.equal(otherBranch.status, 200);
    assert.deepEqual(otherBranch.json.entries, []);
    assert.equal(otherBranch.json.totals.balance, 0);
  });
});
