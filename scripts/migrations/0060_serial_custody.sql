-- 0060 — serial-level custody: a device held by a person, then installed at a
-- customer.
--
-- 0059 made quantities follow the person. A CPE, however, is a physical unit
-- with an identity, and until now the register could only say IN_STOCK or
-- CONSUMED: issuing a serialised device to a technician left it "in stock at the
-- branch" (or, after the issue, falsely "consumed"), so the serial register, the
-- van stock and the customer's installed-device record could not agree.
--
-- The register now names the person holding a unit (`holder_employee_id`) and
-- gains the two states that flow needs:
--
--   IN_CUSTODY — issued to a technician, not yet installed, returned or lost
--   LOST       — written off from that person's custody (never coming back)
--
-- The lifecycle, stated once:
--   IN_STOCK → IN_CUSTODY → CUSTOMER_ASSIGNED   (issued, then installed)
--   IN_CUSTODY → IN_STOCK                       (returned to the branch)
--   IN_CUSTODY → CONSUMED                       (consumed with no customer)
--   IN_CUSTODY → LOST                           (written off)
--
-- `employee_stock_movement_serials` records which serials each custody movement
-- actually moved, so a movement's quantity can be checked against its physical
-- units instead of trusted.
--
-- Idempotent: safe to re-run. Historical rows keep their state; none of them can
-- be given a holder without inventing custody that never happened.

ALTER TABLE serial_log ADD COLUMN IF NOT EXISTS holder_employee_id VARCHAR(50);

-- serial_log references employees, which a fresh install creates later in
-- scripts/schema.sql; the guarded block there adds the same constraint, and this
-- migration adds it to databases that already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'serial_log_holder_employee_id_fkey'
  ) THEN
    ALTER TABLE serial_log
      ADD CONSTRAINT serial_log_holder_employee_id_fkey
      FOREIGN KEY (holder_employee_id) REFERENCES employees(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_serial_log_holder
  ON serial_log (holder_employee_id)
  WHERE holder_employee_id IS NOT NULL;

ALTER TABLE serial_log DROP CONSTRAINT IF EXISTS serial_log_status_known;
ALTER TABLE serial_log DROP CONSTRAINT IF EXISTS serial_log_status_check;
ALTER TABLE serial_log ADD CONSTRAINT serial_log_status_check
  CHECK (status IN (
    'IN_STOCK', 'IN_TRANSIT', 'CUSTOMER_ASSIGNED', 'POP_LOCATION_ASSIGNED',
    'DAMAGED', 'RETURNED', 'SOLD', 'RETURNED_TO_VENDOR', 'CONSUMED',
    'IN_CUSTODY', 'LOST'
  ));

CREATE TABLE IF NOT EXISTS employee_stock_movement_serials (
  movement_id BIGINT NOT NULL REFERENCES employee_stock_movements(id) ON DELETE CASCADE,
  device_serial VARCHAR(100) NOT NULL,
  product_id VARCHAR(50) NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  PRIMARY KEY (movement_id, device_serial)
);

CREATE INDEX IF NOT EXISTS idx_employee_stock_movement_serials_serial
  ON employee_stock_movement_serials (lower(device_serial));
