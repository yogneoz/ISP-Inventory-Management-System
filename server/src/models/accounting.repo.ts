/**
 * Accounting ledger repository — every SQL string and parameter builder for the
 * chart of accounts, monthly periods, journals, journal lines and subledger
 * entries. Controllers and services own validation/orchestration only, which is
 * what keeps `check:no-inline-sql` meaningful.
 *
 * The ledger is intentionally generic: operational documents will later call
 * `postJournal` with a source type/id, so the same tables serve invoices,
 * payroll, stock and manual entries. A control account's balance must equal the
 * sum of its subledger entries; the reconciliation builders at the bottom are
 * the two sides of that invariant.
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type StatementGroup =
  | 'CURRENT_ASSET'
  | 'NON_CURRENT_ASSET'
  | 'CURRENT_LIABILITY'
  | 'NON_CURRENT_LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'COST_OF_SALES'
  | 'OPERATING_EXPENSE'
  | 'OTHER_INCOME'
  | 'OTHER_EXPENSE';
export type SubledgerType =
  | 'NONE'
  | 'CUSTOMER'
  | 'SUPPLIER'
  | 'EMPLOYEE'
  | 'INVENTORY'
  | 'FIXED_ASSET'
  | 'BANK'
  | 'CASH'
  | 'TAX'
  | 'INTER_BRANCH';
export type PostingRole =
  | 'AR_CONTROL'
  | 'AP_CONTROL'
  | 'CASH'
  | 'BANK'
  | 'INVENTORY'
  | 'SALES'
  | 'COGS'
  | 'TAX_OUTPUT'
  | 'TAX_INPUT'
  | 'RETAINED_EARNINGS'
  | 'SALARY_PAYABLE'
  | 'INTER_BRANCH_CLEARING'
  | 'STOCK_EXPENSE'
  | 'CPE_ASSET'
  | 'DUE_FROM_HO'
  | 'DUE_TO_HO'
  | 'FIXED_ASSET'
  | 'ACCUMULATED_DEPRECIATION'
  | 'DEPRECIATION_EXPENSE'
  | 'GAIN_ON_DISPOSAL'
  | 'LOSS_ON_DISPOSAL'
  | 'SALARY_EXPENSE'
  | 'TDS_PAYABLE'
  | 'SSF_PAYABLE'
  | 'EMPLOYEE_ADVANCE'
  | 'EMPLOYEE_LOAN';

export type AccountKind = 'CASH' | 'BANK' | 'OTHER';

export const ACCOUNT_TYPES: readonly AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
export const ACCOUNT_KINDS: readonly AccountKind[] = ['CASH', 'BANK', 'OTHER'];
export const STATEMENT_GROUPS: readonly StatementGroup[] = [
  'CURRENT_ASSET',
  'NON_CURRENT_ASSET',
  'CURRENT_LIABILITY',
  'NON_CURRENT_LIABILITY',
  'EQUITY',
  'REVENUE',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
];
export const SUBLEDGER_TYPES: readonly SubledgerType[] = [
  'NONE',
  'CUSTOMER',
  'SUPPLIER',
  'EMPLOYEE',
  'INVENTORY',
  'FIXED_ASSET',
  'BANK',
  'CASH',
  'TAX',
  'INTER_BRANCH',
];
export const POSTING_ROLES: readonly PostingRole[] = [
  'AR_CONTROL',
  'AP_CONTROL',
  'CASH',
  'BANK',
  'INVENTORY',
  'SALES',
  'COGS',
  'TAX_OUTPUT',
  'TAX_INPUT',
  'RETAINED_EARNINGS',
  'SALARY_PAYABLE',
  'INTER_BRANCH_CLEARING',
  'STOCK_EXPENSE',
  'CPE_ASSET',
  'DUE_FROM_HO',
  'DUE_TO_HO',
  'FIXED_ASSET',
  'ACCUMULATED_DEPRECIATION',
  'DEPRECIATION_EXPENSE',
  'GAIN_ON_DISPOSAL',
  'LOSS_ON_DISPOSAL',
  'SALARY_EXPENSE',
  'TDS_PAYABLE',
  'SSF_PAYABLE',
  'EMPLOYEE_ADVANCE',
  'EMPLOYEE_LOAN',
];

export const ACCOUNT_GROUP_COLUMNS = `g.id,
  g.parent_id AS "parentId",
  g.code,
  g.name,
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup",
  g.normal_balance AS "normalBalance",
  g.sort_order AS "sortOrder",
  g.is_active AS "isActive",
  g.is_demo AS "isDemo"`;

export const ACCOUNT_COLUMNS = `a.id,
  a.code,
  a.name,
  a.group_id AS "groupId",
  a.description,
  a.master_profile AS "masterProfile",
  a.is_control AS "isControl",
  a.subledger_type AS "subledgerType",
  a.posting_role AS "postingRole",
  a.account_kind AS "accountKind",
  a.bank_name AS "bankName",
  a.bank_branch AS "bankBranch",
  a.account_number AS "accountNumber",
  a.account_holder AS "accountHolder",
  a.swift_code AS "swiftCode",
  a.is_active AS "isActive",
  a.is_demo AS "isDemo",
  g.code AS "groupCode",
  g.name AS "groupName",
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup",
  g.normal_balance AS "normalBalance"`;

export const PERIOD_COLUMNS = `p.id,
  p.fiscal_year_id AS "fiscalYearId",
  fy.code AS "fiscalYearCode",
  p.period_key AS "periodKey",
  p.start_date_ad AS "startDateAD",
  p.end_date_ad AS "endDateAD",
  p.status,
  p.closed_at AS "closedAt",
  p.closed_by AS "closedBy"`;

export const JOURNAL_COLUMNS = `j.id,
  j.journal_no AS "journalNo",
  j.journal_date_ad AS "journalDateAD",
  j.fiscal_year_id AS "fiscalYearId",
  fy.code AS "fiscalYearCode",
  j.period_id AS "periodId",
  p.period_key AS "periodKey",
  j.branch_id AS "branchId",
  b.name AS "branchName",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId",
  j.voucher_type AS "voucherType",
  j.voucher_class AS "voucherClass",
  j.reference_no AS "referenceNo",
  j.reference_date_ad AS "referenceDateAD",
  j.cheque_no AS "chequeNo",
  j.cheque_date_ad AS "chequeDateAD",
  j.currency,
  j.exchange_rate AS "exchangeRate",
  j.memo,
  j.status,
  j.reversal_of_id AS "reversalOfId",
  j.posted_at AS "postedAt",
  j.posted_by AS "postedBy",
  j.is_demo AS "isDemo"`;

export const JOURNAL_HEADER_SQL = `SELECT ${JOURNAL_COLUMNS},
  COALESCE(t.total_debit, 0)::numeric AS "totalDebit",
  COALESCE(t.total_credit, 0)::numeric AS "totalCredit",
  -- The contra that reversed this voucher (if any). The original keeps its
  -- POSTED status, so the list derives "reversed" from the linked contra.
  (SELECT r.id FROM gl_journals r
    WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
    ORDER BY r.posted_at ASC LIMIT 1) AS "reversalJournalId",
  (SELECT r.journal_no FROM gl_journals r
    WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
    ORDER BY r.posted_at ASC LIMIT 1) AS "reversalJournalNo",
  (SELECT o.journal_no FROM gl_journals o WHERE o.id = j.reversal_of_id) AS "reversalOfNo"
FROM gl_journals j
JOIN fiscal_years fy ON fy.id = j.fiscal_year_id
JOIN gl_periods p ON p.id = j.period_id
LEFT JOIN branches b ON b.id = j.branch_id
LEFT JOIN (
  SELECT journal_id, SUM(debit) AS total_debit, SUM(credit) AS total_credit
  FROM gl_journal_lines GROUP BY journal_id
) t ON t.journal_id = j.id`;

export const JOURNAL_BY_ID_SQL = `${JOURNAL_HEADER_SQL} WHERE j.id = $1`;

export const JOURNAL_LINES_SQL = `SELECT l.id,
  l.journal_id AS "journalId",
  l.line_no AS "lineNo",
  l.account_id AS "accountId",
  a.code AS "accountCode",
  a.name AS "accountName",
  a.is_control AS "isControl",
  a.subledger_type AS "subledgerType",
  l.cost_center_id AS "costCenterId",
  cc.code AS "costCenterCode",
  cc.name AS "costCenterName",
  l.branch_id AS "branchId",
  l.debit::numeric AS debit,
  l.credit::numeric AS credit,
  l.memo
FROM gl_journal_lines l
JOIN gl_accounts a ON a.id = l.account_id
LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id
WHERE l.journal_id = $1
ORDER BY l.line_no ASC`;

export const JOURNAL_SUBLEDGER_SQL = `SELECT s.id,
  s.journal_id AS "journalId",
  s.journal_line_id AS "journalLineId",
  s.account_id AS "accountId",
  s.subledger_id AS "subledgerId",
  s.subledger_type AS "subledgerType",
  s.party_id AS "partyId",
  s.party_name AS "partyName",
  s.branch_id AS "branchId",
  s.entry_date_ad AS "entryDateAD",
  s.debit::numeric AS debit,
  s.credit::numeric AS credit
FROM gl_subledger_entries s
WHERE s.journal_id = $1
ORDER BY s.entry_date_ad ASC, s.id ASC`;

/** Chart of accounts: groups first, then the accounts that use them. */
export const ACCOUNT_GROUP_LIST_SQL = `SELECT ${ACCOUNT_GROUP_COLUMNS}
FROM gl_account_groups g
LEFT JOIN gl_account_groups p ON p.id = g.parent_id
ORDER BY COALESCE(p.sort_order, g.sort_order) ASC,
  COALESCE(p.code, g.code) ASC,
  CASE WHEN g.parent_id IS NULL THEN 0 ELSE 1 END ASC,
  g.sort_order ASC,
  g.code ASC`;

