/**
 * Company Overview — the cross-department executive landing page.
 *
 * Unlike the inventory/finance operations dashboard, this screen is a set of
 * small department snapshots. Each card is permission-gated and links into the
 * register or dashboard that owns the detail. It deliberately does not render
 * ledgers or full tables: the Overview group is an entry point, not a second
 * copy of every module.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  Gauge,
  GripVertical,
  Landmark,
  LayoutDashboard,
  Package,
  RotateCcw,
  Save,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { useActivationKey } from '../../components/common/KeepMounted';
import { useDialog } from '../../components/common/DialogProvider';
import { api } from '../../services/api';
import type { HrPayrollReport, HrWorkforceReport } from '../../services/api';
import type {
  AgingResponse,
  BudgetBranchUtilisationResponse,
  BudgetOverspendAlertsResponse,
  CashFlowResponse,
} from '../../services/api/accounting';
import { useShipmentOverview } from '../../services/shipmentOverviewCache';
import type {
  ApprovalRequest,
  Branch,
  FinancialSummary,
  InventoryStock,
  Product,
  PurchaseOrder,
  User,
} from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { formatNPR } from '../../utils/nprFormat';
import { isOperationAllowed } from '../../utils/permissions';
import { APP_ROLE_LABELS } from '../../utils/permissionMatrixData';
import {
  COMPANY_OVERVIEW_CARD_LABELS,
  DEFAULT_COMPANY_OVERVIEW_CARD_ORDER,
  companyOverviewCardOrderForRole,
  type CompanyOverviewCardId,
} from '../../../../shared/companyOverview';

interface CompanyOverviewProps {
  currentUser?: User | null;
  branches: Branch[];
  products: Product[];
  stock: InventoryStock[];
  financialSummary: FinancialSummary;
  pendingPurchaseOrders: PurchaseOrder[];
  unpaidInvoiceCount: number;
  approvalRequests?: ApprovalRequest[];
  selectedBranchId: string;
  fiscalYearId?: string;
  fiscalYearStartAD?: string;
  fiscalYearEndAD?: string;
  /** Saved role → card order map from app settings. */
  cardOrderByRole?: string;
  onCardOrderSaved?: (cardOrderByRole: string) => void;
  onNavigateTab: (tab: any) => void;
}

type Tone = 'indigo' | 'emerald' | 'sky' | 'teal' | 'amber' | 'rose' | 'violet';

interface LiquiditySnapshot {
  cashFlow: CashFlowResponse | null;
  ar: AgingResponse | null;
  ap: AgingResponse | null;
}

interface BudgetHealthSnapshot {
  alerts: BudgetOverspendAlertsResponse | null;
  utilisation: BudgetBranchUtilisationResponse | null;
}

interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: 'amber' | 'rose';
  onOpen: () => void;
}

const TONE_STYLES: Record<Tone, { icon: string; rule: string; value: string }> = {
  indigo: {
    icon: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300',
    rule: 'bg-indigo-500',
    value: 'text-indigo-700 dark:text-indigo-300',
  },
  emerald: {
    icon: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
    rule: 'bg-emerald-500',
    value: 'text-emerald-700 dark:text-emerald-300',
  },
  sky: {
    icon: 'bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300',
    rule: 'bg-sky-500',
    value: 'text-sky-700 dark:text-sky-300',
  },
  teal: {
    icon: 'bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-300',
    rule: 'bg-teal-500',
    value: 'text-teal-700 dark:text-teal-300',
  },
  amber: {
    icon: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
    rule: 'bg-amber-500',
    value: 'text-amber-700 dark:text-amber-300',
  },
  rose: {
    icon: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
    rule: 'bg-rose-500',
    value: 'text-rose-700 dark:text-rose-300',
  },
  violet: {
    icon: 'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300',
    rule: 'bg-violet-500',
    value: 'text-violet-700 dark:text-violet-300',
  },
};

interface SnapshotMetric {
  label: string;
  value: React.ReactNode;
  hint?: string;
}

interface DepartmentCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  tone: Tone;
  metrics: SnapshotMetric[];
  linkLabel: string;
  onOpen: () => void;
  loading?: boolean;
  error?: string;
  ordering?: boolean;
  attention?: { tone: 'amber' | 'rose'; message: string };
  visual?: React.ReactNode;
}

