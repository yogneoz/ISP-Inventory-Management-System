/**
 * Ledger foundation: opening balances and year-end closing.
 *
 * Both operations are orchestrations over `postJournal`, never a second write
 * path into the ledger. That is what keeps every invariant the journal service
 * already enforces — balanced lines, active accounts, control-account parties,
 * an open period and the fiscal-year membership — true for these entries too.
 *
 * Opening balances:
 *   - one posting per branch, into the earliest OPEN monthly period (or the
 *     earliest OPEN fiscal year's first month when no period exists yet);
 *   - a per-branch advisory lock plus a source-journal check make a concurrent
 *     or repeated request a 409 before anything is written;
 *   - control-account lines must carry the right subledger party, and an
 *     ordinary account must not carry one (postJournal enforces both).
 *
 * Year-end closing:
 *   - every branch's cumulative income/expense balance through the fiscal-year
 *     end is closed to the chart's RETAINED_EARNINGS account;
 *   - one journal per branch, all in the caller's transaction, followed by the
 *     fiscal-year is_closed flag — so a failure on any branch rolls the whole
 *     close back;
 *   - an existing YEAR_END_CLOSE journal is refused even if the year was
 *     reopened, so the close can never double-post.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { FY_CLOSE_SQL } from '../models/admin.repo';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  EARLIEST_OPEN_FISCAL_YEAR_SQL,
  EARLIEST_OPEN_PERIOD_SQL,
  FISCAL_YEAR_CLOSE_LOCK_SQL,
  FISCAL_YEAR_PNL_BALANCE_ROWS_SQL,
  OPENING_BALANCE_EXISTS_SQL,
  OPENING_BALANCE_LOCK_SQL,
  YEAR_END_CLOSE_EXISTS_SQL,
  YEAR_END_CLOSE_LOCK_SQL,
} from '../models/accounting.repo';
import {
  postJournal,
  type AccountingClient,
  type JournalLineInput,
} from './accounting.service';

const OPENING_SOURCE = 'OPENING_BALANCE';
const YEAR_END_SOURCE = 'YEAR_END_CLOSE';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export interface PostOpeningBalancesInput {
  branchId?: unknown;
  lines?: JournalLineInput[];
  actor?: string | null;
}

export interface PostOpeningBalancesResult {
  id: string;
  journalNo: string;
  periodId: string;
  fiscalYearId: string;
  journalDateAD: string;
  periodKey: string;
}

/**
 * Post one branch's opening trial balance into the earliest open period.
 * The caller owns the transaction so the journal, its subledger rows, the
 * duplicate check and any audit row commit or roll back together.
 */
export async function postOpeningBalances(
  client: AccountingClient,
  input: PostOpeningBalancesInput
): Promise<PostOpeningBalancesResult> {
  const branchId = text(input.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required for opening balances.');
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length === 0) {
    throw new ApiError(400, 'At least one opening-balance line is required.');
  }

  // Same branch + same lock key in every process. The check below is the
  // friendly 409; the unique partial index in schema.sql is the durable guard.
  await client.query(OPENING_BALANCE_LOCK_SQL, [`opening-balance:${branchId}`]);
  const existing = (await client.query(OPENING_BALANCE_EXISTS_SQL, [branchId])).rows[0];
  if (existing) {
    throw new ApiError(409, `Opening balances have already been posted for branch ${branchId}.`);
  }

  const period = (await client.query(EARLIEST_OPEN_PERIOD_SQL)).rows[0];
  let journalDateAD: string;
  let periodKey: string;
  if (period) {
    journalDateAD = String(period.startDateAD).slice(0, 10);
    periodKey = String(period.periodKey);
  } else {
    const fiscalYear = (await client.query(EARLIEST_OPEN_FISCAL_YEAR_SQL)).rows[0];
    if (!fiscalYear) {
      throw new ApiError(409, 'No open accounting period is available for opening balances.');
    }
    journalDateAD = String(fiscalYear.startDateAD).slice(0, 10);
    periodKey = journalDateAD.slice(0, 7);
  }

  const posted = await postJournal(client, {
    journalDateAD,
    branchId,
    sourceType: OPENING_SOURCE,
    sourceId: branchId,
    memo: `Opening balances for branch ${branchId}`,
    lines,
    actor: input.actor || null,
    isDemo: false,
  });

  return { ...posted, journalDateAD, periodKey };
}

export interface CloseFiscalYearInput {
  fiscalYearId?: unknown;
  actor?: string | null;
}

export interface CloseFiscalYearResult {
  fiscalYear: any;
  journalCount: number;
}

/**
 * Close one fiscal year: post each branch's P&L residue to retained earnings,
 * then mark the year closed, all inside the caller's transaction.
 */
