/**
 * Comparative statement windows and rows.
 *
 * The prior window is not a guess: it is the equal-length period immediately
 * before the current start. A balance sheet compares the prior fiscal-year end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  TrialBalanceGroup,
  TrialBalanceResponse,
} from '../client/src/services/api/accounting';
import {
  addDaysAD,
  inclusiveDays,
  precedingEqualWindow,
  priorBalanceSheetDate,
} from '../client/src/utils/comparativePeriod';
import {
  balanceSheetComparisonRows,
  comparativeChange,
  profitAndLossComparisonRows,
  tradingAccountComparisonRows,
  trialBalanceComparisonRows,
} from '../client/src/components/accounting/comparative';

const pnl = (overrides: Partial<ProfitAndLossResponse> = {}): ProfitAndLossResponse => ({
  statement: 'PROFIT_AND_LOSS',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  sections: [],
  revenue: 10000,
  otherIncome: 0,
  totalIncome: 10000,
  costOfSales: 4000,
  operatingExpense: 1000,
  otherExpense: 0,
  totalExpenses: 5000,
  grossProfit: 6000,
  netProfit: 5000,
  ...overrides,
});

const group = (
  groupId: string,
  code: string,
  name: string,
  closingDebit: number,
  closingCredit: number,
  children: TrialBalanceGroup[] = []
): TrialBalanceGroup => ({
  groupId,
  code,
  name,
  parentGroupId: null,
  sortOrder: 0,
  openingDebit: 0,
  openingCredit: 0,
  periodDebit: closingDebit,
  periodCredit: closingCredit,
  closingDebit,
  closingCredit,
  accounts: [],
  children,
});

const tb = (groups: TrialBalanceGroup[]): TrialBalanceResponse => ({
  statement: 'TRIAL_BALANCE',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  groups,
  sections: [],
  accounts: [],
  totals: {
    openingDebit: 0,
    openingCredit: 0,
    periodDebit: 0,
    periodCredit: 0,
    closingDebit: 0,
    closingCredit: 0,
  },
  balanced: true,
  controls: [],
  controlsReconciled: true,
});

const balance = (overrides: Partial<BalanceSheetResponse> = {}): BalanceSheetResponse => ({
  statement: 'BALANCE_SHEET',
  branchId: 'ALL',
  from: null,
  asOf: '2026-11-02',
  assets: { sections: [], total: 50000 },
  liabilities: { sections: [], total: 10000 },
  equity: { sections: [], postedTotal: 20000, currentEarnings: 20000, total: 40000 },
  totalAssets: 50000,
  cashAndBank: 0,
  totalLiabilities: 10000,
  totalEquity: 40000,
  totalLiabilitiesAndEquity: 50000,
  difference: 0,
  balanced: true,
  interBranch: { dueFromHeadOffice: 0, dueToHeadOffice: 0 },
  ...overrides,
});

test('the prior window is equal length and ends the day before the current start', () => {
  assert.deepEqual(precedingEqualWindow('2026-07-17', '2026-11-02'), {
    from: '2026-03-30',
    to: '2026-07-16',
    days: 109,
  });
  assert.ok(precedingEqualWindow('2026-07-17', '2026-11-02')!.to < '2026-07-17', 'the prior window must not overlap the current period');
  assert.deepEqual(precedingEqualWindow('2026-11-01', '2026-11-01'), {
    from: '2026-10-31',
    to: '2026-10-31',
    days: 1,
  });
  assert.deepEqual(precedingEqualWindow('2026-01-01', '2026-01-05'), {
    from: '2025-12-27',
    to: '2025-12-31',
    days: 5,
  });
  assert.equal(precedingEqualWindow(null, '2026-11-02'), null);
  assert.equal(inclusiveDays('2026-11-02', '2026-11-01'), null);
  assert.equal(addDaysAD('2026-02-28', 1), '2026-03-01');
});

test('the balance-sheet prior date is the fiscal-year start eve with a deterministic fallback', () => {
  assert.equal(priorBalanceSheetDate('2026-07-17', '2026-11-02'), '2026-07-16');
  assert.equal(priorBalanceSheetDate(null, '2028-02-29'), '2027-02-28');
  assert.equal(priorBalanceSheetDate('2026-07-17', '2026-06-01'), '2025-06-01');
});

test('P&L and trading rows compute change and percentage, but not from a zero prior', () => {
  const current = pnl();
  const prior = pnl({
    revenue: 8000,
    totalIncome: 8000,
    costOfSales: 3000,
    operatingExpense: 500,
    totalExpenses: 3500,
    grossProfit: 5000,
    netProfit: 4500,
  });
  const revenue = profitAndLossComparisonRows(current, prior).find((row) => row.key === 'revenue')!;
  assert.equal(revenue.current, 10000);
  assert.equal(revenue.prior, 8000);
  assert.deepEqual(comparativeChange(revenue), { change: 2000, percent: 25 });

  const zeroPrior = profitAndLossComparisonRows(current, pnl({ revenue: 0 })).find(
    (row) => row.key === 'revenue'
  )!;
  assert.equal(comparativeChange(zeroPrior).percent, null);

  const trading = tradingAccountComparisonRows(current, prior);
  assert.deepEqual(trading.map((row) => row.key), ['revenue', 'cost-of-sales', 'gross-profit']);
  assert.equal(trading[2].prior, 5000);
});

test('a missing prior P&L response leaves prior figures unavailable rather than reusing current', () => {
  const rows = profitAndLossComparisonRows(pnl(), null);
  assert.ok(rows.every((row) => row.prior === null));
  assert.equal(comparativeChange(rows[0]).change, null);
});

test('trial-balance comparison carries group and sub-group closing balances, missing groups at zero', () => {
  const current = tb([
    group('g-ca', 'CA', 'Current Assets', 1000, 0, [
      group('g-cash', 'CASH', 'Cash & Bank', 1000, 0),
    ]),
  ]);
  const prior = tb([group('g-ca', 'CA', 'Current Assets', 600, 0)]);
  const rows = trialBalanceComparisonRows(current, prior);
  const ca = rows.find((row) => row.key === 'group-g-ca')!;
  assert.equal(ca.current, 1000);
  assert.equal(ca.prior, 600);
  assert.deepEqual(comparativeChange(ca), { change: 400, percent: 66.7 });
  const cash = rows.find((row) => row.key === 'group-g-cash')!;
  assert.equal(cash.prior, 0, 'a group missing from the prior chart has a zero prior balance');
});

test('balance-sheet comparison keeps each period current earnings separate', () => {
  const current = balance();
  const prior = balance({
    totalAssets: 40000,
    totalLiabilities: 5000,
    equity: { sections: [], postedTotal: 20000, currentEarnings: 15000, total: 35000 },
    totalEquity: 35000,
    totalLiabilitiesAndEquity: 40000,
  });
  const rows = balanceSheetComparisonRows(current, prior);
  const earnings = rows.find((row) => row.key === 'current-earnings')!;
  assert.equal(earnings.current, 20000);
  assert.equal(earnings.prior, 15000);
  assert.equal(rows.find((row) => row.key === 'total-assets')!.prior, 40000);
});
