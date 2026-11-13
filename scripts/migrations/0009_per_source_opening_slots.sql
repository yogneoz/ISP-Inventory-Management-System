-- The Opening Balances hub now posts one independent opening journal per
-- register (GL, Customers, Stock, Vendors) for the same branch. The old unique
-- journal index was branch/date-only, so it rejected a second register even
-- though the registers are unrelated. Posted originals stay immutable for the
-- audit trail, so "one active opening" cannot be a unique journal predicate
-- (a replacement must coexist with the original it reversed). The slot table
-- is the durable one-active-per-branch-per-register guard; the journal index
-- is lookup-only.
CREATE TABLE IF NOT EXISTS gl_opening_balance_slots (
    branch_id VARCHAR(50) NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    source_key VARCHAR(30) NOT NULL CHECK (source_key IN ('gl', 'customer', 'stock', 'vendor')),
    journal_id VARCHAR(50) NOT NULL REFERENCES gl_journals_registry(id) ON DELETE CASCADE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (branch_id, source_key),
    UNIQUE (journal_id)
);
-- A slot is not audit history; it follows any test-fixture purge of its
-- journal. Re-point the constraint on an environment that already ran an
-- earlier copy of this migration.
ALTER TABLE gl_opening_balance_slots
  DROP CONSTRAINT IF EXISTS gl_opening_balance_slots_journal_id_fkey;
ALTER TABLE gl_opening_balance_slots
  ADD CONSTRAINT gl_opening_balance_slots_journal_id_fkey
  FOREIGN KEY (journal_id) REFERENCES gl_journals_registry(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS uq_gl_journals_opening_balance;
CREATE INDEX IF NOT EXISTS idx_gl_journals_opening_balance
  ON gl_journals(branch_id, journal_date_ad, source_id)
  WHERE source_type = 'OPENING_BALANCE';

-- Backfill the active opening of every branch/register that already exists.
-- Pre-slot openings used the bare branch id as their source id. A legacy
-- opening with a customer subledger row belongs to Customers; everything else
-- is the GL/equity register. Stock and Vendor already carry their prefixes.
WITH active AS (
  SELECT
    j.id,
    j.branch_id,
    CASE
      WHEN j.source_id LIKE 'stock-opening:%' THEN 'stock'
      WHEN j.source_id LIKE 'vendor-opening:%' THEN 'vendor'
      WHEN j.source_id LIKE 'customer-opening:%' THEN 'customer'
      WHEN j.source_id LIKE 'gl-opening:%' THEN 'gl'
      WHEN EXISTS (
        SELECT 1 FROM gl_subledger_entries se
        WHERE se.journal_id = j.id AND se.subledger_type = 'CUSTOMER'
      ) THEN 'customer'
      ELSE 'gl'
    END AS source_key,
    ROW_NUMBER() OVER (
      PARTITION BY j.branch_id,
        CASE
          WHEN j.source_id LIKE 'stock-opening:%' THEN 'stock'
          WHEN j.source_id LIKE 'vendor-opening:%' THEN 'vendor'
          WHEN j.source_id LIKE 'customer-opening:%' THEN 'customer'
          WHEN j.source_id LIKE 'gl-opening:%' THEN 'gl'
          WHEN EXISTS (
            SELECT 1 FROM gl_subledger_entries se
            WHERE se.journal_id = j.id AND se.subledger_type = 'CUSTOMER'
          ) THEN 'customer'
          ELSE 'gl'
        END
      ORDER BY j.posted_at DESC, j.id DESC
    ) AS rn
  FROM gl_journals j
  WHERE j.source_type = 'OPENING_BALANCE'
    AND j.status = 'POSTED'
    AND NOT EXISTS (
      SELECT 1 FROM gl_journals r
      WHERE r.reversal_of_id = j.id AND r.status = 'POSTED'
    )
)
INSERT INTO gl_opening_balance_slots (branch_id, source_key, journal_id)
SELECT branch_id, source_key, id
FROM active
WHERE rn = 1
ON CONFLICT DO NOTHING;
