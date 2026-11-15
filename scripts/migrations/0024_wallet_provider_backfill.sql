-- CASH-1 follow-up: existing clearing accounts predate provider metadata.
--
-- The default chart names the provider on each wallet clearing account, but
-- ensureDefaultChart is deliberately additive and never updates an existing
-- code. An installation that already had 1030/1040/1050 therefore kept a NULL
-- provider_code and every wallet receipt was refused as "belongs to no
-- provider". Backfill only the three canonical clearing codes; an operator's
-- custom wallet account is untouched.

UPDATE gl_accounts
SET provider_code = 'ESEWA'
WHERE code = '1030' AND account_kind = 'WALLET' AND provider_code IS NULL;

UPDATE gl_accounts
SET provider_code = 'KHALTI'
WHERE code = '1040' AND account_kind = 'WALLET' AND provider_code IS NULL;

UPDATE gl_accounts
SET provider_code = 'NEPAL_PAY'
WHERE code = '1050' AND account_kind = 'WALLET' AND provider_code IS NULL;
