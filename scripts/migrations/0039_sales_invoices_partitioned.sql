-- Worklist SCALE-3 (last conversion): `sales_invoices` is RANGE-partitioned by
-- its invoice date, with `invoice_number` moved into the document identity
-- registry.
--
-- Why: the sales register is read month- and branch-scoped on every list, and a
-- closed year has to be prunable without touching live invoices. It is the same
-- shape as stock_operations and serial_log — month children, DEFAULT catch-all,
-- one provisioning function shared by the write path, the boot provisioner and
-- `check:partitions` — with ONE difference that is the reason it was left for
-- last: three other tables point at it.
--
--   sales_returns.original_invoice_id                -> sales_invoices(id) SET NULL
--   customer_payments.invoice_id                     -> sales_invoices(id) SET NULL
--   customer_payment_allocations.invoice_id          -> sales_invoices(id) RESTRICT
--
-- A foreign key cannot reference `(id)` alone once the primary key is
-- `(id, invoice_date_ad)`: PostgreSQL requires the referenced columns to be
-- uniquely constrained on the partitioned parent, and any unique constraint there
-- must contain the partition key. The ledger solved exactly this by pointing its
-- children at `gl_journals_registry` rather than the partitioned journal. This
-- migration does the same with the registry it already has: each child gains
-- `document_type`/`key_role` columns that default to the invoice's PRIMARY row,
-- and the foreign key targets `document_identity_registry (document_type,
-- key_role, id)` — the registry's primary key. Existing rows are validated by
-- the new constraint, so nothing that resolved before stops resolving, and the
-- ON DELETE actions keep their meaning (SET NULL names the id column only, so the
-- anchor columns stay NOT NULL).
--
-- `invoice_number` was `UNIQUE`; a partitioned unique constraint cannot carry it
-- without the date, so it becomes role PRIMARY with `fixed` and `refuse`: a
-- reused number is still an error (the sales controller already maps 23505 to a
-- 409), and an invoice number is still immutable.
--
-- Row-count and registry-count mismatches raise inside the runner's transaction,
-- leaving the legacy table in place.

-- ---------------------------------------------------------------------------
-- Month provisioning (same single-SQL-function path as the other tables)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_sales_invoice_month_partition(p_date DATE)
RETURNS void AS $$
DECLARE
  v_start DATE := date_trunc('month', p_date)::date;
  v_end DATE := (date_trunc('month', p_date) + INTERVAL '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF sales_invoices FOR VALUES FROM (%L) TO (%L)',
    'sales_invoices_' || to_char(p_date, 'YYYYMM'), v_start, v_end
  );
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- The three inbound keys move off the partitioned table
-- ---------------------------------------------------------------------------

ALTER TABLE sales_returns DROP CONSTRAINT IF EXISTS sales_returns_original_invoice_id_fkey;
ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_invoice_id_fkey;
ALTER TABLE customer_payment_allocations DROP CONSTRAINT IF EXISTS customer_payment_allocations_invoice_id_fkey;

-- ---------------------------------------------------------------------------
-- Swap
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_kind "char";
  v_month DATE;
  v_legacy BIGINT;
  v_new BIGINT;
  v_numbers BIGINT;
  v_registered BIGINT;
  v_row RECORD;
BEGIN
  SELECT c.relkind INTO v_kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'sales_invoices';

  IF v_kind IS DISTINCT FROM 'r' THEN
    RETURN; -- already partitioned (or absent: schema.sql owns the fresh shape)
  END IF;

  IF EXISTS (SELECT 1 FROM sales_invoices WHERE invoice_date_ad IS NULL) THEN
    RAISE EXCEPTION 'sales_invoices holds rows without invoice_date_ad; the partition date cannot be NULL, so the conversion aborts instead of routing them to DEFAULT';
  END IF;

  CREATE TEMP TABLE scale3_invoices_stage ON COMMIT DROP AS SELECT * FROM sales_invoices;

  -- CHECK, FOREIGN KEY and named NOT NULL constraints, minus the primary key and
  -- the invoice_number unique (the registry takes that role).
  CREATE TEMP TABLE scale3_invoices_cons ON COMMIT DROP AS
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'sales_invoices'::regclass
       AND contype IN ('c', 'f', 'n');

  DROP TABLE sales_invoices;

  CREATE TABLE sales_invoices (
    id VARCHAR(50),
    invoice_number VARCHAR(100),
    customer_id VARCHAR(50),
    customer_name VARCHAR(200),
    branch_id VARCHAR(50),
    invoice_date_ad DATE,
    invoice_date_bs VARCHAR(20),
    bill_terms_id VARCHAR(50),
    due_date_ad DATE,
    due_date_bs VARCHAR(20),
    area_id VARCHAR(50),
    area_name VARCHAR(150),
    agent_id VARCHAR(50),
    agent_name VARCHAR(150),
    taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    vat_amount NUMERIC(14, 2) DEFAULT 0.00,
    non_taxable_amount NUMERIC(14, 2) DEFAULT 0.00,
    grand_total NUMERIC(14, 2) DEFAULT 0.00,
    payment_status VARCHAR(30) DEFAULT 'UNPAID',
    status VARCHAR(30) DEFAULT 'POSTED',
    payment_method VARCHAR(30) DEFAULT 'CREDIT',
    amount_paid NUMERIC(14, 2) DEFAULT 0.00,
    notes TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    fiscal_year_id VARCHAR(50),
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    created_by VARCHAR(150),
    updated_by VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  ) PARTITION BY RANGE (invoice_date_ad);

  FOR v_row IN SELECT conname, def FROM scale3_invoices_cons ORDER BY contype, conname LOOP
    EXECUTE format('ALTER TABLE sales_invoices ADD CONSTRAINT %I %s', v_row.conname, v_row.def);
  END LOOP;
  ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_pkey PRIMARY KEY (id, invoice_date_ad);

  FOR v_month IN SELECT DISTINCT date_trunc('month', invoice_date_ad)::date FROM scale3_invoices_stage LOOP
    PERFORM ensure_sales_invoice_month_partition(v_month);
  END LOOP;

  INSERT INTO sales_invoices (
    id, invoice_number, customer_id, customer_name, branch_id, invoice_date_ad,
    invoice_date_bs, bill_terms_id, due_date_ad, due_date_bs, area_id, area_name,
    agent_id, agent_name, taxable_amount, vat_amount, non_taxable_amount,
    grand_total, payment_status, status, payment_method, amount_paid, notes, items,
    fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  )
  SELECT
    id, invoice_number, customer_id, customer_name, branch_id, invoice_date_ad,
    invoice_date_bs, bill_terms_id, due_date_ad, due_date_bs, area_id, area_name,
    agent_id, agent_name, taxable_amount, vat_amount, non_taxable_amount,
    grand_total, payment_status, status, payment_method, amount_paid, notes, items,
    fiscal_year_id, is_demo, created_by, updated_by, created_at, updated_at
  FROM scale3_invoices_stage;

  -- Register the legacy numbers before the trigger exists (one set-based insert).
  INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
  SELECT 'SALES_INVOICE', 'PRIMARY', id, invoice_number, invoice_date_ad
    FROM scale3_invoices_stage;

  SELECT count(*) INTO v_legacy FROM scale3_invoices_stage;
  SELECT count(*) INTO v_new FROM sales_invoices;
  SELECT count(*) INTO v_numbers FROM scale3_invoices_stage WHERE invoice_number IS NOT NULL;
  SELECT count(*) INTO v_registered
    FROM document_identity_registry WHERE document_type = 'SALES_INVOICE' AND key_role = 'PRIMARY';
  IF v_new <> v_legacy THEN
    RAISE EXCEPTION 'sales_invoices conversion lost rows: % legacy, % partitioned', v_legacy, v_new;
  END IF;
  IF v_registered <> v_numbers THEN
    RAISE EXCEPTION 'sales_invoices registered % invoice numbers for % rows', v_registered, v_numbers;
  END IF;

  DROP TABLE scale3_invoices_stage;
