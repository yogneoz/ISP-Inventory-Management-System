/**
 * Accounting ledger service — validation and orchestration shared by the HTTP
 * routes and by future document postings.
 *
 * `postJournal` is deliberately transaction-agnostic: it only uses the client
 * it is handed, so an invoice/stock/payroll write can call it inside its own
 * BEGIN…COMMIT and have the document and its ledger entry commit together. The
 * HTTP controller wraps the manual-journal call in `withTransaction`.
 *
 * Rules enforced here, not in SQL alone:
 *   - every journal is balanced (Σ debit = Σ credit) and non-empty;
 *   - every line is exactly one-sided and uses an active account;
 *   - a control account line always names its subledger party, and an ordinary
 *     account can never carry one (otherwise reconciliation would be a sham);
 *   - a journal date resolves to a fiscal year and an OPEN monthly period;
 *   - account groups map to the statement group their type belongs to.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  ACCOUNT_TYPES,
  ACCOUNT_BY_CODE_SQL,
  ACCOUNT_BY_ID_SQL,
  ACCOUNT_BY_POSTING_ROLE_SQL,
  ACCOUNT_DELETE_SQL,
  ACCOUNT_GROUP_ACCOUNT_COUNT_SQL,
  ACCOUNT_GROUP_BY_CODE_SQL,
  ACCOUNT_GROUP_BY_ID_SQL,
  ACCOUNT_GROUP_CHILD_COUNT_SQL,
  ACCOUNT_GROUP_DELETE_SQL,
  ACCOUNT_GROUP_INSERT_SQL,
  ACCOUNT_GROUP_SET_PARENT_SQL,
  ACCOUNT_GROUP_UPDATE_SQL,
  ACCOUNT_INSERT_SQL,
  ACCOUNT_JOURNAL_LINE_COUNT_SQL,
  ACCOUNT_UPDATE_SQL,
  ACCOUNTS_BY_IDS_SQL,
  BRANCH_EXISTS_SQL,
  FISCAL_YEAR_BOUNDS_SQL,
  GL_CONTROL_BALANCE_SQL,
  JOURNAL_BY_ID_SQL,
  JOURNAL_INSERT_SQL,
  JOURNAL_LINES_SQL,
  JOURNAL_LINE_INSERT_SQL,
  JOURNAL_SUBLEDGER_SQL,
  NEXT_JOURNAL_SEQUENCE_SQL,
  PERIOD_BY_ID_SQL,
  PERIOD_BY_KEY_SQL,
  PERIOD_INSERT_IF_MISSING_SQL,
  PERIOD_INSERT_SQL,
  PERIOD_SET_STATUS_SQL,
  POSTING_ROLES,
  STATEMENT_GROUPS,
  SUBLEDGER_BALANCE_SQL,
  SUBLEDGER_INSERT_SQL,
  SUBLEDGER_PARTY_BALANCE_SQL,
  SUBLEDGER_TYPES,
  accountGroupInsertParams,
  accountInsertParams,
  journalInsertParams,
  journalLineInsertParams,
  subledgerInsertParams,
  type AccountType,
  type NormalBalance,
  type PostingRole,
  type StatementGroup,
  type SubledgerType,
} from '../models/accounting.repo';

/** The pg pool or a checked-out transaction client. */
export interface AccountingClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

const STATEMENT_GROUPS_BY_TYPE: Record<AccountType, readonly StatementGroup[]> = {
  ASSET: ['CURRENT_ASSET', 'NON_CURRENT_ASSET'],
  LIABILITY: ['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY'],
  EQUITY: ['EQUITY'],
  INCOME: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
};

const SUBLEDGER_TYPES_SET = new Set<string>(SUBLEDGER_TYPES);
const POSTING_ROLES_SET = new Set<string>(POSTING_ROLES);

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function accountCode(value: unknown): string {
  const code = text(value, 30).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(code)) {
    throw new ApiError(400, 'Account code must be 1–30 letters, digits, dots, dashes or underscores.');
  }
  return code;
}

/** A real AD calendar date in YYYY-MM-DD form. */
export function isAccountingDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function requireDate(value: unknown): string {
  const date = text(value, 10);
  if (!isAccountingDate(date)) throw new ApiError(400, 'A real journal date (YYYY-MM-DD) is required.');
  return date;
}

