-- ACC-7: upgrade a populated install without rewriting its history.
--
-- 1) Backfill one party book for every control-account party that already has
--    posted subledger rows. The books are a read-time attribution layer: no
--    posted row is moved or updated, so the append-only ledger is untouched.
--    Deterministic ids/codes and the NOT EXISTS guard make a replay a no-op.
-- 2) Put the current required close tasks on every period that already exists.
--    New periods continue to copy the same templates at first use.

-- 0) The ACC-3 provider column landed without its inline fee check on
--    installs upgraded by migration 0011. Add the fresh-schema constraint.
ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_fee_amount_check;
ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_fee_amount_check
    CHECK (fee_amount >= 0);

DO $$
BEGIN
  -- Only control accounts that carry party detail and have posted party rows.
  WITH parties AS (
    SELECT
      e.account_id,
      e.party_id,
      MAX(COALESCE(NULLIF(e.party_name, ''), e.party_id)) AS party_name
    FROM gl_subledger_entries e
    JOIN gl_accounts a ON a.id = e.account_id
    WHERE a.is_control = TRUE
      AND a.subledger_type IN ('CUSTOMER', 'SUPPLIER', 'EMPLOYEE')
      AND e.party_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM gl_subledgers s
        WHERE s.main_account_id = e.account_id
          AND s.party_id = e.party_id
      )
    GROUP BY e.account_id, e.party_id
  )
  INSERT INTO gl_subledgers (
    id, code, name, subledger_type, main_account_id, party_id, description,
    is_active, is_demo
  )
  SELECT
    'gls-bf-' || left(md5(p.account_id || ':' || p.party_id), 32),
    'SL-BF-' || left(md5(p.account_id || ':' || p.party_id), 20),
    left(p.party_name, 150),
    a.subledger_type,
    p.account_id,
    p.party_id,
    'Backfilled from posted subledger rows during the ACC-7 upgrade.',
    TRUE,
    FALSE
  FROM parties p
  JOIN gl_accounts a ON a.id = p.account_id
  ON CONFLICT DO NOTHING;

  -- Existing periods get exactly the tasks ensureCloseChecklist would create.
  INSERT INTO gl_close_checklist_items (
    id, period_id, task_code, title, required, sort_order
  )
  SELECT
    'glci-' || md5(p.id || ':' || t.code),
    p.id,
    t.code,
    t.title,
    t.required,
    t.sort_order
  FROM gl_periods p
  CROSS JOIN gl_close_task_templates t
  WHERE t.active = TRUE
  ON CONFLICT (period_id, task_code) DO NOTHING;
END $$;
