/**
 * Forward cash-flow forecast read side.
 *
 * The forecast deliberately reuses the aging builder instead of querying
 * invoices itself: opening AR/AP items are exactly the posted subledger items
 * (and unapplied credits) that the aging report shows for the same branch and
 * as-of date. The opening balance is the posted cash/bank book balance at that
 * same date, so a forecast cannot open at a number the cash-flow statement's
 * closing figure does not recognise.
 *
 * Dates are split into 7-day buckets beginning the day after `asOf`:
 * W1 = asOf+1..asOf+7, W2 = asOf+8..asOf+14, and so on. Overdue items are
 * immediately collectable/payable and therefore sit in W1. A document due
 * beyond the selected horizon is excluded from the buckets but returned in
 * `beyondHorizon` and in the item list, so the exclusion is visible.
 *
 * Unapplied AR/AP credits are subtracted in W1 (the earliest point they can
 * reduce cash), which keeps `ar.total`/`ap.total` tied to aging while still
 * letting the forecast reconcile to the control accounts.
 */
import { roundMoney } from '../utils/money';
import { CASH_BANK_ACCOUNT_ROWS_SQL } from '../models/accounting.repo';
import {
  CASH_FLOW_PAYROLL_OBLIGATIONS_SQL,
  CASH_FLOW_PERIODS_IN_RANGE_SQL,
  CASH_FLOW_RECURRING_TEMPLATES_SQL,
} from '../models/cashFlowForecast.repo';
import {
  buildAging,
  type AgingItemRow,
  type AgingParty,
  type AgingType,
} from './accountingAging.service';
import {
  listCashFlowManualInputs,
  type CashFlowManualInput,
} from './cashFlowManualInput.service';
import { evaluateAmountFormula, type RecurringFrequency } from './recurringClose.service';
import type { AccountingClient } from './accounting.service';

export const FORECAST_DEFAULT_WEEKS = 13;
export const FORECAST_MAX_WEEKS = 26;
export const FORECAST_MIN_WEEKS = 1;

export type CashFlowForecastBasis = 'WEEKLY';
export type CashFlowForecastSource = 'AR' | 'AP' | 'RECURRING' | 'PAYROLL' | 'MANUAL';
export type CashFlowForecastDirection = 'INFLOW' | 'OUTFLOW';
export type CashFlowForecastItemKind =
  | AgingItemRow['kind']
  | 'RECURRING'
  | 'PAYROLL'
  | 'MANUAL';

export interface CashFlowForecastInput {
  asOf: string;
  /** `null` rolls every branch up to company level. */
  branchId: string | null;
  empty: boolean;
  weeks?: number;
  minCash?: number;
}

export interface CashFlowForecastItem {
  kind: CashFlowForecastItemKind;
  source: CashFlowForecastSource;
  direction: CashFlowForecastDirection;
  documentId: string | null;
  documentNo: string | null;
  partyId: string;
  partyName: string;
  dueDateAD: string;
  /**
   * Null only for an item outside the selected horizon. `CREDIT` items are
   * placed in W1 (or null when the item list needs no bucket).
   */
  bucketKey: string | null;
  bucketIndex: number | null;
  overdue: boolean;
  description: string;
  amount: number;
}

export interface CashFlowForecastBucket {
  key: string;
  label: string;
  fromAD: string;
  toAD: string;
  /** Gross open AR charges due in this week. */
  receipts: number;
  /** Unapplied AR credits applied at the start of the forecast. */
  customerCredits: number;
  /** Gross open AP charges due in this week. */
  payments: number;
  /** Unapplied AP credits applied at the start of the forecast. */
  supplierCredits: number;
  /** Recurring-journal cash receipts scheduled in this week. */
  recurringInflows: number;
  /** Recurring-journal cash payments scheduled in this week. */
  recurringOutflows: number;
  /** Unpaid approved/posted payroll obligations due in this week. */
  payrollOutflows: number;
  /** Manual forecast receipts dated in this week. */
  manualInflows: number;
  /** Manual forecast payments dated in this week. */
  manualOutflows: number;
  /** receipts - customerCredits + recurringInflows + manualInflows. */
  inflows: number;
  /** payments - supplierCredits + recurringOutflows + payrollOutflows + manualOutflows. */
  outflows: number;
  netCashFlow: number;
  closingCash: number;
  belowMinimum: boolean;
  itemCount: number;
}

