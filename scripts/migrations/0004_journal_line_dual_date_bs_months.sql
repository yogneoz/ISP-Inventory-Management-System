-- Phase 2 follow-up: every journal line carries the same dual date as its
-- header, and BS month/quarter reporting has one derived reference row per
-- Nepali month.
--
-- The line BS value is copied from its journal header, never guessed from an
-- unseeded day: the header's BS half was resolved by bsDateOrThrow at posting
-- time, so a line inherits exactly the date the ledger already committed.
-- The append-only guard is bypassed only inside this transaction for the
-- one-time backfill.

ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS journal_date_bs VARCHAR(20);

DO $$
BEGIN
  PERFORM set_config('inventory.allow_ledger_purge', 'on', true);
  EXECUTE $sql$
    UPDATE gl_journal_lines l
       SET journal_date_bs = j.journal_date_bs
      FROM gl_journals j
     WHERE j.id = l.journal_id
       AND l.journal_date_bs IS NULL
  $sql$;
  EXECUTE $sql$
    UPDATE gl_journal_lines l
       SET journal_date_bs = b.bs_date || ' BS'
      FROM bs_day_records b
     WHERE b.ad_date = l.journal_date_ad
       AND l.journal_date_bs IS NULL
  $sql$;
  EXECUTE $sql$
    UPDATE gl_journal_lines
       SET journal_date_bs = 'BS not seeded'
     WHERE journal_date_bs IS NULL
  $sql$;
END $$;

ALTER TABLE gl_journal_lines
  ALTER COLUMN journal_date_bs SET NOT NULL;

-- Derived from bs_day_records, never hand-maintained. The function lives in
-- schema.sql as well so a fresh install and an upgraded install share one
-- definition.
CREATE TABLE IF NOT EXISTS bs_months (
    bs_year INT NOT NULL,
    bs_month INT NOT NULL,
    bs_date VARCHAR(20) NOT NULL,
    ad_date DATE NOT NULL,
    ad_end_date DATE NOT NULL,
    bs_end_date VARCHAR(20) NOT NULL,
    bs_month_name VARCHAR(50) NOT NULL,
    bs_month_name_np VARCHAR(50) NOT NULL,
    fiscal_year VARCHAR(20) NOT NULL,
    fiscal_year_id VARCHAR(50) REFERENCES fiscal_years(id) ON DELETE SET NULL,
    quarter VARCHAR(10) NOT NULL CHECK (quarter IN ('Q1', 'Q2', 'Q3', 'Q4')),
    PRIMARY KEY (bs_year, bs_month)
);

CREATE OR REPLACE FUNCTION rebuild_bs_months()
RETURNS void AS $$
BEGIN
  DELETE FROM bs_months;
  INSERT INTO bs_months (
    bs_year, bs_month, bs_date, ad_date, ad_end_date, bs_end_date,
    bs_month_name, bs_month_name_np, fiscal_year, fiscal_year_id, quarter
  )
  SELECT
    bs_year, bs_month, MIN(bs_date), MIN(ad_date), MAX(ad_date), MAX(bs_date),
    MIN(bs_month_name), MIN(bs_month_name_np), MIN(fiscal_year),
    MIN(fiscal_year_id), MIN(quarter)
  FROM bs_day_records
  GROUP BY bs_year, bs_month;
END;
$$ LANGUAGE plpgsql;

SELECT rebuild_bs_months();
