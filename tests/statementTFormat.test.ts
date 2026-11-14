/**
 * T-account presentation for the existing statement responses.
 *
 * These tests pin the arithmetic that makes the two sides agree. The figures
 * are supplied by the statement API; the T view must not invent closing stock
 * or recompute the ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  StatementSection,
} from '../client/src/services/api/accounting';
import {
  buildBalanceSheetTAccount,
  buildProfitAndLossTAccount,
  buildTradingAccount,
} from '../client/src/components/accounting/statementTFormat';

const section = (
  statementGroup: StatementSection['statementGroup'],
  label: string,
  amount: number
): StatementSection => ({ statementGroup, label, amount, groups: [] });

const profitAndLoss = (
  overrides: Partial<ProfitAndLossResponse> = {}
): ProfitAndLossResponse => ({
  statement: 'PROFIT_AND_LOSS',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2026-11-02',
  sections: [
    section('REVENUE', 'Revenue', 1000),
    section('COST_OF_SALES', 'Cost of sales', 600),
    section('OPERATING_EXPENSE', 'Operating expenses', 200),
    section('OTHER_INCOME', 'Other income', 50),
    section('OTHER_EXPENSE', 'Other expenses', 10),
  ],
  revenue: 1000,
  otherIncome: 50,
  totalIncome: 1050,
  costOfSales: 600,
  operatingExpense: 200,
  otherExpense: 10,
  totalExpenses: 810,
  grossProfit: 400,
  netProfit: 240,
  ...overrides,
});

test('trading account carries gross profit down and both sides agree', () => {
  const report = buildTradingAccount(profitAndLoss());
  assert.equal(report.debit.total, 1000);
  assert.equal(report.credit.total, 1000);
  assert.equal(report.balanced, true);
  assert.equal(report.debit.entries[0].label, 'Gross profit c/d');
  assert.equal(report.credit.sections[0].statementGroup, 'REVENUE');
});

test('a gross loss is carried down on the credit side of the trading account', () => {
  const report = buildTradingAccount(
    profitAndLoss({
      revenue: 500,
      totalIncome: 520,
      costOfSales: 700,
      operatingExpense: 50,
      otherIncome: 20,
      otherExpense: 0,
      totalExpenses: 750,
      grossProfit: -200,
      netProfit: -230,
      sections: [
        section('REVENUE', 'Revenue', 500),
        section('COST_OF_SALES', 'Cost of sales', 700),
        section('OPERATING_EXPENSE', 'Operating expenses', 50),
        section('OTHER_INCOME', 'Other income', 20),
      ],
    })
  );
  assert.equal(report.debit.total, 700);
  assert.equal(report.credit.total, 700);
  assert.equal(report.credit.entries[0].label, 'Gross loss c/d');
});

test('profit and loss T view carries net profit to the debit side and net loss to the credit side', () => {
  const profitable = buildProfitAndLossTAccount(profitAndLoss());
  assert.equal(profitable.debit.total, 450);
  assert.equal(profitable.credit.total, 450);
  assert.equal(profitable.debit.entries.at(-1)?.label, 'Net profit c/d');

  const loss = buildProfitAndLossTAccount(
    profitAndLoss({
      revenue: 500,
      totalIncome: 520,
      costOfSales: 700,
      operatingExpense: 50,
      otherIncome: 20,
      otherExpense: 0,
      totalExpenses: 750,
      grossProfit: -200,
      netProfit: -230,
      sections: [
        section('REVENUE', 'Revenue', 500),
        section('COST_OF_SALES', 'Cost of sales', 700),
        section('OPERATING_EXPENSE', 'Operating expenses', 50),
        section('OTHER_INCOME', 'Other income', 20),
      ],
    })
  );
  assert.equal(loss.debit.total, 250);
  assert.equal(loss.credit.total, 250);
  assert.equal(loss.credit.entries.at(-1)?.label, 'Net loss c/d');
  assert.equal(loss.debit.entries[0].label, 'Gross loss b/d');
});

test('balance sheet T view adds current earnings exactly once', () => {
  const data: BalanceSheetResponse = {
    statement: 'BALANCE_SHEET',
    branchId: 'ALL',
    from: null,
    asOf: '2026-11-02',
    assets: { sections: [section('CURRENT_ASSET', 'Current assets', 1000)], total: 1000 },
    liabilities: { sections: [section('CURRENT_LIABILITY', 'Current liabilities', 300)], total: 300 },
    equity: {
      sections: [section('EQUITY', 'Equity', 500)],
      postedTotal: 500,
      currentEarnings: 200,
      total: 700,
    },
    totalAssets: 1000,
    cashAndBank: 0,
    totalLiabilities: 300,
    totalEquity: 700,
    totalLiabilitiesAndEquity: 1000,
    difference: 0,
    balanced: true,
    interBranch: { dueFromHeadOffice: 0, dueToHeadOffice: 0 },
  };
  const report = buildBalanceSheetTAccount(data);
  assert.equal(report.debit.total, 1000);
  assert.equal(report.credit.total, 1000);
  assert.equal(report.credit.entries.length, 1);
  assert.equal(report.credit.entries[0].amount, 200);
  assert.equal(report.balanced, true);
});

test('a T-format side with a difference reports it instead of forcing a balance', () => {
  const report = buildProfitAndLossTAccount(
    profitAndLoss({ grossProfit: 500, netProfit: 240 })
  );
  assert.equal(report.debit.total, 450);
  assert.equal(report.credit.total, 550);
  assert.equal(report.balanced, false);
  assert.equal(report.difference, -100);
});
