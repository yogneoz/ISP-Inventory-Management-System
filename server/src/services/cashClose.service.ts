/**
 * Daily cash close — the branch's cash position for one business day, built
 * from posted cash/bank journal lines, plus the counted close record.
 *
 * The figures deliberately come from the ledger, never from customer_payments
 * or vendor_payments: those documents already posted their journal, and the
 * journal is the single source the cash book and balance sheet also read. The
 * expected closing is therefore the cash book's closing and the balance
 * sheet's cash-and-bank total for the same branch and date.
 *
 * A close stores a snapshot; a later back-posted journal can move the live
 * figure after the count. The read exposes `stale` in that case rather than
 * silently recomputing a variance the counter never agreed to.
 */
import crypto from 'crypto';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  CASH_BRANCH_FIGURES_SQL,
  DAILY_CASH_CLOSE_BY_BRANCH_DATE_SQL,
  DAILY_CASH_CLOSE_BY_ID_SQL,
  DAILY_CASH_CLOSE_INSERT_SQL,
  DAILY_CASH_CLOSE_LOCK_SQL,
  DAILY_CASH_CLOSE_REOPEN_SQL,
  DAILY_CASH_CLOSE_UPDATE_CLOSED_SQL,
  DAILY_CASH_CLOSES_FOR_DATE_SQL,
  cashCloseInsertParams,
  cashCloseUpdateParams,
  type CashBranchFigures,
  type DailyCashCloseRow,
} from '../models/cashClose.repo';
import { isAccountingDate, type AccountingClient } from './accounting.service';

export interface CashCloseRecord {
  id: string;
  branchId: string;
  businessDateAD: string;
  openingCash: number;
  cashIn: number;
  cashOut: number;
  expectedClosing: number;
  countedClosing: number;
  /** counted − expected at close time. */
  variance: number;
  status: 'CLOSED' | 'OPEN';
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
}

export interface CashCloseBranchRow extends CashBranchFigures {
  /** Live posted figure; the close snapshot is inside `close`. */
  status: 'CLOSED' | 'OPEN';
  countedClosing: number | null;
  variance: number | null;
  close: CashCloseRecord | null;
  /** True when a journal moved the day after the count was taken. */
  stale: boolean;
}

export interface CashPositionResult {
  dateAD: string;
  branchId: string | null;
  branches: CashCloseBranchRow[];
  totals: {
    opening: number;
    cashIn: number;
    cashOut: number;
    expectedClosing: number;
    countedClosing: number;
    variance: number;
    closedBranches: number;
    openBranches: number;
  };
}

