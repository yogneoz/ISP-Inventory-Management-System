-- NUM-1: retire document numbers permanently once a document is cancelled or
-- deleted, so an operator/import override can never reuse one. Also removes the
-- obsolete manual PV/RV series now that cash payments/receipts use CP/CR.
CREATE TABLE IF NOT EXISTS document_number_retirements (
    doc_type VARCHAR(20) NOT NULL,
    number VARCHAR(100) NOT NULL,
    branch_id VARCHAR(50),
    document_id VARCHAR(100),
    reason VARCHAR(300),
    retired_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (doc_type, number)
);

CREATE INDEX IF NOT EXISTS idx_document_number_retirements_branch
    ON document_number_retirements(branch_id);

DELETE FROM document_number_configs WHERE id IN ('PV', 'RV');
