-- 0058 — the accounting outbox the mobile claim response already named.
--
-- `POST /api/v1/workplace/claims` has always answered `accountingOutboxStatus`,
-- and nothing was ever queued: an approved reimbursement had no ledger entry and
-- no record that one was owed. This table is that record, with a status a screen
-- can show and a flusher can advance:
--
--   PENDING_APPROVAL -> a claim was submitted; nothing may post yet
--   QUEUED           -> a supervisor approved it; the posting is owed
--   POSTED           -> the flusher posted the journal (`journal_id`, `journal_no`)
--   FAILED           -> the attempt raised (`last_error`, `attempts`); retried
--   CANCELLED        -> the claim was rejected or withdrawn
--
-- The unique `(source_type, source_id)` is the idempotency guarantee: a claim
-- can never owe two postings, and a flusher crash after the journal commits but
-- before the outbox row updates is resolved by the journal's own
-- `source_type`/`source_id` probe on the next run.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS accounting_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(40) NOT NULL CHECK (source_type IN ('EXPENSE_CLAIM')),
  source_id VARCHAR(60) NOT NULL,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status IN ('PENDING_APPROVAL', 'QUEUED', 'POSTED', 'FAILED', 'CANCELLED')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'NPR',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error VARCHAR(500),
  journal_id VARCHAR(50),
  journal_no VARCHAR(40),
  queued_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_outbox_posted_state CHECK (
    (status = 'POSTED') = (posted_at IS NOT NULL AND journal_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_outbox_source
  ON accounting_outbox (source_type, source_id);

-- The flusher scans only work that is owed, oldest first.
CREATE INDEX IF NOT EXISTS idx_accounting_outbox_queued
  ON accounting_outbox (queued_at)
  WHERE status IN ('QUEUED', 'FAILED');
