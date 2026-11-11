/**
 * Bank reconciliation repository.
 *
 * Reconciliation belongs to a bank ledger (`gl_accounts.account_kind = 'BANK'`)
 * and a period, never to a branch: all branches post to the same company bank
 * account and the bank issues one statement for that account. Branch remains a
 * posting dimension on `gl_journal_lines`, so the read queries expose each
 * book line's branch without filtering the statement by it.
 *
 * Statement amounts are signed from the bank statement's point of view
 * (positive = deposit, negative = withdrawal), while the book side stays in
 * posted debit/credit. The service compares `statement.amount` with
 * `book.debit - book.credit`; it never rewrites either.
 */

export interface BankAccountRow {
  accountId: string;
  code: string;
  name: string;
  bankName: string | null;
  bankBranch: string | null;
  accountNumber: string | null;
  accountHolder: string | null;
  isActive: boolean;
}

export interface BankStatementLineRow {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementDateBS: string;
  description: string;
  reference: string | null;
  amount: number;
  importBatchId: string;
  importSource: 'CSV' | 'OFX';
  matchedJournalLineId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedJournalNo: string | null;
  matchedJournalDate: string | null;
  matchedBranchId: string | null;
  matchedBranchCode: string | null;
  matchedBranchName: string | null;
}

export interface BankBookEntryRow {
  journalLineId: string;
  journalId: string;
  journalNo: string;
  journalDateAD: string;
  sourceType: string;
  sourceId: string | null;
  journalMemo: string | null;
  memo: string | null;
  debit: number;
  credit: number;
  branchId: string;
  branchCode: string;
  branchName: string;
  matchedStatementLineId: string | null;
}

