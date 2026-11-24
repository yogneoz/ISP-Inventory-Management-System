/**
 * The accounting outbox.
 *
 * An approved expense claim is a liability the ledger owes. This service makes
 * that a recorded fact rather than an implication:
 *
 *   submit  -> PENDING_APPROVAL (nothing may post before a supervisor agrees)
 *   approve -> QUEUED           (the posting is owed)
 *   reject  -> CANCELLED        (nothing is owed)
 *   flush   -> POSTED           (the journal exists: `journal_id`, `journal_no`)
 *              FAILED           (the attempt raised: `last_error`, `attempts`)
 *
 * The flusher is deliberately per-row: a posting that raises must not poison the
 * transaction of the rows beside it, so each claim posts in its own transaction
 * and a failure is recorded in a second, short one. The journal's own
 * `source_type`/`source_id` probe makes a crash between the journal commit and
 * the status write harmless — the next run finds the journal and marks the row
 * POSTED instead of posting twice.
 *
 * Accounts are resolved from the chart's posting roles (`SALARY_EXPENSE` debit,
 * `SALARY_PAYABLE` credit). A chart without them fails the row loudly with the
 * remedy named; it never guesses an account.
 */
import { pgPool } from '../../db';
import { withTransaction } from '../db/transactions';
import { ApiError } from '../errors/ApiError';
import { businessDateAD } from '../../../shared/businessDate';
import { ACCOUNTS_BY_POSTING_ROLES_SQL, JOURNAL_SOURCE_EXISTS_SQL } from '../models/accounting.repo';
import {
  OUTBOX_CANCEL_SQL,
  OUTBOX_CLAIM_QUEUED_SQL,
  OUTBOX_ENQUEUE_CLAIM_SQL,
  OUTBOX_FOR_SOURCE_SQL,
  OUTBOX_LIST_SQL,
  OUTBOX_MARK_FAILED_SQL,
  OUTBOX_MARK_POSTED_SQL,
  OUTBOX_PENDING_COUNT_SQL,
  OUTBOX_QUEUE_APPROVED_SQL,
} from '../models/accountingOutbox.repo';
import { postJournal } from './accounting.service';

export type AccountingOutboxStatus =
  | 'PENDING_APPROVAL'
  | 'QUEUED'
  | 'POSTED'
  | 'FAILED'
  | 'CANCELLED';

export interface ClaimPostingInput {
  claimId: string;
  employeeId: string;
  employeeName: string | null;
  branchId: string;
  amount: number;
  currency: string;
  category: string;
  description: string | null;
}

const MAX_ATTEMPTS = 10;

/** Queue the claim for accounting at submission; it may not post yet. */
export async function enqueueExpenseClaimOutbox(
  client: any,
  input: ClaimPostingInput
): Promise<AccountingOutboxStatus> {
  const inserted = (
    await client.query(OUTBOX_ENQUEUE_CLAIM_SQL, [
      input.claimId,
      input.branchId,
      input.amount,
      input.currency,
      JSON.stringify({
        employeeId: input.employeeId,
        employeeName: input.employeeName,
        category: input.category,
        description: input.description,
      }),
    ])
  ).rows[0];
  if (inserted) return inserted.status as AccountingOutboxStatus;
  // A re-sent claim (same id) keeps its existing row and status.
  const existing = (await client.query(OUTBOX_FOR_SOURCE_SQL, [input.claimId])).rows[0];
  return (existing?.status as AccountingOutboxStatus) || 'PENDING_APPROVAL';
}

/** Approval: the owed posting becomes flusher work. */
export async function queueExpenseClaimPosting(
  client: any,
  claimId: string
): Promise<AccountingOutboxStatus | null> {
  const row = (await client.query(OUTBOX_QUEUE_APPROVED_SQL, [claimId])).rows[0];
  if (row) return row.status as AccountingOutboxStatus;
  const existing = (await client.query(OUTBOX_FOR_SOURCE_SQL, [claimId])).rows[0];
  return (existing?.status as AccountingOutboxStatus) || null;
}

/** Rejection or withdrawal: nothing is owed. */
export async function cancelExpenseClaimPosting(
  client: any,
  claimId: string
): Promise<AccountingOutboxStatus | null> {
  const row = (await client.query(OUTBOX_CANCEL_SQL, [claimId])).rows[0];
  if (row) return row.status as AccountingOutboxStatus;
  const existing = (await client.query(OUTBOX_FOR_SOURCE_SQL, [claimId])).rows[0];
  return (existing?.status as AccountingOutboxStatus) || null;
}