export interface CashFlowForecastTieOut {
  grossTotal: number;
  unappliedCredit: number;
  total: number;
  controlBalance: number;
  difference: number;
  reconciled: boolean;
  openItemCount: number;
  overdueAmount: number;
}

export interface CashFlowForecastHorizonExclusion {
  count: number;
  amount: number;
}

/** Every non-AR/AP source reports the same five figures, so exclusions are visible. */
export interface CashFlowForecastSourceSummary {
  scheduledCount: number;
  scheduledAmount: number;
  includedCount: number;
  includedAmount: number;
  overdueAmount: number;
  beyondHorizon: CashFlowForecastHorizonExclusion;
  closedPeriodExcluded: CashFlowForecastHorizonExclusion;
}

export interface CashFlowForecastFirstBreach {
  bucketKey: string;
  closingCash: number;
}

export interface CashFlowForecastResponse {
  statement: 'CASH_FLOW_FORECAST';
  basis: CashFlowForecastBasis;
  branchId: string | null;
  asOf: string;
  weeks: number;
  minCash: number;
  openingCash: number;
  totalInflows: number;
  totalOutflows: number;
  netCashFlow: number;
  closingCash: number;
  minimumClosingCash: number;
  openingBelowMinimum: boolean;
  warning: boolean;
  firstBreach: CashFlowForecastFirstBreach | null;
  breaches: string[];
  buckets: CashFlowForecastBucket[];
  items: CashFlowForecastItem[];
  /** Every manual row in scope, including closed-period and beyond-horizon rows. */
  manualInputs: CashFlowManualInput[];
  ar: CashFlowForecastTieOut;
  ap: CashFlowForecastTieOut;
  sources: {
    recurring: CashFlowForecastSourceSummary;
    payroll: CashFlowForecastSourceSummary;
    manual: CashFlowForecastSourceSummary;
  };
  beyondHorizon: {
    ar: CashFlowForecastHorizonExclusion;
    ap: CashFlowForecastHorizonExclusion;
    recurring: CashFlowForecastHorizonExclusion;
    payroll: CashFlowForecastHorizonExclusion;
    manual: CashFlowForecastHorizonExclusion;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function parseAD(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDaysAD(value: string, days: number): string {
  return new Date(parseAD(value) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetweenAD(fromAD: string, toAD: string): number {
  return Math.round((parseAD(toAD) - parseAD(fromAD)) / 86_400_000);
}

function shortDateAD(value: string): string {
  const [, month, day] = value.split('-').map(Number);
  return `${String(day).padStart(2, '0')} ${MONTHS[month - 1] || ''}`.trim();
}

export function clampForecastWeeks(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return FORECAST_DEFAULT_WEEKS;
  return Math.min(FORECAST_MAX_WEEKS, Math.max(FORECAST_MIN_WEEKS, parsed));
}

/**
 * Which weekly bucket a due date belongs to, or null when it is beyond the
 * selected horizon. Overdue (and due-today) items are collectable immediately
 * and therefore share W1 with the next seven days.
 */
export function forecastWeekIndex(
  asOf: string,
  dueDateAD: string,
  weeks: number
): number | null {
  const offset = daysBetweenAD(asOf, dueDateAD);
  if (offset <= 1) return 0;
  const index = Math.floor((offset - 1) / 7);
  return index < weeks ? index : null;
}

interface BucketDraft {
  key: string;
  label: string;
  fromAD: string;
  toAD: string;
  receipts: number;
  customerCredits: number;
  payments: number;
  supplierCredits: number;
  recurringInflows: number;
  recurringOutflows: number;
  payrollOutflows: number;
  manualInflows: number;
  manualOutflows: number;
  inflows: number;
  outflows: number;
  netCashFlow: number;
  closingCash: number;
  belowMinimum: boolean;
  itemCount: number;
}

function buildBucketDrafts(asOf: string, weeks: number): BucketDraft[] {
  return Array.from({ length: weeks }, (_, index) => {
    const fromAD = addDaysAD(asOf, index * 7 + 1);
    const toAD = addDaysAD(asOf, index * 7 + 7);
    return {
      key: `W${index + 1}`,
      label: `${shortDateAD(fromAD)} – ${shortDateAD(toAD)}`,
      fromAD,
      toAD,
      receipts: 0,
      customerCredits: 0,
      payments: 0,
      supplierCredits: 0,
      recurringInflows: 0,
      recurringOutflows: 0,
      payrollOutflows: 0,
      manualInflows: 0,
      manualOutflows: 0,
      inflows: 0,
      outflows: 0,
      netCashFlow: 0,
      closingCash: 0,
      belowMinimum: false,
      itemCount: 0,
    };
  });
}

async function cashBookBalanceAsOf(
  client: AccountingClient,
  asOf: string,
  branchId: string | null
): Promise<number> {
  // `from = NULL` makes the query's opening zero, so the result is the posted
  // cash/bank balance through `asOf` — the same balance at the end of the
  // cash-flow statement, not a new calculation of cash.
  const result = await client.query(CASH_BANK_ACCOUNT_ROWS_SQL, [null, asOf, branchId]);
  return roundMoney(
    result.rows.reduce(
      (sum, row) => sum + money(row.opening) + money(row.receipts) - money(row.payments),
      0
    )
  );
}

interface SourceAccumulator {
  openItemCount: number;
  overdueAmount: number;
  beyond: CashFlowForecastHorizonExclusion;
}

function addAgingSource(
  source: CashFlowForecastSource,
  aging: { parties: AgingParty[] },
  asOf: string,
  weeks: number,
  buckets: BucketDraft[],
  items: CashFlowForecastItem[],
  accumulator: SourceAccumulator
): void {
  for (const party of aging.parties) {
    for (const row of party.rows) {
      if (row.kind === 'CREDIT') continue;
      accumulator.openItemCount += 1;
      const dueDateAD = row.dueDateAD || row.documentDateAD;
      const overdue = daysBetweenAD(asOf, dueDateAD) <= 0;
      if (overdue) {
        accumulator.overdueAmount = roundMoney(accumulator.overdueAmount + row.amount);
      }
      const bucketIndex = forecastWeekIndex(asOf, dueDateAD, weeks);
      const item: CashFlowForecastItem = {
        kind: row.kind,
        source,
        direction: source === 'AR' ? 'INFLOW' : 'OUTFLOW',
        documentId: row.documentId,
        documentNo: row.documentNo,
        partyId: party.partyId,
        partyName: party.partyName,
        dueDateAD,
        bucketKey: bucketIndex === null ? null : buckets[bucketIndex].key,
        bucketIndex,
        overdue,
        description: row.description,
        amount: row.amount,
      };
      if (bucketIndex === null) {
        accumulator.beyond.count += 1;
        accumulator.beyond.amount = roundMoney(accumulator.beyond.amount + row.amount);
        items.push(item);
        continue;
      }
      const bucket = buckets[bucketIndex];
      bucket.itemCount += 1;
      if (source === 'AR') bucket.receipts = roundMoney(bucket.receipts + row.amount);
      else bucket.payments = roundMoney(bucket.payments + row.amount);
      items.push(item);
    }

    // An unapplied credit is already sitting against the control account; it
    // can only reduce cash from the earliest bucket, never from a later due
    // date that no longer exists.
    const credit = money(party.unappliedCredit);
    if (credit <= 0.004) continue;
    const bucket = buckets[0];
    if (bucket) {
      bucket.itemCount += 1;
      if (source === 'AR') bucket.customerCredits = roundMoney(bucket.customerCredits + credit);
      else bucket.supplierCredits = roundMoney(bucket.supplierCredits + credit);
    }
    items.push({
      kind: 'CREDIT',
      source,
      direction: source === 'AR' ? 'OUTFLOW' : 'INFLOW',
      documentId: null,
      documentNo: null,
      partyId: party.partyId,
      partyName: party.partyName,
      dueDateAD: asOf,
      bucketKey: bucket?.key || null,
      bucketIndex: bucket ? 0 : null,
      overdue: false,
      description: `Unapplied ${source} credit`,
      amount: credit,
    });
  }
}

function tieOut(
  aging: { totals: { grossTotal: number; unappliedCredit: number; total: number; controlBalance: number; difference: number; reconciled: boolean } },
  accumulator: SourceAccumulator
): CashFlowForecastTieOut {
  return {
    grossTotal: money(aging.totals.grossTotal),
    unappliedCredit: money(aging.totals.unappliedCredit),
    total: money(aging.totals.total),
    controlBalance: money(aging.totals.controlBalance),
    difference: money(aging.totals.difference),
    reconciled: aging.totals.reconciled,
    openItemCount: accumulator.openItemCount,
    overdueAmount: money(accumulator.overdueAmount),
  };
}

function emptySourceSummary(): CashFlowForecastSourceSummary {
  return {
    scheduledCount: 0,
    scheduledAmount: 0,
    includedCount: 0,
    includedAmount: 0,
    overdueAmount: 0,
    beyondHorizon: { count: 0, amount: 0 },
    closedPeriodExcluded: { count: 0, amount: 0 },
  };
}

interface PeriodWindow {
  status: string;
  startDateAD: string;
  endDateAD: string;
}

function periodIsClosed(dateAD: string, periods: PeriodWindow[]): boolean {
  return periods.some(
    (period) => period.status === 'CLOSED' && dateAD >= period.startDateAD && dateAD <= period.endDateAD
  );
}

interface RecurringTemplateDraft {
  id: string;
  code: string;
  name: string;
  branchId: string;
  frequency: RecurringFrequency;
  nextRunDate: string;
  endDateAD: string | null;
  lines: Array<{
    side: 'DEBIT' | 'CREDIT';
    amountFormula: string;
    accountKind: string;
  }>;
}

function groupRecurringTemplates(rows: any[]): RecurringTemplateDraft[] {
  const templates = new Map<string, RecurringTemplateDraft>();
  for (const row of rows) {
    let template = templates.get(row.id);
    if (!template) {
      template = {
        id: String(row.id),
        code: String(row.code),
        name: String(row.name),
        branchId: String(row.branchId),
        frequency: row.frequency as RecurringFrequency,
        nextRunDate: String(row.nextRunDate).slice(0, 10),
        endDateAD: row.endDateAD ? String(row.endDateAD).slice(0, 10) : null,
        lines: [],
      };
      templates.set(template.id, template);
    }
    template.lines.push({
      side: row.side === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      amountFormula: String(row.amountFormula),
      accountKind: String(row.accountKind || ''),
    });
  }
  return [...templates.values()];
}

function recurringStepMonths(frequency: RecurringFrequency): number {
  return frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 12;
}

function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function recurringCashEffect(template: RecurringTemplateDraft): number {
  let effect = 0;
  for (const line of template.lines) {
    if (line.accountKind !== 'CASH' && line.accountKind !== 'BANK') continue;
    const amount = evaluateAmountFormula(line.amountFormula);
    effect += line.side === 'DEBIT' ? amount : -amount;
  }
  return roundMoney(effect);
}

function addSupplementItem(
  source: Exclude<CashFlowForecastSource, 'AR' | 'AP'>,
  input: {
    kind: CashFlowForecastItemKind;
    direction: CashFlowForecastDirection;
    documentId: string | null;
    documentNo: string | null;
    partyId: string;
    partyName: string;
    dueDateAD: string;
    description: string;
    amount: number;
    closedPeriod: boolean;
  },
  asOf: string,
  weeks: number,
  buckets: BucketDraft[],
  items: CashFlowForecastItem[],
  summary: CashFlowForecastSourceSummary
): void {
  const amount = money(input.amount);
  if (amount <= 0.004) return;
  const overdue = daysBetweenAD(asOf, input.dueDateAD) <= 0;
  summary.scheduledCount += 1;
  summary.scheduledAmount = roundMoney(summary.scheduledAmount + amount);

  if (input.closedPeriod) {
    summary.closedPeriodExcluded.count += 1;
    summary.closedPeriodExcluded.amount = roundMoney(summary.closedPeriodExcluded.amount + amount);
    return;
  }

  const bucketIndex = forecastWeekIndex(asOf, input.dueDateAD, weeks);
  if (bucketIndex === null) {
    summary.beyondHorizon.count += 1;
    summary.beyondHorizon.amount = roundMoney(summary.beyondHorizon.amount + amount);
    items.push({
      kind: input.kind,
      source,
      direction: input.direction,
      documentId: input.documentId,
      documentNo: input.documentNo,
      partyId: input.partyId,
      partyName: input.partyName,
      dueDateAD: input.dueDateAD,
      bucketKey: null,
      bucketIndex: null,
      overdue,
      description: input.description,
      amount,
    });
    return;
  }

  const bucket = buckets[bucketIndex];
  bucket.itemCount += 1;
  summary.includedCount += 1;
  summary.includedAmount = roundMoney(summary.includedAmount + amount);
  if (overdue) summary.overdueAmount = roundMoney(summary.overdueAmount + amount);
  if (source === 'RECURRING') {
    if (input.direction === 'INFLOW') bucket.recurringInflows = roundMoney(bucket.recurringInflows + amount);
    else bucket.recurringOutflows = roundMoney(bucket.recurringOutflows + amount);
  } else if (source === 'PAYROLL') {
    bucket.payrollOutflows = roundMoney(bucket.payrollOutflows + amount);
  } else if (input.direction === 'INFLOW') {
    bucket.manualInflows = roundMoney(bucket.manualInflows + amount);
  } else {
    bucket.manualOutflows = roundMoney(bucket.manualOutflows + amount);
  }
  items.push({
    kind: input.kind,
    source,
    direction: input.direction,
    documentId: input.documentId,
    documentNo: input.documentNo,
    partyId: input.partyId,
    partyName: input.partyName,
    dueDateAD: input.dueDateAD,
    bucketKey: bucket.key,
    bucketIndex,
    overdue,
    description: input.description,
    amount,
  });
}

function addRecurringSource(
  rows: any[],
  asOf: string,
  weeks: number,
  buckets: BucketDraft[],
  items: CashFlowForecastItem[],
  periods: PeriodWindow[],
  summary: CashFlowForecastSourceSummary
): void {
  const horizonEnd = addDaysAD(asOf, weeks * 7);
  for (const template of groupRecurringTemplates(rows)) {
    const effect = recurringCashEffect(template);
    if (Math.abs(effect) < 0.005) continue;
    let dueDateAD = template.nextRunDate;
    let guard = 0;
    while (dueDateAD <= horizonEnd && guard < 1_200) {
      if (template.endDateAD && dueDateAD > template.endDateAD) break;
      addSupplementItem(
        'RECURRING',
        {
          kind: 'RECURRING',
          direction: effect > 0 ? 'INFLOW' : 'OUTFLOW',
          documentId: template.id,
          documentNo: template.code,
          partyId: template.id,
          partyName: template.name,
          dueDateAD,
          description: `${template.frequency} recurring journal`,
          amount: Math.abs(effect),
          closedPeriod: periodIsClosed(dueDateAD, periods),
        },
        asOf,
        weeks,
        buckets,
        items,
        summary
      );
      dueDateAD = addMonths(dueDateAD, recurringStepMonths(template.frequency));
      guard += 1;
    }
  }
}

function addPayrollSource(
  rows: any[],
  asOf: string,
  weeks: number,
  buckets: BucketDraft[],
  items: CashFlowForecastItem[],
  summary: CashFlowForecastSourceSummary
): void {
  for (const row of rows) {
    addSupplementItem(
      'PAYROLL',
      {
        kind: 'PAYROLL',
        direction: 'OUTFLOW',
        documentId: String(row.id),
        documentNo: String(row.runNo),
        partyId: String(row.branchId),
        partyName: 'Payroll',
        dueDateAD: String(row.runDateAD).slice(0, 10),
        description: `Payroll ${row.periodKey} · ${row.status}`,
        amount: money(row.netTotal),
        closedPeriod: false,
      },
      asOf,
      weeks,
      buckets,
      items,
      summary
    );
  }
}

function addManualSource(
  rows: CashFlowManualInput[],
  asOf: string,
  weeks: number,
  buckets: BucketDraft[],
  items: CashFlowForecastItem[],
  summary: CashFlowForecastSourceSummary
): void {
  for (const row of rows) {
    addSupplementItem(
      'MANUAL',
      {
        kind: 'MANUAL',
        direction: row.direction,
        documentId: row.id,
        documentNo: null,
        partyId: row.branchId,
        partyName: row.description,
        dueDateAD: row.expectedDateAD,
        description: row.description,
        amount: row.amount,
        closedPeriod: row.closedPeriod,
      },
      asOf,
      weeks,
      buckets,
      items,
      summary
    );
  }
}

export async function buildCashFlowForecast(
  client: AccountingClient,
  input: CashFlowForecastInput
): Promise<CashFlowForecastResponse> {
  const weeks = clampForecastWeeks(input.weeks);
  const minCash = roundMoney(Number(input.minCash) || 0);
  const buckets = buildBucketDrafts(input.asOf, weeks);
  const items: CashFlowForecastItem[] = [];
  const arAccumulator: SourceAccumulator = {
    openItemCount: 0,
    overdueAmount: 0,
    beyond: { count: 0, amount: 0 },
  };
  const apAccumulator: SourceAccumulator = {
    openItemCount: 0,
    overdueAmount: 0,
    beyond: { count: 0, amount: 0 },
  };
  const recurringSummary = emptySourceSummary();
  const payrollSummary = emptySourceSummary();
  const manualSummary = emptySourceSummary();
  const horizonEnd = addDaysAD(input.asOf, weeks * 7);

  const [ar, ap, recurringResult, payrollResult, manualInputs, periodResult] = await Promise.all([
    buildAging(client, {
      type: 'AR' as AgingType,
      asOf: input.asOf,
      branchId: input.branchId,
      empty: input.empty,
    }),
    buildAging(client, {
      type: 'AP' as AgingType,
      asOf: input.asOf,
      branchId: input.branchId,
      empty: input.empty,
    }),
    input.empty
      ? Promise.resolve({ rows: [] })
      : client.query(CASH_FLOW_RECURRING_TEMPLATES_SQL, [input.branchId]),
    input.empty
      ? Promise.resolve({ rows: [] })
      : client.query(CASH_FLOW_PAYROLL_OBLIGATIONS_SQL, [input.branchId, horizonEnd]),
    input.empty ? Promise.resolve([]) : listCashFlowManualInputs(client, input.branchId),
    input.empty
      ? Promise.resolve({ rows: [] })
      : client.query(CASH_FLOW_PERIODS_IN_RANGE_SQL, ['1900-01-01', horizonEnd]),
  ]);
  const openingCash = input.empty
    ? 0
    : await cashBookBalanceAsOf(client, input.asOf, input.branchId);

  addAgingSource('AR', ar, input.asOf, weeks, buckets, items, arAccumulator);
  addAgingSource('AP', ap, input.asOf, weeks, buckets, items, apAccumulator);
  const periods = periodResult.rows as PeriodWindow[];
  addRecurringSource(
    recurringResult.rows,
    input.asOf,
    weeks,
    buckets,
    items,
    periods,
    recurringSummary
  );
  addPayrollSource(payrollResult.rows, input.asOf, weeks, buckets, items, payrollSummary);
  addManualSource(manualInputs, input.asOf, weeks, buckets, items, manualSummary);

  let closing = openingCash;
  for (const bucket of buckets) {
    bucket.inflows = roundMoney(
      bucket.receipts -
        bucket.customerCredits +
        bucket.recurringInflows +
        bucket.manualInflows
    );
    bucket.outflows = roundMoney(
      bucket.payments -
        bucket.supplierCredits +
        bucket.recurringOutflows +
        bucket.payrollOutflows +
        bucket.manualOutflows
    );
    bucket.netCashFlow = roundMoney(bucket.inflows - bucket.outflows);
    closing = roundMoney(closing + bucket.netCashFlow);
    bucket.closingCash = closing;
    bucket.belowMinimum = closing < minCash - 0.005;
  }

  const closingCash = roundMoney(closing);
  const netCashFlow = roundMoney(closingCash - openingCash);
  const totalInflows = roundMoney(buckets.reduce((sum, bucket) => sum + bucket.inflows, 0));
  const totalOutflows = roundMoney(buckets.reduce((sum, bucket) => sum + bucket.outflows, 0));
  const openingBelowMinimum = openingCash < minCash - 0.005;
  const firstBreach: CashFlowForecastFirstBreach | null = openingBelowMinimum
    ? { bucketKey: 'OPENING', closingCash: openingCash }
    : (() => {
        const bucket = buckets.find((candidate) => candidate.belowMinimum);
        return bucket ? { bucketKey: bucket.key, closingCash: bucket.closingCash } : null;
      })();
  const breaches = [
    ...(openingBelowMinimum ? ['OPENING'] : []),
    ...buckets.filter((bucket) => bucket.belowMinimum).map((bucket) => bucket.key),
  ];
  const minimumClosingCash = Math.min(
    openingCash,
    ...buckets.map((bucket) => bucket.closingCash)
  );

  const sourceOrder: Record<CashFlowForecastSource, number> = {
    AR: 0,
    AP: 1,
    RECURRING: 2,
    PAYROLL: 3,
    MANUAL: 4,
  };
  items.sort((left, right) => {
    if (left.source !== right.source) return sourceOrder[left.source] - sourceOrder[right.source];
    if (left.dueDateAD !== right.dueDateAD) return left.dueDateAD.localeCompare(right.dueDateAD);
    if (left.partyName !== right.partyName) return left.partyName.localeCompare(right.partyName);
    return (left.documentNo || '').localeCompare(right.documentNo || '');
  });

  return {
    statement: 'CASH_FLOW_FORECAST',
    basis: 'WEEKLY',
    branchId: input.branchId,
    asOf: input.asOf,
    weeks,
    minCash,
    openingCash,
    totalInflows,
    totalOutflows,
    netCashFlow,
    closingCash,
    minimumClosingCash: roundMoney(minimumClosingCash),
    openingBelowMinimum,
    warning: Boolean(firstBreach),
    firstBreach,
    breaches,
    buckets: buckets.map((bucket) => ({ ...bucket })),
    items,
    manualInputs,
    ar: tieOut(ar, arAccumulator),
    ap: tieOut(ap, apAccumulator),
    sources: {
      recurring: recurringSummary,
      payroll: payrollSummary,
      manual: manualSummary,
    },
    beyondHorizon: {
      ar: arAccumulator.beyond,
      ap: apAccumulator.beyond,
      recurring: recurringSummary.beyondHorizon,
      payroll: payrollSummary.beyondHorizon,
      manual: manualSummary.beyondHorizon,
    },
  };
}

function csvCell(value: string | number): string {
  const raw = String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function csvRow(...cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}

function fixed(value: number): string {
  return Number(value).toFixed(2);
}

/** The downloadable workbook-shaped CSV behind the register's Export button. */
export function cashFlowForecastCsv(forecast: CashFlowForecastResponse): string {
  const lines: string[] = [
    csvRow('Cash-flow forecast'),
    csvRow('Branch', forecast.branchId || 'All branches'),
    csvRow('As of', forecast.asOf),
    csvRow('Basis', forecast.basis),
    csvRow('Weeks', forecast.weeks),
    csvRow('Minimum cash', fixed(forecast.minCash)),
    csvRow('Opening cash', fixed(forecast.openingCash)),
    csvRow('Total inflows', fixed(forecast.totalInflows)),
    csvRow('Total outflows', fixed(forecast.totalOutflows)),
    csvRow('Net cash flow', fixed(forecast.netCashFlow)),
    csvRow('Closing cash', fixed(forecast.closingCash)),
    csvRow('Minimum closing cash', fixed(forecast.minimumClosingCash)),
    csvRow('Warning', forecast.warning ? 'YES' : 'NO'),
    '',
    csvRow(
      'Week',
      'From',
      'To',
      'AR receipts',
      'Customer credits',
      'AP payments',
      'Supplier credits',
      'Recurring in',
      'Recurring out',
      'Payroll out',
      'Manual in',
      'Manual out',
      'Net receipts',
      'Net payments',
      'Net cash flow',
      'Closing cash',
      'Below minimum'
    ),
  ];
  for (const bucket of forecast.buckets) {
    lines.push(
      csvRow(
        bucket.key,
        bucket.fromAD,
        bucket.toAD,
        fixed(bucket.receipts),
        fixed(bucket.customerCredits),
        fixed(bucket.payments),
        fixed(bucket.supplierCredits),
        fixed(bucket.recurringInflows),
        fixed(bucket.recurringOutflows),
        fixed(bucket.payrollOutflows),
        fixed(bucket.manualInflows),
        fixed(bucket.manualOutflows),
        fixed(bucket.inflows),
        fixed(bucket.outflows),
        fixed(bucket.netCashFlow),
        fixed(bucket.closingCash),
        bucket.belowMinimum ? 'YES' : 'NO'
      )
    );
  }
  lines.push('');
  lines.push(
    csvRow(
      'Source',
      'Party',
      'Document',
      'Due date',
      'Description',
      'Direction',
      'Amount',
      'Bucket',
      'Overdue'
    )
  );
  for (const item of forecast.items) {
    lines.push(
      csvRow(
        item.source,
        item.partyName,
        item.documentNo || '',
        item.dueDateAD,
        item.description,
        item.direction,
        fixed(item.amount),
        item.bucketKey || 'BEYOND_HORIZON',
        item.overdue ? 'YES' : 'NO'
      )
    );
  }
  lines.push('');
  lines.push(csvRow('AR tie-out', 'Gross', 'Credits', 'Net', 'Control', 'Difference', 'Reconciled'));
  lines.push(
    csvRow(
      'AR',
      fixed(forecast.ar.grossTotal),
      fixed(forecast.ar.unappliedCredit),
      fixed(forecast.ar.total),
      fixed(forecast.ar.controlBalance),
      fixed(forecast.ar.difference),
      forecast.ar.reconciled ? 'YES' : 'NO'
    )
  );
  lines.push(csvRow('AP tie-out', 'Gross', 'Credits', 'Net', 'Control', 'Difference', 'Reconciled'));
  lines.push(
    csvRow(
      'AP',
      fixed(forecast.ap.grossTotal),
      fixed(forecast.ap.unappliedCredit),
      fixed(forecast.ap.total),
      fixed(forecast.ap.controlBalance),
      fixed(forecast.ap.difference),
      forecast.ap.reconciled ? 'YES' : 'NO'
    )
  );
  lines.push('');
  lines.push(csvRow('Beyond horizon', 'Source', 'Items', 'Amount'));
  for (const source of ['ar', 'ap'] as const) {
    lines.push(
      csvRow(
        'Beyond horizon',
        source.toUpperCase(),
        forecast.beyondHorizon[source].count,
        fixed(forecast.beyondHorizon[source].amount)
      )
    );
  }
  lines.push('');
  lines.push(
    csvRow(
      'Source summary',
      'Scheduled count',
      'Scheduled amount',
      'Included count',
      'Included amount',
      'Overdue amount',
      'Beyond count',
      'Beyond amount',
      'Closed count',
      'Closed amount'
    )
  );
  for (const source of ['recurring', 'payroll', 'manual'] as const) {
    const summary = forecast.sources[source];
    lines.push(
      csvRow(
        source.toUpperCase(),
        summary.scheduledCount,
        fixed(summary.scheduledAmount),
        summary.includedCount,
        fixed(summary.includedAmount),
        fixed(summary.overdueAmount),
        summary.beyondHorizon.count,
        fixed(summary.beyondHorizon.amount),
        summary.closedPeriodExcluded.count,
        fixed(summary.closedPeriodExcluded.amount)
      )
    );
  }
  lines.push('');
  lines.push(csvRow('Manual inputs', 'Date', 'Direction', 'Formula', 'Amount', 'Description', 'Closed period'));
  for (const input of forecast.manualInputs) {
    lines.push(
      csvRow(
        input.id,
        input.expectedDateAD,
        input.direction,
        input.amountFormula,
        fixed(input.amount),
        input.description,
        input.closedPeriod ? 'YES' : 'NO'
      )
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
