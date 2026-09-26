import React, { useEffect, useMemo, useState } from 'react';
import { FinancialSummary, Asset, PurchaseInvoice, CompanyProfile, Branch, FiscalYear } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { calculateFixedAssetValues } from '../../utils/depreciation';
import { formatNPR } from '../../utils/nprFormat';
import { getFinancialSummary } from '../../services/api/finance';
import {
  Scale,
  TrendingUp,
  Printer,
  Download,
  Building2,
  RefreshCw,
  Info,
  GitCompareArrows,
  GitCompare,
  Table2,
  ChevronDown,
} from 'lucide-react';

interface FinancialStatementsProps {
  financialSummary: FinancialSummary;
  assets: Asset[];
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  /** As-of date used for live NBV; matches the Fixed Asset Register / Depreciation Register view. */
  asOfDateAD?: string;
  /** Company master record — used for the official statement letterhead / header. */
  companyProfile?: CompanyProfile | null;
  /** All company branches — drives the statement filter + comparison report rows. */
  branches: Branch[];
  /** All fiscal years — enables the comparative (prior-FY) period columns. */
  fiscalYears: FiscalYear[];
  /** The fiscal year currently selected in the global header. */
  currentFiscalYear?: FiscalYear | null;
  /** Optional: the fiscal-year id currently selected globally (used for per-branch fetches). */
  fiscalYearId?: string;
}

// PostgreSQL NUMERIC columns arrive as strings over the API. Coerce every
// value to a real number before arithmetic so we never fall into JS string
// concatenation (e.g. 0 + "3000.00" -> "03000.00").
const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** One entity-period's figures. */
interface BranchFigures {
  branchId: string;
  inventoryAssetVal: number;
  grossFixedAssets: number;
  accumulatedDepreciation: number;
  fixedAssetNBV: number;
  totalAssets: number;
  accountsPayable: number;
  totalLiabilities: number;
  netEquity: number;
  salesRevenue: number;
  cogs: number;
  grossSurplus: number;
}

/**
 * Compute figures for one entity (branch) at one period.
 *  - asOfDateAD given → live depreciation schedule evaluated at that date
 *    (current FY: global as-of; prior FY: the prior year's END date, i.e. the
 *    closing NBV of that year).
 */
function computeFigures(
  branchId: string,
  summary: FinancialSummary,
  branchAssets: Asset[],
  asOfDateAD?: string
): BranchFigures {
  const inventoryAssetVal = toNumber(summary?.totalInventoryAssetValue);
  const grossFixedAssets = branchAssets.reduce((sum, a) => sum + toNumber(a.acquisitionCost), 0);
  const accumulatedDepreciation = branchAssets.reduce(
    (sum, a) =>
      sum +
      toNumber(
        calculateFixedAssetValues({
          ...a,
          acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD,
          asOfDateAD,
        }).accumulatedDepreciation
      ),
    0
  );
  const fixedAssetNBV = grossFixedAssets - accumulatedDepreciation;
  const totalAssets = inventoryAssetVal + fixedAssetNBV;
  const accountsPayable = Math.max(0, toNumber(summary?.totalAccountsPayable));
  const netEquity = totalAssets - accountsPayable;
  const salesRevenue = toNumber(summary?.totalSalesRevenue);
  const cogs = toNumber(summary?.totalCostOfGoodsSold);
  return {
    branchId,
    inventoryAssetVal,
    grossFixedAssets,
    accumulatedDepreciation,
    fixedAssetNBV,
    totalAssets,
    accountsPayable,
    totalLiabilities: accountsPayable,
    netEquity,
    salesRevenue,
    cogs,
    grossSurplus: salesRevenue - cogs,
  };
}

const ZERO_FIGURES = (branchId: string): BranchFigures => ({
  branchId,
  inventoryAssetVal: 0,
  grossFixedAssets: 0,
  accumulatedDepreciation: 0,
  fixedAssetNBV: 0,
  totalAssets: 0,
  accountsPayable: 0,
  totalLiabilities: 0,
  netEquity: 0,
  salesRevenue: 0,
  cogs: 0,
  grossSurplus: 0,
});

