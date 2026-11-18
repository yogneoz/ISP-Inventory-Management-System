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
