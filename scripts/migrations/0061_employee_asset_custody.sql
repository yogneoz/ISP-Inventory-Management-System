-- 0061 — a fixed asset can be dispatched to an employee for a job.
--
-- `fixed_assets` already knew an employee held an asset (`assigned_employee_id`,
-- 0038's HR lifecycle issue), but not *why*: the unit went to a technician with
-- no job, so the technician's "my stock" could not say which customer the unit
-- was for and the install could not be proved against the visit that delivered
-- it. This column carries the work order (and therefore the customer) the unit
-- was dispatched for. It is deliberately nullable: an asset issued through an
-- onboarding checklist belongs to a person, not to a visit.
--
-- `approval_requests` gains the one type a holder may raise against their own
-- custody: a loss report. The write-off itself stays with a manager
-- (`custody-writeoff`), so a technician can report a broken ONU without being
-- able to clear it from the ledger.
--
-- Idempotent: safe to re-run.

ALTER TABLE fixed_assets
  ADD COLUMN IF NOT EXISTS assigned_work_order_id VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_assigned_work_order
  ON fixed_assets (assigned_work_order_id)
  WHERE assigned_work_order_id IS NOT NULL;

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_type_check;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_type_check
  CHECK (type IN (
    'CUSTOMER_DEVICE_STATUS', 'CANCEL_TRANSFER', 'CANCEL_IN_TRANSIT_TRANSFER',
    'CANCEL_RECEIVE_TRANSFER', 'STOCK_AUDIT_RECONCILIATION', 'BULK_STOCK_ADJUSTMENT',
    'CUSTODY_LOSS'
  ));
