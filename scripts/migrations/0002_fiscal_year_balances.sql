-- Phase 1: immutable year-end close snapshots.
-- The baseline also declares this table; a booted database picks it up here.
CREATE TABLE IF NOT EXISTS fiscal_year_balances (
    fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    account_code VARCHAR(30) NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL,
    pre_close_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    pre_close_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    pre_close_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    close_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    close_credit NUMERIC(16, 2) NOT NULL DEFAULT 0,
    post_close_balance NUMERIC(16, 2) NOT NULL DEFAULT 0,
    closed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (fiscal_year_id, branch_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_year_balances_account
    ON fiscal_year_balances(fiscal_year_id, account_code, branch_id);

CREATE OR REPLACE FUNCTION reject_fiscal_year_balance_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = format(
      'fiscal_year_balances is immutable: a closed year cannot be changed with %s.',
      TG_OP
    ),
    HINT = 'Reopen the year, correct the ledger with a linked reversal journal, and close it again.';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_fiscal_year_balances_immutable
  BEFORE UPDATE OR DELETE ON fiscal_year_balances
  FOR EACH ROW EXECUTE FUNCTION reject_fiscal_year_balance_mutation();
