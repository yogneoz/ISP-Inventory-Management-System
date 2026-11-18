-- Worklist SCALE-3: convert `stock_operations` to monthly RANGE partitions by
-- its operation date, with the business key moved to a registry.
--
-- Why: stock operations are the operational counterpart of a journal. Every
-- pullout, damage report, disposal, stock-out and consumable issue is a row
-- here, and the screens read them branch- and month-scoped. Partitioning lets a
-- month (or a fiscal year) prune, and lets retention detach a closed month
-- instead of DELETEing through one ever-growing heap.
--
-- The obstacle is identity, not storage: `reference_number` is globally unique
-- and the write path rejects a duplicate reference, but a partitioned unique
-- constraint must contain the partition key. `gl_journals_registry` already
-- solved this for the ledger by keeping the document number in a small
-- unpartitioned table; `document_identity_registry` is that registry
-- generalised (one table, one trigger, one set of rules for every converted
-- document table), and `enforce_document_identity()` is the protocol:
--
--   * INSERT registers (document_type, id, reference, date). A reused
--     reference raises 23505 on the registry, exactly like the UNIQUE column it
--     replaces. Re-sending the same id (the write path upserts by id) is
--     allowed only for the same reference and date, so an upsert cannot move a
--     row into another month.
--   * UPDATE refuses a change to `date_ad` (the partition key: a row must never
--     be silently reparented by a backdate) and to `reference_number` (the
--     registered key). A correction is a reverse-and-repost, which the stock
--     operation screens already implement.
--   * DELETE releases the key, so a month can be emptied and detached.
--
-- No append-only guard is attached to the children: unlike the subledger, this
-- table is meant to be updated (status transitions, receipt, cancellation,
-- reversal) and the identity trigger is what protects its history.
--
-- Upgrade is the same shadow table + swap as the subledger conversion: stage
-- the rows and the CHECK/FOREIGN KEY/NOT NULL constraints, drop the plain
-- table, recreate it partitioned, register the legacy keys, insert the rows back
-- through the parent. A row-count or registry-count mismatch raises and the
-- runner's transaction leaves the legacy table in place.

-- ---------------------------------------------------------------------------
-- Registry and provisioning
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_identity_registry (
    document_type VARCHAR(40) NOT NULL,
    id VARCHAR(60) NOT NULL,
    business_key VARCHAR(160) NOT NULL,
    document_date DATE NOT NULL,
    PRIMARY KEY (document_type, id),
    UNIQUE (document_type, business_key)
);

