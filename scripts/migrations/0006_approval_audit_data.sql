-- Approval requests store the stock-audit variance payload on the request row.
-- It is deliberately JSONB rather than a second audit table: the payload is
-- submitted and consumed as one immutable approval snapshot, and the approval
-- processor already reads the rest of that snapshot from this table.
--
-- There is no backfill: historical rows only ever held this data in process
-- memory, so inventing values would be worse than NULL. New submissions always
-- write it through arInsertParams().
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS audit_data JSONB;
