import React, { useState, useEffect, useRef } from 'react';
import {
  PurchaseInvoice,
  PurchaseInvoiceItem,
  PurchaseOrder,
  Product,
  Branch,
  Supplier,
  InventoryStock,
  DeviceSerialPair,
  User,
  CompanyProfile,
  VendorPayment,
} from '../../types';
import { formatDualDate, convertADToBS } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed, getAllowedBranches } from '../../utils/permissions';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import {
  Receipt,
  Plus,
  Search,
  CheckCircle2,
  Trash2,
  FileText,
  X,
  CreditCard,
  Building2,
  Calculator,
  Eye,
  Tag,
  AlertCircle,
  Printer,
  Calendar,
  Barcode,
  Wifi,
  Download,
  ShoppingCart,
  Link,
  CheckSquare,
  AlertTriangle,
  Lock,
  ArrowLeft,
  PackageCheck,
  RotateCcw,
  Layers,
  ChevronDown,
  Phone,
  MapPin,
  Building,
  Check,
  Banknote,
  Landmark,
  Hash,
  Undo2,
  History,
  Loader2,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { api } from '../../services/api';

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

interface InvoiceFormLine {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  deviceSerials: DeviceSerialPair[];
}

export const PurchaseInvoices: React.FC<PurchaseInvoicesProps> = ({
  companyProfile,
  currentUser,
  invoices,
  products,
  branches,
  suppliers = [],
  stock,
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
  const [reversalId, setReversalId] = useState<string | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [vendorFilter, setVendorFilter] = useState('ALL');

  // Sync the internal page with the sidebar menu that opened this component
  useEffect(() => {
    if (autoOpenModal || activeTab === 'create-purchase') {
      setInternalTab('CREATE_INVOICE');
    } else if (activeTab === 'purchase-list') {
      setInternalTab('INVOICE_LIST');
    }
  }, [autoOpenModal, activeTab]);

  // Link Purchase Order State
  const [selectedPoId, setSelectedPoId] = useState<string>('');
  const [isPoSelectModalOpen, setIsPoSelectModalOpen] = useState<boolean>(false);
  const [poSearchQuery, setPoSearchQuery] = useState<string>('');
  const [isPoChecklistOpen, setIsPoChecklistOpen] = useState<boolean>(false);

  // Bill-wise Discount State
  const [billDiscountType, setBillDiscountType] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [billDiscountValue, setBillDiscountValue] = useState<number>(0);

  // Form State
  const [supplierName, setSupplierName] = useState(availableSuppliers[0]?.name || '');
  const [supplierId, setSupplierId] = useState<string>(availableSuppliers[0]?.id || '');
  const [supplierSearchQuery, setSupplierSearchQuery] = useState('');
  const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
  const supplierDropdownRef = useRef<HTMLDivElement>(null);

  const [vendorBillNumber, setVendorBillNumber] = useState(
    `BILL-${Math.floor(10000 + Math.random() * 90000)}`
  );
  // Purchase date (AD) — intentionally empty by default; the user must select it (never auto-filled to today)
  const [purchaseDateAD, setPurchaseDateAD] = useState('');
  const [vendorBillDateAD, setVendorBillDateAD] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [branchId, setBranchId] = useState(
    selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || ''
  );

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
      setSupplierId(availableSuppliers[0].id);
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
  const [taxationType, setTaxationType] = useState<'TAXABLE_13' | 'TAX_EXEMPTED'>('TAXABLE_13');
  const [notes, setNotes] = useState('');
  const [saveMessage, setSaveMessage] = useState('');

  // Multi-Item Bill Lines (empty by default until scanned/searched)
  const [lines, setLines] = useState<InvoiceFormLine[]>([]);

  // Pending POs list for selection
  const pendingPOs = purchaseOrders.filter(
    (po) => po.status !== 'RECEIVED' && po.status !== 'CANCELLED'
  );
  const activePO = purchaseOrders.find((po) => po.id === selectedPoId || po.poNumber === selectedPoId);

  const poValidation = (() => {
    if (!selectedPoId) return { valid: true, message: '' };
    if (!activePO) return { valid: false, message: 'Select a valid Purchase Order before saving this vendor bill.' };

    const poByProduct = new Map<string, PurchaseOrder['items'][number]>(activePO.items.map((item) => [item.productId, item]));
    const invoiceByProduct = new Map(lines.map((line) => [line.productId, line]));
    const missing = activePO.items.find((item) => !invoiceByProduct.has(item.productId));
    const extra = lines.find((line) => !poByProduct.has(line.productId));
    const exceeding = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      return poItem && line.quantity > poItem.quantity;
    });
    const quantityMismatch = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      return poItem && line.quantity !== poItem.quantity;
    });
    const typeMismatch = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      const product = products.find((item) => item.id === line.productId);
      return poItem?.productGroup && product?.productGroup !== poItem.productGroup;
    });
    if (exceeding) return { valid: false, message: `Quantity exceeding PO: ${exceeding.productName} allows only ${poByProduct.get(exceeding.productId)?.quantity}.` };
    if (missing) return { valid: false, message: `PO product missing from bill: ${missing.productName}.` };
    if (extra) return { valid: false, message: `Product not in selected PO: ${extra.productName}.` };
    if (typeMismatch) return { valid: false, message: `Product type does not match the selected PO: ${typeMismatch.productName}.` };
    if (quantityMismatch) return { valid: false, message: `Quantity must match the selected PO for ${quantityMismatch.productName}: ${poByProduct.get(quantityMismatch.productId)?.quantity} required.` };
    if (invoiceByProduct.size !== poByProduct.size) return { valid: false, message: 'PO and vendor bill products must match exactly.' };
    return { valid: true, message: '' };
  })();

  const filteredPendingPOs = pendingPOs.filter(
    (po) =>
      (po?.poNumber || '').toLowerCase().includes((poSearchQuery || '').toLowerCase()) ||
      (po?.supplierName || '').toLowerCase().includes((poSearchQuery || '').toLowerCase())
  );

  const filteredInvoices = invoices.filter((inv) => {
    const matchesBranch = selectedBranchId === 'ALL' || inv.branchId === selectedBranchId;
    const matchesVendor =
      vendorFilter === 'ALL' ||
      (inv?.supplierName || '').toLowerCase() === (vendorFilter || '').toLowerCase();
    const matchesSearch =
      (inv?.invoiceNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (inv.vendorBillNumber && (inv?.vendorBillNumber || '').toLowerCase().includes((searchQuery || '').toLowerCase())) ||
      (inv?.supplierName || '').toLowerCase().includes((searchQuery || '').toLowerCase());
    return matchesBranch && matchesVendor && matchesSearch;
  }).sort((a, b) => (b.invoiceDateAD || '').localeCompare(a.invoiceDateAD || ''));

  const invoicePagination = useClientPagination(filteredInvoices, 15, [searchQuery, vendorFilter, selectedBranchId]);
  const allowedBranches = getAllowedBranches(currentUser, branches).sort((a, b) => {
    const aIsWarehouse = `${a.id} ${a.code} ${a.name}`.toLowerCase().includes('warehouse') || a.id.toLowerCase().startsWith('wh');
    const bIsWarehouse = `${b.id} ${b.code} ${b.name}`.toLowerCase().includes('warehouse') || b.id.toLowerCase().startsWith('wh');
    return Number(bIsWarehouse) - Number(aIsWarehouse);
  });

  // Financial Metrics
  const totalTaxable = filteredInvoices.reduce((s, i) => s + (Number(i.taxableAmount) || 0), 0);
  const totalVAT = filteredInvoices.reduce((s, i) => s + (Number(i.vatAmount) || 0), 0);
  const totalGrand = filteredInvoices.reduce((s, i) => s + (Number(i.grandTotal) || 0), 0);
  const totalUnpaid = filteredInvoices.reduce(
    (s, i) => s + ((Number(i.grandTotal) || 0) - (Number(i.amountPaid) || 0)),
    0
  );

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
  const handleMarkInvoicePaid = async (inv: PurchaseInvoice) => {
    const remaining = unpaidAmount(inv);
    const ok = await confirmDialog(`Mark invoice #${inv.invoiceNumber} as fully paid (${formatNPR(remaining)})?`);
    if (!ok) return;
    try {
      await onRecordPayment(inv.id, remaining, 'CASH');
    } catch (error: any) {
      alert(error?.message || 'Unable to mark invoice as paid.');
    }
  };

  const handleResetForm = () => {
    setLines([]);
    setSelectedPoId('');
    setSupplierName(availableSuppliers[0]?.name || '');
    setSupplierId(availableSuppliers[0]?.id || '');
    setSupplierSearchQuery('');
    setIsSupplierDropdownOpen(false);
    setBillDiscountValue(0);
    setTaxationType('TAXABLE_13');
    setNotes('');
    setVendorBillNumber(`BILL-${Math.floor(10000 + Math.random() * 90000)}`);
    setVendorBillDateAD(new Date().toISOString().split('T')[0]);
    setPurchaseDateAD('');
  };

  const handleOpenCreateTab = () => {
    handleResetForm();
    setInternalTab('CREATE_INVOICE');
  };

  // Search/Scan Product Add or Duplicate Quantity Increment
  const handleAddOrIncrementProduct = (prod: Product) => {
    const isSerialized = prod.requiresSerialTracking !== false;
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    setLines((prevLines) => {
      const existingIdx = prevLines.findIndex((l) => l.productId === prod.id);
      if (existingIdx !== -1) {
        // Duplicate product entered -> Increase quantity!
        targetLineIdx = existingIdx;
        const updated = [...prevLines];
        const newQty = updated[existingIdx].quantity + 1;
        const currentSerials = [...(updated[existingIdx].deviceSerials || [])];
        if (isSerialized) {
          targetSerialIdx = currentSerials.length;
          currentSerials.push({
            deviceSerial: '',
            ponSerial: '',
          });
        }
        updated[existingIdx] = {
          ...updated[existingIdx],
          quantity: newQty,
          deviceSerials: isSerialized ? currentSerials : [],
        };
        return updated;
      } else {
        // Add new row with initial serial pair if serialized
        targetLineIdx = prevLines.length;
        targetSerialIdx = 0;
        return [
          ...prevLines,
          {
            productId: prod.id,
            productName: prod.name,
            sku: prod.sku,
            unit: prod.unit,
            quantity: 1,
            unitPrice: prod.costPrice,
            discount: 0,
            deviceSerials: isSerialized
              ? [
                  {
                    deviceSerial: '',
                    ponSerial: '',
                  },
                ]
              : [],
          },
        ];
      }
    });

    if (isSerialized) {
      setTimeout(() => {
        const el = document.getElementById(`serial-device-${targetLineIdx}-${targetSerialIdx}`) as HTMLInputElement;
        if (el) {
          el.focus();
          if ('select' in el) el.select();
        }
      }, 60);
    }
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLineQty = (index: number, newQty: number) => {
    const updated = [...lines];
    const qty = Math.max(1, newQty);
    updated[index].quantity = qty;
    const prod = products.find((p) => p.id === updated[index].productId);
    const isSerialized = prod ? prod.requiresSerialTracking !== false : true;

    if (isSerialized) {
      const currentSerials = [...(updated[index].deviceSerials || [])];
      while (currentSerials.length < qty) {
        currentSerials.push({
          deviceSerial: `SN-${updated[index].sku}-${Math.floor(100000 + Math.random() * 900000)}`,
          ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
        });
      }
      updated[index].deviceSerials = currentSerials.slice(0, qty);
    } else {
      updated[index].deviceSerials = [];
    }
    setLines(updated);
  };

  const updateLineDeviceSerial = (lineIdx: number, serialIdx: number, deviceSerial: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], deviceSerial };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLinePonSerial = (lineIdx: number, serialIdx: number, ponSerial: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], ponSerial };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLineMacAddress = (lineIdx: number, serialIdx: number, macAddress: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], macAddress };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLinePrice = (index: number, newPrice: number) => {
    const updated = [...lines];
    updated[index].unitPrice = Math.max(0, newPrice);
    setLines(updated);
  };

  // Bill-wise Calculations
  const calculatedLines = lines.map((l) => {
    const gross = l.quantity * l.unitPrice;
    return {
      ...l,
      gross,
      netSubtotal: gross,
    };
  });

  const grossSubtotal = calculatedLines.reduce((acc, curr) => acc + curr.gross, 0);

  // Bill-wise Discount calculation
  let totalDiscount = 0;
  if (billDiscountType === 'PERCENT') {
    totalDiscount = Math.min(grossSubtotal, (grossSubtotal * (billDiscountValue || 0)) / 100);
  } else {
    totalDiscount = Math.min(grossSubtotal, billDiscountValue || 0);
  }

  const netBillSubtotal = Math.max(0, grossSubtotal - totalDiscount);

  // Bill-wise Tax Rate: 13% if TAXABLE_13, 0% if TAX_EXEMPTED
  const isBillTaxable = taxationType === 'TAXABLE_13';
  const billTaxableAmount = isBillTaxable ? netBillSubtotal : 0;
  const billExemptAmount = isBillTaxable ? 0 : netBillSubtotal;
  const billVatAmount = isBillTaxable ? (netBillSubtotal * 13) / 100 : 0;
  const grandTotalCalculated = netBillSubtotal + billVatAmount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) {
      alert('Please search and add at least one product item to the purchase bill.');
      return;
    }
    if (!poValidation.valid) {
      setSaveMessage(poValidation.message);
      return;
    }

    const targetBranch = branches.find((b) => b.id === branchId);
    if (targetBranch && targetBranch.allowProcurement === false) {
      alert(
        `Procurement & Purchasing permission is disabled for branch "${targetBranch.name}". Please enable it in Branch Directory.`
      );
      return;
    }

    // Purchase date is required and the vendor bill date can never be after it
    if (!purchaseDateAD) {
      setSaveMessage('Please select the Purchase Date (AD) before saving this vendor bill.');
      return;
    }
    if (vendorBillDateAD > purchaseDateAD) {
      setSaveMessage(
        `Vendor bill date (${vendorBillDateAD}) cannot be after the purchase date (${purchaseDateAD}). Please correct the dates and try again.`
      );
      return;
    }

    const invBs = convertADToBS(purchaseDateAD);
    const vendorBillBs = convertADToBS(vendorBillDateAD);

    const items: PurchaseInvoiceItem[] = calculatedLines.map((l, idx) => ({
      id: `inv-item-${Date.now()}-${idx}`,
      productId: l.productId,
      productGroup: products.find((product) => product.id === l.productId)?.productGroup,
      productName: l.productName,
      sku: l.sku,
      unit: l.unit,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      discount: Number(l.discount),
      isTaxExempt: !isBillTaxable,
      taxRate: isBillTaxable ? 13 : 0,
      subtotal: l.netSubtotal,
      taxAmount: isBillTaxable ? (l.netSubtotal * 13) / 100 : 0,
      total: l.netSubtotal + (isBillTaxable ? (l.netSubtotal * 13) / 100 : 0),
      deviceSerials: l.deviceSerials,
    }));

    // Default to CREDIT mode transaction as requested
    await onCreateInvoice({
      supplierId,
      supplierName,
      vendorBillNumber,
      poReferenceId: selectedPoId || undefined,
      branchId,
      invoiceDateAD: purchaseDateAD,
      invoiceDateBS: invBs.formattedBSShort,
      dueDateAD: vendorBillDateAD,
      dueDateBS: vendorBillBs.formattedBSShort,
      paymentMethod: 'CREDIT',
      items,
      subtotalAmount: grossSubtotal,
      totalDiscount,
      taxableAmount: billTaxableAmount,
      vatAmount: billVatAmount,
      nonTaxableAmount: billExemptAmount,
      grandTotal: grandTotalCalculated,
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      notes: `Purchase Date: ${purchaseDateAD} (${invBs.formattedBSShort}). Vendor Bill Date: ${vendorBillDateAD} (${vendorBillBs.formattedBSShort}). ${notes}`,
    });

    setSaveMessage('Vendor bill saved successfully and purchase quantities were posted.');
    window.setTimeout(() => setSaveMessage(''), 3000);
    handleResetForm();
    window.setTimeout(() => setInternalTab('INVOICE_LIST'), 3000);
  };

  const handleExportCSV = () => {
    exportToCSV('Inventory_Purchase_Invoices', filteredInvoices, [
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

  return (
    <div className="space-y-3" id="purchase-invoices-container">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2
            className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}
          >
            <Receipt className={`h-5 w-5 text-blue-600 dark:text-blue-400`} />
            <span>Purchase Invoices & Vendor Bills</span>
          </h2>
          <p className={`text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Full-width inline Vendor Bill entry with live barcode scanning, device & PON serial tracking, 13% Input VAT, and PO linking.
          </p>
        </div>

        {/* Top Actions */}
        <div className="flex items-center gap-2">
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
                const curBranch = branches.find((b) => b.id === branchId);
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
        </div>
      </div>

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
          const curBranch = branches.find((b) => b.id === branchId);
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
              {lines.length > 0 && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                    internalTab === 'CREATE_INVOICE'
                      ? 'bg-blue-800 text-white'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  {lines.length} items
                </span>
              )}
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

          {/* Search bar & Vendor Filter */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row items-center gap-2.5 w-full sm:w-auto flex-1">
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 sm:w-80">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search Invoice #, Bill # or Supplier..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`w-full pl-9 pr-3 py-2 text-xs rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                />
              </div>

              <div className="flex items-center gap-1.5 w-full sm:w-auto">
                <span className={`text-xs font-semibold whitespace-nowrap text-slate-500 dark:text-slate-400`}>
                  Filter Vendor:
                </span>
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  className={`px-3 py-2 text-xs font-medium rounded-xl border focus:outline-none transition-all cursor-pointer bg-white border-slate-200 text-slate-800 focus:border-blue-500 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:focus:border-blue-500`}
                >
                  <option value="ALL">All Vendors / Suppliers ({availableSuppliers.length})</option>
                  {Array.from(new Set([...availableSuppliers.map((s) => s.name), ...invoices.map((i) => i.supplierName)])).map((supp) => (
                    <option key={supp} value={supp}>
                      🏢 {supp}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
              Showing <strong className="text-slate-900 dark:text-white font-mono">{filteredInvoices.length}</strong> purchase bills
            </div>
          </div>

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
                    invoicePagination.pagedItems.map((inv) => {
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

      {/* TAB 2: INLINE PURCHASE BILL CREATION FORM (FULL BODY VISIBLE) */}
      {internalTab === 'CREATE_INVOICE' && (
        <div
          id="pi-inline-form-container"
          className={`rounded-2xl border p-5 sm:p-7 shadow-lg space-y-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
        >
          {/* Form Banner Header */}
          <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800`}>
            <div className="flex items-center gap-3">
              <div className={`p-3 rounded-2xl border bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/60 dark:text-blue-400 dark:border-blue-800`}>
                <Receipt className="h-6 w-6" />
              </div>
              <div>
                <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                  Record Vendor Purchase Bill (Inline POS Entry)
                </h3>
                <p className={`text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
                  Scan barcode / enter items, assign Device Serial, PON Serial & MAC, calculate 13% VAT, and record credit transaction.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6" id="pi-form-element">
            {/* Invoice Details: compact metadata and taxation controls in one card */}
            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 p-3 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
              {/* Destination Branch is first because it determines where stock is received. */}
              <div className="lg:max-w-[11rem]">
                <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Destination Branch *
                </label>
                <select
                  id="pi-branch-select"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* Purchase Date Field (must be selected by the user; never auto-filled to today) */}
              <div className="lg:max-w-[11rem]">
                <DateField
                  label="Purchase Date"
                  mode={dateMode}
                  value={purchaseDateAD}
                  onChange={setPurchaseDateAD}
                  required
                  id="pi-purchase-date"
                  min={vendorBillDateAD || undefined}
                  compact
                  controlClassName={`h-9 ${
                    purchaseDateAD && vendorBillDateAD > purchaseDateAD
                      ? 'border-rose-400 dark:border-rose-700'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                />
              </div>

              {/* Vendor Searchable Field */}
              <div className="relative sm:col-span-2 lg:col-span-2" ref={supplierDropdownRef}>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  Supplier / Vendor *
                </label>
                <div className="relative w-full flex items-center">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    required
                    id="pi-supplier-input"
                    value={supplierName}
                    onFocus={() => {
                      setIsSupplierDropdownOpen(true);
                    }}
                    onChange={(e) => {
                      setSupplierName(e.target.value);
                      // If the typed text exactly matches a directory supplier, keep its id for the FK.
                      const exact = availableSuppliers.find((s) => s.name.toLowerCase() === e.target.value.trim().toLowerCase());
                      setSupplierId(exact?.id || '');
                      setIsSupplierDropdownOpen(true);
                    }}
                    placeholder="Search supplier name or PAN..."
                    className={`w-full rounded-xl border pl-9 pr-8 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
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
                  <div className={`absolute z-50 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-xl border shadow-xl divide-y border-slate-200 bg-white divide-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:divide-slate-800`}>
                    {filteredSuppliers.length === 0 ? (
                      <div className="p-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                        <div>No matching supplier in directory.</div>
                        <div className={`mt-1 font-semibold text-blue-600 dark:text-blue-400`}>
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
                              setSupplierId(s.id);
                              setIsSupplierDropdownOpen(false);
                            }}
                            className={`w-full text-left p-2.5 hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-between ${
                              isSelected ? 'bg-blue-50/70 dark:bg-blue-950/40' : ''
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
                            {isSelected && <Check className={`h-4 w-4 flex-shrink-0 text-blue-600 dark:text-blue-400`} />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div className="lg:max-w-[11rem]">
                <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Vendor Bill / Invoice # *
                </label>
                <input
                  type="text"
                  required
                  id="pi-vendor-bill-number"
                  value={vendorBillNumber}
                  onChange={(e) => setVendorBillNumber(e.target.value)}
                  placeholder="e.g. BILL-99201"
                  className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-mono font-bold focus:outline-none focus:ring-2 focus:ring-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                />
              </div>

              <div className="lg:max-w-[11rem]">
                <DateField
                  label="Vendor Bill Date"
                  mode={dateMode}
                  value={vendorBillDateAD}
                  onChange={setVendorBillDateAD}
                  required
                  id="pi-vendor-bill-date"
                  max={purchaseDateAD || undefined}
                  compact
                  controlClassName={`h-9 purchaseDateAD && vendorBillDateAD > purchaseDateAD ? border-rose-400 dark:border-rose-700 : border-slate-300 dark:border-slate-700`}
                />
                {purchaseDateAD && vendorBillDateAD > purchaseDateAD && (
                  <div className={`mt-1 text-[10px] font-bold text-rose-600 dark:text-rose-400`}>
                    Bill date is after the purchase date — bill cannot be saved.
                  </div>
                )}
              </div>

              {/* Whole Bill Taxation Terms Selection */}
              <div className={`sm:col-span-2 lg:col-span-6 border-t pt-2 border-slate-200 dark:border-slate-800`}>
              <span className={`block text-[10px] font-bold uppercase tracking-wider mb-1.5 text-slate-500 dark:text-slate-400`}>
                Whole-Bill Taxation Mode
              </span>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pi-tax-mode"
                    value="TAXABLE_13"
                    checked={taxationType === 'TAXABLE_13'}
                    onChange={() => setTaxationType('TAXABLE_13')}
                    className={`h-4 w-4 text-blue-600 dark:text-blue-400 focus:ring-blue-500`}
                  />
                  <span className={`font-bold text-slate-900 dark:text-white`}>
                    13% Taxable Bill (Standard VAT Applicable)
                  </span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pi-tax-mode"
                    value="TAX_EXEMPTED"
                    checked={taxationType === 'TAX_EXEMPTED'}
                    onChange={() => setTaxationType('TAX_EXEMPTED')}
                    className={`h-4 w-4 text-blue-600 dark:text-blue-400 focus:ring-blue-500`}
                  />
                  <span className={`font-bold text-slate-900 dark:text-white`}>
                    Tax Exempted Bill (0% Tax / Non-Taxable)
                  </span>
                </label>
              </div>
            </div>

            {/* Purchase Order Linking — kept in the same compact invoice details card */}
            <div className={`sm:col-span-2 lg:col-span-6 border-t pt-2 border-indigo-200 dark:border-indigo-800/60`}>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300`}>
                    <ShoppingCart className="h-4 w-4" />
                  </div>
                  <div>
                    <div className={`text-[11px] font-bold text-indigo-950 dark:text-indigo-200`}>
                      Link Existing Purchase Order Reference (Optional)
                    </div>
                    <div className={`text-[10px] text-indigo-800/80 dark:text-indigo-400`}>
                      {activePO ? (
                        <span className="font-semibold">
                          Linked to <strong className="text-indigo-950 dark:text-white">PO #{activePO.poNumber}</strong> ({activePO.supplierName} • {activePO.items.length} item lines)
                        </span>
                      ) : (
                        'Link a PO to verify items against order and track fulfillment in real-time.'
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIsPoSelectModalOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[11px] shadow-xs transition-colors cursor-pointer"
                  >
                    <Link className="h-3.5 w-3.5" />
                    <span>{activePO ? 'Change Linked PO' : 'Link / Import PO'}</span>
                  </button>

                  {activePO && (
                    <>
                      <button
                        type="button"
                        onClick={() => setIsPoChecklistOpen(true)}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/60 hover:bg-indigo-200 text-indigo-800 dark:text-indigo-200 font-bold text-xs border border-indigo-300 dark:border-indigo-700 transition-colors cursor-pointer"
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                        <span>PO Item Checklist</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setSelectedPoId('')}
                        className={`p-1.5 rounded-xl transition-colors cursor-pointer text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:text-slate-400 dark:hover:text-rose-400 dark:hover:bg-rose-950`}
                        title="Unlink PO"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            </div>

            {/* Product Search & Barcode Scan Bar */}
            <div className={`p-4 rounded-xl border space-y-2 bg-blue-50/70 border-blue-200 dark:bg-blue-950/40 dark:border-blue-800/60`}>
              <div className={`flex items-center justify-between text-xs font-bold text-blue-700 dark:text-blue-300`}>
                <span className="flex items-center gap-1.5">
                  <Search className="h-4 w-4" />
                  <span>Scan Barcode or Search & Enter Product Name / SKU:</span>
                </span>
                <span className={`text-[11px] font-normal hidden sm:inline text-slate-500 dark:text-slate-400`}>
                  Scan barcode to add item row and autofocus Device Serial number
                </span>
              </div>
              <ProductSearchBar
                products={products}
                onAddOrIncrementProduct={handleAddOrIncrementProduct}
                placeholder="Scan barcode or type code/item name and press Enter to add..."
                inputId="purchase-product-search-input"
              />
            </div>

            {/* POS Multi-Line Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-slate-700 dark:text-slate-300`}>
                  <Calculator className="h-4 w-4 text-blue-500" />
                  <span>Bill Items Table ({lines.length} items)</span>
                </h4>
                <span className={`text-[11px] text-slate-500 dark:text-slate-400`}>
                  Transaction Mode: <strong className="text-amber-600 dark:text-amber-400">CREDIT</strong>
                </span>
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
                      <th className="px-2.5 py-1.5 min-w-[220px]">Product Name</th>
                      <th className="px-2.5 py-1.5 w-28">SKU</th>
                      <th className="px-2.5 py-1.5 w-28 text-center">Qty</th>
                      <th className="px-2.5 py-1.5 w-32 text-right">Cost Rate (NPR)</th>
                      <th className="px-2.5 py-1.5 w-36 text-right">Line Subtotal (NPR)</th>
                      <th className="px-2.5 py-1.5 w-14 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className={`p-8 text-center italic text-slate-400 dark:text-slate-500`}>
                          No items added yet. Use the product search & barcode scan bar above to scan or enter items.
                        </td>
                      </tr>
                    ) : (
                      calculatedLines.map((line, idx) => (
                        <React.Fragment key={line.productId}>
                          <tr
                            className={`transition-colors hover:bg-white dark:hover:bg-slate-800/50`}
                          >
                            <td className="p-2.5 text-center font-mono font-bold text-slate-400">
                              {idx + 1}
                            </td>
                            <td className={`p-2.5 font-bold text-slate-900 dark:text-white`}>
                              <div>{line.productName}</div>
                              {activePO && (() => {
                                const poItem = activePO.items.find((p) => p.productId === line.productId);
                                if (poItem) {
                                  const isExact = line.quantity === poItem.quantity;
                                  const isExceed = line.quantity > poItem.quantity;
                                  return (
                                    <div
                                      className={`mt-1 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border 'isExact
                                          ? isDarkMode ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700' : 'bg-emerald-100 text-emerald-800 border-emerald-300'
                                          : isExceed ? bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700 : bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700'`}
                                    >
                                      <CheckCircle2 className="h-3 w-3" />
                                      <span>In PO #{activePO.poNumber} (Ordered: {poItem.quantity})</span>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <div className={`mt-1 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700`}>
                                      <AlertTriangle className={`h-3 w-3 text-amber-600 dark:text-amber-500`} />
                                      <span>⚠️ Extra / Not in PO #{activePO.poNumber}</span>
                                    </div>
                                  );
                                }
                              })()}
                              {(() => {
                                const prod = products.find((p) => p.id === line.productId);
                                const isSerialized = prod ? prod.requiresSerialTracking !== false : true;
                                return isSerialized ? (
                                  <div className={`text-[10px] font-medium mt-0.5 text-blue-600 dark:text-blue-400`}>
                                    Device & PON Serial Tracking ({line.quantity} Unit{line.quantity > 1 ? 's' : ''})
                                  </div>
                                ) : (
                                  <div className={`text-[10px] font-medium mt-0.5 text-emerald-600 dark:text-emerald-400`}>
                                    Bulk Consumable Item ({line.quantity} {line.unit})
                                  </div>
                                );
                              })()}
                            </td>
                            <td className={`p-2.5 font-mono text-slate-500 dark:text-slate-400`}>
                              {line.sku}
                            </td>
                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                value={line.quantity}
                                onChange={(e) => updateLineQty(idx, Number(e.target.value))}
                                className={`w-20 text-center rounded-lg border p-1.5 text-xs font-mono font-bold border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                              />
                            </td>
                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                value={line.unitPrice}
                                onChange={(e) => updateLinePrice(idx, Number(e.target.value))}
                                className={`w-28 text-right rounded-lg border p-1.5 text-xs font-mono font-medium border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                              />
                            </td>
                            <td className={`p-2.5 text-right font-mono font-extrabold text-slate-900 dark:text-white`}>
                              {formatNPRPrecise(line.netSubtotal)}
                            </td>
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => removeLine(idx)}
                                className="p-1.5 text-slate-400 hover:text-rose-500 cursor-pointer transition-colors"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>

                          {/* Device Serial, PON Serial & MAC Row per Unit or Consumable Notice */}
                          {(() => {
                            const prod = products.find((p) => p.id === line.productId);
                            const isSerialized = prod ? prod.requiresSerialTracking !== false : true;

                            if (!isSerialized) {
                              return (
                                <tr className="bg-slate-100/50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800">
                                  <td colSpan={7} className="px-3 py-2">
                                    <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                      <Tag className="h-3.5 w-3.5 text-slate-400" />
                                      <span>Bulk Consumable Item — Device, PON & MAC serial tracking skipped ({line.quantity} {line.unit})</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            }

                            return (
                              <tr className="bg-blue-50/40 dark:bg-blue-950/30 border-b border-slate-200 dark:border-slate-800">
                                <td colSpan={7} className="px-2.5 py-1.5">
                                  <div className="text-[11px] font-bold text-blue-900 dark:text-blue-300 mb-2 flex items-center gap-1.5">
                                    <Barcode className={`h-3.5 w-3.5 text-blue-600 dark:text-blue-400`} />
                                    <span>Serial Numbers — Device / PON / MAC for {line.productName} ({line.quantity} Units)</span>
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                    {Array.from({ length: line.quantity }).map((_, sIdx) => (
                                      <div
                                        key={sIdx}
                                        className="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-blue-200 dark:border-blue-800 text-xs shadow-xs"
                                      >
                                        <div className="flex items-center justify-between mb-1.5">
                                          <span className="font-mono text-[10px] font-bold text-slate-400">Unit #{sIdx + 1}</span>
                                          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                                            MAC
                                          </span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                                          <input
                                            id={`serial-device-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="Device Serial #"
                                            value={line.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                            onChange={(e) => updateLineDeviceSerial(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const nextEl = document.getElementById(
                                                  `serial-pon-${idx}-${sIdx}`
                                                ) as HTMLInputElement;
                                                if (nextEl) {
                                                  nextEl.focus();
                                                  if ('select' in nextEl) nextEl.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-blue-900 dark:text-blue-200 bg-blue-50/50 dark:bg-blue-950/50 rounded-lg border border-blue-200 dark:border-blue-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                          />

                                          <input
                                            id={`serial-pon-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="PON Serial #"
                                            value={line.deviceSerials?.[sIdx]?.ponSerial || ''}
                                            onChange={(e) => updateLinePonSerial(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const nextEl = document.getElementById(
                                                  `serial-mac-${idx}-${sIdx}`
                                                ) as HTMLInputElement;
                                                if (nextEl) {
                                                  nextEl.focus();
                                                  if ('select' in nextEl) nextEl.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-indigo-900 dark:text-indigo-200 bg-indigo-50/50 dark:bg-indigo-950/50 rounded-lg border border-indigo-200 dark:border-indigo-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                          />

                                          <input
                                            id={`serial-mac-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="MAC Address"
                                            value={line.deviceSerials?.[sIdx]?.macAddress || ''}
                                            onChange={(e) => updateLineMacAddress(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const searchInput = document.getElementById(
                                                  'purchase-product-search-input'
                                                ) as HTMLInputElement;
                                                if (searchInput) {
                                                  searchInput.focus();
                                                  if ('select' in searchInput) searchInput.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-emerald-900 dark:text-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/50 rounded-lg border border-emerald-200 dark:border-emerald-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                          />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            );
                          })()}
                        </React.Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bill Totals Summary & Remarks */}
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-5 border-t border-slate-200 dark:border-slate-700 pt-5`}>
              <div>
                <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Bill Remarks / Vendor Terms
                </label>
                <textarea
                  rows={4}
                  id="pi-remarks-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Enter vendor invoice terms, delivery challan reference, or ledger notes..."
                  className={`w-full rounded-xl border p-3 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 border-slate-300 bg-white text-slate-900 placeholder-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500`}
                />
              </div>

              <div
                className={`rounded-2xl p-5 border space-y-2.5 text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
              >
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Gross Amount:</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-white">
                    {formatNPRPrecise(grossSubtotal)}
                  </span>
                </div>

                <div className={`flex justify-between items-center text-amber-600 bg-amber-50/70 border-amber-200/60 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-800/40 p-2 rounded-xl border`}>
                  <span className="font-bold">Bill Discount (NPR):</span>
                  <input
                    type="number"
                    min={0}
                    value={billDiscountValue}
                    onChange={(e) => setBillDiscountValue(Math.max(0, Number(e.target.value)))}
                    className={`w-28 text-right rounded-lg border border-amber-300 bg-white text-amber-600 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-400 px-2 py-1 text-xs font-mono font-bold focus:ring-2 focus:ring-amber-500`}
                  />
                </div>

                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Taxation Status:</span>
                  <span className={`font-bold text-blue-600 dark:text-blue-400`}>
                    {isBillTaxable ? '13% Taxable Bill' : 'Tax Exempted Bill'}
                  </span>
                </div>

                <div className={`flex justify-between text-blue-600 border-slate-200 dark:text-blue-400 dark:border-slate-800 font-semibold border-t pt-2`}>
                  <span>13% Input VAT:</span>
                  <span className="font-mono font-bold">
                    {formatNPRPrecise(billVatAmount)}
                  </span>
                </div>

                <div className="flex justify-between text-base font-extrabold text-slate-900 dark:text-white pt-2 border-t border-slate-300 dark:border-slate-700">
                  <span>Grand Total (Credit Mode):</span>
                  <span className={`font-mono text-blue-600 dark:text-blue-400 text-lg`}>
                    {formatNPRPrecise(grandTotalCalculated)}
                  </span>
                </div>

                {(poValidation.message || saveMessage) && (
                  <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] font-semibold ${
                    poValidation.message
                      ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                  }`} role="status">
                    {poValidation.message || saveMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Actions */}
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
                    setInternalTab('INVOICE_LIST');
                  }}
                  className={`rounded-xl border px-5 py-2.5 text-xs font-semibold cursor-pointer transition-colors border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  id="btn-submit-purchase-invoice"
                  disabled={lines.length === 0 || !poValidation.valid}
                  className="rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-400 disabled:shadow-none disabled:cursor-not-allowed px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 cursor-pointer transition-all"
                >
                  Save Vendor Bill (Credit Mode)
                </button>
              </div>
            </div>
          </form>
        </div>
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

      {/* Modal 1: Searchable PO Selection Dialog */}
      {isPoSelectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-xl rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            <div className={`flex items-center justify-between border-b p-4 bg-slate-50 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <ShoppingCart className={`h-5 w-5 text-indigo-600 dark:text-indigo-400`} />
                <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                  Select Purchase Order to Link / Receive
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsPoSelectModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by PO Number or Vendor Name..."
                  value={poSearchQuery}
                  onChange={(e) => setPoSearchQuery(e.target.value)}
                  className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500 bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                />
              </div>

              <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                {filteredPendingPOs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400">
                    No pending purchase orders match your search.
                  </div>
                ) : (
                  filteredPendingPOs.map((po) => {
                    const isCurrent = po.id === selectedPoId;
                    return (
                      <div
                        key={po.id}
                        className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${isCurrent ? 'bg-indigo-50/80 dark:bg-indigo-950/60 border-indigo-300 dark:border-indigo-700 shadow-xs' : 'bg-white border-slate-200 hover:bg-slate-200 dark:bg-slate-900/50 dark:border-slate-800 dark:hover:bg-slate-800/80'}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-mono font-extrabold text-xs text-indigo-600 dark:text-indigo-400`}>
                              PO #{po.poNumber}
                            </span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 uppercase">
                              {po.status}
                            </span>
                          </div>
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate mt-0.5">
                            {po.supplierName}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-3">
                            <span>📅 {po.orderDateAD}</span>
                            <span>📦 {po.items.length} item line(s)</span>
                            <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                              {formatNPR(po.totalAmount)}
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPoId(po.id);
                            if (po.supplierName) setSupplierName(po.supplierName);
                            if (po.supplierId) setSupplierId(po.supplierId);
                            if (po.branchId) setBranchId(po.branchId);
                            setIsPoSelectModalOpen(false);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer shrink-0 ${
                            isCurrent
                              ? 'bg-indigo-700 text-white shadow-xs'
                              : 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-600 hover:text-white border border-indigo-200 dark:border-indigo-800'
                          }`}
                        >
                          {isCurrent ? 'Linked ✓' : 'Select PO'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className={`p-3 border-t flex justify-between items-center text-xs bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <button
                type="button"
                onClick={() => {
                  setSelectedPoId('');
                  setIsPoSelectModalOpen(false);
                }}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 font-medium"
              >
                Clear Selection (Direct Purchase)
              </button>
              <button
                type="button"
                onClick={() => setIsPoSelectModalOpen(false)}
                className="px-4 py-1.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold rounded-lg hover:bg-slate-300 dark:hover:bg-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Active PO Item Checklist Dialog */}
      {isPoChecklistOpen && activePO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-2xl rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            <div className={`flex items-center justify-between border-b p-4 bg-slate-50 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <CheckSquare className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                    PO Verification Checklist — #{activePO.poNumber}
                  </h3>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Supplier: {activePO.supplierName}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsPoChecklistOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
              <div className="text-xs text-slate-600 dark:text-slate-300 bg-blue-50 dark:bg-blue-950/50 p-3 rounded-xl border border-blue-200 dark:border-blue-800">
                💡 <strong>How receiving works:</strong> As you scan or search product items into the Purchase Invoice form below, this checklist automatically updates received counts.
              </div>

              <div className="space-y-2">
                {activePO.items.map((poItem) => {
                  const matchedLine = lines.find((l) => l.productId === poItem.productId);
                  const scannedQty = matchedLine ? matchedLine.quantity : 0;
                  const isComplete = scannedQty === poItem.quantity;
                  const isOver = scannedQty > poItem.quantity;
                  const isStarted = scannedQty > 0;

                  return (
                    <div
                      key={poItem.id}
                      className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
                        isComplete
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-950 dark:text-emerald-200'
                          : isOver
                          ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-700 text-rose-950 dark:text-rose-200'
                          : isStarted
                          ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-950 dark:text-amber-200'
                          : 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-slate-900 dark:text-white">{poItem.productName}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Ordered Quantity: <strong className="text-slate-800 dark:text-slate-200">{poItem.quantity} {poItem.unit}</strong> @ {formatNPR(poItem.unitPrice)}
                        </div>
                      </div>

                      <div className="text-right font-mono">
                        <div
                          className={`font-extrabold text-sm ${
                            isComplete
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : isOver
                              ? 'text-rose-700 dark:text-rose-400'
                              : isStarted
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-slate-400'
                          }`}
                        >
                          {scannedQty} / {poItem.quantity}
                        </div>
                        <div className="text-[10px] font-bold">
                          {isComplete
                            ? '✓ Fully Scanned'
                            : isOver
                            ? '⚠️ Exceeds Order'
                            : isStarted
                            ? '⏳ Partially Scanned'
                            : 'Not Scanned Yet'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={`p-3 border-t text-right bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <button
                type="button"
                onClick={() => setIsPoChecklistOpen(false)}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-lg"
              >
                Done Inspecting
              </button>
            </div>
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
