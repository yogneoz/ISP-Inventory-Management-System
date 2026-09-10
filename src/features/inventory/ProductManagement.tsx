import React, { useState } from 'react';
import { Category, InventoryStock, Product, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Package,
  Plus,
  Search,
  Edit2,
  Trash2,
  Filter,
  BarChart2,
  X,
  Check,
  Tag,
  Barcode,
  Layers,
  CheckCircle2,
  Printer,
  TrendingDown,
  Lock,
  Wrench,
  Download,
  FileSpreadsheet,
} from 'lucide-react';

const CODE39_MAP: Record<string, string> = {
  '0': '10100110110', '1': '11010010101', '2': '10110010101', '3': '11011001010', '4': '10100110101',
  '5': '11010011010', '6': '10110011010', '7': '10100101101', '8': '11010010110', '9': '10110010110',
  'A': '11010100101', 'B': '10110100101', 'C': '11011010010', 'D': '10101100101', 'E': '11010110010',
  'F': '10110110010', 'G': '10100101101', 'H': '11010010101', 'I': '10110010101', 'J': '10101101001',
  'K': '11010101001', 'L': '10110101001', 'M': '11011010100', 'N': '10101101001', 'O': '11010110100',
  'P': '10110110100', 'Q': '10100110101', 'R': '11010011010', 'S': '10110011010', 'T': '10101101100',
  'U': '11001010101', 'V': '10011010101', 'W': '11001101010', 'X': '10010110101', 'Y': '11001011010',
  'Z': '10011011010', '-': '10010101101', '.': '11001010110', ' ': '10011010110', '*': '10010110110',
  '$': '10010010010', '/': '10010010100', '+': '10010100100', '%': '10100100100',
};

export const Code39BarcodeSVG: React.FC<{
  code: string;
  height?: number;
  barWidth?: number;
  showText?: boolean;
}> = ({ code, height = 45, barWidth = 1.8, showText = true }) => {
  const cleanCode = (code || 'ADP001').toUpperCase().replace(/[^0-9A-Z\-.\s$/+%]/g, '') || 'ADP001';
  const fullText = `*${cleanCode}*`;

  let patternString = '';
  for (let i = 0; i < fullText.length; i++) {
    const char = fullText[i];
    patternString += (CODE39_MAP[char] || CODE39_MAP['*']) + '0';
  }

  const svgWidth = Math.max(120, patternString.length * barWidth);

  return (
    <div className="inline-flex flex-col items-center select-none">
      <svg
        width={svgWidth}
        height={height}
        viewBox={`0 0 ${svgWidth} ${height}`}
        className="bg-white p-1 rounded border border-slate-200"
        shapeRendering="crispEdges"
      >
        {patternString.split('').map((bit, idx) =>
          bit === '1' ? (
            <rect
              key={idx}
              x={idx * barWidth}
              y={0}
              width={barWidth}
              height={height}
              fill="#000000"
            />
          ) : null
        )}
      </svg>
      {showText && (
        <span className="font-mono font-extrabold text-[11px] tracking-widest text-slate-900 mt-1">
          {cleanCode}
        </span>
      )}
    </div>
  );
};

interface ProductManagementProps {
  currentUser?: User | null;
  products: Product[];
  stock?: InventoryStock[];
  selectedBranchId?: string;
  onCreateProduct: (prod: Omit<Product, 'id'>) => Promise<void>;
  onUpdateProduct: (id: string, prod: Partial<Product>) => Promise<void>;
  onDeleteProduct: (id: string) => Promise<void>;
  searchQuery: string;  mode?: 'product-master' | 'all-stock';
  dbCategories?: Category[];
}