/** ISO period key (YYYY-MM) → its inclusive calendar-month bounds. */
export function periodBounds(periodKey: unknown): { periodKey: string; startDateAD: string; endDateAD: string } {
  const key = text(periodKey, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    throw new ApiError(400, 'Period must be a calendar month in YYYY-MM form.');
  }
  const [year, month] = key.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    periodKey: key,
    startDateAD: start.toISOString().slice(0, 10),
    endDateAD: end.toISOString().slice(0, 10),
  };
}

export function periodKeyForDate(date: string): string {
  return date.slice(0, 7);
}

async function fiscalYearForDate(client: AccountingClient, date: string): Promise<any> {
  const found = await client.query(FISCAL_YEAR_BOUNDS_SQL, [date]);
  const fiscalYear = found.rows[0];
  if (!fiscalYear) throw new ApiError(400, `No fiscal year contains ${date}. Create the fiscal year first.`);
  return fiscalYear;
}

/**
 * The monthly period for a date, created OPEN on first use. A period that was
 * explicitly closed stays closed: posting must fail, not reopen it by accident.
 */
async function ensureOpenPeriod(client: AccountingClient, date: string): Promise<any> {
  const fiscalYear = await fiscalYearForDate(client, date);
  const { periodKey, startDateAD, endDateAD } = periodBounds(periodKeyForDate(date));
  let period = (await client.query(PERIOD_BY_KEY_SQL, [fiscalYear.id, periodKey])).rows[0];
  if (!period) {
    // Two concurrent first-postings of the same month must both end up on the
    // one period row; the loser's ON CONFLICT no-op is followed by a re-read.
    const id = `glp-${crypto.randomUUID()}`;
    await client.query(PERIOD_INSERT_IF_MISSING_SQL, [id, fiscalYear.id, periodKey, startDateAD, endDateAD]);
    period = (await client.query(PERIOD_BY_KEY_SQL, [fiscalYear.id, periodKey])).rows[0];
  }
  if (period.status !== 'OPEN') {
    throw new ApiError(409, `Accounting period ${periodKey} is closed. Reopen it before posting.`);
  }
  return period;
}

/** Explicit period creation for the setup screen. */
export async function createPeriod(client: AccountingClient, input: { periodKey?: unknown; isDemo?: boolean }) {
  const { periodKey, startDateAD, endDateAD } = periodBounds(input.periodKey);
  const fiscalYear = await fiscalYearForDate(client, startDateAD);
  const existing = (await client.query(PERIOD_BY_KEY_SQL, [fiscalYear.id, periodKey])).rows[0];
  if (existing) throw new ApiError(409, `Accounting period ${periodKey} already exists.`);
  const id = `glp-${crypto.randomUUID()}`;
  await client.query(PERIOD_INSERT_SQL, [id, fiscalYear.id, periodKey, startDateAD, endDateAD]);
  return (await client.query(PERIOD_BY_ID_SQL, [id])).rows[0];
}

/** Close or reopen a period. Repeating the current state is a no-op. */
export async function setPeriodStatus(
  client: AccountingClient,
  periodId: string,
  status: 'OPEN' | 'CLOSED',
  actor: string | null
) {
  const period = (await client.query(PERIOD_BY_ID_SQL, [periodId])).rows[0];
  if (!period) throw new ApiError(404, 'Accounting period not found.');
  if (period.status === status) return period;
  await client.query(PERIOD_SET_STATUS_SQL, [periodId, status, actor]);
  return (await client.query(PERIOD_BY_ID_SQL, [periodId])).rows[0];
}

