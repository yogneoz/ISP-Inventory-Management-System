/**
 * T-account presentation for the profit & loss, trading and balance-sheet
 * statements. Nothing here recomputes a statement from journals: every figure
 * comes from the existing statement response, and the balancing lines
 * (gross profit/loss b/d or c/d, net profit/loss c/d) are derived so the two
 * sides visibly agree.
 */
import type {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  StatementSection,
} from '../../services/api/accounting';

export type StatementFormat = 'NORMAL' | 'T_FORMAT';

export interface TAccountEntry {
  key: string;
  label: string;
  amount: number;
}

export interface TAccountSide {
  sections: StatementSection[];
  entries: TAccountEntry[];
  total: number;
}

export interface TAccountReport {
  debit: TAccountSide;
  credit: TAccountSide;
  balanced: boolean;
  difference: number;
}

const round = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

const sectionAmount = (sections: readonly StatementSection[], key: string): number =>
  round(sections.find((section) => section.statementGroup === key)?.amount ?? 0);

const section = (
  sections: readonly StatementSection[],
  key: string
): StatementSection | null => sections.find((item) => item.statementGroup === key) ?? null;

const sectionsFor = (
  sections: readonly StatementSection[],
  keys: readonly string[]
): StatementSection[] =>
  keys
    .map((key) => section(sections, key))
    .filter((item): item is StatementSection => item != null);

const side = (sections: StatementSection[], entries: TAccountEntry[]): TAccountSide => ({
  sections,
  entries,
  total: round(
    sections.reduce((total, item) => round(total + item.amount), 0) +
      entries.reduce((total, entry) => round(total + entry.amount), 0)
  ),
});

/**
 * A statement response can omit a group section while still carrying the
 * authoritative section total (older payloads and chart repairs do this).
 * Keep the side tied to that total with an explicit, labelled gap rather than
 * silently dropping the difference.
 */
const detailGap = (
  key: string,
  label: string,
  expected: number,
  sections: readonly StatementSection[]
): TAccountEntry[] => {
  const detailed = round(
    sections.reduce((total, item) => round(total + item.amount), 0)
  );
  const gap = round(expected - detailed);
  return Math.abs(gap) < 0.005 ? [] : [{ key, label, amount: gap }];
};

const report = (debit: TAccountSide, credit: TAccountSide): TAccountReport => {
  const difference = round(debit.total - credit.total);
  return {
    debit,
    credit,
    difference,
    balanced: Math.abs(difference) < 0.005,
  };
};

/**
 * Trading account: revenue on the credit side, cost of sales on the debit
 * side. A positive gross profit is carried down on the debit side; a gross
 * loss is carried down on the credit side. Closing stock is not a separate
 * line because the ledger's cost of sales already carries the stock movement.
 */
export function buildTradingAccount(data: ProfitAndLossResponse): TAccountReport {
  const costOfSales = sectionsFor(data.sections, ['COST_OF_SALES']);
  const revenue = sectionsFor(data.sections, ['REVENUE']);
  const grossProfit = round(data.revenue - data.costOfSales);
  const debitEntries: TAccountEntry[] = detailGap(
    'cost-detail-gap',
    'Cost of sales not detailed by group',
    data.costOfSales,
    costOfSales
  );
  const creditEntries: TAccountEntry[] = detailGap(
    'revenue-detail-gap',
    'Revenue not detailed by group',
    data.revenue,
    revenue
  );

  if (grossProfit >= 0) {
    debitEntries.push({ key: 'gross-profit-cd', label: 'Gross profit c/d', amount: grossProfit });
  } else {
    creditEntries.push({ key: 'gross-loss-cd', label: 'Gross loss c/d', amount: round(-grossProfit) });
  }

  return report(side(costOfSales, debitEntries), side(revenue, creditEntries));
}

/**
 * Profit & loss in T form: expenses and a positive net profit on the debit
 * side; gross profit brought down and other income on the credit side. A gross
 * loss is brought down on the debit side; a net loss is carried down on the
 * credit side. Every balancing figure is the statement's own reported value.
 */
export function buildProfitAndLossTAccount(data: ProfitAndLossResponse): TAccountReport {
  const debitSections = sectionsFor(data.sections, ['OPERATING_EXPENSE', 'OTHER_EXPENSE']);
  const creditSections = sectionsFor(data.sections, ['OTHER_INCOME']);
  const debitEntries: TAccountEntry[] = detailGap(
    'expense-detail-gap',
    'Expenses not detailed by group',
    round(data.operatingExpense + data.otherExpense),
    debitSections
  );
  const creditEntries: TAccountEntry[] = detailGap(
    'other-income-detail-gap',
    'Other income not detailed by group',
    data.otherIncome,
    creditSections
  );

  if (data.grossProfit >= 0) {
    creditEntries.push({ key: 'gross-profit-bd', label: 'Gross profit b/d', amount: data.grossProfit });
  } else {
    debitEntries.push({ key: 'gross-loss-bd', label: 'Gross loss b/d', amount: round(-data.grossProfit) });
  }
  if (data.netProfit >= 0) {
    debitEntries.push({ key: 'net-profit-cd', label: 'Net profit c/d', amount: data.netProfit });
  } else {
    creditEntries.push({ key: 'net-loss-cd', label: 'Net loss c/d', amount: round(-data.netProfit) });
  }

  return report(side(debitSections, debitEntries), side(creditSections, creditEntries));
}

/**
 * Balance sheet in T form: assets on the debit side, liabilities and equity on
 * the credit side. Current earnings is the same equity line the normal balance
 * sheet reports; it is added once, never duplicated inside the equity sections.
 */
export function buildBalanceSheetTAccount(data: BalanceSheetResponse): TAccountReport {
  const debitEntries = detailGap(
    'asset-detail-gap',
    'Assets not detailed by group',
    data.assets.total,
    data.assets.sections
  );
  const debit = side(data.assets.sections, debitEntries);
  const creditEntries: TAccountEntry[] = [
    ...detailGap(
      'liability-detail-gap',
      'Liabilities not detailed by group',
      data.liabilities.total,
      data.liabilities.sections
    ),
    ...detailGap(
      'equity-detail-gap',
      'Posted equity not detailed by group',
      data.equity.postedTotal,
      data.equity.sections
    ),
    {
      key: 'current-earnings',
      label: 'Current earnings',
      amount: data.equity.currentEarnings,
    },
  ];
  const credit = side(
    [...data.liabilities.sections, ...data.equity.sections],
    creditEntries
  );
  return report(debit, credit);
}

export const statementSectionAmount = sectionAmount;