const DepartmentCard: React.FC<DepartmentCardProps> = ({
  title,
  description,
  icon,
  tone,
  metrics,
  linkLabel,
  onOpen,
  loading = false,
  error = '',
  ordering = false,
  attention,
  visual,
}) => {
  const styles = TONE_STYLES[tone];
  const attentionBorder =
    attention?.tone === 'rose'
      ? 'border-rose-300 dark:border-rose-900/70'
      : attention?.tone === 'amber'
        ? 'border-amber-300 dark:border-amber-900/70'
        : 'border-slate-200 dark:border-slate-800';
  const attentionRule =
    attention?.tone === 'rose'
      ? 'bg-rose-500'
      : attention?.tone === 'amber'
        ? 'bg-amber-500'
        : styles.rule;
  const attentionBanner =
    attention?.tone === 'rose'
      ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200'
      : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200';

  return (
    <section
      className={`relative flex min-h-[230px] flex-col overflow-hidden rounded-2xl border bg-white p-4 shadow-xs dark:bg-[#0f1218] ${attentionBorder}`}
    >
      <span className={`absolute inset-x-0 top-0 h-0.5 ${attentionRule}`} />
      <div className={`flex items-start justify-between gap-3 ${ordering ? 'pr-20' : ''}`}>
        <div className="flex items-start gap-2.5">
          <span className={`rounded-xl p-2 ${styles.icon}`}>{icon}</span>
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h3>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
              {description}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid flex-1 grid-cols-2 gap-x-3 gap-y-4">
        {metrics.map((metric, index) => (
          <div
            key={metric.label}
            className={metrics.length % 2 === 1 && index === metrics.length - 1 ? 'col-span-2' : ''}
          >
            <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {metric.label}
            </p>
            <p
              className={`mt-0.5 text-lg font-bold leading-tight tabular-nums ${styles.value}`}
            >
              {loading ? '—' : metric.value}
            </p>
            {metric.hint ? (
              <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                {loading ? 'Loading…' : metric.hint}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {visual ? <div className="mt-3">{visual}</div> : null}

      {attention ? (
        <p
          className={`mt-3 flex items-start gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-semibold ${attentionBanner}`}
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{attention.message}</span>
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onOpen}
        disabled={ordering}
        className="mt-4 flex w-full cursor-pointer items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-[11px] font-bold text-slate-700 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 disabled:cursor-default disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:border-indigo-500/40 dark:hover:bg-indigo-950/30 dark:hover:text-indigo-300"
      >
        <span>{linkLabel}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </section>
  );
};

const MetricValue: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="tabular-nums">{children}</span>
);

interface SnapshotBarRow {
  label: string;
  value: number;
  barClass: string;
}

/** Small CSS bar chart, following the finance registers' existing chart style. */
const SnapshotBars: React.FC<{ rows: SnapshotBarRow[]; ariaLabel: string }> = ({
  rows,
  ariaLabel,
}) => {
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  return (
    <div className="space-y-1.5" role="img" aria-label={ariaLabel}>
      {rows.map((row) => {
        const width = Math.max(0, Math.min(100, (Math.abs(row.value) / max) * 100));
        return (
          <div key={row.label}>
            <div className="flex items-baseline justify-between gap-2 text-[10px]">
              <span className="truncate font-medium text-slate-500 dark:text-slate-400">
                {row.label}
              </span>
              <span className="shrink-0 font-mono font-semibold text-slate-600 dark:text-slate-300">
                {formatNPR(row.value)}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-full rounded-full ${row.barClass}`}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const BudgetMeter: React.FC<{ percent: number | null }> = ({ percent }) => {
  if (percent === null) {
    return (
      <p className="text-[10px] text-slate-400 dark:text-slate-500">
        No budget is configured for this scope.
      </p>
    );
  }
  const capped = Math.max(0, Math.min(100, percent));
  const barClass = percent > 100 ? 'bg-rose-500' : percent >= 85 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div role="img" aria-label={`Budget used ${percent.toFixed(1)} percent`}>
      <div className="flex items-baseline justify-between gap-2 text-[10px]">
        <span className="font-semibold text-slate-500 dark:text-slate-400">Budget used</span>
        <span
          className={`font-mono font-bold ${
            percent > 100
              ? 'text-rose-600 dark:text-rose-400'
              : percent >= 85
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {percent.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${capped}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-slate-400 dark:text-slate-500">
        <span>0%</span>
        <span>100%</span>
      </div>
    </div>
  );
};

export const CompanyOverview: React.FC<CompanyOverviewProps> = ({
  currentUser,
  branches,
  products,
  stock,
  financialSummary,
  pendingPurchaseOrders,
  unpaidInvoiceCount,
  approvalRequests = [],
  selectedBranchId,
  fiscalYearId,
  fiscalYearStartAD,
  fiscalYearEndAD,
  cardOrderByRole,
  onCardOrderSaved,
  onNavigateTab,
}) => {
  const activationKey = useActivationKey('company-overview');
  const { confirm: confirmDialog } = useDialog();
  const [workforce, setWorkforce] = useState<HrWorkforceReport | null>(null);
  const [payroll, setPayroll] = useState<HrPayrollReport | null>(null);
  const [hrLoading, setHrLoading] = useState(false);
  const [hrError, setHrError] = useState('');
  const [liquidity, setLiquidity] = useState<LiquiditySnapshot | null>(null);
  const [liquidityLoading, setLiquidityLoading] = useState(false);
  const [liquidityError, setLiquidityError] = useState('');
  const [budgetHealth, setBudgetHealth] = useState<BudgetHealthSnapshot | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [budgetError, setBudgetError] = useState('');
  const roleLabel = currentUser?.role
    ? APP_ROLE_LABELS[currentUser.role] || currentUser.role
    : 'your role';
  const savedCardOrder = useMemo(
    () => companyOverviewCardOrderForRole(cardOrderByRole, currentUser?.role),
    [cardOrderByRole, currentUser?.role]
  );
  const [draftCardOrder, setDraftCardOrder] = useState<CompanyOverviewCardId[]>(() => savedCardOrder);
  const [arrangingCards, setArrangingCards] = useState(false);
  const [savingCardOrder, setSavingCardOrder] = useState(false);
  const [resettingCardOrder, setResettingCardOrder] = useState(false);
  const [cardOrderError, setCardOrderError] = useState('');
  const [cardOrderNotice, setCardOrderNotice] = useState('');
  const [draggingCard, setDraggingCard] = useState<{
    id: CompanyOverviewCardId;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
  } | null>(null);
  const [dragPoint, setDragPoint] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!arrangingCards) setDraftCardOrder(savedCardOrder);
  }, [arrangingCards, savedCardOrder]);

  const canViewFinance =
    isOperationAllowed('fin-statements', currentUser?.role) ||
    isOperationAllowed('gl-view', currentUser?.role);
  const canViewFinanceDashboard = isOperationAllowed('fin-statements', currentUser?.role);
  const canViewAssets = isOperationAllowed('assets-view', currentUser?.role);
  const canViewInventory =
    isOperationAllowed('prod-view', currentUser?.role) ||
    isOperationAllowed('stock-valuation', currentUser?.role) ||
    canViewAssets;
  const canViewProcurement =
    isOperationAllowed('po-create', currentUser?.role) ||
    isOperationAllowed('inv-create', currentUser?.role) ||
    isOperationAllowed('shipment-history', currentUser?.role);
  const canViewWarehouse =
    isOperationAllowed('shipment-history', currentUser?.role) ||
    isOperationAllowed('wh-receive-pullouts', currentUser?.role) ||
    isOperationAllowed('branch-transfer-receive', currentUser?.role);
  const canViewLiquidity = isOperationAllowed('gl-view', currentUser?.role);
  const canViewBudgetHealth = canViewLiquidity && Boolean(fiscalYearId);
  const canViewSales =
    isOperationAllowed('sales-invoice-create', currentUser?.role) || canViewFinanceDashboard;
  const canViewSupplierBills =
    isOperationAllowed('inv-pay', currentUser?.role) ||
    isOperationAllowed('gl-view', currentUser?.role) ||
    canViewFinanceDashboard;
  const canViewHr =
    isOperationAllowed('hr-employee-view', currentUser?.role) ||
    isOperationAllowed('gl-payroll-manage', currentUser?.role);
  const canApproveWorkflow =
    isOperationAllowed('workflow-approval', currentUser?.role) ||
    isOperationAllowed('workflow-approval-cancel', currentUser?.role);
  const shipments = useShipmentOverview(selectedBranchId);

  // A single scoped snapshot for the HR cards; both endpoints use the same
  // session-derived branch scope. The date window is fiscal-year-to-date so the
  // numbers line up with the rest of this page rather than a separate preset.
  useEffect(() => {
    if (!canViewHr) {
      setWorkforce(null);
      setPayroll(null);
      setHrError('');
      return;
    }
    let cancelled = false;
    const today = localTodayAD();
    const dateTo = fiscalYearEndAD && fiscalYearEndAD < today ? fiscalYearEndAD : today;
    const query = {
      branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
      dateFrom: fiscalYearStartAD || undefined,
      dateTo,
    };
    setHrLoading(true);
    setHrError('');
    void Promise.allSettled([
      api.getHrWorkforceReport(query),
      api.getHrPayrollReport(query),
    ])
      .then(([workforceResult, payrollResult]) => {
        if (cancelled) return;
        if (workforceResult.status === 'fulfilled') {
          setWorkforce(workforceResult.value);
        } else {
          setWorkforce(null);
        }
        if (payrollResult.status === 'fulfilled') {
          setPayroll(payrollResult.value);
        } else {
          setPayroll(null);
        }
        if (workforceResult.status === 'rejected' && payrollResult.status === 'rejected') {
          setHrError('HR summary is unavailable. Open HR Reports for the detailed view.');
        } else if (workforceResult.status === 'rejected') {
          setHrError('Headcount is unavailable right now.');
        } else if (payrollResult.status === 'rejected') {
          setHrError('Payroll cost is unavailable right now.');
        }
      })
      .finally(() => {
        if (!cancelled) setHrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activationKey, canViewHr, selectedBranchId, fiscalYearStartAD, fiscalYearEndAD]);

  // Liquidity and budget snapshots are separate finance reads, not bootstrap
  // slices: the Overview only needs a few statement figures and must not pull
  // the whole ledger. Both use the same fiscal-year-to-date window as the HR
  // cards above and stay behind the gl-view grant.
  useEffect(() => {
    if (!canViewLiquidity) {
      setLiquidity(null);
      setLiquidityLoading(false);
      setLiquidityError('');
      return;
    }
    let cancelled = false;
    const today = localTodayAD();
    const to = fiscalYearEndAD && fiscalYearEndAD < today ? fiscalYearEndAD : today;
    const branchId = selectedBranchId !== 'ALL' ? selectedBranchId : undefined;
    setLiquidityLoading(true);
    setLiquidityError('');
    void Promise.allSettled([
      api.getCashFlow({ branchId, from: fiscalYearStartAD, to }),
      api.getAging({ type: 'AR', branchId, asOf: to }),
      api.getAging({ type: 'AP', branchId, asOf: to }),
    ])
      .then(([cashFlowResult, arResult, apResult]) => {
        if (cancelled) return;
        setLiquidity({
          cashFlow: cashFlowResult.status === 'fulfilled' ? cashFlowResult.value : null,
          ar: arResult.status === 'fulfilled' ? arResult.value : null,
          ap: apResult.status === 'fulfilled' ? apResult.value : null,
        });
        const missing = [
          cashFlowResult.status === 'rejected' ? 'cash flow' : '',
          arResult.status === 'rejected' ? 'receivables' : '',
          apResult.status === 'rejected' ? 'payables' : '',
        ].filter(Boolean);
        if (missing.length === 3) {
          setLiquidityError('Liquidity summary is unavailable for this scope.');
        } else if (missing.length > 0) {
          setLiquidityError(`Some liquidity figures are unavailable: ${missing.join(', ')}.`);
        }
      })
      .finally(() => {
        if (!cancelled) setLiquidityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activationKey, canViewLiquidity, selectedBranchId, fiscalYearStartAD, fiscalYearEndAD]);

  useEffect(() => {
    if (!canViewBudgetHealth || !fiscalYearId) {
      setBudgetHealth(null);
      setBudgetLoading(false);
      setBudgetError('');
      return;
    }
    let cancelled = false;
    const today = localTodayAD();
    const to = fiscalYearEndAD && fiscalYearEndAD < today ? fiscalYearEndAD : today;
    const query = {
      fiscalYearId,
      branchId: selectedBranchId,
      from: fiscalYearStartAD,
      to,
    };
    setBudgetLoading(true);
    setBudgetError('');
    void Promise.allSettled([
      api.getAccountingBudgetAlerts({ ...query, limit: 4 }),
      api.getAccountingBudgetVarianceUtilisation(query),
    ])
      .then(([alertsResult, utilisationResult]) => {
        if (cancelled) return;
        setBudgetHealth({
          alerts: alertsResult.status === 'fulfilled' ? alertsResult.value : null,
          utilisation: utilisationResult.status === 'fulfilled' ? utilisationResult.value : null,
        });
        const missing = [
          alertsResult.status === 'rejected' ? 'overspend alerts' : '',
          utilisationResult.status === 'rejected' ? 'budget utilisation' : '',
        ].filter(Boolean);
        if (missing.length === 2) {
          setBudgetError('Budget health is unavailable for this scope.');
        } else if (missing.length > 0) {
          setBudgetError(`Some budget figures are unavailable: ${missing.join(', ')}.`);
        }
      })
      .finally(() => {
        if (!cancelled) setBudgetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activationKey,
    canViewBudgetHealth,
    fiscalYearId,
    selectedBranchId,
    fiscalYearStartAD,
    fiscalYearEndAD,
  ]);

  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.active !== false),
    [branches]
  );
  const scopeBranches = useMemo(
    () =>
      selectedBranchId === 'ALL'
        ? activeBranches
        : activeBranches.filter((branch) => branch.id === selectedBranchId),
    [activeBranches, selectedBranchId]
  );
  const stockSummary = useMemo(() => {
    if (scopeBranches.length === 0) return { lowStockCount: 0, activeSkuCount: 0 };
    const stockByProductBranch = new Map(
      stock.map((row) => [`${row.productId}|${row.branchId}`, row] as const)
    );
    const activeSkus = new Set<string>();
    let lowStockCount = 0;
    for (const product of products) {
      let isLow = false;
      for (const branch of scopeBranches) {
        const row = stockByProductBranch.get(`${product.id}|${branch.id}`);
        const onHand = row?.quantityOnHand ?? 0;
        if (onHand > 0) activeSkus.add(product.id);
        const threshold =
          row?.minReorderLevel !== undefined && row?.minReorderLevel !== null
            ? row.minReorderLevel
            : product.minReorderLevel;
        if (threshold > 0 ? onHand <= threshold : onHand <= 0) isLow = true;
      }
      if (isLow) lowStockCount += 1;
    }
    return { lowStockCount, activeSkuCount: activeSkus.size };
  }, [products, scopeBranches, stock]);
  const lowStockCount = stockSummary.lowStockCount;

  const branchLabel =
    selectedBranchId === 'ALL'
      ? 'All permitted branches'
      : branches.find((branch) => branch.id === selectedBranchId)?.name ||
        selectedBranchId;
  const pendingApprovals = approvalRequests.filter(
    (request) => request.status === 'PENDING'
  ).length;
  const salesRevenue = Number(financialSummary.totalSalesRevenue || 0);
  const cogs = Number(financialSummary.totalCostOfGoodsSold || 0);
  const grossProfit = salesRevenue - cogs;
  const grossMargin = salesRevenue > 0 ? (grossProfit / salesRevenue) * 100 : null;
  const hrHeadcount = workforce?.headcount.total ?? 0;
  const separations = workforce?.attrition.separations ?? 0;
  const payrollCost = payroll?.payrollCost.available
    ? payroll.payrollCost.totals.totalCost
    : null;
  const inTransitShipments =
    (shipments.counts.IN_TRANSIT || 0) + (shipments.counts.DISPATCHED || 0);
  const awaitingReceiptShipments = shipments.pending.length;
  const todayAD = localTodayAD();
  const overdueShipments = shipments.pending.filter(
    (shipment) =>
      Boolean(shipment.estimatedArrivalAD) && shipment.estimatedArrivalAD < todayAD
  ).length;
  const receivingExceptions = shipments.pending.filter(
    (shipment) => shipment.hasDiscrepancy || shipment.status === 'DISCREPANCY'
  ).length;
  const warehouseAttentionIssues: string[] = [];
  if (overdueShipments > 0) {
    warehouseAttentionIssues.push(
      `${overdueShipments} overdue arrival${overdueShipments === 1 ? '' : 's'}`
    );
  }
  if (receivingExceptions > 0) {
    warehouseAttentionIssues.push(
      `${receivingExceptions} receiving exception${receivingExceptions === 1 ? '' : 's'}`
    );
  }
  const warehouseAttention = warehouseAttentionIssues.length
    ? {
        tone: (receivingExceptions > 0 ? 'rose' : 'amber') as 'amber' | 'rose',
        message: `${warehouseAttentionIssues.join(' and ')} ${
          warehouseAttentionIssues.length === 1 ? 'needs' : 'need'
        } review.`,
      }
    : undefined;
  const shipmentsLoading = !shipments.loaded && shipments.loading;
  const shipmentsError =
    !shipments.loaded && shipments.error
      ? 'Shipment summary is unavailable. Open the register for the detailed view.'
      : '';

  const cashBank = liquidity?.cashFlow ? Number(liquidity.cashFlow.closingCash) : null;
  const netCashFlow = liquidity?.cashFlow ? Number(liquidity.cashFlow.netCashFlow) : null;
  const receivables = liquidity?.ar ? Number(liquidity.ar.totals.total) : null;
  const payables = liquidity?.ap ? Number(liquidity.ap.totals.total) : null;
  const netArAp =
    receivables !== null && payables !== null ? receivables - payables : null;
  const liquidityRows: SnapshotBarRow[] = [
    cashBank !== null
      ? { label: 'Cash & bank', value: cashBank, barClass: 'bg-sky-500' }
      : null,
    receivables !== null
      ? { label: 'Receivables', value: receivables, barClass: 'bg-emerald-500' }
      : null,
    payables !== null
      ? { label: 'Payables', value: payables, barClass: 'bg-rose-500' }
      : null,
  ].filter((row): row is SnapshotBarRow => row !== null);

  const budgetTotals = budgetHealth?.utilisation?.totals;
  const budgetTotal = budgetTotals ? Number(budgetTotals.budget) : 0;
  const budgetActual = budgetTotals ? Number(budgetTotals.actual) : 0;
  const budgetPercent =
    budgetTotal > 0 ? (budgetActual / budgetTotal) * 100 : null;
  const budgetOverBy = budgetHealth?.alerts
    ? Number(budgetHealth.alerts.totals.overBy)
    : 0;
  const budgetAlertCount = budgetHealth?.alerts
    ? Number(budgetHealth.alerts.totals.alertCount)
    : 0;
  const budgetAlertRows: SnapshotBarRow[] =
    budgetHealth?.alerts?.alerts.slice(0, 3).map((alert) => ({
      label: `${alert.code} · ${alert.name}`,
      value: Number(alert.overBy),
      barClass: 'bg-rose-500',
    })) || [];

  const financeTarget = canViewFinanceDashboard ? 'financial-statements' : 'accounting';
  const inventoryTarget = isOperationAllowed('stock-valuation', currentUser?.role)
    ? 'stock-valuation'
    : 'all-stock';
  const procurementTarget = isOperationAllowed('po-create', currentUser?.role)
    ? 'po-list'
    : 'purchase-list';
  const warehouseTarget = isOperationAllowed('shipment-history', currentUser?.role)
    ? 'shipment-list'
    : isOperationAllowed('wh-receive-pullouts', currentUser?.role)
      ? 'receive-shipment'
      : 'receive-branch-transfer';

  const attentionItems: AttentionItem[] = [];
  if (canViewInventory && lowStockCount > 0) {
    attentionItems.push({
      key: 'low-stock',
      label: `low-stock SKU${lowStockCount === 1 ? '' : 's'}`,
      count: lowStockCount,
      tone: 'amber',
      onOpen: () => onNavigateTab('reorder-stock'),
    });
  }
  if (canApproveWorkflow && pendingApprovals > 0) {
    attentionItems.push({
      key: 'approvals',
      label: `pending approval${pendingApprovals === 1 ? '' : 's'}`,
      count: pendingApprovals,
      tone: 'amber',
      onOpen: () => onNavigateTab('approvals'),
    });
  }
  if (canViewProcurement && pendingPurchaseOrders.length > 0) {
    attentionItems.push({
      key: 'open-pos',
      label: `open purchase order${pendingPurchaseOrders.length === 1 ? '' : 's'}`,
      count: pendingPurchaseOrders.length,
      tone: 'amber',
      onOpen: () => onNavigateTab(procurementTarget),
    });
  }
  if (canViewWarehouse && overdueShipments > 0) {
    attentionItems.push({
      key: 'overdue-shipments',
      label: `overdue transfer${overdueShipments === 1 ? '' : 's'}`,
      count: overdueShipments,
      tone: 'amber',
      onOpen: () => onNavigateTab(warehouseTarget),
    });
  }
  if (canViewWarehouse && receivingExceptions > 0) {
    attentionItems.push({
      key: 'receiving-exceptions',
      label: `receiving exception${receivingExceptions === 1 ? '' : 's'}`,
      count: receivingExceptions,
      tone: 'rose',
      onOpen: () => onNavigateTab(warehouseTarget),
    });
  }
  if (canViewBudgetHealth && budgetAlertCount > 0) {
    attentionItems.push({
      key: 'budget-alerts',
      label: `over-budget account${budgetAlertCount === 1 ? '' : 's'}`,
      count: budgetAlertCount,
      tone: 'rose',
      onOpen: () => onNavigateTab(financeTarget),
    });
  }

  const departmentVisibility = useMemo<Record<CompanyOverviewCardId, boolean>>(
    () => ({
      finance: canViewFinance,
      inventory: canViewInventory,
      procurement: canViewProcurement,
      warehouse: canViewWarehouse,
      liquidity: canViewLiquidity,
      budget: canViewBudgetHealth,
      sales: canViewSales,
      hr: canViewHr,
    }),
    [
      canViewBudgetHealth,
      canViewFinance,
      canViewHr,
      canViewInventory,
      canViewLiquidity,
      canViewProcurement,
      canViewSales,
      canViewWarehouse,
    ]
  );
  const visibleCardOrder = draftCardOrder.filter((id) => departmentVisibility[id]);
  const visibleDepartments = visibleCardOrder.length;

  useEffect(() => {
    if (!draggingCard) return;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    const handleMove = (event: PointerEvent) => {
      if (event.pointerId !== draggingCard.pointerId) return;
      event.preventDefault();
      setDragPoint({ x: event.clientX, y: event.clientY });
      const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('[data-company-overview-card]');
      const targetId = target?.dataset.companyOverviewCard as CompanyOverviewCardId | undefined;
      if (!targetId || targetId === draggingCard.id) return;
      setDraftCardOrder((prev) => {
        const visible = prev.filter((cardId) => departmentVisibility[cardId]);
        const from = visible.indexOf(draggingCard.id);
        const to = visible.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return prev;
        visible.splice(from, 1);
        visible.splice(to, 0, draggingCard.id);
        const hidden = prev.filter((cardId) => !departmentVisibility[cardId]);
        return [...visible, ...hidden];
      });
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId !== draggingCard.pointerId) return;
      setDraggingCard(null);
    };
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [departmentVisibility, draggingCard]);

  const departmentCards: Record<CompanyOverviewCardId, React.ReactNode> = {
    finance: canViewFinance ? (
      <DepartmentCard
        title="Finance & Accounting"
        description="Payables, tax and recorded losses."
        icon={<Landmark className="h-4 w-4" />}
        tone="emerald"
        metrics={[
          {
            label: 'Accounts Payable',
            value: <MetricValue>{formatNPR(financialSummary.totalAccountsPayable)}</MetricValue>,
            hint: 'Open vendor balance',
          },
          {
            label: 'VAT Input Tax',
            value: <MetricValue>{formatNPR(financialSummary.totalVatInputTax)}</MetricValue>,
            hint: 'Recorded input tax',
          },
          {
            label: 'Damage Loss',
            value: <MetricValue>{formatNPR(financialSummary.totalDamageLossValue)}</MetricValue>,
            hint: 'Recorded damage value',
          },
        ]}
        linkLabel={canViewFinanceDashboard ? 'Open Finance Dashboard' : 'Open Accounting'}
        onOpen={() => onNavigateTab(financeTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    inventory: canViewInventory ? (
      <DepartmentCard
        title="Inventory & Assets"
        description="Stock value and replenishment pressure."
        icon={<Package className="h-4 w-4" />}
        tone="indigo"
        metrics={[
          {
            label: 'Stock Valuation',
            value: (
              <MetricValue>{formatNPR(financialSummary.totalInventoryAssetValue)}</MetricValue>
            ),
            hint: 'At cost across the selected scope',
          },
          {
            label: 'Low-stock SKUs',
            value: (
              <MetricValue>
                {lowStockCount} SKU{lowStockCount === 1 ? '' : 's'}
              </MetricValue>
            ),
            hint: lowStockCount > 0 ? 'At or below reorder level' : 'No reorder alerts',
          },
          canViewAssets
            ? {
                label: 'Fixed Assets',
                value: (
                  <MetricValue>{formatNPR(financialSummary.totalFixedAssetValue)}</MetricValue>
                ),
                hint: 'Net book value',
              }
            : {
                label: 'Active SKUs',
                value: (
                  <MetricValue>{stockSummary.activeSkuCount.toLocaleString('en-IN')}</MetricValue>
                ),
                hint: 'With stock in this scope',
              },
        ]}
        linkLabel={
          inventoryTarget === 'stock-valuation' ? 'Open Stock Valuation' : 'Open Stock Register'
        }
        onOpen={() => onNavigateTab(inventoryTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    procurement: canViewProcurement ? (
      <DepartmentCard
        title="Procurement & Supply"
        description="Open purchasing commitments and unpaid supplier bills."
        icon={<ShoppingCart className="h-4 w-4" />}
        tone="sky"
        metrics={[
          {
            label: 'Pending POs',
            value: (
              <MetricValue>
                {pendingPurchaseOrders.length} PO{pendingPurchaseOrders.length === 1 ? '' : 's'}
              </MetricValue>
            ),
            hint: 'Draft through purchased',
          },
          ...(canViewSupplierBills
            ? [
                {
                  label: 'Unpaid Bills',
                  value: (
                    <MetricValue>
                      {unpaidInvoiceCount} bill{unpaidInvoiceCount === 1 ? '' : 's'}
                    </MetricValue>
                  ),
                  hint: 'Awaiting payment',
                },
              ]
            : []),
        ]}
        linkLabel="Open Purchase Orders"
        onOpen={() => onNavigateTab(procurementTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    warehouse: canViewWarehouse ? (
      <DepartmentCard
        title="Warehouse & In-Transit"
        description="Transfer movement and receiving pressure."
        icon={<Truck className="h-4 w-4" />}
        tone="teal"
        loading={shipmentsLoading}
        error={shipmentsError}
        attention={shipmentsLoading ? undefined : warehouseAttention}
        metrics={[
          {
            label: 'In Transit',
            value: (
              <MetricValue>
                {inTransitShipments} transfer{inTransitShipments === 1 ? '' : 's'}
              </MetricValue>
            ),
            hint: 'Dispatched or moving',
          },
          {
            label: 'Awaiting Receipt',
            value: (
              <MetricValue>
                {awaitingReceiptShipments} transfer
                {awaitingReceiptShipments === 1 ? '' : 's'}
              </MetricValue>
            ),
            hint: shipments.pendingCapped
              ? 'Showing the first 1,000 open transfers'
              : 'Open transfer records',
          },
          {
            label: 'Overdue Arrivals',
            value: (
              <MetricValue>
                {overdueShipments} late
              </MetricValue>
            ),
            hint:
              overdueShipments > 0
                ? 'Past the estimated arrival date'
                : 'No late transfers',
          },
          {
            label: 'Receiving Exceptions',
            value: (
              <MetricValue>
                {receivingExceptions} flagged
              </MetricValue>
            ),
            hint:
              receivingExceptions > 0
                ? 'Review before closing receipt'
                : 'No receiving exceptions',
          },
        ]}
        linkLabel={
          warehouseTarget === 'shipment-list'
            ? 'Open Shipment Register'
            : warehouseTarget === 'receive-shipment'
              ? 'Open Inbound Receiving'
              : 'Open Branch Receiving'
        }
        onOpen={() => onNavigateTab(warehouseTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    liquidity: canViewLiquidity ? (
      <DepartmentCard
        title="Cash & Liquidity"
        description="Cash, receivables and payables at a glance."
        icon={<Wallet className="h-4 w-4" />}
        tone="sky"
        loading={liquidityLoading}
        error={liquidityError}
        metrics={[
          {
            label: 'Cash & Bank',
            value:
              cashBank === null ? '—' : <MetricValue>{formatNPR(cashBank)}</MetricValue>,
            hint: 'Closing balance',
          },
          {
            label: 'Net Cash Flow',
            value:
              netCashFlow === null ? (
                '—'
              ) : (
                <MetricValue>{formatNPR(netCashFlow)}</MetricValue>
              ),
            hint: 'Fiscal-year to date',
          },
          {
            label: 'Net AR / AP',
            value:
              netArAp === null ? '—' : <MetricValue>{formatNPR(netArAp)}</MetricValue>,
            hint:
              receivables === null || payables === null
                ? 'Receivables less payables'
                : `AR ${formatNPR(receivables)} · AP ${formatNPR(payables)}`,
          },
        ]}
        visual={
          liquidityRows.length > 0 ? (
            <SnapshotBars
              rows={liquidityRows}
              ariaLabel="Cash, receivables and payables"
            />
          ) : undefined
        }
        linkLabel={canViewFinanceDashboard ? 'Open Finance Dashboard' : 'Open Accounting'}
        onOpen={() => onNavigateTab(financeTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    budget: canViewBudgetHealth ? (
      <DepartmentCard
        title="Budget Health"
        description="Budget use and expense accounts above plan."
        icon={<Gauge className="h-4 w-4" />}
        tone="violet"
        loading={budgetLoading}
        error={budgetError}
        metrics={[
          {
            label: 'Budget Used',
            value:
              budgetPercent === null ? '—' : `${budgetPercent.toFixed(1)}%`,
            hint:
              budgetPercent === null
                ? 'No budget configured for this scope'
                : 'Posted expense vs budget',
          },
          {
            label: 'Over Budget',
            value: <MetricValue>{formatNPR(budgetOverBy)}</MetricValue>,
            hint:
              budgetAlertCount > 0
                ? 'Across alert accounts'
                : 'No over-budget accounts',
          },
          {
            label: 'Alert Accounts',
            value: <MetricValue>{budgetAlertCount}</MetricValue>,
            hint: 'Expense accounts above budget',
          },
        ]}
        visual={
          budgetHealth ? (
            <div className="space-y-2">
              <BudgetMeter percent={budgetPercent} />
              {budgetAlertRows.length > 0 ? (
                <SnapshotBars
                  rows={budgetAlertRows}
                  ariaLabel="Largest over-budget expense accounts"
                />
              ) : null}
            </div>
          ) : undefined
        }
        linkLabel={canViewFinanceDashboard ? 'Open Budget vs Actual' : 'Open Accounting'}
        onOpen={() => onNavigateTab(financeTarget)}
        ordering={arrangingCards}
      />
    ) : null,
    sales: canViewSales ? (
      <DepartmentCard
        title="Sales & Customers"
        description="Posted sales, cost of goods and gross margin."
        icon={<TrendingUp className="h-4 w-4" />}
        tone="violet"
        metrics={[
          {
            label: 'Sales Revenue',
            value: <MetricValue>{formatNPR(salesRevenue)}</MetricValue>,
            hint: 'Posted in the selected scope',
          },
          {
            label: 'Gross Profit',
            value: <MetricValue>{formatNPR(grossProfit)}</MetricValue>,
            hint: grossMargin != null ? `${grossMargin.toFixed(1)}% margin` : 'No sales recorded',
          },
          {
            label: 'Cost of Goods Sold',
            value: <MetricValue>{formatNPR(cogs)}</MetricValue>,
            hint: 'Matched to posted sales',
          },
        ]}
        linkLabel="Open Sales Invoices"
        onOpen={() => onNavigateTab('sales-list')}
        ordering={arrangingCards}
      />
    ) : null,
    hr: canViewHr ? (
      <DepartmentCard
        title="People & HR"
        description="Headcount, separations and payroll cost for the period."
        icon={<Users className="h-4 w-4" />}
        tone="amber"
        loading={hrLoading}
        error={hrError}
        metrics={[
          {
            label: 'Active Headcount',
            value: workforce ? (
              <MetricValue>
                {hrHeadcount.toLocaleString('en-IN')} employee
                {hrHeadcount === 1 ? '' : 's'}
              </MetricValue>
            ) : (
              '—'
            ),
            hint: 'Active employees in scope',
          },
          {
            label: 'Separations',
            value: workforce ? (
              <MetricValue>{separations.toLocaleString('en-IN')}</MetricValue>
            ) : (
              '—'
            ),
            hint: 'In the selected period',
          },
          {
            label: 'Payroll Cost',
            value:
              payrollCost == null ? '—' : <MetricValue>{formatNPR(payrollCost)}</MetricValue>,
            hint:
              payrollCost == null ? 'No posted payroll in this period' : 'Gross wages plus employer SSF',
          },
        ]}
        linkLabel="Open HR Reports"
        onOpen={() => onNavigateTab('hr-reports')}
        ordering={arrangingCards}
      />
    ) : null,
  };

  const orderIsDirty = draftCardOrder.some((id, index) => id !== savedCardOrder[index]);
  const hasCustomCardOrder = savedCardOrder.some(
    (id, index) => id !== DEFAULT_COMPANY_OVERVIEW_CARD_ORDER[index]
  );
  const startCardDrag = (
    event: React.PointerEvent<HTMLElement>,
    id: CompanyOverviewCardId
  ) => {
    if (!arrangingCards || savingCardOrder || resettingCardOrder || event.button !== 0) return;
    const card = event.currentTarget.closest<HTMLElement>('[data-company-overview-card]');
    const rect = (card || event.currentTarget).getBoundingClientRect();
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events (tests) have no active OS pointer to capture.
    }
    setCardOrderError('');
    setCardOrderNotice('');
    setDraggingCard({
      id,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    });
    setDragPoint({ x: event.clientX, y: event.clientY });
  };
  const startArranging = () => {
    setDraftCardOrder(savedCardOrder);
    setCardOrderError('');
    setCardOrderNotice('');
    setArrangingCards(true);
  };
  const cancelArranging = () => {
    setDraftCardOrder(savedCardOrder);
    setCardOrderError('');
    setDraggingCard(null);
    setArrangingCards(false);
  };
  const saveCardOrder = async () => {
    if (!orderIsDirty || savingCardOrder || resettingCardOrder) return;
    setSavingCardOrder(true);
    setCardOrderError('');
    try {
      const result = await api.saveCompanyOverviewCardOrder(draftCardOrder);
      setDraftCardOrder(result.cardOrder);
      onCardOrderSaved?.(result.cardOrderByRole);
      setCardOrderNotice(`Card order saved for the ${roleLabel} role.`);
      setArrangingCards(false);
    } catch (err: any) {
      setCardOrderError(err?.message || 'The card order could not be saved.');
    } finally {
      setSavingCardOrder(false);
    }
  };
  const resetCardOrderToDefault = async () => {
    if (!hasCustomCardOrder || savingCardOrder || resettingCardOrder) return;
    const confirmed = await confirmDialog(
      `Reset the Company Overview card order for every ${roleLabel} account to the default sequence? Other roles are unchanged.`,
      { title: 'Reset card order to default', confirmLabel: 'Reset to default' }
    );
    if (!confirmed) return;
    setResettingCardOrder(true);
    setCardOrderError('');
    try {
      const result = await api.resetCompanyOverviewCardOrder();
      setDraftCardOrder(result.cardOrder);
      onCardOrderSaved?.(result.cardOrderByRole);
      setCardOrderNotice(`Card order reset to default for the ${roleLabel} role.`);
      setArrangingCards(false);
    } catch (err: any) {
      setCardOrderError(err?.message || 'The card order could not be reset.');
    } finally {
      setResettingCardOrder(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Company Overview"
        description="A permission-scoped snapshot across the company. Each card opens the register or dashboard that owns the detail."
        icon={<LayoutDashboard className="h-5 w-5 text-indigo-500" />}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-600 dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300">
              <Building2 className="h-3.5 w-3.5 text-indigo-500" />
              {branchLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-600 dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-300">
              FY {financialSummary.currentFiscalYear}
            </span>
            {currentUser?.role && visibleDepartments > 0 && !arrangingCards ? (
              <button
                type="button"
                onClick={startArranging}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-indigo-300 bg-white px-3 py-1.5 font-bold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:bg-[#0f1218] dark:text-indigo-300 dark:hover:bg-indigo-950/40"
              >
                <GripVertical className="h-3.5 w-3.5" />
                Arrange cards
              </button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-col gap-3 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 via-white to-white p-4 shadow-xs dark:border-indigo-900/50 dark:from-indigo-950/30 dark:via-[#0f1218] dark:to-[#0f1218] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2.5">
          <span className="rounded-xl bg-indigo-600 p-2 text-white shadow-sm">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <p className="text-xs font-bold text-slate-900 dark:text-white">
              {visibleDepartments === 0
                ? 'No department snapshots are available for this account'
                : `You can see ${visibleDepartments} department snapshot${visibleDepartments === 1 ? '' : 's'}`}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">
              Cards disappear automatically when your role does not hold the matching read permission.
            </p>
          </div>
        </div>
        {canApproveWorkflow ? (
          <button
            type="button"
            onClick={() => onNavigateTab('approvals')}
            className="inline-flex cursor-pointer items-center gap-1.5 self-start rounded-xl bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-slate-800 dark:bg-indigo-600 dark:hover:bg-indigo-500 sm:self-auto"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {pendingApprovals > 0
              ? `${pendingApprovals} pending approval${pendingApprovals === 1 ? '' : 's'}`
              : 'Open Approval Center'}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {!arrangingCards && attentionItems.length > 0 ? (
        <section
          aria-labelledby="company-overview-attention-title"
          className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3 shadow-xs dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <span className="rounded-xl bg-amber-100 p-1.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div>
                <p
                  id="company-overview-attention-title"
                  className="text-xs font-bold text-amber-950 dark:text-amber-100"
                >
                  Needs attention
                </p>
                <p className="mt-0.5 text-[11px] text-amber-800/80 dark:text-amber-200/80">
                  {attentionItems.length} cross-department item
                  {attentionItems.length === 1 ? '' : 's'} need review. Open one to act on it.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attentionItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onOpen}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-xl border bg-white px-2.5 py-1.5 text-[10px] font-bold transition-colors ${
                    item.tone === 'rose'
                      ? 'border-rose-300 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-[#0f1218] dark:text-rose-300 dark:hover:bg-rose-950/30'
                      : 'border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-[#0f1218] dark:text-amber-300 dark:hover:bg-amber-950/30'
                  }`}
                >
                  <span className="font-mono font-extrabold">{item.count}</span>
                  <span>{item.label}</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {arrangingCards || cardOrderNotice || cardOrderError ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/70 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/20 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
            <div>
              <p className="text-xs font-bold text-indigo-950 dark:text-indigo-100">
                {arrangingCards ? `Arrange cards for the ${roleLabel} role` : 'Card order saved'}
              </p>
              <p className="mt-0.5 text-[11px] text-indigo-800/80 dark:text-indigo-200/80">
                {arrangingCards
                  ? 'Drag the handle on a card to reorder it. The card floats above the grid while you move it, and the order is shared by every account with this role.'
                  : cardOrderNotice}
              </p>
              {cardOrderError ? (
                <p className="mt-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                  {cardOrderError}
                </p>
              ) : null}
            </div>
          </div>
          {arrangingCards ? (
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => void resetCardOrderToDefault()}
                disabled={!hasCustomCardOrder || savingCardOrder || resettingCardOrder}
                title={
                  hasCustomCardOrder
                    ? 'Restore the default card order for this role'
                    : 'This role already uses the default card order'
                }
                className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-indigo-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {resettingCardOrder ? 'Resetting…' : 'Reset to default'}
              </button>
              <button
                type="button"
                onClick={cancelArranging}
                disabled={savingCardOrder || resettingCardOrder}
                className="inline-flex cursor-pointer items-center gap-1 rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-700 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveCardOrder()}
                disabled={!orderIsDirty || savingCardOrder || resettingCardOrder}
                className="inline-flex cursor-pointer items-center gap-1 rounded-xl bg-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {savingCardOrder ? 'Saving…' : 'Save order'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleCardOrder.map((id) => {
          const isDragging = draggingCard?.id === id;
          return (
            <div
              key={id}
              data-company-overview-card={id}
              className={`relative ${
                isDragging
                  ? 'opacity-30 outline-2 outline-offset-2 outline-dashed outline-indigo-400/80'
                  : ''
              }`}
            >
              {departmentCards[id]}
              {arrangingCards && !isDragging ? (
                <button
                  type="button"
                  onPointerDown={(event) => startCardDrag(event, id)}
                  aria-label={`Drag ${COMPANY_OVERVIEW_CARD_LABELS[id]} to reorder`}
                  title="Drag to reorder"
                  className="absolute right-3 top-3 z-10 inline-flex cursor-grab touch-none select-none items-center gap-1 rounded-lg border border-indigo-200 bg-white/95 px-1.5 py-1 text-[9px] font-bold uppercase tracking-wide text-indigo-600 shadow-sm active:cursor-grabbing dark:border-indigo-800 dark:bg-slate-900/95 dark:text-indigo-300"
                >
                  <GripVertical className="h-3.5 w-3.5" />
                  Drag
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {draggingCard
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[2000]"
              style={{
                left: dragPoint.x - draggingCard.offsetX,
                top: dragPoint.y - draggingCard.offsetY,
                width: draggingCard.width,
              }}
            >
              <div className="rotate-1 scale-[1.02] rounded-2xl shadow-2xl shadow-indigo-950/30 ring-2 ring-indigo-500/70">
                {departmentCards[draggingCard.id]}
              </div>
            </div>,
            document.body
          )
        : null}

      {canViewProcurement && pendingPurchaseOrders.length > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-[11px] text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/20 dark:text-sky-200">
          <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {pendingPurchaseOrders.length} purchase order
            {pendingPurchaseOrders.length === 1 ? '' : 's'} remain open in this scope. Open
            Purchase Orders to follow the next receipt or payment action.
          </span>
        </div>
      ) : null}

      {!canViewFinance &&
      !canViewInventory &&
      !canViewProcurement &&
      !canViewWarehouse &&
      !canViewLiquidity &&
      !canViewBudgetHealth &&
      !canViewSales &&
      !canViewHr ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-[#0f1218]">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
          <p className="mt-2 text-xs font-bold text-slate-800 dark:text-slate-200">
            No department snapshots are available
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Ask an administrator for a read grant on at least one department.
          </p>
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
        <CheckCircle2 className="h-3 w-3" />
        All figures are read-only and scoped by the signed-in account and selected branch. Open a
        card for the underlying register.
      </p>
    </div>
  );
};

export default CompanyOverview;