END $$;

-- ---------------------------------------------------------------------------
-- DEFAULT child, indexes, triggers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_invoices_default PARTITION OF sales_invoices DEFAULT;

CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer ON sales_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch ON sales_invoices(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_bill_terms ON sales_invoices(bill_terms_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_area ON sales_invoices(area_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_agent ON sales_invoices(agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_date ON sales_invoices(invoice_date_ad);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_demo ON sales_invoices(id) WHERE is_demo = TRUE;
CREATE INDEX IF NOT EXISTS idx_sales_invoices_number_trgm
  ON sales_invoices USING gin (lower(invoice_number) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer_trgm
  ON sales_invoices USING gin (lower(customer_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_page_all ON sales_invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch_page ON sales_invoices (branch_id, created_at DESC);

CREATE OR REPLACE TRIGGER trg_sales_invoices_fiscal_year
  BEFORE INSERT OR UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION assign_fiscal_year_id_from_date('invoice_date_ad');

CREATE OR REPLACE TRIGGER trg_sales_invoices_identity
  BEFORE INSERT OR UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION enforce_document_identity(
    'SALES_INVOICE', 'invoice_date_ad',
    'PRIMARY:invoice_number:fixed:refuse');

-- ---------------------------------------------------------------------------
-- The registry becomes the referential anchor for the three inbound keys
-- ---------------------------------------------------------------------------

ALTER TABLE sales_returns
  ADD COLUMN IF NOT EXISTS original_invoice_document_type VARCHAR(40) NOT NULL DEFAULT 'SALES_INVOICE';
ALTER TABLE sales_returns
  ADD COLUMN IF NOT EXISTS original_invoice_key_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY';
ALTER TABLE sales_returns
  DROP CONSTRAINT IF EXISTS sales_returns_original_invoice_fk;
ALTER TABLE sales_returns
  ADD CONSTRAINT sales_returns_original_invoice_fk
  FOREIGN KEY (original_invoice_document_type, original_invoice_key_role, original_invoice_id)
  REFERENCES document_identity_registry (document_type, key_role, id)
  ON DELETE SET NULL (original_invoice_id);

ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS invoice_document_type VARCHAR(40) NOT NULL DEFAULT 'SALES_INVOICE';
ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS invoice_key_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY';
ALTER TABLE customer_payments
  DROP CONSTRAINT IF EXISTS customer_payments_invoice_fk;
ALTER TABLE customer_payments
  ADD CONSTRAINT customer_payments_invoice_fk
  FOREIGN KEY (invoice_document_type, invoice_key_role, invoice_id)
  REFERENCES document_identity_registry (document_type, key_role, id)
  ON DELETE SET NULL (invoice_id);

ALTER TABLE customer_payment_allocations
  ADD COLUMN IF NOT EXISTS invoice_document_type VARCHAR(40) NOT NULL DEFAULT 'SALES_INVOICE';
ALTER TABLE customer_payment_allocations
  ADD COLUMN IF NOT EXISTS invoice_key_role VARCHAR(20) NOT NULL DEFAULT 'PRIMARY';
ALTER TABLE customer_payment_allocations
  DROP CONSTRAINT IF EXISTS customer_payment_allocations_invoice_fk;
ALTER TABLE customer_payment_allocations
  ADD CONSTRAINT customer_payment_allocations_invoice_fk
  FOREIGN KEY (invoice_document_type, invoice_key_role, invoice_id)
  REFERENCES document_identity_registry (document_type, key_role, id)
  ON DELETE RESTRICT;
