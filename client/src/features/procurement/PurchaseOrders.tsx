import React, { useState, useEffect, useRef } from 'react';
import { PurchaseOrder, PurchaseInvoice, Product, Branch, POLineItem, InventoryStock, Supplier, User, CompanyProfile } from '../../types';
import { formatDualDate, convertADToBS, formatBSDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed, getAllowedBranches } from '../../utils/permissions';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import {
  ShoppingCart,
  Plus,
  Search,
  CheckCircle2,
  Trash2,
  FileText,
  X,
  AlertCircle,
  Eye,
  Building2,
  Calculator,
  Percent,
  Sparkles,
  Printer,
  XCircle,
  CheckSquare,
  RotateCcw,
  ChevronDown,
  Lock,
  Pencil,
  Clock,
  ArrowLeft,
  Calendar,
  Layers,
  AlertTriangle,
  Phone,
  MapPin,
  Building,
  Check,
  Download,
} from 'lucide-react';
import { formCardClass } from '../../components/common/FormCard';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface PurchaseOrdersProps {
  companyProfile?: CompanyProfile | null;
  purchaseInvoices?: PurchaseInvoice[];
  currentUser?: User | null;
  purchaseOrders: PurchaseOrder[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  suppliers?: Supplier[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  /** Sidebar menu that opened this page: 'create-po' opens the inline create form, 'po-list' opens the register. */
  activeTab?: 'create-po' | 'po-list';
  autoOpenModal?: boolean;
  prepopulatedLines?: OrderFormLine[];
  onCreatePO: (
    po: Omit<
      PurchaseOrder,
      'id' | 'poNumber' | 'subtotalAmount' | 'taxAmount' | 'totalAmount'
    >
  ) => Promise<void>;
  onUpdatePO?: (poId: string, poData: Partial<PurchaseOrder>) => Promise<void>;
  onUpdatePOStatus?: (poId: string, status: string) => Promise<void>;
  onDeletePO?: (poId: string) => Promise<void>;
}

export interface OrderFormLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  isTaxExempt: boolean;
}

export const PurchaseOrders: React.FC<PurchaseOrdersProps> = ({
  companyProfile,
  purchaseInvoices = [],
  currentUser,
  purchaseOrders,
  products,
  branches,
  stock,
  suppliers = [],
  selectedBranchId,
  dateMode,
  activeTab = 'po-list',
  autoOpenModal = false,
  prepopulatedLines,
  onCreatePO,
  onUpdatePO,
  onUpdatePOStatus,
  onDeletePO,
}) => {
  const { isDarkMode } = useDarkMode();
  const { confirm: confirmDialog } = useDialog();
  // Role-level gate: the inline create form is only reachable when the role may create POs
  const canCreatePoByRole = isOperationAllowed('po-create', currentUser?.role);

  // Navigation Tabs: 'PO_LIST' | 'CREATE_PO' | 'VIEW_PO'
  const [internalTab, setInternalTab] = useState<'PO_LIST' | 'CREATE_PO' | 'VIEW_PO'>(
    autoOpenModal || (activeTab === 'create-po' && canCreatePoByRole) ? 'CREATE_PO' : 'PO_LIST'
  );

  const [viewingPO, setViewingPO] = useState<PurchaseOrder | null>(null);
  const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Sync the internal page with the sidebar menu that opened this component
  useEffect(() => {
    if (autoOpenModal || (activeTab === 'create-po' && canCreatePoByRole)) {
      setInternalTab('CREATE_PO');
    } else if (activeTab === 'po-list' || (activeTab === 'create-po' && !canCreatePoByRole)) {
      setInternalTab('PO_LIST');
    }
  }, [autoOpenModal, activeTab, canCreatePoByRole]);

  // Suppliers list strictly sourced from parent master directory
  const availableSuppliers = suppliers && suppliers.length > 0 ? suppliers : [];

  // Form State
  const [supplierName, setSupplierName] = useState(availableSuppliers[0]?.name || '');
  const [supplierSearchQuery, setSupplierSearchQuery] = useState('');
  const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
  const supplierDropdownRef = useRef<HTMLDivElement>(null);

  const [branchId, setBranchId] = useState(
    selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || ''
  );
  const [taxationType, setTaxationType] = useState<'TAXABLE_13' | 'TAX_EXEMPTED'>('TAXABLE_13');
  const [expectedDeliveryDateAD, setExpectedDeliveryDateAD] = useState(
    new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]
  );
  const [billWiseDiscount, setBillWiseDiscount] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [selectedSupplierFilter, setSelectedSupplierFilter] = useState('ALL');

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
  }, [selectedBranchId, branches, currentUser]);

  // Automatically sync supplierName when availableSuppliers load
  useEffect(() => {
    if (availableSuppliers.length > 0 && (!supplierName || !availableSuppliers.some((s) => s.name === supplierName))) {
      setSupplierName(availableSuppliers[0].name);
    }
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
    if (prepopulatedLines && prepopulatedLines.length > 0) {
      return prepopulatedLines;
    }
    return [];
  });

  // Keep lines synced with prepopulatedLines prop when provided
  useEffect(() => {
    if (prepopulatedLines && prepopulatedLines.length > 0) {
      setLines(prepopulatedLines);
    }
  }, [prepopulatedLines]);

  const handleResetForm = () => {
    setEditingPO(null);
    setLines(prepopulatedLines && prepopulatedLines.length > 0 ? prepopulatedLines : []);
    setSupplierName(availableSuppliers[0]?.name || '');
    setSupplierSearchQuery('');
    setIsSupplierDropdownOpen(false);
    setBillWiseDiscount(0);
    setTaxationType('TAXABLE_13');
    setNotes('');
    setExpectedDeliveryDateAD(new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
  };

  const handleOpenCreateTab = () => {
    setEditingPO(null);
    setSupplierName(availableSuppliers[0]?.name || '');
    setSupplierSearchQuery('');
    setBranchId(selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || 'WH001');
    setTaxationType('TAXABLE_13');
    setExpectedDeliveryDateAD(new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]);
    setBillWiseDiscount(0);
    setNotes('');
    setLines(prepopulatedLines && prepopulatedLines.length > 0 ? prepopulatedLines : []);
    setInternalTab('CREATE_PO');
  };

  const handleOpenEditTab = (po: PurchaseOrder) => {
    if (
      po.status === 'IN_PROGRESS' ||
      (po.status as string) === 'INPROGRESS' ||
      po.status === 'CANCELLED' ||
      po.status === 'RECEIVED'
    ) {
      alert(`Cannot edit PO #${po.poNumber} because its status is ${po.status}.`);
      return;
    }
    setEditingPO(po);
    setSupplierName(po.supplierName);
    setBranchId(po.branchId);
    const hasTax = po.items.some((i) => i.taxAmount > 0) || (po.taxAmount ?? 0) > 0;
    setTaxationType(hasTax ? 'TAXABLE_13' : 'TAX_EXEMPTED');
    setExpectedDeliveryDateAD(po.expectedDeliveryDateAD);
    setNotes(po.notes || '');
    setBillWiseDiscount(0);
    setLines(
      po.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        discount: i.discount || 0,
        isTaxExempt: i.isTaxExempt || i.taxRate === 0,
      }))
    );
    setInternalTab('CREATE_PO');
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

  const filteredPOs = purchaseOrders.filter((po) => {
    const matchesBranch = selectedBranchId === 'ALL' || po.branchId === selectedBranchId;
    const matchesSupplier =
      selectedSupplierFilter === 'ALL' ||
      (po?.supplierName || '').toLowerCase() === (selectedSupplierFilter || '').toLowerCase() ||
      availableSuppliers.find((s) => s.id === selectedSupplierFilter)?.name.toLowerCase() === (po?.supplierName || '').toLowerCase();
    const matchesSearch =
      (po?.poNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (po?.supplierName || '').toLowerCase().includes((searchQuery || '').toLowerCase());
    return matchesBranch && matchesSupplier && matchesSearch;
  }).sort((a, b) => (b.orderDateAD || '').localeCompare(a.orderDateAD || ''));

  const poPagination = useClientPagination(filteredPOs, 15, [searchQuery, selectedBranchId, selectedSupplierFilter]);

  // Export the currently visible (filtered) Purchase Orders register to CSV
  const handleExportPOCSV = () => {
    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || selectedBranchId;

    exportToCSV({
      filename: 'Purchase_Orders_Register',
      reportTitle: 'Procurement Purchase Orders Register Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredPOs,
      columns: [
        { key: 'poNumber', label: 'PO Number' },
        { key: 'supplierName', label: 'Vendor / Supplier' },
        { key: 'branchId', label: 'Branch', formatter: (val: string) => branches.find((b) => b.id === val)?.name || val },
        { key: 'orderDateAD', label: 'Order Date (AD)' },
        {
          key: 'orderDateBS',
          label: 'Order Date (BS)',
          formatter: (_: any, row: any) => formatBSDate(row.orderDateAD || row.orderDateBS),
        },
        { key: 'expectedDeliveryDateAD', label: 'Expected Delivery (AD)' },
        {
          key: 'linkedInvoiceNumber',
          label: 'Vendor Bill #',
          formatter: (_: any, row: any) =>
            (purchaseInvoices || []).find(
              (inv) => inv.poReferenceId === row.id || inv.poReferenceId === row.poNumber
            )?.invoiceNumber || '',
        },
        { key: 'items', label: 'Items', formatter: (val: any) => (Array.isArray(val) ? val.length : 0) },
        { key: 'subtotalAmount', label: 'Subtotal (NPR)', formatter: (val: any) => Number(val || 0).toFixed(2) },
        { key: 'taxAmount', label: '13% VAT (NPR)', formatter: (val: any) => Number(val || 0).toFixed(2) },
        { key: 'totalAmount', label: 'Grand Total (NPR)', formatter: (val: any) => Number(val || 0).toFixed(2) },
        { key: 'status', label: 'PO Status' },
        { key: 'notes', label: 'Notes' },
      ],
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
  const totalVAT = taxationType === 'TAXABLE_13' ? (taxableAfterDiscount * 13) / 100 : 0;
  const grandTotal = taxableAfterDiscount + totalVAT;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) {
      alert('Please add at least one product item line before saving.');
      return;
    }

    const targetBranch = branches.find((b) => b.id === branchId);
    if (targetBranch && targetBranch.allowProcurement === false) {
      alert(
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
      const lineTax = taxationType === 'TAX_EXEMPTED' ? 0 : (netLineTotal * 13) / 100;
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
        taxRate: taxationType === 'TAX_EXEMPTED' ? 0 : 13,
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
      setEditingPO(null);
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
    setInternalTab('PO_LIST');
  };

  return (
    <div className="space-y-3" id="purchase-orders-container">
      {/* Header & Title Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2
            className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}
          >
            <ShoppingCart className="h-5 w-5 text-indigo-500" />
            <span>Purchase Orders & Supplier Procurement</span>
          </h2>
          <p className={`text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Full-width inline PO creation with 13% VAT, Bill-wise Discount, and multi-branch supplier management.
          </p>
        </div>

        {/* Top Action Buttons when in PO List */}
        <div className="flex items-center gap-2">
          {internalTab !== 'PO_LIST' && (
            <button
              type="button"
              onClick={() => setInternalTab('PO_LIST')}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs transition-all cursor-pointer bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800`}
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back to PO List</span>
            </button>
          )}

          {internalTab === 'PO_LIST' && (
            <button
              type="button"
              onClick={handleExportPOCSV}
              title="Export the visible register rows to CSV"
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs transition-all cursor-pointer bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800`}
            >
              <Download className="h-4 w-4 text-slate-500" />
              <span>Export CSV</span>
            </button>
          )}

          {internalTab === 'PO_LIST' && (() => {
            const curBranch = branches.find((b) => b.id === branchId);
            const canCreatePo = isOperationAllowed('po-create', currentUser?.role, curBranch?.allowProcurement);
            if (!canCreatePo) return null;

            return (
              <button
                type="button"
                id="btn-new-purchase-order"
                title="Issue new Purchase Order"
                onClick={handleOpenCreateTab}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/20 cursor-pointer transition-all"
              >
                <Plus className="h-4 w-4" />
                <span>New Purchase Order</span>
              </button>
            );
          })()}
        </div>
      </div>

      {/* Navigation Sub-Tabs - hidden when a dedicated sidebar menu opened this page */}
      {activeTab !== 'create-po' && activeTab !== 'po-list' && (
      <div
        className={`flex items-center gap-1.5 border-b pb-1 overflow-x-auto border-slate-200 dark:border-slate-800`}
      >
        <button
          type="button"
          id="tab-po-register"
          onClick={() => setInternalTab('PO_LIST')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${internalTab === 'PO_LIST' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <FileText className="h-4 w-4" />
          <span>1. Purchase Orders Register</span>
          <span
            className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${internalTab === 'PO_LIST' ? 'bg-indigo-800 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
          >
            {filteredPOs.length}
          </span>
        </button>

        {(() => {
          const curBranch = branches.find((b) => b.id === branchId);
          const canCreatePo = isOperationAllowed('po-create', currentUser?.role, curBranch?.allowProcurement);
          return (
            <button
              type="button"
              id="tab-po-form"
              disabled={!canCreatePo}
              title={
                !canCreatePo
                  ? 'Purchase order creation is disabled for your role permissions'
                  : 'Open full inline PO entry form'
              }
              onClick={() => {
                if (!canCreatePo) {
                  alert('Purchase Order creation is disabled for your role permissions.');
                  return;
                }
                if (internalTab !== 'CREATE_PO') {
                  handleOpenCreateTab();
                }
              }}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canCreatePo
                  ? 'opacity-40 cursor-not-allowed text-slate-400'
                  : internalTab === 'CREATE_PO'
                  ? 'bg-indigo-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canCreatePo ? <Lock className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
              <span>
                2. {editingPO ? `Edit Purchase Order (${editingPO.poNumber})` : 'Create Purchase Order (Inline Form)'}
              </span>
              {lines.length > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                    internalTab === 'CREATE_PO'
                      ? 'bg-indigo-800 text-white'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  {lines.length} items
                </span>
              )}
            </button>
          );
        })()}

        {viewingPO && (
          <button
            type="button"
            id="tab-po-view"
            onClick={() => setInternalTab('VIEW_PO')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${internalTab === 'VIEW_PO' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
          >
            <Eye className="h-4 w-4" />
            <span>3. View PO: #{viewingPO.poNumber}</span>
          </button>
        )}
      </div>
      )}

      {/* TAB 1: PURCHASE ORDERS LIST / REGISTER */}
      {internalTab === 'PO_LIST' && (
        <div className="space-y-3" id="po-list-view">
          {/* Metrics Overview Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div
              className={`rounded-2xl p-4 border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
            >
              <span className={`text-xs font-semibold text-slate-500 dark:text-slate-400`}>
                Total POs Issued
              </span>
              <div className={`text-xl font-mono font-bold mt-1 text-slate-900 dark:text-white`}>
                {filteredPOs.length} Orders
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-amber-500/30 bg-amber-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-amber-600 dark:text-amber-400`}>Pending Deliveries</span>
              <div className={`text-xl font-mono font-extrabold text-amber-600 dark:text-amber-400 mt-1`}>
                {filteredPOs.filter((p) => p.status === 'SENT' || p.status === 'APPROVED' || p.status === 'IN_PROGRESS' || (p.status as string) === 'INPROGRESS').length} Orders
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-indigo-500/30 bg-indigo-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-indigo-600 dark:text-indigo-400`}>Pending Order Value</span>
              <div className={`text-xl font-mono font-extrabold text-indigo-600 dark:text-indigo-400 mt-1`}>
                {formatNPR(filteredPOs
                  .filter((p) => p.status !== 'RECEIVED' && p.status !== 'CANCELLED')
                  .reduce((s, p) => s + (Number(p.totalAmount) || 0), 0))}
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-emerald-500/30 bg-emerald-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-emerald-600 dark:text-emerald-400`}>Received Stock Value</span>
              <div className={`text-xl font-mono font-extrabold text-emerald-600 dark:text-emerald-400 mt-1`}>
                {formatNPR(filteredPOs
                  .filter((p) => p.status === 'RECEIVED')
                  .reduce((s, p) => s + (Number(p.totalAmount) || 0), 0))}
              </div>
            </div>
          </div>

          {/* PO Search & Filter Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row items-center gap-2.5 w-full sm:w-auto flex-1">
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 sm:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search PO # or Vendor Name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full pl-9 pr-3 py-2 text-xs rounded-xl border focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                />
              </div>

              <div className="flex items-center gap-1.5 w-full sm:w-auto">
                <span className={`text-xs font-semibold whitespace-nowrap text-slate-500 dark:text-slate-400`}>
                  Filter Vendor:
                </span>
                <select
                  value={selectedSupplierFilter}
                  onChange={(e) => setSelectedSupplierFilter(e.target.value)}
                  className={`px-3 py-2 text-xs font-medium rounded-xl border focus:outline-none transition-all cursor-pointer bg-white border-slate-200 text-slate-800 focus:border-indigo-500 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:focus:border-indigo-500`}
                >
                  <option value="ALL">All Vendors / Suppliers ({availableSuppliers.length})</option>
                  {availableSuppliers.map((supp) => (
                    <option key={supp.id} value={supp.id}>
                      🏢 {supp.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
              Showing <strong className="text-slate-900 dark:text-white font-mono">{filteredPOs.length}</strong> purchase orders
            </div>
          </div>

          {/* Purchase Orders Table */}
          <div
            className={`rounded-2xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead
                  className={`sticky top-0 z-10 font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}
                >
                  <tr>
                    <th className="px-2.5 py-1.5">PO Number</th>
                    <th className="px-2.5 py-1.5">Vendor / Supplier</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">Order Date</th>
                    <th className="px-2.5 py-1.5">Expected Delivery</th>
                    <th className="px-2.5 py-1.5">Vendor Bill #</th>
                    <th className="px-2.5 py-1.5">Vendor Bill Date</th>
                    <th className="px-2.5 py-1.5 text-center">Items</th>
                    <th className="px-2.5 py-1.5 text-right">Subtotal (NPR)</th>
                    <th className="px-2.5 py-1.5 text-right">13% VAT (NPR)</th>
                    <th className="px-2.5 py-1.5 text-right">Total Amount (NPR)</th>
                    <th className="px-2.5 py-1.5 text-center">Status</th>
                    <th className="px-2.5 py-1.5 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800/80`}>
                  {filteredPOs.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="p-10 text-center text-slate-400 italic">
                        No purchase orders found matching the filter criteria. Click "Create Purchase Order" above to issue a new PO.
                      </td>
                    </tr>
                  ) : (
                    poPagination.pagedItems.map((po) => {
                      const branch = branches.find((b) => b.id === po.branchId);
                      const linkedInvoice = purchaseInvoices.find((invoice) => invoice.poReferenceId === po.id || invoice.poReferenceId === po.poNumber);
                      const isPending =
                        po.status === 'SENT' ||
                        po.status === 'APPROVED' ||
                        po.status === 'IN_PROGRESS' ||
                        (po.status as string) === 'INPROGRESS';

                      return (
                        <tr
                          key={po.id}
                          className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}
                        >
                          <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                            {po.poNumber}
                          </td>
                          <td className="p-2.5 font-bold text-slate-900 dark:text-white">
                            {po.supplierName}
                          </td>
                          <td className="p-2.5 text-slate-600 dark:text-slate-400">
                            {branch?.name || po.branchId}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {formatDualDate(po.orderDateAD, dateMode)}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {formatDualDate(po.expectedDeliveryDateAD, dateMode)}
                          </td>
                          <td className="p-2.5 font-mono text-slate-600 dark:text-slate-300">
                            {linkedInvoice?.vendorBillNumber || '—'}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {linkedInvoice ? formatDualDate(linkedInvoice.invoiceDateAD, dateMode) : '—'}
                          </td>
                          <td className="p-2.5 text-center font-mono font-semibold text-slate-700 dark:text-slate-300">
                            {po.items.length} item(s)
                          </td>
                          <td className="p-2.5 text-right font-mono font-medium text-slate-600 dark:text-slate-400">
                            {formatNPR(po.subtotalAmount)}
                          </td>
                          <td className={`p-2.5 text-right font-mono font-medium text-indigo-600 dark:text-indigo-400`}>
                            {formatNPR(po.taxAmount)}
                          </td>
                          <td className="p-2.5 text-right font-mono font-extrabold text-slate-900 dark:text-white">
                            {formatNPR(po.totalAmount)}
                          </td>
                          <td className="p-2.5 text-center">
                            <span
                              className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider border ${
                                po.status === 'RECEIVED'
                                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
                                  : po.status === 'CANCELLED'
                                  ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                                  : po.status === 'IN_PROGRESS' || (po.status as string) === 'INPROGRESS'
                                  ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                                  : 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800'
                              }`}
                            >
                              {po.status}
                            </span>
                          </td>
                          <td className="p-2.5 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              {/* View Action */}
                              <button
                                type="button"
                                onClick={() => {
                                  setViewingPO(po);
                                  setInternalTab('VIEW_PO');
                                }}
                                title="View Purchase Order Details"
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer transition-colors"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </button>

                              {isOperationAllowed('po-delete', currentUser?.role) && <button
                                type="button"
                                onClick={async () => {
                                  if (!onDeletePO || !(await confirmDialog(`Delete Purchase Order #${po.poNumber}?`))) return;
                                  try {
                                    await onDeletePO(po.id);
                                  } catch (error: any) {
                                    alert(error?.message || 'Unable to delete this purchase order.');
                                  }
                                }}
                                title="Delete Purchase Order"
                                className={`p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-600 dark:border-rose-800 dark:hover:bg-rose-950 dark:text-rose-400 cursor-pointer transition-colors`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>}

                              {/* Edit Action */}
                              {isPending && (
                                <button
                                  type="button"
                                  disabled={po.status === 'IN_PROGRESS' || (po.status as string) === 'INPROGRESS'}
                                  onClick={() => handleOpenEditTab(po)}
                                  title={
                                    po.status === 'IN_PROGRESS' || (po.status as string) === 'INPROGRESS'
                                      ? 'Cannot edit order in progress'
                                      : 'Edit Purchase Order'
                                  }
                                  className={`p-1.5 rounded-lg border transition-colors ${po.status === 'IN_PROGRESS' || (po.status as string) === 'INPROGRESS' ? 'opacity-40 cursor-not-allowed text-slate-400 border-slate-300 dark:border-slate-800' : 'border-indigo-200 hover:bg-indigo-50 text-indigo-600 cursor-pointer dark:border-indigo-800 dark:hover:bg-indigo-950 dark:text-indigo-400 dark:cursor-pointer'}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {/* In Progress Quick Action */}
                              {po.status === 'SENT' && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (onUpdatePOStatus) {
                                      await onUpdatePOStatus(po.id, 'IN_PROGRESS');
                                    }
                                  }}
                                  className="flex items-center gap-1 rounded-lg bg-amber-50 dark:bg-amber-950/60 hover:bg-amber-100 dark:hover:bg-amber-900/80 px-2 py-1 text-[11px] font-bold text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 transition-colors cursor-pointer"
                                  title="Mark order as In Progress"
                                >
                                  <Clock className="h-3.5 w-3.5" />
                                  <span>In Progress</span>
                                </button>
                              )}

                              {/* Cancel Action */}
                              {isPending && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (await confirmDialog(`Are you sure you want to cancel PO #${po.poNumber}?`)) {
                                      if (onUpdatePOStatus) {
                                        await onUpdatePOStatus(po.id, 'CANCELLED');
                                      }
                                    }
                                  }}
                                  className="flex items-center gap-1 rounded-lg bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 dark:hover:bg-rose-900/80 px-2 py-1 text-[11px] font-bold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30 transition-colors cursor-pointer"
                                  title="Cancel PO"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                  <span>Cancel</span>
                                </button>
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
            <TablePagination
              page={poPagination.page}
              pageCount={poPagination.pageCount}
              totalItems={poPagination.totalItems}
              rangeStart={poPagination.rangeStart}
              rangeEnd={poPagination.rangeEnd}
              pageSize={poPagination.pageSize}
              onPageChange={poPagination.setPage}
              onPageSizeChange={poPagination.setPageSize}
              className="mt-1"
            />
          </div>
        </div>
      )}

      {/* TAB 2: INLINE PURCHASE ORDER CREATION / EDIT FORM (FULL BODY VISIBLE) */}
      {internalTab === 'CREATE_PO' && (
        <div
          id="po-inline-form-container"
          className={`${formCardClass} space-y-6`}
        >
          {/* Form Banner Header */}
          <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800`}>
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-2xl border bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-400 dark:border-indigo-800`}>
                <ShoppingCart className="h-6 w-6" />
              </div>
              <div>
                <h3 className={`font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white`}>
                  <span>{editingPO ? `Edit Purchase Order — ${editingPO.poNumber}` : 'New Purchase Order Entry (Full Page Inline Form)'}</span>
                </h3>
                <p className={`text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
                  Scan barcodes or search products, configure quantity & unit prices, and calculate 13% VAT with bill-wise discount.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6" id="po-form-element">
            {/* Top Form Fields: Vendor, Branch, Tax Mode, Expected Delivery */}
            <div className={`grid grid-cols-1 sm:grid-cols-4 gap-3 p-3 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
              {/* Vendor Searchable Field */}
              <div className="relative" ref={supplierDropdownRef}>
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
                    className={`w-full rounded-xl border pl-9 pr-8 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-500`}
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

              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  Destination Branch *
                </label>
                <select
                  id="po-branch-select"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className={`w-full rounded-xl border px-2.5 py-1.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
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
                  className={`w-full rounded-xl border px-2.5 py-1.5 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                >
                  <option value="TAXABLE_13">Billwise 13% VAT (Taxable)</option>
                  <option value="TAX_EXEMPTED">Tax Exempted (0% Tax)</option>
                </select>
              </div>

              <div>
                <DateField
                  label="Expected Delivery Date"
                  mode={dateMode}
                  value={expectedDeliveryDateAD}
                  onChange={setExpectedDeliveryDateAD}
                  required
                  id="po-delivery-date"
                />
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
                  <span>13% Input VAT ({taxationType === 'TAXABLE_13' ? 'Applicable' : 'Tax Exempt'}):</span>
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
                    setInternalTab('PO_LIST');
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
      )}

      {/* TAB 3: PO DETAILED VIEWER (FULL PAGE INLINE DOCUMENT) */}
      {internalTab === 'VIEW_PO' && viewingPO && (
        <div
          id="po-detail-view-container"
          className={`printable-document rounded-2xl border p-6 sm:p-8 shadow-lg space-y-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
        >
          {/* Top Document Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
            <div>
              <div className="mb-3">
                <h2 className="text-lg font-serif font-extrabold text-slate-900 dark:text-white">{companyProfile?.name || 'Company profile not configured'}</h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">{companyProfile?.address || 'Registered address unavailable'}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">PAN/VAT: {companyProfile?.panVatNumber || 'Not configured'}{companyProfile?.phone ? ` | ${companyProfile.phone}` : ''}</p>
              </div>
              <div className={`flex items-center gap-2 text-xs font-bold text-indigo-600 dark:text-indigo-400 mb-1`}>
                <FileText className="h-4 w-4" />
                <span>Official Purchase Order Document</span>
              </div>
              <h3 className="text-xl font-serif font-bold text-slate-900 dark:text-white">
                {companyProfile?.legalName || companyProfile?.name || 'Inventory Management System'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Branch: {branches.find((b) => b.id === viewingPO.branchId)?.name || viewingPO.branchId}
              </p>
            </div>

            <div className="text-left sm:text-right">
              <div className={`text-base font-mono font-extrabold text-indigo-600 dark:text-indigo-400`}>
                PO #{viewingPO.poNumber}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Order Date: {viewingPO.orderDateAD} ({viewingPO.orderDateBS})
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Expected Delivery: {viewingPO.expectedDeliveryDateAD}
              </div>
            </div>
          </div>

          {/* Vendor & Status info box */}
          <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl border text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
            <div>
              <span className="font-bold text-slate-500 dark:text-slate-400 uppercase text-[10px]">
                Vendor / Supplier
              </span>
              <div className="font-bold text-slate-900 dark:text-white text-sm mt-0.5">
                {viewingPO.supplierName}
              </div>
            </div>

            <div>
              <span className="font-bold text-slate-500 dark:text-slate-400 uppercase text-[10px]">
                Order Status
              </span>
              <div className="mt-0.5">
                <span
                  className={`px-2.5 py-0.5 rounded text-[10px] font-bold uppercase border ${
                    viewingPO.status === 'RECEIVED'
                      ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700'
                      : viewingPO.status === 'CANCELLED'
                      ? 'bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-700'
                      : viewingPO.status === 'IN_PROGRESS' || (viewingPO.status as string) === 'INPROGRESS'
                      ? 'bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                      : 'bg-indigo-100 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700'
                  }`}
                >
                  {viewingPO.status}
                </span>
              </div>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100 dark:bg-slate-900 text-slate-500 font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-2.5 py-1.5">#</th>
                  <th className="px-2.5 py-1.5">Product Name</th>
                  <th className="px-2.5 py-1.5">SKU</th>
                  <th className="px-2.5 py-1.5 text-center">Qty</th>
                  <th className="px-2.5 py-1.5 text-right">Unit Rate</th>
                  <th className="px-2.5 py-1.5 text-right">Subtotal</th>
                  <th className="px-2.5 py-1.5 text-right">13% VAT</th>
                  <th className="px-2.5 py-1.5 text-right">Total Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {viewingPO.items.map((item, idx) => (
                  <tr key={idx} className="hover:bg-slate-200 dark:hover:bg-slate-800/30">
                    <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                    <td className="p-2.5 font-bold text-slate-800 dark:text-white">{item.productName}</td>
                    <td className="p-2.5 font-mono text-slate-500">{item.sku}</td>
                    <td className="p-2.5 text-center font-mono font-bold">
                      {item.quantity} {item.unit || 'Pcs'}
                    </td>
                    <td className="p-2.5 text-right font-mono">
                      {formatNPR(item.unitPrice)}
                    </td>
                    <td className="p-2.5 text-right font-mono">
                      {formatNPR(item.subtotal ?? (item.quantity * item.unitPrice))}
                    </td>
                    <td className={`p-2.5 text-right font-mono text-indigo-600 dark:text-indigo-400`}>
                      {formatNPR(item.taxAmount)}
                    </td>
                    <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                      {formatNPR(item.total ?? (item.quantity * item.unitPrice))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Remarks & Financial Totals */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="text-xs text-slate-500 max-w-sm space-y-1">
              <p className="font-semibold text-slate-700 dark:text-slate-300">
                Remarks & Terms:
              </p>
              <p className="italic">{viewingPO.notes || 'No specific remarks entered for this order.'}</p>
            </div>

            <div className="w-full sm:w-72 space-y-2 text-xs font-mono">
              <div className="flex justify-between text-slate-500">
                <span>Subtotal:</span>
                <span>{formatNPR(viewingPO.subtotalAmount)}</span>
              </div>
              <div className={`flex justify-between text-indigo-600 dark:text-indigo-400 font-semibold`}>
                <span>13% VAT:</span>
                <span>{formatNPR(viewingPO.taxAmount)}</span>
              </div>
              <div className="flex justify-between text-base font-extrabold text-slate-900 dark:text-white pt-2 border-t border-slate-200 dark:border-slate-800">
                <span>Grand Total:</span>
                <span className="text-indigo-600 dark:text-indigo-400">
                  {formatNPR(viewingPO.totalAmount)}
                </span>
              </div>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setInternalTab('PO_LIST')}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold cursor-pointer border-slate-300 text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800`}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to Register</span>
              </button>

              <button
                type="button"
                onClick={() => window.print()}
                className="flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
              >
                <Printer className="h-4 w-4" />
                <span>Print Document</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Edit Button */}
              <button
                type="button"
                disabled={
                  viewingPO.status === 'IN_PROGRESS' ||
                  (viewingPO.status as string) === 'INPROGRESS' ||
                  viewingPO.status === 'CANCELLED' ||
                  viewingPO.status === 'RECEIVED'
                }
                onClick={() => handleOpenEditTab(viewingPO)}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  viewingPO.status === 'IN_PROGRESS' ||
                  (viewingPO.status as string) === 'INPROGRESS' ||
                  viewingPO.status === 'CANCELLED' ||
                  viewingPO.status === 'RECEIVED'
                    ? 'bg-slate-100 dark:bg-slate-800/60 text-slate-400 border border-slate-300 dark:border-slate-700 cursor-not-allowed opacity-60'
                    : 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-700 hover:bg-indigo-100 cursor-pointer shadow-xs'
                }`}
              >
                <Pencil className="h-4 w-4" />
                <span>Edit PO</span>
              </button>

              {/* Set In Progress */}
              <button
                type="button"
                disabled={
                  viewingPO.status === 'IN_PROGRESS' ||
                  (viewingPO.status as string) === 'INPROGRESS' ||
                  viewingPO.status === 'CANCELLED' ||
                  viewingPO.status === 'RECEIVED'
                }
                onClick={async () => {
                  if (onUpdatePOStatus) {
                    await onUpdatePOStatus(viewingPO.id, 'IN_PROGRESS');
                  }
                  setViewingPO({ ...viewingPO, status: 'IN_PROGRESS' });
                }}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  viewingPO.status === 'IN_PROGRESS' || (viewingPO.status as string) === 'INPROGRESS'
                    ? 'bg-amber-500 text-white shadow-md shadow-amber-500/30 ring-2 ring-amber-400 cursor-not-allowed opacity-90'
                    : viewingPO.status === 'CANCELLED' || viewingPO.status === 'RECEIVED'
                    ? 'bg-slate-100 dark:bg-slate-800/60 text-slate-400 border border-slate-300 dark:border-slate-700 cursor-not-allowed opacity-60'
                    : 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 hover:bg-amber-100 cursor-pointer shadow-xs'
                }`}
              >
                <Clock className="h-4 w-4" />
                <span>
                  {viewingPO.status === 'IN_PROGRESS' || (viewingPO.status as string) === 'INPROGRESS'
                    ? 'In Progress'
                    : 'Set InProgress'}
                </span>
              </button>

              {/* Cancel PO */}
              <button
                type="button"
                disabled={viewingPO.status === 'CANCELLED' || viewingPO.status === 'RECEIVED'}
                onClick={async () => {
                  if (onUpdatePOStatus) {
                    await onUpdatePOStatus(viewingPO.id, 'CANCELLED');
                  }
                  setViewingPO({ ...viewingPO, status: 'CANCELLED' });
                }}
                className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  viewingPO.status === 'CANCELLED'
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30 ring-2 ring-rose-500 cursor-not-allowed opacity-90'
                    : viewingPO.status === 'RECEIVED'
                    ? 'bg-slate-100 dark:bg-slate-800/60 text-slate-400 border border-slate-300 dark:border-slate-700 cursor-not-allowed opacity-60'
                    : 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700 hover:bg-rose-100 cursor-pointer shadow-xs'
                }`}
              >
                <XCircle className="h-4 w-4" />
                <span>
                  {viewingPO.status === 'CANCELLED'
                    ? 'Order Cancelled'
                    : 'Set Cancelled'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
