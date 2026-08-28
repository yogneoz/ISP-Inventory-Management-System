-- Baseline marker migration.
-- Full schema is still created by server/lib/dbBootstrap.ts (CREATE TABLE IF NOT EXISTS).
-- Future incremental changes should land here as 002_*.sql, 003_*.sql, etc.
--
-- Example future migration:
--   ALTER TABLE products ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100);
--
SELECT 1;
