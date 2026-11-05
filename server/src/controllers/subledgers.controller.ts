/**
 * Subledger master — the book that sits behind one control ledger.
 *
 * A control account (AR, AP, salary payable, due to/from head office) doesn't
 * hold party detail itself: `gl_subledger_entries` does. This master names that
 * book, binds it to exactly one control account and records whether it is still
 * in use. The binding is what the chart screen shows as "Control account →
 * subledger", and what the setup-health panel counts when a control account is
 * still unassigned.
 *
 * Rules:
 *   - the main ledger must exist, be active and be a control account;
 *   - the book's type is the account's subledger type (the account is the
 *     authority — a CUSTOMER control cannot own a SUPPLIER book);
 *   - one book per control account (unique `main_account_id`);
 *   - moving a book to another control account is refused once it has posted
 *     rows, and deleting one with rows is refused outright — retire it instead.
 *
 * `GET /api/accounting/chart-health` and `POST /api/accounting/chart-defaults`
 * live here too: the health panel belongs to the same setup story, and the
 * repair is the idempotent seed the boot path already runs.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { logAuditEvent } from '../services/audit.service';
import { ensureDefaultChart, ensureDefaultSubledgers } from '../services/accountingSeed.service';
import { resolveBranchScope } from './accounting.controller';
import {
  ACCOUNT_BY_ID_SQL,
  ACCOUNT_LIST_SQL,
  POSTING_ROLES,
  CUSTOMER_PARTY_BY_ID_SQL,
  EMPLOYEE_PARTY_BY_ID_SQL,
  SUBLEDGER_BOOK_ENTRIES_SQL,
  SUBLEDGER_BOOK_PARTY_BALANCES_SQL,
  SUBLEDGER_BOOK_UNLINKED_COUNT_SQL,
  SUBLEDGER_BOOK_USAGE_COUNT_SQL,
  SUBLEDGER_BY_ACCOUNT_PARTY_SQL,
  SUBLEDGER_BY_CODE_SQL,
  SUBLEDGER_BY_ID_SQL,
  SUBLEDGER_CUSTOMER_CANDIDATES_SQL,
  SUBLEDGER_DELETE_SQL,
  SUBLEDGER_EMPLOYEE_CANDIDATES_SQL,
  SUBLEDGER_GENERAL_BY_ACCOUNT_SQL,
  SUBLEDGER_LIST_SQL,
  SUBLEDGER_MASTER_INSERT_SQL,
  SUBLEDGER_REASSIGN_PARTY_SQL,
  SUBLEDGER_SUPPLIER_CANDIDATES_SQL,
  SUBLEDGER_UPDATE_SQL,
  SUPPLIER_PARTY_BY_ID_SQL,
  type SubledgerType,
} from '../models/accounting.repo';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
/** Only these subledger types have a party master and can own party books. */
const PARTY_TYPES = new Set<SubledgerType>(['CUSTOMER', 'SUPPLIER', 'EMPLOYEE']);

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function subledgerCode(value: unknown): string {
  const code = text(value, 30).toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new ApiError(400, 'Subledger code is required: 1–30 letters, digits, hyphens or underscores.');
  }
  return code;
}

function newId(): string {
  return `gls-${crypto.randomUUID()}`;
}

function optionalPartyId(value: unknown): string | null {
  return text(value, 100) || null;
}

/** A book code derived from the party's own master code, unique within 30 chars. */
function partyBookCode(type: SubledgerType, source: string, attempt = 1): string {
  const prefix = type === 'CUSTOMER' ? 'CUS' : type === 'SUPPLIER' ? 'SUP' : 'EMP';
  const stem = String(source || 'PARTY')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 26);
  const base = `${prefix}-${stem || 'PARTY'}`.slice(0, 27);
  return attempt === 1 ? base : `${base}-${attempt}`.slice(0, 30);
}

/** The shared master row behind one party book, or null when it does not exist. */
async function readPartyMaster(type: SubledgerType, id: string): Promise<{ id: string; name: string } | null> {
  const sql =
    type === 'CUSTOMER'
      ? CUSTOMER_PARTY_BY_ID_SQL
      : type === 'SUPPLIER'
        ? SUPPLIER_PARTY_BY_ID_SQL
        : type === 'EMPLOYEE'
          ? EMPLOYEE_PARTY_BY_ID_SQL
          : null;
  if (!sql) return null;
  return ((await pgPool.query(sql, [id])).rows[0] as { id: string; name: string }) || null;
}

