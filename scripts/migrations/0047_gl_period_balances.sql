-- SCALE-3 follow-up: the two accounting read models the audit still listed as
-- missing — `gl_period_balances` and `gl_party_period_balances`.
--
-- Why these exist:
--
--   gl_period_balances       — one row per branch × account × period, with the
--                              signed opening balance, the period's turnover and
--                              the closing balance. Trial balance, balance sheet
--                              and P&L read this instead of scanning every
--                              `gl_journal_lines` row ever posted.
--   gl_party_period_balances — the same shape per control account × party. AR
--                              aging and dunning read it; it is NOT a second
--                              receivables ledger, it is the subledger's period
--                              projection.
--
-- How correctness is kept (the `branch_stock_balances` pattern):
--
--   * The ledger stays the only truth. Both models are recomputed FROM the
--     ledger, never accumulated in code, so a replay cannot double-count.
--   * Maintenance is a statement-level trigger on the append-only source
--     (`gl_journal_lines`, `gl_subledger_entries`), inside the writer's
--     transaction: a rollback removes the ledger rows and the model change
--     together. `REFERENCING NEW/OLD TABLE` gives one recompute per affected
--     (branch, account) instead of one per line, so a 1,141-line payroll journal
--     costs the same as a two-line one per account.
--   * One function defines the rows (`gl_period_balance_rows`,
--     `gl_party_period_balance_rows`). The incremental refresh, the rebuild and
--     the operator command all read that one definition, which is why the
--     maintained table and a from-scratch rebuild agree byte for byte including
--     `updated_at` (the last source row's `created_at`, never `now()`).
--   * If an apply fails (a row locked by a concurrent reader, maintenance, a
--     constraint), the trigger queues the key in `read_model_outbox` and
--     `flush_read_model_outbox()` replays it — durable and observable, never
--     dropped.
--
-- Sign convention is debit-positive (`debit - credit`), matching
-- `ACCOUNT_BALANCE_ROWS_SQL`; opening = everything in earlier periods for the
-- same branch/account/party, closing = opening + period_debit - period_credit.
--
-- Everything is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`), so a fresh
-- install converges whether it applies schema.sql alone or schema.sql plus this
-- file, and re-running the file is a no-op.

-- 1. Account × branch × period.
CREATE TABLE IF NOT EXISTS gl_period_balances (
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    period_id VARCHAR(50) NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    period_key VARCHAR(7) NOT NULL,
    -- Denormalised so the opening window can order periods without a join.
    period_start_ad DATE NOT NULL,
    opening_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    period_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    period_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    closing_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (branch_id, account_id, period_id)
);

-- Two readers are known and indexed: one account's history (the history index)
-- and a year-scoped statement (the year index). A period-only index served no
-- reader and cost every posting an insert, so it is deliberately absent.
CREATE INDEX IF NOT EXISTS idx_gl_period_balances_year
    ON gl_period_balances(fiscal_year_id, account_id);
CREATE INDEX IF NOT EXISTS idx_gl_period_balances_history
    ON gl_period_balances(branch_id, account_id, period_start_ad);

-- 2. Control account × party × period. `party_id` is part of the key and is
--    never NULL: a subledger row without a party is not a party balance.
CREATE TABLE IF NOT EXISTS gl_party_period_balances (
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    subledger_type VARCHAR(30) NOT NULL,
    party_id VARCHAR(100) NOT NULL,
    period_id VARCHAR(50) NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    period_key VARCHAR(7) NOT NULL,
    period_start_ad DATE NOT NULL,
    opening_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    period_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    period_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    closing_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (branch_id, account_id, subledger_type, party_id, period_id)
);

CREATE INDEX IF NOT EXISTS idx_gl_party_period_balances_party
    ON gl_party_period_balances(subledger_type, party_id, period_start_ad);

-- 3. The single row definition both the refresh and the rebuild read. Only
--    POSTED journals count, matching the statements and the closed-year
--    snapshot. The journal join carries `journal_date_ad` so the partitioned
--    parent prunes through its composite key instead of scanning every month.
--
--    `updated_at` is the newest source row's `created_at`. `created_at` is
--    nullable and a writer may supply NULL, so when no row in the group carries
--    one the group's posting date at UTC stands in: the model's NOT NULL column
--    can then never reject the refresh, which would queue the key and retry the
--    same failure forever. The fallback is a function of the ledger rows only, so
--    the incremental path and a from-scratch rebuild still agree byte for byte.
CREATE OR REPLACE FUNCTION gl_period_balance_rows(
    p_branch_id VARCHAR DEFAULT NULL,
    p_account_id VARCHAR DEFAULT NULL
) RETURNS TABLE (
    branch_id VARCHAR,
    account_id VARCHAR,
    period_id VARCHAR,
    fiscal_year_id VARCHAR,
    period_key VARCHAR,
    period_start_ad DATE,
    opening_balance NUMERIC,
    period_debit NUMERIC,
    period_credit NUMERIC,
    closing_balance NUMERIC,
    updated_at TIMESTAMP WITH TIME ZONE
) AS $$
    WITH totals AS (
        SELECT l.branch_id,
               l.account_id,
               j.period_id,
               j.fiscal_year_id,
               p.period_key,
               p.start_date_ad AS period_start_ad,
               SUM(l.debit)::numeric(16, 2) AS debit,
               SUM(l.credit)::numeric(16, 2) AS credit,
               COALESCE(MAX(l.created_at),
                        MAX((l.journal_date_ad::timestamp) AT TIME ZONE 'UTC')) AS last_line_at
          FROM gl_journal_lines l
          JOIN gl_journals j
            ON j.id = l.journal_id
           AND j.journal_date_ad = l.journal_date_ad
          JOIN gl_periods p ON p.id = j.period_id
         WHERE j.status = 'POSTED'
           AND (p_branch_id IS NULL OR l.branch_id = p_branch_id)
           AND (p_account_id IS NULL OR l.account_id = p_account_id)
         GROUP BY l.branch_id, l.account_id, j.period_id, j.fiscal_year_id,
                  p.period_key, p.start_date_ad
    )
    SELECT t.branch_id,
           t.account_id,
           t.period_id,
           t.fiscal_year_id,
           t.period_key,
           t.period_start_ad,
           round(COALESCE(SUM(t.debit - t.credit) OVER (
               PARTITION BY t.branch_id, t.account_id
               ORDER BY t.period_start_ad, t.period_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 2),
           t.debit,
           t.credit,
           round(COALESCE(SUM(t.debit - t.credit) OVER (
               PARTITION BY t.branch_id, t.account_id
               ORDER BY t.period_start_ad, t.period_id
               ROWS UNBOUNDED PRECEDING), 0), 2),
           t.last_line_at
      FROM totals t
     ORDER BY t.branch_id, t.account_id, t.period_start_ad, t.period_id;
$$ LANGUAGE sql STABLE;

-- 4. The same definition for parties. The subledger row's journal is reached
--    through the journal registry, which is the FK target the partitioned
--    ledger actually exposes. `updated_at` falls back to `entry_date_ad` at UTC
--    for the same reason as the period model.
CREATE OR REPLACE FUNCTION gl_party_period_balance_rows(
    p_branch_id VARCHAR DEFAULT NULL,
    p_account_id VARCHAR DEFAULT NULL,
    p_party_id VARCHAR DEFAULT NULL,
    p_subledger_type VARCHAR DEFAULT NULL
) RETURNS TABLE (
    branch_id VARCHAR,
    account_id VARCHAR,
    subledger_type VARCHAR,
    party_id VARCHAR,
    period_id VARCHAR,
    fiscal_year_id VARCHAR,
    period_key VARCHAR,
    period_start_ad DATE,
    opening_balance NUMERIC,
    period_debit NUMERIC,
    period_credit NUMERIC,
    closing_balance NUMERIC,
    updated_at TIMESTAMP WITH TIME ZONE
) AS $$
    WITH totals AS (
        SELECT s.branch_id,
               s.account_id,
               s.subledger_type,
               s.party_id,
               j.period_id,
               j.fiscal_year_id,
               p.period_key,
               p.start_date_ad AS period_start_ad,
               SUM(s.debit)::numeric(16, 2) AS debit,
               SUM(s.credit)::numeric(16, 2) AS credit,
               COALESCE(MAX(s.created_at),
                        MAX((s.entry_date_ad::timestamp) AT TIME ZONE 'UTC')) AS last_entry_at
          FROM gl_subledger_entries s
          JOIN gl_journals_registry r ON r.id = s.journal_id
          JOIN gl_journals j
            ON j.id = r.id
           AND j.journal_date_ad = r.journal_date_ad
          JOIN gl_periods p ON p.id = j.period_id
         WHERE j.status = 'POSTED'
           AND s.party_id IS NOT NULL
           AND (p_branch_id IS NULL OR s.branch_id = p_branch_id)
           AND (p_account_id IS NULL OR s.account_id = p_account_id)
           AND (p_party_id IS NULL OR s.party_id = p_party_id)
           AND (p_subledger_type IS NULL OR s.subledger_type = p_subledger_type)
         GROUP BY s.branch_id, s.account_id, s.subledger_type, s.party_id,
                  j.period_id, j.fiscal_year_id, p.period_key, p.start_date_ad
    )
    SELECT t.branch_id,
           t.account_id,
           t.subledger_type,
           t.party_id,
           t.period_id,
           t.fiscal_year_id,
           t.period_key,
           t.period_start_ad,
           round(COALESCE(SUM(t.debit - t.credit) OVER (
               PARTITION BY t.branch_id, t.account_id, t.subledger_type, t.party_id
               ORDER BY t.period_start_ad, t.period_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0), 2),
           t.debit,
           t.credit,
           round(COALESCE(SUM(t.debit - t.credit) OVER (
               PARTITION BY t.branch_id, t.account_id, t.subledger_type, t.party_id
               ORDER BY t.period_start_ad, t.period_id
               ROWS UNBOUNDED PRECEDING), 0), 2),
           t.last_entry_at
      FROM totals t
     ORDER BY t.branch_id, t.account_id, t.subledger_type, t.party_id,
              t.period_start_ad, t.period_id;
$$ LANGUAGE sql STABLE;

-- 5. Refresh one branch/account (or everything when both arguments are NULL)
--    from the ledger. The delete-then-insert is what makes a replay idempotent:
--    the result is a function of the ledger, not of how many times it ran.
CREATE OR REPLACE FUNCTION refresh_gl_period_balances(
    p_branch_id VARCHAR DEFAULT NULL,
    p_account_id VARCHAR DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_count BIGINT;
BEGIN
    DELETE FROM gl_period_balances m
     WHERE (p_branch_id IS NULL OR m.branch_id = p_branch_id)
       AND (p_account_id IS NULL OR m.account_id = p_account_id);

    INSERT INTO gl_period_balances (
        branch_id, account_id, period_id, fiscal_year_id, period_key,
        period_start_ad, opening_balance, period_debit, period_credit,
        closing_balance, updated_at
    )
    SELECT branch_id, account_id, period_id, fiscal_year_id, period_key,
           period_start_ad, opening_balance, period_debit, period_credit,
           closing_balance, updated_at
      FROM gl_period_balance_rows(p_branch_id, p_account_id);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION refresh_gl_party_period_balances(
    p_branch_id VARCHAR DEFAULT NULL,
    p_account_id VARCHAR DEFAULT NULL,
    p_party_id VARCHAR DEFAULT NULL,
    p_subledger_type VARCHAR DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_count BIGINT;
BEGIN
    DELETE FROM gl_party_period_balances m
     WHERE (p_branch_id IS NULL OR m.branch_id = p_branch_id)
       AND (p_account_id IS NULL OR m.account_id = p_account_id)
       AND (p_party_id IS NULL OR m.party_id = p_party_id)
       AND (p_subledger_type IS NULL OR m.subledger_type = p_subledger_type);

    INSERT INTO gl_party_period_balances (
        branch_id, account_id, subledger_type, party_id, period_id,
        fiscal_year_id, period_key, period_start_ad, opening_balance,
        period_debit, period_credit, closing_balance, updated_at
    )
    SELECT branch_id, account_id, subledger_type, party_id, period_id,
           fiscal_year_id, period_key, period_start_ad, opening_balance,
           period_debit, period_credit, closing_balance, updated_at
      FROM gl_party_period_balance_rows(
             p_branch_id, p_account_id, p_party_id, p_subledger_type);

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- 6. From-scratch rebuilds. `TRUNCATE` + the same row function: identical to the
--    incremental path by construction, and it is what `--verify` compares.
--
--    TRUNCATE, not DELETE-everything: a full rebuild rewrites every row anyway,
--    so TRUNCATE's ACCESS EXCLUSIVE lock buys no dead tuples and no scan of the
--    old table. That lock is exactly why this stays the operator path and the
--    triggers use the incremental refresh instead.
CREATE OR REPLACE FUNCTION rebuild_gl_period_balances() RETURNS BIGINT AS $$
DECLARE
    v_count BIGINT;
BEGIN
    TRUNCATE gl_period_balances;
    INSERT INTO gl_period_balances (
        branch_id, account_id, period_id, fiscal_year_id, period_key,
        period_start_ad, opening_balance, period_debit, period_credit,
        closing_balance, updated_at
    )
    SELECT branch_id, account_id, period_id, fiscal_year_id, period_key,
           period_start_ad, opening_balance, period_debit, period_credit,
           closing_balance, updated_at
      FROM gl_period_balance_rows(NULL, NULL);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rebuild_gl_party_period_balances() RETURNS BIGINT AS $$
DECLARE
    v_count BIGINT;
BEGIN
    TRUNCATE gl_party_period_balances;
    INSERT INTO gl_party_period_balances (
        branch_id, account_id, subledger_type, party_id, period_id,
        fiscal_year_id, period_key, period_start_ad, opening_balance,
        period_debit, period_credit, closing_balance, updated_at
    )
    SELECT branch_id, account_id, subledger_type, party_id, period_id,
           fiscal_year_id, period_key, period_start_ad, opening_balance,
           period_debit, period_credit, closing_balance, updated_at
      FROM gl_party_period_balance_rows(NULL, NULL, NULL, NULL);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- 7. Statement-level maintenance. One recompute per affected (branch, account)
--    per statement, not per line. A failure is queued, never dropped.
CREATE OR REPLACE FUNCTION sync_gl_period_balances() RETURNS trigger AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT l.branch_id, l.account_id
          FROM changed_lines l
    LOOP
        BEGIN
            PERFORM refresh_gl_period_balances(r.branch_id, r.account_id);
        EXCEPTION WHEN OTHERS THEN
            PERFORM enqueue_read_model_write(
                'gl_period_balances',
                jsonb_build_object('branchId', r.branch_id, 'accountId', r.account_id),
                '{}'::jsonb,
                SQLERRM
            );
        END;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- One function, two triggers: each aliases its transition table to the same
-- name, so the insert and the delete path cannot drift apart. No NULL guard is
-- needed on the key — branch_id and account_id are NOT NULL on the ledger, and
-- a NULL branch would turn one refresh into an every-branch rewrite.
CREATE OR REPLACE TRIGGER trg_gl_journal_lines_period_balances_ins
    AFTER INSERT ON gl_journal_lines
    REFERENCING NEW TABLE AS changed_lines
    FOR EACH STATEMENT EXECUTE FUNCTION sync_gl_period_balances();

CREATE OR REPLACE TRIGGER trg_gl_journal_lines_period_balances_del
    AFTER DELETE ON gl_journal_lines
    REFERENCING OLD TABLE AS changed_lines
    FOR EACH STATEMENT EXECUTE FUNCTION sync_gl_period_balances();

CREATE OR REPLACE FUNCTION sync_gl_party_period_balances() RETURNS trigger AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT s.branch_id, s.account_id, s.subledger_type, s.party_id
          FROM changed_entries s
         WHERE s.party_id IS NOT NULL
    LOOP
        BEGIN
            PERFORM refresh_gl_party_period_balances(
                r.branch_id, r.account_id, r.party_id, r.subledger_type);
        EXCEPTION WHEN OTHERS THEN
            PERFORM enqueue_read_model_write(
                'gl_party_period_balances',
                jsonb_build_object(
                    'branchId', r.branch_id,
                    'accountId', r.account_id,
                    'subledgerType', r.subledger_type,
                    'partyId', r.party_id
                ),
                '{}'::jsonb,
                SQLERRM
            );
        END;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Same function on both directions, for the same reason as the period model.
-- `party_id` is the one key column that is genuinely nullable: a shared
-- subledger line carries no party and is not a party balance.
CREATE OR REPLACE TRIGGER trg_gl_subledger_period_balances_ins
    AFTER INSERT ON gl_subledger_entries
    REFERENCING NEW TABLE AS changed_entries
    FOR EACH STATEMENT EXECUTE FUNCTION sync_gl_party_period_balances();

CREATE OR REPLACE TRIGGER trg_gl_subledger_period_balances_del
    AFTER DELETE ON gl_subledger_entries
    REFERENCING OLD TABLE AS changed_entries
    FOR EACH STATEMENT EXECUTE FUNCTION sync_gl_party_period_balances();

-- 8. Teach the replay command the two new models. Everything else about the
--    outbox is unchanged: pending rows are observable and replayable.
CREATE OR REPLACE FUNCTION flush_read_model_outbox(p_limit INT DEFAULT 100)
RETURNS TABLE (applied BIGINT, failed BIGINT, remaining BIGINT) AS $$
DECLARE
    r RECORD;
    v_applied BIGINT := 0;
    v_failed BIGINT := 0;
BEGIN
    FOR r IN
        SELECT * FROM read_model_outbox
         WHERE applied_at IS NULL
         ORDER BY id
         LIMIT GREATEST(p_limit, 1)
         FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            IF r.model = 'stock_balance' THEN
                PERFORM apply_branch_stock_balance(
                    r.key_json->>'branchId',
                    r.key_json->>'productId',
                    (r.payload->>'quantity')::int,
                    (r.payload->>'unitCost')::numeric,
                    r.payload->>'sourceTxnId',
                    (r.payload->>'sourceTimestamp')::timestamptz
                );
            ELSIF r.model = 'fiscal_year_balances' THEN
                PERFORM rebuild_fiscal_year_balances(r.key_json->>'fiscalYearId');
            ELSIF r.model = 'gl_period_balances' THEN
                PERFORM refresh_gl_period_balances(
                    r.key_json->>'branchId', r.key_json->>'accountId');
            ELSIF r.model = 'gl_party_period_balances' THEN
                PERFORM refresh_gl_party_period_balances(
                    r.key_json->>'branchId',
                    r.key_json->>'accountId',
                    r.key_json->>'partyId',
                    r.key_json->>'subledgerType');
            ELSE
                RAISE EXCEPTION 'unknown read model %', r.model;
            END IF;
            UPDATE read_model_outbox
               SET applied_at = CURRENT_TIMESTAMP,
                   attempts = attempts + 1,
                   last_error = NULL
             WHERE id = r.id;
            v_applied := v_applied + 1;
        EXCEPTION WHEN OTHERS THEN
            UPDATE read_model_outbox
               SET attempts = attempts + 1,
                   last_error = SQLERRM
             WHERE id = r.id;
            v_failed := v_failed + 1;
        END;
    END LOOP;

    RETURN QUERY
        SELECT v_applied,
               v_failed,
               (SELECT count(*) FROM read_model_outbox WHERE applied_at IS NULL);
END;
$$ LANGUAGE plpgsql;

-- 9. Backfill existing installs. The triggers only see new ledger rows, so the
--    first install of this migration seeds both models from the ledger. Both
--    rebuilds are idempotent and safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM gl_period_balances) THEN
        PERFORM rebuild_gl_period_balances();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM gl_party_period_balances) THEN
        PERFORM rebuild_gl_party_period_balances();
    END IF;
END $$;
