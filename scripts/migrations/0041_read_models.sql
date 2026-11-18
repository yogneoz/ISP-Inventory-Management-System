-- SCALE-3 (worklist item: pre-aggregated stock and closed-year read models).
--
-- Two aggregates that reporting and the shell read instead of rescanning the
-- append-only sources:
--
--   branch_stock_balances  — the current on-hand position per (branch, product),
--                            derived from `transaction_logs`, the durable
--                            quantity ledger. The ledger stays the audit source;
--                            this table is the O(1) answer to "what is on hand".
--   fiscal_year_balances   — already exists (written atomically by the year-end
--                            close). This migration adds the ability to rebuild
--                            it from the ledger, so a snapshot can be proven
--                            equal to a from-scratch recomputation.
--
-- How the stock model stays correct:
--
--   * A trigger on `transaction_logs` applies the row's own `quantity_after`
--     (plus `unit_cost`) to the model inside the writer's transaction. A
--     rollback therefore removes the ledger row and the model change together —
--     the read model cannot gain a phantom from an aborted write.
--   * The apply is monotonic: an older ledger row that arrives late (backdated
--     import) cannot overwrite a newer position, because the row is only applied
--     when `(source_timestamp, source_txn_id)` is greater than the stored one.
--     That is exactly the ordering `rebuild_branch_stock_balances()` uses, which
--     is why the incremental table and the rebuilt table are identical.
--   * If applying fails (the model is missing, locked for maintenance, or the
--     key violates a constraint), the trigger catches the error and writes the
--     same payload to `read_model_outbox` — durable, replayable, and visible.
--     `flush_read_model_outbox()` applies pending rows and reports what is left.
--
-- Everything is idempotent (IF NOT EXISTS / CREATE OR REPLACE), so a fresh
-- install converges whether it applies schema.sql alone or schema.sql plus this
-- file, and re-running the file is a no-op.

