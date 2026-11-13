-- Warranty claim lifecycle dates are operational dual dates. New writes derive
-- the BS half with bsDateOrThrow; this migration adds the pair columns and
-- backfills only from an existing bs_day_records row (never a guessed date).

ALTER TABLE warranty_claims
  ADD COLUMN IF NOT EXISTS sent_to_vendor_date_bs VARCHAR(20),
  ADD COLUMN IF NOT EXISTS resolved_date_bs VARCHAR(20),
  ADD COLUMN IF NOT EXISTS closed_date_bs VARCHAR(20);

UPDATE warranty_claims c
   SET sent_to_vendor_date_bs = d.bs_date || ' BS'
  FROM bs_day_records d
 WHERE d.ad_date = c.sent_to_vendor_date_ad
   AND c.sent_to_vendor_date_bs IS NULL;

UPDATE warranty_claims c
   SET resolved_date_bs = d.bs_date || ' BS'
  FROM bs_day_records d
 WHERE d.ad_date = c.resolved_date_ad
   AND c.resolved_date_bs IS NULL;

UPDATE warranty_claims c
   SET closed_date_bs = d.bs_date || ' BS'
  FROM bs_day_records d
 WHERE d.ad_date = c.closed_date_ad
   AND c.closed_date_bs IS NULL;
