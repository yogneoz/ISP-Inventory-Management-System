-- 0059 — a person-directed stock operation writes the custody ledger.
--
-- The Issue Consumables form deducted branch stock and recorded a free-text
-- technician name on `stock_operations`, so the units left the shelf without
-- ever entering anyone's custody: My Stock, the phone's van stock and the
-- offboarding check all disagreed with the stock book. The operation now names
-- the employee and the custody group its movements share, and the movements
-- carry the same group, so a reversal can return exactly what this document
-- issued instead of crediting the shelf a second time.
--
-- Both columns are nullable: historical rows keep their meaning, because none of
-- them can be mapped to a person without inventing custody that never happened.
-- No table is added. Idempotent: safe to re-run.

ALTER TABLE stock_operations
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50) REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE stock_operations
  ADD COLUMN IF NOT EXISTS custody_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_stock_operations_employee
  ON stock_operations (employee_id)
  WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_operations_custody_group
  ON stock_operations (custody_group_id)
  WHERE custody_group_id IS NOT NULL;

ALTER TABLE employee_stock_movements
  ADD COLUMN IF NOT EXISTS custody_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_employee_stock_movements_custody_group
  ON employee_stock_movements (custody_group_id)
  WHERE custody_group_id IS NOT NULL;