-- 1. The stock read model: one row per branch and product.
CREATE TABLE IF NOT EXISTS branch_stock_balances (
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INT NOT NULL DEFAULT 0,
    value NUMERIC(16, 2) NOT NULL DEFAULT 0,
    -- The ledger row this position came from. Kept so the rebuild can reproduce
    -- the exact same winner and so a divergence names the row that caused it.
    source_txn_id VARCHAR(100) NOT NULL,
    source_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (branch_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_stock_balances_product
    ON branch_stock_balances(product_id);
CREATE INDEX IF NOT EXISTS idx_branch_stock_balances_value
    ON branch_stock_balances(branch_id, value DESC);

-- 2. Durable queue for read-model work that could not be applied inline.
CREATE TABLE IF NOT EXISTS read_model_outbox (
    id BIGSERIAL PRIMARY KEY,
    model VARCHAR(40) NOT NULL,
    key_json JSONB NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_read_model_outbox_pending
    ON read_model_outbox(model, id)
    WHERE applied_at IS NULL;

-- 3. Apply one ledger position to the stock model. Monotonic: a late, older row
--    never overwrites a newer position. `updated_at` is the ledger row's own
--    timestamp (not now()), so an incremental row and a rebuilt row are equal
--    byte for byte.
CREATE OR REPLACE FUNCTION apply_branch_stock_balance(
    p_branch_id VARCHAR,
    p_product_id VARCHAR,
    p_quantity INT,
    p_unit_cost NUMERIC,
    p_source_txn_id VARCHAR,
    p_source_timestamp TIMESTAMP WITH TIME ZONE
) RETURNS void AS $$
BEGIN
    INSERT INTO branch_stock_balances (
        branch_id, product_id, quantity, value, source_txn_id, source_timestamp, updated_at
    ) VALUES (
        p_branch_id, p_product_id, p_quantity,
        round(COALESCE(p_unit_cost, 0) * p_quantity, 2),
        p_source_txn_id, p_source_timestamp, p_source_timestamp
    )
    ON CONFLICT (branch_id, product_id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           value = EXCLUDED.value,
           source_txn_id = EXCLUDED.source_txn_id,
           source_timestamp = EXCLUDED.source_timestamp,
           updated_at = EXCLUDED.updated_at
     WHERE (branch_stock_balances.source_timestamp, branch_stock_balances.source_txn_id)
           < (EXCLUDED.source_timestamp, EXCLUDED.source_txn_id);
END;
$$ LANGUAGE plpgsql;

-- 4. Enqueue a read-model write that could not be applied inline.
CREATE OR REPLACE FUNCTION enqueue_read_model_write(
    p_model VARCHAR,
    p_key JSONB,
    p_payload JSONB,
    p_error TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO read_model_outbox (model, key_json, payload, last_error)
    VALUES (p_model, p_key, p_payload, p_error)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- 5. Keep the stock model in step with the ledger. Same transaction, so a
--    rollback takes both. A failure here is queued, never dropped.
CREATE OR REPLACE FUNCTION sync_branch_stock_balance() RETURNS trigger AS $$
BEGIN
    IF NEW.branch_id IS NULL OR NEW.product_id IS NULL THEN
        RETURN NEW;
    END IF;
    BEGIN
        PERFORM apply_branch_stock_balance(
            NEW.branch_id, NEW.product_id, NEW.quantity_after, NEW.unit_cost,
            NEW.id, NEW.timestamp_ad
        );
    EXCEPTION WHEN OTHERS THEN
        PERFORM enqueue_read_model_write(
            'stock_balance',
            jsonb_build_object('branchId', NEW.branch_id, 'productId', NEW.product_id),
            jsonb_build_object(
                'quantity', NEW.quantity_after,
                'unitCost', NEW.unit_cost,
                'sourceTxnId', NEW.id,
                'sourceTimestamp', NEW.timestamp_ad
            ),
            SQLERRM
        );
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_transaction_logs_stock_balance
    AFTER INSERT ON transaction_logs
    FOR EACH ROW EXECUTE FUNCTION sync_branch_stock_balance();

-- 6. Rebuild the stock model from the ledger. The DISTINCT ON ordering is the
--    same (timestamp, id) ordering the trigger's monotonic guard converges to.
CREATE OR REPLACE FUNCTION rebuild_branch_stock_balances() RETURNS BIGINT AS $$
DECLARE
    v_count BIGINT;
BEGIN
    TRUNCATE branch_stock_balances;
    INSERT INTO branch_stock_balances (
        branch_id, product_id, quantity, value, source_txn_id, source_timestamp, updated_at
    )
    SELECT latest.branch_id,
           latest.product_id,
           latest.quantity_after,
           round(COALESCE(latest.unit_cost, 0) * latest.quantity_after, 2),
           latest.id,
           latest.timestamp_ad,
           latest.timestamp_ad
      FROM (
        SELECT DISTINCT ON (t.branch_id, t.product_id)
               t.branch_id, t.product_id, t.quantity_after, t.unit_cost, t.id, t.timestamp_ad
          FROM transaction_logs t
         WHERE t.branch_id IS NOT NULL
           AND t.product_id IS NOT NULL
         ORDER BY t.branch_id, t.product_id, t.timestamp_ad DESC, t.id DESC
      ) latest;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- 7. Rebuild a closed year's snapshot from the ledger. The close writes these
--    rows once, inside its transaction; this recomputes them with the same
--    definition: the cumulative posted position through the year end, excluding
--    that year's own closing journal, plus that closing journal's effect. The
--    immutability trigger is honoured through the documented purge switch, which
--    is transaction-local, so a failed rebuild leaves the snapshot untouched.
CREATE OR REPLACE FUNCTION rebuild_fiscal_year_balances(p_fiscal_year_id VARCHAR) RETURNS BIGINT AS $$
DECLARE
    v_end DATE;
    v_count BIGINT;
BEGIN
    SELECT end_date_ad INTO v_end FROM fiscal_years WHERE id = p_fiscal_year_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fiscal year % does not exist', p_fiscal_year_id
            USING ERRCODE = 'no_data_found';
    END IF;

    PERFORM set_config('inventory.allow_ledger_purge', 'on', true);
    DELETE FROM fiscal_year_balances WHERE fiscal_year_id = p_fiscal_year_id;

    INSERT INTO fiscal_year_balances (
        fiscal_year_id, branch_id, account_id, account_code, account_name, account_type,
        pre_close_debit, pre_close_credit, pre_close_balance,
        close_debit, close_credit, post_close_balance
    )
    WITH pre AS (
        SELECT l.branch_id,
               l.account_id,
               SUM(l.debit)::numeric(16, 2) AS debit,
               SUM(l.credit)::numeric(16, 2) AS credit
          FROM gl_journal_lines l
          JOIN gl_journals j ON j.id = l.journal_id
         WHERE j.status = 'POSTED'
           AND j.journal_date_ad <= v_end
           AND NOT (j.source_type = 'YEAR_END_CLOSE' AND j.source_id = p_fiscal_year_id)
         GROUP BY l.branch_id, l.account_id
    ), closing AS (
        SELECT l.branch_id,
               l.account_id,
               SUM(l.debit)::numeric(16, 2) AS debit,
               SUM(l.credit)::numeric(16, 2) AS credit
          FROM gl_journal_lines l
          JOIN gl_journals j ON j.id = l.journal_id
         WHERE j.status = 'POSTED'
           AND j.source_type = 'YEAR_END_CLOSE'
           AND j.source_id = p_fiscal_year_id
         GROUP BY l.branch_id, l.account_id
    ), keys AS (
        SELECT branch_id, account_id FROM pre
        UNION
        SELECT branch_id, account_id FROM closing
    )
    SELECT p_fiscal_year_id,
           k.branch_id,
           k.account_id,
           a.code,
           a.name,
           g.account_type,
           COALESCE(pre.debit, 0),
           COALESCE(pre.credit, 0),
           round(COALESCE(pre.debit, 0) - COALESCE(pre.credit, 0), 2),
           COALESCE(closing.debit, 0),
           COALESCE(closing.credit, 0),
           round(
               COALESCE(pre.debit, 0) - COALESCE(pre.credit, 0)
               + COALESCE(closing.debit, 0) - COALESCE(closing.credit, 0),
               2
           )
      FROM keys k
      LEFT JOIN pre ON pre.branch_id = k.branch_id AND pre.account_id = k.account_id
      LEFT JOIN closing ON closing.branch_id = k.branch_id AND closing.account_id = k.account_id
      JOIN gl_accounts a ON a.id = k.account_id
      JOIN gl_account_groups g ON g.id = a.group_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- 8. Replay queued read-model work. Reports how much is still pending, so a
--    stuck queue is a number an operator can watch rather than a mystery.
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

-- 9. Backfill existing installs: the trigger only sees new ledger rows, so the
--    first boot after this migration (or the migration itself) must seed the
--    model from the ledger. `rebuild_branch_stock_balances()` is exactly that,
--    and it is idempotent, so it is safe here and in the rebuild command.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM branch_stock_balances) THEN
        PERFORM rebuild_branch_stock_balances();
    END IF;
END $$;
