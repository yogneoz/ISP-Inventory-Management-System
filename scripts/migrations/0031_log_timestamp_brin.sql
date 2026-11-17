-- SCALE-3 (audit item 4): BRIN on the two append-only log timestamps.
--
-- audit_logs and transaction_logs are insert-only and appended in time order, so
-- their heap is physically correlated with timestamp_ad. A BRIN index stores one
-- summary per block range instead of one entry per row: it stays a few pages wide
-- on a table that grows without bound, and a date-range scan can skip the blocks
-- outside the range.
--
-- The existing B-trees (idx_audit_timestamp, idx_txn_timestamp) STAY. They are
-- not redundant: the audit-trail and transaction listings page by
-- `ORDER BY timestamp_ad DESC ... LIMIT`, and BRIN cannot produce ordering. The
-- measured plans with the B-tree disabled are recorded in
-- docs/database-optimization-audit-2026-11-17.md.
--
-- pages_per_range is left at PostgreSQL's default (128). At today's table sizes
-- the index is a handful of ranges, which is exactly the point: it is cheap
-- insurance that costs nothing to carry until the tables are large enough for the
-- planner to prefer it. Tuning pages_per_range to today's row count would bake a
-- development number into the schema.
--
-- Idempotent: IF NOT EXISTS, so re-running this file is a no-op.
--
-- The high-update half of item 4 (fillfactor 80 + autovacuum scale factor 0.02 on
-- inventory_stock and document_sequence_daily) is applied by 0030 and lives in
-- schema.sql for fresh installs; it is not repeated here.
CREATE INDEX IF NOT EXISTS idx_audit_timestamp_brin
  ON audit_logs USING brin (timestamp_ad);

CREATE INDEX IF NOT EXISTS idx_txn_timestamp_brin
  ON transaction_logs USING brin (timestamp_ad);
