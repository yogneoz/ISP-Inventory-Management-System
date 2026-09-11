import React, { useState, useMemo } from 'react';
import { Branch, InventoryStock, Product, CustomerDeviceRecord, User } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import { formatBSDate } from '../../utils/nepaliCalendar';
import {
  DownloadCloud,
  FileSpreadsheet,
  Download,
  Filter,
  Package,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Cpu,
  Search,
  Wifi,
  Copy,
  Check,
  AlertCircle,
  Clock,
  ShieldCheck,
  Tag,
  Layers,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface ExportStockProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  customerDevices?: CustomerDeviceRecord[];
  selectedBranchId?: string;
  dateMode?: 'BS' | 'AD';
}

export type ExportViewMode = 'SERIALIZED_DEVICES' | 'REORDER_LIST' | 'MASTER_STOCK' | 'BRANCH_MATRIX';

export const ExportStock: React.FC<ExportStockProps> = ({
  currentUser,
  products,
  branches,
  stock,
  customerDevices = [],
  selectedBranchId = 'ALL',
  dateMode = 'BS',
}) => {
  const [viewMode, setViewMode] = useState<ExportViewMode>('SERIALIZED_DEVICES');
  const [filterBranch, setFilterBranch] = useState<string>(selectedBranchId);
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [filterGroup, setFilterGroup] = useState<string>('ALL');
  const [filterProductModel, setFilterProductModel] = useState<string>('ALL');
  const [filterDeviceStatus, setFilterDeviceStatus] = useState<string>('IN_STOCK');
  const [filterReorderStatus, setFilterReorderStatus] = useState<'LOW_ONLY' | 'OUT_OF_STOCK' | 'ALL'>('LOW_ONLY');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedSerial, setCopiedSerial] = useState<string | null>(null);

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category))), [products]);
  const serializedProducts = useMemo(() => products.filter((p) => p.requiresSerialTracking), [products]);

  // Helper to get stock on hand for a product given the current branch scope
  const getProductStock = (prodId: string, branchScope = filterBranch) => {
    return stock
      .filter((s) => s.productId === prodId && (branchScope === 'ALL' || s.branchId === branchScope))
      .reduce((sum, item) => sum + (item.quantityOnHand || 0), 0);
  };

  // Serialized products with stock on hand (for display when no customer devices exist)
  const serializedProductsWithStock = useMemo(() => {
    return serializedProducts
      .map((p) => {
        const onHand = getProductStock(p.id);
        const branchStock = filterBranch === 'ALL'
          ? stock.filter((s) => s.productId === p.id && s.quantityOnHand > 0)
          : stock.filter((s) => s.productId === p.id && s.branchId === filterBranch && s.quantityOnHand > 0);
        return {
          product: p,
          onHand,
          branches: branchStock.map((s) => {
            const br = branches.find((b) => b.id === s.branchId);
            return { branchId: s.branchId, branchCode: br?.code, branchName: br?.name, qty: s.quantityOnHand };
          }),
        };
      })
      .filter((item) => item.onHand > 0);
  }, [serializedProducts, stock, filterBranch, branches]);

  // Branch display label
  const currentBranchName = useMemo(() => {
    if (filterBranch === 'ALL') return 'All Branches (Consolidated)';
    const br = branches.find((b) => b.id === filterBranch);
    return br ? `${br.name} (${br.code})` : `Branch ID: ${filterBranch}`;
  }, [filterBranch, branches]);

  const currentUserName = currentUser?.name
    ? `${currentUser.name} (${currentUser.role})`
    : currentUser?.email || 'System Inventory Admin';

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSerial(text);
    setTimeout(() => setCopiedSerial(null), 2000);
  };

  // -------------------------------------------------------------
  // 1. SERIALIZED DEVICES FILTERING
  // -------------------------------------------------------------
  const filteredSerializedDevices = useMemo(() => {
    return customerDevices.filter((dev) => {
      // Branch filter
      if (filterBranch !== 'ALL' && dev.branchId !== filterBranch) return false;

      // Status filter
      if (filterDeviceStatus !== 'ALL') {
        if (filterDeviceStatus === 'IN_STOCK' && dev.status !== 'IN_STOCK') return false;
        if (filterDeviceStatus === 'ASSIGNED' && (dev.status === 'IN_STOCK' || dev.status === 'RETURNED' || dev.status === 'DISCONNECTED')) return false;
        if (filterDeviceStatus === 'RENTAL' && dev.status !== 'RENTAL') return false;
        if (filterDeviceStatus === 'COLLECTED' && dev.status !== 'ROUTER_COLLECTED' && dev.status !== 'RETURNED') return false;
      }

      // Product / Model filter
      if (filterProductModel !== 'ALL' && dev.productName !== filterProductModel) return false;

      // Search Query
      if (searchQuery.trim()) {
        const q = (searchQuery || '').toLowerCase().trim();
        const branchObj = branches.find((b) => b.id === dev.branchId);
        const branchName = branchObj?.name.toLowerCase() || '';
        const branchCode = branchObj?.code.toLowerCase() || '';

        const matchSN = dev.deviceSerial?.toLowerCase().includes(q);
        const matchPON = dev.ponSerial?.toLowerCase().includes(q);
        const matchMAC = dev.macAddress?.toLowerCase().includes(q);
        const matchProd = dev.productName?.toLowerCase().includes(q);
        const matchCust = dev.customerName?.toLowerCase().includes(q) || dev.customerCode?.toLowerCase().includes(q);
        const matchBr = branchName.includes(q) || branchCode.includes(q);

        if (!matchSN && !matchPON && !matchMAC && !matchProd && !matchCust && !matchBr) {
          return false;
        }
      }

      return true;
    });
  }, [customerDevices, filterBranch, filterDeviceStatus, filterProductModel, searchQuery, branches]);

  // -------------------------------------------------------------
  // 2. CONSOLIDATED & PER-BRANCH REORDER LEVEL COMPUTATION
  // -------------------------------------------------------------
  const reorderStockData = useMemo(() => {
    return products.map((prod) => {
      const isConsolidated = filterBranch === 'ALL';

      let onHand = 0;
      let reorderThreshold = 0;
      let deficit = 0;
      let lowBranchesCount = 0;

      if (isConsolidated) {
        // Consolidated View across all branches
        branches.forEach((b) => {
          const item = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
          const bOnHand = item ? item.quantityOnHand || 0 : 0;
          onHand += bOnHand;

          // Resolve branch specific threshold or product default
          const bThreshold = (item && item.minReorderLevel !== undefined && item.minReorderLevel !== null)
            ? item.minReorderLevel
            : (prod.minReorderLevel || 0);

          reorderThreshold += bThreshold;

          if (bThreshold > 0 && bOnHand <= bThreshold) {
            lowBranchesCount++;
            deficit += Math.max(1, bThreshold - bOnHand);
          } else if (bThreshold === 0 && bOnHand < 0) {
            lowBranchesCount++;
            deficit += Math.abs(bOnHand);
          }
        });

        // If deficit was 0 from branch summation but overall onHand is below total threshold
        if (deficit === 0 && onHand < reorderThreshold) {
          deficit = Math.max(0, reorderThreshold - onHand);
        }
      } else {
        // Single Branch View
        const item = stock.find((s) => s.productId === prod.id && s.branchId === filterBranch);
        onHand = item ? item.quantityOnHand || 0 : 0;
        reorderThreshold = (item && item.minReorderLevel !== undefined && item.minReorderLevel !== null)
          ? item.minReorderLevel
          : (prod.minReorderLevel || 0);

        if (reorderThreshold > 0 && onHand <= reorderThreshold) {
          lowBranchesCount = 1;
          deficit = Math.max(1, reorderThreshold - onHand);
        } else if (reorderThreshold === 0 && onHand < 0) {
          lowBranchesCount = 1;
          deficit = Math.abs(onHand);
        }
      }

      const isOutOfStock = onHand <= 0;
      const isBelowReorder = isConsolidated
        ? onHand <= reorderThreshold || lowBranchesCount > 0
        : onHand <= reorderThreshold;

      // Suggested reorder adds safety buffer (20% of threshold or min 2 units per low branch)
      const buffer = Math.max(2 * Math.max(1, lowBranchesCount), Math.ceil(reorderThreshold * 0.2));
      const suggestedReorderQty = isBelowReorder ? deficit + buffer : 0;
      const deficitCost = deficit * (prod.costPrice || 0);
      const estimatedReorderBudget = suggestedReorderQty * (prod.costPrice || 0);

      let statusLabel: 'CRITICAL_OUT_OF_STOCK' | 'LOW_STOCK' | 'HEALTHY' = 'HEALTHY';
      if (isOutOfStock) {
        statusLabel = 'CRITICAL_OUT_OF_STOCK';
      } else if (isBelowReorder) {
        statusLabel = 'LOW_STOCK';
      }

      return {
        product: prod,
        onHand,
        reorderThreshold,
        isConsolidated,
        lowBranchesCount,
        totalBranchesCount: branches.length,
        isOutOfStock,
        isBelowReorder,
        deficit,
        suggestedReorderQty,
        deficitCost,
        estimatedReorderBudget,
        statusLabel,
      };
    });
  }, [products, stock, branches, filterBranch]);

  const filteredReorderItems = useMemo(() => {
    return reorderStockData.filter((item) => {
      const prod = item.product;
      const matchesCat = filterCategory === 'ALL' || prod.category === filterCategory;
      const matchesGrp = filterGroup === 'ALL' || (prod.productGroup || 'Product Item') === filterGroup;

      if (filterReorderStatus === 'LOW_ONLY' && !item.isBelowReorder) return false;
      if (filterReorderStatus === 'OUT_OF_STOCK' && !item.isOutOfStock) return false;

      if (searchQuery.trim()) {
        const q = (searchQuery || '').toLowerCase().trim();
        const matchName = (prod?.name || '').toLowerCase().includes(q);
        const matchSku = (prod?.sku || '').toLowerCase().includes(q);
        const matchBarcode = prod.barcode?.toLowerCase().includes(q);
        const matchCat = (prod?.category || '').toLowerCase().includes(q);
        if (!matchName && !matchSku && !matchBarcode && !matchCat) return false;
      }

      return matchesCat && matchesGrp;
    });
  }, [reorderStockData, filterCategory, filterGroup, filterReorderStatus, searchQuery]);

  const totalLowStockCount = useMemo(
    () => reorderStockData.filter((i) => i.isBelowReorder).length,
    [reorderStockData]
  );

  // -------------------------------------------------------------
  // 3. PRODUCT MASTER LIST FILTERING
  // -------------------------------------------------------------
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesCat = filterCategory === 'ALL' || p.category === filterCategory;
      const matchesGrp = filterGroup === 'ALL' || (p.productGroup || 'Product Item') === filterGroup;
      if (searchQuery.trim()) {
        const q = (searchQuery || '').toLowerCase().trim();
        const matchName = (p?.name || '').toLowerCase().includes(q);
        const matchSku = (p?.sku || '').toLowerCase().includes(q);
        const matchCat = (p?.category || '').toLowerCase().includes(q);
        if (!matchName && !matchSku && !matchCat) return false;
      }
      return matchesCat && matchesGrp;
    });
  }, [products, filterCategory, filterGroup, searchQuery]);

  const devicesPagination = useClientPagination(filteredSerializedDevices, 20, [
    filterBranch,
    filterDeviceStatus,
    filterProductModel,
    searchQuery,
  ]);
  const reorderListPagination = useClientPagination(filteredReorderItems, 20, [
    filterBranch,
    filterCategory,
    filterGroup,
    filterReorderStatus,
    searchQuery,
  ]);
  const productsPagination = useClientPagination(filteredProducts, 20, [
    filterCategory,
    filterGroup,
    searchQuery,
  ]);

  // -------------------------------------------------------------
  // EXPORT ACTION HANDLERS
  // -------------------------------------------------------------

  // 1. Export Serialized Devices
  const handleExportSerializedDevices = () => {
    const columns = [
      {
        key: 'branchCode',
        label: 'Branch Code',
        formatter: (_: any, row: CustomerDeviceRecord) => branches.find((b) => b.id === row.branchId)?.code || row.branchId,
      },
      {
        key: 'branchName',
        label: 'Branch Location',
        formatter: (_: any, row: CustomerDeviceRecord) => branches.find((b) => b.id === row.branchId)?.name || row.branchId,
      },
      { key: 'productName', label: 'Product / Model Name' },
      {
        key: 'sku',
        label: 'Product SKU',
        formatter: (_: any, row: CustomerDeviceRecord) => {
          const prod = products.find((p) => (p?.name || '').toLowerCase() === (row?.productName || '').toLowerCase());
          return prod?.sku || '-';
        },
      },
      {
        key: 'category',
        label: 'Category',
        formatter: (_: any, row: CustomerDeviceRecord) => {
          const prod = products.find((p) => (p?.name || '').toLowerCase() === (row?.productName || '').toLowerCase());
          return prod?.category || 'CPE Hardware';
        },
      },
      { key: 'deviceSerial', label: 'Device Serial Number' },
      { key: 'ponSerial', label: 'PON Serial Number' },
      { key: 'macAddress', label: 'MAC Address', formatter: (val: string) => val || 'N/A' },
      {
        key: 'status',
        label: 'Stock Status',
        formatter: (val: string) => (val === 'IN_STOCK' ? 'AVAILABLE (IN STORE)' : val),
      },
      {
        key: 'unitCost',
        label: 'Unit Cost Price (NPR)',
        formatter: (_: any, row: CustomerDeviceRecord) => {
          const prod = products.find((p) => (p?.name || '').toLowerCase() === (row?.productName || '').toLowerCase());
          return prod ? prod.costPrice : 1850;
        },
      },
      {
        key: 'issuedDateBS',
        label: 'Registered Date (BS)',
        formatter: (_: any, row: CustomerDeviceRecord) => formatBSDate(row.issuedDateAD || row.issuedDateBS),
      },
      { key: 'issuedDateAD', label: 'Registered Date (AD)' },
      { key: 'customerName', label: 'Assigned To / Storage Bin' },
      { key: 'installationAddress', label: 'Storage / Installation Address' },
      { key: 'purchaseBillRef', label: 'Batch / Bill Ref', formatter: (val: string) => val || '-' },
      { key: 'notes', label: 'Notes / Remarks', formatter: (val: string) => val || '-' },
    ];

    exportToCSV({
      filename: `Available_Serialized_Devices_SN_PON_MAC_${filterBranch}`,
      reportTitle: `Available Serialized Devices & Hardware Inventory Report (${filterDeviceStatus})`,
      branchName: currentBranchName,
      generatedBy: currentUserName,
      data: filteredSerializedDevices,
      columns,
    });
  };

  // 2. Export Reorder Level & Deficit List (Consolidated & Branch Aware)
  const handleExportReorderList = () => {
    const columns = [
      {
        key: 'branchScope',
        label: 'Branch Scope',
        formatter: () => currentBranchName,
      },
      {
        key: 'sku',
        label: 'SKU',
        formatter: (_: any, row: any) => row.product.sku,
      },
      {
        key: 'barcode',
        label: 'Barcode',
        formatter: (_: any, row: any) => row.product.barcode || '-',
      },
      {
        key: 'name',
        label: 'Product Name',
        formatter: (_: any, row: any) => row.product.name,
      },
      {
        key: 'group',
        label: 'Product Group',
        formatter: (_: any, row: any) => row.product.productGroup || 'Product Item',
      },
      {
        key: 'category',
        label: 'Category',
        formatter: (_: any, row: any) => row.product.category,
      },
      {
        key: 'unit',
        label: 'UoM',
        formatter: (_: any, row: any) => row.product.unit,
      },
      {
        key: 'onHand',
        label: 'Current On-Hand Stock',
        formatter: (_: any, row: any) => row.onHand,
      },
      {
        key: 'reorderThreshold',
        label: filterBranch === 'ALL' ? 'Consolidated Reorder Level (All Branches)' : 'Branch Min Reorder Level',
        formatter: (_: any, row: any) => row.reorderThreshold,
      },
      {
        key: 'lowBranches',
        label: 'Low Branches Count',
        formatter: (_: any, row: any) =>
          row.isConsolidated ? `${row.lowBranchesCount} of ${row.totalBranchesCount} Branches` : row.lowBranchesCount > 0 ? 'LOW' : 'OK',
      },
      {
        key: 'deficit',
        label: 'Deficit Quantity (Shortfall)',
        formatter: (_: any, row: any) => row.deficit,
      },
      {
        key: 'suggestedReorderQty',
        label: 'Recommended Reorder Quantity',
        formatter: (_: any, row: any) => row.suggestedReorderQty,
      },
      {
        key: 'stockStatus',
        label: 'Stock Health Status',
        formatter: (_: any, row: any) => {
          if (row.isOutOfStock) return 'CRITICAL OUT OF STOCK';
          if (row.isBelowReorder) return 'LOW STOCK (REORDER NEEDED)';
          return 'HEALTHY STOCK';
        },
      },
      {
        key: 'costPrice',
        label: 'Unit Cost Price (NPR)',
        formatter: (_: any, row: any) => row.product.costPrice || 0,
      },
      {
        key: 'deficitCost',
        label: 'Deficit Valuation (NPR)',
        formatter: (_: any, row: any) => row.deficitCost,
      },
      {
        key: 'estimatedReorderBudget',
        label: 'Estimated Reorder Budget (NPR)',
        formatter: (_: any, row: any) => row.estimatedReorderBudget,
      },
      {
        key: 'serialized',
        label: 'Requires Serial Tracking',
        formatter: (_: any, row: any) => (row.product.requiresSerialTracking ? 'YES' : 'NO'),
      },
    ];

    exportToCSV({
      filename: `Reorder_Level_Low_Stock_Report_${filterBranch}`,
      reportTitle: `Low Stock Deficit & Procurement Reorder Priority Report (${filterReorderStatus})`,
      branchName: currentBranchName,
      generatedBy: currentUserName,
      data: filteredReorderItems,
      columns,
    });
  };

  // 3. Export Master Stock Matrix
  const handleExportStockMatrix = () => {
    const columns = [
      { key: 'sku', label: 'SKU' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'name', label: 'Product Name' },
      { key: 'productGroup', label: 'Product Group', formatter: (val: string) => val || 'Product Item' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'UoM' },
      { key: 'costPrice', label: 'Cost Price (NPR)' },
      { key: 'sellingPrice', label: 'Selling Price (NPR)' },
      { key: 'taxRate', label: 'VAT %' },
      {
        key: 'stockOnHand',
        label: 'Current On-Hand Stock',
        formatter: (_: any, row: Product) => getProductStock(row.id),
      },
      { key: 'minReorderLevel', label: 'Reorder Threshold' },
      {
        key: 'costValuation',
        label: 'Stock Cost Valuation (NPR)',
        formatter: (_: any, row: Product) => getProductStock(row.id) * (row.costPrice || 0),
      },
      {
        key: 'sellingValuation',
        label: 'Stock Selling Valuation (NPR)',
        formatter: (_: any, row: Product) => getProductStock(row.id) * (row.sellingPrice || 0),
      },
      {
        key: 'requiresSerialTracking',
        label: 'Serial/PON/MAC Tracking',
        formatter: (val: boolean) => (val ? 'YES (Serialized)' : 'NO'),
      },
    ];

    exportToCSV({
      filename: `Master_Stock_Matrix_${filterBranch}`,
      reportTitle: 'Master Inventory Catalog & Stock Balances Matrix',
      branchName: currentBranchName,
      generatedBy: currentUserName,
      data: filteredProducts,
      columns,
    });
  };

  // 4. Export Branch Breakdown Matrix
  const handleExportBranchBreakdown = () => {
    const branchColumns = branches.map((b) => ({
      key: `branch_${b.id}`,
      label: `${b.code} (${b.name})`,
      formatter: (_: any, row: Product) => {
        const item = stock.find((s) => s.productId === row.id && s.branchId === b.id);
        return item ? item.quantityOnHand : 0;
      },
    }));

    const columns = [
      { key: 'sku', label: 'SKU' },
      { key: 'name', label: 'Product Name' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'UoM' },
      ...branchColumns,
      {
        key: 'totalStockOnHand',
        label: 'Total Stock All Branches',
        formatter: (_: any, row: Product) => {
          return stock
            .filter((s) => s.productId === row.id)
            .reduce((sum, item) => sum + (item.quantityOnHand || 0), 0);
        },
      },
    ];

    exportToCSV({
      filename: 'Branch_Stock_Distribution_Matrix',
      reportTitle: 'Multi-Branch Inventory Stock Distribution Matrix',
      branchName: 'All Branches (Consolidated Matrix)',
      generatedBy: currentUserName,
      data: filteredProducts,
      columns,
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-2.5">
      {/* 1. Header Row (Clean, dedicated title & summary) */}
      <div className="flex-none flex flex-col md:flex-row md:items-center justify-between gap-2 pb-1 border-b border-slate-200 dark:border-slate-800">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <DownloadCloud className="h-5 w-5 text-indigo-500" />
            <span>Export Stock Data & Serialized Reports</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Audit-ready CSV exports for Serialized Hardware (SN/PON/MAC), Consolidated Reorder Levels, Master Stock Matrix, and Branch Breakdown.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold border flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300`}>
            <Building2 className="h-3.5 w-3.5 text-indigo-500" />
            <span>Scope: {currentBranchName}</span>
          </span>
        </div>
      </div>

      {/* 2. All Tabs Navigation Bar (Positioned directly above the Filter Card) */}
      <div className="flex-none">
        <div className={`p-1.5 rounded-2xl border flex items-center gap-1.5 overflow-x-auto shadow-xs bg-slate-100/90 border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <button
            onClick={() => setViewMode('SERIALIZED_DEVICES')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${viewMode === 'SERIALIZED_DEVICES' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/60'}`}
          >
            <Cpu className="h-4 w-4" />
            <span>Serialized Devices (SN / PON / MAC)</span>
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${viewMode === 'SERIALIZED_DEVICES' ? 'bg-white/20 text-white' : 'bg-indigo-500/15 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400'}`}>
              {filteredSerializedDevices.length + serializedProductsWithStock.length}
            </span>
          </button>

          <button
            onClick={() => setViewMode('REORDER_LIST')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${viewMode === 'REORDER_LIST' ? 'bg-rose-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/60'}`}
          >
            <AlertTriangle className="h-4 w-4" />
            <span>Reorder Level & Low Stock</span>
            {totalLowStockCount > 0 ? (
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold ${
                viewMode === 'REORDER_LIST' ? 'bg-white/30 text-white' : 'bg-rose-500/20 text-rose-500'
              }`}>
                {totalLowStockCount} items
              </span>
            ) : (
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-emerald-500/20 text-emerald-600 dark:text-emerald-400`}>
                Healthy
              </span>
            )}
          </button>

          <button
            onClick={() => setViewMode('MASTER_STOCK')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${viewMode === 'MASTER_STOCK' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/60'}`}
          >
            <Package className="h-4 w-4" />
            <span>All Stock Matrix</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
              {products.length} SKUs
            </span>
          </button>

          <button
            onClick={() => setViewMode('BRANCH_MATRIX')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap ${viewMode === 'BRANCH_MATRIX' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/70 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800/60'}`}
          >
            <Building2 className="h-4 w-4" />
            <span>Branch Breakdown Matrix</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
              {branches.length} Branches
            </span>
          </button>
        </div>
      </div>

      {/* 3. Interactive Filters Bar & Primary Action Card */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-wrap items-center justify-between gap-3 flex-none bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5 text-slate-400 text-xs font-semibold">
            <Filter className="h-4 w-4 text-indigo-500" />
            <span>Filter:</span>
          </div>

          {/* Branch Filter */}
          <select
            value={filterBranch}
            onChange={(e) => setFilterBranch(e.target.value)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
          >
            <option value="ALL">All Branches (Consolidated Matrix)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>

          {/* View-Specific Filters */}
          {viewMode === 'SERIALIZED_DEVICES' && (
            <>
              {/* Device Status Filter */}
              <select
                value={filterDeviceStatus}
                onChange={(e) => setFilterDeviceStatus(e.target.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-semibold focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
              >
                <option value="IN_STOCK">Status: Available In-Store Only</option>
                <option value="ASSIGNED">Status: Assigned / Active Customer CPE</option>
                <option value="RENTAL">Status: Rental CPE Only</option>
                <option value="COLLECTED">Status: Collected / Returned</option>
                <option value="ALL">Status: All (In-Stock & Assigned)</option>
              </select>

              {/* Product Model Filter */}
              <select
                value={filterProductModel}
                onChange={(e) => setFilterProductModel(e.target.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
              >
                <option value="ALL">All Serialized Models</option>
                {serializedProducts.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </>
          )}

          {viewMode === 'REORDER_LIST' && (
            <>
              {/* Reorder Status Filter */}
              <select
                value={filterReorderStatus}
                onChange={(e) => setFilterReorderStatus(e.target.value as any)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-bold focus:outline-none focus:border-rose-500 cursor-pointer bg-rose-50 border-rose-200 text-rose-700 dark:bg-slate-900 dark:border-slate-800 dark:text-rose-400`}
              >
                <option value="LOW_ONLY">Filter: Below Reorder Threshold Only ({totalLowStockCount} items)</option>
                <option value="OUT_OF_STOCK">Filter: Critical Out of Stock Only (0 Qty)</option>
                <option value="ALL">Filter: All Catalog Items with Reorder Levels</option>
              </select>

              {/* Category Filter */}
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
              >
                <option value="ALL">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </>
          )}

          {(viewMode === 'MASTER_STOCK' || viewMode === 'BRANCH_MATRIX') && (
            <>
              {/* Product Group Filter */}
              <select
                value={filterGroup}
                onChange={(e) => setFilterGroup(e.target.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
              >
                <option value="ALL">All Groups</option>
                <option value="Product Item">Product Item (Equipment/Resale)</option>
                <option value="Consumable Item">Consumable Item (Splitters/Sleeves)</option>
                <option value="Fixed Asset">Fixed Asset (Capital Assets)</option>
              </select>

              {/* Category Filter */}
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
              >
                <option value="ALL">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </>
          )}

          {/* Search Box */}
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder={
                viewMode === 'SERIALIZED_DEVICES'
                  ? 'Search Serial, PON, MAC, Model, Branch...'
                  : 'Search SKU, Product Name, Category...'
              }
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`pl-8 pr-3 py-1.5 text-xs rounded-xl border focus:outline-none focus:border-indigo-500 w-44 sm:w-60 bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:placeholder-slate-500`}
            />
          </div>
        </div>

        {/* Primary Export Button */}
        <div className="flex items-center gap-2">
          {viewMode === 'SERIALIZED_DEVICES' && (
            <button
              onClick={handleExportSerializedDevices}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-300" />
              <span>Export Serialized Stock CSV ({filteredSerializedDevices.length} Pcs)</span>
            </button>
          )}

          {viewMode === 'REORDER_LIST' && (
            <button
              onClick={handleExportReorderList}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-2 shadow-md shadow-rose-900/20 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-white" />
              <span>Export Reorder Level List CSV ({filteredReorderItems.length} Items)</span>
            </button>
          )}

          {viewMode === 'MASTER_STOCK' && (
            <button
              onClick={handleExportStockMatrix}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-300" />
              <span>Export Master Stock Matrix CSV ({filteredProducts.length} SKUs)</span>
            </button>
          )}

          {viewMode === 'BRANCH_MATRIX' && (
            <button
              onClick={handleExportBranchBreakdown}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-300" />
              <span>Export Branch Breakdown CSV</span>
            </button>
          )}
        </div>
      </div>

      {/* 4. Main Full-Height Table Container */}
      <div className={`flex-1 min-h-0 flex flex-col rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        {/* Table Header Context Bar */}
        <div className={`px-4 py-2 border-b flex items-center justify-between text-xs font-semibold flex-none bg-slate-50 border-slate-200 text-slate-700 dark:bg-[#12161f] dark:border-slate-800 dark:text-slate-300`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${viewMode === 'REORDER_LIST' ? 'bg-rose-500' : 'bg-emerald-500'} animate-pulse`}></span>
            <span>
              {viewMode === 'SERIALIZED_DEVICES'
                ? `Serialized Devices Registry: Showing ${filteredSerializedDevices.length > 0 ? filteredSerializedDevices.length + ' Hardware Units' : serializedProductsWithStock.length + ' Serialized Products with Stock'} in ${currentBranchName}`
                : viewMode === 'REORDER_LIST'
                ? `Reorder Level Priority: Showing ${filteredReorderItems.length} Products in ${currentBranchName} (${
                    filterBranch === 'ALL' ? 'Calculated across All Branches' : 'Single Branch Threshold'
                  })`
                : viewMode === 'MASTER_STOCK'
                ? `Master Stock Catalog: Showing ${filteredProducts.length} Product Items in ${currentBranchName}`
                : `Multi-Branch Distribution Matrix across All Branches`}
            </span>
          </div>

          <span className="text-[11px] font-mono text-slate-400">
            Export Format: Standard CSV (Bikram Sambat BS & Gregorian AD Dual Date)
          </span>
        </div>

        {/* Scrollable Table Viewport */}
        <div className="flex-1 min-h-0 overflow-auto relative">
          {/* VIEW 1: SERIALIZED DEVICES */}
          {viewMode === 'SERIALIZED_DEVICES' && (
            <>
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Branch Location</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product / Model Name</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Device Serial (SN)</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">PON Serial Number</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">MAC Address</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Stock Status</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Location / Holder</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Registered (BS)</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {filteredSerializedDevices.length === 0 && serializedProductsWithStock.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-12 text-center text-slate-400">
                      No serialized devices or serialized products with stock found.
                    </td>
                  </tr>
                ) : filteredSerializedDevices.length === 0 ? (
                  // Show serialized products with stock when no device records exist
                  serializedProductsWithStock.map((item) => {
                    const product = item.product;
                    return (
                      <tr
                        key={product.id}
                        className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40"
                      >
                        <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                            <span>{currentBranchName}</span>
                          </span>
                        </td>
                        <td className="p-2.5 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                          {product.name}
                        </td>
                        <td className="p-2.5 font-mono text-slate-500 dark:text-slate-400 italic">Awaiting Serial Registration</td>
                        <td className="p-2.5 font-mono text-slate-500 dark:text-slate-400">-</td>
                        <td className="p-2.5 font-mono text-slate-500 dark:text-slate-400">-</td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">
                            <AlertTriangle className="h-3 w-3" />
                            <span>STOCK AVAILABLE - NEEDS SERIALS</span>
                          </span>
                        </td>
                        <td className="p-2.5 text-slate-600 dark:text-slate-400">
                          {item.branches.length > 0
                            ? item.branches.map((b) => `${b.branchCode}: ${b.qty}`).join(', ')
                            : 'Consolidated'}
                        </td>
                        <td className="p-2.5 text-right font-mono text-slate-500 whitespace-nowrap">
                          {item.branches.length > 0
                            ? item.branches.map((b) => formatBSDate(b.qty.toString())).join(', ')
                            : '-'}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  devicesPagination.pagedItems.map((dev) => {
                    const br = branches.find((b) => b.id === dev.branchId);
                    const isAvailable = dev.status === 'IN_STOCK';
                    const isRental = dev.status === 'RENTAL';

                    return (
                      <tr
                        key={dev.id}
                        className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}
                      >
                        <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                            <span>{br?.name || dev.branchId}</span>
                            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {br?.code || dev.branchId}
                            </span>
                          </span>
                        </td>
                        <td className="p-2.5 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                          {dev.productName}
                        </td>
                        <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap`}>
                          <div className="flex items-center gap-1.5">
                            <span>{dev.deviceSerial}</span>
                            <button
                              onClick={() => copyToClipboard(dev.deviceSerial)}
                              className="text-slate-400 hover:text-indigo-500 transition-colors cursor-pointer"
                              title="Copy Serial Number"
                            >
                              {copiedSerial === dev.deviceSerial ? (
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="p-2.5 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 font-semibold text-[11px]">
                            {dev.ponSerial || 'N/A'}
                          </span>
                        </td>
                        <td className="p-2.5 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {dev.macAddress || 'N/A'}
                        </td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          {isAvailable ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                              <CheckCircle2 className="h-3 w-3" />
                              <span>AVAILABLE IN-STORE</span>
                            </span>
                          ) : isRental ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
                              <Wifi className="h-3 w-3" />
                              <span>CUSTOMER RENTAL</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {dev.status}
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-slate-600 dark:text-slate-400 truncate max-w-[200px]">
                          {dev.customerName}
                        </td>
                        <td className="p-2.5 text-right font-mono text-slate-500 whitespace-nowrap">
                          {formatBSDate(dev.issuedDateAD || dev.issuedDateBS)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            <TablePagination
              page={devicesPagination.page}
              pageCount={devicesPagination.pageCount}
              totalItems={devicesPagination.totalItems}
              rangeStart={devicesPagination.rangeStart}
              rangeEnd={devicesPagination.rangeEnd}
              pageSize={devicesPagination.pageSize}
              onPageChange={devicesPagination.setPage}
              onPageSizeChange={devicesPagination.setPageSize}
              className="mt-1"
            />
            </>
          )}

          {/* VIEW 2: REORDER LEVEL & LOW STOCK LIST (CONSOLIDATED & BRANCH AWARE) */}
          {viewMode === 'REORDER_LIST' && (
            <>
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">SKU / Code</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product Name</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Category</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">On-Hand Stock</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">
                    {filterBranch === 'ALL' ? 'Consolidated Min Level (All Branches)' : 'Min Reorder Level'}
                  </th>
                  {filterBranch === 'ALL' && (
                    <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Low Branches</th>
                  )}
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Deficit (Shortfall)</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Suggested Reorder</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Stock Health</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Unit Cost</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Reorder Budget (NPR)</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {filteredReorderItems.length === 0 ? (
                  <tr>
                    <td colSpan={filterBranch === 'ALL' ? 11 : 10} className="p-12 text-center text-slate-400">
                      No low stock items found matching the selected filter criteria. All inventory is above safety thresholds.
                    </td>
                  </tr>
                ) : (
                  reorderListPagination.pagedItems.map(({ product: p, onHand, reorderThreshold, isConsolidated, lowBranchesCount, totalBranchesCount, deficit, suggestedReorderQty, estimatedReorderBudget, isOutOfStock, isBelowReorder }) => {
                    return (
                      <tr
                        key={p.id}
                        className={`transition-colors 'isOutOfStock
                            ? 'bg-rose-50/50 hover:bg-rose-50 dark:bg-rose-950/20 dark:hover:bg-rose-950/30'
                            : isBelowReorder ? bg-amber-50/40 hover:bg-amber-50 dark:bg-amber-950/15 dark:hover:bg-amber-950/25 : hover:bg-slate-200 dark:hover:bg-slate-800/40'`}
                      >
                        <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap`}>
                          {p.sku}
                        </td>
                        <td className="p-2.5 font-bold text-slate-900 dark:text-white">
                          <div className="flex items-center gap-2">
                            <span>{p.name}</span>
                            {p.requiresSerialTracking && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400">
                                SERIALIZED
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-2.5 text-slate-500 whitespace-nowrap">{p.category}</td>
                        <td className={`p-2.5 text-center font-mono font-bold whitespace-nowrap ${
                          isOutOfStock
                            ? 'text-rose-600 dark:text-rose-400'
                            : isBelowReorder
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}>
                          {onHand} {p.unit}
                        </td>
                        <td className="p-2.5 text-center font-mono font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {reorderThreshold} {p.unit}
                          {isConsolidated && (
                            <span className="block text-[10px] text-slate-400 font-normal">
                              (Consolidated All Branches)
                            </span>
                          )}
                        </td>
                        {isConsolidated && (
                          <td className="p-2.5 text-center whitespace-nowrap">
                            {lowBranchesCount > 0 ? (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60">
                                {lowBranchesCount} / {totalBranchesCount} Branches Low
                              </span>
                            ) : (
                              <span className="text-emerald-600 font-medium text-[11px] dark:text-emerald-400 dark:font-medium dark:text-[11px]">
                                All Branches OK
                              </span>
                            )}
                          </td>
                        )}
                        <td className="p-2.5 text-center font-mono font-bold whitespace-nowrap">
                          {deficit > 0 ? (
                            <span className={`px-2 py-0.5 rounded bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400 text-xs`}>
                              -{deficit} {p.unit}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">0</span>
                          )}
                        </td>
                        <td className={`p-2.5 text-center font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap`}>
                          {suggestedReorderQty > 0 ? `+${suggestedReorderQty} ${p.unit}` : '-'}
                        </td>
                        <td className="p-2.5 text-center whitespace-nowrap">
                          {isOutOfStock ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-500 border border-rose-500/20">
                              <AlertCircle className="h-3 w-3" />
                              <span>OUT OF STOCK</span>
                            </span>
                          ) : isBelowReorder ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                              <AlertTriangle className="h-3 w-3" />
                              <span>LOW STOCK</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                              <CheckCircle2 className="h-3 w-3" />
                              <span>HEALTHY</span>
                            </span>
                          )}
                        </td>
                        <td className="p-2.5 text-right font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          रु {(p.costPrice || 0).toLocaleString('en-IN')}
                        </td>
                        <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white whitespace-nowrap">
                          {estimatedReorderBudget > 0 ? (
                            <span className="text-rose-600 dark:text-rose-400">
                              रु {(estimatedReorderBudget ?? 0).toLocaleString('en-IN')}
                            </span>
                          ) : (
                            <span className="text-slate-400 font-normal">रु 0</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            <TablePagination
              page={reorderListPagination.page}
              pageCount={reorderListPagination.pageCount}
              totalItems={reorderListPagination.totalItems}
              rangeStart={reorderListPagination.rangeStart}
              rangeEnd={reorderListPagination.rangeEnd}
              pageSize={reorderListPagination.pageSize}
              onPageChange={reorderListPagination.setPage}
              onPageSizeChange={reorderListPagination.setPageSize}
              className="mt-1"
            />
            </>
          )}

          {/* VIEW 3: MASTER STOCK MATRIX */}
          {viewMode === 'MASTER_STOCK' && (
            <>
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">SKU / Barcode</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product Name</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Group</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Category</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">On-Hand Stock</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Reorder Threshold</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Cost Price</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Cost Valuation</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {productsPagination.pagedItems.map((p) => {
                  const qty = getProductStock(p.id);
                  const isLow = qty <= p.minReorderLevel;

                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}
                    >
                      <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                        {p.sku}
                      </td>
                      <td className="p-2.5 font-bold text-slate-900 dark:text-white">
                        <div className="flex items-center gap-2">
                          <span>{p.name}</span>
                          {p.requiresSerialTracking && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400">
                              SERIALIZED
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-2.5 text-slate-500">{p.productGroup || 'Product Item'}</td>
                      <td className="p-2.5 text-slate-500">{p.category}</td>
                      <td className="p-2.5 text-center font-mono font-bold text-slate-800 dark:text-slate-200">
                        {qty} {p.unit}
                      </td>
                      <td className="p-2.5 text-center font-mono font-medium text-slate-500">
                        {p.minReorderLevel} {p.unit}
                      </td>
                      <td className="p-2.5 text-right font-mono text-slate-600 dark:text-slate-400">
                        रु {(p.costPrice ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="p-2.5 text-right font-mono font-semibold text-slate-900 dark:text-white">
                        रु {((qty || 0) * (p.costPrice || 0)).toLocaleString('en-IN')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TablePagination
              page={productsPagination.page}
              pageCount={productsPagination.pageCount}
              totalItems={productsPagination.totalItems}
              rangeStart={productsPagination.rangeStart}
              rangeEnd={productsPagination.rangeEnd}
              pageSize={productsPagination.pageSize}
              onPageChange={productsPagination.setPage}
              onPageSizeChange={productsPagination.setPageSize}
              className="mt-1"
            />
            </>
          )}

          {/* VIEW 4: BRANCH DISTRIBUTION MATRIX */}
          {viewMode === 'BRANCH_MATRIX' && (
            <>
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit whitespace-nowrap">SKU / Code</th>
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit whitespace-nowrap min-w-[200px]">Product Name</th>
                  {branches.map((b) => (
                    <th key={b.id} className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center whitespace-nowrap">
                      {b.code}
                    </th>
                  ))}
                  <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right whitespace-nowrap font-bold text-indigo-500">
                    Total All Branches
                  </th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {productsPagination.pagedItems.map((p) => {
                  const total = stock
                    .filter((s) => s.productId === p.id)
                    .reduce((sum, item) => sum + (item.quantityOnHand || 0), 0);

                  return (
                    <tr
                      key={p.id}
                      className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}
                    >
                      <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap`}>
                        {p.sku}
                      </td>
                      <td className="p-2.5 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                        {p.name}
                      </td>
                      {branches.map((b) => {
                        const st = stock.find((s) => s.productId === p.id && s.branchId === b.id);
                        const qty = st ? st.quantityOnHand : 0;
                        const bThreshold = (st && st.minReorderLevel !== undefined && st.minReorderLevel !== null)
                          ? st.minReorderLevel
                          : (p.minReorderLevel || 0);
                        const isLow = qty <= bThreshold;

                        return (
                          <td
                            key={b.id}
                            className={`p-3 text-center font-mono font-semibold whitespace-nowrap ${
                              qty === 0
                                ? 'text-rose-500'
                                : isLow
                                ? 'text-amber-500'
                                : 'text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            {qty}
                          </td>
                        );
                      })}
                      <td className={`p-2.5 text-right font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap`}>
                        {total} {p.unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TablePagination
              page={productsPagination.page}
              pageCount={productsPagination.pageCount}
              totalItems={productsPagination.totalItems}
              rangeStart={productsPagination.rangeStart}
              rangeEnd={productsPagination.rangeEnd}
              pageSize={productsPagination.pageSize}
              onPageChange={productsPagination.setPage}
              onPageSizeChange={productsPagination.setPageSize}
              className="mt-1"
            />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
