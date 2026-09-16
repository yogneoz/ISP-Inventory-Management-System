import React, { useState, useEffect } from 'react';
import { Product, Branch, InventoryStock, User, StockOperation, DamageRecord } from '../../types';
import { NavTab } from '../../components/layout/Sidebar';
import { api } from '../../services/api';
import { canUserDisposeDamagedStock, isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { formatNPR } from '../../utils/nprFormat';
import { hasExactBSDayRecord, tryConvertADToBS, getNepaliFiscalYear } from '../../utils/nepaliCalendar';
import {
  AlertTriangle,
  Building2,
  Edit,
  CheckCircle2,
  X,
  Search,
  Filter,
  Truck,
  Plus,
  RefreshCw,
  AlertOctagon,
  ShieldAlert,
  ArrowRight,
  Flame,
  Trash2,
  DollarSign,
  FileText,
  HelpCircle,
  Scale,
  Receipt,
  ShieldCheck,
  Layers,
  Sparkles,
  Lock,
  Download,
  FileSpreadsheet,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface DamagedStockTrackingProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  damageRecords?: DamageRecord[];
  selectedBranchId: string;
  onUpdateStockLevel?: (stockId: string, newQty: number, reason: string, damagedQty?: number, changeType?: string) => Promise<void>;
  onCreateOperation?: (op: Partial<StockOperation>) => Promise<void>;
  onNavigateTab?: (tab: NavTab) => void;
}

export const DamagedStockTracking: React.FC<DamagedStockTrackingProps> = ({
  currentUser,
  products,
  branches,
  stock,
  damageRecords = [],
  selectedBranchId,
  onUpdateStockLevel,
  onCreateOperation,
  onNavigateTab,
}) => {
  const { isDarkMode } = useDarkMode();
  // Modal State for adjusting local damaged count
  const [editingStock, setEditingStock] = useState<{
    stockItem: InventoryStock;
    product: Product;
    branch: Branch;
  } | null>(null);

  const [newDamagedQty, setNewDamagedQty] = useState<number>(0);
  const [reason, setReason] = useState<string>('Damaged stock balance verification');

  // Modal State for Damaged Stock Disposal & Financial Write-Off
  const [disposalStock, setDisposalStock] = useState<{
    stockItem: InventoryStock;
    product: Product;
    branch: Branch;
  } | null>(null);

  const [disposalQty, setDisposalQty] = useState<number>(1);
  const [disposalMethod, setDisposalMethod] = useState<'SCRAP_DESTRUCTION' | 'SALVAGE_EWASTE' | 'VENDOR_RMA' | 'INSURANCE_CLAIM'>('SCRAP_DESTRUCTION');
  const [salvageRecoveryAmount, setSalvageRecoveryAmount] = useState<number>(0);
  const [glAccountCode, setGlAccountCode] = useState<string>('GL-5120 (Loss on Inventory Scrap & Write-off)');
  const [disposalNotes, setDisposalNotes] = useState<string>('Physical scrap destruction approved by Quality Auditor');
  const [isSubmittingDisposal, setIsSubmittingDisposal] = useState<boolean>(false);

  // ---------------------------------------------------------------------------
  // BS Calendar Gate: stock operations are only allowed when today's AD date
  // has a seeded Nepali (BS) day record in bs_day_records. Missing months are
  // seeded/updated by the admin from System Settings -> BS Calendar Utility.
  // ---------------------------------------------------------------------------
  const [bsDateStatus, setBsDateStatus] = useState<'checking' | 'available' | 'missing'>('checking');
  const [bsDateCheckedFor, setBsDateCheckedFor] = useState<string>(new Date().toISOString().split('T')[0]);

  const checkBsDateAvailability = async () => {
    const todayAD = new Date().toISOString().split('T')[0];
    try {
      const res = await api.getBsDayRecordByAdDate(todayAD);
      setBsDateCheckedFor(todayAD);
      setBsDateStatus(res?.found ? 'available' : 'missing');
    } catch (_err) {
      // Server unreachable -> fall back to the strict client-side calendar check
      setBsDateCheckedFor(todayAD);
      setBsDateStatus(hasExactBSDayRecord(todayAD) ? 'available' : 'missing');
    }
  };

  useEffect(() => {
    checkBsDateAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureBsDateAvailable = (): boolean => {
    if (bsDateStatus === 'missing') {
      alert(
        'BS date is not available. Stock operations are locked.\n\n' +
          `Today (${bsDateCheckedFor}) has no Nepali (BS) date record in the BS calendar database (bs_day_records).\n` +
          'Please contact your system administrator for BS month seeding.\n\n' +
          'Admin path: System Settings -> BS Calendar Utility -> Seed / Update BS month.'
      );
      return false;
    }
    return true;
  };

  // Guide State
  const [showWriteOffGuide, setShowWriteOffGuide] = useState<boolean>(false);

  const [showZeroDamaged, setShowZeroDamaged] = useState(false);
  const [localSearch, setLocalSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');

  const categories = Array.from(new Set(products.map((p) => p.category)));

  const activeBranches =
    selectedBranchId === 'ALL'
      ? branches
      : branches.filter((b) => b.id === selectedBranchId);

  // Compute damaged stock quantity per product across visible branches
  const productsWithDamaged = products.map((prod) => {
    const branchData = activeBranches.map((b) => {
      const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);

      // Get damage records for this product + branch
      const prodDamageRecords = (damageRecords || []).filter(
        (dr) => dr.productId === prod.id && dr.branchId === b.id
      );

      // Calculate quantities by status
      const identifiedOrUnderReview = prodDamageRecords
        .filter((dr) => dr.status === 'IDENTIFIED' || dr.status === 'UNDER_REVIEW')
        .reduce((sum, dr) => sum + Number(dr.quantityDamaged), 0);
      const disposedOrWrittenOff = prodDamageRecords
        .filter((dr) => dr.status === 'DISPOSED' || dr.status === 'WRITTEN_OFF')
        .reduce((sum, dr) => sum + Number(dr.quantityDamaged), 0);

      // Use damage_records if available, otherwise fallback to stock.damagedQty
      const damagedQty = prodDamageRecords.length > 0
        ? identifiedOrUnderReview
        : Number(item?.damagedQty) || 0;

      return {
        branch: b,
        damagedQty,
        usableQty: Number(item?.quantityOnHand) || 0,
        damageRecords: prodDamageRecords,
        disposedQty: disposedOrWrittenOff,
      };
    });
    const totalDamagedQty = branchData.reduce((sum, bd) => sum + Number(bd.damagedQty), 0);
    const totalUsableQty = branchData.reduce((sum, bd) => sum + Number(bd.usableQty), 0);

    const totalLossValuation = totalDamagedQty * (prod.costPrice || 0);

    return { prod, branchData, totalDamagedQty, totalUsableQty, totalLossValuation };
  });

  const visibleProducts = productsWithDamaged
    .filter(({ prod, totalDamagedQty }) => {
      const matchesDamagedFilter = showZeroDamaged || totalDamagedQty > 0;
      const matchesCat = filterCategory === 'ALL' || prod.category === filterCategory;
      const query = localSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        (prod?.name || '').toLowerCase().includes(query) ||
        (prod?.sku || '').toLowerCase().includes(query) ||
        (prod?.barcode || '').toLowerCase().includes(query) ||
        (prod?.category || '').toLowerCase().includes(query);

      return matchesDamagedFilter && matchesCat && matchesSearch;
    });

  // Summary metrics
  const displayProducts = (filterCategory !== 'ALL' || localSearch.trim()) ? visibleProducts : productsWithDamaged;

  const damagedPagination = useClientPagination(visibleProducts, 20, [filterCategory, localSearch]);
  const grandTotalDamagedUnits = displayProducts.reduce((sum, item) => sum + item.totalDamagedQty, 0);
  const grandTotalLossValuation = displayProducts.reduce((sum, item) => sum + item.totalLossValuation, 0);
  const affectedSKUsCount = displayProducts.filter((item) => item.totalDamagedQty > 0).length;

  const handleExportDamagedStockReport = () => {
    // Dynamic branch damaged qty columns
    const dynamicCols = activeBranches.flatMap((b) => [
      {
        key: `branch_damaged_${b.id}`,
        label: `${b.name} (Damaged Qty)`,
        formatter: (_: any, item: (typeof displayProducts)[0]) => {
          const bd = item.branchData.find((x) => x.branch.id === b.id);
          return bd ? bd.damagedQty : 0;
        },
      },
      {
        key: `branch_usable_${b.id}`,
        label: `${b.name} (Usable Stock)`,
        formatter: (_: any, item: (typeof displayProducts)[0]) => {
          const bd = item.branchData.find((x) => x.branch.id === b.id);
          return bd ? bd.usableQty : 0;
        },
      },
    ]);

    const columns = [
      { key: 'sku', label: 'SKU Code', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.sku },
      { key: 'barcode', label: 'Barcode', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.barcode },
      { key: 'name', label: 'Product Name', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.name },
      { key: 'category', label: 'Category', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.category },
      { key: 'unit', label: 'Unit', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.unit },
      { key: 'costPrice', label: 'Unit Cost Price (NPR)', formatter: (_: any, item: (typeof displayProducts)[0]) => item.prod.costPrice || 0 },
      { key: 'totalUsableQty', label: 'Total Usable Stock', formatter: (_: any, item: (typeof displayProducts)[0]) => item.totalUsableQty },
      { key: 'totalDamagedQty', label: 'Total Damaged Qty', formatter: (_: any, item: (typeof displayProducts)[0]) => item.totalDamagedQty },
      { key: 'totalLossValuation', label: 'Total Loss Valuation (NPR)', formatter: (_: any, item: (typeof displayProducts)[0]) => item.totalLossValuation },
      {
        key: 'quarantineStatus',
        label: 'Loss Risk Status',
        formatter: (_: any, item: (typeof displayProducts)[0]) => (item.totalDamagedQty > 0 ? 'QUARANTINE / LOSS WRITE-OFF NEEDED' : 'NORMAL (NO DAMAGE)'),
      },
      ...dynamicCols,
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Damaged_Stock_Matrix_Report',
      reportTitle: 'Damaged Stock Matrix & Financial Loss Valuation Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: displayProducts,
      columns,
    });
  };

  // Permission checks
  const canDispose = canUserDisposeDamagedStock(currentUser);
  const canAdjustDamageCount = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';

  const openDamagedStockEdit = (s: InventoryStock, p: Product, b: Branch) => {
    if (!canAdjustDamageCount) {
      alert('Permission Denied: Only Stock Manager / Super Admin can adjust damaged stock count in Damage Stock Matrix.');
      return;
    }
    setEditingStock({ stockItem: s, product: p, branch: b });
    setNewDamagedQty(s.damagedQty || 0);
    setReason('Damaged Stock Balance Adjustment');
  };

  const openDisposalModal = (s: InventoryStock, p: Product, b: Branch) => {
    if (!canDispose) {
      alert('Permission Denied: Stock disposal and financial write-off operations are restricted to Inventory Manager and Super Admin users.');
      return;
    }
    const maxQty = s.damagedQty || 1;
    setDisposalStock({ stockItem: s, product: p, branch: b });
    setDisposalQty(Math.min(maxQty, 1));
    setDisposalMethod('SCRAP_DESTRUCTION');
    setSalvageRecoveryAmount(0);
    setGlAccountCode('GL-5120 (Loss on Inventory Scrap & Write-off)');
    setDisposalNotes('Physical scrap destruction certificate approved by Inventory Quality Auditor');
  };

  const handleDamagedSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!editingStock || !onUpdateStockLevel) return;

    const oldDam = editingStock.stockItem.damagedQty || 0;
    const damDiff = newDamagedQty - oldDam;
    const currentUsable = editingStock.stockItem.quantityOnHand;
    const calculatedNewUsable = Math.max(0, currentUsable - damDiff);

    await onUpdateStockLevel(
      editingStock.stockItem.id,
      calculatedNewUsable,
      `Damaged Stock adjusted from ${oldDam} to ${newDamagedQty}: ${reason}`,
      newDamagedQty,
      'DAMAGE'
    );
    setEditingStock(null);
  };

  const handleDisposalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!disposalStock) return;
    if (!canDispose) {
      alert('Permission Denied: Stock disposal and financial write-off operations are restricted to Inventory Manager and Super Admin users.');
      return;
    }

    setIsSubmittingDisposal(true);
    try {
      const grossCost = disposalQty * disposalStock.product.costPrice;
      const salvageVal = Math.min(grossCost, Math.max(0, Number(salvageRecoveryAmount) || 0));
      const netLoss = Math.max(0, grossCost - salvageVal);

      // Date integrity: keep the AD date as the canonical value and derive the
      // BS date from the seeded calendar (never a hardcoded literal).
      const disposalDateAD = new Date().toISOString().split('T')[0];
      const disposalBS = tryConvertADToBS(disposalDateAD);

      const opData: Partial<StockOperation> = {
        type: 'DISPOSAL',
        branchId: disposalStock.branch.id,
        branchName: disposalStock.branch.name,
        productId: disposalStock.product.id,
        productName: disposalStock.product.name,
        quantityChanged: -disposalQty,
        costPerUnit: disposalStock.product.costPrice,
        totalValue: grossCost,
        disposalMethod,
        salvageRecoveryAmount: salvageVal,
        netWriteOffLoss: netLoss,
        glAccountCode,
        reason: `[${disposalMethod}] ${disposalNotes} (Gross: ${formatNPR(grossCost ?? 0)}, Salvage: ${formatNPR(salvageVal ?? 0)}, Net Loss: ${formatNPR(netLoss ?? 0)})`,
        inspectorName: currentUser?.name || 'Inventory Quality Auditor',
        dateAD: disposalDateAD,
        dateBS: disposalBS?.formattedBSShort || '',
        fiscalYear: getNepaliFiscalYear(disposalDateAD),
        status: 'LOGGED',
      };

      if (onCreateOperation) {
        await onCreateOperation(opData);
      } else {
        await api.createStockOperation(opData);
      }

      setDisposalStock(null);
    } catch (err) {
      console.error('Failed to execute disposal write-off', err);
      alert('Failed to process stock disposal write-off. Please check inputs.');
    } finally {
      setIsSubmittingDisposal(false);
    }
  };

  // Find first available damaged stock item to dispose if clicking top header button
  const handleTopDisposalClick = () => {
    if (!canDispose) {
      alert('Permission Denied: Stock disposal and financial write-off operations are restricted to Inventory Manager and Super Admin users.');
      return;
    }
    for (const prodItem of visibleProducts) {
      if (prodItem.totalDamagedQty > 0) {
        for (const b of activeBranches) {
          const s = stock.find((st) => st.productId === prodItem.prod.id && st.branchId === b.id);
          if (s && s.damagedQty && s.damagedQty > 0) {
            openDisposalModal(s, prodItem.prod, b);
            return;
          }
        }
      }
    }
    alert('No damaged stock items currently available in visible filter to dispose.');
  };

  return (
    <div className="space-y-3">
      {/* BS Calendar Gate Banner: blocks stock operations until today's BS date record exists */}
      {bsDateStatus === 'missing' && (
        <div className={`p-3 rounded-2xl bg-red-500/10 border border-red-500/40 flex flex-col sm:flex-row sm:items-center justify-start gap-3 text-red-900 dark:text-red-200`}>
          <div className="flex items-start gap-3">
            <ShieldAlert className={`h-6 w-6 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5`} />
            <div>
              <p className="text-sm font-bold">
                BS date is not available. Please contact your system administrator for BS month seeding.
              </p>
              <p className="text-xs mt-1 opacity-90">
                Today ({bsDateCheckedFor}) has no Nepali (BS) date record in the BS calendar database (bs_day_records),
                so damaged stock adjustments and disposals are temporarily locked. Seed the missing BS month from
                <strong> System Settings &rarr; BS Calendar Utility</strong>, then re-check.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={checkBsDateAvailability}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-colors cursor-pointer flex-shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Re-check BS Date
          </button>
        </div>
      )}

      {/* Role Restriction Alert Banner if user cannot dispose */}
      {!canDispose && (
        <div className={`p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-3 text-xs font-medium text-amber-900 dark:text-amber-200`}>
          <div className="flex items-center gap-2.5">
            <ShieldAlert className={`h-5 w-5 text-amber-500 dark:text-amber-400 flex-shrink-0`} />
            <span>
              <strong>Permission Control Active:</strong> Stock disposal & financial write-off functions are restricted exclusively to <strong>Inventory Manager</strong> and <strong>Super Admin</strong> roles. You are logged in as <span className={`underline font-bold text-amber-700 dark:text-amber-300`}>{currentUser?.role || 'Guest'}</span>.
            </span>
          </div>
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-500/20 flex items-center gap-1 text-amber-700 dark:text-amber-300`}>
            <Lock className="h-3 w-3" />
            <span>Read-Only Audit Mode</span>
          </span>
        </div>
      )}

      {/* Header & Actions */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            <span>Damaged Stock Matrix & Branch Loss Tracking</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Consolidated breakdown of damaged stock units, write-off accounting, and physical disposal workflows.
          </p>
        </div>

        <div className="shrink-0 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportDamagedStockReport}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold border cursor-pointer shadow-xs transition-all text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-300 dark:text-emerald-300 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/80 dark:border-emerald-700/60`}
            title="Export full Damaged Stock Matrix & Financial Loss with uniform BS Date (YYYY-MM-DD)"
          >
            <Download className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
            <FileSpreadsheet className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
            <span>Export Damage CSV (BS Date)</span>
          </button>

          <button
            onClick={() => setShowWriteOffGuide(!showWriteOffGuide)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold border transition-all cursor-pointer bg-white text-slate-700 border-slate-200 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700`}
          >
            <HelpCircle className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
            <span>Corporate Write-Off Guide</span>
          </button>

          <button
            onClick={handleTopDisposalClick}
            title={canDispose ? "Dispose & Write-Off Damaged Stock" : "Restricted: Requires Inventory Manager or Super Admin role"}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-white shadow-md transition-all cursor-pointer ${
              canDispose
                ? 'bg-rose-600 hover:bg-rose-500'
                : 'bg-slate-500 dark:bg-slate-700 hover:bg-slate-600 opacity-80'
            }`}
          >
            <Flame className="h-4 w-4" />
            <span>Dispose & Write-Off Stock</span>
            {!canDispose && <Lock className="h-3 w-3 ml-0.5 text-amber-200" />}
          </button>

          {onNavigateTab && (
            <>
              <button
                onClick={() => onNavigateTab('damage')}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold border transition-all cursor-pointer bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60 dark:hover:bg-amber-900/60`}
              >
                <AlertOctagon className="h-4 w-4 text-amber-500" />
                <span>Tag Damaged Stock</span>
              </button>

              <button
                onClick={() => onNavigateTab('pullout')}
                className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
              >
                <Truck className="h-4 w-4" />
                <span>Dispatch Pullout HQ</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Corporate Write-Off Accounting Guide Banner */}
      {showWriteOffGuide && (
        <div className={`p-4 rounded-2xl border bg-indigo-50/70 border-indigo-200 text-slate-800 dark:bg-[#0f141f] dark:border-indigo-900/60 dark:text-slate-200`}>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2.5">
              <div className={`p-2 rounded-xl bg-indigo-600 dark:bg-indigo-500 text-white`}>
                <Scale className="h-5 w-5" />
              </div>
              <div>
                <h3 className={`font-bold text-sm text-indigo-950 dark:text-indigo-200`}>
                  How Enterprise Companies Handle Damaged Stock Disposal & Accounting Write-offs (GAAP / IFRS)
                </h3>
                <p className={`text-xs text-indigo-700 dark:text-indigo-300`}>
                  Standard Operating Procedures (SOP) for inventory impairment, write-offs, scrap recovery, and balance sheet adjustments.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowWriteOffGuide(false)}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-4 text-xs">
            <div className={`p-3.5 rounded-xl border bg-white border-indigo-100 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className={`font-bold mb-1 flex items-center gap-1.5 text-rose-600 dark:text-rose-400`}>
                <Trash2 className="h-3.5 w-3.5" />
                <span>1. Scrap & Physical Destruction</span>
              </div>
              <p className={`text-[11px] leading-relaxed text-slate-500 dark:text-slate-400`}>
                When goods are beyond repair or obsolete (e.g., shattered fiber optics, burnt ONUs), they are physically destroyed. 100% of book value is debited as an <strong>Inventory Write-off Loss Expense</strong> (GL-5120).
              </p>
            </div>

            <div className={`p-3.5 rounded-xl border bg-white border-indigo-100 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className={`font-bold mb-1 flex items-center gap-1.5 text-amber-600 dark:text-amber-400`}>
                <DollarSign className="h-3.5 w-3.5" />
                <span>2. Salvage / E-Waste Recovery</span>
              </div>
              <p className={`text-[11px] leading-relaxed text-slate-500 dark:text-slate-400`}>
                Damaged copper cable or electronic housings sold to certified recyclers. Cash/Bank is debited for salvage income, offsetting the gross inventory write-off loss on the P&L statement.
              </p>
            </div>

            <div className={`p-3.5 rounded-xl border bg-white border-indigo-100 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className={`font-bold mb-1 flex items-center gap-1.5 text-blue-600 dark:text-blue-400`}>
                <Receipt className="h-3.5 w-3.5" />
                <span>3. Vendor RMA / Credit Note</span>
              </div>
              <p className={`text-[11px] leading-relaxed text-slate-500 dark:text-slate-400`}>
                Factory defects returned to OEM/vendor under warranty. A <strong>Vendor Credit Note</strong> or replacement stock is issued, transferring liability from inventory asset to vendor accounts payable.
              </p>
            </div>

            <div className={`p-3.5 rounded-xl border bg-white border-indigo-100 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className={`font-bold mb-1 flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400`}>
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>4. Insurance Loss Claim</span>
              </div>
              <p className={`text-[11px] leading-relaxed text-slate-500 dark:text-slate-400`}>
                Transit or disaster damage filed with commercial insurers. Loss is booked into <strong>Insurance Claims Receivable</strong> (GL-1350) pending insurer claim approval and settlement payout.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* KPI Summary Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total Damaged Units</span>
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
              <AlertTriangle className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-amber-600 dark:text-amber-400`}>
            {(grandTotalDamagedUnits ?? 0).toLocaleString('en-IN')} Pcs
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">Across all filtered branch stores</p>
        </div>

        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total Damaged Valuation</span>
            <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-rose-600 dark:text-rose-400`}>
            {formatNPR(grandTotalLossValuation ?? 0)}
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">Estimated gross cost inventory impairment</p>
        </div>

        <div className={`p-4 rounded-2xl border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Affected Products</span>
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500">
              <Layers className="h-4 w-4" />
            </div>
          </div>
          <div className={`text-xl font-bold font-mono mt-1 text-indigo-600 dark:text-indigo-400`}>
            {affectedSKUsCount} SKUs
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">Items requiring quality action or disposal</p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-col md:flex-row md:items-center justify-start gap-3 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="flex flex-1 items-center gap-2">
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="Search product name, SKU..."
              className={`w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-white dark:placeholder-slate-500`}
            />
          </div>

          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={`px-3 py-1.5 text-xs rounded-xl border bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
          >
            <option value="ALL">All Categories ({categories.length})</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 cursor-pointer">
            <input
              type="checkbox"
              checked={showZeroDamaged}
              onChange={(e) => setShowZeroDamaged(e.target.checked)}
              className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
            />
            <span>Show SKUs with 0 Damaged</span>
          </label>
        </div>
      </div>

      {/* MATRIX TABLE */}
      <div className={`rounded-2xl border shadow-xs overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 border-b border-slate-200 dark:bg-slate-900/60 dark:text-slate-400 dark:border-b dark:border-slate-800">
                <th className="px-2.5 py-1.5 font-semibold">Product Name & Category</th>
                <th className="px-2.5 py-1.5 font-semibold">SKU / Barcode</th>
                <th className="px-2.5 py-1.5 font-semibold text-right">Unit Cost (NPR)</th>
                <th className="px-2.5 py-1.5 font-semibold text-center">Total Damaged</th>
                <th className="px-2.5 py-1.5 font-semibold text-right">Estimated Loss</th>
                {activeBranches.map((b) => (
                  <th key={b.id} className="px-2.5 py-1.5 font-semibold text-center border-l border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-center gap-1">
                      <Building2 className="h-3 w-3 text-indigo-500" />
                      <span>{b.name}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {visibleProducts.length === 0 ? (
                <tr>
                  <td colSpan={5 + activeBranches.length} className="p-8 text-center text-slate-400">
                    <CheckCircle2 className={`h-8 w-8 mx-auto mb-2 opacity-80 text-emerald-500 dark:text-emerald-400`} />
                    <div className="font-semibold text-sm">No Damaged Stock Found</div>
                    <div className="text-xs text-slate-500">All products in filtered selection are currently healthy with zero recorded damage.</div>
                  </td>
                </tr>
              ) : (
                damagedPagination.pagedItems.map(({ prod, totalDamagedQty, totalLossValuation }) => (
                  <tr
                    key={prod.id}
                    className={`hover:bg-slate-500/5 transition-colors ${totalDamagedQty > 0 ? 'bg-amber-50/30 dark:bg-amber-950/10' : ''}`}
                  >
                    <td className="p-2.5 font-medium">
                      <div className={`font-bold text-slate-900 dark:text-white`}>
                        {prod.name}
                      </div>
                      <div className="text-[11px] text-slate-400">{prod.category} • {prod.unit}</div>
                    </td>
                    <td className="p-2.5 font-mono text-slate-500">
                      <div>{prod.sku}</div>
                      <div className="text-[10px] text-slate-400">{prod.barcode}</div>
                    </td>
                    <td className={`p-2.5 text-right font-mono text-slate-600 dark:text-slate-300`}>
                      {formatNPR(prod.costPrice ?? 0)}
                    </td>
                    <td className="p-2.5 text-center">
                      {totalDamagedQty > 0 ? (
                        <span className={`inline-flex items-center gap-1 font-bold font-mono bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20 text-amber-600 dark:text-amber-400`}>
                          <AlertTriangle className="h-3 w-3" />
                          <span>{totalDamagedQty} {prod.unit}</span>
                        </span>
                      ) : (
                        <span className="text-slate-400 font-mono">0</span>
                      )}
                    </td>
                    <td className={`p-2.5 text-right font-mono font-bold text-rose-600 dark:text-rose-400`}>
                      {totalLossValuation > 0 ? formatNPR(totalLossValuation ?? 0) : '-'}
                    </td>

                    {/* Branch Cells */}
                    {activeBranches.map((b) => {
                      const s = stock.find(
                        (st) => st.productId === prod.id && st.branchId === b.id
                      ) || {
                        id: `stk-${prod.id}-${b.id}`,
                        productId: prod.id,
                        branchId: b.id,
                        quantityOnHand: 0,
                        damagedQty: 0,
                        reservedQty: 0,
                        incomingQty: 0,
                        lastUpdated: new Date().toISOString(),
                      };

                      const localDamaged = s.damagedQty || 0;

                      return (
                        <td
                          key={b.id}
                          className={`p-3 text-center border-l font-medium border-slate-200 dark:border-slate-800 ${localDamaged > 0 ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''}`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <div className="flex flex-col items-start">
                              {localDamaged > 0 ? (
                                <span className={`inline-flex items-center gap-1 text-xs font-bold font-mono text-amber-600 dark:text-amber-400`}>
                                  <AlertTriangle className="h-3 w-3" />
                                  <span>{localDamaged} {prod.unit} damaged</span>
                                </span>
                              ) : (
                                <span className="text-xs text-slate-400 font-mono">0 damaged</span>
                              )}
                              <span className="text-[10px] text-slate-400">
                                ({s.quantityOnHand} usable)
                              </span>
                            </div>

                            <div className="flex items-center gap-1">
                              {localDamaged > 0 && (
                                <button
                                  onClick={() => openDisposalModal(s, prod, b)}
                                  title={canDispose ? "Dispose & Write-Off Damaged Stock" : "Restricted: Requires Inventory Manager or Super Admin role"}
                                  className={`p-1 rounded transition-colors cursor-pointer ${
                                    canDispose
                                      ? 'text-rose-500 hover:text-white hover:bg-rose-600 dark:hover:bg-rose-600'
                                      : 'text-slate-400 hover:text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-950/80'
                                  }`}
                                >
                                  <Flame className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {canAdjustDamageCount && onUpdateStockLevel && (
                                <button
                                  onClick={() => openDamagedStockEdit(s, prod, b)}
                                  title="Adjust local damaged stock balance (Stock Manager)"
                                  className="p-1 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-950/80 transition-colors cursor-pointer"
                                >
                                  <Edit className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={damagedPagination.page}
          pageCount={damagedPagination.pageCount}
          totalItems={damagedPagination.totalItems}
          rangeStart={damagedPagination.rangeStart}
          rangeEnd={damagedPagination.rangeEnd}
          pageSize={damagedPagination.pageSize}
          onPageChange={damagedPagination.setPage}
          onPageSizeChange={damagedPagination.setPageSize}
          className="mt-1"
        />
      </div>

      {/* MODAL 1: EDIT LOCAL DAMAGED STOCK COUNT */}
      {editingStock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border p-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                  Adjust Damaged Stock Count
                </h3>
              </div>
              <button
                onClick={() => setEditingStock(null)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleDamagedSave} className="mt-4 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-500">Product Item</label>
                <div className={`font-bold text-sm text-slate-900 dark:text-white`}>
                  {editingStock.product.name}
                </div>
                <div className={`text-xs font-mono text-indigo-500 dark:text-indigo-400`}>
                  SKU: {editingStock.product.sku} • Location: {editingStock.branch.name}
                </div>
              </div>

              {/* Stock Conservation Preview Box */}
              <div className={`p-3 rounded-xl border space-y-1.5 text-xs font-mono bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                <div className="flex justify-between text-slate-500">
                  <span>Current Usable Stock:</span>
                  <span className={`font-bold text-slate-800 dark:text-slate-200`}>{editingStock.stockItem.quantityOnHand} {editingStock.product.unit}</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Current Damaged Stock:</span>
                  <span className={`font-bold text-amber-600 dark:text-amber-400`}>{editingStock.stockItem.damagedQty || 0} {editingStock.product.unit}</span>
                </div>
                <div className="border-t border-slate-200 dark:border-slate-800 my-1 pt-1 flex justify-between font-bold">
                  <span className="text-indigo-600 dark:text-indigo-400">Calculated New Usable Stock:</span>
                  <span className="text-emerald-600 dark:text-emerald-400">
                    {Math.max(0, editingStock.stockItem.quantityOnHand - (newDamagedQty - (editingStock.stockItem.damagedQty || 0)))} {editingStock.product.unit}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">
                  Damaged Units Count ({editingStock.product.unit})
                </label>
                <input
                  type="number"
                  min="0"
                  value={newDamagedQty}
                  onChange={(e) => setNewDamagedQty(Math.max(0, Number(e.target.value)))}
                  className={`w-full rounded-xl border px-3 py-2 text-sm font-mono font-bold bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">
                  Reason for Adjustment
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g., Physical damage verification count"
                  className={`w-full rounded-xl border px-3 py-2 text-xs bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingStock(null)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-200 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-600 text-white hover:bg-amber-500 shadow-md transition-all cursor-pointer"
                >
                  Save Damaged Count
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: DAMAGED STOCK DISPOSAL & ACCOUNTING WRITE-OFF */}
      {disposalStock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className={`w-full max-w-xl rounded-2xl shadow-2xl border p-6 max-h-[90vh] overflow-y-auto bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className={`p-2 rounded-xl text-white shadow-xs bg-rose-600 dark:bg-rose-500`}>
                  <Flame className="h-5 w-5" />
                </div>
                <div>
                  <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                    Damaged Stock Disposal & Accounting Write-Off
                  </h3>
                  <p className="text-xs text-slate-400">
                    Permanently write off damaged stock from balance sheet & log disposal method
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDisposalStock(null)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleDisposalSubmit} className="mt-4 space-y-4">
              {/* Target Item Overview Card */}
              <div className={`p-3.5 rounded-xl border flex justify-between items-center text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
                <div>
                  <div className={`font-bold text-sm text-slate-900 dark:text-white`}>
                    {disposalStock.product.name}
                  </div>
                  <div className="text-slate-500 font-mono mt-0.5">
                    SKU: {disposalStock.product.sku} • Location: <strong className="text-indigo-600 dark:text-indigo-400">{disposalStock.branch.name}</strong>
                  </div>
                </div>
                <div className="text-right font-mono">
                  <div className={`text-right font-mono text-amber-600 dark:text-amber-400 font-bold`}>
                    {disposalStock.stockItem.damagedQty || 0} {disposalStock.product.unit} Available Damaged
                  </div>
                  <div className="text-slate-400 text-[11px]">
                    Cost: {formatNPR(disposalStock.product.costPrice ?? 0)} / unit
                  </div>
                </div>
              </div>

              {/* Disposal Quantity Input */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    Quantity to Dispose / Write-Off ({disposalStock.product.unit})
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={disposalStock.stockItem.damagedQty || 1}
                    value={disposalQty}
                    onChange={(e) => setDisposalQty(Math.min(disposalStock.stockItem.damagedQty || 1, Math.max(1, Number(e.target.value))))}
                    className={`w-full rounded-xl border px-3 py-2 text-sm font-mono font-bold bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    General Ledger Expense Account
                  </label>
                  <select
                    value={glAccountCode}
                    onChange={(e) => setGlAccountCode(e.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 text-xs font-mono bg-slate-50 border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
                  >
                    <option value="GL-5120 (Loss on Inventory Scrap & Write-off)">
                      GL-5120 - Loss on Inventory Scrap & Write-off
                    </option>
                    <option value="GL-5125 (Obsolete Inventory Expense)">
                      GL-5125 - Obsolete Inventory Expense
                    </option>
                    <option value="GL-1350 (Insurance Loss Claims Receivable)">
                      GL-1350 - Insurance Claims Receivable
                    </option>
                    <option value="GL-2100 (Vendor RMA Receivable / AP Clearing)">
                      GL-2100 - Vendor RMA AP Clearing
                    </option>
                  </select>
                </div>
              </div>

              {/* Disposal Method Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1.5">
                  Corporate Disposal Method & Accounting Category
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => { setDisposalMethod('SCRAP_DESTRUCTION'); setSalvageRecoveryAmount(0); }}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      disposalMethod === 'SCRAP_DESTRUCTION'
                        ? `border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500`
                        : (isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600')
                    }`}
                  >
                    <Trash2 className={`h-4 w-4 mb-1 text-rose-500 dark:text-rose-400`} />
                    <div className="font-bold text-xs">Scrap & Destroy</div>
                    <div className="text-[10px] opacity-80 mt-0.5">100% Expense Loss</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDisposalMethod('SALVAGE_EWASTE')}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      disposalMethod === 'SALVAGE_EWASTE'
                        ? `border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500`
                        : (isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600')
                    }`}
                  >
                    <DollarSign className={`h-4 w-4 mb-1 text-amber-500 dark:text-amber-400`} />
                    <div className="font-bold text-xs">Salvage / Scrap</div>
                    <div className="text-[10px] opacity-80 mt-0.5">Partial Income</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => { setDisposalMethod('VENDOR_RMA'); setSalvageRecoveryAmount(0); }}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      disposalMethod === 'VENDOR_RMA'
                        ? `border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500`
                        : (isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600')
                    }`}
                  >
                    <Receipt className={`h-4 w-4 mb-1 text-blue-500 dark:text-blue-400`} />
                    <div className="font-bold text-xs">Vendor RMA</div>
                    <div className="text-[10px] opacity-80 mt-0.5">Supplier Credit</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDisposalMethod('INSURANCE_CLAIM')}
                    className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                      disposalMethod === 'INSURANCE_CLAIM'
                        ? `border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500`
                        : (isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600')
                    }`}
                  >
                    <ShieldCheck className={`h-4 w-4 mb-1 text-emerald-500 dark:text-emerald-400`} />
                    <div className="font-bold text-xs">Insurance Claim</div>
                    <div className="text-[10px] opacity-80 mt-0.5">Loss Claim</div>
                  </button>
                </div>
              </div>

              {/* Salvage Recovery Field if Salvage or Insurance */}
              {(disposalMethod === 'SALVAGE_EWASTE' || disposalMethod === 'INSURANCE_CLAIM') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">
                    Salvage Revenue / Claim Recovery Amount (NPR)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={salvageRecoveryAmount}
                    onChange={(e) => setSalvageRecoveryAmount(Math.max(0, Number(e.target.value)))}
                    placeholder="Enter salvage sale revenue or expected insurance claim amount"
                    className={`w-full rounded-xl border px-3 py-2 text-sm font-mono font-bold bg-white border-slate-300 text-emerald-600 dark:bg-slate-900 dark:border-slate-700 dark:text-emerald-400`}
                  />
                </div>
              )}

              {/* Financial Write-Off Accounting Summary Card */}
              <div className="p-3.5 rounded-xl bg-slate-900 text-slate-200 border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between text-slate-400">
                  <span>Gross Inventory Cost Value ({disposalQty} × {formatNPR(disposalStock.product.costPrice ?? 0)}):</span>
                  <span className="font-bold text-slate-200">
                    {formatNPR(((disposalQty || 0) * (disposalStock.product.costPrice || 0)))}
                  </span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Salvage Recovery / Offsetting Income:</span>
                  <span className="font-bold text-emerald-400">
                    - {formatNPR(salvageRecoveryAmount || 0)}
                  </span>
                </div>
                <div className="border-t border-slate-800 pt-2 flex justify-between text-sm font-bold">
                  <span className="text-rose-400">Net Write-Off Loss Expense:</span>
                  <span className="text-rose-400">
                    {formatNPR(Math.max(0, (disposalQty * disposalStock.product.costPrice) - (salvageRecoveryAmount || 0)))}
                  </span>
                </div>
              </div>

              {/* Certificate / Audit Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">
                  Disposal Certificate / Audit Notes
                </label>
                <textarea
                  rows={2}
                  value={disposalNotes}
                  onChange={(e) => setDisposalNotes(e.target.value)}
                  placeholder="Record physical disposal details, destruction certificate number, or recycler invoice..."
                  className={`w-full rounded-xl border px-3 py-2 text-xs bg-slate-50 border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setDisposalStock(null)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-200 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingDisposal}
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-rose-600 text-white hover:bg-rose-500 shadow-md transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <Flame className="h-4 w-4" />
                  <span>{isSubmittingDisposal ? 'Executing Write-Off...' : 'Confirm Disposal & Write-Off'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
