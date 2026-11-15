-- REC-2: one customer receipt can settle several invoices.
--
-- `customer_payments.invoice_id` was the compatibility path for a single
-- invoice. The allocation table is the authority for how much of a receipt
-- settled each invoice; the header stays the cash document. Existing receipts
-- with one invoice are backfilled once, with reversed receipts marked as
-- reversed so a later receipt reversal cannot restore an invoice twice.

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
    id VARCHAR(60) PRIMARY KEY,
    payment_id VARCHAR(50) NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
    invoice_id VARCHAR(50) NOT NULL REFERENCES sales_invoices(id) ON DELETE RESTRICT,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
    reversed_at TIMESTAMP WITH TIME ZONE,
    reversed_by VARCHAR(150),
    reversal_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_payment_allocations_payment
    ON customer_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_customer_payment_allocations_invoice
    ON customer_payment_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_payment_allocations_status
    ON customer_payment_allocations(status);

INSERT INTO customer_payment_allocations (
    id, payment_id, invoice_id, amount, status, reversed_at, reversed_by, reversal_reason
)
SELECT
    'cpa-bf-' || left(md5(cp.id || ':' || cp.invoice_id), 32),
    cp.id,
    cp.invoice_id,
    cp.amount,
    CASE WHEN cp.status = 'POSTED' THEN 'POSTED' ELSE 'REVERSED' END,
    CASE WHEN cp.status = 'POSTED' THEN NULL ELSE cp.reversed_at_ad END,
    CASE WHEN cp.status = 'POSTED' THEN NULL ELSE cp.reversed_by END,
    CASE WHEN cp.status = 'POSTED' THEN NULL ELSE cp.reversal_reason END
FROM customer_payments cp
WHERE cp.invoice_id IS NOT NULL
  AND cp.amount > 0
ON CONFLICT (payment_id, invoice_id) DO NOTHING;