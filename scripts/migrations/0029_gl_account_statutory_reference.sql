-- The NFRS chart keeps each account's statutory reference as data.
--
-- `gl_accounts.description` is the operator note ("what belongs here, how it
-- posts"). The standard's own citation — NAS 16, NFRS 15, Nepal IRD VAT Act
-- 2052, SSF Act 2074 … — is a different fact and must not be buried in prose:
-- a trial balance, an audit working paper and the NFRS note mapping all need to
-- read it directly. Backfilling is left to `ensureDefaultChart`, which seeds the
-- full NFRS chart (codes, names, references and notes) idempotently on the next
-- boot; existing accounts keep whatever reference the operator set.
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS statutory_reference VARCHAR(160);
