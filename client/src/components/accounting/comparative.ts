/**
 * Comparative rows built from two statement responses. The current figures are
 * already on screen; the prior response is fetched for the preceding window.
 * No journal is read here and no missing prior figure is substituted with a
 * current one — `null` means "not available", while a real empty prior
 * statement contributes zeroes.
 */
import type {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  TrialBalanceAccount,
  TrialBalanceGroup,
  TrialBalanceResponse,
} from '../../services/api/accounting';

export interface ComparativeRow {
  key: string;
  label: string;
  current: number;
  prior: number | null;
  /** Visual indentation for a group/sub-group row. */
  level?: number;
  emphasis?: boolean;
}

export interface ComparativeChange {
  change: number | null;
  percent: number | null;
}

export const comparativeChange = (row: ComparativeRow): ComparativeChange => {
  if (row.prior === null) return { change: null, percent: null };
  const change = Math.round((row.current - row.prior) * 100) / 100;
  const percent =
    Math.abs(row.prior) < 0.005
      ? null
      : Math.round((change / Math.abs(row.prior)) * 1000) / 10;
  return { change, percent };
};

const row = (
  key: string,
  label: string,
  current: number,
  prior: number | null,
  emphasis = false
): ComparativeRow => ({ key, label, current, prior, emphasis });

export function profitAndLossComparisonRows(
  current: ProfitAndLossResponse,
  prior: ProfitAndLossResponse | null
): ComparativeRow[] {
  const at = (value: (statement: ProfitAndLossResponse) => number) =>
    prior ? value(prior) : null;
  return [
    row('revenue', 'Revenue', current.revenue, at((statement) => statement.revenue)),
    row('other-income', 'Other income', current.otherIncome, at((statement) => statement.otherIncome)),
    row('total-income', 'Total income', current.totalIncome, at((statement) => statement.totalIncome), true),
    row('cost-of-sales', 'Cost of sales', current.costOfSales, at((statement) => statement.costOfSales)),
    row('gross-profit', 'Gross profit', current.grossProfit, at((statement) => statement.grossProfit), true),
    row('operating-expense', 'Operating expenses', current.operatingExpense, at((statement) => statement.operatingExpense)),
    row('other-expense', 'Other expenses', current.otherExpense, at((statement) => statement.otherExpense)),
    row('total-expenses', 'Total expenses', current.totalExpenses, at((statement) => statement.totalExpenses), true),
    row('net-profit', 'Net profit', current.netProfit, at((statement) => statement.netProfit), true),
  ];
}

export function tradingAccountComparisonRows(
  current: ProfitAndLossResponse,
  prior: ProfitAndLossResponse | null
): ComparativeRow[] {
  const at = (value: (statement: ProfitAndLossResponse) => number) =>
    prior ? value(prior) : null;
  return [
    row('revenue', 'Revenue', current.revenue, at((statement) => statement.revenue)),
    row('cost-of-sales', 'Cost of sales', current.costOfSales, at((statement) => statement.costOfSales)),
    row('gross-profit', 'Gross profit', current.grossProfit, at((statement) => statement.grossProfit), true),
  ];
}

export function balanceSheetComparisonRows(
  current: BalanceSheetResponse,
  prior: BalanceSheetResponse | null
): ComparativeRow[] {
  const at = (value: (statement: BalanceSheetResponse) => number) =>
    prior ? value(prior) : null;
  return [
    row('total-assets', 'Total assets', current.totalAssets, at((statement) => statement.totalAssets), true),
    row('total-liabilities', 'Total liabilities', current.totalLiabilities, at((statement) => statement.totalLiabilities)),
    row('current-earnings', 'Current earnings', current.equity.currentEarnings, at((statement) => statement.equity.currentEarnings)),
    row('total-equity', 'Total equity', current.totalEquity, at((statement) => statement.totalEquity)),
    row('total-liabilities-equity', 'Total liabilities & equity', current.totalLiabilitiesAndEquity, at((statement) => statement.totalLiabilitiesAndEquity), true),
    row('difference', 'Difference', current.difference, at((statement) => statement.difference)),
  ];
}

const flattenGroups = (
  groups: readonly TrialBalanceGroup[],
  map: Map<string, TrialBalanceGroup> = new Map()
): Map<string, TrialBalanceGroup> => {
  for (const group of groups) {
    map.set(group.groupId, group);
    flattenGroups(group.children, map);
  }
  return map;
};

const groupBalance = (group: TrialBalanceGroup): number =>
  Math.round((group.closingDebit - group.closingCredit) * 100) / 100;

const accountBalance = (account: TrialBalanceAccount): number =>
  Math.round((account.closingDebit - account.closingCredit) * 100) / 100;

/**
 * Current vs prior closing balance for every group and sub-group. A group that
 * did not exist in the prior chart contributes zero, which is the truthful
 * prior balance for a newly created group.
 */
export function trialBalanceComparisonRows(
  current: TrialBalanceResponse,
  prior: TrialBalanceResponse | null,
  includeAccounts = true
): ComparativeRow[] {
  const priorGroups = prior ? flattenGroups(prior.groups || []) : new Map<string, TrialBalanceGroup>();
  const priorAccounts = new Map(
    (prior?.accounts || []).map((account) => [account.accountId, account])
  );
  const rows: ComparativeRow[] = [];

  const walk = (groups: readonly TrialBalanceGroup[], level: number) => {
    for (const group of groups) {
      rows.push({
        key: `group-${group.groupId}`,
        label: `${group.code} · ${group.name}`,
        current: groupBalance(group),
        prior: prior ? groupBalance(priorGroups.get(group.groupId) ?? { ...group, closingDebit: 0, closingCredit: 0 }) : null,
        level,
      });
      for (const account of includeAccounts ? group.accounts : []) {
        const previous = priorAccounts.get(account.accountId);
        rows.push({
          key: `account-${account.accountId}`,
          label: `${account.code} · ${account.name}`,
          current: accountBalance(account),
          prior: prior ? (previous ? accountBalance(previous) : 0) : null,
          level: level + 1,
        });
      }
      walk(group.children, level + 1);
    }
  };
  walk(current.groups || [], 0);

  if (rows.length === 0) {
    for (const account of includeAccounts ? current.accounts : []) {
      const previous = priorAccounts.get(account.accountId);
      rows.push({
        key: `account-${account.accountId}`,
        label: `${account.code} · ${account.name}`,
        current: accountBalance(account),
        prior: prior ? (previous ? accountBalance(previous) : 0) : null,
      });
    }
  }
  return rows;
}