export const ACCOUNT_GROUP_BY_ID_SQL = `SELECT ${ACCOUNT_GROUP_COLUMNS}
FROM gl_account_groups g WHERE g.id = $1`;

export const ACCOUNT_GROUP_BY_CODE_SQL = `SELECT g.id FROM gl_account_groups g WHERE g.code = $1`;

/** Chart maintenance: a group's label and display order can be corrected. */
export const ACCOUNT_GROUP_UPDATE_SQL = `UPDATE gl_account_groups SET
  name = COALESCE($2, name),
  sort_order = COALESCE($3, sort_order),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const ACCOUNT_GROUP_ACCOUNT_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_accounts WHERE group_id = $1`;

export const ACCOUNT_GROUP_CHILD_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_account_groups WHERE parent_id = $1`;

/**
 * Moving a group (including back to the top level) is a separate statement so
 * the label update can run without having to distinguish "unchanged" from an
 * explicit null parent. The caller supplies the mapping the group must carry
 * at its new level; the same values are passed when moving to the top level.
 */
export const ACCOUNT_GROUP_SET_PARENT_SQL = `UPDATE gl_account_groups SET
  parent_id = $2,
  account_type = $3,
  statement_group = $4,
  normal_balance = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const ACCOUNT_GROUP_DELETE_SQL = `DELETE FROM gl_account_groups WHERE id = $1`;

export const ACCOUNT_GROUP_INSERT_SQL = `INSERT INTO gl_account_groups (
  id, parent_id, code, name, account_type, statement_group, normal_balance, sort_order, is_active, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9)`;

/**
 * Idempotent default-chart seed. `ON CONFLICT DO NOTHING` (with no target)
 * also absorbs the partial unique index on `gl_accounts.posting_role`, so two
 * application instances booting at once cannot fail each other's seed.
 */
export const ACCOUNT_GROUP_SEED_INSERT_SQL = `INSERT INTO gl_account_groups (
  id, code, name, account_type, statement_group, normal_balance, sort_order, is_active, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE)
ON CONFLICT DO NOTHING`;

export const ACCOUNT_SEED_INSERT_SQL = `INSERT INTO gl_accounts (
  id, code, name, group_id, description, is_control, subledger_type,
  posting_role, account_kind, is_active, is_demo
)
SELECT $1, $2, $3, g.id, $4, $5, $6, $7,
  CASE WHEN $7::varchar = 'CASH' THEN 'CASH' WHEN $7::varchar = 'BANK' THEN 'BANK' ELSE 'OTHER' END,
  TRUE, FALSE
FROM gl_account_groups g
WHERE g.code = $8
ON CONFLICT DO NOTHING`;

export const ACCOUNT_LIST_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
ORDER BY g.sort_order ASC, a.code ASC`;

export const ACCOUNT_BY_ID_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.id = $1`;

export const ACCOUNT_BY_CODE_SQL = `SELECT a.id FROM gl_accounts a WHERE a.code = $1`;

export const ACCOUNT_BY_POSTING_ROLE_SQL = `SELECT a.id FROM gl_accounts a WHERE a.posting_role = $1`;

/** Any posted line makes an account part of the ledger's history. */
export const ACCOUNT_JOURNAL_LINE_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_journal_lines WHERE account_id = $1`;

export const ACCOUNT_DELETE_SQL = `DELETE FROM gl_accounts WHERE id = $1`;

/** Every active account holding one of the requested posting roles. */
export const ACCOUNTS_BY_POSTING_ROLES_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.posting_role = ANY($1::varchar[]) AND a.is_active = TRUE`;

/**
 * The active custody accounts an inter-branch movement posts against. The
 * service picks the asset/liability side from the account group's type, so a
 * chart with more than one INTER_BRANCH account still resolves predictably.
 */
export const INTER_BRANCH_ACCOUNTS_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.is_active = TRUE AND a.subledger_type = 'INTER_BRANCH'
ORDER BY a.code ASC`;

/** The one journal a document created (newest first if an old duplicate exists). */
export const JOURNAL_FIND_BY_SOURCE_SQL = `${JOURNAL_HEADER_SQL}
WHERE j.source_type = $1 AND j.source_id = $2
ORDER BY j.posted_at DESC
LIMIT 1`;

/**
 * Net amount (debit − credit) a source document posted to one or more accounts.
 * The fixed-asset postings use it to read the value actually sitting in the
 * ledger for one asset, instead of trusting the register's cached columns.
 */
export const JOURNAL_SOURCE_ACCOUNT_NET_SQL = `SELECT
  COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.account_id = ANY($2::varchar[])), 0)::numeric AS net
FROM gl_journals j
JOIN gl_journal_lines l ON l.journal_id = j.id
WHERE j.status = 'POSTED' AND j.source_id = $1`;

/**
 * Depreciation already posted for one asset across every period. Each run's
 * source id is `<assetId>:<periodKey>`; a prefix comparison (not LIKE) keeps a
 * client-supplied asset id containing % or _ from matching another asset.
 */
export const ASSET_DEPRECIATION_POSTED_SQL = `SELECT
  COALESCE(SUM(l.credit - l.debit), 0)::numeric AS posted
FROM gl_journals j
JOIN gl_journal_lines l ON l.journal_id = j.id
WHERE j.status = 'POSTED'
  AND j.source_type = 'FIXED_ASSET_DEPRECIATION'
  AND left(j.source_id, char_length($1)) = $1
  AND l.account_id = $2`;

/** Serializes one branch's depreciation run for a period across processes. */
export const DEPRECIATION_RUN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))::text AS lock`;

export const JOURNAL_MARK_REVERSED_SQL = `UPDATE gl_journals SET
  status = 'REVERSED', updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'POSTED'`;

/**
 * The original voucher being reversed. `FOR UPDATE` serializes two concurrent
 * reversal requests on the same journal, so a double-click cannot post two
 * contras before either sees the other.
 */
