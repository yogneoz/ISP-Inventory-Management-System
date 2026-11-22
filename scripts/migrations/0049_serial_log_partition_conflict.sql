-- SCALE-3 repair: a serial row that landed in the DEFAULT catch-all used to
-- lock its month out of the partitioned register for good.
--
-- `ensure_serial_log_month_partition` only ever created the child. Once any row
-- for that month sat in `serial_log_default` — which is exactly what a fresh
-- install has, where DEFAULT is the only child, and what any document written
-- for a month the boot window has not provisioned produces — PostgreSQL refuses
-- the CREATE TABLE ... PARTITION OF:
--
--   ERROR: updated partition constraint for default partition
--   "serial_log_default" would be violated by some row  (SQLSTATE 23514)
--
-- From then on the write path could not provision that month, so every serial
-- correction for an unregistered unit answered 500 and no register row for the
-- month could be posted again.
--
-- The function now treats that conflict as "this month already holds its rows":
-- it skips the child instead of failing the caller. Reads and writes keep
-- working through the catch-all, and the month is provisioned on the next call
-- after it has been emptied. Moving the rows out instead (detach the catch-all,
-- create the child, move, re-attach) was rejected: it deadlocks against
-- concurrent inserts into the register, which is the hot path it would run on.
--
-- This is a CREATE OR REPLACE of the function only; no data moves here.

CREATE OR REPLACE FUNCTION ensure_serial_log_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start TIMESTAMPTZ := (date_trunc('month', p_date)::timestamp) AT TIME ZONE 'UTC';
  v_end TIMESTAMPTZ := ((date_trunc('month', p_date) + INTERVAL '1 month')::timestamp) AT TIME ZONE 'UTC';
  v_name TEXT := 'serial_log_' || to_char(p_date, 'YYYYMM');
BEGIN
  BEGIN
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF serial_log FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  EXCEPTION
    WHEN check_violation THEN
      RETURN;
  END;
END;
$$ LANGUAGE plpgsql;
