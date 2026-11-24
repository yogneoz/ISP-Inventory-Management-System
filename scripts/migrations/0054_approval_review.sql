-- 0054 — MyWorkplace v2, Phase 2: a reviewer can settle a flagged or held punch.
--
-- A punch is never deleted or rewritten by the reviewer: the verdict the server
-- computed stays, and `reviewed_at`/`reviewed_by`/`review_note` record that a
-- supervisor looked at it and what they decided. That keeps "the punch exists"
-- and "a person confirmed it" separate facts, which is what payroll needs.
--
-- Idempotent: safe to re-run.

ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(200);

ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(500);

CREATE INDEX IF NOT EXISTS idx_hr_attendance_proofs_needs_review
  ON hr_attendance_proofs (integrity_status)
  WHERE reviewed_at IS NULL AND integrity_status IN ('SUSPECT', 'HELD');

-- The approvals inbox reads a branch's submitted claims oldest first.
CREATE INDEX IF NOT EXISTS idx_hr_expense_claims_branch_pending
  ON hr_expense_claims (branch_id, submitted_at)
  WHERE status = 'SUBMITTED';

-- A delegate's active grants are looked up by the delegate, not the delegator.
CREATE INDEX IF NOT EXISTS idx_hr_delegations_delegate
  ON hr_delegations (delegate_employee_id, end_date_ad DESC);
