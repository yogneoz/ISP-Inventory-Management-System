-- Phase 2: monthly journal partitions.
--
-- Both ledger tables are range-partitioned by journal_date_ad. External tables
-- still reference a bare journal/line id, so the old tables become thin
-- non-partitioned identity registries and a trigger keeps each registry in step
-- with its partitioned parent. The line-to-journal FK is composite and remains
-- a real FK with ON DELETE CASCADE.
--
-- Fresh installs already have the partitioned shape from scripts/schema.sql;
-- this migration only ensures the support objects exist. Existing installs are
-- converted in one transaction, so a failed copy leaves the old tables intact.

DO $$
DECLARE
  v_kind "char";
  v_min DATE;
  v_max DATE;
  v_month DATE;
BEGIN
  SELECT c.relkind INTO v_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'gl_journals';

  IF v_kind = 'r' THEN
    -- The old tables become identity registries. Existing external FKs follow
    -- the rename automatically, so no dependent table needs a new date column.
    ALTER TABLE gl_journals RENAME TO gl_journals_registry;
    ALTER TABLE gl_journal_lines RENAME TO gl_journal_line_registry;

    -- Free the old constraint/index names for the new partitioned parents.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'gl_journals_pkey'
        AND conrelid = 'gl_journals_registry'::regclass
    ) THEN
      ALTER TABLE gl_journals_registry RENAME CONSTRAINT gl_journals_pkey TO gl_journals_registry_pkey;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'gl_journals_journal_no_key'
        AND conrelid = 'gl_journals_registry'::regclass
    ) THEN
      ALTER TABLE gl_journals_registry RENAME CONSTRAINT gl_journals_journal_no_key TO gl_journals_registry_journal_no_key;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'gl_journal_lines_pkey'
        AND conrelid = 'gl_journal_line_registry'::regclass
    ) THEN
      ALTER TABLE gl_journal_line_registry RENAME CONSTRAINT gl_journal_lines_pkey TO gl_journal_line_registry_pkey;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'gl_journal_lines_journal_id_line_no_key'
        AND conrelid = 'gl_journal_line_registry'::regclass
    ) THEN
      ALTER TABLE gl_journal_line_registry RENAME CONSTRAINT gl_journal_lines_journal_id_line_no_key TO gl_journal_line_registry_journal_id_line_no_key;
    END IF;

    DROP INDEX IF EXISTS idx_gl_journals_date;
    DROP INDEX IF EXISTS idx_gl_journals_branch;
    DROP INDEX IF EXISTS idx_gl_journals_period;
    DROP INDEX IF EXISTS idx_gl_journals_source;
    DROP INDEX IF EXISTS idx_gl_journals_reversal_of;
    DROP INDEX IF EXISTS uq_gl_journals_opening_balance;
    DROP INDEX IF EXISTS idx_gl_journal_lines_account;
    DROP INDEX IF EXISTS idx_gl_journal_lines_journal;
    DROP INDEX IF EXISTS idx_gl_journal_lines_cost_center;

    DROP TRIGGER IF EXISTS trg_gl_journals_append_only ON gl_journals_registry;
    DROP TRIGGER IF EXISTS trg_gl_journal_lines_append_only ON gl_journal_line_registry;

    ALTER TABLE gl_journal_line_registry
      ADD COLUMN IF NOT EXISTS journal_date_ad DATE;
    UPDATE gl_journal_line_registry l
    SET journal_date_ad = r.journal_date_ad
    FROM gl_journals_registry r
    WHERE r.id = l.journal_id;

    CREATE TABLE gl_journals (
      id VARCHAR(50) NOT NULL,
      journal_no VARCHAR(50) NOT NULL,
      journal_date_ad DATE NOT NULL,
      journal_date_bs VARCHAR(20),
      fiscal_year_id VARCHAR(50) NOT NULL REFERENCES fiscal_years(id) ON DELETE RESTRICT,
      period_id VARCHAR(50) NOT NULL REFERENCES gl_periods(id) ON DELETE RESTRICT,
      branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
      source_type VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
      source_id VARCHAR(100),
      voucher_type VARCHAR(30) NOT NULL DEFAULT 'JOURNAL',
      voucher_class VARCHAR(50),
      reference_no VARCHAR(100),
      reference_date_ad DATE,
      reference_date_bs VARCHAR(20),
      cheque_no VARCHAR(100),
      cheque_date_ad DATE,
      cheque_date_bs VARCHAR(20),
      currency VARCHAR(10) NOT NULL DEFAULT 'NPR',
      exchange_rate NUMERIC(14, 6) NOT NULL DEFAULT 1,
      memo TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
      reversal_of_id VARCHAR(50) REFERENCES gl_journals_registry(id) ON DELETE SET NULL,
      posted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      posted_by VARCHAR(150),
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, journal_date_ad),
      UNIQUE (journal_no, journal_date_ad)
    ) PARTITION BY RANGE (journal_date_ad);

    CREATE TABLE gl_journal_lines (
      id VARCHAR(60) NOT NULL,
      journal_id VARCHAR(50) NOT NULL,
      journal_date_ad DATE NOT NULL,
      line_no INT NOT NULL,
      account_id VARCHAR(50) NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
      cost_center_id VARCHAR(50) REFERENCES cost_centers(id) ON DELETE RESTRICT,
      branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
      debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
      memo TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT gl_journal_lines_one_sided CHECK (
        debit >= 0 AND credit >= 0 AND
        ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
      ),
      PRIMARY KEY (id, journal_date_ad),
      UNIQUE (journal_id, line_no, journal_date_ad),
      FOREIGN KEY (journal_id, journal_date_ad)
        REFERENCES gl_journals(id, journal_date_ad) ON DELETE CASCADE
    ) PARTITION BY RANGE (journal_date_ad);

    CREATE INDEX idx_gl_journals_date ON gl_journals(journal_date_ad);
    CREATE INDEX idx_gl_journals_branch ON gl_journals(branch_id, journal_date_ad);
    CREATE INDEX idx_gl_journals_period ON gl_journals(period_id, journal_date_ad);
    CREATE INDEX idx_gl_journals_source ON gl_journals(source_type, source_id, journal_date_ad);
    CREATE INDEX idx_gl_journals_reversal_of ON gl_journals(reversal_of_id, journal_date_ad);
    CREATE UNIQUE INDEX uq_gl_journals_opening_balance
      ON gl_journals(branch_id, journal_date_ad) WHERE source_type = 'OPENING_BALANCE';
    CREATE INDEX idx_gl_journal_lines_account ON gl_journal_lines(account_id, branch_id, journal_date_ad);
    CREATE INDEX idx_gl_journal_lines_journal ON gl_journal_lines(journal_id, journal_date_ad);
    CREATE INDEX idx_gl_journal_lines_cost_center ON gl_journal_lines(cost_center_id);

    SELECT MIN(journal_date_ad), MAX(journal_date_ad)
      INTO v_min, v_max
    FROM gl_journals_registry;
    IF v_min IS NULL THEN
      v_month := date_trunc('month', CURRENT_DATE)::date;
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journals FOR VALUES FROM (%L) TO (%L)',
        'gl_journals_' || to_char(v_month, 'YYYYMM'),
        v_month,
        (v_month + INTERVAL '1 month')::date
      );
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journal_lines FOR VALUES FROM (%L) TO (%L)',
        'gl_journal_lines_' || to_char(v_month, 'YYYYMM'),
        v_month,
        (v_month + INTERVAL '1 month')::date
      );
    ELSE
      v_month := date_trunc('month', v_min)::date;
      WHILE v_month <= (date_trunc('month', v_max)::date + INTERVAL '12 months') LOOP
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journals FOR VALUES FROM (%L) TO (%L)',
          'gl_journals_' || to_char(v_month, 'YYYYMM'),
          v_month,
          (v_month + INTERVAL '1 month')::date
        );
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF gl_journal_lines FOR VALUES FROM (%L) TO (%L)',
          'gl_journal_lines_' || to_char(v_month, 'YYYYMM'),
          v_month,
          (v_month + INTERVAL '1 month')::date
        );
        v_month := (v_month + INTERVAL '1 month')::date;
      END LOOP;
    END IF;

    INSERT INTO gl_journals (
      id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id,
      branch_id, source_type, source_id, voucher_type, voucher_class, reference_no,
      reference_date_ad, reference_date_bs, cheque_no, cheque_date_ad, cheque_date_bs,
      currency, exchange_rate, memo, status, reversal_of_id, posted_at, posted_by,
      is_demo, created_at, updated_at
    )
    SELECT
      id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id,
      branch_id, source_type, source_id, voucher_type, voucher_class, reference_no,
      reference_date_ad, reference_date_bs, cheque_no, cheque_date_ad, cheque_date_bs,
      currency, exchange_rate, memo, status, reversal_of_id, posted_at, posted_by,
      is_demo, created_at, updated_at
    FROM gl_journals_registry;

    INSERT INTO gl_journal_lines (
      id, journal_id, journal_date_ad, line_no, account_id, cost_center_id,
      branch_id, debit, credit, memo, created_at
    )
    SELECT
      l.id, l.journal_id, l.journal_date_ad, l.line_no, l.account_id, l.cost_center_id,
      l.branch_id, l.debit, l.credit, l.memo, l.created_at
    FROM gl_journal_line_registry l
    JOIN gl_journals_registry r ON r.id = l.journal_id;

    -- Keep only the identity columns in the old tables. External FKs continue
    -- to point at these registries; they no longer hold ledger amounts.
    ALTER TABLE gl_journals_registry
      DROP COLUMN journal_date_bs,
      DROP COLUMN fiscal_year_id,
      DROP COLUMN period_id,
      DROP COLUMN branch_id,
      DROP COLUMN source_type,
      DROP COLUMN source_id,
      DROP COLUMN voucher_type,
      DROP COLUMN voucher_class,
      DROP COLUMN reference_no,
      DROP COLUMN reference_date_ad,
      DROP COLUMN reference_date_bs,
      DROP COLUMN cheque_no,
      DROP COLUMN cheque_date_ad,
      DROP COLUMN cheque_date_bs,
      DROP COLUMN currency,
      DROP COLUMN exchange_rate,
      DROP COLUMN memo,
      DROP COLUMN status,
      DROP COLUMN reversal_of_id,
      DROP COLUMN posted_at,
      DROP COLUMN posted_by,
      DROP COLUMN is_demo,
      DROP COLUMN created_at,
      DROP COLUMN updated_at;
    ALTER TABLE gl_journal_line_registry
      DROP COLUMN account_id,
      DROP COLUMN cost_center_id,
      DROP COLUMN branch_id,
      DROP COLUMN debit,
      DROP COLUMN credit,
      DROP COLUMN memo,
      DROP COLUMN created_at;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gl_journals_default PARTITION OF gl_journals DEFAULT;
CREATE TABLE IF NOT EXISTS gl_journal_lines_default PARTITION OF gl_journal_lines DEFAULT;

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
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_gl_journal_registry()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gl_journals_registry (id, journal_no, journal_date_ad)
    VALUES (NEW.id, NEW.journal_no, NEW.journal_date_ad);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM gl_journals_registry WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_gl_journal_line_registry()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gl_journal_line_registry (id, journal_id, line_no, journal_date_ad)
    VALUES (NEW.id, NEW.journal_id, NEW.line_no, NEW.journal_date_ad);
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM gl_journal_line_registry WHERE id = OLD.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_gl_journals_append_only
  BEFORE UPDATE OR DELETE ON gl_journals
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();
CREATE OR REPLACE TRIGGER trg_gl_journal_lines_append_only
  BEFORE UPDATE OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_posted_ledger_mutation();
CREATE OR REPLACE TRIGGER trg_gl_journals_registry_sync
  AFTER INSERT OR DELETE ON gl_journals
  FOR EACH ROW EXECUTE FUNCTION sync_gl_journal_registry();
CREATE OR REPLACE TRIGGER trg_gl_journal_lines_registry_sync
  AFTER INSERT OR DELETE ON gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION sync_gl_journal_line_registry();
