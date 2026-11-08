/**
 * Finance Dashboard — the finance and accounting landing view.
 *
 * Every figure here is read from the same POSTED ledger as the statutory
 * registers: P&L, balance sheet, cash flow, cash book and AR/AP aging. The
 * screen never derives a statement from operational registers and never treats
 * a balancing figure as equity.
 *
 * The old `financial-statements` tab id and `fin-statements` permission are
 * retained deliberately. They are saved in navigation preferences and the RBAC
 * matrix; only the screen and its menu home changed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Clock,
  Download,
  Landmark,
  ListTree,
  Printer,
  Scale,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import StatCard from '../../components/common/StatCard';
import {
  AccountingRegisterShell,
  RegisterEmpty,
  useAccountingScope,
} from '../../components/accounting/AccountingRegisterShell';
import type { AccountingScreenProps } from '../../components/accounting/AccountingRegisterShell';
import { api } from '../../services/api';
import type {
  AgingBucketKey,
  AgingResponse,
  BalanceSheetResponse,
  CashBookResponse,
  CashFlowResponse,
  ProfitAndLossResponse,
  StatementGroupBlock,
  StatementSection,
} from '../../services/api/accounting';
import { formatMoney } from '../../utils/nprFormat';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import {
  FinanceBranchComparison,
  metricsForBranch,
  type FinanceBranchRow,
} from '../../components/accounting/FinanceBranchComparison';
import {
  LedgerDrilldownDialog,
  type LedgerDrilldownRequest,
} from '../../components/accounting/LedgerDrilldownDialog';
import type { FiscalYear } from '../../types';
import type { NavTab } from '../../components/layout/Sidebar';

interface FinanceDashboardProps extends AccountingScreenProps {
  fiscalYears: FiscalYear[];
  currentFiscalYear?: FiscalYear | null;
  /** Any register refresh (including a full refresh) re-reads the dashboard. */
  refreshToken?: number;
  onNavigateTab?: (tab: NavTab) => void;
}

interface DashboardData {
  pnl: ProfitAndLossResponse;
  balance: BalanceSheetResponse;
  cashFlow: CashFlowResponse | null;
  cashBook: CashBookResponse | null;
  ar: AgingResponse | null;
  ap: AgingResponse | null;
  priorPnl: ProfitAndLossResponse | null;
  priorBalance: BalanceSheetResponse | null;
  partialFailures: string[];
}

type DashboardView = 'overview' | 'comparison';

interface BranchComparisonState {
  rows: FinanceBranchRow[];
  failures: string[];
}

interface CashMonth {
  key: string;
  label: string;
  title: string;
  receipts: number;
  payments: number;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const AGING_COLORS: Record<AgingBucketKey, string> = {
  CURRENT: 'bg-emerald-500',
  DAYS_1_30: 'bg-amber-400',
  DAYS_31_60: 'bg-orange-500',
  DAYS_61_90: 'bg-rose-500',
  DAYS_90_PLUS: 'bg-red-700',
};

const panelClass =
  'rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-[#0f1218]';

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatPercent = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(1)}%`;

const formatRatio = (value: number | null): string =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}×`;

const sectionAmount = (
  sections: ReadonlyArray<{ statementGroup: string; amount: number }> | undefined,
  key: string
): number => n(sections?.find((section) => section.statementGroup === key)?.amount);

const groupsFromSections = (
  sections: ReadonlyArray<StatementSection> | undefined,
  statementGroups?: string[]
): StatementGroupBlock[] =>
  (sections || [])
    .filter((section) => !statementGroups || statementGroups.includes(section.statementGroup))
    .flatMap((section) => section.groups);

const balanceSheetGroups = (balance: BalanceSheetResponse | null | undefined): StatementGroupBlock[] => [
  ...groupsFromSections(balance?.assets.sections),
  ...groupsFromSections(balance?.liabilities.sections),
  ...groupsFromSections(balance?.equity.sections),
];

const parseAD = (value: string): Date | null => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
};

