-- SCALE-3 (worklist item: page-read indexes + BRIN).
--
-- Every register pages newest-first on `(created_at, id)` or
-- `(entry_date_ad, id)` descending, and every one of those reads is branch- or
-- range-scoped. The indexes these reads already had stopped at the date column
-- (`(branch_id, created_at DESC)`, `(branch_id, timestamp_ad DESC)`), so a
-- keyset page `ORDER BY created_at DESC, id DESC LIMIT 51` still needed a Sort
-- on top of the index scan whenever two rows shared a timestamp — which bulk
-- imports produce by the thousand. Adding the `id` tie-breaker to the same
-- composite lets the index produce the page order directly.
--
-- The BRIN half is for the append-only tables. They are written in date order,
-- so the heap is physically correlated with the date column and one summary per
-- block range can skip months of blocks on a range read. BRIN cannot produce
-- ordering, so every B-tree that a page read sorts with stays; BRIN only earns
-- its space on wide range reads (year-end reports, retention sweeps).
--
-- Dropped here, after measuring (`scripts/measure_page_read_indexes.mjs`): the
-- three narrower page indexes the composites above replace. Each old index is an
-- exact prefix of its replacement, so no plan can prefer it.
--
-- Idempotent: DROP/CREATE IF (NOT) EXISTS, so re-running this file is a no-op and
-- a fresh install (where schema.sql already declares the final set) converges.
--
-- Partitioned parents: CREATE INDEX on the parent builds the partitioned index
-- and every existing child; future children inherit the definition from the
-- parent, which is why these must be created on the parent and never per month.

-- 1. Page reads: newest-first keyset, with the `id` tie-breaker the cursor uses.
CREATE INDEX IF NOT EXISTS idx_sales_invoices_branch_page_id
  ON sales_invoices (branch_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ops_branch_page_id
  ON stock_operations (branch_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_branch_timestamp_id
  ON audit_logs (branch_id, timestamp_ad DESC, id DESC);
-- The subledger book ledger pages `ORDER BY entry_date_ad DESC, id DESC` with an
-- optional branch and a date range. The range is the selective predicate, so the
-- date leads and the branch is a heap filter on the few matching ranges.
CREATE INDEX IF NOT EXISTS idx_gl_subledger_date_page
  ON gl_subledger_entries (entry_date_ad DESC, id DESC);

-- 2. The narrower page indexes the composites replace (exact prefixes).
DROP INDEX IF EXISTS idx_sales_invoices_branch_page;
DROP INDEX IF EXISTS idx_stock_ops_branch_page;
DROP INDEX IF EXISTS idx_audit_branch_timestamp;

-- 3. BRIN on the append-only dates. `pages_per_range` stays at the default 128
--    for the same reason as 0031: tuning it to today's row count would bake a
--    development number into the schema.
--
--    Each BRIN carries `id` as a second column. That is not for pruning — the
--    date leads and is the only summary a range read checks — but because
--    PostgreSQL derives a partition child's index name from the child table and
--    the column list, so a one-column BRIN on `created_at` collides with the
--    existing `(created_at DESC)` B-tree's derived name and the `_idx`/`_idx1`
--    suffix then depends on creation order. Fresh installs and upgrades created
--    them in a different order and the schema comparison caught the swap. The
--    tie-breaker column makes every derived name unique, so both paths agree.
CREATE INDEX IF NOT EXISTS idx_gl_journals_date_brin
  ON gl_journals USING brin (journal_date_ad, id);
CREATE INDEX IF NOT EXISTS idx_gl_subledger_entry_date_brin
  ON gl_subledger_entries USING brin (entry_date_ad, id);
CREATE INDEX IF NOT EXISTS idx_stock_ops_date_brin
  ON stock_operations USING brin (date_ad, id);
CREATE INDEX IF NOT EXISTS idx_serial_log_created_brin
  ON serial_log USING brin (created_at, id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_brin
  ON sales_invoices USING brin (created_at, id);
