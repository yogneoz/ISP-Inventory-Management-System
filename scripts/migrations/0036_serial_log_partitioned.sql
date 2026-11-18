-- Worklist SCALE-3: convert `serial_log` to monthly RANGE partitions, with its
-- three case-insensitive global keys moved into the document identity registry.
--
-- Why: the register is one row per device serial for the life of the unit, read
-- every time a customer device is deployed, exchanged, damaged or returned, and
-- the key always carries the serial, not a date. It grew the same way the
-- operational register did, so it gets the same treatment: monthly children on
-- its document date (`created_at` — the purchase/receive paths write NOW(), the
-- backfill writes the source document's date), retention by DETACH, and a
-- DEFAULT catch-all.
--
-- The obstacle is the opposite of stock_operations': this table has THREE
-- global keys, not one — `uq_serial_log_device_serial`, `uq_serial_log_pon_serial`
-- and `uq_serial_log_mac_address`, all `lower(trim(column))` partial uniques.
-- A partitioned unique index must contain the partition key, so none of them can
-- survive the swap. `enforce_document_identity()` is therefore generalised to
-- carry several keys per document (`key_role` + per-key specs) instead of
-- inventing a second mechanism:
--
--   SERIAL:device_serial:ci:optional
--   PON:pon_serial:ci:optional
--   MAC:mac_address:ci:optional
--
-- `ci` reproduces the `lower(trim(...))` comparison, `optional` reproduces the
-- partial predicate (a blank value is not governed), and the absence of
-- `refuse` keeps the write paths' contract: all three inserts are
-- `INSERT ... ON CONFLICT DO NOTHING` (insert-if-absent, then update the
-- surviving row), so a key already held by another row SKIPS the new row
-- exactly as the old unique index did. A key is never handed to two rows.
--
-- A BEFORE-INSERT trigger cannot raise through `ON CONFLICT DO NOTHING` (the
-- exception aborts the statement instead of being suppressed), which is why the
-- duplicate path is RETURN NULL; `stock_operations` keeps its `refuse` spec for
-- the same reason in reverse — its reference is a real refusal today.
--
-- The register's serial columns are correctable (the serial-correction flow
-- renames them), so the trigger re-claims a changed key and raises 23505 only
-- when another row already holds it — the old unique index's behaviour. The
-- partition date is never movable.
--
-- Upgrade is the shadow table + swap: stage rows and CHECK/FOREIGN KEY/NOT NULL
-- constraints, drop, recreate partitioned, insert back through the parent,
-- register the legacy keys set-wise, then verify row and key counts. Any
-- mismatch raises inside the runner's transaction and leaves the legacy table.

