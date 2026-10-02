import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PurchaseOrder, PurchaseInvoice, Product, Branch, InventoryStock, Supplier, User, CompanyProfile } from '../../types';
import { formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed } from '../../utils/permissions';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR } from '../../utils/nprFormat';
import {
  ShoppingCart,
  Plus,
  Trash2,
  FileText,
  Eye,
  Printer,
  XCircle,
  Lock,
  Pencil,
  Clock,
  ArrowLeft,
  Download,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { FilterCard } from '../../components/common/FilterCard';
import { api } from '../../services/api';
import { TablePagination } from '../../components/common/TablePagination';
import { PurchaseOrderForm, type OrderFormLine } from './PurchaseOrderForm';

// Re-exported for App.tsx, which seeds the dashboard's low-stock reorder flow.
export type { OrderFormLine };

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
  const { confirm: confirmDialog } = useDialog();
  // Role-level gate: the inline create form is only reachable when the role may create POs
  const canCreatePoByRole = isOperationAllowed('po-create', currentUser?.role);

  // Navigation Tabs: 'PO_LIST' | 'CREATE_PO' | 'VIEW_PO'
  const [internalTab, setInternalTab] = useState<'PO_LIST' | 'CREATE_PO' | 'VIEW_PO'>(
    autoOpenModal || (activeTab === 'create-po' && canCreatePoByRole) ? 'CREATE_PO' : 'PO_LIST'
  );

  const [viewingPO, setViewingPO] = useState<PurchaseOrder | null>(null);
  const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);
  // Register search: the input uses a debounced draft (FilterCard); the table
  // only re-filters when the user pauses typing or presses Enter.
  const [searchQuery, setSearchQuery] = useState('');
  // Register date range on the PO order date (canonical AD values;
  // DateField converts BS picks). Empty bound = open-ended.
  const [orderDateFromAD, setOrderDateFromAD] = useState('');
  const [orderDateToAD, setOrderDateToAD] = useState('');
  // Server-side paged fetch state: the register asks /api/purchase-orders
  // for one page of filtered rows instead of filtering the whole prop array.
  const [poRows, setPoRows] = useState<PurchaseOrder[]>([]);
  const [poTotalItems, setPoTotalItems] = useState(0);
  const [poStatusCounts, setPoStatusCounts] = useState<Record<string, number>>({});
  const [poPendingValue, setPoPendingValue] = useState(0);
  const [poReceivedValue, setPoReceivedValue] = useState(0);
  const [poPage, setPoPage] = useState(1);
  const [poPageSize, setPoPageSize] = useState(15);
  const [, setPoLoading] = useState(true);
  const [poLoadError, setPoLoadError] = useState('');
  const [poRefreshKey, setPoRefreshKey] = useState(0);

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
  const [selectedSupplierFilter, setSelectedSupplierFilter] = useState('ALL');





  const matchesBranchLocal = (po: PurchaseOrder) => selectedBranchId === 'ALL' || po.branchId === selectedBranchId;
  const matchesSupplierLocal = (po: PurchaseOrder) =>
    selectedSupplierFilter === 'ALL' ||
    (po?.supplierName || '').toLowerCase() === (selectedSupplierFilter || '').toLowerCase() ||
    availableSuppliers.find((s) => s.id === selectedSupplierFilter)?.name.toLowerCase() === (po?.supplierName || '').toLowerCase();

  // Server-side paged fetch: one page of filtered PO rows plus aggregate KPIs.
  const poFetchSeq = useRef(0);
  const supplierFilterName = selectedSupplierFilter === 'ALL' || !availableSuppliers.find((s) => s.id === selectedSupplierFilter)
    ? selectedSupplierFilter === 'ALL' ? undefined : selectedSupplierFilter
    : availableSuppliers.find((s) => s.id === selectedSupplierFilter)!.name;
  const loadPoPage = useCallback(async () => {
    const seq = ++poFetchSeq.current;
    setPoLoading(true);
    setPoLoadError('');
    try {
      const envelope = await api.getPurchaseOrders({
        branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
        supplier: supplierFilterName,
        query: searchQuery.trim() || undefined,
        dateFromAD: orderDateFromAD || undefined,
        dateToAD: orderDateToAD || undefined,
        page: poPage,
        pageSize: poPageSize,
      }) as { data: PurchaseOrder[]; totalItems: number; statusCounts: Record<string, number>; pendingValue: number; receivedValue: number };
      if (seq !== poFetchSeq.current) return; // superseded
      setPoRows(envelope.data || []);
      setPoTotalItems(envelope.totalItems || 0);
      setPoStatusCounts(envelope.statusCounts || {});
      setPoPendingValue(envelope.pendingValue || 0);
      setPoReceivedValue(envelope.receivedValue || 0);
    } catch (err: any) {
      if (seq !== poFetchSeq.current) return;
      setPoLoadError(err?.message || 'Failed to load the register');
    } finally {
      if (seq === poFetchSeq.current) setPoLoading(false);
    }
  }, [selectedBranchId, supplierFilterName, searchQuery, orderDateFromAD, orderDateToAD, poPage, poPageSize]);

  useEffect(() => {
    loadPoPage();
  }, [loadPoPage, poRefreshKey]);

  // Filter changes snap the server page back to 1.
  useEffect(() => {
    setPoPage(1);
  }, [selectedBranchId, supplierFilterName, searchQuery, orderDateFromAD, orderDateToAD]);

  // Rows on screen: the server page, or (on fetch failure) the client-side
  // filtered prop array so the register degrades instead of breaking.
  const filteredPOs = poLoadError
    ? purchaseOrders.filter((po) => {
        const matchesSearch =
          (po?.poNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
          (po?.supplierName || '').toLowerCase().includes((searchQuery || '').toLowerCase());
        const day = (po?.orderDateAD || '').split('T')[0];
        const matchesDate =
          (!orderDateFromAD || (day && day >= orderDateFromAD)) &&
          (!orderDateToAD || (day && day <= orderDateToAD));
        return matchesBranchLocal(po) && matchesSupplierLocal(po) && matchesSearch && matchesDate;
      }).sort((a, b) => (b.orderDateAD || '').localeCompare(a.orderDateAD || ''))
    : poRows;

  const poPagination = {
    page: poPage,
    pageCount: Math.max(1, Math.ceil(poTotalItems / poPageSize)),
    pageSize: poPageSize,
    totalItems: poTotalItems,
    rangeStart: poTotalItems === 0 ? 0 : (poPage - 1) * poPageSize + 1,
    rangeEnd: Math.min(poPage * poPageSize, poTotalItems),
    setPage: (p: number) => setPoPage(Math.max(1, p)),
    setPageSize: (s: number) => {
      setPoPageSize(s);
      setPoPage(1);
    },
  };

  // Export all filtered Purchase Orders (not just the current page) to CSV
  const handleExportPOCSV = async () => {
    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || selectedBranchId;

    let exportRows = filteredPOs;
    if (!poLoadError) {
      try {
        const envelope = await api.getPurchaseOrders({
          branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
          supplier: supplierFilterName,
          query: searchQuery.trim() || undefined,
          dateFromAD: orderDateFromAD || undefined,
          dateToAD: orderDateToAD || undefined,
          all: true,
        }) as { data: PurchaseOrder[] };
        exportRows = envelope.data || [];
      } catch {
        // Fall back to the rows already on screen.
      }
    }

    exportToCSV({
      filename: 'Purchase_Orders_Register',
      reportTitle: 'Procurement Purchase Orders Register Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: exportRows,
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

  const handleOpenCreateTab = () => {
    setEditingPO(null);
    setInternalTab('CREATE_PO');
  };

  // Edit mode: seed the shared form with the PO being edited. The form
  // component derives supplier/branch/tax/lines from editingPO itself.
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
    setInternalTab('CREATE_PO');
  };

  return (
    <div className="space-y-3" id="purchase-orders-container">
      {/* Header & Title Section — shared PageHeader (single h2 per screen rule) */}
      <PageHeader
        title="Purchase Orders & Supplier Procurement"
        description="Full-width inline PO creation with 13% VAT, Bill-wise Discount, and multi-branch supplier management."
        icon={<ShoppingCart className="h-5 w-5 text-indigo-500" />}
        actions={
          <>
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
              const curBranch = branches.find((b) => b.id === selectedBranchId);
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
          </>
        }
      />

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
          const curBranch = branches.find((b) => b.id === selectedBranchId);
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
                {(poStatusCounts['SENT'] || 0) + (poStatusCounts['APPROVED'] || 0) + (poStatusCounts['IN_PROGRESS'] || 0) + (poStatusCounts['INPROGRESS'] || 0)} Orders
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-indigo-500/30 bg-indigo-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-indigo-600 dark:text-indigo-400`}>Pending Order Value</span>
              <div className={`text-xl font-mono font-extrabold text-indigo-600 dark:text-indigo-400 mt-1`}>
                {formatNPR(poPendingValue)}
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-emerald-500/30 bg-emerald-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-emerald-600 dark:text-emerald-400`}>Received Stock Value</span>
              <div className={`text-xl font-mono font-extrabold text-emerald-600 dark:text-emerald-400 mt-1`}>
                {formatNPR(poReceivedValue)}
              </div>
            </div>
          </div>

          {/* PO Search & Filter Card — shared inline card (no popup) */}
          <FilterCard
            searchPlaceholder="Search PO # or Vendor Name..."
            searchValue={searchQuery}
            onSearchApply={setSearchQuery}
            hasActiveFilters={
              Boolean(searchQuery) || selectedSupplierFilter !== 'ALL' || Boolean(orderDateFromAD) || Boolean(orderDateToAD)
            }
            onClearAll={() => {
              setSearchQuery('');
              setSelectedSupplierFilter('ALL');
              setOrderDateFromAD('');
              setOrderDateToAD('');
            }}
            filterChildren={
              <>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Vendor / Supplier</label>
                  <select
                    value={selectedSupplierFilter}
                    onChange={(e) => setSelectedSupplierFilter(e.target.value)}
                    className={`w-52 px-3 py-2 text-xs font-medium rounded-xl border focus:outline-none cursor-pointer bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                  >
                    <option value="ALL">All Vendors / Suppliers ({availableSuppliers.length})</option>
                    {availableSuppliers.map((supp) => (
                      <option key={supp.id} value={supp.id}>
                        🏢 {supp.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Order Date From</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={orderDateFromAD}
                      onChange={setOrderDateFromAD}
                      compact
                      showHint={false}
                      max={orderDateToAD || undefined}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Order Date To</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={orderDateToAD}
                      onChange={setOrderDateToAD}
                      compact
                      showHint={false}
                      min={orderDateFromAD || undefined}
                    />
                  </div>
                </div>
              </>
            }
            rightChildren={
              <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                Showing <strong className="text-slate-900 dark:text-white font-mono">{filteredPOs.length}</strong> purchase orders
              </span>
            }
          />

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
                    poRows.map((po) => {
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
                                    setPoRefreshKey((k) => k + 1);
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
                                      setPoRefreshKey((k) => k + 1);
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
                                        setPoRefreshKey((k) => k + 1);
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
      {/* TAB 2: INLINE PURCHASE ORDER CREATION / EDIT FORM.
          Phase 4: the form body lives in PurchaseOrderForm.tsx; this register
          owns the edit/create entry points (handleOpenEditTab seeds editingPO)
          and the post-save navigation. */}
      {internalTab === 'CREATE_PO' && (
        <PurchaseOrderForm
          currentUser={currentUser}
          products={products}
          branches={branches}
          stock={stock}
          suppliers={availableSuppliers}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          editingPO={editingPO}
          prepopulatedLines={prepopulatedLines}
          onCreatePO={onCreatePO}
          onUpdatePO={onUpdatePO}
          onSaved={() => {
            setEditingPO(null);
            setInternalTab('PO_LIST');
            setPoRefreshKey((k) => k + 1);
          }}
          onCancel={() => setEditingPO(null)}
        />
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
                    setPoRefreshKey((k) => k + 1);
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
                    setPoRefreshKey((k) => k + 1);
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
