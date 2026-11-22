-- 0051 — dual-date pairing for the tables 0050 introduced.
--
-- The finance guard (`tests/financeBsDateWriteGuard.test.ts`) requires every
-- stored AD business date to carry its BS half, and schema.sql must stay
-- identical to the migration chain. 0050 created four date columns without the
-- pair; this adds them additively so both an upgraded and a fresh database end
-- in the same shape.
--
-- Idempotent: safe to re-run.

ALTER TABLE service_invoices
  ADD COLUMN IF NOT EXISTS invoice_date_bs VARCHAR(20);

ALTER TABLE employee_shift_roster
  ADD COLUMN IF NOT EXISTS shift_date_bs VARCHAR(20);

ALTER TABLE hr_delegations
  ADD COLUMN IF NOT EXISTS start_date_bs VARCHAR(20);

ALTER TABLE hr_delegations
  ADD COLUMN IF NOT EXISTS end_date_bs VARCHAR(20);