const addDays = (value: string, days: number): string => {
  const date = parseAD(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const daysBetween = (from: string, to: string): number => {
  const start = parseAD(from);
  const end = parseAD(to);
  if (!start || !end) return 0;
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
};

const buildMonthBuckets = (from: string, to: string): CashMonth[] => {
  const start = parseAD(from);
  const end = parseAD(to);
  if (!start || !end || start > end) return [];
  start.setUTCDate(1);
  const cursor = new Date(start);
  const months: CashMonth[] = [];
  while (cursor <= end && months.length < 24) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    months.push({
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: MONTHS_SHORT[month],
      title: `${MONTHS_LONG[month]} ${year}`,
      receipts: 0,
      payments: 0,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
};

const PanelHeader: React.FC<{
  title: string;
  caption?: string;
  action?: React.ReactNode;
}> = ({ title, caption, action }) => (
  <div className="flex flex-wrap items-start justify-between gap-2">
    <div>
      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</h3>
      {caption && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{caption}</p>}
    </div>
    {action}
  </div>
);

const PriorDelta: React.FC<{
  current: number;
  prior: number | null;
  label: string;
  positiveIsGood?: boolean;
}> = ({ current, prior, label, positiveIsGood = true }) => {
  if (prior === null || !Number.isFinite(prior)) return null;
  const difference = current - prior;
  if (Math.abs(difference) < 0.5) {
    return <span className="text-[10px] text-slate-400">No change vs {label}</span>;
  }
  const improved = positiveIsGood ? difference > 0 : difference < 0;
  const Icon = difference > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${
        improved ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
      }`}
      title={`${formatMoney(Math.abs(difference))} ${difference > 0 ? 'higher' : 'lower'} than ${label}`}
    >
      <Icon className="h-3 w-3" />
      {formatMoney(Math.abs(difference))}
      <span className="font-medium text-slate-400 dark:text-slate-500">vs {label}</span>
    </span>
  );
};

const QuickActions: React.FC<{
  currentUser?: AccountingScreenProps['currentUser'];
  onNavigateTab?: (tab: NavTab) => void;
}> = ({ currentUser, onNavigateTab }) => {
  const actions: Array<{ tab: NavTab; label: string; icon: React.ElementType; permission: string }> = [
    { tab: 'journal-entry', label: 'Journal entry', icon: BookOpen, permission: 'gl-post' },
    { tab: 'cash-bank-entry', label: 'Cash & bank entry', icon: Wallet, permission: 'gl-post' },
    { tab: 'accounting', label: 'Trial balance', icon: Scale, permission: 'gl-view' },
    { tab: 'accounting-profit-loss', label: 'Profit & loss', icon: TrendingUp, permission: 'gl-view' },
    { tab: 'accounting-balance-sheet', label: 'Balance sheet', icon: Landmark, permission: 'gl-view' },
    { tab: 'accounting-aging', label: 'AR / AP aging', icon: Clock, permission: 'gl-view' },
    { tab: 'accounting-chart', label: 'Chart & defaults', icon: ListTree, permission: 'gl-chart-manage' },
  ];
  const visible = actions.filter((action) => isOperationAllowed(action.permission, currentUser?.role));
  if (!visible.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-[#0f1218]">
      <span className="px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        Jump to
      </span>
      {visible.map(({ tab, label, icon: Icon }) => (
        <button
          key={tab}
          type="button"
          onClick={() => onNavigateTab?.(tab)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
        >
          <Icon className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
          {label}
        </button>
      ))}
    </div>
  );
};

const AgingSide: React.FC<{
  title: string;
  data: AgingResponse | null;
  onOpen: () => void;
}> = ({ title, data, onOpen }) => {
  if (!data) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-400 dark:border-slate-700">
        {title} could not be loaded for this scope.
      </div>
    );
  }

  const gross = n(data.totals.grossTotal);
  const credits = n(data.totals.unappliedCredit);
  const total = n(data.totals.total);
  const overdue = Math.max(0, gross - n(data.totals.CURRENT));
  const ninetyPlus = n(data.totals.DAYS_90_PLUS);
  const barTotal = Math.max(gross, 1);

  return (
    <div className="min-w-0 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-bold text-slate-700 dark:text-slate-200">{title}</h4>
          <p className="mt-1 font-serif text-lg font-bold text-slate-800 dark:text-slate-100">
            {formatMoney(total)}
          </p>
          <span className="mt-0.5 block text-[9px] font-medium text-slate-400">net open</span>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${
            data.totals.reconciled
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
          }`}
        >
          {data.totals.reconciled ? 'Tied to control' : 'Control differs'}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        <span>
          Overdue (gross){' '}
          <strong className="font-mono text-slate-700 dark:text-slate-200">{formatMoney(overdue)}</strong>
        </span>
        <span>
          90+ days <strong className="font-mono text-rose-600 dark:text-rose-400">{formatMoney(ninetyPlus)}</strong>
        </span>
        {credits > 0 && (
          <span>
            Unapplied credits{' '}
            <strong className="font-mono text-emerald-600 dark:text-emerald-400">
              −{formatMoney(credits)}
            </strong>
          </span>
        )}
      </div>

      {credits > 0 && (
        <p className="mt-1 text-[9px] leading-snug text-slate-400 dark:text-slate-500">
          Bucket bars show gross open charges; the headline nets {formatMoney(credits)} in unapplied credits.
        </p>
      )}

      <div
        className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        role="img"
        aria-label={`${title} aging by bucket`}
      >
        {data.buckets.map((bucket) => {
          const width = gross > 0 ? (n(bucket.amount) / barTotal) * 100 : 0;
          return (
            <span
              key={bucket.key}
              className={`${AGING_COLORS[bucket.key]} h-full`}
              style={{ width: `${Math.max(0, Math.min(100, width))}%` }}
              title={`${bucket.label}: ${formatMoney(n(bucket.amount))}`}
            />
          );
        })}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        {data.buckets.map((bucket) => (
          <span key={bucket.key} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${AGING_COLORS[bucket.key]}`} />
              <span className="truncate">{bucket.label}</span>
            </span>
            <span className="shrink-0 font-mono text-slate-600 dark:text-slate-300">
              {formatMoney(n(bucket.amount))}
            </span>
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-3 inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
      >
        Open aging report
        <ArrowUpRight className="h-3 w-3" />
      </button>
    </div>
  );
};

export const FinanceDashboard: React.FC<FinanceDashboardProps> = ({
  branches,
  dateMode,
  currentUser,
  fiscalYears,
  currentFiscalYear,
  refreshToken = 0,
  onNavigateTab,
}) => {
  const scope = useAccountingScope(branches, currentUser);
  const activationKey = useActivationKey('financial-statements');
  const isActive = useTabActive('financial-statements') && scope.allowed;
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<DashboardView>('overview');
  const [branchComparison, setBranchComparison] = useState<BranchComparisonState | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [branchReloadKey, setBranchReloadKey] = useState(0);
  const [drill, setDrill] = useState<LedgerDrilldownRequest | null>(null);

  const currentFy = useMemo<FiscalYear | null>(
    () => currentFiscalYear || fiscalYears.find((year) => year.isCurrent) || fiscalYears[0] || null,
    [currentFiscalYear, fiscalYears]
  );

  const priorFy = useMemo<FiscalYear | null>(() => {
    if (!currentFy) return null;
    const ordered = [...fiscalYears].sort((a, b) => b.startDateAD.localeCompare(a.startDateAD));
    const index = ordered.findIndex((year) => year.id === currentFy.id);
    if (index >= 0) return ordered[index + 1] || null;
    return ordered.find((year) => year.endDateAD < currentFy.startDateAD) || null;
  }, [currentFy, fiscalYears]);

  const priorTo = useMemo(() => {
    if (!currentFy || !priorFy || !scope.asOfDate) return null;
    const elapsedDays = daysBetween(currentFy.startDateAD, scope.asOfDate);
    if (elapsedDays < 0) return null;
    const candidate = addDays(priorFy.startDateAD, elapsedDays);
    return candidate > priorFy.endDateAD ? priorFy.endDateAD : candidate;
  }, [currentFy, priorFy, scope.asOfDate]);

  useEffect(() => {
    if (!isActive) return;
    let live = true;

    const load = async () => {
      setLoading(true);
      setError('');
      setData(null);

      const query = {
        branchId: scope.query.branchId,
        from: currentFy?.startDateAD,
        to: scope.asOfDate,
      };
      const priorPnlQuery =
        priorFy && priorTo
          ? { branchId: scope.query.branchId, from: priorFy.startDateAD, to: priorTo }
          : null;

      try {
        const results = await Promise.allSettled(
          [
            api.getProfitAndLoss(query),
            api.getBalanceSheet({ branchId: scope.query.branchId, to: scope.asOfDate }),
            api.getCashFlow(query),
            api.getCashBook(query),
            api.getAging({ type: 'AR', branchId: scope.query.branchId, asOf: scope.asOfDate }),
            api.getAging({ type: 'AP', branchId: scope.query.branchId, asOf: scope.asOfDate }),
            priorPnlQuery ? api.getProfitAndLoss(priorPnlQuery) : Promise.resolve(null),
            priorPnlQuery
              ? api.getBalanceSheet({ branchId: scope.query.branchId, to: priorTo! })
              : Promise.resolve(null),
          ] as const
        );
        if (!live) return;

        const [pnlResult, balanceResult, cashFlowResult, cashBookResult, arResult, apResult, priorPnlResult, priorBalanceResult] =
          results;
        if (pnlResult.status === 'rejected') throw pnlResult.reason;
        if (balanceResult.status === 'rejected') throw balanceResult.reason;

        const failures: string[] = [];
        const optional = <T,>(result: PromiseSettledResult<T>, label: string): T | null => {
          if (result.status === 'fulfilled') return result.value;
          failures.push(label);
          return null;
        };

        setData({
          pnl: pnlResult.value,
          balance: balanceResult.value,
          cashFlow: optional(cashFlowResult, 'cash flow'),
          cashBook: optional(cashBookResult, 'cash book'),
          ar: optional(arResult, 'receivables aging'),
          ap: optional(apResult, 'payables aging'),
          priorPnl: optional(priorPnlResult, 'prior-year P&L'),
          priorBalance: optional(priorBalanceResult, 'prior-year balance sheet'),
          partialFailures: Array.from(new Set(failures)),
        });
      } catch (err: any) {
        if (!live) return;
        setData(null);
        setError(err?.message || 'Failed to load the finance dashboard.');
      } finally {
        if (live) setLoading(false);
      }
    };

    void load();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isActive,
    scope.branchId,
    scope.asOfDate,
    currentFy?.id,
    priorFy?.id,
    priorTo,
    activationKey,
    reloadKey,
    refreshToken,
  ]);

  useEffect(() => {
    if (!isActive || view !== 'comparison' || !currentFy || scope.scopedBranches.length === 0) return;
    let live = true;
    setBranchLoading(true);
    setBranchError('');
    setBranchComparison(null);

    const load = async () => {
      try {
        const rows = await Promise.all(
          scope.scopedBranches.map(async (branch): Promise<FinanceBranchRow> => {
            const [pnlResult, balanceResult] = await Promise.allSettled([
              api.getProfitAndLoss({
                branchId: branch.id,
                from: currentFy.startDateAD,
                to: scope.asOfDate,
              }),
              api.getBalanceSheet({ branchId: branch.id, to: scope.asOfDate }),
            ]);
            const pnl = pnlResult.status === 'fulfilled' ? pnlResult.value : null;
            const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
            const failures = [
              pnlResult.status === 'rejected' ? 'P&L' : '',
              balanceResult.status === 'rejected' ? 'balance sheet' : '',
            ].filter(Boolean);
            return {
              branchId: branch.id,
              code: branch.code,
              name: branch.name,
              pnl,
              balance,
              error: failures.length ? `Could not load ${failures.join(' and ')}` : undefined,
            };
          })
        );
        if (!live) return;
        setBranchComparison({
          rows,
          failures: rows
            .filter((row) => row.error)
            .map((row) => `${row.code} · ${row.name}`),
        });
      } catch (err: any) {
        if (!live) return;
        setBranchComparison(null);
        setBranchError(err?.message || 'The branch comparison could not be loaded.');
      } finally {
        if (live) setBranchLoading(false);
      }
    };

    void load();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isActive,
    view,
    currentFy?.id,
    scope.asOfDate,
    scope.scopedBranches,
    activationKey,
    branchReloadKey,
    reloadKey,
    refreshToken,
  ]);

  const asOfLabel = formatDualDate(scope.asOfDate, dateMode);
  const branchLabel =
    scope.branchId === 'ALL'
      ? 'All branches'
      : branches.find((branch) => branch.id === scope.branchId)?.name || 'Selected branch';
  const periodLabel = currentFy ? `FY ${currentFy.code}` : 'Fiscal year to date';
  const priorLabel = priorFy ? `FY ${priorFy.code} same period` : 'prior year';

  const cashMonths = useMemo(() => {
    if (!data?.cashBook) return [];
    const from = data.cashBook.from || currentFy?.startDateAD || data.pnl.from || '';
    const to = data.cashBook.to || scope.asOfDate;
    const months = buildMonthBuckets(from, to);
    if (!months.length) return months;
    const byKey = new Map(months.map((month) => [month.key, month]));
    for (const account of data.cashBook.accounts) {
      for (const entry of account.entries) {
        const bucket = byKey.get(String(entry.journalDateAD).slice(0, 7));
        if (!bucket) continue;
        const amount = n(entry.type === 'RECEIPT' ? entry.debit : entry.credit);
        if (entry.type === 'RECEIPT') bucket.receipts += amount;
        else bucket.payments += amount;
      }
    }
    return months;
  }, [data, currentFy?.startDateAD, scope.asOfDate]);

  const recentCashEntries = useMemo(() => {
    if (!data?.cashBook) return [];
    return data.cashBook.accounts
      .flatMap((account) =>
        account.entries.map((entry) => ({
          ...entry,
          accountName: account.name,
          accountCode: account.code,
        }))
      )
      .sort((a, b) => {
        const dateOrder = String(b.journalDateAD).localeCompare(String(a.journalDateAD));
        return dateOrder || String(b.journalNo).localeCompare(String(a.journalNo));
      })
      .slice(0, 6);
  }, [data]);

  if (!data) {
    return (
      <AccountingRegisterShell
        title="Finance Dashboard"
        description="Ledger-backed profitability, liquidity and control health. Every figure is calculated from posted journal lines."
        icon={<Landmark className="h-5 w-5 text-indigo-500" />}
        registerName="finance dashboard"
        scope={scope}
        dateMode={dateMode}
        printable
        loading={loading}
        error={error}
        onRefresh={() => setReloadKey((key) => key + 1)}
        onRetry={() => setReloadKey((key) => key + 1)}
      >
        {!loading && !error && (
          <RegisterEmpty message="No posted ledger data has been loaded for this scope yet." />
        )}
      </AccountingRegisterShell>
    );
  }

  const totalIncome = n(data.pnl.totalIncome);
  const revenue = n(data.pnl.revenue);
  const grossProfit = n(data.pnl.grossProfit);
  const totalExpenses = n(data.pnl.totalExpenses);
  const netProfit = n(data.pnl.netProfit);
  const grossMargin = totalIncome !== 0 ? (grossProfit / totalIncome) * 100 : null;
  const netMargin = totalIncome !== 0 ? (netProfit / totalIncome) * 100 : null;
  const expenseRatio = totalIncome !== 0 ? (totalExpenses / totalIncome) * 100 : null;

  const currentAssets = sectionAmount(data.balance.assets.sections, 'CURRENT_ASSET');
  const currentLiabilities = sectionAmount(data.balance.liabilities.sections, 'CURRENT_LIABILITY');
  const workingCapital = currentAssets - currentLiabilities;
  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : null;
  const cash = n(data.balance.cashAndBank);
  const receivables = n(data.ar?.totals.total);
  const payables = n(data.ap?.totals.total);
  const netCashFlow = n(data.cashFlow?.netCashFlow);

  const priorNetProfit = data.priorPnl ? n(data.priorPnl.netProfit) : null;
  const priorRevenue = data.priorPnl ? n(data.priorPnl.revenue) : null;
  const priorCash = data.priorBalance ? n(data.priorBalance.cashAndBank) : null;
  const priorCurrentAssets = data.priorBalance
    ? sectionAmount(data.priorBalance.assets.sections, 'CURRENT_ASSET')
    : null;
  const priorCurrentLiabilities = data.priorBalance
    ? sectionAmount(data.priorBalance.liabilities.sections, 'CURRENT_LIABILITY')
    : null;
  const priorWorkingCapital =
    priorCurrentAssets !== null && priorCurrentLiabilities !== null
      ? priorCurrentAssets - priorCurrentLiabilities
      : null;

  const allocationRows = [
    {
      key: 'cogs',
      label: 'Cost of sales',
      value: n(data.pnl.costOfSales),
      bar: 'bg-rose-500',
      text: 'text-rose-600 dark:text-rose-400',
    },
    {
      key: 'opex',
      label: 'Operating expenses',
      value: n(data.pnl.operatingExpense),
      bar: 'bg-amber-400',
      text: 'text-amber-600 dark:text-amber-400',
    },
    {
      key: 'other-expense',
      label: 'Other expenses',
      value: n(data.pnl.otherExpense),
      bar: 'bg-orange-500',
      text: 'text-orange-600 dark:text-orange-400',
    },
    {
      key: 'net',
      label: netProfit >= 0 ? 'Net profit' : 'Net loss',
      value: netProfit,
      bar: netProfit >= 0 ? 'bg-emerald-500' : 'bg-rose-600',
      text: netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
    },
  ].filter((row) => row.key === 'net' || Math.abs(row.value) > 0.004);

  const incomeBase = Math.max(Math.abs(totalIncome), 1);

  const cashAccounts = [...(data.cashBook?.accounts || [])].sort(
    (a, b) => Math.abs(n(b.closing)) - Math.abs(n(a.closing))
  );
  const cashAccountMax = Math.max(1, ...cashAccounts.map((account) => Math.abs(n(account.closing))));
  const chartReceipts = cashMonths.reduce((sum, month) => sum + month.receipts, 0);
  const chartPayments = cashMonths.reduce((sum, month) => sum + month.payments, 0);
  const chartMax = Math.max(1, ...cashMonths.flatMap((month) => [month.receipts, month.payments]));

  const pnlGroups = groupsFromSections(data.pnl.sections);
  const revenueGroups = groupsFromSections(data.pnl.sections, ['REVENUE', 'OTHER_INCOME']);
  const workingCapitalGroups = [
    ...groupsFromSections(data.balance.assets.sections, ['CURRENT_ASSET']),
    ...groupsFromSections(data.balance.liabilities.sections, ['CURRENT_LIABILITY']),
  ];
  const allBalanceGroups = balanceSheetGroups(data.balance);
  const cashBookDrillEntries = (data.cashBook?.accounts || []).flatMap((account) =>
    account.entries.map((entry) => ({
      ...entry,
      accountCode: account.code,
      accountName: account.name,
    }))
  );
  const cashFlowAccountIds = Array.from(
    new Set((data.cashFlow?.sections || []).flatMap((section) => section.lines.map((line) => line.accountId)))
  );
  const companyRow: FinanceBranchRow | null =
    scope.branchId === 'ALL'
      ? {
          branchId: 'ALL',
          code: 'ALL',
          name: 'All branches (company level)',
          pnl: data.pnl,
          balance: data.balance,
        }
      : null;
  const branchRows = branchComparison?.rows || [];
  const branchFailureText = branchComparison?.failures.length
    ? `Some branches could not be fully loaded: ${branchComparison.failures.join(', ')}.`
    : '';
  const branchBusy = view === 'comparison' && (branchLoading || !branchComparison);

  const controls = [
    {
      key: 'balance-sheet',
      label: 'Balance sheet',
      ok: data.balance.balanced,
      detail: data.balance.balanced
        ? 'Assets equal liabilities plus equity'
        : `Out of balance by ${formatMoney(Math.abs(n(data.balance.difference)))}`,
      tab: 'accounting-balance-sheet' as NavTab,
    },
    {
      key: 'cash-flow',
      label: 'Cash flow',
      ok: data.cashFlow?.reconciled ?? null,
      detail: data.cashFlow
        ? data.cashFlow.reconciled
          ? 'Closing cash ties to the cash book'
          : `Cash difference ${formatMoney(Math.abs(n(data.cashFlow.difference)))}`
        : 'Cash flow not loaded',
      tab: 'accounting-cash-flow' as NavTab,
    },
    {
      key: 'receivables',
      label: 'Receivables control',
      ok: data.ar?.totals.reconciled ?? null,
      detail: data.ar
        ? data.ar.totals.reconciled
          ? 'Aging total ties to the control account'
          : `Control difference ${formatMoney(Math.abs(n(data.ar.totals.difference)))}`
        : 'Aging not loaded',
      tab: 'accounting-aging' as NavTab,
    },
    {
      key: 'payables',
      label: 'Payables control',
      ok: data.ap?.totals.reconciled ?? null,
      detail: data.ap
        ? data.ap.totals.reconciled
          ? 'Aging total ties to the control account'
          : `Control difference ${formatMoney(Math.abs(n(data.ap.totals.difference)))}`
        : 'Aging not loaded',
      tab: 'accounting-aging' as NavTab,
    },
  ];
  const checkedControls = controls.filter((control) => control.ok !== null);
  const passedControls = checkedControls.filter((control) => control.ok === true).length;
  const allControlsTie = checkedControls.length === controls.length && passedControls === controls.length;

  const goTo = (tab: NavTab) => onNavigateTab?.(tab);

  const openStatementDrill = (
    title: string,
    subtitle: string,
    statement: 'PROFIT_AND_LOSS' | 'BALANCE_SHEET',
    groups: StatementGroupBlock[],
    from: string | null | undefined,
    to: string,
    branchId?: string | null
  ) => {
    if (!groups.length) return;
    setDrill({
      kind: 'statement-groups',
      title,
      subtitle,
      statement,
      groups,
      branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
      from: from || undefined,
      to,
    });
  };

  const openAccountDrill = (
    title: string,
    subtitle: string,
    accountIds: string[],
    from: string | null | undefined,
    to: string,
    branchId?: string | null
  ) => {
    if (!accountIds.length) return;
    setDrill({
      kind: 'accounts',
      title,
      subtitle,
      accountIds,
      branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
      from: from || undefined,
      to,
    });
  };

  const openPnlLines = (title: string, pnl: ProfitAndLossResponse, branchId?: string | null) => {
    openStatementDrill(
      title,
      `Profit & loss · ${pnl.from || 'from inception'} → ${pnl.to}`,
      'PROFIT_AND_LOSS',
      groupsFromSections(pnl.sections),
      pnl.from,
      pnl.to,
      branchId
    );
  };

  const openBalanceLines = (title: string, balance: BalanceSheetResponse, branchId?: string | null) => {
    openStatementDrill(
      title,
      `Balance sheet · as of ${balance.asOf}`,
      'BALANCE_SHEET',
      balanceSheetGroups(balance),
      null,
      balance.asOf,
      branchId
    );
  };

  const openKpiDrill = (kind: 'net-profit' | 'revenue' | 'cash' | 'working-capital') => {
    if (kind === 'net-profit') {
      openStatementDrill(
        'Posted P&L lines — Net profit',
        `All posted profit-and-loss groups · ${periodLabel} · ${asOfLabel}`,
        'PROFIT_AND_LOSS',
        pnlGroups,
        data.pnl.from,
        data.pnl.to,
        scope.query.branchId
      );
      return;
    }
    if (kind === 'revenue') {
      openStatementDrill(
        'Posted income lines — Revenue',
        `Revenue and other income groups · ${periodLabel} · ${asOfLabel}`,
        'PROFIT_AND_LOSS',
        revenueGroups,
        data.pnl.from,
        data.pnl.to,
        scope.query.branchId
      );
      return;
    }
    if (kind === 'working-capital') {
      openStatementDrill(
        'Posted working-capital lines',
        `Current assets and current liabilities · as of ${asOfLabel}`,
        'BALANCE_SHEET',
        workingCapitalGroups,
        null,
        data.balance.asOf,
        scope.query.branchId
      );
      return;
    }
    if (!data.cashBook) return;
    setDrill({
      kind: 'cash-book',
      title: 'Posted cash & bank lines',
      subtitle: `${branchLabel} · ${data.cashBook.from || periodLabel} → ${data.cashBook.to}`,
      entries: cashBookDrillEntries,
    });
  };

  const openControlDrill = (key: string) => {
    if (key === 'balance-sheet') {
      openStatementDrill(
        'Posted balance-sheet lines — Control',
        `All posted asset, liability and equity groups · as of ${asOfLabel}`,
        'BALANCE_SHEET',
        allBalanceGroups,
        null,
        data.balance.asOf,
        scope.query.branchId
      );
      return;
    }
    if (key === 'cash-flow') {
      if (!data.cashFlow) return;
      openAccountDrill(
        'Posted cash-flow lines — Control',
        `Opening balances plus posted movement through ${data.cashFlow.to}`,
        cashFlowAccountIds,
        data.cashFlow.from,
        data.cashFlow.to,
        scope.query.branchId
      );
      return;
    }
    const aging = key === 'receivables' ? data.ar : data.ap;
    if (!aging) return;
    openAccountDrill(
      key === 'receivables' ? 'Posted receivable control lines' : 'Posted payable control lines',
      `${aging.account.code} · ${aging.account.name} · opening balance plus posted movement through ${asOfLabel}`,
      [aging.account.accountId],
      data.pnl.from,
      scope.asOfDate,
      scope.query.branchId
    );
  };

  const openBranchPnlLines = (row: FinanceBranchRow) => {
    if (!row.pnl) return;
    openPnlLines(
      `Posted P&L lines — ${row.code} ${row.name}`,
      row.pnl,
      row.branchId === 'ALL' ? null : row.branchId
    );
  };

  const openBranchBalanceLines = (row: FinanceBranchRow) => {
    if (!row.balance) return;
    openBalanceLines(
      `Posted balance-sheet lines — ${row.code} ${row.name}`,
      row.balance,
      row.branchId === 'ALL' ? null : row.branchId
    );
  };

  const handlePrint = () => {
    if (!data || branchBusy) return;
    window.print();
  };

  const handleExport = () => {
    if (!data || branchBusy) return;
    const safeFy = (currentFy?.code || 'FY').replace(/[^a-zA-Z0-9-]+/g, '-');
    const priorValue = (value: number | null) =>
      value === null ? 'Prior value unavailable' : `${formatMoney(value)} prior`;

    if (view === 'comparison') {
      const rows = [companyRow, ...branchRows].filter(Boolean) as FinanceBranchRow[];
      if (!rows.length) return;
      exportToCSV({
        filename: `Finance_Branch_Comparison_${safeFy}_${scope.asOfDate}`,
        data: rows.map((row) => {
          const metrics = metricsForBranch(row.pnl, row.balance);
          return {
            branch: `${row.code} · ${row.name}`,
            revenue: metrics.revenue,
            netProfit: metrics.netProfit,
            netMargin: metrics.netMargin === null ? '' : metrics.netMargin,
            cashAndBank: metrics.cash,
            workingCapital: metrics.workingCapital,
            currentRatio: metrics.currentRatio === null ? '' : metrics.currentRatio,
            status: row.error ? `Partial — ${row.error}` : 'Posted',
          };
        }),
        columns: [
          { key: 'branch', label: 'Branch' },
          { key: 'revenue', label: 'Revenue (NPR)' },
          { key: 'netProfit', label: 'Net profit (NPR)' },
          { key: 'netMargin', label: 'Net margin (%)' },
          { key: 'cashAndBank', label: 'Cash & bank (NPR)' },
          { key: 'workingCapital', label: 'Working capital (NPR)' },
          { key: 'currentRatio', label: 'Current ratio' },
          { key: 'status', label: 'Read status' },
        ],
        reportTitle: `Finance Dashboard — Branch Comparison — ${periodLabel} — as of ${asOfLabel}`,
        branchName:
          scope.branchId === 'ALL' ? 'All branches (company level)' : `${branchLabel} comparison`,
        generatedBy: currentUser?.name,
      });
      return;
    }

    const rows: Array<Record<string, any>> = [];
    const add = (section: string, metric: string, value: string | number, detail = '') => {
      rows.push({ section, metric, value, detail });
    };

    add('Scope', 'Fiscal year', periodLabel, `${branchLabel} · as of ${asOfLabel}`);
    add('Scope', 'Prior comparison', priorLabel, `${priorFy?.startDateAD || '—'} → ${priorTo || '—'}`);
    add('KPI', 'Net profit', netProfit, `Net margin ${formatPercent(netMargin)} · ${priorValue(priorNetProfit)}`);
    add('KPI', 'Revenue', revenue, `Gross margin ${formatPercent(grossMargin)} · ${priorValue(priorRevenue)}`);
    add('KPI', 'Cash & bank', cash, `Net cash flow ${formatMoney(netCashFlow)} · ${priorValue(priorCash)}`);
    add('KPI', 'Working capital', workingCapital, `Current ratio ${formatRatio(currentRatio)} · ${priorValue(priorWorkingCapital)}`);

    add('Income allocation', 'Total income', totalIncome, 'Revenue and other income');
    add('Income allocation', 'Cost of sales', n(data.pnl.costOfSales), 'Posted cost of sales');
    add('Income allocation', 'Operating expenses', n(data.pnl.operatingExpense), 'Posted operating expenses');
    add('Income allocation', 'Other expenses', n(data.pnl.otherExpense), 'Posted other expenses');
    add('Income allocation', 'Gross profit', grossProfit, `Gross margin ${formatPercent(grossMargin)}`);
    add('Income allocation', 'Total expenses', totalExpenses, `Expense ratio ${formatPercent(expenseRatio)}`);
    add('Income allocation', netProfit >= 0 ? 'Net profit' : 'Net loss', netProfit, `Net margin ${formatPercent(netMargin)}`);

    if (data.cashBook) {
      add('Cash & bank', 'Opening', n(data.cashBook.opening), data.cashBook.from || 'Period opening');
      add('Cash & bank', 'Receipts', n(data.cashBook.receipts), 'Posted cash-book receipts');
      add('Cash & bank', 'Payments', n(data.cashBook.payments), 'Posted cash-book payments');
      add('Cash & bank', 'Closing', n(data.cashBook.closing), `As of ${data.cashBook.to}`);
      for (const account of data.cashBook.accounts) {
        add('Cash & bank account', `${account.code} · ${account.name}`, n(account.closing), 'Closing balance');
      }
    }

    for (const month of cashMonths) {
      add('Cash movement', month.title, month.receipts - month.payments, `Receipts ${formatMoney(month.receipts)} · payments ${formatMoney(month.payments)}`);
    }

    for (const control of controls) {
      add(
        'Ledger controls',
        control.label,
        control.ok === true ? 'Tied' : control.ok === false ? 'Difference' : 'Not loaded',
        control.detail
      );
    }

    for (const [label, aging] of [
      ['Receivables', data.ar],
      ['Payables', data.ap],
    ] as const) {
      if (!aging) continue;
      add('Aging', `${label} net open`, n(aging.totals.total), `Control ${formatMoney(n(aging.totals.controlBalance))}`);
      add('Aging', `${label} gross open`, n(aging.totals.grossTotal), `Unapplied credits ${formatMoney(n(aging.totals.unappliedCredit))}`);
      for (const bucket of aging.buckets) {
        add('Aging', `${label} · ${bucket.label}`, n(bucket.amount), 'Gross bucket');
      }
    }

    for (const entry of recentCashEntries) {
      add(
        'Recent cash activity',
        `${entry.accountCode} · ${entry.accountName}`,
        entry.type === 'RECEIPT' ? n(entry.debit) : -n(entry.credit),
        `${entry.journalNo} · ${entry.journalDateAD} · ${entry.memo || entry.sourceType || ''}`
      );
    }

    exportToCSV({
      filename: `Finance_Dashboard_${safeFy}_${scope.asOfDate}`,
      data: rows,
      columns: [
        { key: 'section', label: 'Section' },
        { key: 'metric', label: 'Metric' },
        { key: 'value', label: 'Value' },
        { key: 'detail', label: 'Detail' },
      ],
      reportTitle: `Finance Dashboard — ${periodLabel} — ${branchLabel}`,
      branchName: branchLabel,
      generatedBy: currentUser?.name,
    });
  };

  const headerActions = (
    <>
      <div
        role="group"
        aria-label="Finance dashboard view"
        className="inline-flex rounded-xl border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900"
      >
        <button
          type="button"
          onClick={() => setView('overview')}
          aria-pressed={view === 'overview'}
          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            view === 'overview'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          Overview
        </button>
        <button
          type="button"
          onClick={() => setView('comparison')}
          aria-pressed={view === 'comparison'}
          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            view === 'comparison'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
          }`}
        >
          Branch comparison
        </button>
      </div>
      <button
        type="button"
        onClick={handlePrint}
        disabled={!data || branchBusy}
        className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Printer className="h-3.5 w-3.5 text-slate-400" /> Print
      </button>
      <button
        type="button"
        onClick={handleExport}
        disabled={!data || branchBusy}
        className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <Download className="h-3.5 w-3.5 text-slate-400" /> Export CSV
      </button>
    </>
  );

  return (
    <>
    <AccountingRegisterShell
      title="Finance Dashboard"
      description="Ledger-backed profitability, liquidity and control health. Every figure is calculated from posted journal lines, not operational registers."
      icon={<Landmark className="h-5 w-5 text-indigo-500" />}
      registerName="finance dashboard"
      scope={scope}
      dateMode={dateMode}
      headerActions={headerActions}
      printable
      loading={loading}
      error={error}
      onRefresh={() => setReloadKey((key) => key + 1)}
      onRetry={() => setReloadKey((key) => key + 1)}
    >
      <div className="space-y-3.5 print:hidden">
        {data.partialFailures.length > 0 && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Some panels could not load: {data.partialFailures.join(', ')}. The rest of the dashboard is showing
              the posted ledger.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
            Posted ledger
          </span>
          <span>{periodLabel}</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>{branchLabel}</span>
          <span className="text-slate-300 dark:text-slate-700">·</span>
          <span>{asOfLabel}</span>
          {priorFy && (
            <>
              <span className="text-slate-300 dark:text-slate-700">·</span>
              <span>Prior comparison: {priorLabel}</span>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            variant="hero"
            label="Net profit"
            value={formatMoney(netProfit)}
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            tone={netProfit >= 0 ? 'emerald' : 'rose'}
            onClick={() => openKpiDrill('net-profit')}
            hint={
              <span className="block space-y-0.5">
                <span className="block">Net margin {formatPercent(netMargin)}</span>
                <PriorDelta current={netProfit} prior={priorNetProfit} label={priorLabel} />
              </span>
            }
          />
          <StatCard
            variant="hero"
            label="Revenue"
            value={formatMoney(revenue)}
            icon={<Scale className="h-3.5 w-3.5" />}
            tone="indigo"
            onClick={() => openKpiDrill('revenue')}
            hint={
              <span className="block space-y-0.5">
                <span className="block">Gross margin {formatPercent(grossMargin)}</span>
                <PriorDelta current={revenue} prior={priorRevenue} label={priorLabel} />
              </span>
            }
          />
          <StatCard
            variant="hero"
            label="Cash & bank"
            value={formatMoney(cash)}
            icon={<Wallet className="h-3.5 w-3.5" />}
            tone="sky"
            onClick={() => openKpiDrill('cash')}
            hint={
              <span className="block space-y-0.5">
                <span className="block">
                  Net cash flow {formatMoney(netCashFlow)}
                  {data.cashFlow ? (data.cashFlow.reconciled ? ' · tied' : ' · check') : ''}
                </span>
                <PriorDelta current={cash} prior={priorCash} label={priorLabel} />
              </span>
            }
          />
          <StatCard
            variant="hero"
            label="Working capital"
            value={formatMoney(workingCapital)}
            icon={<Landmark className="h-3.5 w-3.5" />}
            tone={workingCapital >= 0 ? 'violet' : 'rose'}
            onClick={() => openKpiDrill('working-capital')}
            hint={
              <span className="block space-y-0.5">
                <span className="block">
                  Current ratio {formatRatio(currentRatio)} · AR {formatMoney(receivables)} / AP {formatMoney(payables)}
                </span>
                <PriorDelta current={workingCapital} prior={priorWorkingCapital} label={priorLabel} />
              </span>
            }
          />
        </div>

        <QuickActions currentUser={currentUser} onNavigateTab={onNavigateTab} />

        {view === 'overview' ? (
          <>
        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-3">
          <section className={`${panelClass} p-4 xl:col-span-2`}>
            <PanelHeader
              title="Income allocation"
              caption={`${periodLabel} · posted revenue and expenses`}
              action={
                <div className="flex flex-wrap justify-end gap-1.5">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    Gross {formatPercent(grossMargin)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    Net {formatPercent(netMargin)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    Expense ratio {formatPercent(expenseRatio)}
                  </span>
                </div>
              }
            />

            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Total income
                </p>
                <p className="font-serif text-2xl font-bold text-slate-800 dark:text-slate-100">
                  {formatMoney(totalIncome)}
                </p>
              </div>
              <p className="text-[10px] text-slate-400">
                {n(data.pnl.otherIncome) > 0 ? `Includes ${formatMoney(n(data.pnl.otherIncome))} other income` : 'Revenue and other income'}
              </p>
            </div>

            {allocationRows.length === 0 ? (
              <RegisterEmpty message="No posted income or expenses in this period." />
            ) : (
              <div className="mt-4 space-y-3">
                {allocationRows.map((row) => {
                  const share = totalIncome !== 0 ? (row.value / totalIncome) * 100 : null;
                  const width = Math.min(100, (Math.abs(row.value) / incomeBase) * 100);
                  return (
                    <div key={row.key}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{row.label}</span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <span className={`text-[10px] font-semibold ${row.text}`}>{formatPercent(share)}</span>
                          <span className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-200">
                            {formatMoney(row.value)}
                          </span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className={`h-full rounded-full ${row.bar}`}
                          style={{ width: `${Math.max(0, width)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3 text-[10px] text-slate-500 dark:border-slate-800 dark:text-slate-400 sm:grid-cols-4">
              <span>
                Gross profit
                <strong className="mt-0.5 block font-mono text-xs text-slate-700 dark:text-slate-200">
                  {formatMoney(grossProfit)}
                </strong>
              </span>
              <span>
                Total expenses
                <strong className="mt-0.5 block font-mono text-xs text-slate-700 dark:text-slate-200">
                  {formatMoney(totalExpenses)}
                </strong>
              </span>
              <span>
                Other income
                <strong className="mt-0.5 block font-mono text-xs text-slate-700 dark:text-slate-200">
                  {formatMoney(n(data.pnl.otherIncome))}
                </strong>
              </span>
              <span>
                Net result
                <strong className={`mt-0.5 block font-mono text-xs ${netProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {formatMoney(netProfit)}
                </strong>
              </span>
            </div>
          </section>

          <section className={`${panelClass} p-4`}>
            <PanelHeader
              title="Cash & bank"
              caption="Closing balances from posted cash-book lines"
              action={
                <button
                  type="button"
                  onClick={() => goTo('accounting-cash-book')}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Open book
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              }
            />
            <div className="mt-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Total cash & bank
              </p>
              <p className="font-serif text-2xl font-bold text-sky-700 dark:text-sky-300">{formatMoney(cash)}</p>
            </div>

            {cashAccounts.length === 0 ? (
              <p className="mt-4 rounded-lg border border-dashed border-slate-200 p-3 text-xs text-slate-400 dark:border-slate-700">
                Account-level cash detail is unavailable for this scope.
              </p>
            ) : (
              <div className="mt-4 space-y-3">
                {cashAccounts.map((account) => {
                  const amount = n(account.closing);
                  return (
                    <div key={account.accountId}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 text-xs font-medium text-slate-600 dark:text-slate-300">
                          <span className="font-mono text-[10px] text-slate-400">{account.code}</span>{' '}
                          <span className="break-words">{account.name}</span>
                        </span>
                        <span
                          className={`shrink-0 font-mono text-xs font-semibold ${
                            amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {formatMoney(amount)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className={`h-full rounded-full ${amount < 0 ? 'bg-rose-500' : 'bg-sky-500'}`}
                          style={{ width: `${Math.max(0, Math.min(100, (Math.abs(amount) / cashAccountMax) * 100))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {data.cashBook && (
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-[10px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <span>
                  Opening
                  <strong className="mt-0.5 block font-mono text-xs text-slate-700 dark:text-slate-200">
                    {formatMoney(n(data.cashBook.opening))}
                  </strong>
                </span>
                <span>
                  Receipts
                  <strong className="mt-0.5 block font-mono text-xs text-emerald-600 dark:text-emerald-400">
                    {formatMoney(n(data.cashBook.receipts))}
                  </strong>
                </span>
                <span>
                  Payments
                  <strong className="mt-0.5 block font-mono text-xs text-rose-600 dark:text-rose-400">
                    {formatMoney(n(data.cashBook.payments))}
                  </strong>
                </span>
              </div>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-3">
          <section className={`${panelClass} p-4 xl:col-span-2`}>
            <PanelHeader
              title="Cash movement"
              caption="Cash-book receipts and payments by month"
              action={
                <div className="flex items-center gap-3 text-[10px] font-semibold">
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Receipts
                  </span>
                  <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                    Payments
                  </span>
                </div>
              }
            />

            <div className="mt-3 grid grid-cols-3 gap-2">
              <span className="rounded-lg bg-emerald-50 px-2.5 py-2 dark:bg-emerald-950/20">
                <span className="block text-[9px] font-bold uppercase tracking-wider text-emerald-700/70 dark:text-emerald-400/70">
                  Receipts
                </span>
                <strong className="block font-mono text-xs text-emerald-700 dark:text-emerald-400">
                  {formatMoney(chartReceipts)}
                </strong>
              </span>
              <span className="rounded-lg bg-rose-50 px-2.5 py-2 dark:bg-rose-950/20">
                <span className="block text-[9px] font-bold uppercase tracking-wider text-rose-700/70 dark:text-rose-400/70">
                  Payments
                </span>
                <strong className="block font-mono text-xs text-rose-700 dark:text-rose-400">
                  {formatMoney(chartPayments)}
                </strong>
              </span>
              <span className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800/50">
                <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500/80 dark:text-slate-400/80">
                  Net movement
                </span>
                <strong className="block font-mono text-xs text-slate-700 dark:text-slate-200">
                  {formatMoney(chartReceipts - chartPayments)}
                </strong>
              </span>
            </div>

            {cashMonths.length === 0 ? (
              <div className="mt-4">
                <RegisterEmpty message="No cash movement has been posted for this period." />
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <div className="flex min-w-[480px] items-end gap-2 border-b border-slate-100 pb-1 dark:border-slate-800">
                  {cashMonths.map((month) => {
                    const receiptHeight =
                      month.receipts > 0 ? Math.max(2, (month.receipts / chartMax) * 100) : 0;
                    const paymentHeight =
                      month.payments > 0 ? Math.max(2, (month.payments / chartMax) * 100) : 0;
                    return (
                      <div key={month.key} className="group flex min-w-0 flex-1 flex-col items-center">
                        <div className="flex h-40 w-full items-end justify-center gap-1">
                          <div
                            className="w-1/3 rounded-t-sm bg-emerald-500/85 transition-colors group-hover:bg-emerald-500"
                            style={{ height: `${receiptHeight}%` }}
                            title={`${month.title} receipts: ${formatMoney(month.receipts)}`}
                          />
                          <div
                            className="w-1/3 rounded-t-sm bg-rose-500/85 transition-colors group-hover:bg-rose-500"
                            style={{ height: `${paymentHeight}%` }}
                            title={`${month.title} payments: ${formatMoney(month.payments)}`}
                          />
                        </div>
                        <span className="mt-1 text-[9px] font-semibold text-slate-400 dark:text-slate-500">
                          {month.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <p className="mt-3 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
              Gross cash-book turnover. Transfers between cash and bank appear on both sides, so the net movement is
              the useful liquidity figure.
            </p>
          </section>

          <section className={`${panelClass} p-4`}>
            <PanelHeader
              title="Ledger controls"
              caption="Server-computed tie-outs"
              action={
                <span
                  className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${
                    allControlsTie
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                      : checkedControls.length > 0 && passedControls === checkedControls.length
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
                  }`}
                >
                  {allControlsTie
                    ? 'All tie'
                    : checkedControls.length > 0
                      ? `${passedControls}/${checkedControls.length} tie`
                      : 'Not loaded'}
                </span>
              }
            />

            <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[10px] text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              {allControlsTie
                ? 'Every available ledger control reconciles.'
                : checkedControls.length > 0
                  ? 'Review the controls that do not tie before closing the period.'
                  : 'The optional control reads could not be loaded.'}
            </div>

            <div className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {controls.map((control) => {
                const Icon =
                  control.ok === true ? CheckCircle2 : control.ok === false ? AlertTriangle : Clock;
                const tone =
                  control.ok === true
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : control.ok === false
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-400 dark:text-slate-500';
                return (
                  <button
                    key={control.key}
                    type="button"
                    onClick={() => openControlDrill(control.key)}
                    className="flex w-full items-start gap-2 py-2.5 text-left transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/30"
                  >
                    <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
                        {control.label}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                        {control.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-3">
          <section className={`${panelClass} p-4 xl:col-span-2`}>
            <PanelHeader
              title="Receivables & payables aging"
              caption="Open items by days past due, with control-account reconciliation"
              action={
                <button
                  type="button"
                  onClick={() => goTo('accounting-aging')}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Open aging
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              }
            />
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <AgingSide title="Receivables" data={data.ar} onOpen={() => goTo('accounting-aging')} />
              <AgingSide title="Payables" data={data.ap} onOpen={() => goTo('accounting-aging')} />
            </div>
          </section>

          <section className={`${panelClass} p-4`}>
            <PanelHeader
              title="Recent cash activity"
              caption="Latest posted cash-book lines"
              action={
                <button
                  type="button"
                  onClick={() => goTo('accounting-cash-book')}
                  className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  View all
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              }
            />
            {recentCashEntries.length === 0 ? (
              <p className="mt-4 text-xs text-slate-400">No cash activity has been posted in this period.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                {recentCashEntries.map((entry) => (
                  <div key={`${entry.journalId}-${entry.accountCode}-${entry.journalNo}`} className="py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                        <span className="font-mono text-slate-400">{entry.accountCode}</span>{' '}
                        <span className="break-words">{entry.accountName}</span>
                      </span>
                      <span
                        className={`shrink-0 font-mono text-xs font-semibold ${
                          entry.type === 'RECEIPT'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {entry.type === 'RECEIPT' ? '+' : '−'}
                        {formatMoney(n(entry.type === 'RECEIPT' ? entry.debit : entry.credit))}
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2 text-[9px] text-slate-400 dark:text-slate-500">
                      <span className="truncate">{entry.memo || entry.sourceType || entry.journalNo}</span>
                      <span className="shrink-0">{formatDualDate(entry.journalDateAD, dateMode)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
          </>
        ) : (
          <FinanceBranchComparison
            rows={branchRows}
            company={companyRow}
            selectedBranchId={scope.branchId}
            loading={branchLoading}
            error={branchError || branchFailureText}
            onRetry={() => setBranchReloadKey((key) => key + 1)}
            onOpenPnlLines={openBranchPnlLines}
            onOpenBalanceLines={openBranchBalanceLines}
            periodLabel={periodLabel}
            asOfLabel={asOfLabel}
          />
        )}
      </div>

      <div className="hidden print:block space-y-3 text-[10px] text-slate-800">
        <div className="border-b border-slate-300 pb-2">
          <p className="text-sm font-bold">
            Finance Dashboard — {view === 'comparison' ? 'Branch Comparison' : 'Overview'}
          </p>
          <p className="mt-0.5">
            {periodLabel} · {branchLabel} · as of {asOfLabel}
          </p>
          <p className="mt-0.5">Posted ledger only. Amounts in NPR.</p>
        </div>

        {view === 'comparison' ? (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-slate-100">
                <th className="border border-slate-300 px-2 py-1">Branch</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Revenue</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Net profit</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Net margin</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Cash &amp; bank</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Working capital</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Current ratio</th>
              </tr>
            </thead>
            <tbody>
              {([companyRow, ...branchRows].filter(Boolean) as FinanceBranchRow[]).map((row) => {
                const metrics = metricsForBranch(row.pnl, row.balance);
                return (
                  <tr key={row.branchId}>
                    <td className="border border-slate-300 px-2 py-1">
                      {row.code} · {row.name}
                      {row.error ? ` (${row.error})` : ''}
                    </td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(metrics.revenue)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(metrics.netProfit)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatPercent(metrics.netMargin)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(metrics.cash)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(metrics.workingCapital)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatRatio(metrics.currentRatio)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-100">
                  <th className="border border-slate-300 px-2 py-1">Key figure</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Current</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Prior</th>
                  <th className="border border-slate-300 px-2 py-1">Detail</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Net profit', netProfit, priorNetProfit, `Net margin ${formatPercent(netMargin)}`],
                  ['Revenue', revenue, priorRevenue, `Gross margin ${formatPercent(grossMargin)}`],
                  ['Cash & bank', cash, priorCash, `Net cash flow ${formatMoney(netCashFlow)}`],
                  ['Working capital', workingCapital, priorWorkingCapital, `Current ratio ${formatRatio(currentRatio)}`],
                ].map(([label, current, prior, detail]) => (
                  <tr key={String(label)}>
                    <td className="border border-slate-300 px-2 py-1">{label}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(current as number)}</td>
                    <td className="border border-slate-300 px-2 py-1 text-right">
                      {prior === null ? '—' : formatMoney(prior as number)}
                    </td>
                    <td className="border border-slate-300 px-2 py-1">{detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid grid-cols-2 gap-4">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border border-slate-300 px-2 py-1">Income allocation</th>
                    <th className="border border-slate-300 px-2 py-1 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationRows.map((row) => (
                    <tr key={row.key}>
                      <td className="border border-slate-300 px-2 py-1">{row.label}</td>
                      <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border border-slate-300 px-2 py-1">Cash &amp; bank</th>
                    <th className="border border-slate-300 px-2 py-1 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {cashAccounts.map((account) => (
                    <tr key={account.accountId}>
                      <td className="border border-slate-300 px-2 py-1">
                        {account.code} · {account.name}
                      </td>
                      <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(n(account.closing))}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="border border-slate-300 px-2 py-1 font-bold">Total cash &amp; bank</td>
                    <td className="border border-slate-300 px-2 py-1 text-right font-bold">{formatMoney(cash)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-100">
                  <th className="border border-slate-300 px-2 py-1">Control</th>
                  <th className="border border-slate-300 px-2 py-1">Status</th>
                  <th className="border border-slate-300 px-2 py-1">Detail</th>
                </tr>
              </thead>
              <tbody>
                {controls.map((control) => (
                  <tr key={control.key}>
                    <td className="border border-slate-300 px-2 py-1">{control.label}</td>
                    <td className="border border-slate-300 px-2 py-1">
                      {control.ok === true ? 'Tied' : control.ok === false ? 'Difference' : 'Not loaded'}
                    </td>
                    <td className="border border-slate-300 px-2 py-1">{control.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-100">
                  <th className="border border-slate-300 px-2 py-1">Aging</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Net open</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Gross open</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">Unapplied credits</th>
                  <th className="border border-slate-300 px-2 py-1 text-right">90+ days</th>
                </tr>
              </thead>
              <tbody>
                {([
                  ['Receivables', data.ar],
                  ['Payables', data.ap],
                ] as const).map(([label, aging]) =>
                  aging ? (
                    <tr key={label}>
                      <td className="border border-slate-300 px-2 py-1">{label}</td>
                      <td className="border border-slate-300 px-2 py-1 text-right">{formatMoney(n(aging.totals.total))}</td>
                      <td className="border border-slate-300 px-2 py-1 text-right">
                        {formatMoney(n(aging.totals.grossTotal))}
                      </td>
                      <td className="border border-slate-300 px-2 py-1 text-right">
                        {formatMoney(n(aging.totals.unappliedCredit))}
                      </td>
                      <td className="border border-slate-300 px-2 py-1 text-right">
                        {formatMoney(n(aging.totals.DAYS_90_PLUS))}
                      </td>
                    </tr>
                  ) : null
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </AccountingRegisterShell>
    {drill && <LedgerDrilldownDialog request={drill} onClose={() => setDrill(null)} />}
    </>
  );
};

export default FinanceDashboard;
