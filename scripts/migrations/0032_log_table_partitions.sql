-- Worklist A7: monthly partitions for the two high-volume log tables, plus an
-- append-only guard on the audit trail.
--
-- Why: audit_logs and transaction_logs are the fastest-growing objects in the
-- database and were the last two plain tables. Unless they are partitioned,
-- retention can only DELETE, and the rows of a bad import can never be pruned
-- as a unit. `timestamp_ad` is the natural key: every read is time-bounded.
--
-- Shape (deliberately the same as the GL ledgers):
--   * PARTITION BY RANGE (timestamp_ad), one child per month, named
--     <table>_YYYYMM;
--   * a DEFAULT child, so an out-of-range or undated insert can never fail;
--   * ensure_log_month_partition(table, ts) creates one month and is called by
--     the write path before its INSERT (PostgreSQL refuses
--     `CREATE TABLE ... PARTITION OF` inside the statement that inserts into the
--     same table, so month creation is its own statement, exactly like the GL
--     posting path);
--   * audit_logs refuses UPDATE and DELETE through the same
--     `inventory.allow_ledger_purge` switch the ledger purge uses.
--
-- Idempotent: a second apply finds relkind = 'p' and only re-asserts the DEFAULT
-- children, indexes and triggers.
--
-- Conversion of a populated install stages the rows and the legacy table's
-- CHECK/NOT NULL shape, drops the old table and recreates the partitioned one
-- with the canonical names before inserting the rows back through the parent.
-- Dropping first matters: keeping the renamed table alive made PostgreSQL
-- suffix every fresh constraint and index (`audit_logs_pkey1`,
-- `..._fkey1`), and the upgrade-vs-fresh schema comparison rightly refuses that.
-- The whole migration runs in the runner's transaction, so a failure leaves the
-- legacy table in place.

-- ---------------------------------------------------------------------------
-- Month provisioning
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_log_month_partition(p_table TEXT, p_ts TIMESTAMPTZ)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', COALESCE(p_ts, CURRENT_TIMESTAMP))::date;
  v_end DATE := (date_trunc('month', COALESCE(p_ts, CURRENT_TIMESTAMP)) + INTERVAL '1 month')::date;
  v_name TEXT := p_table || '_' || to_char(COALESCE(p_ts, CURRENT_TIMESTAMP), 'YYYYMM');
BEGIN
  IF p_table NOT IN ('audit_logs', 'transaction_logs') THEN
    RAISE EXCEPTION 'ensure_log_month_partition: % is not a log table this function owns', p_table;
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    v_name, p_table, v_start, v_end
  );
  -- A row-level trigger on a partitioned parent does not fire for DML aimed
  -- directly at a child, so the append-only guard is attached to each child as
  -- well; otherwise DELETE FROM audit_logs_202611 would bypass the audit trail.
  IF p_table = 'audit_logs' THEN
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation()',
      v_name || '_append_only', v_name
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Append-only audit trail
-- ---------------------------------------------------------------------------

/*
 * Audit rows are evidence: once written they may not change or disappear. The
 * escape hatch is the same GUC the ledger purge uses, and it has to be set
 * explicitly for one transaction (`SET LOCAL`) — a sanctioned purge, not a
 * side effect of ordinary cleanup.
 */
CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('inventory.allow_ledger_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed. Use a sanctioned purge (SET LOCAL inventory.allow_ledger_purge = ''on'') if history must be removed.', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- audit_logs: convert a populated plain table to monthly partitions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_kind "char";
  v_month DATE;
  v_legacy BIGINT;
  v_new BIGINT;
  v_row RECORD;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'audit_logs';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN; -- already partitioned (or absent: schema.sql owns the fresh shape)
  END IF;

  -- Stage the rows, the CHECK constraints and the NOT NULL shape the live table
  -- actually has. An install that went through later migrations accepts more
  -- module values and has more NOT NULL columns than the original CREATE TABLE.
  CREATE TEMP TABLE a7_audit_stage ON COMMIT DROP AS SELECT * FROM audit_logs;
  CREATE TEMP TABLE a7_audit_cons ON COMMIT DROP AS
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
  CREATE TEMP TABLE a7_audit_notnull ON COMMIT DROP AS
    SELECT attname
      FROM pg_attribute
     WHERE attrelid = 'audit_logs'::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull;

  DROP TABLE audit_logs;

  CREATE TABLE audit_logs (
    id VARCHAR(50) NOT NULL,
    user_email VARCHAR(150) NOT NULL,
    user_name VARCHAR(150) NOT NULL,
    action VARCHAR(100) NOT NULL,
    module VARCHAR(50) NOT NULL,
    details TEXT,
    timestamp_ad TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    timestamp_bs VARCHAR(20),
    -- No foreign keys: the append-only guard refuses the cascading UPDATE that
    -- `ON DELETE SET NULL` performs when a branch or fiscal year is deleted, and
    -- the trail should keep the id it was written with anyway.
    branch_id VARCHAR(50),
    fiscal_year_id VARCHAR(50),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (id, timestamp_ad)
  ) PARTITION BY RANGE (timestamp_ad);

  FOR v_row IN SELECT conname, def FROM a7_audit_cons LOOP
    EXECUTE format('ALTER TABLE audit_logs ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  FOR v_row IN SELECT attname FROM a7_audit_notnull LOOP
    IF v_row.attname <> 'timestamp_ad' THEN
      EXECUTE format('ALTER TABLE audit_logs ALTER COLUMN %I SET NOT NULL', v_row.attname);
    END IF;
  END LOOP;

  -- The partition key is part of the primary key, so it cannot be NULL. An
  -- undated row can only come from an explicit NULL insert; stamp it with the
  -- migration instant rather than leave a row that would sit in DEFAULT and
  -- block that month from ever being attached.
  UPDATE a7_audit_stage SET timestamp_ad = CURRENT_TIMESTAMP WHERE timestamp_ad IS NULL;

  -- One child per month the data already occupies, created by the same function
  -- the write path uses.
  FOR v_month IN
    SELECT DISTINCT date_trunc('month', timestamp_ad)::date FROM a7_audit_stage
  LOOP
    PERFORM ensure_log_month_partition('audit_logs', v_month::timestamptz);
  END LOOP;

  INSERT INTO audit_logs (
    id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs,
    branch_id, fiscal_year_id, is_demo
  )
  SELECT
    id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs,
    branch_id, fiscal_year_id, is_demo
  FROM a7_audit_stage;

  SELECT count(*) INTO v_legacy FROM a7_audit_stage;
  SELECT count(*) INTO v_new FROM audit_logs;
  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'audit_logs conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;

  DROP TABLE a7_audit_stage;
END $$;

-- ---------------------------------------------------------------------------
-- transaction_logs: same conversion
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_kind "char";
  v_month DATE;
  v_legacy BIGINT;
  v_new BIGINT;
  v_row RECORD;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'transaction_logs';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE a7_txn_stage ON COMMIT DROP AS SELECT * FROM transaction_logs;
  CREATE TEMP TABLE a7_txn_cons ON COMMIT DROP AS
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'transaction_logs'::regclass AND contype = 'c';
  CREATE TEMP TABLE a7_txn_notnull ON COMMIT DROP AS
    SELECT attname
      FROM pg_attribute
     WHERE attrelid = 'transaction_logs'::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull;

  DROP TABLE transaction_logs;

  CREATE TABLE transaction_logs (
    id VARCHAR(100) NOT NULL,
    transaction_number VARCHAR(100) NOT NULL,
    product_id VARCHAR(50) REFERENCES products(id) ON DELETE SET NULL,
    product_sku VARCHAR(100),
    product_name VARCHAR(255),
    branch_id VARCHAR(50) REFERENCES branches(id) ON DELETE CASCADE,
    change_type VARCHAR(50) NOT NULL,
    quantity_before INT NOT NULL,
    quantity_changed INT NOT NULL,
    quantity_after INT NOT NULL,
    unit_cost NUMERIC(12, 2) DEFAULT 0.00,
    reference_doc_id VARCHAR(100),
    timestamp_ad TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    timestamp_bs VARCHAR(20),
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    PRIMARY KEY (id, timestamp_ad)
  ) PARTITION BY RANGE (timestamp_ad);

  FOR v_row IN SELECT conname, def FROM a7_txn_cons LOOP
    EXECUTE format('ALTER TABLE transaction_logs ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  FOR v_row IN SELECT attname FROM a7_txn_notnull LOOP
    IF v_row.attname <> 'timestamp_ad' THEN
      EXECUTE format('ALTER TABLE transaction_logs ALTER COLUMN %I SET NOT NULL', v_row.attname);
    END IF;
  END LOOP;

  UPDATE a7_txn_stage SET timestamp_ad = CURRENT_TIMESTAMP WHERE timestamp_ad IS NULL;

  FOR v_month IN
    SELECT DISTINCT date_trunc('month', timestamp_ad)::date FROM a7_txn_stage
  LOOP
    PERFORM ensure_log_month_partition('transaction_logs', v_month::timestamptz);
  END LOOP;

  INSERT INTO transaction_logs (
    id, transaction_number, product_id, product_sku, product_name, branch_id,
    change_type, quantity_before, quantity_changed, quantity_after, unit_cost,
    reference_doc_id, timestamp_ad, timestamp_bs, fiscal_year_id, is_demo, created_by
  )
  SELECT
    id, transaction_number, product_id, product_sku, product_name, branch_id,
    change_type, quantity_before, quantity_changed, quantity_after, unit_cost,
    reference_doc_id, timestamp_ad, timestamp_bs, fiscal_year_id, is_demo, created_by
  FROM a7_txn_stage;

  SELECT count(*) INTO v_legacy FROM a7_txn_stage;
  SELECT count(*) INTO v_new FROM transaction_logs;
  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'transaction_logs conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;

  DROP TABLE a7_txn_stage;
END $$;

-- ---------------------------------------------------------------------------
-- DEFAULT children, indexes and triggers (re-asserted on every apply)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE TABLE IF NOT EXISTS transaction_logs_default PARTITION OF transaction_logs DEFAULT;

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp_ad DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module);
CREATE INDEX IF NOT EXISTS idx_audit_branch ON audit_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_fiscal_year_id ON audit_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_demo ON audit_logs(id) WHERE is_demo = TRUE;
-- Same shape as scripts/schema.sql: the audit index is two columns (the
-- transaction one carries id for its cursor); the upgrade-vs-fresh comparison
-- is what caught the difference.
CREATE INDEX IF NOT EXISTS idx_audit_branch_timestamp ON audit_logs (branch_id, timestamp_ad DESC);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp_brin ON audit_logs USING brin (timestamp_ad);

CREATE INDEX IF NOT EXISTS idx_txn_product ON transaction_logs(product_id);
CREATE INDEX IF NOT EXISTS idx_txn_branch ON transaction_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_txn_timestamp ON transaction_logs(timestamp_ad DESC);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transaction_logs(change_type);
CREATE INDEX IF NOT EXISTS idx_transaction_logs_fiscal_year_id ON transaction_logs(fiscal_year_id) WHERE fiscal_year_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_logs_demo ON transaction_logs(id) WHERE is_demo = TRUE;
CREATE INDEX IF NOT EXISTS idx_txn_branch_time ON transaction_logs (branch_id, timestamp_ad DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_txn_timestamp_brin ON transaction_logs USING brin (timestamp_ad);

CREATE OR REPLACE TRIGGER trg_audit_logs_fiscal_year
  BEFORE INSERT OR UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');

CREATE OR REPLACE TRIGGER trg_transaction_logs_fiscal_year
  BEFORE INSERT OR UPDATE ON transaction_logs
  FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('timestamp_ad');

CREATE OR REPLACE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- Children created before this migration (and DEFAULT) need the same guard; the
-- provisioning function covers the ones created afterwards.
DO $$
DECLARE
  v_child RECORD;
BEGIN
  FOR v_child IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'audit_logs'
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation()',
      v_child.name || '_append_only', v_child.name
    );
  END LOOP;
END $$;
