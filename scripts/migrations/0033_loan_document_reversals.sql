-- LEND-1 correction path: a posted loan document is append-only, but one
-- recorded in error must still be correctable. The supported correction is a
-- linked contra journal (the same `reverseSourceJournal` path payments and
-- invoices use) plus a REVERSED marker on the document itself, so:
--
--   * the original rows stay visible with their amounts unchanged;
--   * every loan sum (funded, repaid, interest, TDS), the accrual sums and the
--     installment schedule ignore a reversed document;
--   * the lender statement keeps both the original and the contra posting,
--     which is what makes the control tie-out explain the correction.
--
-- A REVERSED row must carry the journal, actor, reason and timestamp that
-- reversed it; a POSTED row must carry none. The check makes half a reversal
-- impossible to store.

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'POSTED';

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS reversed_by VARCHAR(150);

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

ALTER TABLE loan_transactions
    ADD COLUMN IF NOT EXISTS reversal_journal_id VARCHAR(50)
        REFERENCES gl_journals_registry(id) ON DELETE RESTRICT;

ALTER TABLE loan_transactions
    DROP CONSTRAINT IF EXISTS loan_transactions_status_check;
ALTER TABLE loan_transactions
    ADD CONSTRAINT loan_transactions_status_check
    CHECK (status IN ('POSTED', 'REVERSED'));

ALTER TABLE loan_transactions
    DROP CONSTRAINT IF EXISTS loan_transactions_reversal_shape_check;
ALTER TABLE loan_transactions
    ADD CONSTRAINT loan_transactions_reversal_shape_check
    CHECK (
        (status = 'POSTED' AND reversed_at IS NULL AND reversal_journal_id IS NULL AND reversal_reason IS NULL)
        OR (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversal_journal_id IS NOT NULL AND reversal_reason IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_loan_transactions_status
    ON loan_transactions(loan_id, status, txn_date_ad);

ALTER TABLE loan_interest_accruals
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'POSTED';

ALTER TABLE loan_interest_accruals
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE loan_interest_accruals
    ADD COLUMN IF NOT EXISTS reversed_by VARCHAR(150);

ALTER TABLE loan_interest_accruals
    ADD COLUMN IF NOT EXISTS reversal_reason TEXT;

ALTER TABLE loan_interest_accruals
    ADD COLUMN IF NOT EXISTS reversal_journal_id VARCHAR(50)
        REFERENCES gl_journals_registry(id) ON DELETE RESTRICT;

ALTER TABLE loan_interest_accruals
    DROP CONSTRAINT IF EXISTS loan_interest_accruals_status_check;
ALTER TABLE loan_interest_accruals
    ADD CONSTRAINT loan_interest_accruals_status_check
    CHECK (status IN ('POSTED', 'REVERSED'));

ALTER TABLE loan_interest_accruals
    DROP CONSTRAINT IF EXISTS loan_interest_accruals_reversal_shape_check;
ALTER TABLE loan_interest_accruals
    ADD CONSTRAINT loan_interest_accruals_reversal_shape_check
    CHECK (
        (status = 'POSTED' AND reversed_at IS NULL AND reversal_journal_id IS NULL AND reversal_reason IS NULL)
        OR (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversal_journal_id IS NOT NULL AND reversal_reason IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_loan_interest_accruals_status
    ON loan_interest_accruals(loan_id, status, to_date_ad);
