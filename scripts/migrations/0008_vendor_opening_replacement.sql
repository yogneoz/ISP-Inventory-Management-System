-- Vendor opening saves follow the stock-opening replacement contract: the
-- register rows and the journal are written together, and a re-save posts a
-- linked reversal before the current supplier balances. Exclude their stable
-- source id from the branch/date unique guard; every other OPENING_BALANCE
-- source still keeps the one-per-branch-and-date rule.
DROP INDEX IF EXISTS uq_gl_journals_opening_balance;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_journals_opening_balance
  ON gl_journals(branch_id, journal_date_ad)
  WHERE source_type = 'OPENING_BALANCE'
    AND COALESCE(source_id, '') NOT LIKE 'stock-opening:%'
    AND COALESCE(source_id, '') NOT LIKE 'vendor-opening:%';