export async function accountingOutboxStatus(claimId: string): Promise<AccountingOutboxStatus | null> {
  const row = (await pgPool.query(OUTBOX_FOR_SOURCE_SQL, [claimId])).rows[0];
  return (row?.status as AccountingOutboxStatus) || null;
}

export interface OutboxFlushResult {
  posted: number;
  failed: number;
  remaining: number;
  errors: Array<{ id: string; message: string }>;
}

interface PostingAccountRow {
  id: string;
  code: string;
  postingRole: string | null;
  isControl: boolean;
  subledgerType: string;
}

/**
 * Post one queued claim. Runs in the caller's transaction; a chart that cannot
 * name both roles refuses with the remedy, which the flusher records on the row.
 */
async function postQueuedClaim(client: any, row: any): Promise<{ id: string; journalNo: string | null }> {
  const already = (
    await client.query(JOURNAL_SOURCE_EXISTS_SQL, [row.source_type, row.source_id])
  ).rows[0];
  if (already) return { id: already.id, journalNo: null };

  const accounts = (
    await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['SALARY_EXPENSE', 'SALARY_PAYABLE']])
  ).rows as PostingAccountRow[];
  const expense = accounts.find((account) => account.postingRole === 'SALARY_EXPENSE');
  const payable = accounts.find((account) => account.postingRole === 'SALARY_PAYABLE');
  if (!expense || !payable) {
    throw new ApiError(
      400,
      'Accounting is not configured for expense claims: map the SALARY_EXPENSE and SALARY_PAYABLE posting roles, then flush the outbox again.'
    );
  }

  const payload = (row.payload || {}) as Record<string, any>;
  const amount = Number(row.amount);
  const memo = `Expense claim ${row.source_id} (${payload.category || 'GENERAL'})`;
  const credit: Record<string, any> = { accountId: payable.id, debit: 0, credit: amount, memo };
  // A payable ledger that carries an EMPLOYEE subledger names the person owed.
  if (payable.isControl && payable.subledgerType === 'EMPLOYEE' && payload.employeeId) {
    credit.subledgerType = 'EMPLOYEE';
    credit.partyId = String(payload.employeeId);
    credit.partyName = payload.employeeName ? String(payload.employeeName) : undefined;
  }

  const journal = await postJournal(client, {
    journalDateAD: businessDateAD(),
    branchId: row.branch_id,
    memo,
    sourceType: row.source_type,
    sourceId: row.source_id,
    voucherType: 'JOURNAL',
    lines: [{ accountId: expense.id, debit: amount, credit: 0, memo }, credit],
    actor: 'accounting-outbox',
  });
  return { id: journal.id, journalNo: journal.journalNo };
}

/**
 * Apply every owed posting. Each row is its own transaction: one broken claim
 * records FAILED without rolling back the ones beside it.
 */
export async function flushAccountingOutbox(
  options: { limit?: number; branchId?: string } = {}
): Promise<OutboxFlushResult> {
  const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 50), 1), 200);
  const rows = (await pgPool.query(OUTBOX_CLAIM_QUEUED_SQL, [limit, options.branchId || null])).rows;
  let posted = 0;
  let failed = 0;
  const errors: Array<{ id: string; message: string }> = [];

  for (const row of rows) {
    try {
      const journal = await withTransaction((client) => postQueuedClaim(client, row));
      await pgPool.query(OUTBOX_MARK_POSTED_SQL, [row.id, journal.id, journal.journalNo]);
      posted += 1;
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 500);
      await pgPool.query(OUTBOX_MARK_FAILED_SQL, [row.id, message]);
      failed += 1;
      errors.push({ id: row.id, message });
    }
  }

  const remaining = Number(
    (await pgPool.query(OUTBOX_PENDING_COUNT_SQL, [options.branchId || null])).rows[0]?.count || 0
  );
  return { posted, failed, remaining, errors };
}

export async function listAccountingOutbox(options: {
  status?: string;
  limit?: number;
}): Promise<any[]> {
  const limit = Math.min(Math.max(Math.trunc(Number(options.limit) || 50), 1), 200);
  return (await pgPool.query(OUTBOX_LIST_SQL, [options.status || null, limit])).rows;
}

/** The attempts ceiling, exported so a test can pin it without duplicating it. */
export const ACCOUNTING_OUTBOX_MAX_ATTEMPTS = MAX_ATTEMPTS;