export const JOURNAL_LOCK_BY_ID_SQL = `SELECT j.id,
  j.journal_no AS "journalNo",
  j.journal_date_ad AS "journalDateAD",
  j.branch_id AS "branchId",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId",
  j.voucher_type AS "voucherType",
  j.voucher_class AS "voucherClass",
  j.reference_no AS "referenceNo",
  j.reference_date_ad AS "referenceDateAD",
  j.cheque_no AS "chequeNo",
  j.cheque_date_ad AS "chequeDateAD",
  j.currency,
  j.exchange_rate AS "exchangeRate",
  j.memo,
  j.status,
  j.reversal_of_id AS "reversalOfId",
  j.is_demo AS "isDemo"
FROM gl_journals j
WHERE j.id = $1
FOR UPDATE`;

/** The contra already posted for an original voucher, if one exists. */
export const JOURNAL_REVERSAL_EXISTS_SQL = `SELECT id, journal_no AS "journalNo"
FROM gl_journals
WHERE reversal_of_id = $1
ORDER BY posted_at ASC
LIMIT 1`;

export const ACCOUNT_INSERT_SQL = `INSERT INTO gl_accounts (
  id, code, name, group_id, description, is_control, subledger_type,
  posting_role, account_kind, bank_name, bank_branch, account_number,
  account_holder, swift_code, master_profile, is_active, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, TRUE, $16)`;

export const ACCOUNT_UPDATE_SQL = `UPDATE gl_accounts SET
  name = COALESCE($2, name),
  description = COALESCE($3, description),
  posting_role = $4,
  is_active = COALESCE($5, is_active),
  group_id = COALESCE($6, group_id),
  account_kind = COALESCE($7, account_kind),
  bank_name = $8,
  bank_branch = $9,
  account_number = $10,
  account_holder = $11,
  swift_code = $12,
  master_profile = COALESCE($13::jsonb, master_profile),
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

/** Active ledgers a payment document may settle through, default first. */
export const SETTLEMENT_ACCOUNTS_SQL = `SELECT a.id,
  a.code,
  a.name,
  a.account_kind AS "accountKind",
  a.posting_role AS "postingRole",
  a.bank_name AS "bankName",
  a.bank_branch AS "bankBranch",
  a.account_number AS "accountNumber",
  a.account_holder AS "accountHolder",
  a.swift_code AS "swiftCode"
FROM gl_accounts a
WHERE a.is_active = TRUE AND a.account_kind IN ('CASH', 'BANK')
ORDER BY CASE WHEN a.posting_role IN ('CASH', 'BANK') THEN 0 ELSE 1 END,
  a.account_kind ASC, a.code ASC`;

/** `$1` is a text[] of ids; callers pass an empty array safely (no rows). */
export const ACCOUNTS_BY_IDS_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.id = ANY($1::varchar[])`;

export const PERIOD_BY_ID_SQL = `SELECT ${PERIOD_COLUMNS}
FROM gl_periods p JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE p.id = $1`;

export const PERIOD_BY_KEY_SQL = `SELECT ${PERIOD_COLUMNS}
FROM gl_periods p JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE p.fiscal_year_id = $1 AND p.period_key = $2`;

export const PERIOD_LIST_SQL = `SELECT ${PERIOD_COLUMNS}
FROM gl_periods p JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE ($1::varchar IS NULL OR p.fiscal_year_id = $1)
ORDER BY p.start_date_ad DESC`;

export const PERIOD_INSERT_SQL = `INSERT INTO gl_periods (
  id, fiscal_year_id, period_key, start_date_ad, end_date_ad, status
) VALUES ($1, $2, $3, $4, $5, 'OPEN')`;

/** Lazily created period for a posting: a concurrent writer may win the key. */
export const PERIOD_INSERT_IF_MISSING_SQL = `INSERT INTO gl_periods (
  id, fiscal_year_id, period_key, start_date_ad, end_date_ad, status
) VALUES ($1, $2, $3, $4, $5, 'OPEN')
ON CONFLICT (fiscal_year_id, period_key) DO NOTHING`;

export const PERIOD_SET_STATUS_SQL = `UPDATE gl_periods SET
  status = $2::varchar,
  closed_at = CASE WHEN $2::varchar = 'CLOSED' THEN CURRENT_TIMESTAMP ELSE NULL END,
  closed_by = CASE WHEN $2::varchar = 'CLOSED' THEN $3::varchar ELSE NULL END,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

/**
 * The earliest period an opening-balance journal may use: the first OPEN
 * monthly period in an OPEN fiscal year. Ordered by the real date, not the
 * period key, so a fiscal year starting in a non-calendar month is handled.
 */
export const EARLIEST_OPEN_PERIOD_SQL = `SELECT ${PERIOD_COLUMNS}
FROM gl_periods p JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
WHERE p.status = 'OPEN' AND fy.is_closed = FALSE
ORDER BY p.start_date_ad ASC, p.period_key ASC
LIMIT 1`;

/**
 * Fallback when no period exists yet: the first open fiscal year's start. The
 * journal posting service lazily creates that month's period from this date.
 */
export const EARLIEST_OPEN_FISCAL_YEAR_SQL = `SELECT id, code,
  start_date_ad::text AS "startDateAD"
FROM fiscal_years
WHERE is_closed = FALSE
ORDER BY start_date_ad ASC
LIMIT 1`;

/** Serializes the one-opening-per-branch check across processes. */
export const OPENING_BALANCE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))::text AS lock`;

/** The durable proof that this branch's opening balances are already posted. */
export const OPENING_BALANCE_EXISTS_SQL = `SELECT id FROM gl_journals
WHERE source_type = 'OPENING_BALANCE' AND branch_id = $1
LIMIT 1`;

/** Locks the fiscal-year row while its closing journals are built and posted. */
export const FISCAL_YEAR_CLOSE_LOCK_SQL = `SELECT id, code,
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD",
  is_closed AS "isClosed"
FROM fiscal_years
WHERE id = $1
FOR UPDATE`;

/** Serializes a year-end close even if two requests race past the row lock. */
export const YEAR_END_CLOSE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))::text AS lock`;

/** One close posting per fiscal year, independent of the is_closed flag. */
export const YEAR_END_CLOSE_EXISTS_SQL = `SELECT id FROM gl_journals
WHERE fiscal_year_id = $1 AND source_type = 'YEAR_END_CLOSE'
LIMIT 1`;

/**
 * Income and expense balances through a fiscal-year end, grouped by branch and
 * account. The cumulative balance is deliberate: a close zeroes whatever P&L
 * residue exists in the ledger at that date, including an earlier year that
 * was never closed, so current earnings cannot remain stranded after a close.
 */
export const FISCAL_YEAR_PNL_BALANCE_ROWS_SQL = `SELECT
  l.branch_id AS "branchId",
  a.id AS "accountId",
  a.code,
  a.name,
  a.is_active AS "isActive",
  a.is_control AS "isControl",
  g.account_type AS "accountType",
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS "signedBalance"
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
JOIN gl_accounts a ON a.id = l.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE j.status = 'POSTED'
  AND j.journal_date_ad <= $1::date
  AND g.account_type IN ('INCOME', 'EXPENSE')
