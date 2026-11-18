-- Worklist SCALE-3: convert the subledger ledger to monthly RANGE partitions.
--
-- Why: gl_subledger_entries is the third ledger table and the fastest-growing
-- non-journal one — every posted line writes one. A trial balance for one month
-- or a closed year still read the whole table, and a retention purge had to
-- DELETE row by row. `entry_date_ad` is the natural key: every read is bounded
-- by a document date, exactly like `journal_date_ad` on the journals.
--
-- Shape (deliberately the same as 0003 and 0032):
--   * PARTITION BY RANGE (entry_date_ad), one child per month named
--     gl_subledger_entries_YYYYMM, plus a DEFAULT catch-all;
--   * the partition key joins the primary key — a partitioned unique constraint
--     must contain it — and `id` stays unique within its month, which is the
--     only way a subledger row is ever addressed (the document is reached
--     through journal_id, the party through subledger_id);
--   * ensure_subledger_month_partition(date) creates one month and is called by
--     ensure_journal_month_partition(), so the posting path provisions all
--     three ledger tables from the one call it already made;
--   * the append-only guard is attached to the parent AND to every child: a
--     row trigger on a partitioned parent does not fire for DML aimed directly
--     at a child.
--
-- Upgrade is a shadow table + swap, never an in-place rewrite: stage the rows,
-- the CHECK/FOREIGN KEY/NOT NULL constraints and the canonical indexes, drop
-- the plain table, recreate it partitioned and insert the rows back through the
-- parent so each one lands in its month. A row-count mismatch raises, and the
-- migration runner's transaction leaves the legacy table in place.

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_subledger_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', p_date)::date;
  v_end DATE := (date_trunc('month', p_date) + INTERVAL '1 month')::date;
  v_name TEXT := 'gl_subledger_entries_' || to_char(p_date, 'YYYYMM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_subledger_entries FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
  EXECUTE format(
    'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation()',
    v_name || '_append_only', v_name
  );
END;
$$ LANGUAGE plpgsql;

-- Re-assert the journal function with the subledger call, so an install that
-- applies this migration provisions the subledger child from the posting path
-- without any code change.
CREATE OR REPLACE FUNCTION ensure_journal_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', p_date)::date;
  v_end DATE := (date_trunc('month', p_date) + INTERVAL '1 month')::date;
  v_suffix TEXT := to_char(p_date, 'YYYYMM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journals FOR VALUES FROM (%L) TO (%L)',
    'gl_journals_' || v_suffix, v_start, v_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journal_lines FOR VALUES FROM (%L) TO (%L)',
    'gl_journal_lines_' || v_suffix, v_start, v_end
  );
  PERFORM ensure_subledger_month_partition(p_date);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Conversion of a populated plain table
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
   WHERE n.nspname = 'public' AND c.relname = 'gl_subledger_entries';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN; -- already partitioned (or absent: schema.sql owns the fresh shape)
  END IF;

  CREATE TEMP TABLE scale3_sub_stage ON COMMIT DROP AS
    SELECT id, journal_id, journal_line_id, account_id, subledger_id, subledger_type,
           party_id, party_name, branch_id, entry_date_ad, debit, credit, created_at,
           entry_date_bs
      FROM gl_subledger_entries;

  -- CHECK, FOREIGN KEY and (PG 18) named NOT NULL constraints. The primary key
  -- is rebuilt from the new key and skipped here.
  CREATE TEMP TABLE scale3_sub_cons ON COMMIT DROP AS
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'gl_subledger_entries'::regclass
       AND contype IN ('c', 'f', 'n');

  DROP TABLE gl_subledger_entries;

  -- Columns are created bare and receive the staged constraints below, so an
  -- install whose NOT NULLs and foreign keys were added by later migrations
  -- keeps their exact names; a fresh install gets the same shape from
  -- schema.sql.
  CREATE TABLE gl_subledger_entries (
    id VARCHAR(60),
    journal_id VARCHAR(50),
    journal_line_id VARCHAR(60),
    account_id VARCHAR(50),
    subledger_id VARCHAR(50),
    subledger_type VARCHAR(30),
    party_id VARCHAR(100),
    party_name VARCHAR(200),
    branch_id VARCHAR(50),
    entry_date_ad DATE,
    debit NUMERIC(14, 2) DEFAULT 0,
    credit NUMERIC(14, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    entry_date_bs VARCHAR(20)
  ) PARTITION BY RANGE (entry_date_ad);

  FOR v_row IN SELECT conname, def FROM scale3_sub_cons ORDER BY contype, conname LOOP
    EXECUTE format('ALTER TABLE gl_subledger_entries ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  ALTER TABLE gl_subledger_entries ADD CONSTRAINT gl_subledger_entries_pkey
    PRIMARY KEY (id, entry_date_ad);

  -- One child per month the data already occupies, created by the same function
  -- the write path uses.
  FOR v_month IN
    SELECT DISTINCT date_trunc('month', entry_date_ad)::date FROM scale3_sub_stage
  LOOP
    PERFORM ensure_subledger_month_partition(v_month);
  END LOOP;

  INSERT INTO gl_subledger_entries (
    id, journal_id, journal_line_id, account_id, subledger_id, subledger_type,
    party_id, party_name, branch_id, entry_date_ad, debit, credit, created_at,
    entry_date_bs
  )
  SELECT
    id, journal_id, journal_line_id, account_id, subledger_id, subledger_type,
    party_id, party_name, branch_id, entry_date_ad, debit, credit, created_at,
    entry_date_bs
  FROM scale3_sub_stage;

  SELECT count(*) INTO v_legacy FROM scale3_sub_stage;
  SELECT count(*) INTO v_new FROM gl_subledger_entries;
  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'gl_subledger_entries conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;

  DROP TABLE scale3_sub_stage;
END $$;

-- ---------------------------------------------------------------------------
-- DEFAULT child, indexes, append-only guard (re-asserted on every apply)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gl_subledger_entries_default
    PARTITION OF gl_subledger_entries DEFAULT;

CREATE INDEX IF NOT EXISTS idx_gl_subledger_account_branch ON gl_subledger_entries(account_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_party ON gl_subledger_entries(subledger_type, party_id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_journal ON gl_subledger_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_book ON gl_subledger_entries(subledger_id);

CREATE OR REPLACE TRIGGER trg_gl_subledger_entries_append_only
  BEFORE UPDATE OR DELETE ON gl_subledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();

-- Children created before this migration (and DEFAULT) need the same guard;
-- ensure_subledger_month_partition() covers the ones created afterwards.
DO $$
DECLARE
  v_child RECORD;
BEGIN
  FOR v_child IN
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'gl_subledger_entries'
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation()',
      v_child.name || '_append_only', v_child.name
    );
  END LOOP;
END $$;