/** The server's local calendar day (the operator's business day, not UTC). */
export function cashCloseTodayAD(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

export function requireCashCloseDate(value: unknown, field = 'dateAD'): string {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${field} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function mapClose(row: any): CashCloseRecord {
  return {
    id: String(row.id),
    branchId: String(row.branchId),
    businessDateAD: String(row.businessDateAD).slice(0, 10),
    openingCash: money(row.openingCash),
    cashIn: money(row.cashIn),
    cashOut: money(row.cashOut),
    expectedClosing: money(row.expectedClosing),
    countedClosing: money(row.countedClosing),
    variance: money(row.variance),
    status: row.status === 'OPEN' ? 'OPEN' : 'CLOSED',
    closedBy: row.closedBy ? String(row.closedBy) : null,
    closedAt: row.closedAt ? String(row.closedAt) : null,
    reopenedBy: row.reopenedBy ? String(row.reopenedBy) : null,
    reopenedAt: row.reopenedAt ? String(row.reopenedAt) : null,
  };
}

async function loadFigures(
  client: AccountingClient,
  dateAD: string,
  branchScope: string[] | null
): Promise<CashCloseBranchRow[]> {
  const rows = (
    await client.query(CASH_BRANCH_FIGURES_SQL, [dateAD, branchScope])
  ).rows as any[];
  return rows.map((row) => ({
    branchId: String(row.branchId),
    code: String(row.code),
    name: String(row.name),
    opening: money(row.opening),
    cashIn: money(row.cashIn),
    cashOut: money(row.cashOut),
    expectedClosing: money(row.expectedClosing),
    status: 'OPEN' as const,
    countedClosing: null,
    variance: null,
    close: null,
    stale: false,
  }));
}

/**
 * The day's live figures plus the stored close, merged per branch. `$1` is the
 * date; `$2` is a branch list or NULL for every branch.
 */
export async function buildCashPosition(
  client: AccountingClient,
  options: { dateAD: string; branchScope: string[] | null; branchId?: string | null }
): Promise<CashPositionResult> {
  const [branches, closeRows] = await Promise.all([
    loadFigures(client, options.dateAD, options.branchScope),
    client.query(DAILY_CASH_CLOSES_FOR_DATE_SQL, [options.dateAD, options.branchScope]),
  ]);
  const closeByBranch = new Map<string, CashCloseRecord>();
  for (const row of closeRows.rows) {
    const close = mapClose(row);
    closeByBranch.set(close.branchId, close);
  }

  const merged: CashCloseBranchRow[] = branches.map((branch) => {
    const close = closeByBranch.get(branch.branchId) || null;
    if (!close) return branch;
    const closed = close.status === 'CLOSED';
    return {
      ...branch,
      status: close.status,
      // A reopened day has no CURRENT count: it keeps the prior record for the
      // audit trail (`close`), but the live view must not present the withdrawn
      // count as this day's counted cash — the row would disagree with the day
      // total, which only adds a closed branch's counted figure.
      countedClosing: closed ? close.countedClosing : null,
      variance: closed ? close.variance : null,
      close,
      stale: closed && Math.abs(close.expectedClosing - branch.expectedClosing) >= 0.005,
    };
  });

  const totals = merged.reduce(
    (sum, branch) => ({
      opening: roundMoney(sum.opening + branch.opening),
      cashIn: roundMoney(sum.cashIn + branch.cashIn),
      cashOut: roundMoney(sum.cashOut + branch.cashOut),
      expectedClosing: roundMoney(sum.expectedClosing + branch.expectedClosing),
      countedClosing: roundMoney(
        sum.countedClosing + (branch.status === 'CLOSED' ? branch.countedClosing || 0 : 0)
      ),
      variance: roundMoney(
        sum.variance + (branch.status === 'CLOSED' ? branch.variance || 0 : 0)
      ),
      closedBranches: sum.closedBranches + (branch.status === 'CLOSED' ? 1 : 0),
      openBranches: sum.openBranches + (branch.status === 'CLOSED' ? 0 : 1),
    }),
    {
      opening: 0,
      cashIn: 0,
      cashOut: 0,
      expectedClosing: 0,
      countedClosing: 0,
      variance: 0,
      closedBranches: 0,
      openBranches: 0,
    }
  );

  return {
    dateAD: options.dateAD,
    branchId: options.branchId ?? null,
    branches: merged,
    totals,
  };
}

/**
 * Close one branch/day. The advisory lock makes the "not already closed" test
 * and the insert atomic; a CLOSED row is refused even when the request carries
 * a new count. An OPEN row (a reopened day) is updated in place, so a day has
 * one close record for its whole life.
 */
export async function closeCashDay(
  client: AccountingClient,
  input: {
    branchId: string;
    dateAD: string;
    countedClosing: number;
    actor: string | null;
  }
): Promise<CashCloseRecord> {
  await client.query(DAILY_CASH_CLOSE_LOCK_SQL, [
    `daily-cash-close:${input.branchId}:${input.dateAD}`,
  ]);

  const figures = (
    await client.query(CASH_BRANCH_FIGURES_SQL, [input.dateAD, [input.branchId]])
  ).rows[0] as any;
  if (!figures) throw new ApiError(404, `Branch ${input.branchId} does not exist.`);

  const existing = (
    await client.query(DAILY_CASH_CLOSE_BY_BRANCH_DATE_SQL, [input.branchId, input.dateAD])
  ).rows[0];
  if (existing && existing.status === 'CLOSED') {
    throw new ApiError(
      409,
      `Cash for ${input.branchId} on ${input.dateAD} is already closed. Reopen the day before counting it again.`
    );
  }

  const expectedClosing = money(figures.expectedClosing);
  const variance = roundMoney(input.countedClosing - expectedClosing);
  const opening = money(figures.opening);
  const cashIn = money(figures.cashIn);
  const cashOut = money(figures.cashOut);

  const row = existing
    ? (
        await client.query(
          DAILY_CASH_CLOSE_UPDATE_CLOSED_SQL,
          cashCloseUpdateParams({
            id: String(existing.id),
            opening,
            cashIn,
            cashOut,
            expectedClosing,
            countedClosing: input.countedClosing,
            variance,
            closedBy: input.actor,
          })
        )
      ).rows[0]
    : (
        await client.query(
          DAILY_CASH_CLOSE_INSERT_SQL,
          cashCloseInsertParams({
            id: `dcc-${crypto.randomUUID()}`,
            branchId: input.branchId,
            dateAD: input.dateAD,
            opening,
            cashIn,
            cashOut,
            expectedClosing,
            countedClosing: input.countedClosing,
            variance,
            closedBy: input.actor,
          })
        )
      ).rows[0];

  return mapClose(row);
}

/** Reopen a closed day; an already-open day is refused, not a silent no-op. */
export async function reopenCashDay(
  client: AccountingClient,
  input: { id: string; actor: string | null }
): Promise<CashCloseRecord> {
  const existing = (await client.query(DAILY_CASH_CLOSE_BY_ID_SQL, [input.id])).rows[0];
  if (!existing) throw new ApiError(404, 'Daily cash close not found.');
  if (existing.status === 'OPEN') {
    throw new ApiError(
      409,
      `Cash for ${existing.branchId} on ${String(existing.businessDateAD).slice(0, 10)} is already open.`
    );
  }
  const row = (await client.query(DAILY_CASH_CLOSE_REOPEN_SQL, [input.id, input.actor])).rows[0];
  return mapClose(row);
}

/** The stored record for one branch/day, if any (used by the close response). */
export async function readCashClose(
  client: AccountingClient,
  branchId: string,
  dateAD: string
): Promise<CashCloseRecord | null> {
  const row = (
    await client.query(DAILY_CASH_CLOSE_BY_BRANCH_DATE_SQL, [branchId, dateAD])
  ).rows[0];
  return row ? mapClose(row) : null;
}

/** One close by id, for the reopen path to check its branch before writing. */
export async function readCashCloseById(
  client: AccountingClient,
  id: string
): Promise<CashCloseRecord> {
  const row = (await client.query(DAILY_CASH_CLOSE_BY_ID_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'Daily cash close not found.');
  return mapClose(row);
}
