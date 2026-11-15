-- TDS applicability is a loan term, not a UI hint.
--
-- Existing loans remain TDS-applicable, so this migration is backward
-- compatible. A non-applicable loan carries a fixed exemption reason and the
-- evidence relied on. Every repayment snapshots the reason/reference actually
-- used, because the loan may be corrected later and the register must still
-- explain the original posting.

ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS tds_applicable BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS tds_exemption_reason VARCHAR(30);

ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS tds_exemption_reference TEXT;

ALTER TABLE loans
    DROP CONSTRAINT IF EXISTS loans_tds_exemption_reason_check;
ALTER TABLE loans
    ADD CONSTRAINT loans_tds_exemption_reason_check
    CHECK (
        tds_exemption_reason IS NULL
        OR tds_exemption_reason IN (
            'RESIDENT_BANK',
            'RESIDENT_FI',
            'INTER_COOP',
            'NO_INTEREST',
            'TREATY',
            'EXEMPT_INCOME',
            'OTHER'
        )
    );

ALTER TABLE loans
    DROP CONSTRAINT IF EXISTS loans_tds_applicable_reason_check;
ALTER TABLE loans
    ADD CONSTRAINT loans_tds_applicable_reason_check
    CHECK (
        (tds_applicable AND tds_exemption_reason IS NULL AND tds_exemption_reference IS NULL)
        OR (NOT tds_applicable AND tds_exemption_reason IS NOT NULL)
    );

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS tds_exemption_reason VARCHAR(30);

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS tds_exemption_reference TEXT;

ALTER TABLE loan_transactions
    DROP CONSTRAINT IF EXISTS loan_transactions_tds_exemption_reason_check;
ALTER TABLE loan_transactions
    ADD CONSTRAINT loan_transactions_tds_exemption_reason_check
    CHECK (
        tds_exemption_reason IS NULL
        OR tds_exemption_reason IN (
            'RESIDENT_BANK',
            'RESIDENT_FI',
            'INTER_COOP',
            'NO_INTEREST',
            'TREATY',
            'EXEMPT_INCOME',
            'OTHER'
        )
    );

-- A withheld repayment cannot also claim an exemption. Legacy zero-TDS rows
-- remain readable; the application guard applies to new postings.
ALTER TABLE loan_transactions
    DROP CONSTRAINT IF EXISTS loan_transactions_tds_withheld_reason_check;
ALTER TABLE loan_transactions
    ADD CONSTRAINT loan_transactions_tds_withheld_reason_check
    CHECK (tds_amount = 0 OR tds_exemption_reason IS NULL);