GROUP BY l.branch_id, a.id, a.code, a.name, a.is_active, a.is_control, g.account_type
HAVING COALESCE(SUM(l.debit - l.credit), 0) <> 0
ORDER BY l.branch_id ASC, a.code ASC`;

export const BRANCH_EXISTS_SQL = `SELECT id FROM branches WHERE id = $1`;

/** Next value of the durable journal-number sequence. */
export const NEXT_JOURNAL_SEQUENCE_SQL = `SELECT nextval('gl_journal_no_seq')::bigint AS seq`;

export const JOURNAL_INSERT_SQL = `INSERT INTO gl_journals (
  id, journal_no, journal_date_ad, fiscal_year_id, period_id, branch_id,
  source_type, source_id, voucher_type, voucher_class, reference_no,
  reference_date_ad, cheque_no, cheque_date_ad, currency, exchange_rate,
  memo, status, reversal_of_id, posted_by, is_demo
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
  $17, 'POSTED', $18, $19, $20
)`;

export const JOURNAL_LINE_INSERT_SQL = `INSERT INTO gl_journal_lines (
  id, journal_id, line_no, account_id, cost_center_id, branch_id, debit, credit, memo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export const SUBLEDGER_INSERT_SQL = `INSERT INTO gl_subledger_entries (
  id, journal_id, journal_line_id, account_id, subledger_id, subledger_type,
  party_id, party_name, branch_id, entry_date_ad, debit, credit
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

export interface JournalListOptions {
  branchId?: string;
  periodId?: string;
  status?: string;
  from?: string;
  to?: string;
  query?: string;
  page?: number;
  pageSize?: number;
}

/** Shared WHERE for the page and its count, so a footer can never disagree. */
function buildJournalWhere(opts: JournalListOptions): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  if (opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conds.push(`j.branch_id = $${params.length}`);
  }
  if (opts.periodId) {
    params.push(opts.periodId);
    conds.push(`j.period_id = $${params.length}`);
  }
  const status = typeof opts.status === 'string' ? opts.status.trim().toUpperCase() : '';
  if (status === 'POSTED' || status === 'REVERSED') {
    params.push(status);
    conds.push(`j.status = $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    conds.push(`j.journal_date_ad >= $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    conds.push(`j.journal_date_ad <= $${params.length}`);
  }
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    conds.push(
      `lower(COALESCE(j.journal_no, '') || ' ' || COALESCE(j.memo, '') || ' ' || COALESCE(j.source_id, '')) LIKE $${params.length}`
    );
  }
  return { whereSql: conds.length ? ` WHERE ${conds.join(' AND ')}` : '', params };
}

export function buildJournalPageQuery(opts: JournalListOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildJournalWhere(opts);
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.pageSize)) || 25));
  const page = Math.max(1, Math.trunc(Number(opts.page)) || 1);
  return {
    sql: `${JOURNAL_HEADER_SQL}${whereSql}
      ORDER BY j.journal_date_ad DESC, j.journal_no DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  };
}

export function buildJournalCountQuery(opts: JournalListOptions): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildJournalWhere(opts);
  return {
    sql: `SELECT COUNT(*)::int AS count FROM gl_journals j${whereSql}`,
    params,
  };
}

/**
 * GL side of a control-account reconciliation. Only POSTED journal lines count;
 * a reversed journal keeps its rows but stops contributing (status REVERSED).
 */
export const GL_CONTROL_BALANCE_SQL = `SELECT
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance,
  COUNT(*)::int AS "lineCount"
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND ($2::varchar IS NULL OR l.branch_id = $2)`;

/** Subledger side of the same reconciliation. */
export const SUBLEDGER_BALANCE_SQL = `SELECT
  COALESCE(SUM(s.debit - s.credit), 0)::numeric AS balance,
  COUNT(*)::int AS "entryCount"
FROM gl_subledger_entries s
WHERE s.account_id = $1
  AND ($2::varchar IS NULL OR s.branch_id = $2)`;

/** Per-party breakdown the reconciliation screen/API can explain a gap with. */
export const SUBLEDGER_PARTY_BALANCE_SQL = `SELECT
  s.subledger_type AS "subledgerType",
  s.party_id AS "partyId",
  COALESCE(s.party_name, '') AS "partyName",
  COALESCE(SUM(s.debit - s.credit), 0)::numeric AS balance
FROM gl_subledger_entries s
WHERE s.account_id = $1
  AND ($2::varchar IS NULL OR s.branch_id = $2)
GROUP BY s.subledger_type, s.party_id, s.party_name
ORDER BY s.party_id ASC NULLS LAST`;

/**
 * AR / AP aging account: the chart's active AR_CONTROL or AP_CONTROL default.
 * The caller names the report side; the chart owns which account that is.
 */
export const AGING_CONTROL_ACCOUNT_SQL = `SELECT ${ACCOUNT_COLUMNS}
FROM gl_accounts a JOIN gl_account_groups g ON g.id = a.group_id
WHERE a.posting_role = $1
LIMIT 1`;

/**
 * GL side of the aging tie-out through `$2` (one branch, or every branch when
 * `$3` is NULL). Debit-positive, exactly like the control agreement.
 */
export const AGING_CONTROL_GL_BALANCE_SQL = `SELECT
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad <= $2::date
  AND ($3::varchar IS NULL OR l.branch_id = $3::varchar)`;

/**
 * Every posted subledger entry on the aging control account through `$2`.
 * A journal sourced from an invoice is joined back to that invoice so the
 * report can use its document number and due date; payments and other credits
 * simply carry no document and are allocated FIFO by the service.
 */
export const AGING_SUBLEDGER_ROWS_SQL = `SELECT
  s.party_id AS "partyId",
  COALESCE(NULLIF(TRIM(s.party_name), ''), s.party_id, 'UNASSIGNED') AS "partyName",
  s.branch_id AS "branchId",
  s.entry_date_ad::text AS "entryDateAD",
  s.debit,
  s.credit,
  j.journal_no AS "journalNo",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId",
  j.memo,
  COALESCE(si.invoice_number, pi.invoice_number) AS "documentNo",
  COALESCE(si.invoice_date_ad, pi.invoice_date_ad, j.journal_date_ad)::text AS "documentDateAD",
  CASE WHEN si.id IS NOT NULL THEN si.due_date_ad::text
       WHEN pi.id IS NOT NULL THEN pi.due_date_ad::text
       ELSE NULL END AS "storedDueDateAD"
FROM gl_subledger_entries s
JOIN gl_journals j ON j.id = s.journal_id
LEFT JOIN sales_invoices si
  ON j.source_type LIKE 'SALES_INVOICE%' AND si.id = j.source_id
LEFT JOIN purchase_invoices pi
  ON j.source_type LIKE 'PURCHASE_INVOICE%' AND pi.id = j.source_id
WHERE s.account_id = $1
  AND j.status = 'POSTED'
  AND s.entry_date_ad <= $2::date
  AND ($3::varchar IS NULL OR s.branch_id = $3::varchar)
ORDER BY s.party_id ASC NULLS LAST, s.entry_date_ad ASC, j.journal_no ASC, s.id ASC`;

/**
 * Statement read side: one row per account with its signed opening balance
 * (before `$1`), period turnover (`$1`..`$2`) and account/statement mapping.
 *
 * The signed balance convention is debit-positive (`debit - credit`); the
 * service turns it into a natural-positive presentation amount per account
 * type. `$1 = NULL` means "no opening window" and makes the period run from
 * inception to `$2`, which is the balance-sheet shape. Only POSTED journals
 * count, matching the reconciliation builders above. The branch filter is on
 * the LINE (where the branch dimension lives), so a journal can never be
 * split across branches by this query.
 */
export const ACCOUNT_BALANCE_ROWS_SQL = `WITH scoped_lines AS (
  SELECT l.account_id, l.debit, l.credit, j.journal_date_ad
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad <= $2::date
    AND ($3::varchar IS NULL OR l.branch_id = $3::varchar)
), balances AS (
  SELECT account_id,
    COALESCE(SUM(CASE WHEN $1::date IS NOT NULL AND journal_date_ad < $1::date
      THEN debit - credit ELSE 0 END), 0) AS opening_balance,
    COALESCE(SUM(CASE WHEN ($1::date IS NULL OR journal_date_ad >= $1::date)
      AND journal_date_ad <= $2::date THEN debit ELSE 0 END), 0) AS period_debit,
    COALESCE(SUM(CASE WHEN ($1::date IS NULL OR journal_date_ad >= $1::date)
      AND journal_date_ad <= $2::date THEN credit ELSE 0 END), 0) AS period_credit
  FROM scoped_lines
  GROUP BY account_id
)
SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.is_active AS "isActive",
  a.subledger_type AS "subledgerType",
  a.posting_role AS "postingRole",
  a.account_kind AS "accountKind",
  g.id AS "groupId",
  g.parent_id AS "parentGroupId",
  g.code AS "groupCode",
  g.name AS "groupName",
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup",
  g.normal_balance AS "normalBalance",
  g.sort_order AS "groupSortOrder",
  COALESCE(b.opening_balance, 0)::numeric AS "openingBalance",
  COALESCE(b.period_debit, 0)::numeric AS "periodDebit",
  COALESCE(b.period_credit, 0)::numeric AS "periodCredit"
FROM gl_accounts a
JOIN gl_account_groups g ON g.id = a.group_id
LEFT JOIN balances b ON b.account_id = a.id
ORDER BY g.sort_order ASC, a.code ASC`;

