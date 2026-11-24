-- 0052 — MyWorkplace v2, Phase 0 storage.
--
-- A punch is judged, never silently dropped: the proof row now records the
-- verdict the server returned (ACCEPTED / FLAGGED / HELD) and why, so a
-- supervisor can review it instead of the technician losing a day's pay. The
-- integrity status gains HELD (accepted, stored, awaiting a reviewer), which is
-- what an offline punch arriving with a skewed device clock gets.
--
-- A device also becomes an approve/revoke record rather than a name seen on a
-- punch: `approved_at`/`approved_by` say who admitted it, and `revoked_at`
-- (already present) is now enforced at login and at sync.
--
-- Idempotent: safe to re-run.

ALTER TABLE hr_attendance_proofs
  DROP CONSTRAINT IF EXISTS hr_attendance_proofs_integrity_status_check;

ALTER TABLE hr_attendance_proofs
  ADD CONSTRAINT hr_attendance_proofs_integrity_status_check
  CHECK (integrity_status IN ('VERIFIED', 'SUSPECT', 'REJECTED', 'HELD'));

ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS verdict VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED';

ALTER TABLE hr_attendance_proofs
  DROP CONSTRAINT IF EXISTS hr_attendance_proofs_verdict_check;

ALTER TABLE hr_attendance_proofs
  ADD CONSTRAINT hr_attendance_proofs_verdict_check
  CHECK (verdict IN ('ACCEPTED', 'FLAGGED', 'HELD'));

ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS held_reason VARCHAR(200);

-- Device time minus server time, signed. A large gap is what holds a punch.
ALTER TABLE hr_attendance_proofs
  ADD COLUMN IF NOT EXISTS clock_skew_ms BIGINT;

ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE mobile_devices
  ADD COLUMN IF NOT EXISTS approved_by VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_active
  ON mobile_devices (employee_id)
  WHERE revoked_at IS NULL;
