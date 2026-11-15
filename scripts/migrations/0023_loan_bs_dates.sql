-- LEND-1 follow-up: loan agreements carry both calendars.
--
-- 0022 created loans with AD-only start/maturity dates. The finance dual-date
-- guard now requires the BS half, so existing installs need the columns
-- backfilled from the seeded BS calendar before the start date becomes NOT NULL.

ALTER TABLE loans ADD COLUMN IF NOT EXISTS start_date_bs VARCHAR(20);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS maturity_date_bs VARCHAR(20);

UPDATE loans l
SET start_date_bs = COALESCE(
        (SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = l.start_date_ad),
        'BS not seeded'
    )
WHERE l.start_date_bs IS NULL OR l.start_date_bs = '';

UPDATE loans l
SET maturity_date_bs = COALESCE(
        (SELECT b.bs_date || ' BS' FROM bs_day_records b WHERE b.ad_date = l.maturity_date_ad),
        'BS not seeded'
    )
WHERE l.maturity_date_ad IS NOT NULL
  AND (l.maturity_date_bs IS NULL OR l.maturity_date_bs = '');

ALTER TABLE loans ALTER COLUMN start_date_bs SET NOT NULL;

ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_maturity_bs_pair;
ALTER TABLE loans ADD CONSTRAINT loans_maturity_bs_pair CHECK (
    (maturity_date_ad IS NULL AND maturity_date_bs IS NULL)
    OR (maturity_date_ad IS NOT NULL AND maturity_date_bs IS NOT NULL)
);
