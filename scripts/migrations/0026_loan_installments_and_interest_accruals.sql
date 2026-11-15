-- LEND-1 follow-up: installment schedule, due-date tracking and lender interest accrual.
--
-- The loan agreement remains the terms record. These rows make the schedule
-- explicit (so a due date is not re-derived differently by every screen) and
-- record accruals posted as interest expense against a lender-interest payable.
-- Repayments allocate their principal/interest/TDS to the earliest open rows.

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS interest_payable_applied NUMERIC(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE loan_transactions
    DROP CONSTRAINT IF EXISTS loan_transactions_interest_payable_applied_check;
ALTER TABLE loan_transactions
    ADD CONSTRAINT loan_transactions_interest_payable_applied_check
    CHECK (interest_payable_applied >= 0 AND interest_payable_applied <= interest_amount + 0.005);

-- A non-control liability separate from lender TDS and the Loan Payable control.
-- Accrued interest is a liability until the repayment clears it.
INSERT INTO gl_accounts (
    id, code, name, group_id, description, is_control, subledger_type,
    posting_role, account_kind, is_active, is_demo
)
SELECT
    'gla-2370', '2370', 'Interest Payable — Lender', g.id,
    'Interest accrued on lender borrowings and not yet paid; cleared by loan repayments.',
    FALSE, 'NONE', NULL, 'OTHER', TRUE, FALSE
FROM gl_account_groups g
WHERE g.code = '2000'
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS loan_installments (
    id VARCHAR(50) PRIMARY KEY,
    loan_id VARCHAR(50) NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    due_date_ad DATE NOT NULL,
    due_date_bs VARCHAR(20) NOT NULL,
    principal_due NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (principal_due >= 0),
    interest_due NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (interest_due >= 0),
    principal_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
    interest_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (interest_paid >= 0),
    tds_paid NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tds_paid >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT loan_installments_due UNIQUE (loan_id, sequence_number),
    CONSTRAINT loan_installments_principal_paid CHECK (principal_paid <= principal_due + 0.005),
    CONSTRAINT loan_installments_interest_paid CHECK (interest_paid <= interest_due + 0.005),
    CONSTRAINT loan_installments_tds_paid CHECK (tds_paid <= interest_due + 0.005)
);

CREATE INDEX IF NOT EXISTS idx_loan_installments_loan_due
    ON loan_installments(loan_id, due_date_ad, sequence_number);

CREATE TABLE IF NOT EXISTS loan_interest_accruals (
    id VARCHAR(50) PRIMARY KEY,
    accrual_number VARCHAR(100) UNIQUE NOT NULL,
    loan_id VARCHAR(50) NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    lender_id VARCHAR(50) NOT NULL REFERENCES lenders(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    from_date_ad DATE NOT NULL,
    from_date_bs VARCHAR(20) NOT NULL,
    to_date_ad DATE NOT NULL,
    to_date_bs VARCHAR(20) NOT NULL,
    principal_base NUMERIC(14, 2) NOT NULL CHECK (principal_base >= 0),
    annual_rate NUMERIC(8, 4) NOT NULL CHECK (annual_rate >= 0),
    days INTEGER NOT NULL CHECK (days > 0),
    interest_amount NUMERIC(14, 2) NOT NULL CHECK (interest_amount > 0),
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE RESTRICT,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT loan_interest_accruals_period CHECK (to_date_ad >= from_date_ad)
);

CREATE INDEX IF NOT EXISTS idx_loan_interest_accruals_loan
    ON loan_interest_accruals(loan_id, to_date_ad, id);
CREATE INDEX IF NOT EXISTS idx_loan_interest_accruals_lender
    ON loan_interest_accruals(lender_id, to_date_ad, id);

-- Existing agreements need a schedule too. A single due row is the safe
-- conservative shape when the old agreement predates schedule generation; the
-- next term edit without repayments regenerates the full schedule.
INSERT INTO loan_installments (
    id, loan_id, sequence_number, due_date_ad, due_date_bs,
    principal_due, interest_due, principal_paid, interest_paid, tds_paid
)
SELECT
    'lin-' || md5(l.id),
    l.id,
    1,
    COALESCE(l.maturity_date_ad, l.start_date_ad),
    COALESCE(l.maturity_date_bs, l.start_date_bs),
    l.principal,
    0,
    0,
    0,
    0
FROM loans l
WHERE NOT EXISTS (SELECT 1 FROM loan_installments li WHERE li.loan_id = l.id);
