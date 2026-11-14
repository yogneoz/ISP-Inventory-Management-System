-- ACC-6: business-structure groups above the AR/AP control ledgers.
-- Receivables and payables are groups, not per-customer accounts: the control
-- ledgers stay at 1100 and 2100, now under their trade groups. Existing
-- installs keep any manual reorganisation; only the default rows move.
--
-- A schema-only fresh install has no chart groups yet; this migration leaves it
-- alone so ensureDefaultChart creates the whole hierarchy with its parent ids.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM gl_account_groups WHERE code = '1000')
     AND EXISTS (SELECT 1 FROM gl_account_groups WHERE code = '2000') THEN
    INSERT INTO gl_account_groups (
      id, parent_id, code, name, account_type, statement_group,
      normal_balance, sort_order, is_active, is_demo
    )
    VALUES
      (
        'glg-1110',
        (SELECT id FROM gl_account_groups WHERE code = '1000'),
        '1110', 'Trade Receivables', 'ASSET', 'CURRENT_ASSET', 'DEBIT', 15, TRUE, FALSE
      ),
      (
        'glg-2110',
        (SELECT id FROM gl_account_groups WHERE code = '2000'),
        '2110', 'Trade Payables', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 35, TRUE, FALSE
      )
    ON CONFLICT (code) DO NOTHING;

    -- Move only the seeded control ledgers that are still in their original
    -- root group. A chart the operator has already reorganised is untouched.
    UPDATE gl_accounts a
    SET group_id = 'glg-1110'
    FROM gl_account_groups old
    WHERE a.code = '1100'
      AND a.group_id = old.id
      AND old.code = '1000'
      AND EXISTS (SELECT 1 FROM gl_account_groups g WHERE g.id = 'glg-1110' AND g.code = '1110');

    UPDATE gl_accounts a
    SET group_id = 'glg-2110'
    FROM gl_account_groups old
    WHERE a.code = '2100'
      AND a.group_id = old.id
      AND old.code = '2000'
      AND EXISTS (SELECT 1 FROM gl_account_groups g WHERE g.id = 'glg-2110' AND g.code = '2110');
  END IF;
END $$;
