-- 0056 — custody moves person to person (the TRANSFER vocabulary the CHECK
-- already reserved but no endpoint ever wrote).
--
-- A transfer is two appends in one transaction: TRANSFER_OUT subtracts from the
-- giver's projection and TRANSFER_IN adds to the receiver's, both naming the
-- other person and the group that pairs them. The quantity never passes through
-- `inventory_stock`: the units were already out of branch stock when they were
-- issued, so a transfer between two technicians of one branch does not touch
-- the shelf. Crossing branches is refused by the service rather than modelled
-- here — see `transferEmployeeStock` for the stated rule.
--
-- Idempotent: safe to re-run.

ALTER TABLE employee_stock_movements
  DROP CONSTRAINT IF EXISTS employee_stock_movements_movement_type_check;

ALTER TABLE employee_stock_movements
  ADD CONSTRAINT employee_stock_movements_movement_type_check
  CHECK (movement_type IN ('ISSUE', 'RETURN', 'CONSUME', 'TRANSFER', 'TRANSFER_OUT', 'TRANSFER_IN', 'LOSS'));

ALTER TABLE employee_stock_movements
  ADD COLUMN IF NOT EXISTS counterparty_employee_id VARCHAR(50) REFERENCES employees(id) ON DELETE RESTRICT;

ALTER TABLE employee_stock_movements
  ADD COLUMN IF NOT EXISTS transfer_group_id UUID;

-- A transfer row is meaningless without the other person and the pair it
-- belongs to, and a non-transfer row must not carry either: the projection
-- reads every row as a signed quantity, so a half-written transfer would move
-- units to nobody.
ALTER TABLE employee_stock_movements
  DROP CONSTRAINT IF EXISTS employee_stock_transfer_shape;

ALTER TABLE employee_stock_movements
  ADD CONSTRAINT employee_stock_transfer_shape CHECK (
    (movement_type NOT IN ('TRANSFER_OUT', 'TRANSFER_IN')
      AND counterparty_employee_id IS NULL AND transfer_group_id IS NULL)
    OR (movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN')
      AND counterparty_employee_id IS NOT NULL AND transfer_group_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_employee_stock_movements_transfer
  ON employee_stock_movements (transfer_group_id)
  WHERE transfer_group_id IS NOT NULL;
