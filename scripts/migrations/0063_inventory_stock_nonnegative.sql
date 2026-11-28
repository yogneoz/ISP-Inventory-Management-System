-- H6 (audit 2026-11-28): the database refuses a negative balance.
--
-- Every WRITE path already guards itself — the sale, purchase, stock-operation
-- and partner-consumption statements all carry `WHERE quantity_on_hand >= qty`
-- and abort when the UPDATE matches no row. Nothing guarded the TABLE: a manual
-- `UPDATE`, a restore, a future writer, or a bug in one of those guards could
-- still leave `-1` on the shelf, and once it is there every downstream total is
-- wrong (and the audit trail has no way to say when it happened).
--
-- NOT VALID on purpose: adding a validated CHECK would scan (and refuse) on an
-- installation that already has a negative row, turning an upgrade into an
-- outage. NOT VALID still enforces the rule on every INSERT and UPDATE from the
-- moment it is created. The VALIDATE below promotes it to a full constraint
-- when the existing data agrees, so a healthy database ends up identical to a
-- fresh install (`scripts/schema.sql` declares the same constraint and runs the
-- same two blocks).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inventory_stock_qoh_nonnegative'
       AND conrelid = 'inventory_stock'::regclass
  ) THEN
    ALTER TABLE inventory_stock
      ADD CONSTRAINT inventory_stock_qoh_nonnegative CHECK (quantity_on_hand >= 0) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE inventory_stock VALIDATE CONSTRAINT inventory_stock_qoh_nonnegative;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'inventory_stock_qoh_nonnegative stays NOT VALID: existing rows hold a negative quantity_on_hand. Correct them, then re-run this VALIDATE.';
END $$;
