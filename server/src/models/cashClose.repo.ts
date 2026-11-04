/**
 * Daily cash close — every SQL string for the branch cash position and its
 * close record.
 *
 * The figures are derived from POSTED `gl_journal_lines` on accounts carrying
 * the CASH or BANK posting default, exactly like the cash/bank book and the
 * balance sheet. No payment document is re-summed here, so the close cannot
 * disagree with the ledger it is closing.
 *
 * Opening is the signed net (debit − credit) before the business day; cash-in
 * and cash-out are that day's gross debits and credits; expected closing is
 * the signed net through the day. A reversed journal stops contributing
 * because its header is REVERSED; the linked contra journal carries the
 * reversal movement.
 */

export interface CashBranchFigures {
  branchId: string;
  code: string;
  name: string;
  opening: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
}

export interface DailyCashCloseRow {
  id: string;
  branchId: string;
  businessDateAD: string;
  openingCash: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  variance: number;
  status: 'CLOSED' | 'OPEN';
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
}

/**
 * One row per branch the caller may see, even when the branch has no cash
 * movement (zeros), so the consolidated table is a complete branch picture
 * rather than only the branches that happened to trade.
 *
 * `$2` is a varchar[] of allowed branches, or NULL for every branch.
 */
export const CASH_BRANCH_FIGURES_SQL = `WITH scoped AS (
  SELECT l.branch_id, j.journal_date_ad, l.debit, l.credit
  FROM gl_journal_lines l
  JOIN gl_journals j ON j.id = l.journal_id
  JOIN gl_accounts a ON a.id = l.account_id
  WHERE j.status = 'POSTED'
    AND a.account_kind IN ('CASH', 'BANK')
    AND j.journal_date_ad <= $1::date
    AND ($2::varchar[] IS NULL OR l.branch_id = ANY($2::varchar[]))
)
SELECT b.id AS "branchId",
  b.code,
  b.name,
  COALESCE(SUM(CASE WHEN s.journal_date_ad < $1::date
    THEN s.debit - s.credit ELSE 0 END), 0)::numeric AS opening,
  COALESCE(SUM(CASE WHEN s.journal_date_ad = $1::date
    THEN s.debit ELSE 0 END), 0)::numeric AS "cashIn",
  COALESCE(SUM(CASE WHEN s.journal_date_ad = $1::date
    THEN s.credit ELSE 0 END), 0)::numeric AS "cashOut",
  COALESCE(SUM(CASE WHEN s.journal_date_ad <= $1::date
    THEN s.debit - s.credit ELSE 0 END), 0)::numeric AS "expectedClosing"
FROM branches b
LEFT JOIN scoped s ON s.branch_id = b.id
WHERE ($2::varchar[] IS NULL OR b.id = ANY($2::varchar[]))
GROUP BY b.id, b.code, b.name
ORDER BY b.code ASC`;

export const DAILY_CASH_CLOSE_COLUMNS = `c.id,
  c.branch_id AS "branchId",
  c.business_date_ad::text AS "businessDateAD",
  c.opening_cash::numeric AS "openingCash",
  c.cash_in::numeric AS "cashIn",
  c.cash_out::numeric AS "cashOut",
  c.expected_closing::numeric AS "expectedClosing",
  c.counted_closing::numeric AS "countedClosing",
  c.variance::numeric AS variance,
  c.status,
  c.closed_by AS "closedBy",
  c.closed_at AS "closedAt",
  c.reopened_by AS "reopenedBy",
  c.reopened_at AS "reopenedAt"`;

/** Every close on one date, under the caller's branch list (NULL = all). */
export const DAILY_CASH_CLOSES_FOR_DATE_SQL = `SELECT ${DAILY_CASH_CLOSE_COLUMNS}
FROM daily_cash_closes c
WHERE c.business_date_ad = $1::date
  AND ($2::varchar[] IS NULL OR c.branch_id = ANY($2::varchar[]))
ORDER BY c.branch_id ASC`;

export const DAILY_CASH_CLOSE_BY_ID_SQL = `SELECT ${DAILY_CASH_CLOSE_COLUMNS}
FROM daily_cash_closes c
WHERE c.id = $1`;

export const DAILY_CASH_CLOSE_BY_BRANCH_DATE_SQL = `SELECT ${DAILY_CASH_CLOSE_COLUMNS}
FROM daily_cash_closes c
WHERE c.branch_id = $1 AND c.business_date_ad = $2::date`;

/** Serializes one branch/day's close so two requests cannot both insert. */
export const DAILY_CASH_CLOSE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))::text AS lock`;

export const DAILY_CASH_CLOSE_INSERT_SQL = `INSERT INTO daily_cash_closes AS c (
  id, branch_id, business_date_ad, opening_cash, cash_in, cash_out,
  expected_closing, counted_closing, variance, status, closed_by, closed_at,
  is_demo
) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, 'CLOSED', $10, CURRENT_TIMESTAMP, FALSE)
RETURNING ${DAILY_CASH_CLOSE_COLUMNS}`;

export const DAILY_CASH_CLOSE_UPDATE_CLOSED_SQL = `UPDATE daily_cash_closes c SET
  opening_cash = $2,
  cash_in = $3,
  cash_out = $4,
  expected_closing = $5,
  counted_closing = $6,
  variance = $7,
  status = 'CLOSED',
  closed_by = $8,
  closed_at = CURRENT_TIMESTAMP,
  reopened_by = NULL,
  reopened_at = NULL,
  updated_at = CURRENT_TIMESTAMP
WHERE c.id = $1
RETURNING ${DAILY_CASH_CLOSE_COLUMNS}`;

export const DAILY_CASH_CLOSE_REOPEN_SQL = `UPDATE daily_cash_closes c SET
  status = 'OPEN',
  reopened_by = $2,
  reopened_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE c.id = $1
RETURNING ${DAILY_CASH_CLOSE_COLUMNS}`;

export function cashCloseInsertParams(input: {
  id: string;
  branchId: string;
  dateAD: string;
  opening: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  variance: number;
  closedBy: string | null;
}): unknown[] {
  return [
    input.id,
    input.branchId,
    input.dateAD,
    input.opening,
    input.cashIn,
    input.cashOut,
    input.expectedClosing,
    input.countedClosing,
    input.variance,
    input.closedBy,
  ];
}

export function cashCloseUpdateParams(input: {
  id: string;
  opening: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  variance: number;
  closedBy: string | null;
}): unknown[] {
  return [
    input.id,
    input.opening,
    input.cashIn,
    input.cashOut,
    input.expectedClosing,
    input.countedClosing,
    input.variance,
    input.closedBy,
  ];
}
