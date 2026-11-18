-- 0042 — a closed year's snapshot carries the statement columns it has to serve.
--
-- `fiscal_year_balances` already held the pre-close position, the closing
-- journal's effect and the post-close balance. A closed year's trial balance and
-- profit-and-loss also need the opening position (before the year) and the
-- year's own posted turnover, which the old columns could not express: the
-- statement endpoints had to keep scanning `gl_journal_lines` to get them.
--
-- With these three columns the whole window is on the snapshot, and the figures
-- are the same ones the ledger scan returns for the same dates:
--
--   opening_balance  = posted net before the year start
--   period_debit     = posted debit  inside the year, the closing journal included
--   period_credit    = posted credit inside the year, the closing journal included
--   opening_balance + period_debit - period_credit = post_close_balance
--
-- The immutability trigger is untouched: it refuses UPDATE and DELETE, and an
-- ALTER TABLE ADD COLUMN is neither.

ALTER TABLE fiscal_year_balances
    ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS period_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS period_credit NUMERIC(16, 2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION rebuild_fiscal_year_balances(p_fiscal_year_id VARCHAR) RETURNS BIGINT AS $$
DECLARE
    v_start DATE;
    v_end DATE;
    v_count BIGINT;
BEGIN
    SELECT start_date_ad, end_date_ad INTO v_start, v_end
      FROM fiscal_years WHERE id = p_fiscal_year_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fiscal year % does not exist', p_fiscal_year_id
            USING ERRCODE = 'no_data_found';
    END IF;

    PERFORM set_config('inventory.allow_ledger_purge', 'on', true);
    DELETE FROM fiscal_year_balances WHERE fiscal_year_id = p_fiscal_year_id;

    INSERT INTO fiscal_year_balances (
        fiscal_year_id, branch_id, account_id, account_code, account_name, account_type,
        opening_balance, period_debit, period_credit,
        pre_close_debit, pre_close_credit, pre_close_balance,
        close_debit, close_credit, post_close_balance
    )
    WITH opening AS (
        SELECT l.branch_id,
               l.account_id,
               SUM(l.debit)::numeric(16, 2) AS debit,
               SUM(l.credit)::numeric(16, 2) AS credit
          FROM gl_journal_lines l
          JOIN gl_journals j ON j.id = l.journal_id
         WHERE j.status = 'POSTED'
           AND j.journal_date_ad < v_start
         GROUP BY l.branch_id, l.account_id
    ), pre AS (
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
        SELECT branch_id, account_id FROM opening
        UNION
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
           round(COALESCE(op.debit, 0) - COALESCE(op.credit, 0), 2),
           round(
               COALESCE(pre.debit, 0) - COALESCE(op.debit, 0) + COALESCE(closing.debit, 0),
               2
           ),
           round(
               COALESCE(pre.credit, 0) - COALESCE(op.credit, 0) + COALESCE(closing.credit, 0),
               2
           ),
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
      LEFT JOIN opening op ON op.branch_id = k.branch_id AND op.account_id = k.account_id
      LEFT JOIN pre ON pre.branch_id = k.branch_id AND pre.account_id = k.account_id
      LEFT JOIN closing ON closing.branch_id = k.branch_id AND closing.account_id = k.account_id
      JOIN gl_accounts a ON a.id = k.account_id
      JOIN gl_account_groups g ON g.id = a.group_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
