-- BAK-2/BAK-3 shared ledger assertions.
-- One row: company-wide totals, per-journal imbalances, deterministic
-- trial-balance checksum and net. The table-count comparison lives in
-- restore_verify.mjs / the drill and uses the same parent-only rule as BAK-1.
WITH balances AS (
  SELECT account_id, sum(debit - credit)::numeric(16, 2) AS balance
  FROM gl_journal_lines
  GROUP BY account_id
),
bad AS (
  SELECT journal_id
  FROM gl_journal_lines
  GROUP BY journal_id, journal_date_ad
  HAVING sum(debit) <> sum(credit)
),
posted_bad AS (
  SELECT j.id
  FROM gl_journals j
  LEFT JOIN gl_journal_lines l
    ON l.journal_id = j.id AND l.journal_date_ad = j.journal_date_ad
  WHERE j.status = 'POSTED'
  GROUP BY j.id
  HAVING COALESCE(sum(l.debit), 0) <> COALESCE(sum(l.credit), 0)
),
totals AS (
  SELECT COALESCE(sum(debit), 0)::text AS debit,
         COALESCE(sum(credit), 0)::text AS credit
  FROM gl_journal_lines
),
trial AS (
  SELECT md5(string_agg(account_id || ':' || balance::text,
                        '|' ORDER BY account_id COLLATE "C")) AS checksum,
         COALESCE(sum(balance), 0)::text AS net
  FROM balances
)
SELECT totals.debit,
       totals.credit,
       (SELECT count(*)::int FROM bad) AS imbalance_journals,
       (SELECT count(*)::int FROM posted_bad) AS posted_imbalance_journals,
       trial.checksum,
       trial.net
FROM totals, trial;