export async function closeFiscalYear(
  client: AccountingClient,
  input: CloseFiscalYearInput
): Promise<CloseFiscalYearResult> {
  const fiscalYearId = text(input.fiscalYearId, 50);
  if (!fiscalYearId) throw new ApiError(400, 'A fiscal year id is required.');

  await client.query(YEAR_END_CLOSE_LOCK_SQL, [`year-end-close:${fiscalYearId}`]);
  const fiscalYear = (await client.query(FISCAL_YEAR_CLOSE_LOCK_SQL, [fiscalYearId])).rows[0];
  if (!fiscalYear) throw new ApiError(404, 'Fiscal year not found.');
  if (fiscalYear.isClosed) {
    throw new ApiError(409, `Fiscal year ${fiscalYear.code} is already closed.`);
  }

  const existingClose = (await client.query(YEAR_END_CLOSE_EXISTS_SQL, [fiscalYearId])).rows[0];
  if (existingClose) {
    throw new ApiError(
      409,
      `A year-end close has already been posted for fiscal year ${fiscalYear.code}.`
    );
  }

  const rows = (
    await client.query(FISCAL_YEAR_PNL_BALANCE_ROWS_SQL, [String(fiscalYear.endDateAD).slice(0, 10)])
  ).rows;

  // An empty P&L (new company, nothing posted yet) still closes the year —
  // there is simply no closing journal to write.
  let retainedEarnings: any = null;
  if (rows.length > 0) {
    retainedEarnings = (
      await client.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['RETAINED_EARNINGS']])
    ).rows[0];
    if (!retainedEarnings) {
      throw new ApiError(
        400,
        'The RETAINED_EARNINGS posting default is not configured. Assign it to an active equity account before closing the year.'
      );
    }
    if (retainedEarnings.isControl) {
      throw new ApiError(
        400,
        `Retained earnings account ${retainedEarnings.code} is a control account; a year-end close cannot name a subledger party for it.`
      );
    }
  }

  const byBranch = new Map<string, any[]>();
  for (const row of rows) {
    const branchId = String(row.branchId);
    const branchRows = byBranch.get(branchId);
    if (branchRows) branchRows.push(row);
    else byBranch.set(branchId, [row]);
  }

  let journalCount = 0;
  for (const [branchId, balances] of byBranch) {
    const inactive = balances.find((row) => row.isActive !== true);
    if (inactive) {
      throw new ApiError(
        400,
        `Account ${inactive.code} is inactive but still carries a P&L balance; reactivate it before closing the year.`
      );
    }
    const control = balances.find((row) => row.isControl === true);
    if (control) {
      throw new ApiError(
        400,
        `P&L account ${control.code} is a control account; reactivate/remap it before closing the year.`
      );
    }

    const lines: JournalLineInput[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const row of balances) {
      const signed = roundMoney(Number(row.signedBalance) || 0);
      if (Math.abs(signed) < 0.005) continue;
      // signed > 0 is a net debit (expense): credit it to zero. signed < 0 is
      // a net credit (income): debit it to zero.
      const debit = signed < 0 ? roundMoney(-signed) : 0;
      const credit = signed > 0 ? signed : 0;
      totalDebit = roundMoney(totalDebit + debit);
      totalCredit = roundMoney(totalCredit + credit);
      lines.push({
        accountId: row.accountId,
        debit,
        credit,
        memo: `Year-end close ${fiscalYear.code} — ${row.code} ${row.name}`,
      });
    }
    if (lines.length === 0) continue;

    // The P&L lines are the mirror of their balances; the retained-earnings
    // line is the net result that makes the closing journal balance.
    const retainedDifference = roundMoney(totalDebit - totalCredit);
    if (retainedDifference > 0) {
      lines.push({
        accountId: retainedEarnings.id,
        debit: 0,
        credit: retainedDifference,
        memo: `Year-end close ${fiscalYear.code} — retained earnings`,
      });
    } else if (retainedDifference < 0) {
      lines.push({
        accountId: retainedEarnings.id,
        debit: roundMoney(-retainedDifference),
        credit: 0,
        memo: `Year-end close ${fiscalYear.code} — retained earnings`,
      });
    }

    await postJournal(client, {
      journalDateAD: String(fiscalYear.endDateAD).slice(0, 10),
      branchId,
      sourceType: YEAR_END_SOURCE,
      sourceId: fiscalYearId,
      memo: `Year-end close ${fiscalYear.code} for branch ${branchId}`,
      lines,
      actor: input.actor || null,
      isDemo: false,
    });
    journalCount += 1;
  }

  // One atomic outcome: the closing journals above and this flag either both
  // commit or both roll back. The SQL keeps the existing close-date guard.
  const closed = (await client.query(FY_CLOSE_SQL, [fiscalYearId])).rows[0];
  if (!closed) {
    throw new ApiError(
      400,
      `Fiscal year closing is available only after ${String(fiscalYear.endDateAD).slice(0, 10)}.`
    );
  }

  return { fiscalYear: closed, journalCount };
}
