-- LEND-1: lender master, loan register and the party book statement source.
--
-- The lender is not a supplier: owner and related-party borrowing is a Loan
-- Payable liability, tracked in its own LENDER subledger book. These tables add
-- the identity and agreement terms; posted money stays in gl_subledger_entries
-- under the LOAN_PAYABLE control account, so the statement never becomes a
-- second ledger.

CREATE TABLE IF NOT EXISTS lenders (
    id VARCHAR(50) PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    lender_type VARCHAR(20) NOT NULL DEFAULT 'OTHER'
        CHECK (lender_type IN ('OWNER', 'RELATED_PARTY', 'OTHER')),
    pan_number VARCHAR(50),
    phone VARCHAR(50),
    address TEXT,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lenders_active ON lenders(is_active, code);

CREATE TABLE IF NOT EXISTS loans (
    id VARCHAR(50) PRIMARY KEY,
    loan_number VARCHAR(100) UNIQUE NOT NULL,
    lender_id VARCHAR(50) NOT NULL REFERENCES lenders(id) ON DELETE RESTRICT,
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    principal NUMERIC(14, 2) NOT NULL CHECK (principal > 0),
    interest_rate NUMERIC(8, 4) NOT NULL DEFAULT 0 CHECK (interest_rate >= 0),
    start_date_ad DATE NOT NULL,
    start_date_bs VARCHAR(20) NOT NULL,
    maturity_date_ad DATE,
    maturity_date_bs VARCHAR(20),
    repayment_frequency VARCHAR(20) NOT NULL DEFAULT 'LUMP_SUM'
        CHECK (repayment_frequency IN ('LUMP_SUM', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL')),
    installment_amount NUMERIC(14, 2) CHECK (installment_amount IS NULL OR installment_amount >= 0),
    security_type VARCHAR(20) NOT NULL DEFAULT 'UNSECURED'
        CHECK (security_type IN ('UNSECURED', 'SECURED')),
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    agreement_reference VARCHAR(100),
    notes TEXT,
    created_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT loans_maturity_after_start CHECK (
        maturity_date_ad IS NULL OR maturity_date_ad >= start_date_ad
    ),
    CONSTRAINT loans_maturity_bs_pair CHECK (
        (maturity_date_ad IS NULL AND maturity_date_bs IS NULL)
        OR (maturity_date_ad IS NOT NULL AND maturity_date_bs IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_loans_lender ON loans(lender_id, status, start_date_ad);
CREATE INDEX IF NOT EXISTS idx_loans_branch ON loans(branch_id, start_date_ad);