async function partyCandidates(
  type: SubledgerType,
  branchId: string | null
): Promise<Array<{ id: string; name: string; code: string }>> {
  if (type === 'SUPPLIER') {
    return (await pgPool.query(SUBLEDGER_SUPPLIER_CANDIDATES_SQL)).rows;
  }
  const sql = type === 'CUSTOMER' ? SUBLEDGER_CUSTOMER_CANDIDATES_SQL : SUBLEDGER_EMPLOYEE_CANDIDATES_SQL;
  return (await pgPool.query(sql, [branchId])).rows;
}

function activeFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() !== 'false' && String(value) !== '0';
}

function isoDateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError(400, 'Dates must use YYYY-MM-DD.');
  return raw;
}

type SubledgerAccount = {
  id: string;
  code: string;
  name: string;
  isControl: boolean;
  subledgerType: SubledgerType;
  isActive: boolean;
};

/** The control account a book may be bound to. */
async function readControlAccount(accountId: string): Promise<SubledgerAccount> {
  if (!accountId) throw new ApiError(400, 'Choose the control ledger this subledger belongs to.');
  const account = (await pgPool.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0] as
    | SubledgerAccount
    | undefined;
  if (!account) throw new ApiError(400, 'The selected control ledger was not found.');
  if (!account.isControl) {
    throw new ApiError(
      400,
      `Ledger ${account.code} ${account.name} is not a control account. Mark it as a control account with a subledger type first.`
    );
  }
  if (!account.isActive) {
    throw new ApiError(400, `Ledger ${account.code} ${account.name} is inactive and cannot own a subledger.`);
  }
  return account;
}