-- ---------------------------------------------------------------------------
-- stock_operations indexes renamed to the names scripts/schema.sql declares
-- (0035 shipped the older names; the upgrade-vs-fresh comparison is what caught
-- the difference, so the fix is a later migration rather than an edit of an
-- applied one).
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_stock_operations_created_at;
DROP INDEX IF EXISTS idx_stock_operations_branch_created_at;
DROP INDEX IF EXISTS idx_stock_operations_destination_created_at;
CREATE INDEX IF NOT EXISTS idx_stock_ops_page_all ON stock_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch_page ON stock_operations (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_destination_page ON stock_operations (destination_warehouse_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Registry: one row per (document, key role)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_identity_registry (
    document_type VARCHAR(40) NOT NULL,
    key_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY',
    id VARCHAR(60) NOT NULL,
    business_key VARCHAR(160) NOT NULL,
    document_date DATE NOT NULL,
    PRIMARY KEY (document_type, key_role, id),
    UNIQUE (document_type, key_role, business_key)
);

-- Existing registries were one key per document; that key is the PRIMARY role.
ALTER TABLE document_identity_registry ADD COLUMN IF NOT EXISTS key_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY';

DO $$
DECLARE
  v_pk TEXT;
  v_unique TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_pk
    FROM pg_constraint
   WHERE conrelid = 'document_identity_registry'::regclass AND contype = 'p';
  IF v_pk IS NULL OR v_pk NOT LIKE '%key_role%' THEN
    ALTER TABLE document_identity_registry DROP CONSTRAINT IF EXISTS document_identity_registry_pkey;
    ALTER TABLE document_identity_registry
      ADD CONSTRAINT document_identity_registry_pkey PRIMARY KEY (document_type, key_role, id);
  END IF;

  SELECT conname INTO v_unique
    FROM pg_constraint
   WHERE conrelid = 'document_identity_registry'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%business_key%'
   LIMIT 1;
  IF v_unique IS NOT NULL AND v_unique <> 'document_identity_registry_document_type_key_role_business_key_key' THEN
    EXECUTE format('ALTER TABLE document_identity_registry DROP CONSTRAINT %I', v_unique);
    v_unique := NULL;
  END IF;
  IF v_unique IS NULL THEN
    ALTER TABLE document_identity_registry
      ADD CONSTRAINT document_identity_registry_document_type_key_role_business_key_key
      UNIQUE (document_type, key_role, business_key);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The registry protocol (multi-key form; see the schema.sql copy for the rules)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_document_identity()
RETURNS trigger AS $$
DECLARE
  v_type TEXT := TG_ARGV[0];
  v_date_col TEXT := TG_ARGV[1];
  v_specs TEXT[] := TG_ARGV[2:array_upper(TG_ARGV, 1)];
  v_parts TEXT[];
  v_role TEXT;
  v_col TEXT;
  v_ci BOOLEAN;
  v_optional BOOLEAN;
  v_fixed BOOLEAN;
  v_refuse BOOLEAN;
  v_new TEXT;
  v_old TEXT;
  v_new_date DATE;
  v_old_date DATE;
  v_existing RECORD;
  v_inserted TEXT[] := '{}';
  i INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM document_identity_registry WHERE document_type = v_type AND id = OLD.id;
    RETURN OLD;
  END IF;

  v_new_date := (to_jsonb(NEW) ->> v_date_col)::date;
  IF TG_OP = 'UPDATE' THEN
    v_old_date := (to_jsonb(OLD) ->> v_date_col)::date;
    IF v_new_date IS DISTINCT FROM v_old_date THEN
      RAISE EXCEPTION 'a % row cannot move to another %: it is the partition key (row %). Reverse it and post a new document instead.', v_type, v_date_col, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR i IN 1 .. COALESCE(array_length(v_specs, 1), 0) LOOP
    v_parts := string_to_array(v_specs[i], ':');
    v_role := v_parts[1];
    v_col := v_parts[2];
    v_ci := 'ci' = ANY (v_parts[3:]);
    v_optional := 'optional' = ANY (v_parts[3:]);
    v_fixed := 'fixed' = ANY (v_parts[3:]);
    v_refuse := 'refuse' = ANY (v_parts[3:]);

    v_new := to_jsonb(NEW) ->> v_col;
    IF v_ci THEN v_new := lower(btrim(v_new)); END IF;
    IF v_optional AND (v_new IS NULL OR v_new = '') THEN v_new := NULL; END IF;

    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD) ->> v_col;
      IF v_ci THEN v_old := lower(btrim(v_old)); END IF;
      IF v_optional AND (v_old IS NULL OR v_old = '') THEN v_old := NULL; END IF;
      IF v_new IS NOT DISTINCT FROM v_old THEN CONTINUE; END IF;
      IF v_fixed THEN
        RAISE EXCEPTION 'a % row cannot change its %: it is the registered business key (row %).', v_type, v_col, NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      DELETE FROM document_identity_registry
       WHERE document_type = v_type AND key_role = v_role AND id = NEW.id;
      IF v_new IS NOT NULL THEN
        INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
        VALUES (v_type, v_role, NEW.id, v_new, v_new_date)
        ON CONFLICT (document_type, key_role, business_key) DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'duplicate key value: another % document already holds % % (row %).', v_type, v_role, v_new, NEW.id
            USING ERRCODE = 'unique_violation';
        END IF;
      END IF;
      CONTINUE;
    END IF;

    IF v_new IS NULL THEN CONTINUE; END IF;

    SELECT business_key, document_date INTO v_existing
      FROM document_identity_registry
     WHERE document_type = v_type AND key_role = v_role AND id = NEW.id;
    IF FOUND THEN
      IF v_existing.business_key IS DISTINCT FROM v_new OR v_existing.document_date IS DISTINCT FROM v_new_date THEN
        IF v_fixed THEN
          RAISE EXCEPTION 'a % row cannot change its % or move to another %: both are registered (row %).', v_type, v_col, v_date_col, NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF array_length(v_inserted, 1) IS NOT NULL THEN
          DELETE FROM document_identity_registry
           WHERE document_type = v_type AND key_role = ANY (v_inserted) AND id = NEW.id;
        END IF;
        RETURN NULL;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
    VALUES (v_type, v_role, NEW.id, v_new, v_new_date)
    ON CONFLICT (document_type, key_role, business_key) DO NOTHING;
    IF NOT FOUND THEN
      IF v_refuse THEN
        RAISE EXCEPTION 'duplicate key value: another % document already holds % % (row %).', v_type, v_role, v_new, NEW.id
          USING ERRCODE = 'unique_violation';
      END IF;
      IF array_length(v_inserted, 1) IS NOT NULL THEN
        DELETE FROM document_identity_registry
         WHERE document_type = v_type AND key_role = ANY (v_inserted) AND id = NEW.id;
      END IF;
      RETURN NULL;
    END IF;
    v_inserted := v_inserted || v_role;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- stock_operations keeps its refusal: a reused reference is an error, not a
-- skipped row.
CREATE OR REPLACE TRIGGER trg_stock_operations_identity
  BEFORE INSERT OR UPDATE OR DELETE ON stock_operations
  FOR EACH ROW EXECUTE FUNCTION enforce_document_identity('STOCK_OPERATION', 'date_ad', 'PRIMARY:reference_number:fixed:refuse');

CREATE OR REPLACE FUNCTION ensure_serial_log_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start TIMESTAMPTZ := (date_trunc('month', p_date)::timestamp) AT TIME ZONE 'UTC';
  v_end TIMESTAMPTZ := ((date_trunc('month', p_date) + INTERVAL '1 month')::timestamp) AT TIME ZONE 'UTC';
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF serial_log FOR VALUES FROM (%L) TO (%L)',
    'serial_log_' || to_char(p_date, 'YYYYMM'), v_start, v_end
  );
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Conversion of the populated plain table
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_kind "char";
  v_month DATE;
  v_legacy BIGINT;
  v_new BIGINT;
  v_serial BIGINT;
  v_pon BIGINT;
  v_mac BIGINT;
  v_reg_serial BIGINT;
  v_reg_pon BIGINT;
  v_reg_mac BIGINT;
  v_row RECORD;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'serial_log';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN; -- already partitioned (or absent: schema.sql owns the fresh shape)
  END IF;

  IF EXISTS (SELECT 1 FROM serial_log WHERE created_at IS NULL) THEN
    RAISE EXCEPTION 'serial_log holds rows without created_at; the partition date cannot be NULL, so the conversion aborts instead of routing them to DEFAULT';
  END IF;

  CREATE TEMP TABLE scale3_serial_stage ON COMMIT DROP AS SELECT * FROM serial_log;

  CREATE TEMP TABLE scale3_serial_cons ON COMMIT DROP AS
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'serial_log'::regclass
       AND contype IN ('c', 'f', 'n');

  DROP TABLE serial_log;

  CREATE TABLE serial_log (
    id VARCHAR(50),
    device_serial VARCHAR(100),
    pon_serial VARCHAR(100),
    mac_address VARCHAR(100),
    product_id VARCHAR(50),
    product_name VARCHAR(255),
    branch_id VARCHAR(50),
    customer_id VARCHAR(50),
    customer_name VARCHAR(200),
    status VARCHAR(30),
    source_type VARCHAR(30),
    source_id VARCHAR(50),
    history_json TEXT DEFAULT '[]',
    fiscal_year_id VARCHAR(50),
    is_demo BOOLEAN DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  ) PARTITION BY RANGE (created_at);

  FOR v_row IN SELECT conname, def FROM scale3_serial_cons ORDER BY contype, conname LOOP
    EXECUTE format('ALTER TABLE serial_log ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  ALTER TABLE serial_log ALTER COLUMN created_at SET NOT NULL;
  ALTER TABLE serial_log ADD CONSTRAINT serial_log_pkey PRIMARY KEY (id, created_at);

  FOR v_month IN SELECT DISTINCT date_trunc('month', created_at)::date FROM scale3_serial_stage LOOP
    PERFORM ensure_serial_log_month_partition(v_month);
  END LOOP;

  INSERT INTO serial_log (
    id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id,
    customer_id, customer_name, status, source_type, source_id, history_json,
    fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  )
  SELECT
    id, device_serial, pon_serial, mac_address, product_id, product_name, branch_id,
    customer_id, customer_name, status, source_type, source_id, history_json,
    fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  FROM scale3_serial_stage;

  -- Register the three legacy keys set-wise, before the trigger exists, with the
  -- same normalisation the unique indexes compared (lower(trim(...))) and the
  -- same partial predicate (blank values were never governed).
  INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
  SELECT 'SERIAL_LOG', 'SERIAL', id, lower(btrim(device_serial)), created_at::date
    FROM scale3_serial_stage WHERE btrim(device_serial) <> '';
  INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
  SELECT 'SERIAL_LOG', 'PON', id, lower(btrim(pon_serial)), created_at::date
    FROM scale3_serial_stage WHERE btrim(coalesce(pon_serial, '')) <> '';
  INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
  SELECT 'SERIAL_LOG', 'MAC', id, lower(btrim(mac_address)), created_at::date
    FROM scale3_serial_stage WHERE btrim(coalesce(mac_address, '')) <> '';

  SELECT count(*) INTO v_legacy FROM scale3_serial_stage;
  SELECT count(*) INTO v_new FROM serial_log;
  SELECT count(*) INTO v_serial FROM scale3_serial_stage WHERE btrim(device_serial) <> '';
  SELECT count(*) INTO v_pon FROM scale3_serial_stage WHERE btrim(coalesce(pon_serial, '')) <> '';
  SELECT count(*) INTO v_mac FROM scale3_serial_stage WHERE btrim(coalesce(mac_address, '')) <> '';
  SELECT count(*) INTO v_reg_serial FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND key_role = 'SERIAL';
  SELECT count(*) INTO v_reg_pon FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND key_role = 'PON';
  SELECT count(*) INTO v_reg_mac FROM document_identity_registry WHERE document_type = 'SERIAL_LOG' AND key_role = 'MAC';

  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'serial_log conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;
  IF v_reg_serial <> v_serial OR v_reg_pon <> v_pon OR v_reg_mac <> v_mac THEN
    RAISE EXCEPTION 'serial_log registry mismatch: serial %/% pon %/% mac %/%',
      v_reg_serial, v_serial, v_reg_pon, v_pon, v_reg_mac, v_mac;
  END IF;

  DROP TABLE scale3_serial_stage;
END $$;

-- ---------------------------------------------------------------------------
-- DEFAULT child, indexes and the identity trigger (re-asserted on every apply)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS serial_log_default PARTITION OF serial_log DEFAULT;

CREATE INDEX IF NOT EXISTS idx_serial_log_branch ON serial_log(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_serial_log_status ON serial_log(status);
CREATE INDEX IF NOT EXISTS idx_serial_log_demo ON serial_log(id) WHERE is_demo = TRUE;
CREATE INDEX IF NOT EXISTS idx_serial_log_created_at ON serial_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_serial_log_device_serial ON serial_log((lower(trim(device_serial))));

CREATE OR REPLACE TRIGGER trg_serial_log_identity
  BEFORE INSERT OR UPDATE OR DELETE ON serial_log
  FOR EACH ROW EXECUTE FUNCTION enforce_document_identity(
    'SERIAL_LOG', 'created_at',
    'SERIAL:device_serial:ci:optional',
    'PON:pon_serial:ci:optional',
    'MAC:mac_address:ci:optional');