const sumFigures = (cols: BranchFigures[]): BranchFigures => {
  const acc = ZERO_FIGURES('CONSOLIDATED');
  for (const f of cols) {
    acc.inventoryAssetVal += f.inventoryAssetVal;
    acc.grossFixedAssets += f.grossFixedAssets;
    acc.accumulatedDepreciation += f.accumulatedDepreciation;
    acc.fixedAssetNBV += f.fixedAssetNBV;
    acc.totalAssets += f.totalAssets;
    acc.accountsPayable += f.accountsPayable;
    acc.totalLiabilities += f.totalLiabilities;
    acc.netEquity += f.netEquity;
    acc.salesRevenue += f.salesRevenue;
    acc.cogs += f.cogs;
    acc.grossSurplus += f.grossSurplus;
  }
  return acc;
};

export const FinancialStatements: React.FC<FinancialStatementsProps> = ({
  financialSummary,
  assets,
  dateMode,
  asOfDateAD,
  companyProfile,
  branches,
  fiscalYears,
  currentFiscalYear,
  fiscalYearId,
}) => {
  const [statementType, setStatementType] = useState<'BALANCE_SHEET' | 'PROFIT_LOSS'>('BALANCE_SHEET');
  // Two views, ERP-style: a single-entity statement + a branch comparison report.
  const [view, setView] = useState<'STATEMENT' | 'COMPARISON'>('STATEMENT');
  // Statement view entity filter: 'ALL' (consolidated) or a branch id.
  const [statementEntity, setStatementEntity] = useState<string>('ALL');
  // Comparative mode: show prior-FY period column + variance.
  const [comparativeMode, setComparativeMode] = useState(false);
  // Per-branch server summaries keyed by `${branchId}|${fyId}`.
  const [summaryMap, setSummaryMap] = useState<Record<string, FinancialSummary>>({});
  const [summariesLoading, setSummariesLoading] = useState(false);
  const [summariesError, setSummariesError] = useState<string | null>(null);

  const activeBranches = useMemo(
    () => (branches || []).filter((b) => b.active),
    [branches]
  );

  // Current + prior fiscal year for the comparison pairs.
  const currentFy = useMemo<FiscalYear | null>(() => {
    if (currentFiscalYear) return currentFiscalYear;
    const byId = (fiscalYears || []).find((f) => f.id === fiscalYearId);
    if (byId) return byId;
    return (fiscalYears || []).find((f) => f.isCurrent) || (fiscalYears || [])[0] || null;
  }, [currentFiscalYear, fiscalYears, fiscalYearId]);

  const priorFy = useMemo<FiscalYear | null>(() => {
    if (!currentFy || !fiscalYears || fiscalYears.length < 2) return null;
    const idx = fiscalYears.findIndex((f) => f.id === currentFy.id);
    if (idx < 0) return null;
    // Fiscal years arrive newest-first (bootstrap order); prior = next entry.
    for (let i = idx + 1; i < fiscalYears.length; i++) {
      if (fiscalYears[i].id !== currentFy.id) return fiscalYears[i];
    }
    return null;
  }, [currentFy, fiscalYears]);

  // Fetch a financial summary per branch × needed fiscal year.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!activeBranches.length) return;
      setSummariesLoading(true);
      setSummariesError(null);
      try {
        const fyIds = [currentFy?.id, priorFy?.id].filter((x): x is string => Boolean(x));
        const pairs: { branchId: string; fyId?: string }[] = [];
        for (const b of activeBranches) {
          for (const fyId of fyIds.length ? fyIds : [undefined]) {
            pairs.push({ branchId: b.id, fyId });
          }
        }
        const results = await Promise.all(
          pairs.map(async ({ branchId, fyId }) => {
            const s = await getFinancialSummary(branchId, fyId);
            return [`${branchId}|${fyId || ''}`, s] as const;
          })
        );
        if (cancelled) return;
        const map: Record<string, FinancialSummary> = {};
        for (const [k, s] of results) map[k] = s;
        setSummaryMap(map);
      } catch {
        if (!cancelled) setSummariesError('Failed to load per-branch financials — figures may show zeros for payables/sales.');
      } finally {
        if (!cancelled) setSummariesLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activeBranches, currentFy, priorFy]);

  // ----- Figures per branch × fiscal year ------------------------------------
  const figuresFor = (branchId: string, fy: FiscalYear | null): BranchFigures => {
    const branchAssets = (assets || []).filter((a) => a.branchId === branchId);
    // Current FY: evaluated at the global as-of date (matches the Fixed Asset
    // Register). Prior FY: evaluated at the prior year's END date — "what the
    // NBV was when that year closed".
    const isPrior = Boolean(fy && priorFy && fy.id === priorFy.id);
    const summary = summaryMap[`${branchId}|${fy?.id || ''}`] || financialSummary;
    return computeFigures(
      branchId,
      summary,
      branchAssets,
      isPrior ? priorFy?.endDateAD : asOfDateAD
    );
  };

  /** Figures for an entity ('ALL' or branch id) at a fiscal year. */
  const entityFigures = (entityId: string, fy: FiscalYear | null): BranchFigures => {
    if (entityId !== 'ALL') return figuresFor(entityId, fy);
    return sumFigures(activeBranches.map((b) => figuresFor(b.id, fy)));
  };

  const asOfLabel = asOfDateAD
    ? formatDualDate(asOfDateAD, dateMode)
    : formatDualDate(new Date().toISOString().split('T')[0], dateMode);

  const handlePrint = () => window.print();

  // ----- Matrix row definitions ----------------------------------------------
  type MatrixRow = {
    key: string;
    section?: string;
    subSection?: string;
    label: string;
    depth: 0 | 1 | 2;
    get: (f: BranchFigures) => number;
    style?: 'total' | 'negative' | 'strong';
  };

  const BALANCE_SHEET_ROWS: MatrixRow[] = [
    { key: 'el-section', section: 'EQUITY AND LIABILITIES', label: '', depth: 0, get: () => 0 },
    { key: 'el-sub1', subSection: "1. Shareholders' Funds", label: '', depth: 0, get: () => 0 },
    { key: 'equity', label: "Capital & Retained Surplus (Balancing Figure)", depth: 1, get: (f) => f.netEquity },
    { key: 'el-sub2', subSection: '2. Current Liabilities', label: '', depth: 0, get: () => 0 },
    { key: 'payables', label: 'Trade Payables — Accounts Payable (Opening + Invoices − Payments)', depth: 1, get: (f) => f.accountsPayable },
    { key: 'el-total', label: 'TOTAL EQUITY & LIABILITIES', depth: 0, get: (f) => f.totalLiabilities + f.netEquity, style: 'total' },
    { key: 'assets-section', section: 'ASSETS', label: '', depth: 0, get: () => 0 },
    { key: 'assets-sub1', subSection: '1. Non-Current Assets — Fixed Assets', label: '', depth: 0, get: () => 0 },
    { key: 'fa-gross', label: 'Fixed Assets at Gross Cost', depth: 1, get: (f) => f.grossFixedAssets },
    { key: 'fa-dep', label: 'Less: Accumulated Depreciation', depth: 2, get: (f) => -f.accumulatedDepreciation, style: 'negative' },
    { key: 'fa-nbv', label: 'Net Block — Fixed Assets (NBV)', depth: 1, get: (f) => f.fixedAssetNBV, style: 'strong' },
    { key: 'assets-sub2', subSection: '2. Current Assets — Inventories', label: '', depth: 0, get: () => 0 },
    { key: 'inventory', label: 'Merchandise Inventory (At Valuation)', depth: 1, get: (f) => f.inventoryAssetVal },
    { key: 'assets-total', label: 'TOTAL ASSETS', depth: 0, get: (f) => f.totalAssets, style: 'total' },
  ];

  const PL_ROWS: MatrixRow[] = [
    { key: 'pl-section', section: 'TRADING ACCOUNT', label: '', depth: 0, get: () => 0 },
    { key: 'revenue', label: 'Posted Sales Revenue (customer product sales)', depth: 1, get: (f) => f.salesRevenue },
    { key: 'cogs', label: 'Less: Cost of Goods Sold (qty × cost price)', depth: 1, get: (f) => -f.cogs, style: 'negative' },
    { key: 'gross', label: 'GROSS SURPLUS (SALES − COGS)', depth: 0, get: (f) => f.grossSurplus, style: 'total' },
    { key: 'opex', label: 'Less: Posted Operating Expenses', depth: 1, get: () => 0, style: 'negative' },
    { key: 'net', label: 'NET OPERATING PROFIT / SURPLUS', depth: 0, get: (f) => f.grossSurplus, style: 'total' },
  ];

  const rows = statementType === 'BALANCE_SHEET' ? BALANCE_SHEET_ROWS : PL_ROWS;

  // ----- Statement view columns (periods, ERP-style) --------------------------
  const periodCols = useMemo(() => {
    const cols: { fy: FiscalYear | null; isVariance?: boolean; figures: BranchFigures }[] = [
      { fy: null, figures: entityFigures(statementEntity, currentFy) },
    ];
    if (comparativeMode && priorFy) {
      cols.push({ fy: priorFy, figures: entityFigures(statementEntity, priorFy) });
      cols.push({ fy: null, isVariance: true, figures: cols[0].figures });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statementEntity, currentFy, priorFy, comparativeMode, summaryMap, assets, activeBranches, asOfDateAD]);

  const varianceFor = (i: number, get: (f: BranchFigures) => number): number => {
    const cur = periodCols[i - 2];
    const prior = periodCols[i - 1];
    if (!cur || !prior) return 0;
    return get(cur.figures) - get(prior.figures);
  };

  // ----- Branch comparison report rows (rows = branches — scales downward) ----
  const comparisonRows = useMemo(() => {
    const rowsOut = activeBranches.map((b) => ({
      branch: b,
      current: figuresFor(b.id, currentFy),
      prior: priorFy ? figuresFor(b.id, priorFy) : null,
    }));
    return rowsOut;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranches, currentFy, priorFy, summaryMap, assets, asOfDateAD]);

  const comparisonConsolidated = useMemo(
    () => sumFigures(comparisonRows.map((r) => r.current)),
    [comparisonRows]
  );
  const comparisonConsolidatedPrior = useMemo(
    () => (priorFy ? sumFigures(comparisonRows.map((r) => r.prior || ZERO_FIGURES(r.branch.id))) : null),
    [comparisonRows, priorFy]
  );

  const COMPARISON_KPIS: { key: string; label: string; get: (f: BranchFigures) => number; color: string }[] = [
    { key: 'assets', label: 'Total Assets', get: (f) => f.totalAssets, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'nbv', label: 'Fixed Assets (NBV)', get: (f) => f.fixedAssetNBV, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'inventory', label: 'Inventory', get: (f) => f.inventoryAssetVal, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'payables', label: 'Accounts Payable', get: (f) => f.accountsPayable, color: 'text-amber-600 dark:text-amber-400' },
    { key: 'equity', label: 'Net Equity', get: (f) => f.netEquity, color: 'text-indigo-600 dark:text-indigo-400' },
    { key: 'revenue', label: 'Sales Revenue', get: (f) => f.salesRevenue, color: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'cogs', label: 'Cost of Goods Sold', get: (f) => f.cogs, color: 'text-rose-600 dark:text-rose-400' },
    { key: 'surplus', label: 'Gross Surplus', get: (f) => f.grossSurplus, color: 'text-indigo-600 dark:text-indigo-400' },
  ];

  const entityName =
    statementEntity === 'ALL'
      ? 'All Branches (Consolidated)'
      : (() => {
          const b = activeBranches.find((x) => x.id === statementEntity);
          return b ? b.name + (b.isHeadquarters ? ' (HQ)' : '') : '';
        })();

  const handleExport = () => {
    if (view === 'STATEMENT') {
      const colNames = periodCols.map((c) => {
        if (c.isVariance) return `Variance (${priorFy?.code || ''} → ${currentFy?.code || ''})`;
        if (c.fy) return c.fy.code;
        return currentFy?.code || 'Current';
      });
      const data = rows
        .filter((r) => r.label)
        .map((r) => {
          const row: Record<string, string | number> = { 'Line Item': r.label };
          periodCols.forEach((c, i) => {
            row[colNames[i]] = c.isVariance ? varianceFor(i, r.get) : r.get(c.figures);
          });
          return row;
        });
      exportToCSV(
        `${statementType === 'BALANCE_SHEET' ? 'Balance_Sheet' : 'Profit_And_Loss'}_${entityName.replace(/[^A-Za-z0-9]+/g, '_')}`,
        data,
        [{ key: 'Line Item', label: 'Line Item' }, ...colNames.map((n) => ({ key: n, label: `${n} (NPR)` }))],
        companyProfile
      );
    } else {
      const data: Record<string, string | number>[] = [];
      for (const r of comparisonRows) {
        const row: Record<string, string | number> = { Branch: r.branch.name + (r.branch.isHeadquarters ? ' (HQ)' : '') };
        for (const kpi of COMPARISON_KPIS) {
          row[kpi.label] = kpi.get(r.current);
          if (priorFy && r.prior) row[`${kpi.label} (${priorFy.code})`] = kpi.get(r.prior);
        }
        data.push(row);
      }
      const consRow: Record<string, string | number> = { Branch: 'CONSOLIDATED' };
      for (const kpi of COMPARISON_KPIS) {
        consRow[kpi.label] = kpi.get(comparisonConsolidated);
        if (priorFy && comparisonConsolidatedPrior) consRow[`${kpi.label} (${priorFy.code})`] = kpi.get(comparisonConsolidatedPrior);
      }
      data.push(consRow);
      exportToCSV(
        'Branch_Comparison_Report',
        data,
        [
          { key: 'Branch', label: 'Branch' },
          ...COMPARISON_KPIS.flatMap((k) => [
            { key: k.label, label: `${k.label} (NPR)` },
            ...(priorFy ? [{ key: `${k.label} (${priorFy.code})`, label: `${k.label} ${priorFy.code} (NPR)` }] : []),
          ]),
        ],
        companyProfile
      );
    }
  };

  const priorFyLabel = priorFy ? priorFy.code : '';
  const curFyLabel = currentFy ? currentFy.code : '';

  const selectCls =
    'px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/40';

  return (
    <div className="printable-document space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2">
            <Scale className="h-5 w-5 text-indigo-500" />
            <span>Financial Statements (Balance Sheet &amp; Profit/Loss)</span>
          </h2>
          <p className="truncate text-slate-400 text-xs mt-0.5">
            One statement per entity — pick a branch or the consolidated group. Compare branches in the comparison report.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handleExport}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={handlePrint}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Statement</span>
          </button>
        </div>
      </div>

      {/* Controls row: view switch + statement type + comparative + entity filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        {/* View switch */}
        <div className="flex items-center rounded-xl border border-slate-300 dark:border-slate-700 overflow-hidden">
          <button
            onClick={() => setView('STATEMENT')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-all cursor-pointer ${
              view === 'STATEMENT'
                ? 'bg-indigo-600 text-white'
                : 'bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-800 dark:hover:text-white'
            }`}
          >
            <Scale className="h-3.5 w-3.5" />
            <span>Statement</span>
          </button>
          <button
            onClick={() => setView('COMPARISON')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold transition-all cursor-pointer ${
              view === 'COMPARISON'
                ? 'bg-indigo-600 text-white'
                : 'bg-white dark:bg-slate-900 text-slate-500 hover:text-slate-800 dark:hover:text-white'
            }`}
          >
            <Table2 className="h-3.5 w-3.5" />
            <span>Branch Comparison</span>
          </button>
        </div>

        {view === 'STATEMENT' && (
          <>
            {/* Statement type */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setStatementType('BALANCE_SHEET')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  statementType === 'BALANCE_SHEET'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Scale className="h-4 w-4" />
                <span>Balance Sheet</span>
              </button>
              <button
                onClick={() => setStatementType('PROFIT_LOSS')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  statementType === 'PROFIT_LOSS'
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
                    : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <TrendingUp className="h-4 w-4" />
                <span>Profit &amp; Loss</span>
              </button>
            </div>

            {/* Entity filter: which entity the statement is FOR */}
            <label className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Statement of</span>
              <span className="relative">
                <select
                  value={statementEntity}
                  onChange={(e) => setStatementEntity(e.target.value)}
                  className={selectCls + ' pr-8 appearance-none'}
                >
                  <option value="ALL">🏢 All Branches (Consolidated)</option>
                  {activeBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.isHeadquarters ? '⭐' : '📍'} {b.name} {b.isHeadquarters ? '(HQ)' : ''} {b.code ? `(${b.code})` : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-3.5 w-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </span>
            </label>
          </>
        )}

        {/* Comparative toggle (both views) */}
        {priorFy && (
          <button
            onClick={() => setComparativeMode((v) => !v)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
              comparativeMode
                ? 'bg-amber-500 border-amber-500 text-white shadow-md shadow-amber-500/20'
                : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:border-amber-400 hover:text-amber-500'
            } ${view === 'COMPARISON' ? '' : view === 'STATEMENT' ? '' : 'ml-auto'}`}
            title={
              comparativeMode
                ? 'Hide prior-year comparative and variance columns'
                : `Show ${priorFyLabel} comparative + variance`
            }
          >
            {comparativeMode ? <GitCompare className="h-4 w-4" /> : <GitCompareArrows className="h-4 w-4" />}
            <span>{comparativeMode ? `${priorFyLabel} vs ${curFyLabel} ON` : `Compare with ${priorFyLabel}`}</span>
          </button>
        )}
      </div>

      {summariesLoading && (
        <div className="flex items-center gap-2 text-xs text-slate-400 px-1">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Loading per-branch financials{priorFy ? ` for ${priorFyLabel} & ${curFyLabel}` : ''}…
        </div>
      )}
      {summariesError && (
        <div className="p-3 rounded-xl border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900/60 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0" />
          {summariesError}
        </div>
      )}

      {view === 'STATEMENT' ? (
        <>
          {/* Statement title */}
          <div className="text-center border-b-2 border-slate-300 dark:border-slate-700 pb-4">
            <h2 className="text-xl font-serif font-extrabold text-slate-900 dark:text-white tracking-tight hidden print:block">
              {companyProfile?.legalName || companyProfile?.name || 'Inventory Management System'}
            </h2>
            <h3 className="text-lg font-serif font-bold text-slate-800 dark:text-slate-200 mt-2 tracking-wide">
              {statementType === 'BALANCE_SHEET' ? 'BALANCE SHEET' : 'PROFIT & LOSS STATEMENT'}
              <span className="block text-sm font-sans font-semibold text-indigo-600 dark:text-indigo-400 mt-1">
                {entityName}
              </span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {statementType === 'BALANCE_SHEET' ? 'As at ' : 'Trading period ending '}
              {asOfLabel}
              {comparativeMode && priorFy && (
                <span className="text-slate-400"> · Comparative: {priorFyLabel} vs {curFyLabel}</span>
              )}
            </p>
          </div>

          {/* Statement table: line items × period columns (fixed width, never grows with branches) */}
          <div className="rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800 overflow-x-auto">
            <table className="w-full text-xs border-collapse max-w-4xl mx-auto">
              <thead>
                <tr className="border-b-2 border-slate-300 dark:border-slate-700">
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-slate-400 text-[10px] w-[46%] min-w-[240px]">
                    Particulars
                  </th>
                  {periodCols.map((c, i) => {
                    const isVar = !!c.isVariance;
                    return (
                      <th
                        key={i}
                        className={`px-4 py-3 text-right font-bold whitespace-nowrap ${
                          isVar
                            ? 'text-slate-400 bg-slate-50/80 dark:bg-slate-800/40'
                            : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        <span className="text-[11px] uppercase tracking-wide">
                          {isVar ? 'Variance' : c.fy ? c.fy.code : curFyLabel || 'Current'}
                        </span>
                        {isVar && (
                          <span className="block text-[9px] font-normal mt-0.5">
                            {priorFyLabel} → {curFyLabel}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  if (r.section) {
                    return (
                      <tr key={r.key} className="border-b-2 border-slate-200 dark:border-slate-800">
                        <td
                          colSpan={periodCols.length + 1}
                          className={`px-4 py-2 font-bold text-sm tracking-wide ${
                            r.section === 'ASSETS'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-indigo-600 dark:text-indigo-400'
                          }`}
                        >
                          {r.section}
                        </td>
                      </tr>
                    );
                  }
                  if (r.subSection) {
                    return (
                      <tr key={r.key}>
                        <td
                          colSpan={periodCols.length + 1}
                          className="px-4 pt-3 pb-1 font-bold uppercase tracking-wider text-slate-400 text-[10px]"
                        >
                          {r.subSection}
                        </td>
                      </tr>
                    );
                  }
                  const isTotal = r.style === 'total';
                  const isNegative = r.style === 'negative';
                  return (
                    <tr
                      key={r.key}
                      className={`border-b border-slate-100 dark:border-slate-800/60 ${
                        isTotal ? 'bg-slate-50/80 dark:bg-slate-800/30 border-t-2 border-slate-300 dark:border-slate-700' : ''
                      }`}
                    >
                      <td
                        className={`px-4 py-2 ${
                          isTotal
                            ? 'font-bold text-slate-800 dark:text-slate-100'
                            : isNegative
                              ? 'pl-8 text-slate-400'
                              : r.depth === 1
                                ? 'pl-6 text-slate-600 dark:text-slate-300'
                                : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {r.label}
                      </td>
                      {periodCols.map((c, i) => {
                        const isVar = !!c.isVariance;
                        const v = isVar ? varianceFor(i, r.get) : r.get(c.figures);
                        const varPositive = v >= 0;
                        return (
                          <td
                            key={i}
                            className={`px-4 py-2 text-right font-mono whitespace-nowrap ${
                              isVar
                                ? `text-[11px] font-semibold border-l ${
                                    r.key === 'opex'
                                      ? 'text-slate-300 dark:text-slate-600'
                                      : varPositive
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-rose-500'
                                  }`
                                : isTotal
                                  ? 'font-bold text-slate-800 dark:text-slate-100'
                                  : isNegative
                                    ? 'text-rose-500'
                                    : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {r.key === 'opex' ? '—' : isVar ? `${varPositive ? '+' : ''}${formatNPR(v)}` : formatNPR(v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Sign-off (statement only) */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-4 text-[10px] text-slate-400 max-w-3xl mx-auto">
            <div className="text-left">
              <p className="font-bold uppercase tracking-wider">Prepared By</p>
              <p className="mt-8 border-t border-slate-300 dark:border-slate-700 pt-1">Authorized Signatory</p>
            </div>
            <div className="text-right">
              <p className="font-bold uppercase tracking-wider">Reviewed By</p>
              <p className="mt-8 border-t border-slate-300 dark:border-slate-700 pt-1">Management / Accountant</p>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* ===== Branch Comparison report: rows = branches (scales downward) ===== */}
          <div className="text-center border-b-2 border-slate-300 dark:border-slate-700 pb-4">
            <h3 className="text-lg font-serif font-bold text-slate-800 dark:text-slate-200 tracking-wide">
              BRANCH COMPARISON REPORT
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {curFyLabel || 'Current'}
              {comparativeMode && priorFy ? ` vs ${priorFyLabel} · ` : ' · '}
              {activeBranches.length} branches + consolidated
            </p>
          </div>

          <div className="rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800 overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[880px]">
              <thead>
                <tr className="border-b-2 border-slate-300 dark:border-slate-700">
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-slate-400 text-[10px] sticky left-0 bg-white dark:bg-slate-900/95 min-w-[170px] z-10">
                    Branch
                  </th>
                  {COMPARISON_KPIS.map((k) => (
                    <th key={k.key} className="px-3 py-3 text-right font-bold whitespace-nowrap">
                      <span className="block text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {k.label}
                      </span>
                      <span className="block text-[9px] font-mono text-slate-400 mt-0.5">{curFyLabel || 'Current'}</span>
                    </th>
                  ))}
                  {comparativeMode && priorFy && (
                    <th className="px-3 py-3 text-right font-bold whitespace-nowrap bg-slate-50/80 dark:bg-slate-800/40">
                      <span className="block text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Total Assets {priorFyLabel}
                      </span>
                      <span className="block text-[9px] font-mono text-slate-400 mt-0.5">prior-year close</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map(({ branch, current, prior }) => {
                  const priorDelta =
                    comparativeMode && prior && prior.totalAssets !== 0
                      ? current.totalAssets - prior.totalAssets
                      : null;
                  return (
                    <tr key={branch.id} className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50/60 dark:hover:bg-slate-800/20">
                      <td className="px-4 py-2.5 sticky left-0 bg-white dark:bg-slate-900/95 z-10">
                        <span className="flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                          <Building2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          {branch.name}
                          {branch.isHeadquarters ? ' (HQ)' : ''}
                          {branch.code && (
                            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-400">
                              {branch.code}
                            </span>
                          )}
                        </span>
                      </td>
                      {COMPARISON_KPIS.map((k) => (
                        <td key={k.key} className={`px-3 py-2.5 text-right font-mono whitespace-nowrap ${k.color}`}>
                          {formatNPR(k.get(current))}
                        </td>
                      ))}
                      {comparativeMode && priorFy && (
                        <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap bg-slate-50/50 dark:bg-slate-800/20">
                          {prior && (
                            <>
                              <span className="block text-slate-500 dark:text-slate-400">{formatNPR(prior.totalAssets)}</span>
                              {priorDelta !== null && (
                                <span
                                  className={`block text-[10px] font-semibold ${
                                    priorDelta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
                                  }`}
                                >
                                  {priorDelta >= 0 ? '▲ +' : '▼ '}
                                  {formatNPR(priorDelta)}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {/* Consolidated row */}
                <tr className="border-t-2 border-slate-300 dark:border-slate-700 bg-indigo-50/50 dark:bg-indigo-950/20 font-bold">
                  <td className="px-4 py-3 sticky left-0 bg-indigo-50/95 dark:bg-indigo-950/60 z-10">
                    <span className="flex items-center gap-2 text-indigo-700 dark:text-indigo-300 whitespace-nowrap">
                      <Building2 className="h-3.5 w-3.5" />
                      CONSOLIDATED
                    </span>
                  </td>
                  {COMPARISON_KPIS.map((k) => (
                    <td key={k.key} className={`px-3 py-3 text-right font-mono whitespace-nowrap text-indigo-700 dark:text-indigo-300`}>
                      {formatNPR(k.get(comparisonConsolidated))}
                    </td>
                  ))}
                  {comparativeMode && priorFy && comparisonConsolidatedPrior && (
                    <td className="px-3 py-3 text-right font-mono whitespace-nowrap text-indigo-700 dark:text-indigo-300 bg-indigo-50/80 dark:bg-indigo-950/40">
                      <span className="block">{formatNPR(comparisonConsolidatedPrior.totalAssets)}</span>
                      <span
                        className={`block text-[10px] font-semibold ${
                          comparisonConsolidated.totalAssets - comparisonConsolidatedPrior.totalAssets >= 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-500'
                        }`}
                      >
                        {comparisonConsolidated.totalAssets - comparisonConsolidatedPrior.totalAssets >= 0 ? '▲ +' : '▼ '}
                        {formatNPR(comparisonConsolidated.totalAssets - comparisonConsolidatedPrior.totalAssets)}
                      </span>
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="p-4 rounded-2xl border bg-slate-50/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 flex items-start gap-3">
            <Info className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
            <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
              <p>
                <span className="font-bold text-slate-600 dark:text-slate-300">Reading this report:</span> each row is one
                branch, columns are KPIs — the table grows <em>downward</em> as branches are added, never sideways. The
                consolidated row is the group total. Turn on{' '}
                <span className="font-semibold">Compare with {priorFyLabel}</span> for prior-year closing assets and the
                change per branch. For the full formal statement of any single entity, switch to the{' '}
                <span className="font-semibold">Statement</span> view and pick it from the filter.
              </p>
            </div>
          </div>

          {statementType === 'PROFIT_LOSS' && (
            <div className="p-4 rounded-2xl border bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/60 flex items-start gap-3">
              <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-bold">Operating expenses &amp; net profit are not published</p>
                <p>
                  No expense journal / general-ledger posting exists yet, so profit below the gross line remains
                  unpublished across all branches.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