async function subledgerById(id: string) {
  const row = (await pgPool.query(SUBLEDGER_BY_ID_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'Subledger not found.');
  return row;
}

async function bookUsageCount(bookId: string): Promise<number> {
  return Number((await pgPool.query(SUBLEDGER_BOOK_USAGE_COUNT_SQL, [bookId])).rows[0]?.count) || 0;
}

/**
 * GET /api/accounting/subledgers?includeInactive=1&branchId=…
 * Books are master data; their rows, balances and unlinked counts follow the
 * same branch scope as every other ledger read.
 */
export async function get_subledgers(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const rows = (await pgPool.query(SUBLEDGER_LIST_SQL, [scope.branchId || null])).rows as any[];
  return res.json(includeInactive ? rows : rows.filter((row) => row.isActive));
}

/** POST /api/accounting/subledgers — bind a new book to a control account. */
export async function post_subledger(req: any, res: Response): Promise<any> {
  const body = req.body || {};
  const code = subledgerCode(body.code);
  const name = text(body.name, 150);
  if (!name) throw new ApiError(400, 'A subledger name is required.');

  const account = await readControlAccount(text(body.mainAccountId, 50));
  const declared = text(body.subledgerType, 30).toUpperCase();
  if (declared && declared !== account.subledgerType) {
    throw new ApiError(
      400,
      `Ledger ${account.code} carries the ${account.subledgerType} subledger; a ${declared} subledger cannot be assigned to it.`
    );
  }
  if ((await pgPool.query(SUBLEDGER_BY_CODE_SQL, [code])).rows[0]) {
    throw new ApiError(409, `Subledger code ${code} is already in use.`);
  }

  // A control account owns at most one general book, but any number of party
  // books: every employee under Salary Payable can have its own book, and the
  // party id is the same id the employee/customer/supplier master already uses.
  const party = optionalPartyId(body.partyId);
  if (party) {
    if (!PARTY_TYPES.has(account.subledgerType)) {
      throw new ApiError(
        400,
        `Ledger ${account.code} carries ${account.subledgerType} detail; only customer, supplier and employee books can be bound to one party.`
      );
    }
    const master = await readPartyMaster(account.subledgerType, party);
    if (!master) {
      throw new ApiError(
        400,
        `No active ${account.subledgerType} master record matches '${party}'. Use the id from the shared party master.`
      );
    }
    if ((await pgPool.query(SUBLEDGER_BY_ACCOUNT_PARTY_SQL, [account.id, party])).rows[0]) {
      throw new ApiError(
        409,
        `Ledger ${account.code} already has a subledger for ${master.name}. One book exists per party; use the existing book or rename it.`
      );
    }
  } else if ((await pgPool.query(SUBLEDGER_GENERAL_BY_ACCOUNT_SQL, [account.id])).rows[0]) {
    throw new ApiError(
      409,
      `Ledger ${account.code} ${account.name} already has a general subledger. Create a party book for one customer, supplier or employee, or use the existing general book.`
    );
  }

  const id = newId();
  await pgPool.query(SUBLEDGER_MASTER_INSERT_SQL, [
    id,
    code,
    name,
    account.subledgerType,
    account.id,
    party,
    text(body.description, 500) || null,
    activeFlag(body.isActive, true),
    false,
  ]);
  const saved = await subledgerById(id);
  await logAuditEvent(
    req,
    'CREATE_GL_SUBLEDGER',
    'ACCOUNTING',
    `Created ${account.subledgerType} subledger ${code} ${name} for ledger ${account.code} ${account.name}`
  );
  return res.status(201).json(saved);
}

/** PATCH /api/accounting/subledgers/:id — rename, retire or rebind an empty book. */
export async function patch_subledger(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A subledger id is required.');
  const existing = await subledgerById(id);
  const body = req.body || {};

  if (Object.prototype.hasOwnProperty.call(body, 'code')) {
    const requested = subledgerCode(body.code);
    if (requested !== existing.code) {
      throw new ApiError(400, 'A subledger code cannot be changed. Create a new subledger instead.');
    }
  }

  let mainAccountId = existing.mainAccountId as string;
  const requestedParty = Object.prototype.hasOwnProperty.call(body, 'partyId')
    ? optionalPartyId(body.partyId)
    : existing.partyId || null;
  if (requestedParty !== (existing.partyId || null)) {
    throw new ApiError(400, 'A subledger party cannot be changed. Create a new book for the other party instead.');
  }

  if (
    Object.prototype.hasOwnProperty.call(body, 'mainAccountId') &&
    String(body.mainAccountId || '') !== mainAccountId
  ) {
    const used = await bookUsageCount(id);
    if (used > 0) {
      throw new ApiError(
        409,
        `This subledger already has ${used} posted subledger row(s). Its main ledger cannot change; create a new subledger for the other control account.`
      );
    }
    const account = await readControlAccount(text(body.mainAccountId, 50));
    if (account.subledgerType !== existing.subledgerType) {
      throw new ApiError(
        400,
        `Ledger ${account.code} carries the ${account.subledgerType} subledger, but ${existing.code} is a ${existing.subledgerType} book.`
      );
    }
    const taken = existing.partyId
      ? (await pgPool.query(SUBLEDGER_BY_ACCOUNT_PARTY_SQL, [account.id, existing.partyId])).rows[0]
      : (await pgPool.query(SUBLEDGER_GENERAL_BY_ACCOUNT_SQL, [account.id])).rows[0];
    if (taken) {
      throw new ApiError(409, `Ledger ${account.code} ${account.name} already has that subledger.`);
    }
    mainAccountId = account.id;
  }

  const name = Object.prototype.hasOwnProperty.call(body, 'name')
    ? text(body.name, 150)
    : existing.name;
  if (!name) throw new ApiError(400, 'A subledger name is required.');
  const description = Object.prototype.hasOwnProperty.call(body, 'description')
    ? text(body.description, 500) || null
    : existing.description;
  const isActive = activeFlag(body.isActive, Boolean(existing.isActive));

  await pgPool.query(SUBLEDGER_UPDATE_SQL, [id, name, description, isActive, mainAccountId]);
  const saved = await subledgerById(id);
  await logAuditEvent(
    req,
    'UPDATE_GL_SUBLEDGER',
    'ACCOUNTING',
    `Updated subledger ${existing.code} ${name} (${isActive ? 'active' : 'inactive'})`
  );
  return res.json(saved);
}

/** DELETE /api/accounting/subledgers/:id — an unused book only. */
export async function delete_subledger(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A subledger id is required.');
  const existing = await subledgerById(id);
  const used = await bookUsageCount(id);
  if (used > 0) {
    throw new ApiError(
      409,
      `'${existing.name}' has ${used} posted subledger row(s). Retire it instead of deleting it.`
    );
  }
  await pgPool.query(SUBLEDGER_DELETE_SQL, [id]);
  await logAuditEvent(
    req,
    'DELETE_GL_SUBLEDGER',
    'ACCOUNTING',
    `Deleted subledger ${existing.code} ${existing.name}`
  );
  return res.json({ deleted: true, id });
}

/**
 * GET /api/accounting/subledgers/:id/entries — one book's posted movements,
 * read by `subledger_id` instead of by the main account. It carries the party
 * balances for the same window, the debit/credit totals and the number of rows
 * on the control account that still carry no book id (pre-linkage history).
 */
export async function get_subledgerEntries(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A subledger id is required.');
  const book = await subledgerById(id);
  const from = isoDateOrNull(req.query?.from);
  const to = isoDateOrNull(req.query?.to);
  if (from && to && from > to) {
    throw new ApiError(400, 'The from date must not be after the to date.');
  }
  const branchId = scope.branchId || null;
  const params = [id, from, to, branchId];
  const [entries, parties, unlinked] = await Promise.all([
    pgPool.query(SUBLEDGER_BOOK_ENTRIES_SQL, params),
    pgPool.query(SUBLEDGER_BOOK_PARTY_BALANCES_SQL, params),
    pgPool.query(SUBLEDGER_BOOK_UNLINKED_COUNT_SQL, [book.mainAccountId, branchId]),
  ]);
  const rows = entries.rows.map((entry: any) => ({
    ...entry,
    debit: Number(entry.debit),
    credit: Number(entry.credit),
  }));
  const partyRows = parties.rows.map((party: any) => ({ ...party, balance: Number(party.balance) }));
  const debit = rows.reduce((sum: number, row: any) => sum + row.debit, 0);
  const credit = rows.reduce((sum: number, row: any) => sum + row.credit, 0);
  return res.json({
    book: {
      id: book.id,
      code: book.code,
      name: book.name,
      subledgerType: book.subledgerType,
      mainAccountId: book.mainAccountId,
      partyId: book.partyId || null,
      accountCode: book.accountCode,
      accountName: book.accountName,
    },
    from,
    to,
    branchId,
    entries: rows,
    parties: partyRows,
    totals: { debit, credit, balance: debit - credit },
    unlinkedCount: Number(unlinked.rows[0]?.count) || 0,
  });
}

/**
 * POST /api/accounting/subledgers/generate — create one book for every active
 * party in the shared master that does not have one under this control account.
 *
 * This is the "unlimited subledgers" path: Salary Payable gets one book per
 * employee, AR one per customer and AP one per supplier, all using the same
 * ids the operational documents already carry. Existing rows that sit on the
 * general book (or predate book linkage) are moved to the new party book, so
 * the employee/customer ledger is complete immediately, not only from the next
 * posting onward.
 */
export async function post_generateSubledgers(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) {
    return res.status(403).json({ message: 'Forbidden: this account has no branch scope.' });
  }
  const account = await readControlAccount(text(req.body?.mainAccountId, 50));
  if (!PARTY_TYPES.has(account.subledgerType)) {
    throw new ApiError(
      400,
      `Ledger ${account.code} carries ${account.subledgerType} detail. Only customer, supplier and employee control accounts can generate party books.`
    );
  }

  const branchId = scope.branchId || null;
  const candidates = await partyCandidates(account.subledgerType, branchId);
  const generalBook =
    ((await pgPool.query(SUBLEDGER_GENERAL_BY_ACCOUNT_SQL, [account.id])).rows[0] as
      | { id: string }
      | undefined)?.id || null;
  let created = 0;
  let skipped = 0;
  let linkedEntries = 0;

  for (const candidate of candidates) {
    if ((await pgPool.query(SUBLEDGER_BY_ACCOUNT_PARTY_SQL, [account.id, candidate.id])).rows[0]) {
      skipped += 1;
      continue;
    }
    let code = partyBookCode(account.subledgerType, candidate.code || candidate.id);
    let attempt = 2;
    while ((await pgPool.query(SUBLEDGER_BY_CODE_SQL, [code])).rows[0]) {
      if (attempt > 100) {
        throw new ApiError(409, `Could not allocate a unique subledger code for ${candidate.name}.`);
      }
      code = partyBookCode(account.subledgerType, candidate.code || candidate.id, attempt);
      attempt += 1;
    }

    const bookId = newId();
    await pgPool.query(SUBLEDGER_MASTER_INSERT_SQL, [
      bookId,
      code,
      text(candidate.name, 150) || code,
      account.subledgerType,
      account.id,
      candidate.id,
      `Party book generated from the ${account.subledgerType} master.`,
      true,
      false,
    ]);
    const moved = await pgPool.query(SUBLEDGER_REASSIGN_PARTY_SQL, [
      account.id,
      candidate.id,
      bookId,
      generalBook,
    ]);
    linkedEntries += moved.rowCount || 0;
    created += 1;
  }

  await logAuditEvent(
    req,
    'GENERATE_GL_SUBLEDGERS',
    'ACCOUNTING',
    `Generated ${created} ${account.subledgerType} subledger book(s) under ${account.code} ${account.name}; linked ${linkedEntries} existing row(s)`.slice(0, 500)
  );
  return res.json({
    created,
    skipped,
    linkedEntries,
    total: candidates.length,
    accountCode: account.code,
    subledgerType: account.subledgerType,
  });
}

