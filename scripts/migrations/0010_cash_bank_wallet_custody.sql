-- ACC-2: cash, bank and wallet custody.
--
-- A till belongs to one branch; a bank or provider clearing account may be
-- shared (NULL owner) or branch-owned. The account kind gains WALLET so PSP
-- clearing is not disguised as a bank account, and provider metadata names the
-- external account that the clearing ledger represents.
--
-- Existing CASH/BANK rows keep a NULL owner: they were shared company accounts
-- before this migration, and silently assigning them to one branch would move
-- another branch's historical cash into that branch. An operator can set an
-- owner in the ledger master after reviewing the custody model.
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS branch_id VARCHAR(50);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS provider_code VARCHAR(30);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS merchant_id VARCHAR(100);
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS settlement_account_id VARCHAR(50);

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_account_kind_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_account_kind_check
    CHECK (account_kind IN ('CASH', 'BANK', 'WALLET', 'OTHER'));

ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_provider_code_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_provider_code_check
    CHECK (provider_code IS NULL OR provider_code IN ('ESEWA', 'KHALTI', 'NEPAL_PAY'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gl_accounts_branch_id_fkey'
      AND conrelid = 'gl_accounts'::regclass
  ) THEN
    ALTER TABLE gl_accounts
      ADD CONSTRAINT gl_accounts_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gl_accounts_settlement_account_id_fkey'
      AND conrelid = 'gl_accounts'::regclass
  ) THEN
    ALTER TABLE gl_accounts
      ADD CONSTRAINT gl_accounts_settlement_account_id_fkey
      FOREIGN KEY (settlement_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gl_accounts_branch ON gl_accounts(branch_id);
CREATE INDEX IF NOT EXISTS idx_gl_accounts_provider ON gl_accounts(provider_code)
  WHERE provider_code IS NOT NULL;
