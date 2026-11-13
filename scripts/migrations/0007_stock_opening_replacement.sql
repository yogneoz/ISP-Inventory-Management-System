-- Opening-stock saves are replaceable: the register and its journal are written
-- together, and a re-save posts a linked reversal of the prior stock opening
-- before the current valuation (same stable source id, same earliest open
-- date). The branch/date unique guard must therefore exclude stock openings;
-- every other OPENING_BALANCE source keeps the one-per-branch-and-date rule.
DROP INDEX IF EXISTS uq_gl_journals_opening_balance;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_journals_opening_balance
  ON gl_journals(branch_id, journal_date_ad)
  WHERE source_type = 'OPENING_BALANCE'
    AND COALESCE(source_id, '') NOT LIKE 'stock-opening:%';
