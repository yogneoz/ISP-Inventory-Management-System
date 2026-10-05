/**
 * PurchaseOrderForm — the inline create/edit Purchase Order form (phase 4
 * extraction from PurchaseOrders.tsx).
 *
 * Owns the full PO form body: vendor search, destination branch, expected
 * delivery, taxation term, product scan/search bar, order-lines table with
 * low-stock auto-fill, bill-wise discount totals, and the create/update
 * submit. Rendering this component is equivalent to the old in-file
 * "TAB 2: INLINE PURCHASE ORDER CREATION / EDIT FORM" block.
 *
 * The parent (PurchaseOrders register) still owns the register, the PO
 * viewer, and the edit/create entry points (handleOpenEditTab feeds
 * `editingPO` in; submit reports back via onSaved).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Search,
  Trash2,
  X,
  Calculator,
  Sparkles,
  Plus,
  RotateCcw,
  ChevronDown,
  Check,
} from 'lucide-react';
import { formCardClass } from '../../components/common/FormCard';
import { DateField } from '../../components/DateField';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import { convertADToBS } from '../../utils/nepaliCalendar';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import { getAllowedBranches } from '../../utils/permissions';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { useDialog } from '../../components/common/DialogProvider';
import type {
  PurchaseOrder, Product, Branch, POLineItem, InventoryStock, Supplier, User,
} from '../../types';

export interface OrderFormLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  isTaxExempt: boolean;
}

interface PurchaseOrderFormProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  suppliers: Supplier[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  /** PO being edited (edit mode) or null (create mode). */
  editingPO: PurchaseOrder | null;
  /** Low-stock lines prepopulated from the dashboard's reorder flow. */
  prepopulatedLines?: OrderFormLine[];
  onCreatePO: (
    po: Omit<PurchaseOrder, 'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'>
  ) => Promise<void>;
  onUpdatePO?: (poId: string, poData: Partial<PurchaseOrder>) => Promise<void>;
  /** Called after a successful create/update — parent resets edit state, returns to the register and refreshes. */
  onSaved: () => void;
  /** Called on Cancel — parent resets edit state and returns to the register. */
  onCancel: () => void;
}