/**
 * Drill-down for a profit-and-loss or balance-sheet group: every POSTED line
 * on an account in the group or any of its sub-groups, inside the statement
 * window. `$1` is the group id, `$2` the opening date (NULL means "through
 * `$3`", the balance-sheet shape), `$3` the closing date, `$4` the branch
 * (NULL rolls up every branch) and `$5` the page size.
 *
 * The window aggregates run before LIMIT, so `entryCount`, `totalDebit` and
 * `totalCredit` describe every matching line even when only the first page is
 * returned. That keeps the drill-down total equal to the statement subtotal
 * instead of the subtotal of whatever happened to fit in the table.
 */
export const STATEMENT_GROUP_LINES_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM gl_account_groups WHERE id = $1
  UNION ALL
  SELECT g.id FROM gl_account_groups g
  JOIN subtree s ON g.parent_id = s.id
), scoped AS (
  SELECT l.id,
    j.id AS journal_id,
    j.journal_no,
    j.journal_date_ad,
    j.source_type,
    j.source_id,
    l.branch_id,
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    l.line_no,
    l.memo,
    j.memo AS journal_memo,
    l.debit,
    l.credit
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  JOIN subtree s ON s.id = a.group_id
  WHERE j.status = 'POSTED'
    AND ($2::date IS NULL OR j.journal_date_ad >= $2::date)
    AND j.journal_date_ad <= $3::date
    AND ($4::varchar IS NULL OR l.branch_id = $4::varchar)
)
SELECT id,
  journal_id AS "journalId",
  journal_no AS "journalNo",
  journal_date_ad::text AS "journalDateAD",
  source_type AS "sourceType",
  source_id AS "sourceId",
  branch_id AS "branchId",
  account_id AS "accountId",
  account_code AS "accountCode",
  account_name AS "accountName",
  line_no AS "lineNo",
  memo,
  journal_memo AS "journalMemo",
  debit::numeric AS debit,
  credit::numeric AS credit,
  COUNT(*) OVER ()::int AS "entryCount",
  COALESCE(SUM(debit) OVER (), 0)::numeric AS "totalDebit",
  COALESCE(SUM(credit) OVER (), 0)::numeric AS "totalCredit"
FROM scoped
ORDER BY journal_date_ad ASC, journal_no ASC, line_no ASC
LIMIT $5::int`;

/**
 * Drill-down behind one trial-balance group subtotal: every POSTED line on an
 * account in the group or any sub-group through `$3`, split into the opening
 * window (before `$2`) and the period window (`$2`..`$3`). `$1` is the group
 * id, `$2` the opening date, `$3` the closing date, `$4` the branch (NULL rolls
 * every branch up) and `$5` the per-window page size.
 *
 * The trial balance's opening and closing columns are net balances per
 * account, not gross historical debits and credits, so those totals are built
 * from each account's net and then split by sign. Period debit and credit are
 * genuine posted turnover. The per-window page cut comes after the totals, and
 * each window gets its own first `$5` rows, so both the opening and period
 * sections stay represented even when a group has many lines.
 */
export const TRIAL_BALANCE_GROUP_LINES_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM gl_account_groups WHERE id = $1
  UNION ALL
  SELECT g.id FROM gl_account_groups g
  JOIN subtree s ON g.parent_id = s.id
), scoped AS (
  SELECT l.id,
    j.id AS journal_id,
    j.journal_no,
    j.journal_date_ad,
    j.source_type,
    j.source_id,
    l.branch_id,
    a.id AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    l.line_no,
    l.memo,
    j.memo AS journal_memo,
    l.debit,
    l.credit,
    CASE WHEN j.journal_date_ad < $2::date THEN 'OPENING' ELSE 'PERIOD' END AS line_window
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  JOIN subtree s ON s.id = a.group_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad <= $3::date
    AND ($4::varchar IS NULL OR l.branch_id = $4::varchar)
), per_account AS (
  SELECT account_id,
    COALESCE(ROUND(SUM(debit - credit) FILTER (WHERE line_window = 'OPENING'), 2), 0) AS opening_net,
    COALESCE(ROUND(SUM(debit) FILTER (WHERE line_window = 'PERIOD'), 2), 0) AS period_debit,
    COALESCE(ROUND(SUM(credit) FILTER (WHERE line_window = 'PERIOD'), 2), 0) AS period_credit,
    COALESCE(ROUND(SUM(debit - credit), 2), 0) AS closing_net
  FROM scoped
  GROUP BY account_id
), counts AS (
  SELECT
    COUNT(*) FILTER (WHERE line_window = 'OPENING')::int AS opening_count,
    COUNT(*) FILTER (WHERE line_window = 'PERIOD')::int AS period_count
  FROM scoped
), totals AS (
  SELECT
    COALESCE((SELECT SUM(GREATEST(opening_net, 0)) FROM per_account), 0)::numeric AS opening_debit,
    COALESCE((SELECT SUM(GREATEST(-opening_net, 0)) FROM per_account), 0)::numeric AS opening_credit,
    COALESCE((SELECT SUM(period_debit) FROM per_account), 0)::numeric AS period_debit,
    COALESCE((SELECT SUM(period_credit) FROM per_account), 0)::numeric AS period_credit,
    COALESCE((SELECT SUM(GREATEST(closing_net, 0)) FROM per_account), 0)::numeric AS closing_debit,
    COALESCE((SELECT SUM(GREATEST(-closing_net, 0)) FROM per_account), 0)::numeric AS closing_credit,
    c.opening_count,
    c.period_count
  FROM counts c
), ranked AS (
  SELECT scoped.*,
    ROW_NUMBER() OVER (
      PARTITION BY line_window
      ORDER BY journal_date_ad ASC, journal_no ASC, line_no ASC
    ) AS rn
  FROM scoped
)
SELECT r.id,
  r.journal_id AS "journalId",
  r.journal_no AS "journalNo",
  r.journal_date_ad::text AS "journalDateAD",
  r.source_type AS "sourceType",
  r.source_id AS "sourceId",
  r.branch_id AS "branchId",
  r.account_id AS "accountId",
  r.account_code AS "accountCode",
  r.account_name AS "accountName",
  r.line_no AS "lineNo",
  r.memo,
  r.journal_memo AS "journalMemo",
  r.debit::numeric AS debit,
  r.credit::numeric AS credit,
  r.line_window AS "lineWindow",
  t.opening_debit AS "openingDebit",
  t.opening_credit AS "openingCredit",
  t.period_debit AS "periodDebit",
  t.period_credit AS "periodCredit",
  t.closing_debit AS "closingDebit",
  t.closing_credit AS "closingCredit",
  t.opening_count AS "openingCount",
  t.period_count AS "periodCount"
FROM ranked r
CROSS JOIN totals t
WHERE r.rn <= $5::int
ORDER BY CASE WHEN r.line_window = 'OPENING' THEN 0 ELSE 1 END,
  r.journal_date_ad ASC, r.journal_no ASC, r.line_no ASC`;

/**
 * Drill-down behind one trial-balance account row: every POSTED line on `$1`
 * through `$3`, split into the opening window (before `$2`) and the period
 * window (`$2`..`$3`). `$4` is the branch (NULL rolls every branch up) and `$5`
 * is the per-window page size.
 *
 * The six statement figures use the same net-per-account rule as the trial
 * balance: opening and closing are the account's signed net split by sign,
 * while period debit and credit are genuine posted turnover. `runningBalance`
 * is debit-positive (`debit - credit`) and is ordered by date, journal and line
 * within each window: opening lines run from zero to the opening balance, and
 * period lines start at that opening balance. The window runs before LIMIT, so
 * a returned page keeps the correct running balance even when the section is
 * truncated.
 */