export interface BankReconciliationSessionRow {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  periodStartBS: string;
  periodEndBS: string;
  openingStatementBalance: number;
  closingStatementBalance: number;
  status: 'OPEN' | 'LOCKED';
  lockedAt: string | null;
  lockedBy: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const BANK_ACCOUNTS_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.bank_name AS "bankName",
  a.bank_branch AS "bankBranch",
  a.account_number AS "accountNumber",
  a.account_holder AS "accountHolder",
  a.is_active AS "isActive"
FROM gl_accounts a
WHERE a.account_kind = 'BANK'
ORDER BY CASE WHEN a.posting_role = 'BANK' THEN 0 ELSE 1 END,
  a.code ASC`;

export const BANK_ACCOUNT_BY_ID_SQL = `SELECT a.id AS "accountId",
  a.code,
  a.name,
  a.bank_name AS "bankName",
  a.bank_branch AS "bankBranch",
  a.account_number AS "accountNumber",
  a.account_holder AS "accountHolder",
  a.is_active AS "isActive"
FROM gl_accounts a
WHERE a.id = $1 AND a.account_kind = 'BANK'`;

export const BANK_DEFAULT_WINDOW_SQL = `SELECT start_date_ad::text AS "startDateAD"
FROM fiscal_years
WHERE is_current = TRUE
ORDER BY start_date_ad DESC
LIMIT 1`;

/**
 * Balance immediately before the reconciliation period. No branch filter:
 * every branch's postings to this bank account are part of the same bank book.
 */
export const BANK_BOOK_OPENING_SQL = `SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS opening
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad < $2::date`;

/** Posted book movement inside the reconciliation period, across all branches. */
export const BANK_BOOK_MOVEMENT_SQL = `SELECT COUNT(*)::int AS "lineCount",
  COALESCE(SUM(l.debit), 0)::numeric AS debit,
  COALESCE(SUM(l.credit), 0)::numeric AS credit,
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS movement
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad >= $2::date
  AND j.journal_date_ad <= $3::date`;

/**
 * Book lines in the period, with the posting branch and the statement line
 * that has claimed the line. This is where branch attribution belongs: the
 * statement line itself has no branch.
 */
export const BANK_BOOK_ENTRIES_SQL = `SELECT l.id AS "journalLineId",
  j.id AS "journalId",
  j.journal_no AS "journalNo",
  j.journal_date_ad::text AS "journalDateAD",
  j.source_type AS "sourceType",
  j.source_id AS "sourceId",
  j.memo AS "journalMemo",
  l.memo,
  l.debit::numeric AS debit,
  l.credit::numeric AS credit,
  l.branch_id AS "branchId",
  b.code AS "branchCode",
  b.name AS "branchName",
  bs.id AS "matchedStatementLineId"
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
JOIN branches b ON b.id = l.branch_id
LEFT JOIN bank_statement_lines bs ON bs.matched_journal_line_id = l.id
WHERE l.account_id = $1
  AND j.status = 'POSTED'
  AND j.journal_date_ad >= $2::date
  AND j.journal_date_ad <= $3::date
ORDER BY j.journal_date_ad ASC, j.journal_no ASC, l.line_no ASC
LIMIT 1000`;

export const BANK_STATEMENT_SUMMARY_SQL = `SELECT COUNT(*)::int AS "lineCount",
  COUNT(*) FILTER (WHERE matched_journal_line_id IS NOT NULL)::int AS "matchedCount",
  COALESCE(SUM(amount), 0)::numeric AS movement,
  COALESCE(SUM(amount) FILTER (WHERE matched_journal_line_id IS NULL), 0)::numeric AS "unmatchedAmount",
  COUNT(*) FILTER (WHERE matched_journal_line_id IS NULL)::int AS "unmatchedCount"
FROM bank_statement_lines
WHERE bank_account_id = $1
  AND statement_date >= $2::date
  AND statement_date <= $3::date`;

export const BANK_STATEMENT_LINES_SQL = `SELECT s.id,
  s.bank_account_id AS "bankAccountId",
  s.statement_date::text AS "statementDate",
  s.statement_date_bs AS "statementDateBS",
  s.description,
  s.reference,
  s.amount::numeric AS amount,
  s.import_batch_id AS "importBatchId",
  s.import_source AS "importSource",
  s.matched_journal_line_id AS "matchedJournalLineId",
  s.matched_at::text AS "matchedAt",
  s.matched_by AS "matchedBy",
  j.journal_no AS "matchedJournalNo",
  j.journal_date_ad::text AS "matchedJournalDate",
  l.branch_id AS "matchedBranchId",
  b.code AS "matchedBranchCode",
  b.name AS "matchedBranchName"
FROM bank_statement_lines s
LEFT JOIN gl_journal_lines l ON l.id = s.matched_journal_line_id
LEFT JOIN gl_journals j ON j.id = l.journal_id
LEFT JOIN branches b ON b.id = l.branch_id
WHERE s.bank_account_id = $1
  AND s.statement_date >= $2::date
  AND s.statement_date <= $3::date
ORDER BY s.statement_date ASC, s.created_at ASC, s.id ASC
LIMIT 1000`;

export const BANK_SESSION_BY_ACCOUNT_PERIOD_SQL = `SELECT id,
  bank_account_id AS "bankAccountId",
  period_start::text AS "periodStart",
  period_end::text AS "periodEnd",
  period_start_bs AS "periodStartBS",
  period_end_bs AS "periodEndBS",
  opening_statement_balance::numeric AS "openingStatementBalance",
  closing_statement_balance::numeric AS "closingStatementBalance",
  status,
  locked_at::text AS "lockedAt",
  locked_by AS "lockedBy",
  reopened_at::text AS "reopenedAt",
  reopened_by AS "reopenedBy",
  reopen_reason AS "reopenReason",
  created_by AS "createdBy",
  created_at::text AS "createdAt",
  updated_at::text AS "updatedAt"
FROM bank_reconciliation_sessions
WHERE bank_account_id = $1
  AND period_start = $2::date
  AND period_end = $3::date`;

export const BANK_SESSION_BY_ACCOUNT_PERIOD_FOR_UPDATE_SQL = `${BANK_SESSION_BY_ACCOUNT_PERIOD_SQL}
FOR UPDATE`;

export const BANK_SESSION_BY_ID_SQL = `SELECT id,
  bank_account_id AS "bankAccountId",
  period_start::text AS "periodStart",
  period_end::text AS "periodEnd",
  period_start_bs AS "periodStartBS",
  period_end_bs AS "periodEndBS",
  opening_statement_balance::numeric AS "openingStatementBalance",
  closing_statement_balance::numeric AS "closingStatementBalance",
  status,
  locked_at::text AS "lockedAt",
  locked_by AS "lockedBy",
  reopened_at::text AS "reopenedAt",
  reopened_by AS "reopenedBy",
  reopen_reason AS "reopenReason",
  created_by AS "createdBy",
  created_at::text AS "createdAt",
  updated_at::text AS "updatedAt"
FROM bank_reconciliation_sessions
WHERE id = $1`;

export const BANK_SESSION_BY_ID_FOR_UPDATE_SQL = `${BANK_SESSION_BY_ID_SQL}
FOR UPDATE`;

/**
 * Overlapping periods are ambiguous for matching/locking; refuse them for the
 * same bank account regardless of session status. `$4` is the session being
 * edited, or NULL for a new one.
 */
export const BANK_SESSION_OVERLAP_SQL = `SELECT id
FROM bank_reconciliation_sessions
WHERE bank_account_id = $1
  AND period_start <= $3::date
  AND period_end >= $2::date
  AND ($4::varchar IS NULL OR id <> $4)
LIMIT 1`;

export const BANK_LOCKED_SESSION_FOR_DATES_SQL = `SELECT id,
  period_start::text AS "periodStart",
  period_end::text AS "periodEnd"
FROM bank_reconciliation_sessions
WHERE bank_account_id = $1
  AND status = 'LOCKED'
  AND period_start <= $3::date
  AND period_end >= $2::date
ORDER BY period_start ASC
LIMIT 1`;

export const BANK_STATEMENT_LINE_FOR_UPDATE_SQL = `SELECT id,
  bank_account_id AS "bankAccountId",
  statement_date::text AS "statementDate",
  description,
  amount::numeric AS amount,
  matched_journal_line_id AS "matchedJournalLineId"
FROM bank_statement_lines
WHERE id = $1
FOR UPDATE`;

export const BANK_JOURNAL_LINE_FOR_UPDATE_SQL = `SELECT l.id AS "journalLineId",
  l.journal_id AS "journalId",
  l.account_id AS "accountId",
  l.branch_id AS "branchId",
  l.debit::numeric AS debit,
  l.credit::numeric AS credit,
  j.journal_no AS "journalNo",
  j.journal_date_ad::text AS "journalDateAD",
  j.status
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
WHERE l.id = $1
  AND l.account_id = $2
  AND j.status = 'POSTED'
FOR UPDATE OF l`;

export const BANK_JOURNAL_LINE_MATCH_CONFLICT_SQL = `SELECT id
FROM bank_statement_lines
WHERE matched_journal_line_id = $1
  AND id <> $2
LIMIT 1`;

export const BANK_STATEMENT_MATCH_UPDATE_SQL = `UPDATE bank_statement_lines SET
  matched_journal_line_id = $2,
  matched_at = CURRENT_TIMESTAMP,
  matched_by = $3
WHERE id = $1`;

export const BANK_STATEMENT_UNMATCH_UPDATE_SQL = `UPDATE bank_statement_lines SET
  matched_journal_line_id = NULL,
  matched_at = NULL,
  matched_by = NULL
WHERE id = $1`;

export const BANK_IMPORT_INSERT_SQL = `INSERT INTO bank_statement_lines (
  id, bank_account_id, statement_date, description, reference,
  amount, statement_date_bs, import_batch_id, import_source, fingerprint
) VALUES ($1, $2, $3::date, $4, $5, $6::numeric, $7, $8, $9, $10)
ON CONFLICT (bank_account_id, fingerprint) DO NOTHING
RETURNING id`;

export const BANK_SESSION_INSERT_SQL = `INSERT INTO bank_reconciliation_sessions (
  id, bank_account_id, period_start, period_end,
  period_start_bs, period_end_bs,
  opening_statement_balance, closing_statement_balance, created_by
) VALUES ($1, $2, $3::date, $4::date, $5, $6, $7::numeric, $8::numeric, $9)
RETURNING id`;

export const BANK_SESSION_UPDATE_SQL = `UPDATE bank_reconciliation_sessions SET
  opening_statement_balance = $2,
  closing_statement_balance = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'OPEN'
RETURNING id`;

export const BANK_SESSION_LOCK_SQL = `UPDATE bank_reconciliation_sessions SET
  status = 'LOCKED',
  locked_at = CURRENT_TIMESTAMP,
  locked_by = $2,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'OPEN'
RETURNING id`;

export const BANK_SESSION_REOPEN_SQL = `UPDATE bank_reconciliation_sessions SET
  status = 'OPEN',
  reopened_at = CURRENT_TIMESTAMP,
  reopened_by = $2,
  reopen_reason = $3,
  updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND status = 'LOCKED'
RETURNING id`;