export const PurchaseOrderForm: React.FC<PurchaseOrderFormProps> = ({
  currentUser,
  products,
  branches,
  stock,
  suppliers,
  selectedBranchId,
  dateMode,
  editingPO,
  prepopulatedLines,
  onCreatePO,
  onUpdatePO,
  onSaved,
  onCancel,
}) => {
  const { isDarkMode } = useDarkMode();
  const { alert: alertDialog } = useDialog();
  const availableSuppliers = suppliers && suppliers.length > 0 ? suppliers : [];

  const [supplierName, setSupplierName] = useState(editingPO?.supplierName || availableSuppliers[0]?.name || '');
  const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
  const supplierDropdownRef = useRef<HTMLDivElement>(null);

  const [branchId, setBranchId] = useState(
    editingPO?.branchId || (selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || '')
  );
  const [taxationType, setTaxationType] = useState<'TAXABLE_13' | 'TAX_EXEMPTED'>(() => {
    if (editingPO) {
      const hasTax = editingPO.items.some((i) => i.taxAmount > 0) || (editingPO.taxAmount ?? 0) > 0;
      return hasTax ? 'TAXABLE_13' : 'TAX_EXEMPTED';
    }
    return 'TAXABLE_13';
  });
  const [expectedDeliveryDateAD, setExpectedDeliveryDateAD] = useState(
    editingPO?.expectedDeliveryDateAD || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
  );
  const [billWiseDiscount, setBillWiseDiscount] = useState<number>(0);
  const [notes, setNotes] = useState(editingPO?.notes || '');

  // Close supplier dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (supplierDropdownRef.current && !supplierDropdownRef.current.contains(e.target as Node)) {
        setIsSupplierDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Automatically sync branchId when branches load or selectedBranchId changes
  useEffect(() => {
    const allowed = getAllowedBranches(currentUser, branches);
    if (allowed.length > 0) {
      if (selectedBranchId !== 'ALL' && allowed.some((b) => b.id === selectedBranchId)) {
        setBranchId(selectedBranchId);
      } else if (!allowed.some((b) => b.id === branchId)) {
        setBranchId(allowed[0].id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranchId, branches, currentUser]);

  // Automatically sync supplierName when availableSuppliers load
  useEffect(() => {
    if (availableSuppliers.length > 0 && (!supplierName || !availableSuppliers.some((s) => s.name === supplierName))) {
      setSupplierName(availableSuppliers[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableSuppliers]);

  // Filtered suppliers for searchable directory picker
  const filteredSuppliers = availableSuppliers.filter((s) => {
    if (!s) return false;
    const q = (supplierName || '').trim().toLowerCase();
    if (!q) return true;
    return (
      (s?.name || '').toLowerCase().includes(q) ||
      (s?.panVatNumber && s.panVatNumber.toLowerCase().includes(q)) ||
      (s?.contactPerson && s.contactPerson.toLowerCase().includes(q)) ||
      (s?.phone && s.phone.includes(q))
    );
  });

  // Line items for POS entry (start with prepopulated lines if given, otherwise empty)
  const [lines, setLines] = useState<OrderFormLine[]>(() => {
    if (editingPO) {
      return editingPO.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discount: i.discount || 0,
        isTaxExempt: i.isTaxExempt || i.taxRate === 0,
      }));
    }
    if (prepopulatedLines && prepopulatedLines.length > 0) {
      return prepopulatedLines;
    }
    return [];
  });

  // Keep lines synced with prepopulatedLines prop when provided (create mode only)
  useEffect(() => {
    if (!editingPO && prepopulatedLines && prepopulatedLines.length > 0) {
      setLines(prepopulatedLines);
    }
  }, [prepopulatedLines, editingPO]);

  const handleResetForm = () => {
    setLines(prepopulatedLines && prepopulatedLines.length > 0 ? prepopulatedLines : []);
    setSupplierName(availableSuppliers[0]?.name || '');
    setIsSupplierDropdownOpen(false);
    setBillWiseDiscount(0);
    setTaxationType('TAXABLE_13');
    setNotes('');
    setExpectedDeliveryDateAD(new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
  };

  const handleAutoPopulateLowStock = () => {
    const lowStockProductMap = new Map<string, { product: Product; qty: number }>();

    stock.forEach((s) => {
      const prod = products.find((p) => p.id === s.productId);
      if (!prod) return;

      const branchMinReorder = s.minReorderLevel ?? prod.minReorderLevel;
      const isLow =
        branchMinReorder > 0
          ? s.quantityOnHand <= branchMinReorder
          : s.quantityOnHand <= 0;

      if (isLow) {
        const deficit =
          branchMinReorder > 0
            ? Math.max(1, branchMinReorder - s.quantityOnHand)
            : Math.abs(s.quantityOnHand);

        if (deficit <= 0) return;

        if (lowStockProductMap.has(prod.id)) {
          const curr = lowStockProductMap.get(prod.id)!;
          curr.qty += deficit;
        } else {
          lowStockProductMap.set(prod.id, { product: prod, qty: deficit });
        }
      }
    });

    const lowStockLines: OrderFormLine[] = Array.from(lowStockProductMap.values()).map(
      ({ product, qty }) => ({
        productId: product.id,
        quantity: Math.max(1, qty),
        unitPrice: product.costPrice,
        discount: 0,
        isTaxExempt: taxationType === 'TAX_EXEMPTED' || product.taxRate === 0,
      })
    );

    if (lowStockLines.length > 0) {
      setLines(lowStockLines);
    }
  };

  // Search / Scan Product Add or Increment
  const handleAddOrIncrementProduct = (prod: Product) => {
    setLines((prevLines) => {
      const existingIdx = prevLines.findIndex((l) => l.productId === prod.id);
      if (existingIdx !== -1) {
        const updated = [...prevLines];
        updated[existingIdx] = {
          ...updated[existingIdx],
          quantity: updated[existingIdx].quantity + 1,
        };
        return updated;
      } else {
        return [
          ...prevLines,
          {
            productId: prod.id,
            quantity: 1,
            unitPrice: prod.costPrice,
            discount: 0,
            isTaxExempt: taxationType === 'TAX_EXEMPTED' || prod.taxRate === 0,
          },
        ];
      }
    });
  };

  const allowedBranches = getAllowedBranches(currentUser, branches).sort((a, b) => {
    const aIsWarehouse = `${a.id} ${a.code} ${a.name}`.toLowerCase().includes('warehouse') || a.id.toLowerCase().startsWith('wh');
    const bIsWarehouse = `${b.id} ${b.code} ${b.name}`.toLowerCase().includes('warehouse') || b.id.toLowerCase().startsWith('wh');
    return Number(bIsWarehouse) - Number(aIsWarehouse);
  });

  const addLine = () => {
    const existingIds = new Set(lines.map((l) => l.productId));
    const nextProd = products.find((p) => !existingIds.has(p.id)) || products[0];
    if (!nextProd) return;

    setLines([
      ...lines,
      {
        productId: nextProd.id,
        quantity: 1,
        unitPrice: nextProd.costPrice,
        discount: 0,
        isTaxExempt: taxationType === 'TAX_EXEMPTED' || nextProd.taxRate === 0,
      },
    ]);
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLine = (index: number, field: keyof OrderFormLine, value: any) => {
    const updated = [...lines];
    if (field === 'productId') {
      const prod = products.find((p) => p.id === value);
      updated[index] = {
        ...updated[index],
        productId: value,
        unitPrice: prod?.costPrice || 0,
        isTaxExempt: taxationType === 'TAX_EXEMPTED' || prod?.taxRate === 0,
      };
    } else {
      updated[index] = { ...updated[index], [field]: value };
    }
    setLines(updated);
  };

  // Order level calculations with bill-wise discount
  const grossSubtotal = lines.reduce((acc, curr) => acc + curr.quantity * curr.unitPrice, 0);
  const taxableAfterDiscount = Math.max(0, grossSubtotal - billWiseDiscount);
  const totalVAT = taxationType === 'TAXABLE_13' ? (taxableAfterDiscount * getDefaultTaxRate()) / 100 : 0;
  const grandTotal = taxableAfterDiscount + totalVAT;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) {
      alertDialog('Please add at least one product item line before saving.');
      return;
    }

    const targetBranch = branches.find((b) => b.id === branchId);
    if (targetBranch && targetBranch.allowProcurement === false) {
      alertDialog(
        `Procurement & Purchasing permission is disabled for branch "${targetBranch.name}". Please enable it in Branch Directory.`
      );
      return;
    }

    const todayAD = new Date().toISOString().split('T')[0];
    const bsObj = convertADToBS(todayAD);
    const appliedBillDiscount = Math.min(grossSubtotal, Math.max(0, billWiseDiscount));

    const items: POLineItem[] = lines.map((l, idx) => {
      const prod = products.find((p) => p.id === l.productId);
      const lineTotal = l.quantity * l.unitPrice;
      const lineDiscount = grossSubtotal > 0 ? (lineTotal / grossSubtotal) * appliedBillDiscount : 0;
      const netLineTotal = Math.max(0, lineTotal - lineDiscount);
      const lineTax = taxationType === 'TAX_EXEMPTED' ? 0 : (netLineTotal * getDefaultTaxRate()) / 100;
      return {
        id: `poi-${Date.now()}-${idx}`,
        productId: l.productId,
        productGroup: prod?.productGroup,
        productName: prod?.name || 'Item',
        sku: prod?.sku || 'SKU',
        unit: prod?.unit || 'Pcs',
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice),
        discount: lineDiscount,
        isTaxExempt: taxationType === 'TAX_EXEMPTED',
        taxRate: taxationType === 'TAX_EXEMPTED' ? 0 : getDefaultTaxRate(),
        subtotal: netLineTotal,
        taxAmount: lineTax,
        total: lineTotal + lineTax,
      };
    });
    if (editingPO) {
      if (onUpdatePO) {
        await onUpdatePO(editingPO.id, {
          supplierName,
          branchId,
          expectedDeliveryDateAD,
          items,
          notes,
        });
      }
    } else {
      await onCreatePO({
        supplierName,
        branchId,
        orderDateAD: todayAD,
        orderDateBS: bsObj.formattedBSShort,
        expectedDeliveryDateAD,
        status: 'SENT',
        items,
        notes,
      });
    }

    handleResetForm();
    onSaved();
  };

  return (
    <div
      id="po-inline-form-container"
      className={`${formCardClass} space-y-6`}
    >
      {/* No secondary form banner by design: the sub-tab indicator
          ("2. Create Purchase Order" / "Edit Purchase Order — #") already
          communicates context, so the form goes straight to its fields. */}
      <form onSubmit={handleSubmit} className="space-y-6" id="po-form-element">
        {/* Top Form Fields: Vendor, Branch, Expected Delivery, Tax Mode.
            Rows on lg: Row 1 = Destination Branch + Expected Delivery, Row 2 = Vendor
            (full-width search), Row 3 = Taxation Term. The date field uses a compact
            max-width so the control hugs its content instead of stretching. */}
        <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 p-3 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
          {/* Vendor Searchable Field — its own row (10/12 so it doesn't dominate) */}
          <div className="relative sm:col-span-2 lg:col-span-10" ref={supplierDropdownRef}>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Vendor / Supplier Name *
            </label>
            <div className="relative w-full flex items-center">
              <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                id="po-supplier-input"
                value={supplierName}
                onFocus={() => {
                  setIsSupplierDropdownOpen(true);
                }}
                onChange={(e) => {
                  setSupplierName(e.target.value);
                  setIsSupplierDropdownOpen(true);
                }}
                placeholder="Search supplier name or PAN..."
                className={`w-full rounded-xl border pl-9 pr-8 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500`}
              />
              {supplierName ? (
                <button
                  type="button"
                  onClick={() => {
                    setSupplierName('');
                    setIsSupplierDropdownOpen(true);
                  }}
                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full cursor-pointer text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800`}
                  title="Clear vendor selection"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsSupplierDropdownOpen((prev) => !prev)}
                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 cursor-pointer text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Floating Search Dropdown Overlay */}
            {isSupplierDropdownOpen && (
              <div className={`absolute z-50 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-xl border shadow-xl border-slate-200 bg-white divide-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:divide-slate-800`}>
                {filteredSuppliers.length === 0 ? (
                  <div className="p-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                    <div>No matching supplier in directory.</div>
                    <div className={`mt-1 font-semibold text-indigo-600 dark:text-indigo-400`}>
                      Press enter or tab to use "{supplierName}".
                    </div>
                  </div>
                ) : (
                  filteredSuppliers.map((s) => {
                    const isSelected = (s?.name || '').toLowerCase() === (supplierName || '').toLowerCase();
                    return (
                      <button
                        key={s.id || s.name}
                        type="button"
                        onClick={() => {
                          setSupplierName(s.name);
                          setIsSupplierDropdownOpen(false);
                        }}
                        className={`w-full text-left p-2.5 transition-colors cursor-pointer flex items-center justify-between ${
                          isDarkMode
                            ? `hover:bg-slate-800 ${isSelected ? 'bg-indigo-950/40' : ''}`
                            : `hover:bg-indigo-50 ${isSelected ? 'bg-indigo-50/70' : ''}`
                        }`}
                      >
                        <div className="min-w-0 pr-2">
                          <div className={`font-semibold text-xs truncate text-slate-900 dark:text-white`}>
                            {s.name}
                          </div>
                          <div className={`flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-500 dark:text-slate-400`}>
                            {s.panVatNumber && <span>PAN: {s.panVatNumber}</span>}
                            {s.phone && <span>• {s.phone}</span>}
                          </div>
                        </div>
                        {isSelected && <Check className={`h-4 w-4 flex-shrink-0 text-indigo-600 dark:text-indigo-400`} />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div className="lg:col-span-4">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Destination Branch *
            </label>
            <select
              id="po-branch-select"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
            >
              {allowedBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-4 lg:max-w-[15rem]">
            <DateField
              label="Expected Delivery Date"
              mode={dateMode}
              value={expectedDeliveryDateAD}
              onChange={setExpectedDeliveryDateAD}
              required
              id="po-delivery-date"
              compact
            />
          </div>

          {/* Taxation Term — own row so the long option labels never squeeze the date fields */}
          <div className="sm:col-span-2 lg:col-span-6 lg:col-start-1 border-t pt-2 border-slate-200 dark:border-slate-800">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Taxation Term *
            </label>
            <select
              id="po-taxation-type"
              value={taxationType}
              onChange={(e) => {
                const val = e.target.value as 'TAXABLE_13' | 'TAX_EXEMPTED';
                setTaxationType(val);
                setLines(lines.map((l) => ({ ...l, isTaxExempt: val === 'TAX_EXEMPTED' })));
              }}
              className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
            >
              <option value="TAXABLE_13">Billwise {getDefaultTaxRate()}% VAT (Taxable)</option>
              <option value="TAX_EXEMPTED">Tax Exempted (0% Tax)</option>
            </select>
          </div>
        </div>

        {/* Product Search & Barcode Scan Bar */}
        <div className={`p-3 rounded-xl border space-y-2 bg-indigo-50/70 border-indigo-200 dark:bg-indigo-950/40 dark:border-indigo-800/60`}>
          <div className="flex items-center justify-between text-xs font-bold text-indigo-700 dark:text-indigo-300">
            <span className={`flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300`}>
              <Search className="h-4 w-4" />
              <span>Scan Barcode or Search & Enter Product Name / SKU:</span>
            </span>
            <span className={`text-[10px] font-normal hidden sm:inline text-slate-500 dark:text-slate-400`}>
              Scan or type item name to instantly add or increment quantity
            </span>
          </div>
          <ProductSearchBar
            products={products}
            onAddOrIncrementProduct={handleAddOrIncrementProduct}
            placeholder="Scan Barcode or Search & Enter Product Name / SKU:"
            inputId="po-product-search-input"
          />
        </div>

        {/* POS Multi-Line Table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Calculator className="h-4 w-4 text-indigo-500" />
              <span>Order Items Table ({lines.length} items)</span>
            </h4>
            <div className="flex items-center gap-2">
              <button
                type="button"
                id="btn-po-autofill-low-stock"
                onClick={handleAutoPopulateLowStock}
                className="flex items-center gap-1 text-xs font-bold text-amber-700 dark:text-amber-300 hover:underline cursor-pointer bg-amber-50 dark:bg-amber-950/50 px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800/50"
                title="Automatically populate low stock products below reorder levels"
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                <span>Auto-fill Low Stock Items</span>
              </button>
              <button
                type="button"
                id="btn-po-add-line"
                onClick={addLine}
                className={`flex items-center gap-1 text-xs font-bold text-indigo-600 bg-indigo-50 border-indigo-200 dark:text-indigo-400 dark:bg-indigo-950/50 dark:border-indigo-800/50 hover:underline cursor-pointer px-3 py-1.5 rounded-lg border`}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Item Line</span>
              </button>
            </div>
          </div>

          <div
            className={`border rounded-xl overflow-x-auto border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/30`}
          >
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}
              >
                <tr>
                  <th className="px-2.5 py-1.5 w-10 text-center">#</th>
                  <th className="px-2.5 py-1.5 min-w-[220px]">Product / Item Name & SKU</th>
                  <th className="px-2.5 py-1.5 w-28 text-center">Quantity</th>
                  <th className="px-2.5 py-1.5 w-32 text-right">Unit Rate (NPR)</th>
                  <th className="px-2.5 py-1.5 w-36 text-right">Line Total</th>
                  <th className="px-2.5 py-1.5 w-14 text-center">Action</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-400 italic">
                      No items added yet. Use the barcode scanner / search bar above or click "Add Item Line" to begin.
                    </td>
                  </tr>
                ) : (
                  lines.map((line, idx) => {
                    const prod = products.find((p) => p.id === line.productId);
                    const lineTotal = line.quantity * line.unitPrice;

                    return (
                      <tr
                        key={idx}
                        className={`transition-colors hover:bg-white dark:hover:bg-slate-800/50`}
                      >
                        <td className="p-2.5 text-center align-middle font-mono font-bold text-slate-400">
                          {idx + 1}
                        </td>
                        <td className="p-2.5">
                          <select
                            value={line.productId}
                            onChange={(e) => updateLine(idx, 'productId', e.target.value)}
                            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs font-semibold text-slate-900 dark:text-slate-100"
                          >
                            {products.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} ({p.sku}) — {p.category}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                            <span>Unit: <strong className="text-slate-700 dark:text-slate-300">{prod?.unit || 'Pcs'}</strong></span>
                            <span>•</span>
                            <span>Default Cost: <strong className="text-slate-700 dark:text-slate-300">{formatNPR(prod?.costPrice)}</strong></span>
                          </div>
                        </td>
                        <td className="p-2.5 text-center align-middle">
                          <input
                            type="number"
                            min={1}
                            required
                            value={line.quantity}
                            onChange={(e) =>
                              updateLine(idx, 'quantity', Math.max(1, Number(e.target.value)))
                            }
                            className="w-20 text-center rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 text-xs font-mono font-bold text-slate-900 dark:text-slate-100"
                          />
                        </td>
                        <td className="p-2.5 text-right align-middle">
                          <input
                            type="number"
                            min={0}
                            required
                            value={line.unitPrice}
                            onChange={(e) =>
                              updateLine(idx, 'unitPrice', Math.max(0, Number(e.target.value)))
                            }
                            className="w-28 text-right rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-1.5 text-xs font-mono font-medium text-slate-900 dark:text-slate-100"
                          />
                        </td>
                        <td className="p-2.5 text-right align-middle font-mono font-extrabold text-slate-900 dark:text-white">
                          {formatNPR(lineTotal)}
                        </td>
                        <td className="p-2.5 text-center align-middle">
                          <button
                            type="button"
                            onClick={() => removeLine(idx)}
                            className="p-1.5 text-slate-400 hover:text-rose-500 cursor-pointer transition-colors"
                            title="Remove item line"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* POS Summary Calculations & Remarks */}
        <div className={`grid grid-cols-1 md:grid-cols-2 gap-5 border-t border-slate-200 dark:border-slate-700 pt-5`}>
          <div>
            <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
              Order Remarks / Terms & Conditions
            </label>
            <textarea
              rows={5}
              id="po-remarks-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Enter dispatch instructions, payment terms, warranty terms, or vendor agreement reference..."
              className={`w-full rounded-xl border p-3 text-xs focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 border-slate-300 bg-white text-slate-900 placeholder-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500`}
            />
          </div>

          {/* Bill-wise Discount Summary Box */}
          <div
            className={`rounded-2xl p-5 border space-y-3 text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
          >
            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span className="font-semibold">Gross Subtotal:</span>
              <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                {formatNPRPrecise(grossSubtotal)}
              </span>
            </div>

            {/* Bill Wise Discount Input */}
            <div className={`flex justify-between items-center text-amber-600 bg-amber-50/70 border-amber-200/60 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-800/40 p-2.5 rounded-xl border`}>
              <span className="font-bold">Bill Wise Discount (NPR):</span>
              <input
                type="number"
                min={0}
                id="po-bill-discount-input"
                value={billWiseDiscount}
                onChange={(e) => setBillWiseDiscount(Math.max(0, Number(e.target.value)))}
                className={`w-32 text-right rounded-lg border border-amber-300 bg-white text-amber-600 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-400 px-2 py-1 text-xs font-mono font-bold focus:ring-2 focus:ring-amber-500`}
              />
            </div>

            <div className="flex justify-between items-center text-slate-600 dark:text-slate-400">
              <span>Taxable Base Subtotal:</span>
              <span className="font-mono font-bold">
                {formatNPRPrecise(taxableAfterDiscount)}
              </span>
            </div>

            <div className={`flex justify-between items-center text-indigo-600 border-slate-200 dark:text-indigo-400 dark:border-slate-800 font-semibold border-t pt-2.5`}>
              <span>{getDefaultTaxRate()}% Input VAT ({taxationType === 'TAXABLE_13' ? 'Applicable' : 'Tax Exempt'}):</span>
              <span className="font-mono font-bold">
                {formatNPRPrecise(totalVAT)}
              </span>
            </div>

            <div className="flex justify-between items-center text-base font-extrabold text-slate-900 dark:text-white pt-2.5 border-t border-slate-300 dark:border-slate-700">
              <span>Grand Total Order Amount:</span>
              <span className={`font-mono text-indigo-600 dark:text-indigo-400 text-lg`}>
                {formatNPRPrecise(grandTotal)}
              </span>
            </div>
          </div>
        </div>

        {/* Bottom Form Actions */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleResetForm}
            className="flex items-center gap-1.5 rounded-xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-xs font-bold text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer"
          >
            <RotateCcw className="h-4 w-4" />
            <span>Reset Form</span>
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                handleResetForm();
                onCancel();
              }}
              className={`rounded-xl border px-5 py-2.5 text-xs font-semibold cursor-pointer transition-colors border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`}
            >
              Cancel
            </button>

            <button
              type="submit"
              id="btn-submit-po"
              className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 cursor-pointer transition-all"
            >
              {editingPO ? 'Update & Save Purchase Order' : 'Confirm & Issue Purchase Order'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
