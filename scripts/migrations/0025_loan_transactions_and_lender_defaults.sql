-- LEND-1 completion: lender defaults, loan receipts and loan repayments.
--
-- A loan agreement is not money. The receipt credits the lender's LENDER book
-- under Loan Payable, and the repayment debits that book while charging interest
-- and withholding TDS separately. These rows link each document to its posted
-- journal; the ledger remains the source of truth.

ALTER TABLE lenders ADD COLUMN IF NOT EXISTS registration_number VARCHAR(50);
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS default_cash_account_id VARCHAR(50)
    REFERENCES gl_accounts(id) ON DELETE SET NULL;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS default_interest_account_id VARCHAR(50)
    REFERENCES gl_accounts(id) ON DELETE SET NULL;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS default_tds_account_id VARCHAR(50)
    REFERENCES gl_accounts(id) ON DELETE SET NULL;
ALTER TABLE lenders ADD COLUMN IF NOT EXISTS default_loan_account_id VARCHAR(50)
    REFERENCES gl_accounts(id) ON DELETE SET NULL;

-- Stable non-control accounts for lender interest and lender-interest TDS. The
-- existing TDS Payable account is an EMPLOYEE control, so it cannot carry a
-- lender party; this separate liability keeps the withholding traceable without
-- pretending a lender is an employee.
INSERT INTO gl_accounts (
    id, code, name, group_id, description, is_control, subledger_type,
    posting_role, account_kind, is_active, is_demo
)
SELECT
    'gla-2360', '2360', 'TDS Payable — Lender Interest', g.id,
    'Tax withheld from interest paid to a lender; a non-control liability, not the employee TDS book.',
    FALSE, 'NONE', NULL, 'OTHER', TRUE, FALSE
FROM gl_account_groups g
WHERE g.code = '2000'
ON CONFLICT (code) DO NOTHING;

INSERT INTO gl_accounts (
    id, code, name, group_id, description, is_control, subledger_type,
    posting_role, account_kind, is_active, is_demo
)
SELECT
    'gla-6700', '6700', 'Interest Expense — Borrowings', g.id,
    'Interest charged on lender borrowings, including owner and related-party loans.',
    FALSE, 'NONE', NULL, 'OTHER', TRUE, FALSE
FROM gl_account_groups g
WHERE g.code = '6000'
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS loan_transactions (
    id VARCHAR(50) PRIMARY KEY,
    txn_number VARCHAR(100) UNIQUE NOT NULL,
    loan_id VARCHAR(50) NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
    lender_id VARCHAR(50) NOT NULL REFERENCES lenders(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    txn_type VARCHAR(20) NOT NULL CHECK (txn_type IN ('RECEIPT', 'REPAYMENT')),
    txn_date_ad DATE NOT NULL,
    txn_date_bs VARCHAR(20) NOT NULL,
    principal_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (principal_amount >= 0),
    interest_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (interest_amount >= 0),
    tds_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
    cash_amount NUMERIC(14, 2) NOT NULL CHECK (cash_amount > 0),
    cash_account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    interest_account_id VARCHAR(50) REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    tds_account_id VARCHAR(50) REFERENCES gl_accounts(id) ON DELETE RESTRICT,
    cheque_no VARCHAR(100),
    reference_no VARCHAR(100),
    notes TEXT,
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE RESTRICT,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT loan_txn_receipt_shape CHECK (
        (txn_type = 'RECEIPT' AND interest_amount = 0 AND tds_amount = 0 AND cash_amount = principal_amount)
        OR (txn_type = 'REPAYMENT' AND cash_amount = principal_amount + interest_amount - tds_amount)
    )
);

CREATE INDEX IF NOT EXISTS idx_loan_transactions_loan
    ON loan_transactions(loan_id, txn_date_ad, id);
CREATE INDEX IF NOT EXISTS idx_loan_transactions_lender
    ON loan_transactions(lender_id, txn_type, txn_date_ad);
CREATE INDEX IF NOT EXISTS idx_loan_transactions_branch
    ON loan_transactions(branch_id, txn_date_ad);
