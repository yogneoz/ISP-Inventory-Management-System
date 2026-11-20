/**
 * Read-model SQL (SCALE-3): the pre-aggregated stock position and the
 * closed-year snapshot.
 *
 * All SQL for the read models lives here, like every other repository, so the
 * `check:no-inline-sql` gate and the `check:branch-predicates` gate can see it.
 * The maintenance functions themselves are in `scripts/migrations/0041_read_models.sql`;
 * these constants are the read/queries and command entry points.
 */

/**
 * The shell/stock-on-hand read: one branch's positions, newest valuation last.
 * `branch_id` is the caller's scope, never a client-supplied value.
 */
export const BRANCH_STOCK_BALANCES_SQL = `SELECT
  product_id AS "productId",
  quantity,
  value::numeric AS value,
  source_txn_id AS "sourceTxnId",
  source_timestamp AS "sourceTimestamp",
  updated_at AS "updatedAt"
FROM branch_stock_balances
WHERE branch_id = $1
ORDER BY product_id ASC
LIMIT $2`;

/** One branch's total stock value — the badge number, no product scan. */
export const BRANCH_STOCK_VALUE_SQL = `SELECT
  COALESCE(SUM(value), 0)::numeric AS value,
  COALESCE(SUM(quantity), 0)::bigint AS quantity,
  COUNT(*)::int AS "productCount"
FROM branch_stock_balances
WHERE branch_id = $1`;

/** Pending read-model work: the observable "is the queue stuck?" number. */
export const READ_MODEL_PENDING_COUNT_SQL = `SELECT
  COUNT(*)::int AS pending,
  MIN(created_at) AS "oldestCreatedAt",
  MAX(attempts)::int AS "maxAttempts"
FROM read_model_outbox
WHERE applied_at IS NULL`;

/** The oldest pending rows, so a stuck queue names what it is stuck on. */
export const READ_MODEL_PENDING_LIST_SQL = `SELECT
  id,
  model,
  key_json AS key,
  attempts,
  last_error AS "lastError",
  created_at AS "createdAt"
FROM read_model_outbox
WHERE applied_at IS NULL
ORDER BY id ASC
LIMIT $1`;

/** Replay queued work. Returns applied/failed/remaining in one round trip. */
export const READ_MODEL_FLUSH_SQL = `SELECT applied, failed, remaining
FROM flush_read_model_outbox($1)`;

/** Recompute the stock position from the ledger (truncate + latest row per key). */
export const STOCK_BALANCE_REBUILD_SQL = `SELECT rebuild_branch_stock_balances() AS rows`;

/** Recompute one closed year's snapshot from the ledger. */
export const FISCAL_YEAR_BALANCES_REBUILD_SQL = `SELECT rebuild_fiscal_year_balances($1) AS rows`;

/** Queue a read-model write that could not be applied inline. */
export const READ_MODEL_ENQUEUE_SQL = `SELECT enqueue_read_model_write($1, $2::jsonb, $3::jsonb, $4) AS id`;

/**
 * Period balances for one branch: opening, turnover and closing per account and
 * period, maintained from `gl_journal_lines`. Signed, debit-positive — the same
 * convention as `ACCOUNT_BALANCE_ROWS_SQL`. `$2` narrows to a fiscal year and
 * `$3` to one account; both NULL reads the branch's whole history.
 *
 * Deliberately no LIMIT: the row set is the chart of accounts × periods, which
 * the caller narrows with `$2`/`$3`, and a silent truncation would drop accounts
 * from a trial balance without saying so.
 */
export const GL_PERIOD_BALANCES_SQL = `SELECT
  account_id AS "accountId",
  period_id AS "periodId",
  period_key AS "periodKey",
  fiscal_year_id AS "fiscalYearId",
  period_start_ad AS "periodStartAd",
  opening_balance::numeric AS "openingBalance",
  period_debit::numeric AS "periodDebit",
  period_credit::numeric AS "periodCredit",
  closing_balance::numeric AS "closingBalance",
  updated_at AS "updatedAt"
FROM gl_period_balances
WHERE branch_id = $1
  AND ($2::varchar IS NULL OR fiscal_year_id = $2::varchar)
  AND ($3::varchar IS NULL OR account_id = $3::varchar)
  ORDER BY account_id ASC, period_start_ad ASC, period_id ASC`;

/**
 * Party balances for one branch: the AR/AP aging read. `$2` is the subledger
 * type, `$3` one party and `$4` one period; NULL means every value at that
 * position. Never a client-supplied branch — the caller passes its session scope.
 * No LIMIT, for the same reason as `GL_PERIOD_BALANCES_SQL`.
 *
 * Rows are sparse per period: a party with no activity in a period has no row
 * for it, and its balance is carried by its latest earlier row. An "as at
 * period" read therefore joins each party's latest row at or before the period
 * rather than filtering to the period alone.
 */
export const GL_PARTY_PERIOD_BALANCES_SQL = `SELECT
  account_id AS "accountId",
  subledger_type AS "subledgerType",
  party_id AS "partyId",
  period_id AS "periodId",
  period_key AS "periodKey",
  fiscal_year_id AS "fiscalYearId",
  period_start_ad AS "periodStartAd",
  opening_balance::numeric AS "openingBalance",
  period_debit::numeric AS "periodDebit",
  period_credit::numeric AS "periodCredit",
  closing_balance::numeric AS "closingBalance",
  updated_at AS "updatedAt"
FROM gl_party_period_balances
WHERE branch_id = $1
  AND ($2::varchar IS NULL OR subledger_type = $2::varchar)
  AND ($3::varchar IS NULL OR party_id = $3::varchar)
  AND ($4::varchar IS NULL OR period_key = $4::varchar)
  ORDER BY subledger_type ASC, party_id ASC, account_id ASC, period_start_ad ASC, period_id ASC`;

/** Recompute every period balance from the ledger (branch × account × period). */
export const GL_PERIOD_BALANCES_REBUILD_SQL = `SELECT rebuild_gl_period_balances() AS rows`;

/** Recompute every party balance from the subledger (account × party × period). */
export const GL_PARTY_PERIOD_BALANCES_REBUILD_SQL = `SELECT rebuild_gl_party_period_balances() AS rows`;