export const TRIAL_BALANCE_ACCOUNT_LINES_SQL = `WITH scoped AS (
  SELECT l.id,
    j.id AS journal_id,
    j.journal_no,
    j.journal_date_ad,
    j.source_type,
    j.source_id,
    l.branch_id,
    l.line_no,
    l.memo,
    j.memo AS journal_memo,
    l.debit,
    l.credit,
    l.debit - l.credit AS signed_amount,
    CASE WHEN j.journal_date_ad < $2::date THEN 'OPENING' ELSE 'PERIOD' END AS line_window
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  WHERE l.account_id = $1
    AND j.status = 'POSTED'
    AND j.journal_date_ad <= $3::date
    AND ($4::varchar IS NULL OR l.branch_id = $4::varchar)
), totals AS (
  SELECT
    COALESCE(ROUND(SUM(signed_amount) FILTER (WHERE line_window = 'OPENING'), 2), 0) AS opening_net,
    COALESCE(ROUND(SUM(debit) FILTER (WHERE line_window = 'PERIOD'), 2), 0) AS period_debit,
    COALESCE(ROUND(SUM(credit) FILTER (WHERE line_window = 'PERIOD'), 2), 0) AS period_credit,
    COALESCE(ROUND(SUM(signed_amount), 2), 0) AS closing_net,
    COUNT(*) FILTER (WHERE line_window = 'OPENING')::int AS opening_count,
    COUNT(*) FILTER (WHERE line_window = 'PERIOD')::int AS period_count
  FROM scoped
), ranked AS (
  SELECT scoped.*,
    ROW_NUMBER() OVER (
      PARTITION BY line_window
      ORDER BY journal_date_ad ASC, journal_no ASC, line_no ASC, id ASC
    ) AS rn,
    SUM(signed_amount) OVER (
      PARTITION BY line_window
      ORDER BY journal_date_ad ASC, journal_no ASC, line_no ASC, id ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS window_running
  FROM scoped
)
SELECT r.id,
  r.journal_id AS "journalId",
  r.journal_no AS "journalNo",
  r.journal_date_ad::text AS "journalDateAD",
  r.source_type AS "sourceType",
  r.source_id AS "sourceId",
  r.branch_id AS "branchId",
  r.line_no AS "lineNo",
  r.memo,
  r.journal_memo AS "journalMemo",
  r.debit::numeric AS debit,
  r.credit::numeric AS credit,
  r.line_window AS "lineWindow",
  (CASE WHEN r.line_window = 'OPENING' THEN r.window_running
    ELSE t.opening_net + r.window_running END)::numeric AS "runningBalance",
  GREATEST(t.opening_net, 0)::numeric AS "openingDebit",
  GREATEST(-t.opening_net, 0)::numeric AS "openingCredit",
  t.period_debit AS "periodDebit",
  t.period_credit AS "periodCredit",
  GREATEST(t.closing_net, 0)::numeric AS "closingDebit",
  GREATEST(-t.closing_net, 0)::numeric AS "closingCredit",
  t.opening_count AS "openingCount",
  t.period_count AS "periodCount"
FROM ranked r
CROSS JOIN totals t
WHERE r.rn <= $5::int
ORDER BY CASE WHEN r.line_window = 'OPENING' THEN 0 ELSE 1 END,
  r.journal_date_ad ASC, r.journal_no ASC, r.line_no ASC, r.id ASC`;

/** The fiscal year containing `$1`, with its bounds as plain YYYY-MM-DD text. */
export const FISCAL_YEAR_BOUNDS_SQL = `SELECT id, code,
  start_date_ad::text AS "startDateAD",
  end_date_ad::text AS "endDateAD"
FROM fiscal_years
WHERE $1::date BETWEEN start_date_ad AND end_date_ad
ORDER BY start_date_ad DESC
LIMIT 1`;

/**
 * Control-account agreement through `$1` (and one branch, or every branch
 * when `$2` is NULL). Both sides are date-bounded so a statement as of a date
 * compares the GL and subledger as of the SAME day; the existing
 * reconciliation builders are unbounded and serve the current-balance screen.
 */
export const CONTROL_AGREEMENT_ROWS_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.subledger_type AS "subledgerType",
  COALESCE(gl.balance, 0)::numeric AS "glBalance",
  COALESCE(sl.balance, 0)::numeric AS "subledgerBalance"
FROM gl_accounts a
LEFT JOIN (
  SELECT l.account_id, SUM(l.debit - l.credit) AS balance
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad <= $1::date
    AND ($2::varchar IS NULL OR l.branch_id = $2::varchar)
  GROUP BY l.account_id
) gl ON gl.account_id = a.id
LEFT JOIN (
  SELECT s.account_id, SUM(s.debit - s.credit) AS balance
  FROM gl_subledger_entries s
  WHERE s.entry_date_ad <= $1::date
    AND ($2::varchar IS NULL OR s.branch_id = $2::varchar)
  GROUP BY s.account_id
) sl ON sl.account_id = a.id
WHERE a.is_control = TRUE
ORDER BY a.code ASC`;

/**
 * Cash/bank book, account totals: one row per ledger classified CASH or BANK,
 * whether or not it carries the single posting default. `$1` is the opening
 * boundary (NULL means inception), `$2` the closing date and `$3` the branch
 * (NULL rolls up every branch).
 *
 * Only POSTED journals count, and the branch filter is on the line where the
 * branch dimension lives — exactly the rules the statements use. The closing
 * total is therefore the same figure the balance sheet reports as cash+bank.
 */
export const CASH_BANK_ACCOUNT_ROWS_SQL = `WITH scoped AS (
  SELECT l.account_id, l.debit, l.credit, j.journal_date_ad
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad <= $2::date
    AND ($3::varchar IS NULL OR l.branch_id = $3::varchar)
)
SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.account_kind AS "accountKind",
  a.posting_role AS "postingRole",
  a.bank_name AS "bankName",
  a.bank_branch AS "bankBranch",
  a.account_number AS "accountNumber",
  a.account_holder AS "accountHolder",
  a.swift_code AS "swiftCode",
  a.is_active AS "isActive",
  COALESCE(SUM(CASE WHEN $1::date IS NOT NULL AND s.journal_date_ad < $1::date
    THEN s.debit - s.credit ELSE 0 END), 0)::numeric AS opening,
  COALESCE(SUM(CASE WHEN ($1::date IS NULL OR s.journal_date_ad >= $1::date)
    THEN s.debit ELSE 0 END), 0)::numeric AS receipts,
  COALESCE(SUM(CASE WHEN ($1::date IS NULL OR s.journal_date_ad >= $1::date)
    THEN s.credit ELSE 0 END), 0)::numeric AS payments
FROM gl_accounts a
LEFT JOIN scoped s ON s.account_id = a.id
WHERE a.account_kind IN ('CASH', 'BANK')
GROUP BY a.id, a.code, a.name, a.account_kind, a.posting_role, a.bank_name,
  a.bank_branch, a.account_number, a.account_holder, a.swift_code, a.is_active
ORDER BY a.account_kind ASC, a.code ASC`;

/** The individual movements behind the cash/bank book, oldest first. */
export const CASH_BANK_ENTRY_ROWS_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  j.journal_date_ad::text AS "journalDateAD",
  j.journal_no AS "journalNo",
  j.id AS "journalId",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId",
  l.branch_id AS "branchId",
  COALESCE(l.memo, j.memo) AS memo,
  l.debit::numeric AS debit,
  l.credit::numeric AS credit
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
JOIN gl_accounts a ON a.id = l.account_id
WHERE a.account_kind IN ('CASH', 'BANK')
  AND j.status = 'POSTED'
  AND ($1::date IS NULL OR j.journal_date_ad >= $1::date)
  AND j.journal_date_ad <= $2::date
  AND ($3::varchar IS NULL OR l.branch_id = $3::varchar)
ORDER BY a.code ASC, j.journal_date_ad ASC, j.journal_no ASC, l.line_no ASC`;

/**
 * Direct cash-flow rows: every line of a journal that has at least one cash or
 * bank line inside the requested branch/window. Cash lines carry the actual
 * movement; non-cash lines are the counterpart accounts used to classify it.
 * Filtering the journal's lines by the same branch keeps a branch statement
 * from borrowing a counterpart from another branch.
 */
