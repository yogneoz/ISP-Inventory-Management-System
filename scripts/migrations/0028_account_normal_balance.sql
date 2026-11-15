-- Classic double-entry posting needs each account's own permanent side.
--
-- Until now the only balance hint in the chart was `gl_account_groups.
-- normal_balance`, a DEBIT/CREDIT reporting label. That is not enough to post:
-- accumulated depreciation and sales returns are contra accounts whose side
-- differs from the group they report under, so a group label cannot say which
-- way an account increases.
--
-- `gl_accounts.normal_balance` (D = debit-normal, C = credit-normal) becomes the
-- single authority the posting engine reads. It is permanent data: once set,
-- nothing derives it again at post time.
--
-- The backfill is deliberately one-shot: the column is added nullable, filled
-- only where it is still NULL, then made mandatory. Re-running this migration
-- (or re-applying schema.sql at boot) never overwrites a side the operator has
-- since corrected.
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS normal_balance CHAR(1);

UPDATE gl_accounts a
SET normal_balance = CASE
    -- Credit-normal posting purposes. Sales returns are the contra-income
    -- exception: they report inside revenue but increase with a debit.
    WHEN a.posting_role IN (
        'AP_CONTROL', 'SALES', 'TAX_OUTPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE',
        'DUE_TO_HO', 'ACCUMULATED_DEPRECIATION', 'GAIN_ON_DISPOSAL', 'TDS_PAYABLE',
        'SSF_PAYABLE', 'LOAN_PAYABLE'
    ) THEN 'C'
    -- Any other mapped role is debit-normal (assets, costs, contra-income).
    WHEN a.posting_role IS NOT NULL THEN 'D'
    -- An unmapped account follows the nature of its group.
    WHEN g.account_type IN ('ASSET', 'EXPENSE') THEN 'D'
    ELSE 'C'
  END
FROM gl_account_groups g
WHERE g.id = a.group_id
  AND a.normal_balance IS NULL;

ALTER TABLE gl_accounts ALTER COLUMN normal_balance SET DEFAULT 'D';
ALTER TABLE gl_accounts ALTER COLUMN normal_balance SET NOT NULL;
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_normal_balance_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_normal_balance_check
    CHECK (normal_balance IN ('D', 'C'));

-- `1525 Accumulated Depreciation` is the seeded contra-asset. Its group is a
-- non-current ASSET group (debit-normal), so the type fallback would have put
-- it on the wrong side; it is credit-normal by nature.
UPDATE gl_accounts SET normal_balance = 'C' WHERE code = '1525' AND normal_balance = 'D';

-- A sales return is not negative sales: it is its own contra-income ledger, so
-- revenue keeps its gross figure and the returns line stays separately
-- auditable on the P&L. `SALES_RETURNS` is the posting role that resolves it.
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_posting_role_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_posting_role_check CHECK (posting_role IN (
    'AR_CONTROL', 'AP_CONTROL', 'CASH', 'BANK', 'INVENTORY', 'SALES', 'COGS',
    'TAX_OUTPUT', 'TAX_INPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE', 'INTER_BRANCH_CLEARING',
    'STOCK_EXPENSE', 'CPE_ASSET', 'DUE_FROM_HO', 'DUE_TO_HO',
    'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'DEPRECIATION_EXPENSE',
    'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL',
    'SALARY_EXPENSE', 'TDS_PAYABLE', 'SSF_PAYABLE', 'EMPLOYEE_ADVANCE', 'EMPLOYEE_LOAN', 'LOAN_PAYABLE',
    'PAYMENT_FEE_EXPENSE', 'SALES_RETURNS'
));

-- The ledger itself is seeded idempotently by ensureDefaultChart on the next
-- boot (code 4090, role SALES_RETURNS). An install that already ran a custom
-- chart keeps its own account and only needs the role assigned in
-- Accounting -> Chart & Defaults.