export async function createAccountGroup(
  client: AccountingClient,
  input: {
    parentId?: unknown;
    code?: unknown;
    name?: unknown;
    accountType?: unknown;
    statementGroup?: unknown;
    normalBalance?: unknown;
    sortOrder?: unknown;
    isDemo?: boolean;
  }
) {
  const code = accountCode(input.code);
  const name = text(input.name, 150);
  if (!name) throw new ApiError(400, 'Account group name is required.');

  const parentId = text(input.parentId, 50) || null;
  let parent: any = null;
  if (parentId) {
    parent = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [parentId])).rows[0];
    if (!parent) throw new ApiError(400, 'Parent account group not found.');
    if (parent.parentId) {
      throw new ApiError(400, 'A sub-group cannot itself have sub-groups. Choose a top-level group as the parent.');
    }
  }

  // A sub-group inherits its parent's accounting nature; letting a caller send
  // a conflicting type would make the same branch of the chart report in two
  // different statement sections.
  let accountType: AccountType;
  let statementGroup: StatementGroup;
  let normalBalance: NormalBalance;
  if (parent) {
    accountType = parent.accountType as AccountType;
    statementGroup = parent.statementGroup as StatementGroup;
    normalBalance = parent.normalBalance as NormalBalance;
  } else {
    accountType = text(input.accountType, 20).toUpperCase() as AccountType;
    if (!ACCOUNT_TYPES.includes(accountType)) {
      throw new ApiError(400, `Account type must be one of: ${ACCOUNT_TYPES.join(', ')}.`);
    }
    statementGroup = text(input.statementGroup, 30).toUpperCase() as StatementGroup;
    if (!STATEMENT_GROUPS.includes(statementGroup)) {
      throw new ApiError(400, `Statement group must be one of: ${STATEMENT_GROUPS.join(', ')}.`);
    }
    if (!STATEMENT_GROUPS_BY_TYPE[accountType].includes(statementGroup)) {
      throw new ApiError(
        400,
        `Statement group ${statementGroup} cannot belong to an ${accountType} group. Expected: ${STATEMENT_GROUPS_BY_TYPE[accountType].join(' or ')}.`
      );
    }
    const requestedBalance = text(input.normalBalance, 6).toUpperCase();
    normalBalance =
      requestedBalance === 'DEBIT' || requestedBalance === 'CREDIT'
        ? requestedBalance
        : accountType === 'ASSET' || accountType === 'EXPENSE'
          ? 'DEBIT'
          : 'CREDIT';
  }

  if ((await client.query(ACCOUNT_GROUP_BY_CODE_SQL, [code])).rows[0]) {
    throw new ApiError(409, `Account group code ${code} already exists.`);
  }
  const id = `glg-${crypto.randomUUID()}`;
  const sortOrder = Math.trunc(Number(input.sortOrder));
  await client.query(
    ACCOUNT_GROUP_INSERT_SQL,
    accountGroupInsertParams({
      id,
      parentId,
      code,
      name,
      accountType,
      statementGroup,
      normalBalance,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      isDemo: input.isDemo,
    })
  );
  return (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [id])).rows[0];
}

/**
 * Correct a group's label or display order. `code`, type and statement mapping
 * are deliberately not editable: they are the report structure every posted
 * account was classified under, so changing them would rewrite history.
 */
export async function updateAccountGroup(
  client: AccountingClient,
  groupId: string,
  input: { parentId?: unknown; name?: unknown; sortOrder?: unknown }
) {
  const existing = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [groupId])).rows[0];
  if (!existing) throw new ApiError(404, 'Account group not found.');
  if (['code', 'accountType', 'statementGroup', 'normalBalance'].some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    throw new ApiError(
      400,
      'A group code, type, normal balance and statement mapping cannot be changed once the group exists.'
    );
  }

  let newParent: any = null;
  if (Object.prototype.hasOwnProperty.call(input, 'parentId')) {
    const parentId = text(input.parentId, 50) || null;
    if (parentId !== (existing.parentId || null)) {
      if (parentId === groupId) throw new ApiError(400, 'A group cannot be its own parent.');
      if (parentId) {
        newParent = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [parentId])).rows[0];
        if (!newParent) throw new ApiError(400, 'Parent account group not found.');
        if (newParent.parentId) {
          throw new ApiError(400, 'A sub-group cannot itself have sub-groups. Choose a top-level group as the parent.');
        }
      }
      // Moving a group reclassifies every account under it in every past
      // statement, so only an empty branch of the chart may move.
      const used = Number((await client.query(ACCOUNT_GROUP_ACCOUNT_COUNT_SQL, [groupId])).rows[0]?.count) || 0;
      const children = Number((await client.query(ACCOUNT_GROUP_CHILD_COUNT_SQL, [groupId])).rows[0]?.count) || 0;
      if (used > 0 || children > 0) {
        throw new ApiError(
          409,
          `Account group ${existing.code} still has ${used} account${used === 1 ? '' : 's'} and ${children} sub-group${children === 1 ? '' : 's'}. Move an empty group only.`
        );
      }
      await client.query(ACCOUNT_GROUP_SET_PARENT_SQL, [
        groupId,
        parentId,
        newParent ? newParent.accountType : existing.accountType,
        newParent ? newParent.statementGroup : existing.statementGroup,
        newParent ? newParent.normalBalance : existing.normalBalance,
      ]);
    }
  }

  let name: string | null = null;
  if (Object.prototype.hasOwnProperty.call(input, 'name')) {
    name = text(input.name, 150);
    if (!name) throw new ApiError(400, 'Account group name cannot be empty.');
  }
  let sortOrder: number | null = null;
  if (Object.prototype.hasOwnProperty.call(input, 'sortOrder')) {
    const parsed = Math.trunc(Number(input.sortOrder));
    if (!Number.isFinite(parsed)) throw new ApiError(400, 'Sort order must be a whole number.');
    sortOrder = parsed;
  }

  await client.query(ACCOUNT_GROUP_UPDATE_SQL, [groupId, name, sortOrder]);
  return (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [groupId])).rows[0];
}