export const CASH_FLOW_JOURNAL_ROWS_SQL = `WITH scoped_journals AS (
  SELECT DISTINCT j.id
  FROM gl_journals j
  JOIN gl_journal_lines cash_line ON cash_line.journal_id = j.id
  JOIN gl_accounts cash_account ON cash_account.id = cash_line.account_id
  WHERE j.status = 'POSTED'
    AND j.journal_date_ad >= $1::date
    AND j.journal_date_ad <= $2::date
    AND cash_account.account_kind IN ('CASH', 'BANK')
    AND ($3::varchar IS NULL OR cash_line.branch_id = $3::varchar)
)
SELECT j.id AS "journalId",
  j.journal_no AS "journalNo",
  j.journal_date_ad::text AS "journalDateAD",
  l.branch_id AS "branchId",
  l.account_id AS "accountId",
  a.code AS "accountCode",
  a.name AS "accountName",
  a.account_kind AS "accountKind",
  g.code AS "groupCode",
  g.name AS "groupName",
  g.account_type AS "accountType",
  g.statement_group AS "statementGroup",
  l.debit::numeric AS debit,
  l.credit::numeric AS credit
FROM scoped_journals sj
JOIN gl_journals j ON j.id = sj.id
JOIN gl_journal_lines l ON l.journal_id = j.id
JOIN gl_accounts a ON a.id = l.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE ($3::varchar IS NULL OR l.branch_id = $3::varchar)
ORDER BY j.journal_date_ad ASC, j.journal_no ASC, l.line_no ASC`;

export interface AccountGroupInput {
  id: string;
  parentId?: string | null;
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  normalBalance: NormalBalance;
  sortOrder?: number;
  isDemo?: boolean;
}

export function accountGroupSeedParams(input: {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  statementGroup: StatementGroup;
  normalBalance: NormalBalance;
  sortOrder: number;
}): unknown[] {
  return [
    input.id,
    input.code,
    input.name,
    input.accountType,
    input.statementGroup,
    input.normalBalance,
    input.sortOrder,
  ];
}

export function accountSeedParams(input: {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isControl: boolean;
  subledgerType: SubledgerType;
  postingRole: PostingRole | null;
  groupCode: string;
}): unknown[] {
  return [
    input.id,
    input.code,
    input.name,
    input.description || null,
    input.isControl,
    input.subledgerType,
    input.postingRole,
    input.groupCode,
  ];
}

export function accountGroupInsertParams(input: AccountGroupInput): unknown[] {
  return [
    input.id,
    input.parentId || null,
    input.code,
    input.name,
    input.accountType,
    input.statementGroup,
    input.normalBalance,
    Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder as number) : 0,
    Boolean(input.isDemo),
  ];
}

export interface AccountInput {
  id: string;
  code: string;
  name: string;
  groupId: string;
  description?: string | null;
  isControl: boolean;
  subledgerType: SubledgerType;
  postingRole?: PostingRole | null;
  accountKind?: AccountKind;
  bankName?: string | null;
  bankBranch?: string | null;
  accountNumber?: string | null;
  accountHolder?: string | null;
  swiftCode?: string | null;
  masterProfile?: Record<string, unknown>;
  isDemo?: boolean;
}

export function accountInsertParams(input: AccountInput): unknown[] {
  return [
    input.id,
    input.code,
    input.name,
    input.groupId,
    input.description || null,
    input.isControl,
    input.subledgerType,
    input.postingRole || null,
    input.accountKind || 'OTHER',
    input.bankName || null,
    input.bankBranch || null,
    input.accountNumber || null,
    input.accountHolder || null,
    input.swiftCode || null,
    input.masterProfile || {},
    Boolean(input.isDemo),
  ];
}

export interface JournalInsertInput {
  id: string;
  journalNo: string;
  journalDateAD: string;
  fiscalYearId: string;
  periodId: string;
  branchId: string;
  sourceType: string;
  sourceId?: string | null;
  voucherType?: string | null;
  voucherClass?: string | null;
  referenceNo?: string | null;
  referenceDateAD?: string | null;
  chequeNo?: string | null;
  chequeDateAD?: string | null;
  currency?: string | null;
  exchangeRate?: number | null;
  memo?: string | null;
  reversalOfId?: string | null;
  postedBy?: string | null;
  isDemo?: boolean;
}

export function journalInsertParams(input: JournalInsertInput): unknown[] {
  return [
    input.id,
    input.journalNo,
    input.journalDateAD,
    input.fiscalYearId,
    input.periodId,
    input.branchId,
    input.sourceType,
    input.sourceId || null,
    input.voucherType || 'JOURNAL',
    input.voucherClass || null,
    input.referenceNo || null,
    input.referenceDateAD || null,
    input.chequeNo || null,
    input.chequeDateAD || null,
    input.currency || 'NPR',
    input.exchangeRate ?? 1,
    input.memo || null,
    input.reversalOfId || null,
    input.postedBy || null,
    Boolean(input.isDemo),
  ];
}

export function journalLineInsertParams(input: {
  id: string;
  journalId: string;
  lineNo: number;
  accountId: string;
  costCenterId?: string | null;
  branchId: string;
  debit: number;
  credit: number;
  memo?: string | null;
}): unknown[] {
  return [
    input.id,
    input.journalId,
    input.lineNo,
    input.accountId,
    input.costCenterId || null,
    input.branchId,
    input.debit,
    input.credit,
    input.memo || null,
  ];
}

export function subledgerInsertParams(input: {
  id: string;
  journalId: string;
  journalLineId: string;
  accountId: string;
  subledgerId?: string | null;
  subledgerType: Exclude<SubledgerType, 'NONE'>;
  partyId?: string | null;
  partyName?: string | null;
  branchId: string;
  entryDateAD: string;
  debit: number;
  credit: number;
}): unknown[] {
  return [
    input.id,
    input.journalId,
    input.journalLineId,
    input.accountId,
    input.subledgerId || null,
    input.subledgerType,
    input.partyId || null,
    input.partyName || null,
    input.branchId,
    input.entryDateAD,
    input.debit,
    input.credit,
  ];
}

/**
 * Subledger master: a named book bound to one control account. The list carries
 * the two sides of the reconciliation per book — the account's posted GL
 * balance and the sum of its subledger entries — so the screen can show a
 * difference without a second request per row.
 */
export const SUBLEDGER_COLUMNS = `s.id,
  s.code,
  s.name,
  s.subledger_type AS "subledgerType",
  s.main_account_id AS "mainAccountId",
  s.party_id AS "partyId",
  s.description,
  s.is_active AS "isActive",
  s.is_demo AS "isDemo",
  a.code AS "accountCode",
  a.name AS "accountName",
  a.posting_role AS "accountPostingRole",
  g.code AS "groupCode",
  g.name AS "groupName"`;

const SUBLEDGER_JOIN_SQL = `FROM gl_subledgers s
JOIN gl_accounts a ON a.id = s.main_account_id
JOIN gl_account_groups g ON g.id = a.group_id`;

/**
 * The register list. `$1` is the branch filter (NULL = company level), so a
 * book's rows, the account-wide subledger total, the GL balance and the
 * unlinked count all describe the same branch window. `bookBalance` is one
 * book; `subledgerBalance` is every book on the control account; `difference`
 * is therefore the account-level GL tie-out, repeated on each of its books.
 */