CREATE OR REPLACE FUNCTION enforce_document_identity()
RETURNS trigger AS $$
DECLARE
  v_type TEXT := TG_ARGV[0];
  v_key TEXT := TG_ARGV[1];
  v_date TEXT := TG_ARGV[2];
  v_new_key TEXT;
  v_new_date DATE;
  v_old_key TEXT;
  v_old_date DATE;
  v_existing RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM document_identity_registry WHERE document_type = v_type AND id = OLD.id;
    RETURN OLD;
  END IF;

  v_new_key := to_jsonb(NEW) ->> v_key;
  v_new_date := (to_jsonb(NEW) ->> v_date)::date;

  IF TG_OP = 'UPDATE' THEN
    v_old_key := to_jsonb(OLD) ->> v_key;
    v_old_date := (to_jsonb(OLD) ->> v_date)::date;
    IF v_new_date IS DISTINCT FROM v_old_date THEN
      RAISE EXCEPTION 'a % row cannot move to another %: % is the partition key (row %). Reverse it and post a new document instead.', v_type, v_date, v_date, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_new_key IS DISTINCT FROM v_old_key THEN
      RAISE EXCEPTION 'a % row cannot change its %: it is the registered business key (row %).', v_type, v_key, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT business_key, document_date INTO v_existing
    FROM document_identity_registry
   WHERE document_type = v_type AND id = NEW.id;
  IF FOUND THEN
    IF v_existing.document_date IS DISTINCT FROM v_new_date THEN
      RAISE EXCEPTION 'a % row cannot move to another %: % is the partition key (row %). Reverse it and post a new document instead.', v_type, v_date, v_date, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_existing.business_key IS DISTINCT FROM v_new_key THEN
      RAISE EXCEPTION 'a % row cannot change its %: it is the registered business key (row %).', v_type, v_key, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO document_identity_registry (document_type, id, business_key, document_date)
  VALUES (v_type, NEW.id, v_new_key, v_new_date);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_stock_operation_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', p_date)::date;
  v_end DATE := (date_trunc('month', p_date) + INTERVAL '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF stock_operations FOR VALUES FROM (%L) TO (%L)',
    'stock_operations_' || to_char(p_date, 'YYYYMM'), v_start, v_end
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
  v_registered BIGINT;
  v_row RECORD;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'stock_operations';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN; -- already partitioned (or absent: schema.sql owns the fresh shape)
  END IF;

  CREATE TEMP TABLE scale3_ops_stage ON COMMIT DROP AS SELECT * FROM stock_operations;

  -- CHECK, FOREIGN KEY and (PG 18) named NOT NULL constraints, minus the
  -- reference UNIQUE: the registry takes that role and a partitioned unique
  -- constraint cannot carry the business key alone. The primary key is rebuilt
  -- with the partition key and is skipped here by contype.
  CREATE TEMP TABLE scale3_ops_cons ON COMMIT DROP AS
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'stock_operations'::regclass
       AND contype IN ('c', 'f', 'n');

  DROP TABLE stock_operations;

  CREATE TABLE stock_operations (
    id VARCHAR(50),
    reference_number VARCHAR(100),
    type VARCHAR(50),
    technician_name VARCHAR(150),
    work_order_ref VARCHAR(100),
    branch_id VARCHAR(50),
    branch_name VARCHAR(150),
    destination_warehouse_id VARCHAR(50),
    destination_warehouse_name VARCHAR(150),
    product_id VARCHAR(50),
    quantity_changed INT DEFAULT 0,
    cost_per_unit NUMERIC(12, 2) DEFAULT 0.00,
    total_value NUMERIC(12, 2) DEFAULT 0.00,
    reason TEXT,
    inspector_name VARCHAR(150),
    date_ad DATE,
    date_bs VARCHAR(20),
    fiscal_year VARCHAR(20),
    status VARCHAR(30) DEFAULT 'LOGGED',
    items JSONB DEFAULT '[]'::jsonb,
    search_text TEXT GENERATED ALWAYS AS (
        lower(
            COALESCE(reference_number, '') || ' ' ||
            COALESCE(technician_name, '') || ' ' ||
            COALESCE(work_order_ref, '') || ' ' ||
            COALESCE(reason, '') || ' ' ||
            COALESCE(items::text, '')
        )
    ) STORED,
    fiscal_year_id VARCHAR(50),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  ) PARTITION BY RANGE (date_ad);

  FOR v_row IN SELECT conname, def FROM scale3_ops_cons ORDER BY contype, conname LOOP
    EXECUTE format('ALTER TABLE stock_operations ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  ALTER TABLE stock_operations ADD CONSTRAINT stock_operations_pkey PRIMARY KEY (id, date_ad);

  -- One child per month the data already occupies, created by the same function
  -- the write path and the boot provisioner use.
  FOR v_month IN
    SELECT DISTINCT date_trunc('month', date_ad)::date FROM scale3_ops_stage
  LOOP
    PERFORM ensure_stock_operation_month_partition(v_month);
  END LOOP;

  INSERT INTO stock_operations (
    id, reference_number, type, technician_name, work_order_ref, branch_id, branch_name,
    destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed,
    cost_per_unit, total_value, reason, inspector_name, date_ad, date_bs, fiscal_year,
    status, items, fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  )
  SELECT
    id, reference_number, type, technician_name, work_order_ref, branch_id, branch_name,
    destination_warehouse_id, destination_warehouse_name, product_id, quantity_changed,
    cost_per_unit, total_value, reason, inspector_name, date_ad, date_bs, fiscal_year,
    status, items, fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  FROM scale3_ops_stage;

  -- Register the legacy keys before the trigger exists, so the backfill is one
  -- set-based insert instead of a trigger call per row. A duplicate reference
  -- would abort here (the old UNIQUE made it impossible).
  INSERT INTO document_identity_registry (document_type, id, business_key, document_date)
  SELECT 'STOCK_OPERATION', id, reference_number, date_ad FROM scale3_ops_stage;

  SELECT count(*) INTO v_legacy FROM scale3_ops_stage;
  SELECT count(*) INTO v_new FROM stock_operations;
  SELECT count(*) INTO v_registered
    FROM document_identity_registry WHERE document_type = 'STOCK_OPERATION';
  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'stock_operations conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;
  IF v_registered <> v_legacy THEN
    RAISE EXCEPTION 'stock_operations conversion registered % keys for % rows', v_registered, v_legacy;
  END IF;

  DROP TABLE scale3_ops_stage;
END $$;

-- ---------------------------------------------------------------------------
-- DEFAULT child, indexes and the identity trigger (re-asserted on every apply)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_operations_default PARTITION OF stock_operations DEFAULT;

CREATE INDEX IF NOT EXISTS idx_stock_ops_ref ON stock_operations(reference_number);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch ON stock_operations(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_ops_type ON stock_operations(type);
CREATE INDEX IF NOT EXISTS idx_stock_ops_date ON stock_operations(date_ad DESC);
CREATE INDEX IF NOT EXISTS idx_stock_operations_fiscal_year_id ON stock_operations(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_operations_demo ON stock_operations(id) WHERE is_demo = TRUE;
CREATE INDEX IF NOT EXISTS idx_stock_operations_search_trgm ON stock_operations USING gin (search_text gin_trgm_ops);
-- Same names as scripts/schema.sql (the upgrade-vs-fresh comparison is what
-- catches a renamed index).
CREATE INDEX IF NOT EXISTS idx_stock_ops_page_all ON stock_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch_page ON stock_operations (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_destination_page ON stock_operations (destination_warehouse_id, created_at DESC);

CREATE OR REPLACE TRIGGER trg_stock_operations_fiscal_year
  BEFORE INSERT OR UPDATE ON stock_operations
  FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('date_ad');

CREATE OR REPLACE TRIGGER trg_stock_operations_identity
  BEFORE INSERT OR UPDATE OR DELETE ON stock_operations
  FOR EACH ROW EXECUTE FUNCTION enforce_document_identity('STOCK_OPERATION', 'reference_number', 'date_ad');
