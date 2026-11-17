-- SCALE-3 (first slice): storage parameters for the two tables every document
-- rewrites.
--
-- `document_sequence_daily` gets one UPDATE per issued document and
-- `inventory_stock` one per stock movement: both are small tables that are
-- rewritten constantly, and both ran on PostgreSQL defaults — a 0.20 vacuum
-- scale factor (on a 4,000-row table vacuum waits for 800 dead tuples) and
-- fillfactor 100. The autovacuum thresholds are the lever that unambiguously
-- applies to tables this size.
--
-- `fillfactor = 80` keeps free space on each page so an UPDATE that touches no
-- indexed column is stored in place (HOT) instead of moving the tuple and
-- inserting into every index. That is the whole story for
-- `document_sequence_daily`, whose counter column is not indexed. It is only
-- partial for `inventory_stock`: the dominant movement UPDATE sets
-- `quantity_on_hand`, which `idx_stock_reorder` covers, so that update cannot be
-- HOT at any fillfactor — the padding still avoids heap page splits and covers
-- the non-indexed columns (`damaged_qty`, `incoming_qty`, `last_updated`).
-- Making that update HOT would take a smaller `idx_stock_reorder` (partial on the
-- reorder predicate), which is an index-design change, not a storage one.
--
-- Storage parameters apply to new writes and are idempotent, so this needs no
-- table rewrite and is safe to re-run.
--
-- The same statements live in scripts/schema.sql for a fresh install; this file
-- is what reaches a database that already recorded its baseline.
ALTER TABLE document_sequence_daily SET (
    fillfactor = 80,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE inventory_stock SET (
    fillfactor = 80,
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_analyze_scale_factor = 0.05
);
