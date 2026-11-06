/**
 * Financial statements API — real Express app against real PostgreSQL.
 *
 * This is the gate for the plan's source-of-truth claim: the statements must be
 * produced from POSTED journal lines, not from the operational registers. The
 * fixture posts three kinds of journals through the real routes — manual
 * customer/supplier/expense/inter-branch entries and a real sales invoice — in
 * one dedicated branch, then pins every figure the three statements expose:
 *
 *   1. TRIAL BALANCE: debit = credit for opening, turnover and closing; the
 *      as-of call starts the opening window at the fiscal-year boundary; an
 *      explicit `from` moves the right journals into opening vs turnover.
 *   2. PROFIT AND LOSS: revenue, cost of sales and expenses for the range,
 *      nested by statement group then account group; an earlier range is
 *      genuinely empty, so the totals cannot be hard-coded.
 *   3. BALANCE SHEET: assets = liabilities + equity + current earnings for the
 *      branch, the company roll-up, and one branch in isolation; due to/from
 *      head office are reported as a breakdown and already inside the totals.
 *   4. CONTROL AGREEMENT: every control account's GL balance equals its
 *      subledger, and a deliberately altered subledger row shows the difference
 *      instead of a hard-coded zero.
 *
 * Dates sit in July 2026 (fy-4 2083-84) deliberately: the other ledger suites
 * post at 2026-08-15 or "today", so a company-level statement as of 2026-07-31
 * is not polluted by tests running in parallel. The dedicated ASTBR branch and
 * AST-prefixed accounts keep the branch-scoped assertions isolated too.
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

const BR = 'ASTBR';
const OTHER = 'WH001';
const INVOICE_DATE = '2026-07-25';
const TO = '2026-07-31';
/** fy-4 2083-84 starts on this date (server/src/config/seedData.ts). */
const FY_START = '2026-07-17';
const PERIOD_KEY = '2026-07';
const PRODUCT = 'ast-prod';
const CUSTOMER = 'ast-customer';

