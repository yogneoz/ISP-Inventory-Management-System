/**
 * Sales Invoices — register + create form (INV-… documents).
 *
 * Lean sales module: posting decrements branch stock (server-guarded against
 * negative stock) and appends SALES_INVOICE ledger rows. Sales Returns
 * validate against the sold quantities recorded here.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFilterPageReset } from '../../utils/useFilterPageReset';
import {
  PlusCircle,
  Receipt,
  ArrowLeft,
  Loader2,
  Eye,
  Banknote,
  Ban,
  Plus,
  Trash2,
  PackageMinus,
  Download,
  Printer,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { formCardClass } from '../../components/common/FormCard';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import { CustomerPicker } from '../../components/common/CustomerPicker';
import { FilterCard } from '../../components/common/FilterCard';
import { ModalPanel } from '../../components/common/ModalPanel';
import { TablePagination, useServerPageClamp } from '../../components/common/TablePagination';
import { RegisterLoadError } from '../../components/common/RegisterLoadError';
import { DocumentLetterhead } from '../../components/common/DocumentLetterhead';
import { useDialog } from '../../components/common/DialogProvider';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { formatMoney } from '../../utils/nprFormat';
import { exportToCSV } from '../../utils/exportUtils';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import { isSellableProduct } from '../../utils/productGroupBehavior';
import { inputClass, labelClass, btnPrimary, btnGhost } from '../../components/common/styleConstants';
import { api } from '../../services/api';
import { DeviceSerialInput } from '../../components/common/DeviceSerialInput';
import { normalizeMacAddress } from '../../../../shared/macAddress';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import type {
  SalesInvoice, SalesInvoiceItem, Product, Branch, InventoryStock, CompanyProfile, User,
  CustomerRecord, DeviceSerialPair, SerialLog,
} from '../../types';
import { localTodayAD } from '../../utils/localDate';
import { clampLineQuantity } from '../../utils/lineQuantity';
import { warrantyCoveredDefault, warrantyEndFieldError, warrantyEndFor } from '../../utils/warrantyCapture';
import { isWarrantyBearingLine, salesWarrantyCoverageLabel, summarizeSalesWarranty } from '../../utils/salesWarranty';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { getAllowedBranches } from '../../utils/permissions';

/** Human labels for the stored payment-method codes (the values stay the API enums). */
const SALES_PAYMENT_METHODS: Array<{ value: NonNullable<SalesInvoice['paymentMethod']>; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer / Fonepay' },
  { value: 'ONLINE', label: 'Online / eSewa / Khalti' },
  { value: 'CARD', label: 'Card' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CREDIT', label: 'Customer account credit' },
  { value: 'OTHER', label: 'Other' },
];

/** Small, consistent chips for the two read-only warranty surfaces. */
const WARRANTY_CHIP = {
  covered:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  none:
    'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  missing:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
};

function WarrantyChip({ tone, children }: { tone: keyof typeof WARRANTY_CHIP; children: React.ReactNode }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${WARRANTY_CHIP[tone]}`}>
      {children}
    </span>
  );
}

/** One detail-table cell: the promise captured with this line (WTY-5). */
function SellerWarrantyLine({ item, dateMode }: { item: SalesInvoiceItem; dateMode: 'BS' | 'AD' }) {
  if (!isWarrantyBearingLine(item)) {
    return (
      <span className="text-slate-400" title="Quantity-only line — seller warranty applies to serialised units">
        —
      </span>
    );
  }
  if (item.sellerWarrantyCovered === false) {
    return <WarrantyChip tone="none">No warranty</WarrantyChip>;
  }
  if (item.sellerWarrantyEndDateAD) {
    const date = formatDualDate(item.sellerWarrantyEndDateAD, dateMode);
    return (
      <div className="space-y-0.5">
        <WarrantyChip tone="covered">Covered</WarrantyChip>
        <div className="font-mono text-[10px] font-semibold text-slate-600 dark:text-slate-300" title={date}>
          {date}
        </div>
      </div>
    );
  }
  return (
    <span title="This serialised line has no captured seller warranty.">
      <WarrantyChip tone="missing">Not recorded</WarrantyChip>
    </span>
  );
}

/** Register cell: one honest summary for the invoice's serialised lines. */
function SellerWarrantySummary({ items, dateMode }: { items?: SalesInvoiceItem[]; dateMode: 'BS' | 'AD' }) {
  const summary = summarizeSalesWarranty(items);
  const compactDate = (adDate: string) => {
    const full = formatDualDate(adDate, dateMode);
    return <span title={full}>{full.split(' (')[0]}</span>;
  };

  if (summary.state === 'NONE') {
    return (
      <span className="text-slate-400" title="No serialised line — no seller warranty to show">
        —
      </span>
    );
  }
  if (summary.state === 'NOT_COVERED') {
    return <WarrantyChip tone="none">No warranty</WarrantyChip>;
  }
  if (summary.state === 'NOT_RECORDED') {
    return (
      <span title={`${summary.unrecordedCount} serialised line(s) without a captured warranty.`}>
        <WarrantyChip tone="missing">Not recorded</WarrantyChip>
      </span>
    );
  }
  if (summary.state === 'MIXED') {
    const parts = [
      summary.coveredCount ? `${summary.coveredCount} covered` : '',
      summary.uncoveredCount ? `${summary.uncoveredCount} none` : '',
      summary.unrecordedCount ? `${summary.unrecordedCount} not recorded` : '',
    ].filter(Boolean);
    return (
      <div className="space-y-0.5">
        <WarrantyChip tone="missing">Mixed</WarrantyChip>
        <div className="text-[10px] text-slate-500 dark:text-slate-400">{parts.join(' · ')}</div>
        {summary.endDateAD && (
          <div className="whitespace-nowrap font-mono text-[10px] font-semibold text-slate-600 dark:text-slate-300">
            {summary.dateCount > 1 ? 'earliest to ' : 'covered to '}
            {compactDate(summary.endDateAD)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="space-y-0.5"
      title={
        summary.state === 'MULTIPLE'
          ? `Earliest of ${summary.dateCount} covered expiry dates on this invoice.`
          : undefined
      }
    >
      <WarrantyChip tone="covered">Covered</WarrantyChip>
      <div className="whitespace-nowrap font-mono text-[10px] font-semibold text-slate-600 dark:text-slate-300">
        to {compactDate(summary.endDateAD!)}
        {summary.state === 'MULTIPLE' && (
          <span className="font-sans font-normal text-slate-400"> · {summary.dateCount} dates</span>
        )}
      </div>
    </div>
  );
}

/**
 * Flatten invoices to one row per line for CSV. Warranty travels with the
 * line, so an invoice cannot be exported as "covered" without its date.
 */
export function buildSalesInvoiceExportRows(
  source: SalesInvoice[],
  branches: Branch[]
): Array<Record<string, string | number>> {
  return source.flatMap((invoice) => {
    const branch = branches.find((b) => b.id === invoice.branchId || b.code === invoice.branchId);
    const paymentMethod = SALES_PAYMENT_METHODS.find((m) => m.value === invoice.paymentMethod)?.label
      || invoice.paymentMethod
      || '';
    const base = {
      invoiceNumber: invoice.invoiceNumber,
      invoiceDateAD: invoice.invoiceDateAD || '',
      invoiceDateBS: invoice.invoiceDateBS || '',
      customerName: invoice.customerName || '',
      branchName: branch?.name || invoice.branchId || '',
      documentStatus: invoice.status === 'CANCELLED' ? 'Cancelled' : 'Posted',
      paymentStatus: invoice.paymentStatus || '',
      paymentMethod,
    };
    const items: Array<SalesInvoiceItem | null> = invoice.items && invoice.items.length > 0
      ? invoice.items
      : [null];
    return items.map((item) => ({
      ...base,
      productName: item?.productName || '',
      sku: item?.sku || '',
      quantity: item?.quantity ?? '',
      unitPrice: item?.unitPrice ?? '',
      taxAmount: item?.taxAmount ?? '',
      lineTotal: item?.total ?? '',
      sellerWarrantyCoverage: item ? salesWarrantyCoverageLabel(item) : '',
      sellerWarrantyEndDateAD: item?.sellerWarrantyEndDateAD || '',
      sellerWarrantyEndDateBS: item?.sellerWarrantyEndDateAD
        ? formatDualDate(item.sellerWarrantyEndDateAD, 'BS').split(' (')[0]
        : '',
    }));
  });
}

interface SalesInvoicesProps {
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  /** Sellable inventory serials (serial_log IN_STOCK) — the pre-post gate. */
  inventorySerials?: SerialLog[];
  /** Failure reading that list (DF-17); '' once it succeeds. */
  inventorySerialsError?: string;
  inventorySerialsLoading?: boolean;
  /** Re-reads the list for the current branch (the notice's Retry). */
  onRetryInventorySerials?: () => void;
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  activeTab?: 'create-sale' | 'sales-list';
  onCreateInvoice: (inv: Omit<SalesInvoice, 'id' | 'invoiceNumber'>) => Promise<void>;
  /** Records a dated customer receipt (customer_payments sub-ledger). */
  onRecordPayment?: (invoice: SalesInvoice, amount: number, paymentMethod: string) => Promise<void>;
  /**
   * Voids a posted invoice. The server reverses it atomically (stock + claimed
   * serials + ledger) and refuses invoices that still carry payments or credit
   * notes; that message is surfaced in the dialog.
   */
  onCancelInvoice?: (id: string, reason?: string) => Promise<void>;
  /** Bumped by App's SSE handler when sales events arrive. */
  sseRefreshKey?: number;
}



interface FormLine {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  /** Per-line discount, clamped to the line gross by the server. */
  discount: number;
  isTaxExempt: boolean;
  /** One slot per unit for serial-tracked products. */
  deviceSerials?: DeviceSerialPair[];
  /** WTY-5: the customer promise captured with this serialised line. */
  sellerWarrantyEndDateAD?: string;
  sellerWarrantyCovered?: boolean;
}

export const SalesInvoices: React.FC<SalesInvoicesProps> = ({
  companyProfile,
  currentUser,
  products,
  branches,
  stock,
  inventorySerials = [],
  inventorySerialsError = '',
  inventorySerialsLoading = false,
  onRetryInventorySerials,
  selectedBranchId,
  dateMode,
  activeTab = 'sales-list',
  onCreateInvoice,
  onRecordPayment,
  onCancelInvoice,
  sseRefreshKey,
}) => {
  const { isDarkMode } = useDarkMode();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [internalTab, setInternalTab] = useState<'LIST' | 'CREATE'>(
    activeTab === 'create-sale' ? 'CREATE' : 'LIST'
  );
  const [viewing, setViewing] = useState<SalesInvoice | null>(null);

  // Only branches this account may post from. A fixture that mounts the form
  // without a session keeps the full list rather than an empty select.
  const selectableBranches = useMemo(
    () => (currentUser ? getAllowedBranches(currentUser, branches) : branches),
    [currentUser, branches]
  );

  // Create-form state. A sale must be fulfilled from ONE branch, so a global
  // "All Branches (Consolidated)" selection (branchId 'ALL') can never leak
  // into the form — it would zero every stock lookup and post to branch 'ALL'.
  const pickInitialBranch = () => {
    const match = selectableBranches.find(
      (b) => b.id === selectedBranchId || b.code === selectedBranchId
    );
    return match?.id || selectableBranches[0]?.id || '';
  };
  const [branchId, setBranchId] = useState(pickInitialBranch);
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  // Searchable customer picker: `customerQuery` is the visible label,
  // `customerId`/`customerName` stay the canonical FK + display name.
  const [customerQuery, setCustomerQuery] = useState('');
  const [invDateAD, setInvDateAD] = useState(localTodayAD);
  /** Recomputed every render so the picker and the guard share one "today". */
  const todayAD = localTodayAD();
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE' | 'ONLINE' | 'CARD' | 'OTHER'>('CASH');
  const [amountPaid, setAmountPaid] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<FormLine[]>([
    { productId: '', productName: '', sku: '', unit: '', quantity: 1, unitPrice: 0, discount: 0, isTaxExempt: false },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [query, setQuery] = useState('');

  // Follow the global branch selector only while it points at a branch this
  // account may post from.
  useEffect(() => {
    const match = selectableBranches.find(
      (b) => b.id === selectedBranchId || b.code === selectedBranchId
    );
    if (match) setBranchId(match.id);
  }, [selectedBranchId, selectableBranches]);

  // Server-side paged fetch state: the register asks /api/sales-invoices for
  // one page of filtered rows instead of filtering the whole prop array.
  const [siRows, setSiRows] = useState<SalesInvoice[]>([]);
  const [siTotalItems, setSiTotalItems] = useState(0);
  const [siPage, setSiPage] = useState(1);
  const [siPageSize, setSiPageSize] = useState(25);
  const [siLoading, setSiLoading] = useState(true);
  const [siLoadError, setSiLoadError] = useState('');
  const [siRefreshKey, setSiRefreshKey] = useState(0);
  const [exporting, setExporting] = useState(false);

  // One page of filtered invoice rows; the seq guard drops superseded responses.
  const siFetchSeq = useRef(0);
  const loadSiPage = useCallback(async () => {
    const seq = ++siFetchSeq.current;
    setSiLoading(true);
    setSiLoadError('');
    try {
      const envelope = (await api.getSalesInvoices({
        branchId: branchFilter !== 'ALL' ? branchFilter : undefined,
        query: query.trim() || undefined,
        page: siPage,
        pageSize: siPageSize,
      })) as SalesInvoice[] | { data: SalesInvoice[]; totalItems: number };
      if (seq !== siFetchSeq.current) return; // superseded
      if (Array.isArray(envelope)) {
        setSiRows(envelope);
        setSiTotalItems(envelope.length);
      } else {
        setSiRows(envelope.data || []);
        setSiTotalItems(envelope.totalItems || 0);
      }
    } catch (err: any) {
      if (seq !== siFetchSeq.current) return;
      setSiLoadError(err?.message || 'Failed to load the register.');
    } finally {
      if (seq === siFetchSeq.current) setSiLoading(false);
    }
  }, [branchFilter, query, siPage, siPageSize]);

  useEffect(() => {
    loadSiPage();
  }, [loadSiPage, siRefreshKey, sseRefreshKey]);

  // A filter change snaps the page back to 1 in the same render, so one
  // change costs one request for page 1 instead of two (DF-12).
  useFilterPageReset([branchFilter, query].join('\u0000'), siPage, setSiPage);

  // Record-payment state (customer_payments sub-ledger)
  const [payInvoice, setPayInvoice] = useState<SalesInvoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [payError, setPayError] = useState('');

  // Mirrors the server's computeBillTotals(items): line discount is clamped to
  // the line gross, and VAT is charged on the discounted (net) taxable amount.
  const lineTotals = useMemo(() => {
    // Company-configured VAT rate (company_profile.default_tax_rate via
    // bootstrap) — never a hard-coded 13.
    const vatRate = getDefaultTaxRate();
    let gross = 0, discount = 0, taxable = 0, nonTaxable = 0, vat = 0;
    for (const l of lines) {
      if (!l.productId) continue;
      const lineGross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
      const lineDiscount = Math.min(Math.max(Number(l.discount) || 0, 0), lineGross);
      const net = lineGross - lineDiscount;
      gross += lineGross;
      discount += lineDiscount;
      if (l.isTaxExempt) { nonTaxable += net; continue; }
      taxable += net;
      vat += (net * vatRate) / 100;
    }
    return { gross, discount, taxable, nonTaxable, vat, grand: taxable + nonTaxable + vat };
  }, [lines]);

  const stockFor = (productId: string): number =>
    stock.find((s) => s.productId === productId && s.branchId === branchId)?.quantityOnHand ?? 0;

  /** Only products whose group behaviour is STOCK_ITEM are sellable here. */
  const saleEligibleProducts = useMemo(
    () => products.filter((p) => isSellableProduct(p)),
    [products]
  );

  const norm = (s?: string) => (s || '').trim().toUpperCase();

  // Compact table-cell controls: same theme treatment as inputClass but
  // fixed-width so numeric columns stay aligned (inputClass carries w-full).
  const cellInputClass =
    'rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900 focus:border-indigo-500 focus:outline-none dark:border-slate-700 dark:bg-[#0f1218] dark:text-white';
  const serialInputClass =
    'w-full rounded-md border border-indigo-300 bg-white px-2 py-1.5 font-mono text-[11px] font-bold text-indigo-900 focus:border-indigo-500 focus:outline-none dark:border-indigo-700 dark:bg-[#0f1218] dark:text-indigo-100';
  const stockToneText = { OK: 'In stock', LOW: 'Low', SHORT: 'Short', NONE: '' } as const;

  const emptyLine = (): FormLine => ({
    productId: '', productName: '', sku: '', unit: '', quantity: 1, unitPrice: 0, discount: 0, isTaxExempt: false,
  });

  /** Mirrors StockOperations: QUANTITY_ONLY products are not serial-tracked. */
  const isSerializedProduct = (productId: string): boolean => {
    const p = products.find((pr) => pr.id === productId);
    return !!p && p.requiresSerialTracking !== false && p.trackingType !== 'QUANTITY_ONLY';
  };

  /** Keeps exactly one serial slot per unit so Sales Returns have 1:1 coverage. */
  const syncSerialSlots = (line: FormLine): DeviceSerialPair[] | undefined => {
    if (!isSerializedProduct(line.productId)) return undefined;
    // AUD-3: the pad below is bounded by construction, not by what was typed.
    const qty = clampLineQuantity(line.quantity);
    const slots = [...(line.deviceSerials || [])];
    while (slots.length < qty) slots.push({ deviceSerial: '', ponSerial: '', macAddress: '' });
    return slots.slice(0, qty);
  };

  /** Per-line stock badge: cannot fulfil / nearly out / healthy. */
  const lineStock = (line: FormLine): { tone: 'NONE' | 'SHORT' | 'LOW' | 'OK'; label: string; className: string } => {
    if (!line.productId) return { tone: 'NONE', label: '', className: 'text-slate-400' };
    const onHand = stockFor(line.productId);
    const qty = Number(line.quantity) || 0;
    if (qty > onHand) return { tone: 'SHORT', label: `Only ${onHand} on hand`, className: 'text-red-600 dark:text-red-400' };
    if (onHand - qty <= 2) return { tone: 'LOW', label: `${onHand} on hand (low)`, className: 'text-amber-600 dark:text-amber-400' };
    return { tone: 'OK', label: `${onHand} on hand`, className: 'text-emerald-600 dark:text-emerald-400' };
  };

  const updateLine = (idx: number, patch: Partial<FormLine>) => {
    // AUD-3: every quantity enters a line through this patch — typing, the
    // scan-again increment and product swaps — so the ceiling is applied once
    // here. A nine-digit quantity used to build that many serial slots on the
    // keystroke and freeze the tab.
    const bounded = patch.quantity === undefined ? patch : { ...patch, quantity: clampLineQuantity(patch.quantity) };
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...bounded };
        // Swapping the product or changing qty resizes the serial slots.
        if (bounded.quantity !== undefined || bounded.productId !== undefined) next.deviceSerials = syncSerialSlots(next);
        return next;
      })
    );
  };

  const updateSerial = (idx: number, sIdx: number, patch: Partial<DeviceSerialPair>) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const slots = [...(l.deviceSerials || [])];
        slots[sIdx] = { ...(slots[sIdx] || { deviceSerial: '', ponSerial: '', macAddress: '' }), ...patch };
        return { ...l, deviceSerials: slots };
      })
    );
  };

  const updateLineWarrantyEnd = (idx: number, value: string) => {
    updateLine(idx, { sellerWarrantyEndDateAD: value });
  };

  /**
   * WTY-5: turning seller coverage off is a declaration, not an empty field.
   * The date is cleared so a hidden value can never be submitted; turning it
   * back on re-derives the untouched prefill from the product's seller term.
   */
  const updateLineWarrantyCovered = (idx: number, covered: boolean) => {
    const line = lines[idx];
    const product = products.find((p) => p.id === line?.productId);
    updateLine(idx, {
      sellerWarrantyCovered: covered,
      sellerWarrantyEndDateAD: covered ? warrantyEndFor(invDateAD, product?.sellerWarrantyMonths) : '',
    });
  };

  /**
   * ProductSearchBar callback — re-scanning the same product increments its
   * line (and opens one more serial slot), anything else starts a new line.
   */
  const addOrIncrementProduct = (p: Product) => {
    const existing = lines.findIndex((l) => l.productId === p.id);
    if (existing !== -1) {
      updateLine(existing, { quantity: (Number(lines[existing].quantity) || 0) + 1 });
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        ...emptyLine(),
        productId: p.id,
        productName: p.name,
        sku: p.sku || '',
        unit: p.unit || '',
        quantity: 1,
        unitPrice: Number(p.sellingPrice) || 0,
        isTaxExempt: (Number(p.taxRate) || 0) === 0,
        sellerWarrantyEndDateAD: isSerializedProduct(p.id)
          ? warrantyEndFor(todayAD, p.sellerWarrantyMonths)
          : undefined,
        sellerWarrantyCovered: isSerializedProduct(p.id)
          ? warrantyCoveredDefault(p.sellerWarrantyMonths)
          : undefined,
      },
    ]);
    setFormError('');
  };

  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const pickProduct = (idx: number, productId: string) => {
    const p = products.find((pr) => pr.id === productId);
    if (!p) { updateLine(idx, { productId: '', deviceSerials: undefined }); return; }
    updateLine(idx, {
      productId,
      productName: p.name,
      sku: p.sku || '',
      unit: p.unit || '',
      unitPrice: Number(p.sellingPrice) || 0,
      discount: 0,
      deviceSerials: undefined,
      isTaxExempt: (Number(p.taxRate) || 0) === 0,
      sellerWarrantyEndDateAD: isSerializedProduct(productId)
        ? warrantyEndFor(invDateAD, p.sellerWarrantyMonths)
        : undefined,
      sellerWarrantyCovered: isSerializedProduct(productId)
        ? warrantyCoveredDefault(p.sellerWarrantyMonths)
        : undefined,
    });
  };

  const resetForm = () => {
    setCustomerId(''); setCustomerName(''); setCustomerQuery(''); setNotes(''); setAmountPaid('0');
    setPaymentMethod('CASH');
    setLines([emptyLine()]);
    setFormError('');
  };

  const customerDisplay = (c: CustomerRecord) => `${c.customerName} (${c.customerId})`;
  // VOL-4a: the form keeps the label the picker produced (`customerQuery`) and
  // the canonical name; it never resolves the row out of a client-side
  // directory array, because there is no longer one to resolve from.
  const customerPickerValue = customerId
    ? { id: customerId, label: customerQuery || customerName }
    : null;

  const submit = async () => {
    setFormError('');
    if (!branchId || branchId === 'ALL' || !branches.some((b) => b.id === branchId)) {
      setFormError('Pick the fulfilling branch before posting — a sale must come from one branch.');
      return;
    }
    if (!customerId) {
      setFormError('Select a customer from the search results before posting.');
      return;
    }
    if (!invDateAD) {
      setFormError('Invoice date is required.');
      return;
    }
    if (invDateAD !== todayAD) {
      setFormError(
        invDateAD > todayAD
          ? `Invoice date ${invDateAD} is in the future — a sales invoice can only be issued for ${todayAD}.`
          : `Invoice date ${invDateAD} is in the past — a sales invoice can only be issued for ${todayAD}.`
      );
      return;
    }
    const validLines = lines.filter((l) => l.productId && (Number(l.quantity) || 0) > 0);
    if (validLines.length === 0) { setFormError('Add at least one product line with a quantity.'); return; }
    const overselling = validLines.find((l) => (Number(l.quantity) || 0) > stockFor(l.productId));
    if (overselling) {
      setFormError(`Insufficient stock for ${overselling.productName}: ${stockFor(overselling.productId)} on hand at this branch.`);
      return;
    }
    // Serial-tracked lines must carry one device serial + one PON serial per
    // unit, and EVERY serial must resolve to a record that is already in
    // inventory at this branch before the sale can post. Sales Returns
    // re-validate these (server validateReturnSerials), so capture them now.
    const seenDevice = new Set<string>();
    const seenPon = new Set<string>();
    const seenMac = new Set<string>();
    const sellBranchName = branches.find((b) => b.id === branchId)?.name || branchId;
    for (const l of validLines) {
      if (!isSerializedProduct(l.productId)) continue;
      const qty = Number(l.quantity) || 0;
      // Local copy: the register-resolved PON/MAC are written back here (never
      // into React state) before the payload is built.
      const slots = [...(l.deviceSerials || [])];
      l.deviceSerials = slots;
      if (slots.length < qty) {
        setFormError(`Enter serial numbers for all ${qty} unit(s) of "${l.productName}".`);
        return;
      }
      for (let s = 0; s < qty; s++) {
        const unit = s + 1;
        const serial = norm(slots[s]?.deviceSerial);
        // PON/MAC are resolved from the register row by the one-field input;
        // they are display/verification values, not required typed keys.
        const pon = norm(slots[s]?.ponSerial);
        const mac = norm(slots[s]?.macAddress);

        if (!serial) { setFormError(`Device serial is required for "${l.productName}" (unit #${unit}).`); return; }
        // An unread list cannot prove a unit is in inventory; say that instead
        // of pinning a valid serial to "not in inventory" (DF-17).
        if (inventorySerialsError) {
          setFormError('The sellable serial list could not be read — use Retry above before posting this invoice.');
          return;
        }
        if (seenDevice.has(serial)) { setFormError(`Duplicate device serial ${serial} on this invoice.`); return; }
        if (seenPon.has(pon)) { setFormError(`Duplicate PON serial ${pon} on this invoice.`); return; }
        if (mac && seenMac.has(mac)) { setFormError(`Duplicate MAC address ${mac} on this invoice.`); return; }
        seenDevice.add(serial);
        if (pon) seenPon.add(pon);
        if (mac) seenMac.add(mac);

        // Gate: every serial must already exist in inventory — an IN_STOCK
        // serial_log row for this branch and product. serial_log is the
        // inventory register (purchase receipts write it, stock counts match
        // it), and it is what Sales Returns re-validate against.
        const rec = inventorySerials.find(
          (sl) =>
            sl.branchId === branchId &&
            sl.status === 'IN_STOCK' &&
            norm(sl.deviceSerial) === serial &&
            (!sl.productId || sl.productId === l.productId)
        );
        if (!rec) {
          setFormError(
            `Device serial ${serial} is not in inventory at ${sellBranchName} for "${l.productName}" — only IN_STOCK units can be sold.`
          );
          return;
        }
        if (pon && norm(rec.ponSerial) !== pon) {
          setFormError(
            `PON serial ${pon} (unit #${unit}) does not match inventory: ${sellBranchName} has ` +
            `${norm(rec.ponSerial) || 'no PON'} recorded against ${serial}.`
          );
          return;
        }
        if (mac && norm(rec.macAddress) !== mac) {
          setFormError(
            `MAC address ${mac} (unit #${unit}) does not match inventory: ${sellBranchName} has ` +
            `${norm(rec.macAddress) || 'no MAC'} recorded against ${serial}.`
          );
          return;
        }
        // Fill the resolved identity so the payload/claim carries the
        // register's own PON and MAC rather than blanks.
        if (!pon || !mac) {
          slots[s] = {
            ...slots[s],
            ponSerial: pon || norm(rec.ponSerial),
            macAddress: mac || normalizeMacAddress(rec.macAddress),
          };
        }
      }
    }

    // WTY-5: every serialised line carries an explicit customer promise. Off
    // is a declaration; on requires an expiry, so a cleared date can never
    // silently become the product's default term.
    for (const l of validLines) {
      if (!isSerializedProduct(l.productId)) continue;
      const warrantyError = warrantyEndFieldError(
        invDateAD,
        l.sellerWarrantyEndDateAD,
        'Seller warranty expiry',
        l.sellerWarrantyCovered
      );
      if (warrantyError) {
        setFormError(`${l.productName}: ${warrantyError}`);
        return;
      }
    }

    const ok = await confirmDialog(
      `Post sales invoice for ${customerName || 'Walk-in Customer'} — ${validLines.length} line(s), ` +
      `grand total ${formatMoney(lineTotals.grand)}? Stock is deducted immediately.`
    );
    if (!ok) return;

    setSubmitting(true);
    try {
      const items: SalesInvoiceItem[] = validLines.map((l, i) => {
        const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
        const discount = Math.min(Math.max(Number(l.discount) || 0, 0), gross);
        const net = gross - discount;
        return {
          id: `sii-${Date.now()}-${i}`,
          productId: l.productId,
          productName: l.productName,
          sku: l.sku,
          unit: l.unit,
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          discount,
          isTaxExempt: l.isTaxExempt,
          taxRate: l.isTaxExempt ? 0 : getDefaultTaxRate(),
          subtotal: net,
          taxAmount: l.isTaxExempt ? 0 : (net * getDefaultTaxRate()) / 100,
          total: l.isTaxExempt ? net : net * (1 + getDefaultTaxRate() / 100),
          deviceSerials: l.deviceSerials,
          sellerWarrantyEndDateAD: l.sellerWarrantyEndDateAD || undefined,
          sellerWarrantyCovered: l.sellerWarrantyCovered,
        };
      });
      await onCreateInvoice({
        customerId: customerId || undefined,
        customerName: customerName || 'Walk-in Customer',
        branchId,
        invoiceDateAD: invDateAD,
        invoiceDateBS: '',
        items,
        taxableAmount: lineTotals.taxable,
        vatAmount: lineTotals.vat,
        nonTaxableAmount: lineTotals.nonTaxable,
        grandTotal: lineTotals.grand,
        paymentStatus: Number(amountPaid) >= lineTotals.grand ? 'PAID' : Number(amountPaid) > 0 ? 'PARTIAL' : 'UNPAID',
        paymentMethod,
        amountPaid: Number(amountPaid) || 0,
        notes,
      } as Omit<SalesInvoice, 'id' | 'invoiceNumber'>);
      resetForm();
      setInternalTab('LIST');
      setSiRefreshKey((k) => k + 1);
    } catch (e: any) {
      setFormError(e?.message || 'Failed to create sales invoice.');
    } finally {
      setSubmitting(false);
    }
  };

  const openPayment = (inv: SalesInvoice) => {
    setPayInvoice(inv);
    setPayAmount(String(Math.max(0, (Number(inv.grandTotal) || 0) - (Number(inv.amountPaid) || 0))));
    setPayMethod('CASH');
    setPayError('');
  };

  // Void: confirm first, then let the server reverse everything in one
  // transaction. A refusal (payments/returns still on the invoice, a
  // concurrent void) is shown verbatim so the user knows what to undo first.
  const voidInvoice = async (inv: SalesInvoice) => {
    if (!onCancelInvoice) return;
    const ok = await confirmDialog(
      `Void sales invoice ${inv.invoiceNumber} for ${inv.customerName}? Stock and claimed serials return to inventory and the ledger is reversed. This cannot be undone.`,
      { title: 'Void sales invoice', confirmLabel: 'Void invoice' }
    );
    if (!ok) return;
    try {
      await onCancelInvoice(inv.id, 'Voided from the Sales Invoices register');
      setSiRefreshKey((k) => k + 1);
    } catch (e: any) {
      await alertDialog(e?.message || 'Failed to void the sales invoice.');
    }
  };

  const submitPayment = async () => {
    if (!payInvoice) return;
    const amt = Number(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setPayError('Enter a payment amount greater than 0.'); return; }
    setPaySubmitting(true);
    setPayError('');
    try {
      await onRecordPayment?.(payInvoice, amt, payMethod);
      setPayInvoice(null);
      setSiRefreshKey((k) => k + 1);
    } catch (e: any) {
      setPayError(e?.message || 'Failed to record the payment.');
    } finally {
      setPaySubmitting(false);
    }
  };

  // The register has no full-array fallback: a failed page leaves the rows
  // already on screen (if any) and shows the error + Retry. The bootstrap no
  // longer carries the fiscal year's invoices, and silently filtering a stale
  // copy was the last reason it did.
  const totalItems = siTotalItems;
  // A delete can shrink the filtered set under the current page; snap back to
  // the new last page instead of asking the server for one that is gone (DF-09).
  const safePage = useServerPageClamp(siPage, siPageSize, totalItems, setSiPage);
  const pageRows = siRows;
  const pageCount = Math.max(1, Math.ceil(totalItems / siPageSize));
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * siPageSize + 1;
  const rangeEnd = Math.min(totalItems, safePage * siPageSize);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || id;

  /**
   * Exports the filtered register, or one invoice from the detail view, as one
   * row per line — the seller warranty stays attached to the product it covers.
   */
  const handleExportCSV = async (invoices?: SalesInvoice[]) => {
    if (!invoices && siLoadError) {
      await alertDialog('Cannot export while the register is in an error state. Retry the page load first.');
      return;
    }
    setExporting(true);
    try {
      let exported: SalesInvoice[];
      if (invoices) {
        exported = invoices;
      } else {
        const envelope = (await api.getSalesInvoices({
          branchId: branchFilter !== 'ALL' ? branchFilter : undefined,
          query: query.trim() || undefined,
          all: true,
        })) as SalesInvoice[] | { data: SalesInvoice[] };
        exported = Array.isArray(envelope) ? envelope : envelope.data || [];
      }
      if (exported.length === 0) {
        await alertDialog('No sales invoices available to export.');
        return;
      }

      const rows = buildSalesInvoiceExportRows(exported, branches);
      const scope = exported.length === 1
        ? branchName(exported[0].branchId)
        : branchFilter !== 'ALL' ? branchName(branchFilter) : 'All branches';
      const single = exported.length === 1;
      exportToCSV({
        filename: single
          ? `Sales_Invoice_${exported[0].invoiceNumber}`
          : 'Inventory_Sales_Invoices',
        data: rows,
        columns: [
          { label: 'System Invoice #', key: 'invoiceNumber' },
          { label: 'Invoice Date (AD)', key: 'invoiceDateAD' },
          { label: 'Invoice Date (BS)', key: 'invoiceDateBS' },
          { label: 'Customer', key: 'customerName' },
          { label: 'Branch', key: 'branchName' },
          { label: 'Document Status', key: 'documentStatus' },
          { label: 'Payment Status', key: 'paymentStatus' },
          { label: 'Payment Method', key: 'paymentMethod' },
          { label: 'Product', key: 'productName' },
          { label: 'SKU', key: 'sku' },
          { label: 'Qty', key: 'quantity' },
          { label: 'Unit Price', key: 'unitPrice', formatter: (value) => Number(value || 0).toFixed(2) },
          { label: 'Tax', key: 'taxAmount', formatter: (value) => Number(value || 0).toFixed(2) },
          { label: 'Line Total', key: 'lineTotal', formatter: (value) => Number(value || 0).toFixed(2) },
          { label: 'Seller Warranty Coverage', key: 'sellerWarrantyCoverage' },
          { label: 'Seller Warranty Expiry (AD)', key: 'sellerWarrantyEndDateAD' },
          { label: 'Seller Warranty Expiry (BS)', key: 'sellerWarrantyEndDateBS' },
        ],
        reportTitle: single ? `Sales Invoice ${exported[0].invoiceNumber}` : 'Sales Invoices',
        branchName: scope,
        generatedBy: currentUser?.name,
        companyInfo: companyProfile,
      });
    } catch (err: any) {
      await alertDialog(`Export failed: ${err?.message || 'the full register could not be loaded'}. No file was written.`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={internalTab === 'CREATE' ? 'Create Sales Invoice' : viewing ? 'Sales Invoice Detail' : 'Sales Invoices Register'}
        description={
          internalTab === 'CREATE'
            ? 'Issue a tax invoice to a customer. Posting deducts branch stock immediately.'
            : viewing
              ? `Invoice ${viewing.invoiceNumber} — ${viewing.customerName}`
              : 'All issued customer tax invoices (INV-…) across branches.'
        }
        icon={internalTab === 'CREATE' ? <PlusCircle className="h-5 w-5" /> : <Receipt className="h-5 w-5" />}
        actions={
          viewing ? (
            <>
              <button className={btnGhost} onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> Print Invoice
              </button>
              <button
                className={btnGhost}
                onClick={() => { void handleExportCSV([viewing]); }}
                disabled={exporting}
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {exporting ? 'Exporting…' : 'Export Invoice CSV'}
              </button>
              <button className={btnGhost} onClick={() => setViewing(null)}>
                <ArrowLeft className="h-4 w-4" /> Back to Register
              </button>
            </>
          ) : internalTab === 'CREATE' ? (
            <button className={btnGhost} onClick={() => setInternalTab('LIST')}>
              <ArrowLeft className="h-4 w-4" /> Back to Register
            </button>
          ) : (
            <>
              <button
                className={btnGhost}
                onClick={() => { void handleExportCSV(); }}
                disabled={exporting}
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
              <button className={btnPrimary} onClick={() => setInternalTab('CREATE')}>
                <PlusCircle className="h-4 w-4" /> New Sales Invoice
              </button>
            </>
          )
        }
      />

      {viewing ? (
        <div className={`${formCardClass} printable-document space-y-4`}>
          {/* Company identity and document title appear in the print/PDF copy. */}
          <DocumentLetterhead
            companyProfile={companyProfile}
            title="TAX INVOICE"
            subtitle={`Invoice ${viewing.invoiceNumber} • ${viewing.customerName} • ${formatDualDate(viewing.invoiceDateAD, dateMode)}`}
          />
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div><div className={labelClass}>Invoice #</div><div className="font-medium">{viewing.invoiceNumber}</div></div>
            <div><div className={labelClass}>Customer</div><div className="font-medium">{viewing.customerName}</div></div>
            <div><div className={labelClass}>Branch</div><div className="font-medium">{branchName(viewing.branchId)}</div></div>
            <div><div className={labelClass}>Date</div><div className="font-medium">{dateMode === 'BS' && viewing.invoiceDateBS ? viewing.invoiceDateBS : viewing.invoiceDateAD}</div></div>
            <div>
              <div className={labelClass}>Document Status</div>
              <div className="font-medium">
                {viewing.status === 'CANCELLED' ? (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                    Cancelled
                  </span>
                ) : (
                  'Posted'
                )}
              </div>
            </div>
            <div><div className={labelClass}>Payment Status</div><div className="font-medium">{viewing.paymentStatus}</div></div>
            <div><div className={labelClass}>Amount Paid</div><div className="font-medium">{formatMoney(viewing.amountPaid)}</div></div>
            <div><div className={labelClass}>VAT</div><div className="font-medium">{formatMoney(viewing.vatAmount)}</div></div>
            <div><div className={labelClass}>Grand Total</div><div className="font-semibold">{formatMoney(viewing.grandTotal)}</div></div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'} text-left text-xs uppercase text-slate-500`}>
                  <th className="py-2">Product</th><th className="py-2">SKU</th><th className="py-2">Qty</th>
                  <th className="py-2">Unit Price</th><th className="py-2">Tax</th>
                  <th className="py-2">Seller warranty</th><th className="py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {(viewing.items || []).map((it, i) => (
                  <tr key={i} className={`border-b ${isDarkMode ? 'border-slate-800' : 'border-slate-100'}`}>
                    <td className="py-2">{it.productName}</td>
                    <td className="py-2">{it.sku}</td>
                    <td className="py-2">{it.quantity}</td>
                    <td className="py-2">{formatMoney(it.unitPrice)}</td>
                    <td className="py-2">{formatMoney(it.taxAmount || 0)}</td>
                    <td className="py-2"><SellerWarrantyLine item={it} dateMode={dateMode} /></td>
                    <td className="py-2">{formatMoney(it.total || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : internalTab === 'CREATE' ? (
        <div className={`${formCardClass} space-y-4`}>
          {/* In-card form header — the page header names the screen; this names
              the document being created and its posting side effects. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 font-serif text-base font-bold text-slate-900 dark:text-white">
                <Receipt className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <span>Create Sales Invoice</span>
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                Issue a customer tax invoice — pick the fulfilling branch and customer, scan or add each product line, verify the serials, then post. Stock, serial claims and seller warranty are recorded together.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-indigo-200 bg-indigo-100 px-2.5 py-1 text-[10px] font-extrabold text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
              Tax Invoice
            </span>
          </div>

          {/* DF-17: the pre-post serial gate reads this list; a failure clears
              it (never the previous branch's units) and offers the retry here. */}
          <LoadStateNotice
            subject="sellable serials"
            loading={inventorySerialsLoading}
            error={inventorySerialsError}
            hasCachedRows={inventorySerials.length > 0}
            onRetry={() => onRetryInventorySerials?.()}
            emptyNote=" The serial gate cannot verify units until this succeeds."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className={labelClass}>Branch *</label>
              <select className={inputClass} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {selectableBranches.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className={labelClass}>Sell to Customer *</label>
              <CustomerPicker
                value={customerPickerValue}
                onSelect={(customer) => {
                  setCustomerId(customer?.id || '');
                  setCustomerName(customer?.customerName || '');
                  setCustomerQuery(customer ? customerDisplay(customer) : '');
                }}
                search={api.searchCustomers}
                placeholder="Search customer name, code, phone, or address…"
                inputClassName="h-9 text-xs font-semibold"
                ariaLabel="Sell to customer"
                required
              />
            </div>
            <div>
              <label className={labelClass}>Invoice Date (AD) *</label>
              <input
                type="date"
                className={inputClass}
                value={invDateAD}
                min={todayAD}
                max={todayAD}
                onChange={(e) => {
                  // Only today is issueable: clamp anything typed or picked.
                  if (e.target.value !== todayAD) setInvDateAD(todayAD);
                }}
              />
              <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">Invoice can only be dated today — no past or future dates.</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <label className={labelClass}>Scan barcode or search product name / SKU to add *</label>
              <ProductSearchBar
                products={saleEligibleProducts}
                onAddOrIncrementProduct={addOrIncrementProduct}
                placeholder="Scan Barcode or Search & Enter Product Name / SKU to Add to Sales Invoice..."
                inputId="sale-product-search-input"
                stock={stock}
                selectedBranchId={branchId}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium">
                Sales Invoice Line Items ({lines.filter((l) => l.productId).length}) *
              </div>
              <button
                id="sale-add-line"
                type="button"
                onClick={() => { const p = saleEligibleProducts[0]; if (p) addOrIncrementProduct(p); }}
                disabled={saleEligibleProducts.length === 0}
                className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-xs hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add Product to Invoice
              </button>
            </div>

            {lines.every((l) => !l.productId) ? (
              <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-400 dark:border-slate-800">
                <PackageMinus className="mx-auto mb-2 h-8 w-8 text-slate-300 dark:text-slate-700" />
                <p className="text-sm">No product items added to this sales invoice yet.</p>
                <button
                  type="button"
                  onClick={() => { const p = saleEligibleProducts[0]; if (p) addOrIncrementProduct(p); }}
                  className="mt-2 cursor-pointer text-xs font-bold text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  + Click here to add products to sale invoice
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-100 text-[10px] tracking-wider text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                    <tr>
                      <th className="px-2.5 py-1.5">Product Name</th>
                      <th className="px-2.5 py-1.5 text-center">Branch Stock</th>
                      <th className="px-2.5 py-1.5 text-center">Sale Qty</th>
                      <th className="px-2.5 py-1.5 text-right">Unit Price (NPR)</th>
                      <th className="px-2.5 py-1.5 text-right">Discount (NPR)</th>
                      <th className="px-2.5 py-1.5 text-right">Subtotal (NPR)</th>
                      <th className="px-2.5 py-1.5 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {lines.map((line, idx) => {
                      if (!line.productId) return null;
                      const stockState = lineStock(line);
                      const serialQty = clampLineQuantity(line.quantity);
                      const lineGross = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
                      const subtotal = Math.max(0, lineGross - (Number(line.discount) || 0));
                      const isSerialized = isSerializedProduct(line.productId);
                      return (
                        <React.Fragment key={`${line.productId}-${idx}`}>
                          <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="min-w-[220px] p-2.5">
                              <select
                                className={`${inputClass} font-semibold`}
                                value={line.productId}
                                onChange={(e) => pickProduct(idx, e.target.value)}
                              >
                                {saleEligibleProducts.map((p) => (
                                  <option key={p.id} value={p.id}>[{p.sku}] {p.name} ({p.unit})</option>
                                ))}
                              </select>
                            </td>
                            <td className="p-2.5 text-center">
                              <div className={`font-mono font-bold ${stockState.className}`}>
                                {stockFor(line.productId)} {line.unit}
                              </div>
                              <div className={`text-[10px] ${stockState.className}`}>
                                {stockToneText[stockState.tone]}
                              </div>
                            </td>
                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                className={`${cellInputClass} w-16 text-center`}
                                value={line.quantity}
                                onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                              />
                            </td>
                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                className={`${cellInputClass} w-24 text-right`}
                                value={line.unitPrice}
                                onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value) })}
                              />
                            </td>
                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                className={`${cellInputClass} w-20 text-right text-amber-600 dark:text-amber-400`}
                                value={line.discount}
                                onChange={(e) => updateLine(idx, { discount: Number(e.target.value) })}
                              />
                            </td>
                            <td className="p-2.5 text-right font-mono font-bold">{formatMoney(subtotal)}</td>
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                title="Remove line"
                                onClick={() => removeLine(idx)}
                                className="cursor-pointer p-1 text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>

                          {isSerialized && (
                            <tr className="bg-indigo-50/50 dark:bg-indigo-950/30">
                              <td colSpan={7} className="p-2.5">
                                <div className="mb-1.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300">
                                  ✓ Verify serials for {line.productName} — {serialQty} unit{serialQty > 1 ? 's' : ''}
                                  {' · '}every serial must be IN_STOCK in inventory at {branchName(branchId)}
                                </div>
                                <div className="mb-2 flex flex-wrap items-center gap-2">
                                  <label
                                    htmlFor={`sale-warranty-covered-${idx}`}
                                    className="flex cursor-pointer items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                                  >
                                    <input
                                      id={`sale-warranty-covered-${idx}`}
                                      type="checkbox"
                                      checked={line.sellerWarrantyCovered !== false}
                                      onChange={(e) => updateLineWarrantyCovered(idx, e.target.checked)}
                                      className="h-3.5 w-3.5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                                    />
                                    Sellers warranty covered
                                  </label>
                                  {line.sellerWarrantyCovered !== false ? (
                                    <>
                                      <label
                                        htmlFor={`sale-warranty-${idx}`}
                                        className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400"
                                      >
                                        Expires
                                      </label>
                                      <input
                                        id={`sale-warranty-${idx}`}
                                        type="date"
                                        min={invDateAD}
                                        value={line.sellerWarrantyEndDateAD || ''}
                                        onChange={(e) => updateLineWarrantyEnd(idx, e.target.value)}
                                        className="rounded-lg border border-indigo-200 bg-white px-2 py-1 font-mono text-[11px] font-bold text-indigo-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-indigo-800 dark:bg-slate-900 dark:text-indigo-200"
                                      />
                                    </>
                                  ) : (
                                    <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                      No seller warranty
                                    </span>
                                  )}
                                  <span className="text-[10px] text-slate-500 dark:text-slate-400">
                                    {line.sellerWarrantyCovered !== false
                                      ? "Prefilled from the invoice date + this product's seller term; an edited date is kept."
                                      : 'No coverage will be recorded for these units.'}
                                  </span>
                                </div>
                                <table className="w-full text-left">
                                  <thead>
                                    <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                                      <th className="w-8 pb-1">#</th>
                                      <th className="pb-1">Device Serial *</th>
                                      <th className="pb-1">PON / MAC (from register)</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {Array.from({ length: serialQty }).map((_, sIdx) => (
                                      <tr key={sIdx}>
                                        <td className="py-1 font-mono text-[10px] font-bold text-slate-400 align-top">#{sIdx + 1}</td>
                                        <td className="py-1 pr-2" colSpan={2}>
                                          <DeviceSerialInput
                                            id={`sale-serial-device-${idx}-${sIdx}`}
                                            value={line.deviceSerials?.[sIdx]}
                                            onChange={(next) => updateSerial(idx, sIdx, next)}
                                            register={inventorySerials}
                                            branchId={branchId}
                                            productId={line.productId}
                                            productName={line.productName}
                                            onEnter={() => {
                                              if (sIdx + 1 < serialQty) {
                                                document.getElementById(`sale-serial-device-${idx}-${sIdx + 1}`)?.focus();
                                              } else {
                                                document.getElementById('sale-add-line')?.focus();
                                              }
                                            }}
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Notes (multi-line) sits beside the compact POS bill panel — both
              below the product bin, exactly where the totals used to render. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className={labelClass}>Notes</label>
              <textarea
                rows={4}
                className={`${inputClass} min-h-[6.5rem] resize-y leading-relaxed`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Sale remarks / notes…"
              />
            </div>

            {/* POS-counter bill panel: compact rows, total pinned at the bottom. */}
            <div className={`flex flex-col rounded-xl border p-3 ${isDarkMode ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50'}`}>
              <div className="space-y-1 font-mono text-xs">
                <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Gross</span><span>{formatMoney(lineTotals.gross)}</span></div>
                <div className="flex justify-between text-amber-600 dark:text-amber-400"><span>Discount</span><span>-{formatMoney(lineTotals.discount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Taxable</span><span>{formatMoney(lineTotals.taxable)}</span></div>
                {lineTotals.nonTaxable > 0 && (
                  <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Non-taxable</span><span>{formatMoney(lineTotals.nonTaxable)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">VAT ({getDefaultTaxRate()}%)</span><span>{formatMoney(lineTotals.vat)}</span></div>
              </div>
              <div className={`mt-3 flex items-baseline justify-between border-t pt-2 ${isDarkMode ? 'border-slate-700' : 'border-slate-300'}`}>
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Total</span>
                <span className="font-mono text-xl font-extrabold text-indigo-600 dark:text-indigo-400">{formatMoney(lineTotals.grand)}</span>
              </div>
            </div>
          </div>

          {/* Payment method + paid amount — their own row, right under notes/bill. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:max-w-xl">
            <div>
              <label className={labelClass}>Payment Method</label>
              <select className={inputClass} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
                {SALES_PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Amount Paid</label>
              <input type="number" min="0" className={inputClass} value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
          </div>

          {formError && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
              {formError}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={resetForm} disabled={submitting}>Clear</button>
            <button className={btnPrimary} onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />}
              Post Invoice
            </button>
          </div>
        </div>
      ) : (
        <>
          <FilterCard
            searchPlaceholder="Invoice # or customer…"
            searchValue={query}
            onSearchApply={setQuery}
            onClearAll={() => { setBranchFilter('ALL'); setQuery(''); }}
            hasActiveFilters={branchFilter !== 'ALL' || !!query}
            filterChildren={
              <div className="w-56">
                <label className={labelClass}>Branch</label>
                <select className={inputClass} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                  <option value="ALL">All Branches</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            }
          />

          {siLoadError && (
            <RegisterLoadError
              subject="this page of sales invoices"
              message={siLoadError}
              hasCachedRows={siRows.length > 0}
              loading={siLoading}
              onRetry={() => { void loadSiPage(); }}
            />
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0f1218]">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'} text-left text-xs uppercase text-slate-500`}>
                  <th className="px-4 py-3">Invoice #</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Seller warranty</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Grand Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((inv) => (
                  <tr key={inv.id} className={`border-b ${isDarkMode ? 'border-slate-800' : 'border-slate-100'} hover:bg-slate-50 dark:hover:bg-slate-800/40`}>
                    <td className="px-4 py-2 font-medium">{inv.invoiceNumber}</td>
                    <td className="px-4 py-2">{inv.customerName}</td>
                    <td className="px-4 py-2">{branchName(inv.branchId)}</td>
                    <td className="px-4 py-2">{dateMode === 'BS' && inv.invoiceDateBS ? inv.invoiceDateBS : inv.invoiceDateAD}</td>
                    <td className="px-4 py-2"><SellerWarrantySummary items={inv.items} dateMode={dateMode} /></td>
                    <td className="px-4 py-2">
                      {inv.status === 'CANCELLED' ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                          Cancelled
                        </span>
                      ) : (
                        inv.paymentStatus
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">{formatMoney(inv.grandTotal)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <button className="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400" title="View"
                        onClick={() => { setViewing(inv); }}>
                        <Eye className="h-4 w-4" />
                      </button>
                      {onRecordPayment && inv.status !== 'CANCELLED' && inv.paymentStatus !== 'PAID' && (
                        <button className="ml-2 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400" title="Record payment"
                          onClick={() => openPayment(inv)}>
                          <Banknote className="h-4 w-4" />
                        </button>
                      )}
                      {onCancelInvoice && inv.status !== 'CANCELLED' && (
                        <button className="ml-2 text-rose-600 hover:text-rose-700 dark:text-rose-400" title="Void invoice"
                          onClick={() => voidInvoice(inv)}>
                          <Ban className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-500">No sales invoices yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={safePage}
            pageSize={siPageSize}
            totalItems={totalItems}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPageChange={setSiPage}
            onPageSizeChange={(s) => { setSiPageSize(s); setSiPage(1); }}
          />
        </>
      )}

      {payInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !paySubmitting && setPayInvoice(null)}>
          <ModalPanel
            label="Record Customer Payment"
            onClose={() => {
              if (!paySubmitting) setPayInvoice(null);
            }}
            className={`${formCardClass} w-full max-w-md space-y-4`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-semibold">Record Customer Payment</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className={labelClass}>Invoice</div><div className="font-medium">{payInvoice.invoiceNumber}</div></div>
              <div><div className={labelClass}>Customer</div><div className="font-medium">{payInvoice.customerName}</div></div>
              <div><div className={labelClass}>Grand Total</div><div>{formatMoney(payInvoice.grandTotal)}</div></div>
              <div><div className={labelClass}>Already Paid</div><div>{formatMoney(payInvoice.amountPaid)}</div></div>
            </div>
            <div>
              <label className={labelClass}>Amount *</label>
              <input type="number" min="0" step="0.01" className={inputClass} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Method</label>
              <select className={inputClass} value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                {SALES_PAYMENT_METHODS.filter((m) => m.value !== 'CREDIT').map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {payError && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">{payError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className={btnGhost} onClick={() => setPayInvoice(null)} disabled={paySubmitting}>Cancel</button>
              <button className={btnPrimary} onClick={submitPayment} disabled={paySubmitting}>
                {paySubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                Record Payment
              </button>
            </div>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default SalesInvoices;
