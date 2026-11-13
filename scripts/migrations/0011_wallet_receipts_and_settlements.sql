-- ACC-3: wallet receipts, provider settlements and PSP reconciliation.
--
-- A wallet receipt is recorded at gross against the provider clearing ledger;
-- the provider's fee is recognised only when the net bank deposit is settled.
-- payment_settlements stores one allocation per settlement, so a receipt can
-- settle partially without inventing a second receivable.
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS provider_code VARCHAR(30);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(200);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14, 2);

-- Historical rows predate provider settlement; their full receipt is already
-- the gross and no fee had been recognised.
UPDATE customer_payments
SET gross_amount = amount,
    fee_amount = 0,
    net_amount = amount
WHERE gross_amount IS NULL;

ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_status_check;
ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_status_check
    CHECK (status IN ('POSTED', 'REVERSED', 'VOIDED', 'REFUNDED', 'CHARGEBACK'));

ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_provider_code_check;
ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_provider_code_check
    CHECK (provider_code IS NULL OR provider_code IN ('ESEWA', 'KHALTI', 'NEPAL_PAY'));

ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_provider_amounts_check;
ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_provider_amounts_check CHECK (
    (gross_amount IS NULL AND net_amount IS NULL)
    OR (
        gross_amount > 0
        AND net_amount > 0
        AND fee_amount >= 0
        AND fee_amount <= gross_amount
        AND net_amount = gross_amount - fee_amount
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_payments_provider_transaction
    ON customer_payments(provider_code, provider_transaction_id)
    WHERE provider_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_settlements (
    id VARCHAR(60) PRIMARY KEY,
    settlement_number VARCHAR(100) UNIQUE NOT NULL,
    customer_payment_id VARCHAR(50) NOT NULL REFERENCES customer_payments(id) ON DELETE RESTRICT,
    wallet_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    bank_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    settlement_date_ad DATE NOT NULL,
    settlement_date_bs VARCHAR(20) NOT NULL,
    gross_amount NUMERIC(14, 2) NOT NULL CHECK (gross_amount > 0),
    fee_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    net_amount NUMERIC(14, 2) NOT NULL CHECK (net_amount > 0),
    provider_reference VARCHAR(200),
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
    reversal_journal_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE RESTRICT,
    reversed_at TIMESTAMP WITH TIME ZONE,
    reversed_by VARCHAR(150),
    reversal_reason TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT payment_settlements_net_check CHECK (net_amount = gross_amount - fee_amount)
);

CREATE INDEX IF NOT EXISTS idx_payment_settlements_payment
    ON payment_settlements(customer_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_settlements_wallet_date
    ON payment_settlements(wallet_account_id, settlement_date_ad);
CREATE INDEX IF NOT EXISTS idx_payment_settlements_bank_date
    ON payment_settlements(bank_account_id, settlement_date_ad);

-- Provider statement rows reuse the existing statement store and parser; they
-- match the settlement row they paid instead of a bank journal line.
ALTER TABLE bank_statement_lines
    ADD COLUMN IF NOT EXISTS matched_settlement_id VARCHAR(60) REFERENCES payment_settlements(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_statement_lines_settlement
    ON bank_statement_lines(matched_settlement_id)
    WHERE matched_settlement_id IS NOT NULL;

-- The settlement journal debits the provider fee to a dedicated expense ledger.
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_posting_role_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_posting_role_check CHECK (posting_role IN (
    'AR_CONTROL', 'AP_CONTROL', 'CASH', 'BANK', 'INVENTORY', 'SALES', 'COGS',
    'TAX_OUTPUT', 'TAX_INPUT', 'RETAINED_EARNINGS', 'SALARY_PAYABLE', 'INTER_BRANCH_CLEARING',
    'STOCK_EXPENSE', 'CPE_ASSET', 'DUE_FROM_HO', 'DUE_TO_HO',
    'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'DEPRECIATION_EXPENSE',
    'GAIN_ON_DISPOSAL', 'LOSS_ON_DISPOSAL',
    'SALARY_EXPENSE', 'TDS_PAYABLE', 'SSF_PAYABLE', 'EMPLOYEE_ADVANCE', 'EMPLOYEE_LOAN',
    'PAYMENT_FEE_EXPENSE'
));