/**
 * GET /api/accounting/chart-health — what a chart still needs before it is a
 * complete posting environment. All three gaps refuse postings later, so the
 * chart screen shows them before an operator meets them as a document error.
 */
export async function get_chartHealth(_req: any, res: Response): Promise<any> {
  const accounts = (await pgPool.query(ACCOUNT_LIST_SQL)).rows as any[];
  const subledgers = (await pgPool.query(SUBLEDGER_LIST_SQL, [null])).rows as any[];
  // An inactive book cannot accept a posting, so it does not satisfy the
  // control account's setup requirement.
  const assigned = new Set(
    subledgers.filter((row) => row.isActive).map((row) => row.mainAccountId)
  );
  const activeRoles = new Set(
    accounts.filter((account) => account.isActive && account.postingRole).map((account) => account.postingRole)
  );
  const controlAccounts = accounts.filter((account) => account.isControl);
  return res.json({
    missingPostingRoles: POSTING_ROLES.filter((role) => !activeRoles.has(role)),
    controlAccountsWithoutSubledger: controlAccounts
      .filter((account) => !assigned.has(account.id))
      .map((account) => ({
        accountId: account.id,
        code: account.code,
        name: account.name,
        subledgerType: account.subledgerType,
        isActive: account.isActive,
      })),
    inactiveAccountsHoldingRole: accounts
      .filter((account) => !account.isActive && account.postingRole)
      .map((account) => ({ accountId: account.id, code: account.code, name: account.name, postingRole: account.postingRole })),
    totals: {
      accounts: accounts.length,
      controlAccounts: controlAccounts.length,
      subledgers: subledgers.length,
      activeSubledgers: subledgers.filter((row) => row.isActive).length,
    },
  });
}

/**
 * POST /api/accounting/chart-defaults — idempotently seed any missing default
 * group, account or subledger book. Existing rows are never updated, so this is
 * a repair for a chart that lost its defaults, not a reset.
 */
export async function post_chartDefaults(req: any, res: Response): Promise<any> {
  const chart = await ensureDefaultChart(pgPool as any);
  const subledgers = await ensureDefaultSubledgers(pgPool as any);
  await logAuditEvent(
    req,
    'SEED_GL_CHART_DEFAULTS',
    'ACCOUNTING',
    `Seeded missing chart defaults (${chart.groups} group(s), ${chart.accounts} account(s), ${subledgers} subledger(s))`
  );
  return res.json({
    added: { groups: chart.groups, accounts: chart.accounts, subledgers },
    message:
      chart.groups + chart.accounts + subledgers === 0
        ? 'Every default chart row already exists — nothing to add.'
        : 'Missing default chart rows were added.',
  });
}
