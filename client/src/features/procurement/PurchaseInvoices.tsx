import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PurchaseInvoice,
  PurchaseOrder,
  Product,
  Branch,
  Supplier,
  InventoryStock,
  User,
  CompanyProfile,
  VendorPayment,
} from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed } from '../../utils/permissions';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import {
  Receipt,
  Plus,
  Trash2,
  FileText,
  X,
  Eye,
  AlertCircle,
  Printer,
  Download,
  Lock,
  ArrowLeft,
  PackageCheck,
  Check,
  Banknote,
  Landmark,
  Undo2,
  History,
  Loader2,
} from 'lucide-react';
import { TablePagination } from '../../components/common/TablePagination';
import { FilterCard } from '../../components/common/FilterCard';
import { PageHeader } from '../../components/common/PageHeader';
import { api } from '../../services/api';
import { PurchaseInvoiceForm } from './PurchaseInvoiceForm';

interface PurchaseInvoicesProps {
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  invoices: PurchaseInvoice[];
  products: Product[];
  branches: Branch[];
  suppliers?: Supplier[];
  stock: InventoryStock[];
  purchaseOrders?: PurchaseOrder[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  /** Sidebar menu that opened this page: 'create-purchase' opens the inline bill form, 'purchase-list' opens the register. */
  activeTab?: 'create-purchase' | 'purchase-list';
  autoOpenModal?: boolean;
  onCreateInvoice: (
    inv: Omit<PurchaseInvoice, 'id' | 'invoiceNumber'> & { poReferenceId?: string }
  ) => Promise<void>;
  onRecordPayment: (
    id: string,
    amount: number,
    paymentMethod?: string,
    details?: {
      bankName?: string;
      bankBranch?: string;
      accountNumber?: string;
      chequeNumber?: string;
      transactionReference?: string;
      paymentDateAD?: string;
    }
  ) => Promise<void>;
  onReversePayment?: (paymentId: string, reason: string) => Promise<void>;
  /** Reverses ALL posted payments of a fully paid invoice, restoring it to UNPAID. */
  onReverseInvoicePayments?: (invoiceId: string, reason: string) => Promise<void>;
  onDeleteInvoice?: (id: string) => Promise<void>;
}


export const PurchaseInvoices: React.FC<PurchaseInvoicesProps> = ({
  companyProfile,
  currentUser,
  invoices,
  products,
  branches,
  suppliers = [],
  purchaseOrders = [],
  selectedBranchId,
  dateMode,
  activeTab = 'purchase-list',
  autoOpenModal = false,
  onCreateInvoice,
  onRecordPayment,
  onReversePayment,
  onReverseInvoicePayments,
  onDeleteInvoice,
}) => {
  const { confirm: confirmDialog, prompt: promptDialog } = useDialog();
  // Suppliers list strictly sourced from master supplier directory
  const availableSuppliers = suppliers && suppliers.length > 0 ? suppliers : [];

  // Navigation Sub-tabs: 'INVOICE_LIST' | 'CREATE_INVOICE' | 'VIEW_INVOICE'
  const [internalTab, setInternalTab] = useState<'INVOICE_LIST' | 'CREATE_INVOICE' | 'VIEW_INVOICE'>(
    autoOpenModal || activeTab === 'create-purchase' ? 'CREATE_INVOICE' : 'INVOICE_LIST'
  );

  const [viewingInvoice, setViewingInvoice] = useState<PurchaseInvoice | null>(null);
  const [productsModalInvoice, setProductsModalInvoice] = useState<PurchaseInvoice | null>(null);

  // Payment State
  const [payInvoice, setPayInvoice] = useState<PurchaseInvoice | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE'>('CASH');
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  // Payment bank details (sub-ledger)
  const [bankName, setBankName] = useState('');
  const [bankBranch, setBankBranch] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [transactionReference, setTransactionReference] = useState('');
  const [paymentDateAD, setPaymentDateAD] = useState(new Date().toISOString().split('T')[0]);
  // Payment history for the current payInvoice
  const [invoicePayments, setInvoicePayments] = useState<VendorPayment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [, setReversalId] = useState<string | null>(null);
  const [, setReversalReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [vendorFilter, setVendorFilter] = useState('ALL');
  // Register date range on the bill date (canonical AD values; DateField
  // converts BS picks). Empty bound = open-ended.
  const [billDateFromAD, setBillDateFromAD] = useState('');
  const [billDateToAD, setBillDateToAD] = useState('');
  // Server-side paged fetch state: the register asks /api/purchase-invoices
  // for one page of filtered rows instead of filtering the whole prop array.
  const [piRows, setPiRows] = useState<PurchaseInvoice[]>([]);
  const [piTotalItems, setPiTotalItems] = useState(0);
  const [piSums, setPiSums] = useState({ taxable: 0, vat: 0, grand: 0, unpaid: 0 });
  const [piPage, setPiPage] = useState(1);
  const [piPageSize, setPiPageSize] = useState(15);
  const [, setPiLoading] = useState(true);
  const [piLoadError, setPiLoadError] = useState('');
  const [piRefreshKey, setPiRefreshKey] = useState(0);

  // Sync the internal page with the sidebar menu that opened this component
  useEffect(() => {
    if (autoOpenModal || activeTab === 'create-purchase') {
      setInternalTab('CREATE_INVOICE');
    } else if (activeTab === 'purchase-list') {
      setInternalTab('INVOICE_LIST');
    }
  }, [autoOpenModal, activeTab]);

  // Server-side paged fetch: one page of filtered invoice rows plus sums.
  const piFetchSeq = useRef(0);
  const loadPiPage = useCallback(async () => {
    const seq = ++piFetchSeq.current;
    setPiLoading(true);
    setPiLoadError('');
    try {
      const envelope = await api.getPurchaseInvoices({
        branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
        supplier: vendorFilter !== 'ALL' ? vendorFilter : undefined,
        query: searchQuery.trim() || undefined,
        dateFromAD: billDateFromAD || undefined,
        dateToAD: billDateToAD || undefined,
        page: piPage,
        pageSize: piPageSize,
      }) as { data: PurchaseInvoice[]; totalItems: number; sums: { taxable: number; vat: number; grand: number; unpaid: number } };
      if (seq !== piFetchSeq.current) return; // superseded
      setPiRows(envelope.data || []);
      setPiTotalItems(envelope.totalItems || 0);
      setPiSums(envelope.sums || { taxable: 0, vat: 0, grand: 0, unpaid: 0 });
    } catch (err: any) {
      if (seq !== piFetchSeq.current) return;
      setPiLoadError(err?.message || 'Failed to load the register');
    } finally {
      if (seq === piFetchSeq.current) setPiLoading(false);
    }
  }, [selectedBranchId, vendorFilter, searchQuery, billDateFromAD, billDateToAD, piPage, piPageSize]);

  useEffect(() => {
    loadPiPage();
  }, [loadPiPage, piRefreshKey]);

  // Filter changes snap the server page back to 1.
  useEffect(() => {
    setPiPage(1);
  }, [selectedBranchId, vendorFilter, searchQuery, billDateFromAD, billDateToAD]);

  // Rows on screen: the server page, or (on fetch failure) the client-side
  // filtered prop array so the register degrades instead of breaking.
  const filteredInvoices = piLoadError
    ? invoices.filter((inv) => {
        const matchesBranch = selectedBranchId === 'ALL' || inv.branchId === selectedBranchId;
        const matchesVendor =
          vendorFilter === 'ALL' ||
          (inv?.supplierName || '').toLowerCase() === (vendorFilter || '').toLowerCase();
        const matchesSearch =
          (inv?.invoiceNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
          (inv.vendorBillNumber && (inv?.vendorBillNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase())) ||
          (inv?.supplierName || '').toLowerCase().includes((searchQuery || '').toLowerCase());
        const day = (inv?.invoiceDateAD || '').split('T')[0];
        const matchesDate =
          (!billDateFromAD || (day && day >= billDateFromAD)) &&
          (!billDateToAD || (day && day <= billDateToAD));
        return matchesBranch && matchesVendor && matchesSearch && matchesDate;
      }).sort((a, b) => (b.invoiceDateAD || '').localeCompare(a.invoiceDateAD || ''))
    : piRows;

  const invoicePagination = {
    page: piPage,
    pageCount: Math.max(1, Math.ceil(piTotalItems / piPageSize)),
    pageSize: piPageSize,
    totalItems: piTotalItems,
    rangeStart: piTotalItems === 0 ? 0 : (piPage - 1) * piPageSize + 1,
    rangeEnd: Math.min(piPage * piPageSize, piTotalItems),
    setPage: (p: number) => setPiPage(Math.max(1, p)),
    setPageSize: (s: number) => {
      setPiPageSize(s);
      setPiPage(1);
    },
  };

  // Financial Metrics — server aggregate over the full filtered set (falls
  // back to page rows only when the paged fetch failed).
  const sumOr = (fn: (list: PurchaseInvoice[]) => number) => (piLoadError ? fn(filteredInvoices) : 0);
  const totalTaxable = piLoadError ? sumOr((l) => l.reduce((s, i) => s + (Number(i.taxableAmount) || 0), 0)) : piSums.taxable;
  const totalVAT = piLoadError ? sumOr((l) => l.reduce((s, i) => s + (Number(i.vatAmount) || 0), 0)) : piSums.vat;
  const totalGrand = piLoadError ? sumOr((l) => l.reduce((s, i) => s + (Number(i.grandTotal) || 0), 0)) : piSums.grand;
  const totalUnpaid = piLoadError ? sumOr((l) => l.reduce((s, i) => s + ((Number(i.grandTotal) || 0) - (Number(i.amountPaid) || 0)), 0)) : piSums.unpaid;

  // Payment status render helpers
  const paymentStatusBadge = (inv: PurchaseInvoice) => {
    const paid = Number(inv.amountPaid) || 0;
    const total = Number(inv.grandTotal) || 0;
    const status = paid >= total && total > 0 ? 'PAID' : inv.paymentStatus;
    if (status === 'PAID') {
      return (
        <span className="rounded-md px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
          PAID
        </span>
      );
    }
    if (status === 'PARTIAL') {
      return (
        <span className="rounded-md px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          PARTIAL ({formatNPR(paid)})
        </span>
      );
    }
    return (
      <span className="rounded-md px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
        UNPAID
      </span>
    );
  };

  const unpaidAmount = (inv: PurchaseInvoice) =>
    Math.max(0, (Number(inv.grandTotal) || 0) - (Number(inv.amountPaid) || 0));

  // Open the payment modal for an invoice
  const openPaymentModal = async (inv: PurchaseInvoice) => {
    setPayInvoice(inv);
    setPaymentError('');
    setPaymentMethod('CASH');
    setPaymentAmount(String(unpaidAmount(inv)));
    setBankName('');
    setBankBranch('');
    setAccountNumber('');
    setChequeNumber('');
    setTransactionReference('');
    setPaymentDateAD(new Date().toISOString().split('T')[0]);
    setReversalId(null);
    setReversalReason('');
    // Load payment history for this invoice (vendor_payments sub-ledger)
    setPaymentsLoading(true);
    setInvoicePayments([]);
    try {
      const history = await api.getInvoicePayments(inv.id);
      setInvoicePayments(history);
    } catch (_err) {
      setInvoicePayments([]);
    } finally {
      setPaymentsLoading(false);
    }
  };

  const closePaymentModal = () => {
    if (paymentSubmitting) return;
    setPayInvoice(null);
    setPaymentError('');
    setPaymentAmount('');
    setInvoicePayments([]);
    setReversalId(null);
    setReversalReason('');
  };

  const handleReversePayment = async (p: VendorPayment) => {
    const reason = await promptDialog(`Reason for reversing payment #${p.paymentNumber} (${formatNPR(p.amount)})?`);
    if (!reason || !reason.trim()) return;
    try {
      if (onReversePayment) {
        await onReversePayment(p.id, reason.trim());
      } else {
        await api.reverseVendorPayment(p.id, reason.trim());
      }
      // Refresh history + invoice
      setInvoicePayments((prev) => prev.map((item) =>
        item.id === p.id
          ? { ...item, status: 'REVERSED', reversalReason: reason.trim() }
          : item
      ));
      if (payInvoice) {
        const amountPaid = invoicePayments
          .filter((item) => item.id !== p.id)
          .reduce((sum, item) => sum + (item.status === 'POSTED' ? Number(item.amount) : 0), 0);
        setPayInvoice({ ...payInvoice, amountPaid, paymentStatus: amountPaid >= (Number(payInvoice.grandTotal) || 0) ? 'PAID' : amountPaid > 0 ? 'PARTIAL' : 'UNPAID' });
        setPaymentAmount(String(Math.max(0, (Number(payInvoice.grandTotal) || 0) - amountPaid)));
      }
      alert(`Payment #${p.paymentNumber} reversed.`);
    } catch (err: any) {
      alert(err?.message || 'Unable to reverse payment.');
    }
  };

  // Is this invoice fully settled (used to gate the "reverse full invoice" action)?
  const isFullyPaid = (inv: PurchaseInvoice) =>
    (Number(inv.grandTotal) || 0) > 0 && (Number(inv.amountPaid) || 0) >= (Number(inv.grandTotal) || 0);

  // Reverse ALL posted payments of a fully paid invoice in one audited action.
  // The server marks every payment REVERSED and resets the invoice to UNPAID.
  const handleReverseInvoicePayments = async (inv: PurchaseInvoice) => {
    const paid = Number(inv.amountPaid) || 0;
    const reason = await promptDialog(
      `Reverse ALL payments for Invoice #${inv.invoiceNumber} (${formatNPR(paid)})? This will restore the bill to UNPAID and reverse every posted payment, including any on partial invoices already at their full amount.\n\nReason:`
    );
    if (reason === null) return;
    if (!reason.trim()) {
      alert('A reversal reason is required.');
      return;
    }
    const ok = await confirmDialog(`Confirm reversing Invoice #${inv.invoiceNumber}: all posted payment(s) totaling ${formatNPR(paid)} will be reversed and the bill will be restored to UNPAID. This action is audited and cannot be undone automatically.`);
    if (!ok) return;
    try {
      if (onReverseInvoicePayments) {
        await onReverseInvoicePayments(inv.id, reason.trim());
      } else {
        await api.reverseInvoicePayments(inv.id, reason.trim());
      }
      // Refresh in-memory state so the UI reflects UNPAID immediately.
      setInvoicePayments((prev) => prev.map((item) => (item.invoiceId === inv.id ? { ...item, status: 'REVERSED', reversalReason: reason.trim() } : item)));
      if (payInvoice?.id === inv.id) {
        setPayInvoice({ ...payInvoice, amountPaid: 0, paymentStatus: 'UNPAID' });
        setPaymentAmount(String(Math.max(0, Number(payInvoice.grandTotal) || 0)));
      }
      alert(`Invoice #${inv.invoiceNumber} has been set back to UNPAID and all its payments reversed.`);
    } catch (err: any) {
      alert(err?.message || 'Unable to reverse invoice payments.');
    }
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payInvoice) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentError('Payment amount must be greater than 0.');
      return;
    }
    const remaining = unpaidAmount(payInvoice);
    if (amount > remaining) {
      setPaymentError(
        `Payment cannot exceed the outstanding balance of ${formatNPR(remaining)}.`
      );
      return;
    }
    setPaymentSubmitting(true);
    setPaymentError('');
    try {
      await onRecordPayment(payInvoice.id, amount, paymentMethod, {
        bankName,
        bankBranch,
        accountNumber,
        chequeNumber: paymentMethod === 'CHEQUE' ? chequeNumber : undefined,
        transactionReference: paymentMethod === 'BANK_TRANSFER' ? transactionReference : undefined,
        paymentDateAD,
      });
      setPaymentSubmitting(false);
      setPayInvoice(null);
      setPaymentAmount('');
      setInvoicePayments([]);
      setReversalId(null);
      setReversalReason('');
    } catch (err: any) {
      setPaymentSubmitting(false);
      setPaymentError(err?.message || 'Unable to record payment. Please try again.');
    }
  };

  // Quick "Mark as Fully Paid" action for unpaid invoices
  const handleExportCSV = async () => {
    // Export every filtered invoice, not just the current page.
    let exportRows = filteredInvoices;
    if (!piLoadError) {
      try {
        const envelope = await api.getPurchaseInvoices({
          branchId: selectedBranchId !== 'ALL' ? selectedBranchId : undefined,
          supplier: vendorFilter !== 'ALL' ? vendorFilter : undefined,
          query: searchQuery.trim() || undefined,
          dateFromAD: billDateFromAD || undefined,
          dateToAD: billDateToAD || undefined,
          all: true,
        }) as { data: PurchaseInvoice[] };
        exportRows = envelope.data || [];
      } catch {
        // Fall back to the rows already on screen.
      }
    }
    exportToCSV('Inventory_Purchase_Invoices', exportRows, [
      { label: 'System Invoice #', key: 'invoiceNumber' },
      { label: 'Vendor Bill #', key: 'vendorBillNumber' },
      { label: 'Supplier Name', key: 'supplierName' },
      {
        label: 'Branch',
        key: 'branchId',
        formatter: (val, i) => branches.find((b) => b.id === i.branchId)?.name || val,
      },
      { label: 'Bill Date (AD)', key: 'invoiceDateAD' },
      { label: 'Bill Date (BS)', key: 'invoiceDateBS' },
      {
        label: 'Taxable Amount',
        key: 'taxableAmount',
        formatter: (val) => Number(val || 0).toFixed(2),
      },
      {
        label: '13% Input VAT',
        key: 'vatAmount',
        formatter: (val) => Number(val || 0).toFixed(2),
      },
      {
        label: 'Grand Total',
        key: 'grandTotal',
        formatter: (val) => Number(val || 0).toFixed(2),
      },
      { label: 'Payment Status', key: 'paymentStatus' },
    ]);
  };

  // The form component remounts fresh on every tab switch, so no field reset is needed here.
  const handleOpenCreateTab = () => {
    setInternalTab('CREATE_INVOICE');
  };

  return (
    <div className="space-y-3" id="purchase-invoices-container">
      {/* Header Section — shared PageHeader (single h2 per screen rule) */}
      <PageHeader
        title="Purchase Invoices & Vendor Bills"
        description="Full-width inline Vendor Bill entry with live barcode scanning, device & PON serial tracking, 13% Input VAT, and PO linking."
        icon={<Receipt className="h-5 w-5 text-blue-600 dark:text-blue-400" />}
        actions={
          <>
            {internalTab !== 'INVOICE_LIST' && (
              <button
                type="button"
                onClick={() => setInternalTab('INVOICE_LIST')}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs transition-all cursor-pointer bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800`}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to Bills Register</span>
              </button>
            )}

            {internalTab === 'INVOICE_LIST' && (
              <>
                <button
                  type="button"
                  onClick={handleExportCSV}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold shadow-xs transition-all cursor-pointer bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800`}
                >
                  <Download className="h-4 w-4 text-slate-500" />
                  <span>Export CSV</span>
                </button>

                {(() => {
                  const curBranch = branches.find((b) => b.id === selectedBranchId);
                  const canCreateInvoice = isOperationAllowed('inv-create', currentUser?.role, curBranch?.allowProcurement);
                  if (!canCreateInvoice) return null;

                  return (
                    <button
                      type="button"
                      id="btn-new-purchase-bill"
                      onClick={handleOpenCreateTab}
                      className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/20 cursor-pointer transition-all"
                    >
                      <Plus className="h-4 w-4" />
                      <span>New Purchase Bill</span>
                    </button>
                  );
                })()}
              </>
            )}
          </>
        }
      />

      {/* Navigation Sub-Tabs - hidden when a dedicated sidebar menu opened this page */}
      {activeTab !== 'create-purchase' && activeTab !== 'purchase-list' && (
      <div
        className={`flex items-center gap-1.5 border-b pb-1 overflow-x-auto border-slate-200 dark:border-slate-800`}
      >
        <button
          type="button"
          id="tab-pi-register"
          onClick={() => setInternalTab('INVOICE_LIST')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${internalTab === 'INVOICE_LIST' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <FileText className="h-4 w-4" />
          <span>1. Purchase Bills Register</span>
          <span
            className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${internalTab === 'INVOICE_LIST' ? 'bg-blue-800 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
          >
            {filteredInvoices.length}
          </span>
        </button>

        {(() => {
          const curBranch = branches.find((b) => b.id === selectedBranchId);
          const canCreateInvoice = isOperationAllowed('inv-create', currentUser?.role, curBranch?.allowProcurement);
          return (
            <button
              type="button"
              id="tab-pi-form"
              disabled={!canCreateInvoice}
              title={
                !canCreateInvoice
                  ? 'Purchase Bill creation is disabled for your role permissions'
                  : 'Open full inline Purchase Bill entry form'
              }
              onClick={() => {
                if (!canCreateInvoice) {
                  alert('Purchase Invoice creation is disabled for your role permissions.');
                  return;
                }
                if (internalTab !== 'CREATE_INVOICE') {
                  handleOpenCreateTab();
                }
              }}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canCreateInvoice
                  ? 'opacity-40 cursor-not-allowed text-slate-400'
                  : internalTab === 'CREATE_INVOICE'
                  ? 'bg-blue-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canCreateInvoice ? <Lock className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
              <span>2. New Purchase Bill (Inline POS & Scan)</span>
            </button>
          );
        })()}

        {viewingInvoice && (
          <button
            type="button"
            id="tab-pi-view"
            onClick={() => setInternalTab('VIEW_INVOICE')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${internalTab === 'VIEW_INVOICE' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
          >
            <Eye className="h-4 w-4" />
            <span>3. Invoice Document: {viewingInvoice.invoiceNumber}</span>
          </button>
        )}
      </div>
      )}

      {/* TAB 1: PURCHASE BILLS REGISTER & METRICS */}
      {internalTab === 'INVOICE_LIST' && (
        <div className="space-y-3" id="pi-list-view">
          {/* Summary Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div
              className={`rounded-2xl p-4 border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
            >
              <span className={`text-xs font-semibold text-slate-500 dark:text-slate-400`}>
                Taxable Purchases
              </span>
              <div className={`text-lg font-mono font-bold mt-1 text-slate-900 dark:text-white`}>
                {formatNPRPrecise(totalTaxable)}
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-blue-500/30 bg-blue-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-blue-600 dark:text-blue-400`}>13% Input VAT</span>
              <div className={`text-lg font-mono font-extrabold text-blue-600 dark:text-blue-400 mt-1`}>
                {formatNPRPrecise(totalVAT)}
              </div>
            </div>

            <div
              className={`rounded-2xl p-4 border shadow-xs bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
            >
              <span className={`text-xs font-semibold text-slate-500 dark:text-slate-400`}>
                Grand Total
              </span>
              <div className={`text-lg font-mono font-bold mt-1 text-slate-900 dark:text-white`}>
                {formatNPRPrecise(totalGrand)}
              </div>
            </div>

            <div className="rounded-2xl p-4 border border-amber-500/30 bg-amber-500/10 shadow-xs">
              <span className={`text-xs font-semibold text-amber-600 dark:text-amber-400`}>Vendor Credit Payable</span>
              <div className={`text-lg font-mono font-extrabold text-amber-600 dark:text-amber-400 mt-1`}>
                {formatNPRPrecise(totalUnpaid)}
              </div>
            </div>
          </div>

          {/* Search & Vendor Filter Card — shared inline card */}
          <FilterCard
            searchPlaceholder="Search Invoice #, Bill # or Supplier..."
            searchValue={searchQuery}
            onSearchApply={setSearchQuery}
            hasActiveFilters={
              Boolean(searchQuery) || vendorFilter !== 'ALL' || Boolean(billDateFromAD) || Boolean(billDateToAD)
            }
            onClearAll={() => {
              setSearchQuery('');
              setVendorFilter('ALL');
              setBillDateFromAD('');
              setBillDateToAD('');
            }}
            filterChildren={
              <>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Vendor / Supplier</label>
                  <select
                    value={vendorFilter}
                    onChange={(e) => setVendorFilter(e.target.value)}
                    className={`w-52 px-3 py-2 text-xs font-medium rounded-xl border focus:outline-none cursor-pointer bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                  >
                    <option value="ALL">All Vendors / Suppliers ({availableSuppliers.length})</option>
                    {Array.from(new Set([...availableSuppliers.map((s) => s.name), ...invoices.map((i) => i.supplierName)])).map((supp) => (
                      <option key={supp} value={supp}>
                        🏢 {supp}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Bill Date From</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={billDateFromAD}
                      onChange={setBillDateFromAD}
                      compact
                      showHint={false}
                      max={billDateToAD || undefined}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Bill Date To</label>
                  <div className="w-40">
                    <DateField
                      mode={dateMode}
                      value={billDateToAD}
                      onChange={setBillDateToAD}
                      compact
                      showHint={false}
                      min={billDateFromAD || undefined}
                    />
                  </div>
                </div>
              </>
            }
            rightChildren={
              <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                Showing <strong className="text-slate-900 dark:text-white font-mono">{filteredInvoices.length}</strong> purchase bills
              </span>
            }
          />

          {/* Invoices Table */}
          <div
            className={`rounded-2xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead
                  className={`sticky top-0 z-10 font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}
                >
                  <tr>
                    <th className="px-2.5 py-1.5">System Ref #</th>
                    <th className="px-2.5 py-1.5">Vendor Bill #</th>
                    <th className="px-2.5 py-1.5">Supplier / Vendor</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">PO Order Date</th>
                    <th className="px-2.5 py-1.5">Expected Delivery</th>
                    <th className="px-2.5 py-1.5">Bill Date</th>
                    <th className="px-2.5 py-1.5 text-right">Taxable</th>
                    <th className="px-2.5 py-1.5 text-right">13% VAT</th>
                    <th className="px-2.5 py-1.5 text-right">Total Amount (NPR)</th>
                    <th className="px-2.5 py-1.5 text-center">Payment Mode</th>
                    <th className="px-2.5 py-1.5 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800/80`}>
                  {filteredInvoices.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="p-10 text-center text-slate-400 italic">
                        No purchase bills recorded. Click "New Purchase Bill" to record vendor transactions.
                      </td>
                    </tr>
                  ) : (
                    piRows.map((inv) => {
                      const branch = branches.find((b) => b.id === inv.branchId);
                      const linkedPO = purchaseOrders.find((po) => po.id === inv.poReferenceId || po.poNumber === inv.poReferenceId);
                      return (
                        <tr
                          key={inv.id}
                          className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}
                        >
                          <td className={`p-2.5 font-mono font-bold text-blue-600 dark:text-blue-400`}>
                            {inv.invoiceNumber}
                          </td>
                          <td className="p-2.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                            {inv.vendorBillNumber || '—'}
                          </td>
                          <td className="p-2.5 font-bold text-slate-900 dark:text-white">
                            {inv.supplierName}
                          </td>
                          <td className="p-2.5 text-slate-600 dark:text-slate-400">
                            {branch?.name || inv.branchId}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {linkedPO ? formatDualDate(linkedPO.orderDateAD, dateMode) : '—'}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {linkedPO ? formatDualDate(linkedPO.expectedDeliveryDateAD, dateMode) : '—'}
                          </td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                            {formatDualDate(inv.invoiceDateAD, dateMode)}
                          </td>
                          <td className="p-2.5 text-right font-mono font-medium text-slate-700 dark:text-slate-300">
                            {formatNPRPrecise(inv.taxableAmount)}
                          </td>
                          <td className={`p-2.5 text-right font-mono font-bold text-blue-600 dark:text-blue-400`}>
                            {formatNPRPrecise(inv.vatAmount)}
                          </td>
                          <td className="p-2.5 text-right font-mono font-extrabold text-slate-900 dark:text-white">
                            {formatNPRPrecise(inv.grandTotal)}
                          </td>
                          <td className="p-2.5 text-center">
                            {paymentStatusBadge(inv)}
                          </td>
                          <td className="p-2.5 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              {unpaidAmount(inv) > 0 && (
                                <button
                                  type="button"
                                  onClick={() => openPaymentModal(inv)}
                                  title={`Record Payment — ${formatNPR(unpaidAmount(inv))} outstanding`}
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 dark:hover:bg-emerald-900/80 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold cursor-pointer transition-all shadow-2xs"
                                >
                                  <Banknote className="h-3.5 w-3.5" />
                                  <span className="hidden lg:inline">Pay</span>
                                </button>
                              )}

                              {isFullyPaid(inv) && onReverseInvoicePayments && (
                                <button
                                  type="button"
                                  onClick={() => handleReverseInvoicePayments(inv)}
                                  title="Reverse all payments on this fully paid invoice (restore to UNPAID)"
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[11px] font-bold cursor-pointer transition-all shadow-2xs"
                                >
                                  <Undo2 className="h-3.5 w-3.5" />
                                  <span className="hidden lg:inline">Reverse</span>
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => setProductsModalInvoice(inv)}
                                title="View List of Products Purchased in this Invoice"
                                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/80 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold cursor-pointer transition-all shadow-2xs"
                              >
                                <PackageCheck className={`h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400`} />
                                <span className="hidden md:inline">Products ({inv.items?.length || 0})</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  setViewingInvoice(inv);
                                  setInternalTab('VIEW_INVOICE');
                                }}
                                title="View Bill Details & Print Voucher"
                                className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer transition-colors"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </button>

                              {isOperationAllowed('inv-delete', currentUser?.role) && <button
                                type="button"
                                onClick={async () => {
                                  if (!onDeleteInvoice || !(await confirmDialog(`Delete Purchase Invoice #${inv.invoiceNumber}? This will reverse its stock and remove its unassigned serial records.`))) return;
                                  try {
                                    await onDeleteInvoice(inv.id);
                                    setPiRefreshKey((k) => k + 1);
                                  } catch (error: any) {
                                    alert(error?.message || 'Unable to delete this purchase invoice.');
                                  }
                                }}
                                title="Delete Purchase Invoice"
                                className={`p-1.5 rounded-lg border border-rose-200 hover:bg-rose-50 text-rose-600 dark:border-rose-800 dark:hover:bg-rose-950 dark:text-rose-400 cursor-pointer transition-colors`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>}
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
              page={invoicePagination.page}
              pageCount={invoicePagination.pageCount}
              totalItems={invoicePagination.totalItems}
              rangeStart={invoicePagination.rangeStart}
              rangeEnd={invoicePagination.rangeEnd}
              pageSize={invoicePagination.pageSize}
              onPageChange={invoicePagination.setPage}
              onPageSizeChange={invoicePagination.setPageSize}
              className="mt-1"
            />
          </div>
        </div>
      )}

      {/* TAB 2: INLINE PURCHASE BILL CREATION FORM.
          Phase 4: the form body (and its PO-link dialogs) live in
          PurchaseInvoiceForm.tsx; this register owns navigation and refresh. */}
      {internalTab === 'CREATE_INVOICE' && (
        <PurchaseInvoiceForm
          currentUser={currentUser}
          products={products}
          branches={branches}
          suppliers={availableSuppliers}
          purchaseOrders={purchaseOrders}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          onCreateInvoice={onCreateInvoice}
          onSaved={() => setPiRefreshKey((k) => k + 1)}
          onClose={() => setInternalTab('INVOICE_LIST')}
        />
      )}

      {/* TAB 3: INVOICE DOCUMENT & VOUCHER VIEWER */}
      {internalTab === 'VIEW_INVOICE' && viewingInvoice && (
        <div
          id="pi-detail-view-container"
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
              <div className={`flex items-center gap-2 text-xs font-bold text-blue-600 dark:text-blue-400 mb-1`}>
                <Receipt className="h-4 w-4" />
                <span>Vendor Purchase Bill Document</span>
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                {viewingInvoice.supplierName}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Vendor Bill #: <strong className="text-slate-800 dark:text-slate-200">{viewingInvoice.vendorBillNumber || 'N/A'}</strong>
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Target Branch: {branches.find((b) => b.id === viewingInvoice.branchId)?.name || viewingInvoice.branchId}
              </p>
            </div>

            <div className="text-left sm:text-right">
              <div className={`text-base font-mono font-extrabold text-blue-600 dark:text-blue-400`}>
                {viewingInvoice.invoiceNumber}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Bill Date: {viewingInvoice.invoiceDateAD} ({viewingInvoice.invoiceDateBS})
              </div>
            </div>
          </div>

          {/* Items Table */}
          {viewingInvoice.items && viewingInvoice.items.length > 0 && (
            <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100 dark:bg-slate-900 text-slate-500 font-bold text-[10px] border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-2.5 py-1.5">#</th>
                    <th className="px-2.5 py-1.5">Product Name</th>
                    <th className="px-2.5 py-1.5 text-center">Qty</th>
                    <th className="px-2.5 py-1.5 text-right">Rate</th>
                    <th className="px-2.5 py-1.5 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {viewingInvoice.items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-slate-200 dark:hover:bg-slate-800/30">
                      <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                      <td className="p-2.5 font-bold text-slate-900 dark:text-white">{item.productName}</td>
                      <td className="p-2.5 text-center font-mono font-bold">
                        {item.quantity} {item.unit || 'Pcs'}
                      </td>
                      <td className="p-2.5 text-right font-mono">
                        {formatNPRPrecise(item.unitPrice)}
                      </td>
                      <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                        {formatNPRPrecise(item.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Totals & Voucher Footer */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
              <div>
                Transaction Mode: <span className={`font-bold text-amber-600 dark:text-amber-400`}>CREDIT MODE</span>
              </div>
              <div className="flex items-center gap-2">
                <span>Payment Status:</span>
                {paymentStatusBadge(viewingInvoice)}
              </div>
              {unpaidAmount(viewingInvoice) > 0 && (
                <div>
                  Outstanding Balance:{' '}
                  <span className={`font-bold text-rose-600 dark:text-rose-400`}>
                    {formatNPRPrecise(unpaidAmount(viewingInvoice))}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
              <div className="w-64 space-y-1.5 text-xs font-mono text-right">
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Taxable Base:</span>
                  <span>{formatNPRPrecise(viewingInvoice.taxableAmount)}</span>
                </div>
                <div className={`flex justify-between text-blue-600 dark:text-blue-400 font-semibold`}>
                  <span>13% VAT:</span>
                  <span>{formatNPRPrecise(viewingInvoice.vatAmount)}</span>
                </div>
                <div className="flex justify-between text-base font-extrabold text-slate-900 dark:text-white pt-2 border-t border-slate-200 dark:border-slate-800">
                  <span>Grand Total:</span>
                  <span className={`text-blue-600 dark:text-blue-400`}>
                    {formatNPRPrecise(viewingInvoice.grandTotal)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Actions Toolbar */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setInternalTab('INVOICE_LIST')}
              className={`flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold cursor-pointer border-slate-300 text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800`}
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back to Bills Register</span>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold text-xs transition-all cursor-pointer"
            >
              <Printer className="h-4 w-4" />
              <span>Print Bill Voucher (PDF)</span>
            </button>

            {unpaidAmount(viewingInvoice) > 0 && (
              <button
                type="button"
                onClick={() => openPaymentModal(viewingInvoice)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-all cursor-pointer shadow-lg shadow-emerald-600/25"
              >
                <Banknote className="h-4 w-4" />
                <span>Record Payment</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Payment Modal: Record Vendor Payment */}
      {payInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-2xl rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            <div className={`flex items-center justify-between border-b p-4 bg-slate-50 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <Banknote className={`h-5 w-5 text-emerald-600 dark:text-emerald-400`} />
                <h3 className="font-bold text-slate-900 dark:text-white text-sm">Record Vendor Payment — Sub-ledger</h3>
              </div>
              <div className="flex items-center gap-2">
                {isFullyPaid(payInvoice) && onReverseInvoicePayments && (
                  <button
                    type="button"
                    onClick={() => handleReverseInvoicePayments(payInvoice)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 text-xs font-bold transition-all cursor-pointer"
                    title="Reverse all payments on this fully paid invoice (restore to UNPAID)"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Reverse Full Invoice</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={closePaymentModal}
                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <form onSubmit={handlePaymentSubmit} className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3.5 max-h-[70vh] overflow-y-auto">
              <div className={`md:col-span-2 rounded-xl p-3 border bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800 space-y-0.5`}>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Invoice <span className="font-mono font-bold text-slate-800 dark:text-slate-200">{payInvoice.invoiceNumber}</span>
                  <span className="ml-1.5">• {payInvoice.supplierName}</span>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  Grand Total:{' '}
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {formatNPRPrecise(payInvoice.grandTotal)}
                  </span>
                  {' '}• Paid:{' '}
                  <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                    {formatNPRPrecise(payInvoice.amountPaid)}
                  </span>
                  {' '}• Outstanding:{' '}
                  <span className="font-mono font-bold text-rose-600 dark:text-rose-400">
                    {formatNPRPrecise(unpaidAmount(payInvoice))}
                  </span>
                </div>
              </div>

              {paymentError && (
                <div className="md:col-span-2 flex items-center gap-2 rounded-xl bg-rose-50 dark:bg-rose-950/60 p-3 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span className="font-medium">{paymentError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Payment Amount (NPR) *
                </label>
                <div className="relative">
                  <Banknote className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400`} />
                  <input
                    type="number"
                    required
                    min={0.01}
                    step="0.01"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    placeholder="0.00"
                    className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-9 pr-3 py-2 text-xs font-mono text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Payment Date *
                </label>
                <DateField
                  value={paymentDateAD}
                  onChange={(v) => setPaymentDateAD(v)}
                  mode="AD"
                  compact
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Payment Method
                </label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as any)}
                  className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white focus:border-emerald-500 focus:outline-none cursor-pointer`}
                >
                  <option value="CASH">Cash</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="CREDIT">Credit / Adjustment</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <div className="flex items-center gap-1.5 mb-1 text-xs font-bold text-slate-700 dark:text-slate-300">
                  <Landmark className="h-3.5 w-3.5 text-slate-400" />
                  Bank Details (for CHEQUE / BANK_TRANSFER)
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="Bank name"
                    className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none`}
                  />
                  <input
                    type="text"
                    value={bankBranch}
                    onChange={(e) => setBankBranch(e.target.value)}
                    placeholder="Bank branch"
                    className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none`}
                  />
                  <input
                    type="text"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    placeholder="Account number"
                    className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none`}
                  />
                  {paymentMethod === 'CHEQUE' ? (
                    <input
                      type="text"
                      value={chequeNumber}
                      onChange={(e) => setChequeNumber(e.target.value)}
                      placeholder="Cheque number"
                      className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none`}
                    />
                  ) : (
                    <input
                      type="text"
                      value={transactionReference}
                      onChange={(e) => setTransactionReference(e.target.value)}
                      placeholder="Transaction reference"
                      className={`w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-emerald-500 focus:outline-none`}
                    />
                  )}
                </div>
              </div>

              {/* Payment history */}
              <div className="md:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-300">
                    <History className="h-3.5 w-3.5 text-slate-400" />
                    Payment History
                  </div>
                  {paymentsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
                </div>
                {invoicePayments.length === 0 && !paymentsLoading ? (
                  <p className="text-xs text-slate-400 dark:text-slate-500 py-2">No payments recorded yet for this invoice.</p>
                ) : (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800 max-h-44 overflow-y-auto">
                    {invoicePayments.map((p) => {
                      const isReversed = p.status === 'REVERSED' || p.status === 'VOIDED';
                      return (
                        <div key={p.id} className="flex items-center justify-between px-3 py-2 text-xs">
                          <div className="space-y-0.5 min-w-0">
                            <div className="font-mono font-bold text-slate-800 dark:text-slate-200">
                              {p.paymentNumber}
                              {isReversed ? (
                                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-300">
                                  {p.status}
                                </span>
                              ) : (
                                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300">
                                  Posted
                                </span>
                              )}
                            </div>
                            <div className="text-slate-500 dark:text-slate-400">
                              {formatDualDate(p.paymentDateAD, dateMode)}
                              {' • '}
                              {p.paymentMethod}
                              {p.bankName ? ` • ${p.bankName}` : ''}
                              {p.chequeNumber ? ` • Chq ${p.chequeNumber}` : ''}
                              {p.transactionReference ? ` • Ref ${p.transactionReference}` : ''}
                            </div>
                            {isReversed && p.reversalReason && (
                              <div className="text-rose-500 dark:text-rose-400">Reversed: {p.reversalReason}</div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                              {formatNPRPrecise(p.amount)}
                            </span>
                            {!isReversed && onReversePayment && (
                              <button
                                type="button"
                                onClick={() => handleReversePayment(p)}
                                className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 cursor-pointer"
                                title="Reverse payment"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="md:col-span-2 flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closePaymentModal}
                  disabled={paymentSubmitting}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={paymentSubmitting}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all cursor-pointer shadow-lg shadow-emerald-600/25 disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {paymentSubmitting ? (
                    <>
                      <div className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Recording...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      <span>Confirm Payment</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* Purchased Products Breakdown Modal */}
      {productsModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div
            className={`w-full max-w-6xl max-h-[92vh] flex flex-col rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 bg-indigo-600 text-white">
              <div className="flex items-center gap-2.5">
                <PackageCheck className="h-5 w-5 text-amber-300" />
                <div>
                  <h3 className="font-bold text-sm">
                    Purchased Products List — Ref #{productsModalInvoice.invoiceNumber}
                  </h3>
                  <p className="text-[11px] text-indigo-100">
                    Vendor: <strong>{productsModalInvoice.supplierName}</strong> | Vendor Bill #: <strong>{productsModalInvoice.vendorBillNumber || '—'}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProductsModalInvoice(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-white cursor-pointer transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 overflow-y-auto space-y-4 flex-1">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-50 dark:bg-slate-900/60 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Invoice Date (AD)</span>
                  <span className="font-mono font-bold">{formatDualDate(productsModalInvoice.invoiceDateAD, dateMode)}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Total Items</span>
                  <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-400`}>{productsModalInvoice.items?.length ?? 0} Lines</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Taxable Subtotal</span>
                  <span className="font-mono font-bold">{formatNPRPrecise(productsModalInvoice.taxableAmount)}</span>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">Grand Total</span>
                  <span className={`font-mono font-bold text-emerald-600 dark:text-emerald-400`}>{formatNPRPrecise(productsModalInvoice.grandTotal)}</span>
                </div>
              </div>

              {/* Products Table */}
              <div className="grid gap-3 md:hidden">
                {productsModalInvoice.items?.map((item, idx) => {
                  const prod = products.find((p) => p.id === item.productId || p.sku === item.sku);
                  return (
                    <article key={item.id || idx} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-slate-900 dark:text-white">{item.productName || prod?.name}</p>
                          <p className={`text-[10px] font-mono text-indigo-600 dark:text-indigo-400`}>{item.sku || prod?.sku}</p>
                        </div>
                        <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-400`}>{item.quantity} {prod?.unit || 'Pcs'}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-[10px]">
                        <span>Unit<br /><strong>{formatNPR(item.unitPrice)}</strong></span>
                        <span>Discount<br /><strong>{formatNPR(item.discount)}</strong></span>
                        <span>Total<br /><strong className="text-emerald-600 dark:text-emerald-400">{formatNPR(item.total ?? item.quantity * item.unitPrice)}</strong></span>
                      </div>
                      {item.deviceSerials?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {item.deviceSerials.map((serial, serialIndex) => (
                            <span key={serialIndex} className="rounded bg-purple-100 dark:bg-purple-950 px-1.5 py-1 text-[9px] font-mono">
                              {serial.deviceSerial}{serial.ponSerial ? ` | ${serial.ponSerial}` : ''}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-[10px] text-slate-400 italic">Non-serialized item</span>}
                    </article>
                  );
                })}
              </div>
              <div className="hidden md:block rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                    <tr>
                      <th className="px-2.5 py-1.5">#</th>
                      <th className="px-2.5 py-1.5">Product Name & Code</th>
                      <th className="px-2.5 py-1.5 text-center">Qty Purchased</th>
                      <th className="px-2.5 py-1.5 text-right">Unit Price (NPR)</th>
                      <th className="px-2.5 py-1.5 text-right">Discount (NPR)</th>
                      <th className="px-2.5 py-1.5 text-right">Line Total (NPR)</th>
                      <th className="px-2.5 py-1.5">Serials / PON Data</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                    {productsModalInvoice.items?.map((item, idx) => {
                      const prod = products.find((p) => p.id === item.productId || p.sku === item.sku);
                      const hasSerials = item.deviceSerials && item.deviceSerials.length > 0;
                      return (
                        <tr key={item.id || idx} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                          <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                          <td className="p-2.5">
                            <span className="font-bold block text-slate-900 dark:text-white">{item.productName || prod?.name}</span>
                            <span className={`text-[10px] font-mono text-indigo-600 dark:text-indigo-400`}>
                              SKU: {item.sku || prod?.sku} | {prod?.category || 'Inventory'}
                            </span>
                          </td>
                          <td className={`p-2.5 text-center font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                            {item.quantity} {prod?.unit || 'Pcs'}
                          </td>
                          <td className="p-2.5 text-right font-mono">
                            {formatNPRPrecise(item.unitPrice)}
                          </td>
                          <td className="p-2.5 text-right font-mono text-slate-500">
                            {formatNPR(item.discount)}
                          </td>
                          <td className={`p-2.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400`}>
                            {formatNPRPrecise(item.total ?? (item.quantity * item.unitPrice))}
                          </td>
                          <td className="p-2.5">
                            {hasSerials ? (
                              <div className="space-y-1">
                                <span className="text-[10px] font-bold text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950 px-1.5 py-0.5 rounded">
                                  {item.deviceSerials?.length} Serials Scanned
                                </span>
                                <div className="max-h-16 overflow-y-auto space-y-0.5">
                                  {item.deviceSerials?.map((s, sIdx) => (
                                    <div key={sIdx} className="text-[9px] font-mono bg-slate-100 dark:bg-slate-900 px-1 py-0.2 rounded border border-slate-200 dark:border-slate-800">
                                      SN: {s.deviceSerial || '—'} {s.ponSerial ? `| PON: ${s.ponSerial}` : ''} {s.macAddress ? `| MAC: ${s.macAddress}` : ''}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <span className="text-[10px] text-slate-400 italic">Non-serialized Item</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/50">
              <div className="text-xs text-slate-500">
                Purchased list exported or saved to inventory database.
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    exportToCSV(
                      `Invoice_Products_${productsModalInvoice.invoiceNumber}`,
                      productsModalInvoice.items,
                      [
                        { key: 'productName', label: 'Product Name' },
                        { key: 'sku', label: 'SKU' },
                        { key: 'quantity', label: 'Qty' },
                        { key: 'unitPrice', label: 'Unit Price' },
                        { key: 'total', label: 'Total Price' },
                      ]
                    )
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5 text-indigo-500" />
                  <span>Export CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => setProductsModalInvoice(null)}
                  className="px-4 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-500 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
