-- 0057 — dispatch override, recorded rather than implied.
--
-- Normal job dispatch refuses two cases: a technician with no roster seat on the
-- visit's date, and a technician already holding the day's open-job ceiling. An
-- emergency callout has to beat both sometimes, so a supervisor may override
-- either rule — but only by naming the reason, and the row keeps who waived what
-- and when. Branch membership and "the technician exists" are never overridable;
-- the service checks those before an override is even considered.
--
-- Idempotent: safe to re-run.

ALTER TABLE field_work_orders
  ADD COLUMN IF NOT EXISTS dispatch_override_reason VARCHAR(500);

ALTER TABLE field_work_orders
  ADD COLUMN IF NOT EXISTS dispatch_override_by VARCHAR(200);

ALTER TABLE field_work_orders
  ADD COLUMN IF NOT EXISTS dispatch_override_at TIMESTAMPTZ;

-- Which rules the override waived (`NO_ROSTER_SEAT`, `DAILY_JOB_CAP`), so the
-- review does not have to infer it from the reason text.
ALTER TABLE field_work_orders
  ADD COLUMN IF NOT EXISTS dispatch_override_rules TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE field_work_orders
  DROP CONSTRAINT IF EXISTS field_work_orders_override_shape;

ALTER TABLE field_work_orders
  ADD CONSTRAINT field_work_orders_override_shape CHECK (
    (dispatch_override_reason IS NULL AND dispatch_override_by IS NULL
      AND dispatch_override_at IS NULL AND cardinality(dispatch_override_rules) = 0)
    OR (dispatch_override_reason IS NOT NULL AND dispatch_override_by IS NOT NULL
      AND dispatch_override_at IS NOT NULL AND cardinality(dispatch_override_rules) > 0)
  );

-- The dispatch rules count a technician's open jobs for one day.
CREATE INDEX IF NOT EXISTS idx_field_work_orders_technician_day
  ON field_work_orders (technician_id, scheduled_date_ad)
  WHERE technician_id IS NOT NULL;