const USERS = {
  super: { id: 'ast-super', email: 'ast-super@example.com', name: 'AST Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'ast-accountant', email: 'ast-accountant@example.com', name: 'AST Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  auditor: { id: 'ast-auditor', email: 'ast-auditor@example.com', name: 'AST Auditor', role: 'AUDITOR', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  noView: { id: 'ast-frontdesk', email: 'ast-frontdesk@example.com', name: 'AST Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  empty: { id: 'ast-empty', email: 'ast-empty@example.com', name: 'AST Empty', role: 'ACCOUNTANT', branchId: '', allowedBranchIds: [], canSwitchUser: false },
} as const;

const tokens = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

interface AccountFixture {
  customerControl: string;
  supplierControl: string;
  income: string;
  expense: string;
  dueFrom: string;
  dueTo: string;
  cash: string;
}

describe('financial statements API (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const accounts = {} as AccountFixture;

  async function request(
    method: 'GET' | 'POST',
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

  async function createGroup(code: string, name: string, accountType: string, statementGroup: string) {
    const res = await post('/api/accounting/groups', tokens.super, { code, name, accountType, statementGroup });
    assert.equal(res.status, 201, `group ${code}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function createAccount(input: Record<string, unknown>) {
    const res = await post('/api/accounting/accounts', tokens.super, input);
    assert.equal(res.status, 201, `account ${String(input.code)}: ${JSON.stringify(res.json)}`);
    return res.json.id as string;
  }

  async function createControlAccount(input: Record<string, unknown>) {
    const id = await createAccount(input);
    const book = await post('/api/accounting/subledgers', tokens.super, {
      code: `SL-${String(input.code)}`,
      name: `Book ${String(input.name)}`,
      mainAccountId: id,
    });
    assert.equal(book.status, 201, `book ${String(input.code)}: ${JSON.stringify(book.json)}`);
    return id;
  }

  function line(accountId: string, debit: number, credit: number, extra: Record<string, unknown> = {}) {
    return { accountId, debit, credit, ...extra };
  }

  async function postJournal(
    journalDateAD: string,
    branchId: string,
    sourceId: string,
    memo: string,
    lines: unknown[]
  ) {
    const res = await post('/api/accounting/journals', tokens.super, {
      journalDateAD,
      branchId,
      sourceId,
      memo,
      lines,
    });
    assert.equal(res.status, 201, `journal ${sourceId}: ${JSON.stringify(res.json)}`);
    return res.json;
  }

  function sectionOf(sections: any[], statementGroup: string) {
    return sections.find((section) => section.statementGroup === statementGroup);
  }

  function groupOf(groups: any[], code: string): any {
    for (const group of groups || []) {
      if (group.code === code) return group;
      const nested = groupOf(group.children, code);
      if (nested) return nested;
    }
    return undefined;
  }

  function accountOf(accountsRes: any[], code: string) {
    return accountsRes.find((account) => account.code === code);
  }

  function controlOf(controls: any[], code: string) {
    return controls.find((control) => control.code === code);
  }

  async function cleanup() {
    // Journals first: their branch and account FKs are RESTRICT.
    await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'ast-%' OR memo LIKE 'AST %'");
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'ast-%'");
    await pool!.query("DELETE FROM customer_records WHERE id LIKE 'ast-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'ast-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'ast-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%AST-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'ast-%'");
    await pool!.query(
      "DELETE FROM gl_subledgers WHERE main_account_id IN (SELECT id FROM gl_accounts WHERE code LIKE 'AST-%')"
    );
    await pool!.query("DELETE FROM gl_accounts WHERE code LIKE 'AST-%'");
    await pool!.query("DELETE FROM gl_account_groups WHERE code LIKE 'AST-%'");
    await pool!.query(
      // Only the app-created period for this month (glp- ids). A seeded/real
      // period for the same month owns journals, and the period FK is RESTRICT.
      "DELETE FROM gl_periods WHERE period_key = $1 AND fiscal_year_id = (SELECT id FROM fiscal_years WHERE code = '2083-84') AND id LIKE 'glp-%'",
      [PERIOD_KEY]
    );
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  before(async () => {
    await ensureReferenceData(pool!, INVOICE_DATE);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'ASTB', 'AST Statements Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, $1, 'AST Customer', '9800000000', $2, 'ACTIVE')`,
      [CUSTOMER, BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'AST Router', 'AST-SKU', 'Equipment', 'Product Item', 'Pcs', 90, 150, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ('ast-stock', $1, $2, 10, 90, 1)`,
      [PRODUCT, BR]
    );

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const assetGroup = await createGroup('AST-CA', 'AST Current Assets', 'ASSET', 'CURRENT_ASSET');
    const liabilityGroup = await createGroup('AST-CL', 'AST Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY');
    const incomeGroup = await createGroup('AST-RG', 'AST Revenue Group', 'INCOME', 'REVENUE');
    const expenseGroup = await createGroup('AST-EX', 'AST Expense Group', 'EXPENSE', 'OPERATING_EXPENSE');

    accounts.customerControl = await createControlAccount({
      code: 'AST-1100', name: 'AST Customer Control', groupId: assetGroup,
      isControl: true, subledgerType: 'CUSTOMER',
    });
    accounts.dueFrom = await createControlAccount({
      code: 'AST-1610', name: 'AST Due from Head Office', groupId: assetGroup,
      isControl: true, subledgerType: 'INTER_BRANCH',
    });
    accounts.supplierControl = await createControlAccount({
      code: 'AST-2000', name: 'AST Supplier Control', groupId: liabilityGroup,
      isControl: true, subledgerType: 'SUPPLIER',
    });
    accounts.dueTo = await createControlAccount({
      code: 'AST-2310', name: 'AST Due to Head Office', groupId: liabilityGroup,
      isControl: true, subledgerType: 'INTER_BRANCH',
    });
    accounts.income = await createAccount({ code: 'AST-4100', name: 'AST Sales Revenue', groupId: incomeGroup });
    accounts.expense = await createAccount({ code: 'AST-6100', name: 'AST Office Expense', groupId: expenseGroup });

    // Seeded posting defaults: the invoice posts through these.
    const defaults = await get('/api/accounting/posting-defaults', tokens.super);
    assert.equal(defaults.status, 200, JSON.stringify(defaults.json));
    accounts.cash = defaults.json.defaults.CASH.accountId;

    // 1. A customer sale on account, 1130.
    await postJournal('2026-07-20', BR, 'ast-m1', 'AST manual customer sale', [
      line(accounts.customerControl, 1130, 0, {
        subledgerType: 'CUSTOMER', partyId: 'ast-cust-1', partyName: 'AST Customer',
      }),
      line(accounts.income, 0, 1130),
    ]);

    // 2. Cash expense, 500.
    await postJournal('2026-07-22', BR, 'ast-m2', 'AST manual cash expense', [
      line(accounts.expense, 500, 0),
      line(accounts.cash, 0, 500),
    ]);

    // 3. Inter-branch custody: due from / due to head office, 500 each.
    await postJournal('2026-07-23', BR, 'ast-m3', 'AST manual inter-branch custody', [
      line(accounts.dueFrom, 500, 0, { subledgerType: 'INTER_BRANCH', partyId: 'HQ', partyName: 'Head Office' }),
      line(accounts.dueTo, 0, 500, { subledgerType: 'INTER_BRANCH', partyId: 'HQ', partyName: 'Head Office' }),
    ]);

    // 4. A supplier bill on credit, 200.
    await postJournal('2026-07-24', BR, 'ast-m4', 'AST manual supplier bill', [
      line(accounts.expense, 200, 0),
      line(accounts.supplierControl, 0, 200, {
        subledgerType: 'SUPPLIER', partyId: 'ast-sup-1', partyName: 'AST Supplier',
      }),
    ]);

    // 5. A real sales invoice through the real route: 2 × 150 + 13% VAT, COGS
    //    at the stock row's weighted average (90 × 2 = 180).
    const invoice = await post('/api/sales-invoices', tokens.super, {
      id: 'ast-si-1',
      invoiceNumber: 'AST-SI-1',
      customerId: CUSTOMER,
      customerName: 'AST Customer',
      branchId: BR,
      invoiceDateAD: INVOICE_DATE,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [{
        productId: PRODUCT, productName: 'AST Router', sku: 'AST-SKU', unit: 'Pcs',
        quantity: 2, unitPrice: 150, discount: 0, taxRate: 13, isTaxExempt: false,
      }],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
    assert.equal(invoice.json.grandTotal, 339);

    // 6. A second branch, so the company roll-up has something to add.
    await postJournal('2026-07-26', OTHER, 'ast-m5', 'AST manual other-branch sale', [
      line(accounts.cash, 50, 0),
      line(accounts.income, 0, 50),
    ]);
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('a trial balance is balanced in opening, turnover and closing and nests account groups', async () => {
    const res = await get(
      `/api/accounting/statements/trial-balance?asOf=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.statement, 'TRIAL_BALANCE');
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.from, FY_START, 'an as-of call opens at the fiscal-year boundary');
    assert.equal(res.json.to, TO);
    assert.equal(res.json.balanced, true);
    assert.equal(res.json.controlsReconciled, true);

    // 1130 + 500 + 500 + 200 + 339 + 180 = 2849 on each side.
    assert.deepEqual(res.json.totals, {
      openingDebit: 0, openingCredit: 0,
      periodDebit: 2849, periodCredit: 2849,
      closingDebit: 2849, closingCredit: 2849,
    });

    const customerControl = accountOf(res.json.accounts, 'AST-1100');
    assert.equal(customerControl.closingDebit, 1130);
    assert.equal(accountOf(res.json.accounts, 'AST-4100').closingCredit, 1130);
    assert.equal(accountOf(res.json.accounts, 'AST-6100').closingDebit, 700);
    assert.equal(accountOf(res.json.accounts, 'AST-1610').closingDebit, 500);
    assert.equal(accountOf(res.json.accounts, 'AST-2310').closingCredit, 500);
    assert.equal(accountOf(res.json.accounts, 'AST-2000').closingCredit, 200);
    assert.equal(accountOf(res.json.accounts, '1010').closingCredit, 500, 'cash was paid out');
    assert.equal(accountOf(res.json.accounts, '1100').closingDebit, 339, 'the invoice AR');
    assert.equal(accountOf(res.json.accounts, '4000').closingCredit, 300, 'invoice revenue');
    assert.equal(accountOf(res.json.accounts, '2200').closingCredit, 39, 'invoice output VAT');
    assert.equal(accountOf(res.json.accounts, '5000').closingDebit, 180, 'invoice COGS');
    assert.equal(accountOf(res.json.accounts, '1200').closingCredit, 180, 'inventory relieved as a credit');

    const currentAssets = sectionOf(res.json.sections, 'CURRENT_ASSET');
    assert.ok(currentAssets, 'the trial balance must be presented by statement group');
    assert.equal(currentAssets.label, 'Current assets');
    const ownGroup = currentAssets.groups.find((group: any) => group.groupCode === 'AST-CA');
    assert.ok(ownGroup, 'account groups must nest inside their statement group');
    assert.equal(ownGroup.accounts.length, 2);
    assert.equal(ownGroup.amount, 1630, 'AST-1100 1130 + AST-1610 500');

    const revenue = sectionOf(res.json.sections, 'REVENUE');
    assert.equal(revenue.groups.find((group: any) => group.groupCode === 'AST-RG').amount, 1130);

    assert.equal(controlOf(res.json.controls, 'AST-1100').status, 'RECONCILED');
    assert.equal(controlOf(res.json.controls, 'AST-1100').glBalance, 1130);
    assert.equal(controlOf(res.json.controls, 'AST-2000').subledgerBalance, -200);
    assert.equal(controlOf(res.json.controls, 'AST-2310').glBalance, -500, 'signed debit-positive');
    assert.equal(controlOf(res.json.controls, '1100').glBalance, 339, 'the invoice control account');
  });

  test('an explicit from date splits opening from turnover', async () => {
    const res = await get(
      `/api/accounting/statements/trial-balance?from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.from, '2026-07-24');
    assert.deepEqual(res.json.totals, {
      openingDebit: 2130, openingCredit: 2130,
      periodDebit: 719, periodCredit: 719,
      closingDebit: 2849, closingCredit: 2849,
    });

    const expense = accountOf(res.json.accounts, 'AST-6100');
    assert.equal(expense.openingBalance, 500, 'the cash expense precedes the window');
    assert.equal(expense.periodDebit, 200, 'the supplier bill falls inside the window');
    assert.equal(expense.closingBalance, 700);
    assert.equal(accountOf(res.json.accounts, 'AST-1100').openingDebit, 1130);
    assert.equal(accountOf(res.json.accounts, '1100').openingDebit, 0);
  });

  test('a trial balance group drill-down splits opening from period and ties to the group subtotal', async () => {
    const trial = await get(
      `/api/accounting/statements/trial-balance?from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    const expenseGroup = groupOf(trial.json.groups, 'AST-EX');
    assert.ok(expenseGroup, 'the expense group must be in the trial balance tree');
    assert.deepEqual(
      {
        openingDebit: expenseGroup.openingDebit,
        openingCredit: expenseGroup.openingCredit,
        periodDebit: expenseGroup.periodDebit,
        periodCredit: expenseGroup.periodCredit,
        closingDebit: expenseGroup.closingDebit,
        closingCredit: expenseGroup.closingCredit,
      },
      {
        openingDebit: 500,
        openingCredit: 0,
        periodDebit: 200,
        periodCredit: 0,
        closingDebit: 700,
        closingCredit: 0,
      }
    );

    const lines = await get(
      `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
        `&from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(lines.status, 200, JSON.stringify(lines.json));
    assert.equal(lines.json.statement, 'TRIAL_BALANCE');
    assert.equal(lines.json.branchId, BR);
    assert.equal(lines.json.from, '2026-07-24');
    assert.equal(lines.json.to, TO);
    assert.equal(lines.json.group.groupCode, 'AST-EX');
    assert.deepEqual(
      {
        openingDebit: lines.json.group.openingDebit,
        openingCredit: lines.json.group.openingCredit,
        periodDebit: lines.json.group.periodDebit,
        periodCredit: lines.json.group.periodCredit,
        closingDebit: lines.json.group.closingDebit,
        closingCredit: lines.json.group.closingCredit,
      },
      {
        openingDebit: 500,
        openingCredit: 0,
        periodDebit: 200,
        periodCredit: 0,
        closingDebit: 700,
        closingCredit: 0,
      }
    );
    assert.deepEqual(lines.json.totals, {
      openingDebit: 500,
      openingCredit: 0,
      periodDebit: 200,
      periodCredit: 0,
      closingDebit: 700,
      closingCredit: 0,
      openingEntryCount: 1,
      periodEntryCount: 1,
      entryCount: 2,
    });
    assert.equal(lines.json.truncated, false);
    assert.equal(lines.json.limit, 500);
    assert.deepEqual(lines.json.entries.map((entry: any) => entry.window), ['OPENING', 'PERIOD']);
    assert.deepEqual(
      lines.json.entries.map((entry: any) => entry.journalDateAD),
      ['2026-07-22', '2026-07-24'],
      'opening lines precede the window and period lines fall inside it'
    );
    assert.deepEqual(
      lines.json.entries.map((entry: any) => [entry.accountCode, entry.debit, entry.credit]),
      [
        ['AST-6100', 500, 0],
        ['AST-6100', 200, 0],
      ]
    );

    // The same figures must equal the group that opened the drill-down.
    for (const key of [
      'openingDebit', 'openingCredit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit',
    ] as const) {
      assert.equal(lines.json.totals[key], expenseGroup[key], `${key} must tie to the trial balance`);
    }

    const defaultWindow = await get(
      `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
        `&asOf=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(defaultWindow.status, 200, JSON.stringify(defaultWindow.json));
    assert.equal(defaultWindow.json.from, FY_START, 'an as-of trial balance drill-down opens at the fiscal year');
    assert.deepEqual(
      defaultWindow.json.entries.map((entry: any) => entry.window),
      ['PERIOD', 'PERIOD'],
      'the earlier expense becomes period turnover in the default fiscal-year window'
    );

    const otherBranch = await get(
      `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
        `&from=2026-07-24&to=${TO}&branchId=${OTHER}`,
      tokens.super
    );
    assert.equal(otherBranch.status, 200, JSON.stringify(otherBranch.json));
    assert.equal(otherBranch.json.totals.entryCount, 0, 'another branch must not see these lines');
    assert.equal(otherBranch.json.group.openingDebit, 0);

    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
          `&from=2026-07-24&to=${TO}&branchId=ALL`,
        tokens.accountant
      )).status,
      403,
      'a branch account cannot widen a trial-balance drill-down to ALL'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
          `&from=2026-07-24&to=${TO}`,
        tokens.accountant
      )).status,
      200,
      'the same branch account can read its own scope'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${expenseGroup.groupId}` +
          `&from=2026-07-24&to=${TO}`,
        tokens.noView
      )).status,
      403
    );
  });

  test('a trial balance account drill-down carries a debit-positive running balance and ties to the account row', async () => {
    const trial = await get(
      `/api/accounting/statements/trial-balance?from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(trial.status, 200, JSON.stringify(trial.json));
    const expense = accountOf(trial.json.accounts, 'AST-6100');
    assert.ok(expense, 'the expense account must be in the trial balance');

    const lines = await get(
      `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
        `&from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(lines.status, 200, JSON.stringify(lines.json));
    assert.equal(lines.json.statement, 'TRIAL_BALANCE');
    assert.equal(lines.json.branchId, BR);
    assert.equal(lines.json.from, '2026-07-24');
    assert.equal(lines.json.to, TO);
    assert.equal(lines.json.account.accountId, expense.accountId);
    assert.equal(lines.json.account.code, 'AST-6100');
    assert.equal(lines.json.truncated, false);
    assert.equal(lines.json.limit, 500);

    // The account summary and the independently totalled lines must both equal
    // the row that opened the drill-down.
    for (const key of [
      'openingDebit', 'openingCredit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit',
    ] as const) {
      assert.equal(lines.json.account[key], expense[key], `account.${key} must tie to the trial balance`);
      assert.equal(lines.json.totals[key], expense[key], `totals.${key} must tie to the trial balance`);
    }
    assert.deepEqual(
      lines.json.entries.map((entry: any) => [
        entry.window, entry.journalDateAD, entry.debit, entry.credit, entry.runningBalance,
      ]),
      [
        ['OPENING', '2026-07-22', 500, 0, 500],
        ['PERIOD', '2026-07-24', 200, 0, 700],
      ],
      'opening lines run from zero and period lines carry the opening balance forward'
    );
    assert.equal(lines.json.entries[1].runningBalance, expense.closingBalance);
    assert.deepEqual(lines.json.totals, {
      openingDebit: 500,
      openingCredit: 0,
      periodDebit: 200,
      periodCredit: 0,
      closingDebit: 700,
      closingCredit: 0,
      openingEntryCount: 1,
      periodEntryCount: 1,
      entryCount: 2,
    });

    // With the default fiscal-year window the earlier expense is period
    // turnover, so the run starts from an opening balance of zero.
    const defaultWindow = await get(
      `/api/accounting/statements/account-lines?accountId=${expense.accountId}&asOf=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(defaultWindow.status, 200, JSON.stringify(defaultWindow.json));
    assert.equal(defaultWindow.json.from, FY_START);
    assert.equal(defaultWindow.json.account.openingBalance, 0);
    assert.deepEqual(
      defaultWindow.json.entries.map((entry: any) => entry.window),
      ['PERIOD', 'PERIOD']
    );
    assert.deepEqual(
      defaultWindow.json.entries.map((entry: any) => entry.runningBalance),
      [500, 700]
    );

    // A credit balance runs negative: the column is debit-positive (Dr - Cr).
    const supplier = accountOf(trial.json.accounts, 'AST-2000');
    const supplierLines = await get(
      `/api/accounting/statements/account-lines?accountId=${supplier.accountId}` +
        `&from=2026-07-24&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(supplierLines.status, 200, JSON.stringify(supplierLines.json));
    assert.deepEqual(
      supplierLines.json.entries.map((entry: any) => [entry.credit, entry.runningBalance]),
      [[200, -200]]
    );
    assert.equal(supplierLines.json.account.closingBalance, -200);

    const otherBranch = await get(
      `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
        `&from=2026-07-24&to=${TO}&branchId=${OTHER}`,
      tokens.super
    );
    assert.equal(otherBranch.status, 200, JSON.stringify(otherBranch.json));
    assert.equal(otherBranch.json.account.code, 'AST-6100', 'the chart row is global');
    assert.equal(otherBranch.json.totals.entryCount, 0, 'another branch must not see these lines');
    assert.equal(otherBranch.json.account.closingBalance, 0);

    const own = await get(
      `/api/accounting/statements/account-lines?accountId=${expense.accountId}&from=2026-07-24&to=${TO}`,
      tokens.accountant
    );
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch');

    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
          `&from=2026-07-24&to=${TO}&branchId=ALL`,
        tokens.accountant
      )).status,
      403,
      'a branch account cannot widen an account drill-down to ALL'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
          `&from=2026-07-24&to=${TO}&branchId=${OTHER}`,
        tokens.accountant
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
          `&from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.noView
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?accountId=${expense.accountId}` +
          `&from=2026-07-24&to=${TO}&branchId=${BR}`
      )).status,
      401
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.super
      )).status,
      400,
      'an account drill-down needs an account id'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/account-lines?accountId=not-an-account` +
          `&from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.super
      )).status,
      404
    );
  });

  test('profit and loss reports the period by statement group and account group', async () => {
    const res = await get(
      `/api/accounting/statements/profit-and-loss?from=2026-07-01&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.statement, 'PROFIT_AND_LOSS');
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.revenue, 1430, 'manual 1130 + invoice 300');
    assert.equal(res.json.otherIncome, 0);
    assert.equal(res.json.totalIncome, 1430);
    assert.equal(res.json.costOfSales, 180);
    assert.equal(res.json.operatingExpense, 700);
    assert.equal(res.json.otherExpense, 0);
    assert.equal(res.json.totalExpenses, 880);
    assert.equal(res.json.grossProfit, 1250);
    assert.equal(res.json.netProfit, 550);

    assert.deepEqual(
      res.json.sections.map((section: any) => section.statementGroup),
      ['REVENUE', 'COST_OF_SALES', 'OPERATING_EXPENSE'],
      'empty statement groups are omitted, the rest keep their canonical order'
    );
    const revenue = sectionOf(res.json.sections, 'REVENUE');
    assert.equal(revenue.groups.length, 2, 'the manual journal and the invoice use different groups');
    assert.equal(revenue.groups.find((group: any) => group.groupCode === 'AST-RG').amount, 1130);
    assert.equal(revenue.groups.find((group: any) => group.groupCode === '4000').amount, 300);

    const expenses = sectionOf(res.json.sections, 'OPERATING_EXPENSE');
    assert.equal(expenses.groups[0].groupCode, 'AST-EX');
    assert.equal(expenses.groups[0].accounts[0].code, 'AST-6100');
    assert.equal(expenses.groups[0].amount, 700);
  });

  test('profit and loss is empty for a range with no journals and defaults to the fiscal year', async () => {
    const empty = await get(
      `/api/accounting/statements/profit-and-loss?from=2026-07-01&to=2026-07-19&branchId=${BR}`,
      tokens.super
    );
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.netProfit, 0);
    assert.deepEqual(empty.json.sections, [], 'no journals in the range means no sections');

    const asOf = await get(`/api/accounting/statements/profit-and-loss?asOf=${TO}&branchId=${BR}`, tokens.super);
    assert.equal(asOf.status, 200, JSON.stringify(asOf.json));
    assert.equal(asOf.json.from, FY_START);
    assert.equal(asOf.json.netProfit, 550, 'the as-of call covers the fiscal year to date');
  });

  test('cash flow classifies posted cash movements and ties opening + net to the cash book', async () => {
    try {
      const nonCurrentGroup = await createGroup(
        'AST-NCA', 'AST Non-current Assets', 'ASSET', 'NON_CURRENT_ASSET'
      );
      const equityGroup = await createGroup('AST-EQ', 'AST Equity', 'EQUITY', 'EQUITY');
      const fixedAsset = await createAccount({
        code: 'AST-1500', name: 'AST Equipment', groupId: nonCurrentGroup,
      });
      const capital = await createAccount({
        code: 'AST-3000', name: 'AST Owner Capital', groupId: equityGroup,
      });

      // Cash expense 500 (already in the fixture) is operating; the equipment
      // purchase is investing; the owner contribution is financing.
      await postJournal('2026-07-27', BR, 'ast-cf-invest', 'AST cash equipment purchase', [
        line(fixedAsset, 300, 0),
        line(accounts.cash, 0, 300),
      ]);
      await postJournal('2026-07-28', BR, 'ast-cf-finance', 'AST owner capital contribution', [
        line(accounts.cash, 700, 0),
        line(capital, 0, 700),
      ]);

      const res = await get(
        `/api/accounting/statements/cash-flow?from=2026-07-01&to=${TO}&branchId=${BR}`,
        tokens.super
      );
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.equal(res.json.statement, 'CASH_FLOW');
      assert.equal(res.json.method, 'DIRECT');
      assert.equal(res.json.branchId, BR);
      assert.equal(res.json.from, '2026-07-01');
      assert.equal(res.json.to, TO);

      const section = (key: string) => res.json.sections.find((item: any) => item.key === key);
      assert.deepEqual(
        res.json.sections.map((item: any) => item.key),
        ['OPERATING', 'INVESTING', 'FINANCING'],
        'sections keep the canonical operating → investing → financing order'
      );
      assert.equal(section('OPERATING').amount, -500);
      assert.equal(section('INVESTING').amount, -300);
      assert.equal(section('FINANCING').amount, 700);
      assert.equal(
        section('OPERATING').lines.find((line: any) => line.accountCode === 'AST-6100').amount,
        -500
      );
      assert.equal(
        section('INVESTING').lines.find((line: any) => line.accountCode === 'AST-1500').amount,
        -300
      );
      assert.equal(
        section('FINANCING').lines.find((line: any) => line.accountCode === 'AST-3000').amount,
        700
      );

      assert.equal(res.json.openingCash, 0);
      assert.equal(res.json.netCashFlow, -100);
      assert.equal(res.json.classifiedCashFlow, -100);
      assert.equal(res.json.closingCash, -100);
      assert.equal(res.json.cashBookClosing, -100);
      assert.equal(res.json.difference, 0);
      assert.equal(res.json.reconciled, true);
    } finally {
      await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'ast-cf-%'");
      await pool!.query("DELETE FROM gl_accounts WHERE code IN ('AST-1500', 'AST-3000')");
      await pool!.query("DELETE FROM gl_account_groups WHERE code IN ('AST-NCA', 'AST-EQ')");
    }
  });

  test('the balance sheet balances per branch and reports due to/from head office', async () => {
    const res = await get(
      `/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.statement, 'BALANCE_SHEET');
    assert.equal(res.json.branchId, BR);
    assert.equal(res.json.from, null);
    assert.equal(res.json.asOf, TO);

    // Assets: AR 339 + AST-1100 1130 + AST-1610 500 − cash 500 − inventory 180 = 1289.
    assert.equal(res.json.totalAssets, 1289);
    // Liabilities: AST-2000 200 + VAT 39 + AST-2310 500 = 739.
    assert.equal(res.json.totalLiabilities, 739);
    assert.equal(res.json.equity.postedTotal, 0);
    assert.equal(res.json.equity.currentEarnings, 550, 'revenue 1430 − expenses 880');
    assert.equal(res.json.totalEquity, 550);
    assert.equal(res.json.totalLiabilitiesAndEquity, 1289);
    assert.equal(res.json.difference, 0);
    assert.equal(res.json.balanced, true);

    assert.deepEqual(res.json.interBranch, { dueFromHeadOffice: 500, dueToHeadOffice: 500 });

    const assetGroup = res.json.assets.sections[0].groups.find((group: any) => group.groupCode === 'AST-CA');
    assert.equal(assetGroup.amount, 1630);
    assert.equal(res.json.assets.sections[0].label, 'Current assets');
  });

  test('the company level rolls the branches up and one branch still balances alone', async () => {
    const company = await get(
      `/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=ALL`,
      tokens.super
    );
    assert.equal(company.status, 200, JSON.stringify(company.json));
    assert.equal(company.json.branchId, 'ALL');

    // A shared database is not empty, so the company level is asserted as the
    // roll-up of every branch rather than a fixed number: the property under
    // test is the roll-up, and the seeded verification dataset legitimately
    // contributes journals to the same fiscal year.
    const allBranches = (await get('/api/branches', tokens.super)).json as any[];
    let branchAssets = 0;
    let branchLiabilities = 0;
    let branchEarnings = 0;
    let branchDebit = 0;
    let branchCredit = 0;
    for (const branch of allBranches) {
      const bs = await get(`/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=${branch.id}`, tokens.super);
      assert.equal(bs.status, 200, JSON.stringify(bs.json));
      branchAssets += Number(bs.json.totalAssets);
      branchLiabilities += Number(bs.json.totalLiabilities);
      branchEarnings += Number(bs.json.equity.currentEarnings);
      const tb = await get(`/api/accounting/statements/trial-balance?asOf=${TO}&branchId=${branch.id}`, tokens.super);
      assert.equal(tb.status, 200, JSON.stringify(tb.json));
      branchDebit += Number(tb.json.totals.periodDebit);
      branchCredit += Number(tb.json.totals.periodCredit);
    }
    assert.equal(company.json.totalAssets, branchAssets, 'ALL assets must equal the branch totals summed');
    assert.equal(company.json.totalLiabilities, branchLiabilities);
    assert.equal(company.json.equity.currentEarnings, branchEarnings);
    assert.equal(company.json.totalLiabilitiesAndEquity, branchAssets);
    assert.equal(company.json.difference, 0);
    assert.equal(company.json.balanced, true);

    const otherBranch = await get(
      `/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=${OTHER}`,
      tokens.super
    );
    assert.equal(otherBranch.status, 200, JSON.stringify(otherBranch.json));
    assert.equal(otherBranch.json.totalAssets, 50);
    assert.equal(otherBranch.json.totalLiabilities, 0);
    assert.equal(otherBranch.json.equity.currentEarnings, 50);
    assert.equal(otherBranch.json.balanced, true);

    const companyTrial = await get(
      `/api/accounting/statements/trial-balance?asOf=${TO}&branchId=ALL`,
      tokens.super
    );
    assert.equal(companyTrial.status, 200, JSON.stringify(companyTrial.json));
    assert.equal(companyTrial.json.totals.periodDebit, branchDebit);
    assert.equal(companyTrial.json.totals.periodCredit, branchCredit);
    assert.equal(companyTrial.json.totals.periodDebit, companyTrial.json.totals.periodCredit);
    assert.equal(companyTrial.json.balanced, true);
  });

  test('a control account difference is exposed, not hidden behind a zero', async () => {
    try {
      await pool!.query('UPDATE gl_subledger_entries SET debit = debit - 25 WHERE account_id = $1', [
        accounts.customerControl,
      ]);
      const res = await get(
        `/api/accounting/statements/trial-balance?asOf=${TO}&branchId=${BR}`,
        tokens.super
      );
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const control = controlOf(res.json.controls, 'AST-1100');
      assert.equal(control.glBalance, 1130);
      assert.equal(control.subledgerBalance, 1105);
      assert.equal(control.difference, 25);
      assert.equal(control.status, 'DIFFERENCE');
      assert.equal(res.json.controlsReconciled, false);
    } finally {
      await pool!.query('UPDATE gl_subledger_entries SET debit = debit + 25 WHERE account_id = $1', [
        accounts.customerControl,
      ]);
    }
  });

  test('profit and loss and balance sheet roll sub-group subtotals into their parent group', async () => {
    // A hierarchy on both sides of the ledger proves the tree is not a
    // trial-balance-only shape: each statement's group amount must include its
    // direct accounts plus every sub-group below it, and the statement totals
    // must still agree with the same posted lines.
    const assetParent = await createGroup('AST-HA', 'AST Hierarchy Assets', 'ASSET', 'CURRENT_ASSET');
    const assetChild = await post('/api/accounting/groups', tokens.super, {
      parentId: assetParent, code: 'AST-HA-SUB', name: 'AST Hierarchy Cash', sortOrder: 8,
    });
    assert.equal(assetChild.status, 201, JSON.stringify(assetChild.json));

    const expenseParent = await createGroup('AST-HX', 'AST Hierarchy Expenses', 'EXPENSE', 'OPERATING_EXPENSE');
    const expenseChild = await post('/api/accounting/groups', tokens.super, {
      parentId: expenseParent, code: 'AST-HX-SUB', name: 'AST Hierarchy Payroll', sortOrder: 8,
    });
    assert.equal(expenseChild.status, 201, JSON.stringify(expenseChild.json));

    const assetDirect = await createAccount({
      code: 'AST-HA-1', name: 'AST Hierarchy Equipment', groupId: assetParent,
    });
    const assetNested = await createAccount({
      code: 'AST-HA-2', name: 'AST Hierarchy Petty Cash', groupId: assetChild.json.id,
    });
    const expenseDirect = await createAccount({
      code: 'AST-HX-1', name: 'AST Hierarchy Rent', groupId: expenseParent,
    });
    const expenseNested = await createAccount({
      code: 'AST-HX-2', name: 'AST Hierarchy Wages', groupId: expenseChild.json.id,
    });

    await postJournal('2026-07-30', BR, 'ast-h1', 'AST hierarchy statement journal', [
      line(assetDirect, 400, 0),
      line(assetNested, 600, 0),
      line(expenseDirect, 100, 0),
      line(expenseNested, 200, 0),
      line(accounts.cash, 0, 1300),
    ]);

    const pnl = await get(
      '/api/accounting/statements/profit-and-loss?from=2026-07-30&to=2026-07-31&branchId=' + BR,
      tokens.super
    );
    assert.equal(pnl.status, 200, JSON.stringify(pnl.json));
    const expenses = sectionOf(pnl.json.sections, 'OPERATING_EXPENSE');
    const expenseBlock = expenses.groups.find((group: any) => group.groupCode === 'AST-HX');
    assert.ok(expenseBlock, 'the parent expense group must be a root of the section tree');
    assert.deepEqual(expenseBlock.accounts.map((account: any) => account.code), ['AST-HX-1']);
    assert.equal(expenseBlock.children.length, 1, 'the sub-group must nest under its parent');
    assert.equal(expenseBlock.children[0].groupCode, 'AST-HX-SUB');
    assert.equal(expenseBlock.children[0].amount, 200, 'the sub-group carries its own account subtotal');
    assert.equal(expenseBlock.amount, 300, 'the parent subtotal includes its direct account and its sub-group');
    assert.equal(pnl.json.operatingExpense, 300, 'the section total is the sum of the same leaves');
    assert.equal(pnl.json.netProfit, -300, 'the range contains only this hierarchy journal');

    const balance = await get(
      `/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(balance.status, 200, JSON.stringify(balance.json));
    const assets = sectionOf(balance.json.assets.sections, 'CURRENT_ASSET');
    const assetBlock = assets.groups.find((group: any) => group.groupCode === 'AST-HA');
    assert.ok(assetBlock, 'the parent asset group must be a root of the section tree');
    assert.deepEqual(assetBlock.accounts.map((account: any) => account.code), ['AST-HA-1']);
    assert.equal(assetBlock.children[0].amount, 600, 'the nested asset account is a sub-group subtotal');
    assert.equal(assetBlock.amount, 1000, 'the parent asset subtotal includes its sub-group');
    assert.equal(balance.json.equity.currentEarnings, 250, 'the earlier 550 less the 300 hierarchy expense');
    assert.equal(balance.json.difference, 0);
    assert.equal(balance.json.balanced, true);

    // The group's subtotal must be openable: the drill-down lists the POSTED
    // lines on its direct accounts AND its sub-group, and its total equals the
    // subtotal the statement displayed.
    const expenseLines = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseParent}` +
        `&from=2026-07-30&to=2026-07-31&branchId=${BR}`,
      tokens.super
    );
    assert.equal(expenseLines.status, 200, JSON.stringify(expenseLines.json));
    assert.equal(expenseLines.json.statement, 'PROFIT_AND_LOSS');
    assert.equal(expenseLines.json.branchId, BR);
    assert.equal(expenseLines.json.from, '2026-07-30');
    assert.equal(expenseLines.json.to, '2026-07-31');
    assert.equal(expenseLines.json.group.groupCode, 'AST-HX');
    assert.equal(expenseLines.json.group.amount, expenseBlock.amount, 'drill-down total = statement subtotal');
    assert.equal(expenseLines.json.totals.amount, expenseBlock.amount);
    assert.equal(expenseLines.json.totals.debit, 300);
    assert.equal(expenseLines.json.totals.credit, 0);
    assert.equal(expenseLines.json.totals.entryCount, 2);
    assert.deepEqual(
      expenseLines.json.entries.map((entry: any) => entry.accountCode),
      ['AST-HX-1', 'AST-HX-2'],
      'the parent drill-down must include its direct account and its sub-group lines'
    );
    assert.deepEqual(
      expenseLines.json.entries.map((entry: any) => entry.amount),
      [100, 200],
      'each line contributes its natural-side amount to the subtotal'
    );
    assert.equal(expenseLines.json.truncated, false);

    const childLines = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseChild.json.id}` +
        `&from=2026-07-30&to=2026-07-31&branchId=${BR}`,
      tokens.super
    );
    assert.equal(childLines.status, 200, JSON.stringify(childLines.json));
    assert.deepEqual(childLines.json.entries.map((entry: any) => entry.accountCode), ['AST-HX-2']);
    assert.equal(childLines.json.group.amount, 200);
    assert.equal(childLines.json.group.amount, expenseBlock.children[0].amount);

    const assetLines = await get(
      `/api/accounting/statements/group-lines?statement=BALANCE_SHEET&groupId=${assetParent}` +
        `&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(assetLines.status, 200, JSON.stringify(assetLines.json));
    assert.equal(assetLines.json.statement, 'BALANCE_SHEET');
    assert.equal(assetLines.json.from, null, 'a balance sheet drill-down is point-in-time');
    assert.equal(assetLines.json.to, TO);
    assert.equal(assetLines.json.group.amount, assetBlock.amount);
    assert.equal(assetLines.json.totals.amount, assetBlock.amount);
    assert.deepEqual(
      assetLines.json.entries.map((entry: any) => entry.accountCode),
      ['AST-HA-1', 'AST-HA-2']
    );

    // The trial-balance variant must walk the same subtree and keep opening and
    // period separate; the hierarchy journal falls entirely in the period.
    const trialAssetLines = await get(
      `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${assetParent}` +
        `&from=2026-07-30&to=${TO}&branchId=${BR}`,
      tokens.super
    );
    assert.equal(trialAssetLines.status, 200, JSON.stringify(trialAssetLines.json));
    assert.equal(trialAssetLines.json.statement, 'TRIAL_BALANCE');
    assert.deepEqual(
      trialAssetLines.json.entries.map((entry: any) => entry.accountCode),
      ['AST-HA-1', 'AST-HA-2'],
      'the trial-balance drill-down must include the sub-group lines'
    );
    assert.deepEqual(
      trialAssetLines.json.entries.map((entry: any) => entry.window),
      ['PERIOD', 'PERIOD']
    );
    assert.equal(trialAssetLines.json.totals.openingEntryCount, 0);
    assert.equal(trialAssetLines.json.totals.periodEntryCount, 2);
    assert.equal(trialAssetLines.json.totals.periodDebit, 1000);
    assert.equal(trialAssetLines.json.totals.closingDebit, 1000);
    assert.equal(trialAssetLines.json.group.periodDebit, 1000);
    assert.equal(trialAssetLines.json.truncated, false);

    const pagedTrialLines = await get(
      `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${assetParent}` +
        `&from=2026-07-30&to=${TO}&branchId=${BR}&limit=1`,
      tokens.super
    );
    assert.equal(pagedTrialLines.status, 200, JSON.stringify(pagedTrialLines.json));
    assert.equal(pagedTrialLines.json.entries.length, 1);
    assert.equal(pagedTrialLines.json.totals.periodEntryCount, 2);
    assert.equal(
      pagedTrialLines.json.totals.periodDebit,
      1000,
      'the per-window page limit must not shrink the subtotal'
    );
    assert.equal(pagedTrialLines.json.truncated, true);

    const otherBranch = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseParent}` +
        `&from=2026-07-30&to=2026-07-31&branchId=${OTHER}`,
      tokens.super
    );
    assert.equal(otherBranch.status, 200, JSON.stringify(otherBranch.json));
    assert.equal(otherBranch.json.totals.entryCount, 0, 'another branch must not see these lines');
    assert.equal(otherBranch.json.group.amount, 0);

    const outsideWindow = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseParent}` +
        `&from=2026-07-31&to=2026-07-31&branchId=${BR}`,
      tokens.super
    );
    assert.equal(outsideWindow.status, 200, JSON.stringify(outsideWindow.json));
    assert.equal(outsideWindow.json.totals.entryCount, 0);

    const firstPage = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseParent}` +
        `&from=2026-07-30&to=2026-07-31&branchId=${BR}&limit=1`,
      tokens.super
    );
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.json));
    assert.equal(firstPage.json.entries.length, 1);
    assert.equal(firstPage.json.totals.entryCount, 2);
    assert.equal(firstPage.json.totals.amount, 300, 'the page limit must not shrink the total');
    assert.equal(firstPage.json.truncated, true);

    // Later tests read the branch as of the same date; leave their fixture
    // exactly as this test found it. The empty groups are harmless and the
    // suite-level cleanup removes them with the other AST rows.
    await pool!.query("DELETE FROM gl_journals WHERE source_id = 'ast-h1'");
  });

  test('a group drill-down refuses the wrong statement side, unknown groups and foreign branches', async () => {
    const assetGroup = (await get('/api/accounting/groups', tokens.super)).json.find(
      (group: any) => group.code === 'AST-CA'
    );
    const expenseGroup = (await get('/api/accounting/groups', tokens.super)).json.find(
      (group: any) => group.code === 'AST-EX'
    );
    assert.ok(assetGroup && expenseGroup, 'the chart fixture must still exist');

    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${assetGroup.id}&asOf=${TO}`,
        tokens.super
      )).status,
      400,
      'an asset group is not part of the profit and loss statement'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=BALANCE_SHEET&groupId=${expenseGroup.id}&asOf=${TO}`,
        tokens.super
      )).status,
      400,
      'an expense group is not part of the balance sheet'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=not-a-group&asOf=${TO}`,
        tokens.super
      )).status,
      404
    );
    assert.equal(
      (await get(`/api/accounting/statements/group-lines?groupId=${expenseGroup.id}&asOf=${TO}`, tokens.super)).status,
      400,
      'the statement mode is required so the window cannot be guessed'
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=BALANCE_SHEET&groupId=${assetGroup.id}&asOf=${TO}&from=2026-07-01`,
        tokens.super
      )).status,
      400,
      'a balance sheet drill-down is point-in-time like its statement'
    );

    const own = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}`,
      tokens.accountant
    );
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch');
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}&branchId=${OTHER}`,
        tokens.accountant
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}&branchId=ALL`,
        tokens.accountant
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}`,
        tokens.noView
      )).status,
      403
    );
    assert.equal(
      (await get(
        `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}`
      )).status,
      401
    );

    const empty = await get(
      `/api/accounting/statements/group-lines?statement=PROFIT_AND_LOSS&groupId=${expenseGroup.id}&asOf=${TO}`,
      tokens.empty
    );
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.branchId, null);
    assert.deepEqual(empty.json.entries, []);
    assert.deepEqual(empty.json.totals, { debit: 0, credit: 0, amount: 0, entryCount: 0 });
  });

  test('a trial balance drill-down nets multiple opening lines per account before tying out', async () => {
    // One account with 100 Dr and 30 Cr before `from`, plus 20 Dr inside the
    // window. The trial balance reports an opening balance of 70, not gross
    // posted debits of 100, so the drill-down must net the opening lines the
    // same way or its tie-out would be wrong.
    const netGroup = await createGroup('AST-NET', 'AST Netting Assets', 'ASSET', 'CURRENT_ASSET');
    const netAccount = await createAccount({
      code: 'AST-NET-1',
      name: 'AST Netting Receivable',
      groupId: netGroup,
    });
    try {
      await postJournal('2026-07-18', BR, 'ast-net-1', 'AST netting opening debit', [
        line(netAccount, 100, 0),
        line(accounts.cash, 0, 100),
      ]);
      await postJournal('2026-07-19', BR, 'ast-net-2', 'AST netting opening credit', [
        line(accounts.cash, 30, 0),
        line(netAccount, 0, 30),
      ]);
      await postJournal('2026-07-25', BR, 'ast-net-3', 'AST netting period debit', [
        line(netAccount, 20, 0),
        line(accounts.cash, 0, 20),
      ]);

      const trial = await get(
        `/api/accounting/statements/trial-balance?from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.super
      );
      assert.equal(trial.status, 200, JSON.stringify(trial.json));
      const group = groupOf(trial.json.groups, 'AST-NET');
      assert.ok(group, 'the netting group must be in the trial balance tree');
      assert.deepEqual(
        {
          openingDebit: group.openingDebit,
          openingCredit: group.openingCredit,
          periodDebit: group.periodDebit,
          periodCredit: group.periodCredit,
          closingDebit: group.closingDebit,
          closingCredit: group.closingCredit,
        },
        {
          openingDebit: 70,
          openingCredit: 0,
          periodDebit: 20,
          periodCredit: 0,
          closingDebit: 90,
          closingCredit: 0,
        }
      );

      const lines = await get(
        `/api/accounting/statements/group-lines?statement=TRIAL_BALANCE&groupId=${netGroup}` +
          `&from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.super
      );
      assert.equal(lines.status, 200, JSON.stringify(lines.json));
      assert.deepEqual(
        lines.json.entries.map((entry: any) => [entry.window, entry.debit, entry.credit]),
        [
          ['OPENING', 100, 0],
          ['OPENING', 0, 30],
          ['PERIOD', 20, 0],
        ],
        'every posted line stays visible in its own window'
      );
      assert.deepEqual(
        {
          openingDebit: lines.json.totals.openingDebit,
          openingCredit: lines.json.totals.openingCredit,
          periodDebit: lines.json.totals.periodDebit,
          periodCredit: lines.json.totals.periodCredit,
          closingDebit: lines.json.totals.closingDebit,
          closingCredit: lines.json.totals.closingCredit,
        },
        {
          openingDebit: 70,
          openingCredit: 0,
          periodDebit: 20,
          periodCredit: 0,
          closingDebit: 90,
          closingCredit: 0,
        },
        'opening and closing must be net per account, not gross posted history'
      );
      assert.equal(lines.json.totals.openingEntryCount, 2);
      assert.equal(lines.json.totals.periodEntryCount, 1);
      assert.equal(lines.json.totals.entryCount, 3);

      // The account-level view keeps every gross line visible but runs the
      // balance on the net movement, including the credit that reduces it.
      const accountLines = await get(
        `/api/accounting/statements/account-lines?accountId=${netAccount}` +
          `&from=2026-07-24&to=${TO}&branchId=${BR}`,
        tokens.super
      );
      assert.equal(accountLines.status, 200, JSON.stringify(accountLines.json));
      assert.deepEqual(
        accountLines.json.entries.map((entry: any) => [
          entry.window, entry.debit, entry.credit, entry.runningBalance,
        ]),
        [
          ['OPENING', 100, 0, 100],
          ['OPENING', 0, 30, 70],
          ['PERIOD', 20, 0, 90],
        ],
        'a credit reduces the running balance before the period line'
      );
      assert.equal(accountLines.json.account.openingBalance, 70);
      assert.equal(accountLines.json.account.closingBalance, 90);
    } finally {
      await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'ast-net-%'");
      await pool!.query("DELETE FROM gl_accounts WHERE code = 'AST-NET-1'");
      await pool!.query("DELETE FROM gl_account_groups WHERE code = 'AST-NET'");
    }
  });

  test('branch scope, permissions and date validation are enforced on the statement routes', async () => {
    const own = await get(`/api/accounting/statements/profit-and-loss?asOf=${TO}`, tokens.accountant);
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.branchId, BR, 'a branch account defaults to its own branch');
    assert.equal(own.json.netProfit, 550);

    assert.equal(
      (await get(`/api/accounting/statements/balance-sheet?asOf=${TO}&branchId=${OTHER}`, tokens.accountant)).status,
      403
    );
    assert.equal(
      (await get(`/api/accounting/statements/trial-balance?asOf=${TO}&branchId=ALL`, tokens.accountant)).status,
      403
    );

    const empty = await get(`/api/accounting/statements/trial-balance?asOf=${TO}`, tokens.empty);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.branchId, null);
    assert.deepEqual(empty.json.totals, {
      openingDebit: 0, openingCredit: 0, periodDebit: 0, periodCredit: 0, closingDebit: 0, closingCredit: 0,
    });
    assert.deepEqual(empty.json.controls, []);
    assert.equal(empty.json.balanced, true);

    assert.equal((await get(`/api/accounting/statements/trial-balance?asOf=${TO}`, tokens.auditor)).status, 200);
    assert.equal((await get(`/api/accounting/statements/trial-balance?asOf=${TO}`, tokens.noView)).status, 403);
    assert.equal((await get(`/api/accounting/statements/trial-balance?asOf=${TO}`)).status, 401);

    assert.equal(
      (await get('/api/accounting/statements/trial-balance?asOf=2026-02-30', tokens.super)).status,
      400,
      'an impossible calendar date is refused'
    );
    assert.equal(
      (await get(`/api/accounting/statements/trial-balance?asOf=${TO}&to=2026-07-30`, tokens.super)).status,
      400,
      'asOf and to may not disagree'
    );
    assert.equal(
      (await get(`/api/accounting/statements/profit-and-loss?from=${TO}&to=2026-07-01`, tokens.super)).status,
      400,
      'a reversed range is refused'
    );
    assert.equal(
      (await get(`/api/accounting/statements/balance-sheet?asOf=${TO}&from=2026-07-01`, tokens.super)).status,
      400,
      'a balance sheet is a point-in-time statement'
    );
  });
});
