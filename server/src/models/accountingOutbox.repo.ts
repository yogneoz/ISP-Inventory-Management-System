/**
 * The accounting outbox — every SQL the queue runs.
 *
 * A claim owes at most one posting: the unique `(source_type, source_id)` is the
 * contract, and the flusher's journal-source probe makes a crash between the
 * journal commit and the status write harmless (the next run finds the journal
 * and marks the row POSTED instead of posting a second one).
 */

export const OUTBOX_COLUMNS = `
  id, source_type, source_id, branch_id, status, amount, currency, payload,
  attempts, last_error, journal_id, journal_no, queued_at, posted_at,
  created_at, updated_at`;

/**
 * A submitted claim is queued for accounting but may not post yet. A re-send of
 * the same claim keeps the original row (the claim id is stable), so a retry
 * cannot owe a second posting.
 */
export const OUTBOX_ENQUEUE_CLAIM_SQL = `
  INSERT INTO accounting_outbox (source_type, source_id, branch_id, amount, currency, payload)
  VALUES ('EXPENSE_CLAIM', $1, $2, $3, $4, $5::jsonb)
  ON CONFLICT (source_type, source_id) DO NOTHING
  RETURNING ${OUTBOX_COLUMNS}`;

export const OUTBOX_FOR_SOURCE_SQL = `
  SELECT ${OUTBOX_COLUMNS}
    FROM accounting_outbox
   WHERE source_type = 'EXPENSE_CLAIM' AND source_id = $1`;

/** Approval turns the owed posting into work for the flusher, once. */
export const OUTBOX_QUEUE_APPROVED_SQL = `
  UPDATE accounting_outbox
     SET status = 'QUEUED', queued_at = now(), updated_at = now()
   WHERE source_type = 'EXPENSE_CLAIM' AND source_id = $1
     AND status IN ('PENDING_APPROVAL', 'FAILED')
  RETURNING ${OUTBOX_COLUMNS}`;

/** Rejection (or a withdrawn claim) cancels the posting instead of queuing it. */
export const OUTBOX_CANCEL_SQL = `
  UPDATE accounting_outbox
     SET status = 'CANCELLED', updated_at = now()
   WHERE source_type = 'EXPENSE_CLAIM' AND source_id = $1
     AND status IN ('PENDING_APPROVAL', 'QUEUED', 'FAILED')
  RETURNING ${OUTBOX_COLUMNS}`;

/**
 * Oldest work first. `attempts < 10` parks a permanently broken posting for a
 * human instead of retrying it forever; `read-models:pending`-style observability
 * is what makes those rows visible.
 */
export const OUTBOX_CLAIM_QUEUED_SQL = `
  SELECT ${OUTBOX_COLUMNS}
    FROM accounting_outbox
   WHERE status IN ('QUEUED', 'FAILED')
     AND attempts < 10
     AND ($2::text IS NULL OR branch_id = $2)
   ORDER BY queued_at ASC NULLS LAST, created_at ASC
   LIMIT $1`;

export const OUTBOX_MARK_POSTED_SQL = `
  UPDATE accounting_outbox
     SET status = 'POSTED', journal_id = $2, journal_no = $3,
         posted_at = COALESCE(posted_at, now()), last_error = NULL, updated_at = now()
   WHERE id = $1
  RETURNING ${OUTBOX_COLUMNS}`;

export const OUTBOX_MARK_FAILED_SQL = `
  UPDATE accounting_outbox
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2, updated_at = now()
   WHERE id = $1
  RETURNING ${OUTBOX_COLUMNS}`;

export const OUTBOX_PENDING_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
    FROM accounting_outbox
   WHERE status IN ('QUEUED', 'FAILED') AND attempts < 10
     AND ($1::text IS NULL OR branch_id = $1)`;

export const OUTBOX_LIST_SQL = `
  SELECT ${OUTBOX_COLUMNS}
    FROM accounting_outbox
   WHERE ($1::text IS NULL OR status = $1)
   ORDER BY created_at DESC
   LIMIT $2`;