export const SUBLEDGER_LIST_SQL = `SELECT ${SUBLEDGER_COLUMNS},
  COALESCE(book.entry_count, 0)::int AS "entryCount",
  COALESCE(book.balance, 0)::numeric AS "bookBalance",
  COALESCE(acct.balance, 0)::numeric AS "subledgerBalance",
  COALESCE(gl.balance, 0)::numeric AS "glBalance",
  (COALESCE(gl.balance, 0) - COALESCE(acct.balance, 0))::numeric AS "difference",
  COALESCE(unlinked.count, 0)::int AS "unlinkedCount"
${SUBLEDGER_JOIN_SQL}
LEFT JOIN (
  SELECT se.subledger_id, COUNT(*)::int AS entry_count, SUM(se.debit - se.credit) AS balance
  FROM gl_subledger_entries se
  JOIN gl_journals j ON j.id = se.journal_id
  WHERE j.status = 'POSTED' AND ($1::varchar IS NULL OR se.branch_id = $1)
  GROUP BY se.subledger_id
) book ON book.subledger_id = s.id
LEFT JOIN (
  SELECT se.account_id, SUM(se.debit - se.credit) AS balance
  FROM gl_subledger_entries se
  JOIN gl_journals j ON j.id = se.journal_id
  WHERE j.status = 'POSTED' AND ($1::varchar IS NULL OR se.branch_id = $1)
  GROUP BY se.account_id
) acct ON acct.account_id = s.main_account_id
LEFT JOIN (
  SELECT l.account_id, SUM(l.debit - l.credit) AS balance
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  WHERE j.status = 'POSTED' AND ($1::varchar IS NULL OR j.branch_id = $1)
  GROUP BY l.account_id
) gl ON gl.account_id = s.main_account_id
LEFT JOIN (
  SELECT se.account_id, COUNT(*)::int AS count
  FROM gl_subledger_entries se
  WHERE se.subledger_id IS NULL AND ($1::varchar IS NULL OR se.branch_id = $1)
  GROUP BY se.account_id
) unlinked ON unlinked.account_id = s.main_account_id
ORDER BY s.code ASC`;

export const SUBLEDGER_BY_ID_SQL = `SELECT ${SUBLEDGER_COLUMNS}
${SUBLEDGER_JOIN_SQL} WHERE s.id = $1`;

export const SUBLEDGER_BY_CODE_SQL = `SELECT s.id FROM gl_subledgers s WHERE s.code = $1`;

export const SUBLEDGER_GENERAL_BY_ACCOUNT_SQL = `SELECT s.id
FROM gl_subledgers s
WHERE s.main_account_id = $1 AND s.party_id IS NULL`;

export const SUBLEDGER_BY_ACCOUNT_PARTY_SQL = `SELECT s.id
FROM gl_subledgers s
WHERE s.main_account_id = $1 AND s.party_id = $2`;

/** Every active book on one control account, used to resolve a posting line. */
export const SUBLEDGER_BOOKS_BY_ACCOUNT_SQL = `SELECT s.id, s.party_id AS "partyId"
FROM gl_subledgers s
WHERE s.main_account_id = $1 AND s.is_active = TRUE
ORDER BY s.party_id NULLS FIRST, s.code ASC`;

export const SUBLEDGER_MASTER_INSERT_SQL = `INSERT INTO gl_subledgers (
  id, code, name, subledger_type, main_account_id, party_id, description, is_active, is_demo
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export const SUBLEDGER_UPDATE_SQL = `UPDATE gl_subledgers SET
  name = $2,
  description = $3,
  is_active = $4,
  main_account_id = $5,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1`;

export const SUBLEDGER_DELETE_SQL = `DELETE FROM gl_subledgers WHERE id = $1`;

/** Posted rows in one book; 0 means the book is safe to delete or rebind. */
export const SUBLEDGER_BOOK_USAGE_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_subledger_entries WHERE subledger_id = $1`;

/** Legacy rows on an account that carry no book id (pre-linkage history). */
export const SUBLEDGER_USAGE_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_subledger_entries WHERE account_id = $1 AND subledger_id IS NULL`;

/**
 * The posted movements of one book. Reading by `subledger_id` (rather than by
 * the main account) is what lets two books on one account stay separable, and
 * what makes the report independent of the chart's control-account mapping.
 */
export const SUBLEDGER_BOOK_ENTRIES_SQL = `SELECT s.id,
  s.journal_id AS "journalId",
  j.journal_no AS "journalNo",
  s.journal_line_id AS "journalLineId",
  s.account_id AS "accountId",
  s.subledger_type AS "subledgerType",
  s.party_id AS "partyId",
  s.party_name AS "partyName",
  s.branch_id AS "branchId",
  s.entry_date_ad::text AS "entryDateAD",
  s.debit::numeric AS debit,
  s.credit::numeric AS credit,
  COALESCE(l.memo, j.memo, '') AS memo
FROM gl_subledger_entries s
JOIN gl_journals j ON j.id = s.journal_id
LEFT JOIN gl_journal_lines l ON l.id = s.journal_line_id
WHERE s.subledger_id = $1
  AND j.status = 'POSTED'
  AND ($2::date IS NULL OR s.entry_date_ad >= $2::date)
  AND ($3::date IS NULL OR s.entry_date_ad <= $3::date)
  AND ($4::varchar IS NULL OR s.branch_id = $4)
ORDER BY s.entry_date_ad DESC, s.id DESC`;

export const SUBLEDGER_BOOK_PARTY_BALANCES_SQL = `SELECT
  s.party_id AS "partyId",
  COALESCE(MAX(s.party_name), '') AS "partyName",
  COALESCE(SUM(s.debit - s.credit), 0)::numeric AS balance
FROM gl_subledger_entries s
JOIN gl_journals j ON j.id = s.journal_id
WHERE s.subledger_id = $1
  AND j.status = 'POSTED'
  AND ($2::date IS NULL OR s.entry_date_ad >= $2::date)
  AND ($3::date IS NULL OR s.entry_date_ad <= $3::date)
  AND ($4::varchar IS NULL OR s.branch_id = $4)
GROUP BY s.party_id
ORDER BY balance DESC NULLS LAST`;

/** Rows on the book's control account that still carry no book id, in scope. */
export const SUBLEDGER_BOOK_UNLINKED_COUNT_SQL = `SELECT COUNT(*)::int AS count
FROM gl_subledger_entries
WHERE account_id = $1 AND subledger_id IS NULL
  AND ($2::varchar IS NULL OR branch_id = $2)`;

/**
 * Party masters for book generation. Customer ids are
 * `customer_records.customer_id` — the same id sales invoices, stock issue and
 * accounting already use — so a customer never has two subledger identities.
 */
export const SUBLEDGER_CUSTOMER_CANDIDATES_SQL = `SELECT customer_id AS id,
  customer_name AS name,
  customer_id AS code
FROM customer_records
WHERE status = 'ACTIVE' AND ($1::varchar IS NULL OR branch_id = $1)
ORDER BY customer_name ASC`;

export const SUBLEDGER_SUPPLIER_CANDIDATES_SQL = `SELECT id,
  name,
  COALESCE(supplier_code, id) AS code
FROM suppliers
WHERE status = 'ACTIVE'
ORDER BY name ASC`;

export const SUBLEDGER_EMPLOYEE_CANDIDATES_SQL = `SELECT id,
  name,
  employee_code AS code
FROM employees
WHERE is_active = TRUE AND ($1::varchar IS NULL OR branch_id = $1)
ORDER BY employee_code ASC`;

export const CUSTOMER_PARTY_BY_ID_SQL = `SELECT customer_id AS id, customer_name AS name
FROM customer_records WHERE customer_id = $1`;

export const SUPPLIER_PARTY_BY_ID_SQL = `SELECT id, name FROM suppliers WHERE id = $1`;

export const EMPLOYEE_PARTY_BY_ID_SQL = `SELECT id, name FROM employees WHERE id = $1`;

/** Move a party's existing rows from the general book (or no book) to its own. */
export const SUBLEDGER_REASSIGN_PARTY_SQL = `UPDATE gl_subledger_entries
SET subledger_id = $3
WHERE account_id = $1
  AND party_id = $2
  AND (subledger_id IS NULL OR ($4::varchar IS NOT NULL AND subledger_id = $4))`;

/**
 * Idempotent default subledger seed. It resolves the control account by code,
 * so it works on a fresh install and on an install whose account ids differ.
 * ON CONFLICT DO NOTHING absorbs both a known code and an account that already
 * has a different subledger assigned.
 */
export const SUBLEDGER_SEED_INSERT_SQL = `INSERT INTO gl_subledgers (
  id, code, name, subledger_type, main_account_id, description, is_active, is_demo
)
SELECT $1, $2, $3, $4, a.id, $5, TRUE, FALSE
FROM gl_accounts a
WHERE a.code = $6 AND a.is_control = TRUE
ON CONFLICT DO NOTHING`;