export const ProductManagement: React.FC<ProductManagementProps> = ({
  currentUser,
  products,
  stock = [],
  selectedBranchId = 'ALL',
  onCreateProduct,
  onUpdateProduct,
  onDeleteProduct,
  searchQuery,  mode = 'product-master',
  dbCategories = [],
}) => {
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [filterProductGroup, setFilterProductGroup] = useState<string>('ALL');
  const [localSearch, setLocalSearch] = useState<string>('');
  const [showZeroStock, setShowZeroStock] = useState<boolean>(mode === 'product-master');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // Barcode Printing State
  const [printingProduct, setPrintingProduct] = useState<Product | null>(null);
  const [labelCopies, setLabelCopies] = useState<number>(1);
  const [showPriceOnLabel, setShowPriceOnLabel] = useState<boolean>(true);
  const [showConsumablesBanner, setShowConsumablesBanner] = useState<boolean>(true);

  // Bulk Barcode Printing State (A4 Paper Size PDF)
  const [isBulkBarcodeModalOpen, setIsBulkBarcodeModalOpen] = useState<boolean>(false);
  const [bulkScope, setBulkScope] = useState<'FILTERED' | 'ALL' | 'IN_STOCK'>('FILTERED');
  const [bulkQtyMode, setBulkQtyMode] = useState<'ONE_PER_SKU' | 'STOCK_QTY' | 'CUSTOM'>('ONE_PER_SKU');
  const [bulkCustomCopies, setBulkCustomCopies] = useState<number>(1);
  const [bulkColumns, setBulkColumns] = useState<number>(3);
  const [bulkShowPrice, setBulkShowPrice] = useState<boolean>(true);
  const [bulkShowCategory, setBulkShowCategory] = useState<boolean>(true);

  // Form state
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Fiber Accessories & Cables');
  const [isCustomCategory, setIsCustomCategory] = useState<boolean>(false);
  const [productGroup, setProductGroup] = useState<'Product Item' | 'Fixed Asset' | 'Consumable Item'>('Product Item');
  const [unit, setUnit] = useState<Product['unit']>('Pcs');
  const [costPrice, setCostPrice] = useState<number>(0);
  const [sellingPrice, setSellingPrice] = useState<number>(0);
  const [taxRate, setTaxRate] = useState<number>(13);
  const [minReorderLevel, setMinReorderLevel] = useState<number>(10);
  const [requiresSerialTracking, setRequiresSerialTracking] = useState<boolean>(true);
  const [description, setDescription] = useState('');

  // Fixed Asset Depreciation Form State
  const [depreciationMethod, setDepreciationMethod] = useState<'STRAIGHT_LINE' | 'DECLINING_BALANCE' | 'WRITTEN_DOWN_VALUE'>('STRAIGHT_LINE');
  const [depreciationRate, setDepreciationRate] = useState<number>(15);
  const [usefulLifeYears, setUsefulLifeYears] = useState<number>(5);
  const [salvageValuePercent, setSalvageValuePercent] = useState<number>(10);

  // Categories fetched dynamically from backend database table
  const availableCategories = Array.from(
    new Set([
      ...dbCategories.map((c) => c.name),
      ...products.map((p) => p.category).filter(Boolean),
    ])
  ).sort();

  if (availableCategories.length === 0) {
    availableCategories.push(
      'Fiber Accessories & Cables',
      'Routers & ONTs',
      'Networking Switches',
      'Fixed Assets',
      'Tools & Safety Gear',
      'Power & UPS'
    );
  }

  const categories = Array.from(
    new Set([
      ...dbCategories.map((c) => c.name),
      ...products.map((p) => p.category).filter(Boolean),
    ])
  ).sort();

  const effectiveSearch = localSearch || searchQuery;

  // Calculate total stock on hand for each product
  const getProductStockQty = (prodId: string) => {
    if (!stock || stock.length === 0) return 0;
    const items = stock.filter(
      (s) => s.productId === prodId && (selectedBranchId === 'ALL' || s.branchId === selectedBranchId)
    );
    return items.reduce((sum, item) => sum + item.quantityOnHand, 0);
  };

  const hiddenZeroStockCount = products.filter((p) => getProductStockQty(p.id) === 0).length;

  const filteredProducts = products.filter((p) => {
    const matchesCat = filterCategory === 'ALL' || p.category === filterCategory;
    const matchesGroup = filterProductGroup === 'ALL' || (p.productGroup || 'Product Item') === filterProductGroup;
    const matchesSearch =
      !effectiveSearch ||
      (p?.name || '').toLowerCase().includes((effectiveSearch || '').toLowerCase()) ||
      (p?.sku || '').toLowerCase().includes((effectiveSearch || '').toLowerCase()) ||
      (p?.barcode || '').toLowerCase().includes((effectiveSearch || '').toLowerCase());

    const totalQty = getProductStockQty(p.id);
    const matchesStockFilter = showZeroStock || totalQty > 0;

    return matchesCat && matchesGroup && matchesSearch && matchesStockFilter;
  });

  const handleExportStockCSV = () => {
    const isAllStock = mode === 'all-stock';
    const reportTitle = isAllStock
      ? 'All Available Stock Inventory Matrix'
      : 'Product Master Catalog Directory';
    const filename = isAllStock ? 'All_Available_Stock_Matrix' : 'Product_Master_Catalog';

    const columns = [
      { key: 'sku', label: 'Product Code / SKU' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'name', label: 'Product Name' },
      { key: 'productGroup', label: 'Product Group', formatter: (val: string) => val || 'Product Item' },
      { key: 'category', label: 'Category' },
      {
        key: 'trackingType',
        label: 'Tracking Mode',
        formatter: (_: any, row: Product) => (row.requiresSerialTracking !== false ? 'Serial / MAC / PON' : 'Quantity Only'),
      },
      { key: 'stockQty', label: 'Available Stock', formatter: (_: any, row: Product) => getProductStockQty(row.id) },
      { key: 'unit', label: 'Unit (UoM)' },
      { key: 'costPrice', label: 'Cost Price (NPR)', formatter: (val: number) => val || 0 },
      { key: 'sellingPrice', label: 'Selling Price (NPR)', formatter: (val: number) => val || 0 },
      { key: 'taxRate', label: 'VAT Rate (%)', formatter: (val: number) => `${val || 0}%` },
      {
        key: 'costValuation',
        label: 'Cost Valuation (NPR)',
        formatter: (_: any, row: Product) => getProductStockQty(row.id) * (row.costPrice || 0),
      },
      {
        key: 'sellingValuation',
        label: 'Selling Valuation (NPR)',
        formatter: (_: any, row: Product) => getProductStockQty(row.id) * (row.sellingPrice || 0),
      },
      { key: 'minReorderLevel', label: 'Reorder Level' },
      { key: 'description', label: 'Description', formatter: (val: string) => val || '-' },
    ];

    exportToCSV({
      filename,
      reportTitle,
      branchName: selectedBranchId && selectedBranchId !== 'ALL' ? `Branch ID: ${selectedBranchId}` : 'All Branches (Consolidated)',
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredProducts,
      columns,
    });
  };

  const canEditProduct = isOperationAllowed('prod-edit', currentUser?.role);

  const openCreateModal = () => {
    if (!canEditProduct) {
      alert('Permission Denied: Only Super Admin and Inventory Manager can create new products.');
      return;
    }
    setEditingProduct(null);
    const newSku = `ADP${Math.floor(100 + Math.random() * 900)}`;
    setSku(newSku);
    setBarcode(newSku);
    setName('');
    const defaultCat = availableCategories[0] || 'Fiber Accessories & Cables';
    setCategory(defaultCat);
    setIsCustomCategory(false);
    setProductGroup('Product Item');
    setUnit('Pcs');
    setCostPrice(1000);
    setSellingPrice(1300);
    setTaxRate(13);
    setMinReorderLevel(10);
    setRequiresSerialTracking(true);
    setDescription('');
    setDepreciationMethod('STRAIGHT_LINE');
    setDepreciationRate(15);
    setUsefulLifeYears(5);
    setSalvageValuePercent(10);
    setIsModalOpen(true);
  };

  const openEditModal = (p: Product) => {
    if (!canEditProduct) {
      alert('Permission Denied: Only Super Admin and Inventory Manager can edit product master records.');
      return;
    }
    setEditingProduct(p);
    setSku(p.sku);
    setBarcode(p.barcode || p.sku);
    setName(p.name);
    setCategory(p.category || 'Fiber Accessories & Cables');
    setIsCustomCategory(!availableCategories.includes(p.category));
    setProductGroup(p.productGroup || 'Product Item');
    setUnit(p.unit);
    setCostPrice(p.costPrice);
    setSellingPrice(p.sellingPrice);
    setTaxRate(p.taxRate);
    setMinReorderLevel(p.minReorderLevel);
    setRequiresSerialTracking(p.requiresSerialTracking !== false);
    setDescription(p.description || '');
    setDepreciationMethod(p.depreciationMethod || 'STRAIGHT_LINE');
    setDepreciationRate(p.depreciationRate ?? 15);
    setUsefulLifeYears(p.usefulLifeYears ?? 5);
    setSalvageValuePercent(p.salvageValuePercent ?? 10);
    setIsModalOpen(true);
  };

  const openPrintBarcodeModal = (p: Product) => {
    setPrintingProduct(p);
    setLabelCopies(1);
    setShowPriceOnLabel(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const payload: Partial<Product> = {
      sku,
      barcode: barcode || sku,
      name,
      category,
      productGroup,
      unit,
      costPrice: Number(costPrice),
      sellingPrice: Number(sellingPrice),
      taxRate: Number(taxRate),
      minReorderLevel: Number(minReorderLevel),
      requiresSerialTracking,
      trackingType: (requiresSerialTracking ? 'SERIAL_MAC_PON' : 'QUANTITY_ONLY') as 'SERIAL_MAC_PON' | 'QUANTITY_ONLY',
      description,
      ...(productGroup === 'Fixed Asset'
        ? {
            depreciationMethod,
            depreciationRate: Number(depreciationRate),
            usefulLifeYears: Number(usefulLifeYears),
            salvageValuePercent: Number(salvageValuePercent),
          }
        : {
            depreciationMethod: undefined,
            depreciationRate: undefined,
            usefulLifeYears: undefined,
            salvageValuePercent: undefined,
          }),
    };

    if (editingProduct) {
      await onUpdateProduct(editingProduct.id, payload);
    } else {
      await onCreateProduct(payload as Omit<Product, 'id'>);
    }
    setIsModalOpen(false);
  };

  const getBulkLabelsList = () => {
    let sourceProducts = filteredProducts;
    if (bulkScope === 'ALL') {
      sourceProducts = products;
    } else if (bulkScope === 'IN_STOCK') {
      sourceProducts = products.filter((p) => getProductStockQty(p.id) > 0);
    }

    const labels: Array<{ product: Product; copyIdx: number }> = [];
    for (const prod of sourceProducts) {
      let count = 1;
      if (bulkQtyMode === 'STOCK_QTY') {
        count = Math.max(1, getProductStockQty(prod.id));
      } else if (bulkQtyMode === 'CUSTOM') {
        count = Math.max(1, Math.min(50, bulkCustomCopies));
      }
      for (let c = 0; c < count; c++) {
        labels.push({ product: prod, copyIdx: c });
      }
    }
    return labels;
  };

  const bulkLabels = getBulkLabelsList();

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      <style>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 0;
          }
          body * {
            visibility: hidden !important;
          }
          #barcode-print-area, #barcode-print-area *,
          #bulk-barcode-a4-area, #bulk-barcode-a4-area * {
            visibility: visible !important;
          }
          #barcode-print-area, #bulk-barcode-a4-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            background: white !important;
            color: black !important;
          }
          .barcode-card-item {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }
        }
      `}</style>

      {/* Header bar */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Package className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
            <span>{mode === 'product-master' ? 'Product Master Page' : 'All Available Stock Inventory'}</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            {mode === 'product-master'
              ? 'Master SKU catalog specification: Product Code, Barcode, Fixed Asset Depreciation settings, Category, UoM, Pricing, VAT %, and Reorder levels.'
              : 'Live multi-branch inventory stock overview: on-hand balances, warehouse locations, and zero-stock filters.'}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleExportStockCSV}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:hover:bg-emerald-900/80 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer shadow-xs transition-all"
            title="Export full stock matrix with uniform BS date YYYY-MM-DD"
          >
            <Download className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span>Export Stock CSV (BS Date)</span>
          </button>

          <button
            type="button"
            onClick={() => setIsBulkBarcodeModalOpen(true)}
            className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-300 dark:border-slate-700 cursor-pointer shadow-xs transition-all"
            title="Print All Item Barcodes formatted in A4 Sheet PDF Grid (Code 39 format)"
          >
            <Printer className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
            <Barcode className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
            <span>Print All Barcodes (A4 PDF)</span>
          </button>

          {(() => {
            const canEditProd = isOperationAllowed('prod-edit', currentUser?.role);
            if (!canEditProd) return null;
            return (
              <button
                title="Create new product SKU"
                onClick={openCreateModal}
                className="flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer shadow-md transition-all"
              >
                <Plus className="h-4 w-4" />
                <span>Add New Product SKU</span>
              </button>
            );
          })()}
        </div>
      </div>

      {/* Consumable Products vs Fixed Assets Guidance & Advisory Banner */}
      {showConsumablesBanner && (
        <div className={`p-3.5 rounded-2xl border transition-all bg-amber-50/90 border-amber-200 text-amber-900 dark:bg-amber-950/20 dark:border-amber-800/40 dark:text-amber-200`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex gap-2.5">
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                <Wrench className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                    Consumables Management Guide (Splitters, Protection Sleeves, Couplers, Fast Connectors)
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-200 dark:bg-amber-900 text-amber-900 dark:text-amber-100">
                    Operational Standard
                  </span>
                </div>
                <p className="text-xs mt-1 leading-relaxed opacity-90">
                  <strong>Are Splitters, Protection Sleeves, Couplers Fixed Assets? NO.</strong> Small field materials are high-turnover <strong>Consumable Items</strong>. Treating a 10-rupee sleeve or 200-rupee coupler as a Fixed Asset creates unnecessary asset registers and depreciation overhead.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2.5 text-[11px]">
                  <div className={`p-2 rounded-lg border bg-white/80 border-amber-200/80 dark:bg-slate-900/80 dark:border-slate-800`}>
                    <span className="font-bold text-amber-600 dark:text-amber-400">🛠️ Consumable Item</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">Splitters, Sleeves, Couplers, Patch Cords, Fast Connectors. Tracked by <strong>Quantity Only</strong>, issued to field technicians/jobs as direct operational expense.</p>
                  </div>
                  <div className={`p-2 rounded-lg border bg-white/80 border-amber-200/80 dark:bg-slate-900/80 dark:border-slate-800`}>
                    <span className="font-bold text-sky-600 dark:text-sky-400">📦 Product Item</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">ONUs, Dual-Band Routers, CPEs, Equipment for resale or customer installation. Tracked by <strong>Serial/MAC/PON</strong>.</p>
                  </div>
                  <div className={`p-2 rounded-lg border bg-white/80 border-amber-200/80 dark:bg-slate-900/80 dark:border-slate-800`}>
                    <span className="font-bold text-purple-600 dark:text-purple-400">🏢 Fixed Asset</span>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">OLT Mainframes, Splicer Machines, Servers, Generators, Vehicles. Capitalized, tagged (`AST-XXX`), and depreciated over useful life.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setShowConsumablesBanner(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 cursor-pointer transition-colors"
                title="Dismiss guide"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter and Search controls */}
      <div className={`flex-none flex flex-col md:flex-row items-center justify-between gap-2 p-2 rounded-xl border shadow-2xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Scan Barcode or Search Product Code (ADP001) / Name:"
            className={`w-full rounded-lg border pl-8 pr-2.5 py-1 text-xs focus:outline-none focus:border-indigo-500 bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:placeholder-slate-500`}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <button
            type="button"
            onClick={() => setShowZeroStock(!showZeroStock)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold border transition-all cursor-pointer ${
              showZeroStock
                ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-600/40 hover:bg-amber-100'
                : 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-600/40 hover:bg-emerald-100'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              {showZeroStock ? 'All Stock List' : 'Available Stock (>0)'}
            </span>
            {!showZeroStock && hiddenZeroStockCount > 0 && (
              <span className="rounded-full bg-emerald-200 dark:bg-emerald-900/90 text-emerald-800 dark:text-emerald-200 px-1.5 py-0.2 text-[9px] font-bold">
                {hiddenZeroStockCount} Zero-Qty Hidden
              </span>
            )}
          </button>

          <Filter className="h-3.5 w-3.5 text-slate-400 ml-1" />
          <span className={`text-[11px] font-semibold text-slate-500 dark:text-slate-400`}>Group:</span>
          <select
            value={filterProductGroup}
            onChange={(e) => setFilterProductGroup(e.target.value)}
            className={`rounded-lg border px-2 py-1 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
          >
            <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Groups</option>
            <option value="Product Item" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Product Item (Equipment/Resale)</option>
            <option value="Consumable Item" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-amber-400 font-semibold">Consumable Item (Splitters/Sleeves/Couplers)</option>
            <option value="Fixed Asset" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-indigo-400 font-semibold">Fixed Asset (Capital Assets)</option>
          </select>

          <span className={`text-[11px] font-semibold text-slate-500 dark:text-slate-400`}>Category:</span>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className={`rounded-lg border px-2 py-1 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
          >
            <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Categories ({products.length})</option>
            {categories.map((cat) => (
              <option key={cat} value={cat} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Products Table */}
      <div className={`flex-1 min-h-0 flex flex-col rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="flex-1 min-h-0 overflow-auto relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-2xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
              <tr>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product Code / Barcode</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product Details</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Product Group</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Depreciation (Fixed Asset)</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Category</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Tracking Mode</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Available Stock</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Unit</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Cost Price (NPR)</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Selling Price (NPR)</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">VAT Rate</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-right">Min Reorder</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={13} className="p-6 text-center text-slate-500 text-xs">
                    No matching available stock items found. Toggle "Available Stock (&gt;0)" to view all stock items including zero-stock products.
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => {
                  const qtyOnHand = getProductStockQty(p.id);
                  const grp = p.productGroup || 'Product Item';
                  return (
                    <tr key={p.id} className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}>
                      <td className="px-2.5 py-1.5">
                        <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                          <span>{p.sku}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono flex items-center gap-1 mt-0.5">
                          <Barcode className="h-3 w-3 text-slate-400" />
                          <span>{p.barcode || p.sku}</span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <div className={`font-bold text-xs text-slate-900 dark:text-white`}>{p.name}</div>
                        {p.description && (
                          <div className={`text-[10px] line-clamp-1 text-slate-500 dark:text-slate-400`}>{p.description}</div>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          grp === 'Fixed Asset'
                            ? 'bg-purple-50 dark:bg-purple-950/80 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800'
                            : grp === 'Consumable Item'
                            ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800'
                            : 'bg-sky-50 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800'
                        }`}>
                          {grp === 'Consumable Item' ? '🛠️ Consumable' : grp === 'Fixed Asset' ? '🏢 Fixed Asset' : '📦 Product Item'}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5">
                        {grp === 'Fixed Asset' ? (
                          <div className="flex flex-col text-[10px]">
                            <span className="font-bold text-purple-700 dark:text-purple-300">
                              {p.depreciationMethod === 'WRITTEN_DOWN_VALUE'
                                ? 'WDV'
                                : p.depreciationMethod === 'DECLINING_BALANCE'
                                ? 'Declining'
                                : 'SLM'}{' '}
                              @ {p.depreciationRate ?? 15}%/yr
                            </span>
                            <span className="text-slate-500 text-[9px]">
                              {p.usefulLifeYears ?? 5} yrs life • {p.salvageValuePercent ?? 10}% salvage
                            </span>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
                          {p.category}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        {p.requiresSerialTracking !== false ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                            <Barcode className="h-3 w-3" />
                            Serial/MAC/PON
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                            <Layers className="h-3 w-3" />
                            Qty Only (Bulk)
                          </span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.2 text-[10px] font-mono font-extrabold border ${
                            qtyOnHand > p.minReorderLevel
                              ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30'
                              : qtyOnHand > 0
                              ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/30'
                              : 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-500/30'
                          }`}
                        >
                          {qtyOnHand} {p.unit}
                        </span>
                      </td>
                      <td className={`px-2.5 py-1.5 font-medium text-slate-600 dark:text-slate-400`}>{p.unit}</td>
                      <td className={`px-2.5 py-1.5 text-right font-mono font-medium text-slate-700 dark:text-slate-300`}>
                        रु {(p.costPrice ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className={`px-2.5 py-1.5 text-right font-mono font-bold text-slate-900 dark:text-white`}>
                        रु {(p.sellingPrice ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className="rounded bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.2 text-[10px] font-bold text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20">
                          {p.taxRate}%
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-semibold text-rose-600 dark:text-rose-400">
                        {p.minReorderLevel} {p.unit}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openPrintBarcodeModal(p)}
                            title="Print Barcode Label for Product Code"
                            className="p-1.5 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 rounded transition-colors cursor-pointer"
                          >
                            <Printer className="h-3.5 w-3.5" />
                          </button>
                          {canEditProduct && (
                            <>
                              <button
                                onClick={() => openEditModal(p)}
                                title="Edit Product Specification"
                                className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => onDeleteProduct(p.id)}
                                title="Delete Product"
                                className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors cursor-pointer"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Print Barcode Modal */}
      {printingProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs overflow-y-auto">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden my-8 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
            <div id="barcode-print-area">
              <div className={`p-4 border-b flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 print:hidden`}>
                <div className="flex items-center gap-2">
                  <Printer className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
                  <h3 className="font-bold text-sm">Print Product Code Barcode Label</h3>
                </div>
                <button
                  onClick={() => setPrintingProduct(null)}
                  className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div className="text-xs space-y-1 print:hidden">
                  <div className="font-bold text-sm text-indigo-600 dark:text-indigo-400">
                    Product Code: {printingProduct.sku}
                  </div>
                  <div className="font-semibold text-slate-800 dark:text-slate-200">
                    {printingProduct.name}
                  </div>
                  <div className="text-slate-500 text-[11px]">
                    Category: {printingProduct.category} | Group: {printingProduct.productGroup || 'Product Item'}
                  </div>
                </div>

                {/* Print Controls */}
                <div className="grid grid-cols-2 gap-3 p-3 rounded-xl border bg-slate-50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 print:hidden">
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 opacity-80">
                      Label Copies
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={labelCopies}
                      onChange={(e) => setLabelCopies(Math.max(1, Math.min(100, Number(e.target.value))))}
                      className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                    />
                  </div>
                  <div className="flex items-center pt-5">
                    <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showPriceOnLabel}
                        onChange={(e) => setShowPriceOnLabel(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      Include Price on Label
                    </label>
                  </div>
                </div>

                {/* Printable Labels Container */}
                <div className="border rounded-xl p-4 bg-slate-100 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 flex flex-wrap gap-4 justify-center max-h-80 overflow-y-auto">
                  {Array.from({ length: labelCopies }).map((_, i) => (
                    <div
                      key={i}
                      className="w-56 p-3 bg-white text-slate-900 rounded-lg border border-slate-300 shadow-sm flex flex-col items-center text-center print:break-inside-avoid print:shadow-none print:border-black"
                    >
                      <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 line-clamp-1 w-full">
                        {printingProduct.category}
                      </div>
                      <div className="text-xs font-bold text-slate-900 line-clamp-1 w-full my-0.5">
                        {printingProduct.name}
                      </div>

                      {/* Vector Barcode for Product Code */}
                      <div className="my-1.5">
                        <Code39BarcodeSVG
                          code={printingProduct.sku || printingProduct.barcode}
                          height={45}
                          barWidth={1.8}
                          showText={true}
                        />
                      </div>

                      {showPriceOnLabel && (
                        <div className="text-xs font-mono font-extrabold text-slate-900 mt-0.5">
                          NPR {(printingProduct.sellingPrice ?? 0).toLocaleString('en-IN')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className={`p-4 border-t flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 print:hidden`}>
                <button
                  type="button"
                  onClick={() => setPrintingProduct(null)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-md transition-all cursor-pointer"
                >
                  <Printer className="h-4 w-4" />
                  <span>Print Barcode Label{labelCopies > 1 ? 's' : ''}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Product Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden my-8 bg-white border-slate-200 text-slate-700 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300`}>
            <div className={`flex items-center justify-between border-b p-4 border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50`}>
              <h3 className={`font-bold text-sm text-slate-900 dark:text-white`}>
                {editingProduct ? 'Edit Product SKU Specification' : 'Create New Product SKU'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-semibold opacity-80">
                      Product Code (SKU)
                    </label>
                    {editingProduct && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                        <Lock className="h-3 w-3" />
                        <span>Locked</span>
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    required
                    readOnly={!!editingProduct}
                    disabled={!!editingProduct}
                    value={sku}
                    onChange={(e) => {
                      if (editingProduct) return;
                      const val = e.target.value;
                      setSku(val);
                      setBarcode(val);
                    }}
                    placeholder="e.g. ADP001"
                    title={editingProduct ? 'Product SKU code is immutable once created' : 'Enter unique product SKU'}
                    className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-indigo-500 ${editingProduct ? 'border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed opacity-80 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400 dark:cursor-not-allowed dark:opacity-80' : 'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
                  />
                  {editingProduct && (
                    <p className="text-[9px] text-slate-400 mt-0.5">
                      SKU Code is permanent and cannot be modified.
                    </p>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-semibold opacity-80">
                      Barcode
                    </label>
                    {editingProduct && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                        <Lock className="h-3 w-3" />
                        <span>Locked</span>
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    required
                    readOnly={!!editingProduct}
                    disabled={!!editingProduct}
                    value={barcode}
                    onChange={(e) => {
                      if (editingProduct) return;
                      setBarcode(e.target.value);
                    }}
                    placeholder="e.g. ADP001"
                    title={editingProduct ? 'Barcode is linked to SKU and cannot be altered' : 'Enter barcode'}
                    className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-indigo-500 ${editingProduct ? 'border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed opacity-80 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400 dark:cursor-not-allowed dark:opacity-80' : 'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'}`}
                  />
                  {editingProduct && (
                    <p className="text-[9px] text-slate-400 mt-0.5">
                      Barcode matches product SKU identifier.
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">
                  Product Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. 0 DB ADAPTAR-FA or Dell Latitude Laptop"
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">
                    Product Group
                  </label>
                  <select
                    value={productGroup}
                    onChange={(e) => {
                      const val = e.target.value as 'Product Item' | 'Fixed Asset' | 'Consumable Item';
                      setProductGroup(val);
                      if (val === 'Fixed Asset') {
                        setMinReorderLevel(0);
                      } else if (val === 'Consumable Item') {
                        setMinReorderLevel(20);
                        setRequiresSerialTracking(false);
                      }
                    }}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  >
                    <option value="Product Item">Product Item (Equipment/Resale)</option>
                    <option value="Consumable Item">Consumable Item (Splitters, Sleeves, Couplers)</option>
                    <option value="Fixed Asset">Fixed Asset (Capital Equipment)</option>
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-semibold opacity-80">
                      Category
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const nextIsCustom = !isCustomCategory;
                        setIsCustomCategory(nextIsCustom);
                        if (!nextIsCustom) {
                          setCategory(availableCategories[0] || 'Fiber Accessories & Cables');
                        }
                      }}
                      className="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold hover:underline cursor-pointer"
                    >
                      {isCustomCategory ? '← Choose Existing' : '＋ Type Custom'}
                    </button>
                  </div>

                  {isCustomCategory ? (
                    <input
                      type="text"
                      required
                      value={category}
                      onChange={(e) => {
                        const newCat = e.target.value;
                        setCategory(newCat);
                        if ((newCat || '').toLowerCase().includes('asset') || (newCat || '').toLowerCase().includes('fixed')) {
                          setMinReorderLevel(0);
                        }
                      }}
                      placeholder="e.g. Fiber Drop Wire, Splitters..."
                      className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                    />
                  ) : (
                    <select
                      value={category}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '__ADD_NEW_CUSTOM__') {
                          setIsCustomCategory(true);
                          setCategory('');
                        } else {
                          setCategory(val);
                          if ((val || '').toLowerCase().includes('asset') || (val || '').toLowerCase().includes('fixed')) {
                            setMinReorderLevel(0);
                          }
                        }
                      }}
                      className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 cursor-pointer border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                    >
                      {availableCategories.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                      <option value="__ADD_NEW_CUSTOM__" className="font-bold text-indigo-600">
                        ＋ Type Custom Category...
                      </option>
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">
                    Unit
                  </label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as any)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  >
                    <option value="Pcs">Pcs (Pieces)</option>
                    <option value="Box">Box</option>
                    <option value="Kg">Kg (Kilograms)</option>
                    <option value="Set">Set</option>
                    <option value="Mtr">Mtr (Meters)</option>
                    <option value="Roll">Roll</option>
                  </select>
                </div>
              </div>

              {/* Fixed Asset Depreciation Configuration Block */}
              {productGroup === 'Fixed Asset' && (
                <div className={`p-3 rounded-xl border space-y-2.5 bg-purple-50/70 border-purple-200 dark:bg-purple-950/20 dark:border-purple-800/40`}>
                  <div className="flex items-center gap-1.5 text-purple-700 dark:text-purple-300 text-xs font-bold">
                    <TrendingDown className="h-4 w-4" />
                    <span>Fixed Asset Depreciation Settings</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold mb-1 opacity-80">
                        Depreciation Method
                      </label>
                      <select
                        value={depreciationMethod}
                        onChange={(e) => setDepreciationMethod(e.target.value as any)}
                        className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-purple-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                      >
                        <option value="STRAIGHT_LINE">Straight Line Method (SLM)</option>
                        <option value="DECLINING_BALANCE">Declining Balance Method</option>
                        <option value="WRITTEN_DOWN_VALUE">Written Down Value (WDV)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold mb-1 opacity-80">
                        Annual Depreciation Rate (%)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={depreciationRate}
                        onChange={(e) => setDepreciationRate(Number(e.target.value))}
                        className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-purple-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold mb-1 opacity-80">
                        Useful Life (Years)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={usefulLifeYears}
                        onChange={(e) => setUsefulLifeYears(Number(e.target.value))}
                        className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-purple-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold mb-1 opacity-80">
                        Salvage / Scrap Value (%)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={salvageValuePercent}
                        onChange={(e) => setSalvageValuePercent(Number(e.target.value))}
                        className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-purple-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">
                    Cost Price (NPR)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={costPrice}
                    onChange={(e) => setCostPrice(Number(e.target.value))}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">
                    Selling Price (NPR)
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={sellingPrice}
                    onChange={(e) => setSellingPrice(Number(e.target.value))}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">
                    VAT %
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    max={100}
                    value={taxRate}
                    onChange={(e) => setTaxRate(Number(e.target.value))}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">
                  Minimum Stock Reorder Threshold
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  value={minReorderLevel}
                  onChange={(e) => setMinReorderLevel(Math.max(0, Number(e.target.value)))}
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  Accepts 0 for Fixed Asset type products or non-reorder items.
                </p>
              </div>

              {/* Serial / MAC Tracking Mode Toggle */}
              <div className={`p-3 rounded-xl border border-indigo-200 bg-indigo-50/50 dark:border-indigo-900/40 dark:bg-indigo-950/20`}>
                <label className="block text-xs font-bold text-indigo-900 dark:text-indigo-300 mb-1 flex items-center gap-1.5">
                  <Barcode className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  <span>Item Serial / MAC / PON Tracking Mode</span>
                </label>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label
                    onClick={() => setRequiresSerialTracking(true)}
                    className={`flex items-center gap-2 p-2 rounded-lg border text-xs font-semibold cursor-pointer transition-all ${requiresSerialTracking ? 'border-indigo-500 bg-indigo-600 text-white shadow-xs' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-700'}`}
                  >
                    <input
                      type="radio"
                      name="serialTrackingMode"
                      checked={requiresSerialTracking}
                      onChange={() => setRequiresSerialTracking(true)}
                      className="sr-only"
                    />
                    <CheckCircle2 className={`h-4 w-4 shrink-0 ${requiresSerialTracking ? 'text-white' : 'opacity-0'}`} />
                    <div>
                      <div>Serialized Device</div>
                      <div className={`text-[10px] font-normal ${requiresSerialTracking ? 'text-indigo-100' : 'text-slate-500'}`}>
                        Routers, STBs, OLTs, Switches, Servers
                      </div>
                    </div>
                  </label>

                  <label
                    onClick={() => setRequiresSerialTracking(false)}
                    className={`flex items-center gap-2 p-2 rounded-lg border text-xs font-semibold cursor-pointer transition-all ${!requiresSerialTracking ? 'border-emerald-500 bg-emerald-600 text-white shadow-xs' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-700'}`}
                  >
                    <input
                      type="radio"
                      name="serialTrackingMode"
                      checked={!requiresSerialTracking}
                      onChange={() => setRequiresSerialTracking(false)}
                      className="sr-only"
                    />
                    <CheckCircle2 className={`h-4 w-4 shrink-0 ${!requiresSerialTracking ? 'text-white' : 'opacity-0'}`} />
                    <div>
                      <div>Bulk / Quantity Only</div>
                      <div className={`text-[10px] font-normal ${!requiresSerialTracking ? 'text-emerald-100' : 'text-slate-500'}`}>
                        Cables, Drop wire, RJ45, Fasteners
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">
                  Description / Specification
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional details..."
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                />
              </div>

              <div className={`pt-3 border-t flex items-center justify-end gap-2 border-slate-200 dark:border-slate-800`}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Save Product
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk A4 Barcode Printing Modal */}
      {isBulkBarcodeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs overflow-y-auto">
          <div className={`w-full max-w-5xl rounded-2xl shadow-2xl border overflow-hidden my-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
            <div id="bulk-barcode-a4-area">
              {/* Modal Header */}
              <div className={`p-4 border-b flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 print:hidden`}>
                <div className="flex items-center gap-2">
                  <Printer className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
                  <Barcode className={`h-5 w-5 text-emerald-500 dark:text-emerald-400`} />
                  <h3 className="font-bold text-sm">
                    Print Item Barcodes (A4 Sheet PDF Format — Code 39)
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIsBulkBarcodeModalOpen(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                {/* Configuration controls */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-3.5 rounded-xl border bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 text-xs print:hidden">
                  <div>
                    <label className="block font-bold mb-1 opacity-80">1. Product Scope</label>
                    <select
                      value={bulkScope}
                      onChange={(e) => setBulkScope(e.target.value as any)}
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-semibold focus:outline-none bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
                    >
                      <option value="FILTERED">Current Filtered List ({filteredProducts.length} items)</option>
                      <option value="ALL">Entire Product Catalog ({products.length} items)</option>
                      <option value="IN_STOCK">Available Stock (&gt;0 Qty Only)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-bold mb-1 opacity-80">2. Copies per Item</label>
                    <select
                      value={bulkQtyMode}
                      onChange={(e) => setBulkQtyMode(e.target.value as any)}
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-semibold focus:outline-none bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
                    >
                      <option value="ONE_PER_SKU">1 Label per SKU (Catalog Sheet)</option>
                      <option value="STOCK_QTY">Match Inventory Stock Qty</option>
                      <option value="CUSTOM">Custom Copies per SKU</option>
                    </select>
                    {bulkQtyMode === 'CUSTOM' && (
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={bulkCustomCopies}
                        onChange={(e) => setBulkCustomCopies(Math.max(1, Math.min(50, Number(e.target.value))))}
                        className={`w-full mt-1 rounded-lg border px-2 py-1 font-mono text-xs bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                      />
                    )}
                  </div>

                  <div>
                    <label className="block font-bold mb-1 opacity-80">3. A4 Grid Density</label>
                    <select
                      value={bulkColumns}
                      onChange={(e) => setBulkColumns(Number(e.target.value))}
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-semibold focus:outline-none bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
                    >
                      <option value={3}>3 Columns (24 Labels / Page) — Standard</option>
                      <option value={4}>4 Columns (40 Labels / Page) — Compact</option>
                    </select>
                  </div>

                  <div className="flex flex-col justify-center space-y-1.5 pt-1">
                    <label className="flex items-center gap-2 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bulkShowPrice}
                        onChange={(e) => setBulkShowPrice(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>Show Selling Price (NPR)</span>
                    </label>
                    <label className="flex items-center gap-2 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={bulkShowCategory}
                        onChange={(e) => setBulkShowCategory(e.target.checked)}
                        className="rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>Show Category / Group</span>
                    </label>
                  </div>
                </div>

                {/* Summary Banner */}
                <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-xs text-indigo-900 dark:text-indigo-200 font-semibold print:hidden">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    <span>
                      Total Barcode Labels: <strong>{bulkLabels.length} labels</strong>
                    </span>
                  </div>
                  <span className="text-[11px] opacity-80">
                    A4 Portrait Page Layout (Code 39 Format) • Fits ~{Math.ceil(bulkLabels.length / (bulkColumns * 8))} Page(s)
                  </span>
                </div>

                {/* Printable A4 Sheet Preview Area */}
                <div className="max-h-[60vh] overflow-y-auto p-4 bg-slate-200 dark:bg-slate-950/80 rounded-xl border border-slate-300 dark:border-slate-800">
                  {bulkLabels.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500">
                      No matching products found for the selected scope.
                    </div>
                  ) : (
                    <div
                      className={`w-full bg-white text-slate-900 p-4 shadow-xl border border-slate-300 rounded-sm grid gap-3 ${
                        bulkColumns === 4 ? 'grid-cols-4' : 'grid-cols-3'
                      }`}
                    >
                      {bulkLabels.map((lbl, idx) => (
                        <div
                          key={`${lbl.product.id}-${lbl.copyIdx}-${idx}`}
                          className="barcode-card-item p-2.5 bg-white text-slate-900 border border-slate-300 rounded flex flex-col items-center text-center justify-between min-h-[110px] select-none print:shadow-none print:border-black"
                        >
                          {bulkShowCategory && (
                            <div className="w-full text-[9px] font-extrabold uppercase tracking-wider text-slate-500 truncate">
                              {lbl.product.category} • {lbl.product.productGroup || 'Product Item'}
                            </div>
                          )}

                          <div className="w-full text-[11px] font-bold text-slate-900 line-clamp-1 my-0.5">
                            {lbl.product.name}
                          </div>

                          {/* Code 39 Barcode Vector SVG */}
                          <div className="my-1 flex justify-center w-full">
                            <Code39BarcodeSVG
                              code={lbl.product.sku || lbl.product.barcode}
                              height={bulkColumns === 4 ? 36 : 42}
                              barWidth={bulkColumns === 4 ? 1.5 : 1.7}
                              showText={true}
                            />
                          </div>

                          <div className="w-full flex items-center justify-between text-[10px] font-mono text-slate-700 pt-0.5 border-t border-slate-200 mt-0.5">
                            <span className="font-bold text-indigo-700">{lbl.product.sku}</span>
                            {bulkShowPrice && (
                              <span className="font-extrabold text-slate-900">
                                NPR {(lbl.product.sellingPrice ?? 0).toLocaleString('en-IN')}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Footer */}
              <div className={`p-4 border-t flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 print:hidden`}>
                <button
                  type="button"
                  onClick={() => setIsBulkBarcodeModalOpen(false)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>

                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-slate-400">
                    Destination: Default PDF Printer / Save as PDF
                  </span>
                  <button
                    type="button"
                    disabled={bulkLabels.length === 0}
                    onClick={() => window.print()}
                    className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-xs shadow-md transition-all cursor-pointer"
                  >
                    <Printer className="h-4 w-4" />
                    <span>Print A4 Sheet / Save as PDF ({bulkLabels.length} Labels)</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
