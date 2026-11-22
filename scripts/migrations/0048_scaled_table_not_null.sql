-- SCALE-3 repair: the four partition conversions left their tables nullable on
-- PostgreSQL 16 and 17.
--
-- 0034 (gl_subledger_entries), 0035 (stock_operations), 0036 (serial_log) and
-- 0039 (sales_invoices) each rebuild their table as a shadow copy and then
-- stage the old constraints back onto it. They stage rows of pg_constraint only
-- — CHECK ('c'), FOREIGN KEY ('f') and named NOT NULL ('n', a PostgreSQL 18
-- feature). On 16 and 17 a NOT NULL is not a constraint, it is the
-- pg_attribute.attnotnull flag, so nothing staged it: every NOT NULL except the
-- primary key the migration adds itself disappeared from the upgraded table. A
-- fresh install keeps them (scripts/schema.sql declares them inline), so an
-- upgraded database accepted rows a new one refuses — a subledger line with a
-- null account, branch or amount, a register row with a null document date.
--
-- 0032 already replays attnotnull for audit_logs and transaction_logs; this is
-- the same repair for the four SCALE-3 parents.
--
-- The column sets are exactly the columns these tables carried as NOT NULL
-- before their conversion (verified against the schema of the release the
-- upgrade starts from), so every row already satisfies them and this migration
-- cannot fail on existing data. SET NOT NULL is a no-op where the flag is
-- already set, so the statement is safe to replay.

ALTER TABLE gl_subledger_entries
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN journal_id SET NOT NULL,
    ALTER COLUMN journal_line_id SET NOT NULL,
    ALTER COLUMN account_id SET NOT NULL,
    ALTER COLUMN subledger_type SET NOT NULL,
    ALTER COLUMN branch_id SET NOT NULL,
    ALTER COLUMN entry_date_ad SET NOT NULL,
    ALTER COLUMN entry_date_bs SET NOT NULL,
    ALTER COLUMN debit SET NOT NULL,
    ALTER COLUMN credit SET NOT NULL;

ALTER TABLE stock_operations
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN reference_number SET NOT NULL,
    ALTER COLUMN type SET NOT NULL,
    ALTER COLUMN reason SET NOT NULL,
    ALTER COLUMN date_ad SET NOT NULL,
    ALTER COLUMN date_bs SET NOT NULL,
    ALTER COLUMN is_demo SET NOT NULL;

ALTER TABLE serial_log
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN device_serial SET NOT NULL,
    ALTER COLUMN source_type SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN is_demo SET NOT NULL;

ALTER TABLE sales_invoices
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN invoice_number SET NOT NULL,
    ALTER COLUMN customer_name SET NOT NULL,
    ALTER COLUMN invoice_date_ad SET NOT NULL,
    ALTER COLUMN invoice_date_bs SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN is_demo SET NOT NULL;