/** Delete an empty group; any account — active or not — blocks it. */
export async function deleteAccountGroup(client: AccountingClient, groupId: string) {
  const existing = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [groupId])).rows[0];
  if (!existing) throw new ApiError(404, 'Account group not found.');
  const used = Number((await client.query(ACCOUNT_GROUP_ACCOUNT_COUNT_SQL, [groupId])).rows[0]?.count) || 0;
  const children = Number((await client.query(ACCOUNT_GROUP_CHILD_COUNT_SQL, [groupId])).rows[0]?.count) || 0;
  if (used > 0 || children > 0) {
    const parts = [
      used > 0 ? `${used} account${used === 1 ? '' : 's'}` : '',
      children > 0 ? `${children} sub-group${children === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    throw new ApiError(
      409,
      `Account group ${existing.code} still has ${parts.join(' and ')}. Move or delete them first.`
    );
  }
  await client.query(ACCOUNT_GROUP_DELETE_SQL, [groupId]);
  return existing;
}

export async function createAccount(
  client: AccountingClient,
  input: {
    code?: unknown;
    name?: unknown;
    groupId?: unknown;
    description?: unknown;
    isControl?: unknown;
    subledgerType?: unknown;
    postingRole?: unknown;
    isDemo?: boolean;
  }
) {
  const code = accountCode(input.code);
  const name = text(input.name, 150);
  if (!name) throw new ApiError(400, 'Account name is required.');
  const groupId = text(input.groupId, 50);
  const group = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [groupId])).rows[0];
  if (!group) throw new ApiError(400, 'Account group not found.');

  const subledgerType = (text(input.subledgerType, 30).toUpperCase() || 'NONE') as SubledgerType;
  if (!SUBLEDGER_TYPES_SET.has(subledgerType)) {
    throw new ApiError(400, `Subledger type must be one of: ${SUBLEDGER_TYPES.join(', ')}.`);
  }
  // `isControl` is accepted for convenience, but the subledger type is the
  // authority: naming one means the account is a control account.
  const isControl = input.isControl === undefined ? subledgerType !== 'NONE' : Boolean(input.isControl);
  if (isControl !== (subledgerType !== 'NONE')) {
    throw new ApiError(400, 'A control account must name a subledger type, and an ordinary account must use NONE.');
  }

  const postingRoleRaw = text(input.postingRole, 40).toUpperCase();
  const postingRole = (postingRoleRaw || null) as PostingRole | null;
  if (postingRole && !POSTING_ROLES_SET.has(postingRole)) {
    throw new ApiError(400, `Posting role must be one of: ${POSTING_ROLES.join(', ')}.`);
  }
  if ((await client.query(ACCOUNT_BY_CODE_SQL, [code])).rows[0]) {
    throw new ApiError(409, `Account code ${code} already exists.`);
  }
  if (postingRole && (await client.query(ACCOUNT_BY_POSTING_ROLE_SQL, [postingRole])).rows[0]) {
    throw new ApiError(409, `Posting role ${postingRole} is already assigned to another account.`);
  }

  const id = `gla-${crypto.randomUUID()}`;
  await client.query(
    ACCOUNT_INSERT_SQL,
    accountInsertParams({
      id,
      code,
      name,
      groupId,
      description: text(input.description, 500) || null,
      isControl,
      subledgerType,
      postingRole,
      isDemo: input.isDemo,
    })
  );
  return (await client.query(ACCOUNT_BY_ID_SQL, [id])).rows[0];
}

/**
 * Edit an account's name, description, group, posting default or active flag.
 * The group may only move while the account has no posted lines, so a
 * reorganisation cannot silently reclassify a past statement.
 */
export async function updateAccount(
  client: AccountingClient,
  accountId: string,
  input: {
    name?: unknown;
    description?: unknown;
    groupId?: unknown;
    postingRole?: unknown;
    isActive?: unknown;
  }
) {
  const existing = (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!existing) throw new ApiError(404, 'Account not found.');
  if (['code', 'subledgerType', 'isControl'].some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    throw new ApiError(
      400,
      'An account code and its control/subledger nature cannot be changed. Create a new account instead.'
    );
  }

  let postingRole: PostingRole | null = existing.postingRole || null;
  if (Object.prototype.hasOwnProperty.call(input, 'postingRole')) {
    const raw = text(input.postingRole, 40).toUpperCase();
    if (raw && !POSTING_ROLES_SET.has(raw)) {
      throw new ApiError(400, `Posting role must be one of: ${POSTING_ROLES.join(', ')}.`);
    }
    postingRole = (raw || null) as PostingRole | null;
    if (postingRole) {
      const assigned = (await client.query(ACCOUNT_BY_POSTING_ROLE_SQL, [postingRole])).rows[0];
      if (assigned && assigned.id !== accountId) {
        throw new ApiError(409, `Posting role ${postingRole} is already assigned to another account.`);
      }
    }
  }
  if (input.isActive === false) postingRole = null;
  const name = Object.prototype.hasOwnProperty.call(input, 'name') ? text(input.name, 150) : undefined;
  if (name !== undefined && !name) throw new ApiError(400, 'Account name cannot be empty.');
  const description = Object.prototype.hasOwnProperty.call(input, 'description')
    ? text(input.description, 500) || null
    : undefined;
  const isActive =
    typeof input.isActive === 'boolean' ? input.isActive : undefined;

  let groupId: string | null = null;
  if (Object.prototype.hasOwnProperty.call(input, 'groupId')) {
    groupId = text(input.groupId, 50);
    const group = (await client.query(ACCOUNT_GROUP_BY_ID_SQL, [groupId])).rows[0];
    if (!group) throw new ApiError(400, 'Account group not found.');
    if (groupId !== existing.groupId) {
      const used = Number((await client.query(ACCOUNT_JOURNAL_LINE_COUNT_SQL, [accountId])).rows[0]?.count) || 0;
      if (used > 0) {
        throw new ApiError(
          409,
          `Account ${existing.code} already has posted entries, so its group cannot be changed. Create a new account for the new classification.`
        );
      }
    }
  }

  await client.query(ACCOUNT_UPDATE_SQL, [
    accountId,
    name === undefined ? null : name,
    description === undefined ? null : description,
    postingRole,
    isActive === undefined ? null : isActive,
    groupId,
  ]);
  return (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
}

/**
 * Delete an unused account. An account holding a posting role must have the
 * role cleared first (deactivating does that), and one with posted lines is
 * history, not configuration, so it can only be deactivated.
 */
export async function deleteAccount(client: AccountingClient, accountId: string) {
  const existing = (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!existing) throw new ApiError(404, 'Account not found.');
  if (existing.postingRole) {
    throw new ApiError(
      409,
      `Account ${existing.code} holds the ${existing.postingRole} posting role. Clear or reassign the role before deleting it.`
    );
  }
  const used = Number((await client.query(ACCOUNT_JOURNAL_LINE_COUNT_SQL, [accountId])).rows[0]?.count) || 0;
  if (used > 0) {
    throw new ApiError(
      409,
      `Account ${existing.code} has ${used} posted line${used === 1 ? '' : 's'} and cannot be deleted. Deactivate it instead.`
    );
  }
  await client.query(ACCOUNT_DELETE_SQL, [accountId]);
  return existing;
}

export interface JournalLineInput {
  accountId?: unknown;
  debit?: unknown;
  credit?: unknown;
  memo?: unknown;
  subledgerType?: unknown;
  partyId?: unknown;
  partyName?: unknown;
}

export interface PostJournalInput {
  journalDateAD?: unknown;
  branchId?: unknown;
  memo?: unknown;
  sourceType?: unknown;
  sourceId?: unknown;
  reversalOfId?: unknown;
  isDemo?: boolean;
  lines?: JournalLineInput[];
  actor?: string | null;
}

function amount(value: unknown, field: string): number {
  const parsed = roundMoney(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError(400, `${field} must be a non-negative amount.`);
  }
  if (parsed > 99_999_999_999.99) throw new ApiError(400, `${field} exceeds the ledger limit.`);
  return parsed;
}

/**
 * Post one balanced journal. Safe to call inside an existing transaction; it
 * never opens/commits one itself.
 */
export async function postJournal(
  client: AccountingClient,
  input: PostJournalInput
): Promise<{ id: string; journalNo: string; periodId: string; fiscalYearId: string }> {
  const journalDateAD = requireDate(input.journalDateAD);
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for every journal.');
  if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
    throw new ApiError(400, `Branch ${branchId} does not exist.`);
  }
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length < 2) throw new ApiError(400, 'A journal needs at least two lines.');
  // Payroll is the widest document: one gross line plus up to five deduction
  // lines per employee, with the run itself capped at 190 employees.
  if (rawLines.length > 1000) throw new ApiError(400, 'A journal can hold at most 1000 lines.');

  const accountIds = [...new Set(rawLines.map((line) => text(line?.accountId, 50)).filter(Boolean))];
  if (accountIds.length === 0) throw new ApiError(400, 'Every journal line needs an account.');
  const accounts = (await client.query(ACCOUNTS_BY_IDS_SQL, [accountIds])).rows;
  const accountsById = new Map<string, any>(accounts.map((account) => [account.id, account]));

  const lines = rawLines.map((raw, index) => {
    const lineNo = index + 1;
    const accountId = text(raw?.accountId, 50);
    const account = accountsById.get(accountId);
    if (!account) throw new ApiError(400, `Line ${lineNo}: account not found.`);
    if (!account.isActive) throw new ApiError(400, `Line ${lineNo}: account ${account.code} is inactive.`);
    const debit = amount(raw?.debit, `Line ${lineNo} debit`);
    const credit = amount(raw?.credit, `Line ${lineNo} credit`);
    if ((debit > 0) === (credit > 0)) {
      throw new ApiError(400, `Line ${lineNo} must have exactly one of debit or credit.`);
    }

    const rawSubledger = text(raw?.subledgerType, 30).toUpperCase();
    const partyId = text(raw?.partyId, 100) || null;
    const partyName = text(raw?.partyName, 200) || null;
    if (account.isControl) {
      const subledgerType = rawSubledger as SubledgerType;
      if (subledgerType !== account.subledgerType) {
        throw new ApiError(
          400,
          `Line ${lineNo}: control account ${account.code} requires a ${account.subledgerType} subledger entry.`
        );
      }
      if (!partyId && !partyName) {
        throw new ApiError(400, `Line ${lineNo}: a control-account line must name the subledger party.`);
      }
      return { lineNo, account, debit, credit, memo: text(raw?.memo, 300) || null, subledgerType, partyId, partyName };
    }
    if (rawSubledger && rawSubledger !== 'NONE') {
      throw new ApiError(400, `Line ${lineNo}: account ${account.code} is not a control account.`);
    }
    return { lineNo, account, debit, credit, memo: text(raw?.memo, 300) || null, subledgerType: 'NONE' as const, partyId: null, partyName: null };
  });

  const totalDebit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit <= 0) throw new ApiError(400, 'A journal must carry a positive amount.');
  if (Math.abs(totalDebit - totalCredit) >= 0.005) {
    throw new ApiError(
      400,
      `Journal is not balanced: debits ${totalDebit.toFixed(2)} ≠ credits ${totalCredit.toFixed(2)}.`
    );
  }

  const period = await ensureOpenPeriod(client, journalDateAD);
  const sequence = Number((await client.query(NEXT_JOURNAL_SEQUENCE_SQL)).rows[0]?.seq);
  if (!Number.isFinite(sequence) || sequence <= 0) {
    throw new ApiError(500, 'Could not allocate a journal number.');
  }
  const journalNo = `MJ-${period.fiscalYearCode}-${String(sequence).padStart(5, '0')}`;
  const journalId = `glj-${crypto.randomUUID()}`;
  const sourceType = (text(input.sourceType, 30).toUpperCase() || 'MANUAL');
  await client.query(
    JOURNAL_INSERT_SQL,
    journalInsertParams({
      id: journalId,
      journalNo,
      journalDateAD,
      fiscalYearId: period.fiscalYearId,
      periodId: period.id,
      branchId,
      sourceType,
      sourceId: text(input.sourceId, 100) || null,
      memo: text(input.memo, 1000) || null,
      reversalOfId: text(input.reversalOfId, 50) || null,
      postedBy: input.actor || null,
      isDemo: input.isDemo,
    })
  );

  for (const line of lines) {
    const lineId = `gll-${crypto.randomUUID()}`;
    await client.query(
      JOURNAL_LINE_INSERT_SQL,
      journalLineInsertParams({
        id: lineId,
        journalId,
        lineNo: line.lineNo,
        accountId: line.account.id,
        branchId,
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
      })
    );
    if (line.account.isControl) {
      await client.query(
        SUBLEDGER_INSERT_SQL,
        subledgerInsertParams({
          id: `gls-${crypto.randomUUID()}`,
          journalId,
          journalLineId: lineId,
          accountId: line.account.id,
          subledgerType: line.subledgerType as Exclude<SubledgerType, 'NONE'>,
          partyId: line.partyId,
          partyName: line.partyName,
          branchId,
          entryDateAD: journalDateAD,
          debit: line.debit,
          credit: line.credit,
        })
      );
    }
  }

  return { id: journalId, journalNo, periodId: period.id, fiscalYearId: period.fiscalYearId };
}

/** Header + lines + subledger rows for one posted journal. */
export async function readJournal(client: AccountingClient, journalId: string) {
  const header = (await client.query(JOURNAL_BY_ID_SQL, [journalId])).rows[0];
  if (!header) return null;
  const [lines, subledger] = await Promise.all([
    client.query(JOURNAL_LINES_SQL, [journalId]),
    client.query(JOURNAL_SUBLEDGER_SQL, [journalId]),
  ]);
  return {
    ...header,
    totalDebit: Number(header.totalDebit),
    totalCredit: Number(header.totalCredit),
    lines: lines.rows.map((line) => ({ ...line, debit: Number(line.debit), credit: Number(line.credit) })),
    subledgerEntries: subledger.rows.map((entry) => ({
      ...entry,
      debit: Number(entry.debit),
      credit: Number(entry.credit),
    })),
  };
}

/**
 * Compare a control account's GL balance with its subledger and explain any
 * difference by party. A non-control account is refused: it has no subledger,
 * so "reconciled" there would be meaningless.
 */
export async function reconcileControlAccount(
  client: AccountingClient,
  accountId: string,
  branchId?: string
) {
  const account = (await client.query(ACCOUNT_BY_ID_SQL, [accountId])).rows[0];
  if (!account) throw new ApiError(404, 'Account not found.');
  if (!account.isControl) {
    throw new ApiError(400, `Account ${account.code} is not a control account and has no subledger.`);
  }
  const [gl, subledger, parties] = await Promise.all([
    client.query(GL_CONTROL_BALANCE_SQL, [accountId, branchId || null]),
    client.query(SUBLEDGER_BALANCE_SQL, [accountId, branchId || null]),
    client.query(SUBLEDGER_PARTY_BALANCE_SQL, [accountId, branchId || null]),
  ]);
  const glBalance = roundMoney(Number(gl.rows[0]?.balance) || 0);
  const subledgerBalance = roundMoney(Number(subledger.rows[0]?.balance) || 0);
  const difference = roundMoney(glBalance - subledgerBalance);
  return {
    accountId,
    accountCode: account.code,
    accountName: account.name,
    subledgerType: account.subledgerType,
    branchId: branchId || 'ALL',
    glBalance,
    subledgerBalance,
    difference,
    status: Math.abs(difference) < 0.005 ? 'RECONCILED' : 'DIFFERENCE',
    lineCount: Number(gl.rows[0]?.lineCount) || 0,
    entryCount: Number(subledger.rows[0]?.entryCount) || 0,
    parties: parties.rows.map((row) => ({ ...row, balance: Number(row.balance) })),
  };
}

/** `pg` unique violations are 23505; the routes translate them consistently. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

/** A chart delete that loses a race to a posting or a new account. */
export function isForeignKeyViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23503');
}
