/**
 * Returns Register — shared screen for Purchase Returns (DN-… debit notes)
 * and Sales Returns (CN-… credit notes).
 *
 * The create flow is "return against invoice": pick an original invoice,
 * prefill its lines, cap each quantity at the still-returnable amount
 * (invoiced − already returned), then post. Posting is transaction-wrapped on
 * the server: stock moves + ledger rows + the return document commit together.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFilterPageReset } from '../../utils/useFilterPageReset';
import {
  PlusCircle,
  Undo2,
  ArrowLeft,
  Loader2,
  Eye,
  Ban,
  CheckCircle2,
  PackageCheck,
  PackageX,
  Barcode,
} from 'lucide-react';
import { normalizeMacAddress } from '../../../../shared/macAddress';
import {
  duplicateSerialSlotIndex,
  findInvoiceSerialUnit,
  fitReturnSerialSlots,
  invoiceSerialUnits,
  returnSerialKey,
  returnSerialProblems,
  seedReturnSerialSlots,
  type ReturnSerialSlot,
} from '../../utils/returnSerials';
import { PageHeader } from '../../components/common/PageHeader';
import { formCardClass } from '../../components/common/FormCard';
import { FilterCard } from '../../components/common/FilterCard';
import { TablePagination, useServerPageClamp } from '../../components/common/TablePagination';
import { RegisterLoadError } from '../../components/common/RegisterLoadError';
import { SearchPicker } from '../../components/common/SearchPicker';
import { useDialog } from '../../components/common/DialogProvider';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { formatMoney } from '../../utils/nprFormat';
import { parseLineQuantity } from '../../utils/lineQuantity';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import { inputClass, labelClass, btnPrimary, btnGhost } from '../../components/common/styleConstants';
import { api } from '../../services/api';
import type {
  PurchaseInvoice, SalesInvoice, PurchaseReturn, SalesReturn, Product, Branch, CompanyProfile, User,
} from '../../types';

export type ReturnKind = 'PURCHASE' | 'SALES';

interface ReturnsRegisterProps {
  kind: ReturnKind;
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  /** Purchase invoices (kind=PURCHASE) to return against. The sales kind
   * searches its invoices through GET /api/sales-invoices instead. */
  purchaseInvoices: PurchaseInvoice[];
  returns: (PurchaseReturn | SalesReturn)[];
  products: Product[];
  branches: Branch[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  /** Sidebar menu that opened this page: opens the create form directly. */
  autoOpenCreate?: boolean;
  onCreateReturn: (payload: any) => Promise<any>;
  onCancelReturn?: (id: string, reason: string) => Promise<void>;
  /** Approves a DRAFT (above-threshold) return: DRAFT → POSTED with stock effects. */
  onApproveReturn?: (id: string) => Promise<void>;
  /** Bumped by App's SSE handler when procurement/sales return events arrive. */
  sseRefreshKey?: number;
}



const REASONS = ['DEFECTIVE', 'WRONG_ITEM', 'SHORT_SUPPLY', 'OTHER'] as const;

/** One unit per line: the identity a return document carries for that unit. */
function ReturnSerialsCell({ item }: { item: any }) {
  const entries = (Array.isArray(item?.deviceSerials) ? item.deviceSerials : [])
    .map((serial: any) => (typeof serial === 'string' ? { deviceSerial: serial } : serial))
    .filter((serial: any) => serial?.deviceSerial);
  if (entries.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <div className="space-y-0.5">
      {entries.map((serial: any, index: number) => (
        <div key={index} className="whitespace-normal break-words">
          <span className="font-semibold">{serial.deviceSerial}</span>
          {serial.ponSerial ? (
            <span className="text-slate-500 dark:text-slate-400"> · PON {serial.ponSerial}</span>
          ) : null}
          {serial.macAddress ? (
            <span className="text-slate-500 dark:text-slate-400"> · MAC {serial.macAddress}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface RetLine {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  isTaxExempt: boolean;
  maxQty: number;
  requiresSerials: boolean;
  /**
   * One identity per returned unit, sized to the quantity. Scanned, not typed
   * as a comma-separated list: a barcode reader ends each read with Enter and
   * the form moves to the next field, exactly like the purchase bill.
   */
  deviceSerials: ReturnSerialSlot[];
}

export const ReturnsRegister: React.FC<ReturnsRegisterProps> = ({
  kind,
  currentUser,
  purchaseInvoices,
  returns,
  products,
  branches,
  selectedBranchId,
  dateMode,
  autoOpenCreate = false,
  onCreateReturn,
  onCancelReturn,
  onApproveReturn,
  sseRefreshKey,
}) => {
  const { isDarkMode } = useDarkMode();
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const [internalTab, setInternalTab] = useState<'LIST' | 'CREATE' | 'VIEW'>(autoOpenCreate ? 'CREATE' : 'LIST');
  const [viewing, setViewing] = useState<PurchaseReturn | SalesReturn | null>(null);

  // Create-form state
  const [branchId, setBranchId] = useState(selectedBranchId || branches[0]?.id || '');
  const [invoiceRef, setInvoiceRef] = useState('');
  // The sales kind picks a full invoice row from the server search; the
  // purchase kind keeps its already-scoped bootstrap slice. One state so the
  // prefill/submit path stays identical for both.
  const [selectedSalesInvoice, setSelectedSalesInvoice] = useState<SalesInvoice | null>(null);
  const [retDateAD, setRetDateAD] = useState(() => new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState<(typeof REASONS)[number]>('DEFECTIVE');
  const [restockable, setRestockable] = useState(true);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<RetLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [query, setQuery] = useState('');

  const isPurchase = kind === 'PURCHASE';
  const docNumberLabel = isPurchase ? 'Debit Note (DN-…)' : 'Credit Note (CN-…)';

  // Server-side paged fetch state: the register asks /api/purchase-returns
  // or /api/sales-returns (by kind) for one page of filtered rows instead
  // of filtering the whole prop array.
  const [retRows, setRetRows] = useState<(PurchaseReturn | SalesReturn)[]>([]);
  const [retTotalItems, setRetTotalItems] = useState(0);
  const [retPage, setRetPage] = useState(1);
  const [retPageSize] = useState(25);
  const [retLoading, setRetLoading] = useState(true);
  const [retLoadError, setRetLoadError] = useState('');
  const [retRefreshKey, setRetRefreshKey] = useState(0);

  // Server-side paged fetch: one page of filtered return rows.
  const retFetchSeq = useRef(0);
  const loadRetPage = useCallback(async () => {
    const seq = ++retFetchSeq.current;
    setRetLoading(true);
    setRetLoadError('');
    try {
      const params = {
        branchId: branchFilter !== 'ALL' ? branchFilter : undefined,
        status: statusFilter !== 'ALL' ? statusFilter : undefined,
        query: query.trim() || undefined,
        page: retPage,
        pageSize: retPageSize,
      };
      const envelope = (isPurchase
        ? await api.getPurchaseReturns(params)
        : await api.getSalesReturns(params)) as { data: (PurchaseReturn | SalesReturn)[]; totalItems: number };
      if (seq !== retFetchSeq.current) return; // superseded
      setRetRows(envelope.data || []);
      setRetTotalItems(envelope.totalItems || 0);
    } catch (err: any) {
      if (seq !== retFetchSeq.current) return;
      setRetLoadError(err?.message || 'Failed to load the register');
    } finally {
      if (seq === retFetchSeq.current) setRetLoading(false);
    }
  }, [branchFilter, statusFilter, query, retPage, retPageSize, isPurchase]);

  useEffect(() => {
    loadRetPage();
  }, [loadRetPage, retRefreshKey, sseRefreshKey]);

  // A filter change snaps the page back to 1 in the same render, so one
  // change costs one request for page 1 instead of two (DF-12).
  useFilterPageReset(
    [branchFilter, statusFilter, query, isPurchase].join('\u0000'),
    retPage,
    setRetPage
  );

  const selectedInvoice = useMemo(() => {
    if (!isPurchase) return selectedSalesInvoice;
    if (!invoiceRef) return null;
    return purchaseInvoices.find((i) => i.id === invoiceRef || i.invoiceNumber === invoiceRef) || null;
  }, [isPurchase, invoiceRef, purchaseInvoices, selectedSalesInvoice]);

  /** Already-returned qty per product for the selected invoice (from posted returns). */
  const returnedQtyFor = (invoiceId: string | undefined, productId: string): number => {
    if (!invoiceId) return 0;
    return returns
      .filter((r: any) => r.originalInvoiceId === invoiceId && r.status === 'POSTED')
      .flatMap((r) => r.items || [])
      .filter((it: any) => it.productId === productId)
      .reduce((s: number, it: any) => s + (Math.abs(Number(it.quantity)) || 0), 0);
  };

  /** Serials a posted return already took back for one invoice line. */
  const returnedSerialsFor = (invoiceId: string | undefined, productId: string): string[] => {
    if (!invoiceId) return [];
    return returns
      .filter((r: any) => r.originalInvoiceId === invoiceId && r.status === 'POSTED')
      .flatMap((r: any) => r.items || [])
      .filter((it: any) => it.productId === productId)
      .flatMap((it: any) => it.deviceSerials || [])
      .map((s: any) => (typeof s === 'string' ? s : s?.deviceSerial))
      .filter(Boolean);
  };

  /**
   * Sales-invoice search for the returns picker. Server-side (invoice number
   * or customer name) over the paged endpoint, so a return can target an
   * invoice far outside the first page; `refreshToken` re-runs it when a
   * sales event lands while the field is open.
   */
  const searchSalesInvoices = useCallback(async (q: string): Promise<SalesInvoice[]> => {
    const envelope = await api.getSalesInvoices({
      branchId: branchId !== 'ALL' ? branchId : undefined,
      query: q,
      page: 1,
      pageSize: 20,
    });
    return Array.isArray(envelope) ? envelope : envelope.data;
  }, [branchId]);

  const applyInvoice = (inv: PurchaseInvoice | SalesInvoice) => {
    setInvoiceRef(inv.id);
    setLines([]);
    setFormError('');
    setBranchId(inv.branchId);
    const nextLines = (inv.items || []).map((it: any) => {
        const invoiced = Math.abs(Number(it.quantity)) || 0;
        const already = returnedQtyFor(inv.id, it.productId);
        const returnable = Math.max(0, invoiced - already);
        const p = products.find((pr) => pr.id === it.productId);
        return {
          productId: it.productId,
          productName: it.productName,
          sku: it.sku || '',
          unit: it.unit || '',
          quantity: returnable,
          unitPrice: Number(it.unitPrice) || 0,
          isTaxExempt: (Number(it.taxRate) || 0) === 0,
          maxQty: returnable,
          requiresSerials: Boolean(p?.requiresSerialTracking),
          // Seeded from the invoice's own units, minus those already returned,
          // so scanning the first unit lands on the right slot and no serial is
          // offered twice.
          deviceSerials: seedReturnSerialSlots({
            invoiceItems: inv.items,
            productId: it.productId,
            quantity: returnable,
            alreadyReturned: returnedSerialsFor(inv.id, it.productId),
          }),
        };
      });
    setLines(nextLines);
    // Put the caret in the first unit that still needs an identity, so a
    // barcode reader's next read lands there instead of nowhere. Lines the
    // invoice fully seeded have nothing to scan and keep the focus untouched.
    const firstLine = nextLines.findIndex((line) =>
      line.deviceSerials.some((slot) => !slot.deviceSerial.trim())
    );
    if (firstLine >= 0) {
      const firstSlot = nextLines[firstLine].deviceSerials.findIndex(
        (slot) => !slot.deviceSerial.trim()
      );
      requestAnimationFrame(() =>
        focusReturnField(`ret-serial-device-${firstLine}-${firstSlot}`)
      );
    }
  };

  const lineTotals = useMemo(() => {
    // Company-configured VAT rate (company_profile.default_tax_rate via
    // bootstrap) — never a hard-coded 13.
    const vatRate = getDefaultTaxRate();
    let taxable = 0, nonTaxable = 0, vat = 0;
    for (const l of lines) {
      if (!l.productId) continue;
      const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
      if (l.isTaxExempt) { nonTaxable += gross; continue; }
      taxable += gross;
      vat += (gross * vatRate) / 100;
    }
    return { taxable, nonTaxable, vat, grand: taxable + nonTaxable + vat };
  }, [lines]);

  const updateLine = (idx: number, patch: Partial<RetLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  /**
   * Quantity drives the serial slots: one row per returned unit, like the
   * purchase bill. Lowering the quantity drops the tail (a unit no longer being
   * returned must not keep its identity); raising it adds empty units.
   */
  const updateLineQuantity = (idx: number, quantity: number) => {
    setLines((prev) =>
      prev.map((l, i) =>
        i === idx
          ? { ...l, quantity, deviceSerials: fitReturnSerialSlots(l.deviceSerials, quantity) }
          : l
      )
    );
  };

  const updateLineSerial = (lineIdx: number, serialIdx: number, patch: Partial<ReturnSerialSlot>) => {
    setLines((prev) =>
      prev.map((line, i) => {
        if (i !== lineIdx) return line;
        const deviceSerials = line.deviceSerials.map((slot, s) =>
          s === serialIdx ? { ...slot, ...patch } : slot
        );
        return { ...line, deviceSerials };
      })
    );
  };

  /** Scanned/typed device serial: MAC and PON come from the invoice's unit. */
  const updateLineDeviceSerial = (lineIdx: number, serialIdx: number, raw: string) => {
    const line = lines[lineIdx];
    const units = selectedInvoice ? invoiceSerialUnits(selectedInvoice.items, line.productId) : [];
    const unit = findInvoiceSerialUnit(units, raw);
    updateLineSerial(lineIdx, serialIdx, {
      deviceSerial: raw,
      ...(unit ? { macAddress: unit.macAddress, ponSerial: unit.ponSerial } : {}),
    });
  };

  /** A barcode often carries the MAC without separators; canonicalise on blur/Enter. */
  const normalizeLineMac = (lineIdx: number, serialIdx: number) => {
    const current = lines[lineIdx]?.deviceSerials?.[serialIdx]?.macAddress;
    const normalized = normalizeMacAddress(current);
    if (normalized !== current) updateLineSerial(lineIdx, serialIdx, { macAddress: normalized });
  };

  const focusReturnField = (id: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.focus();
    if ('select' in el) el.select();
  };

  /** The next unit still missing its device serial, across later lines. */
  const focusNextDeviceSlot = (lineIdx: number, serialIdx: number) => {
    for (let li = lineIdx; li < lines.length; li += 1) {
      const start = li === lineIdx ? serialIdx + 1 : 0;
      for (let si = start; si < lines[li].deviceSerials.length; si += 1) {
        if (!lines[li].deviceSerials[si].deviceSerial.trim()) {
          focusReturnField(`ret-serial-device-${li}-${si}`);
          return;
        }
      }
    }
    focusReturnField('return-notes');
  };

  const resetForm = () => {
    setInvoiceRef(''); setSelectedSalesInvoice(null); setLines([]); setNotes(''); setReason('DEFECTIVE'); setRestockable(true);
    setFormError('');
  };

  const submit = async () => {
    setFormError('');
    const validLines = lines.filter((l) => l.productId && (Number(l.quantity) || 0) > 0);
    if (!selectedInvoice) { setFormError('Select the original invoice to return against.'); return; }
    if (validLines.length === 0) { setFormError('Add at least one item with a quantity.'); return; }
    const over = validLines.find((l) => (Number(l.quantity) || 0) > l.maxQty);
    if (over) {
      setFormError(`Cannot return more than ${over.maxQty} × ${over.productName} (invoiced minus already returned).`);
      return;
    }
    // Per-unit identity: one scanned device serial per unit, no duplicates.
    // The server then checks the register (existence, product, original
    // invoice, expected state) and fills MAC/PON from it.
    const serialProblem = returnSerialProblems(validLines);
    if (serialProblem) {
      setFormError(serialProblem);
      return;
    }
    setSubmitting(true);
    try {
      const items = validLines.map((l, i) => {
        const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
        const serials = l.deviceSerials
          .filter((slot) => returnSerialKey(slot.deviceSerial))
          .map((slot) => ({
            deviceSerial: slot.deviceSerial.trim(),
            macAddress: slot.macAddress.trim() || undefined,
            ponSerial: slot.ponSerial.trim() || undefined,
          }));
        return {
          id: `ret-${Date.now()}-${i}`,
          productId: l.productId,
          productName: l.productName,
          sku: l.sku,
          unit: l.unit,
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          isTaxExempt: l.isTaxExempt,
          taxRate: l.isTaxExempt ? 0 : getDefaultTaxRate(),
          subtotal: gross,
          taxAmount: l.isTaxExempt ? 0 : (gross * getDefaultTaxRate()) / 100,
          total: l.isTaxExempt ? gross : gross * (1 + getDefaultTaxRate() / 100),
          ...(l.requiresSerials ? { deviceSerials: serials } : {}),
        };
      });
      const partyFields = isPurchase
        ? { supplierId: (selectedInvoice as PurchaseInvoice).supplierId, supplierName: (selectedInvoice as PurchaseInvoice).supplierName }
        : { customerId: (selectedInvoice as SalesInvoice).customerId, customerName: (selectedInvoice as SalesInvoice).customerName };
      const created: any = await onCreateReturn({
        originalInvoiceId: selectedInvoice.id,
        originalInvoiceNumber: selectedInvoice.invoiceNumber,
        branchId,
        returnDateAD: retDateAD,
        returnDateBS: '',
        reason,
        restockable: isPurchase ? undefined : restockable,
        notes,
        items,
        taxableAmount: lineTotals.taxable,
        vatAmount: lineTotals.vat,
        nonTaxableAmount: lineTotals.nonTaxable,
        grandTotal: lineTotals.grand,
        ...partyFields,
      });
      if (created?.pendingApproval) {
        await alertDialog(
          `${created.returnNumber} is held for approval (Rs. ${created.grandTotal} exceeds the Rs. ${created.approvalThreshold} threshold). It will not affect stock or the ledger until it is approved from the register.`,
          { title: 'Held for Approval' }
        );
      }
      resetForm();
      setInternalTab('LIST');
      setRetRefreshKey((k) => k + 1);
    } catch (e: any) {
      setFormError(e?.message || 'Failed to create the return.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (ret: PurchaseReturn | SalesReturn) => {
    const ok = await confirmDialog(
      `Cancel ${ret.returnNumber}? ` +
        (isPurchase
          ? 'Cancelling restores the returned stock to the branch; the debit note stays in the register as CANCELLED.'
          : 'Cancelling removes the restocked units from the branch again; the credit note stays in the register as CANCELLED.'),
      { title: 'Cancel Return', confirmLabel: 'Cancel Return', cancelLabel: 'Keep' }
    );
    if (!ok) return;
    try {
      await onCancelReturn?.(ret.id, 'Cancelled from register');
      setRetRefreshKey((k) => k + 1);
    } catch (e: any) {
      setFormError(e?.message || 'Failed to cancel the return.');
    }
  };

  const filtered = useMemo(() => {
    let list = returns as any[];
    if (branchFilter !== 'ALL') list = list.filter((r) => r.branchId === branchFilter);
    if (statusFilter !== 'ALL') list = list.filter((r) => r.status === statusFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((r) =>
        r.returnNumber.toLowerCase().includes(q) ||
        (r.originalInvoiceNumber || '').toLowerCase().includes(q) ||
        (isPurchase ? r.supplierName || '' : r.customerName || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [returns, branchFilter, statusFilter, query, isPurchase]);

  // Rows on screen: the server page, or (on fetch failure) the client-side
  // filtered prop array so the register degrades instead of breaking.
  const pageRows = retLoadError ? filtered : retRows;
  const totalItems = retLoadError ? filtered.length : retTotalItems;
  const pageSize = retPageSize;
  // A delete can shrink the filtered set under the current page; snap back to
  // the new last page instead of asking the server for one that is gone (DF-09).
  const page = useServerPageClamp(retPage, pageSize, totalItems, setRetPage);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalItems);
  const setPage = (p: number) => setRetPage(Math.max(1, p));

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || id;
  const partyName = (r: any) => (isPurchase ? r.supplierName : r.customerName) || '—';

  const statusChip = (status: string) => {
    const cls =
      status === 'POSTED'
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
        : status === 'CANCELLED'
          ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400';
    return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status === 'DRAFT' ? 'DRAFT (APPROVAL)' : status}</span>;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          internalTab === 'CREATE'
            ? isPurchase ? 'Create Purchase Return' : 'Create Sales Return'
            : viewing
              ? (isPurchase ? 'Purchase Return Detail' : 'Sales Return Detail')
              : isPurchase ? 'Purchase Returns Register' : 'Sales Returns Register'
        }
        description={
          internalTab === 'CREATE'
            ? `Return goods against an original invoice. The server issues the ${docNumberLabel} number and enforces the returnable-quantity cap.`
            : viewing
              ? `${viewing.returnNumber} — against invoice ${viewing.originalInvoiceNumber || '—'}`
              : isPurchase
                ? 'Goods returned to vendors (debit notes) with stock deduction and ledger entries.'
                : 'Goods returned by customers (credit notes) with restock control and ledger entries.'
        }
        icon={internalTab === 'CREATE' ? <PlusCircle className="h-5 w-5" /> : <Undo2 className="h-5 w-5" />}
        actions={
          viewing ? (
            <button className={btnGhost} onClick={() => setViewing(null)}>
              <ArrowLeft className="h-4 w-4" /> Back to Register
            </button>
          ) : internalTab === 'CREATE' ? (
            <button className={btnGhost} onClick={() => setInternalTab('LIST')}>
              <ArrowLeft className="h-4 w-4" /> Back to Register
            </button>
          ) : (
            <button className={btnPrimary} onClick={() => { resetForm(); setInternalTab('CREATE'); }}>
              <PlusCircle className="h-4 w-4" /> New {isPurchase ? 'Purchase' : 'Sales'} Return
            </button>
          )
        }
      />

      {viewing ? (
        <div className={`${formCardClass} space-y-4`}>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div><div className={labelClass}>Return #</div><div className="font-medium">{viewing.returnNumber}</div></div>
            <div><div className={labelClass}>Original Invoice</div><div className="font-medium">{viewing.originalInvoiceNumber || '—'}</div></div>
            <div><div className={labelClass}>{isPurchase ? 'Supplier' : 'Customer'}</div><div className="font-medium">{partyName(viewing)}</div></div>
            <div><div className={labelClass}>Branch</div><div className="font-medium">{branchName(viewing.branchId)}</div></div>
            <div><div className={labelClass}>Date</div><div className="font-medium">{dateMode === 'BS' && viewing.returnDateBS ? viewing.returnDateBS : viewing.returnDateAD}</div></div>
            <div><div className={labelClass}>Reason</div><div className="font-medium">{viewing.reason}</div></div>
            <div><div className={labelClass}>Status</div><div>{statusChip(viewing.status)}</div></div>
            <div><div className={labelClass}>Grand Total</div><div className="font-semibold">{formatMoney(viewing.grandTotal)}</div></div>
            {!isPurchase && (
              <div><div className={labelClass}>Restocked</div><div className="font-medium">{(viewing as SalesReturn).restockable !== false ? 'Yes' : 'No (damaged)'}</div></div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'} text-left text-xs uppercase text-slate-500`}>
                  <th className="py-2">Product</th><th className="py-2">SKU</th><th className="py-2">Qty</th>
                  <th className="py-2">Unit Price</th><th className="py-2">Total</th>
                  <th className="py-2">Serials (Device / PON / MAC)</th>
                </tr>
              </thead>
              <tbody>
                {(viewing.items || []).map((it: any, i: number) => (
                  <tr key={i} className={`border-b ${isDarkMode ? 'border-slate-800' : 'border-slate-100'}`}>
                    <td className="py-2">{it.productName}</td>
                    <td className="py-2">{it.sku}</td>
                    <td className="py-2">{it.quantity}</td>
                    <td className="py-2">{formatMoney(it.unitPrice)}</td>
                    <td className="py-2">{formatMoney(it.total || it.quantity * it.unitPrice)}</td>
                    <td className="py-2 font-mono text-[11px]"><ReturnSerialsCell item={it} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : internalTab === 'CREATE' ? (
        <div className={`${formCardClass} space-y-4`}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className={labelClass}>Original Invoice *</label>
              {isPurchase ? (
                <select
                  className={inputClass}
                  value={invoiceRef}
                  onChange={(e) => {
                    const ref = e.target.value;
                    setInvoiceRef(ref);
                    setLines([]);
                    setFormError('');
                    const inv = purchaseInvoices.find((i) => i.id === ref || i.invoiceNumber === ref);
                    if (inv) applyInvoice(inv);
                  }}
                >
                  <option value="">— Select invoice —</option>
                  {purchaseInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoiceNumber} · {inv.supplierName} · {formatMoney(inv.grandTotal)}
                    </option>
                  ))}
                </select>
              ) : (
                <SearchPicker<SalesInvoice>
                  value={
                    selectedSalesInvoice
                      ? { id: selectedSalesInvoice.id, label: `${selectedSalesInvoice.invoiceNumber} · ${selectedSalesInvoice.customerName}` }
                      : null
                  }
                  onSelect={(inv) => {
                    if (inv) {
                      setSelectedSalesInvoice(inv);
                      applyInvoice(inv);
                    } else {
                      setSelectedSalesInvoice(null);
                      setInvoiceRef('');
                      setLines([]);
                      setFormError('');
                    }
                  }}
                  search={searchSalesInvoices}
                  itemKey={(inv) => inv.id}
                  itemLabel={(inv) => `${inv.invoiceNumber} · ${inv.customerName}`}
                  renderOption={(inv) => (
                    <div className="min-w-0 pr-2">
                      <div className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-white">
                        {inv.invoiceNumber} · {inv.customerName}
                      </div>
                      <div className="break-words text-[11px] text-slate-500 dark:text-slate-400">
                        {inv.invoiceDateAD} · {formatMoney(inv.grandTotal)} · {branchName(inv.branchId)}
                      </div>
                    </div>
                  )}
                  placeholder="Search invoice number or customer…"
                  ariaLabel="Search sales invoices"
                  inputClassName="h-9 text-xs font-semibold"
                  labels={{
                    hint: 'Type at least 2 characters to search invoices.',
                    empty: 'No matching invoice.',
                    error: 'Could not search invoices.',
                  }}
                  refreshToken={sseRefreshKey}
                />
              )}
            </div>
            <div>
              <label className={labelClass}>Branch *</label>
              <select className={inputClass} value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={!!selectedInvoice}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Return Date (AD) *</label>
              <input type="date" className={inputClass} value={retDateAD} onChange={(e) => setRetDateAD(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Reason</label>
              <select className={inputClass} value={reason} onChange={(e) => setReason(e.target.value as any)}>
                {REASONS.filter((r) => isPurchase || r !== 'SHORT_SUPPLY').map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
              </select>
            </div>
            {!isPurchase && (
              <div>
                <label className={labelClass}>Restock</label>
                <div className="flex items-center gap-4 pt-1.5">
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input type="radio" checked={restockable} onChange={() => setRestockable(true)} />
                    <PackageCheck className="h-4 w-4 text-emerald-600" /> Re-sellable
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input type="radio" checked={!restockable} onChange={() => setRestockable(false)} />
                    <PackageX className="h-4 w-4 text-red-600" /> Damaged
                  </label>
                </div>
              </div>
            )}
            <div>
              <label className={labelClass}>Notes</label>
              <input
                id="return-notes"
                className={inputClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          {lines.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">Items (capped at returnable quantity)</div>
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 items-end gap-2">
                  <div className="col-span-5">
                    <div className={`rounded-lg border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50'}`}>
                      {line.productName} <span className="text-xs text-slate-500">({line.sku})</span>
                    </div>
                  </div>
                  <div className="col-span-2">
                    <input type="number" min="0" max={line.maxQty} className={inputClass} value={line.quantity}
                      onChange={(e) => updateLineQuantity(idx, parseLineQuantity(e.target.value, 0))} placeholder="Qty" />
                  </div>
                  <div className="col-span-2">
                    <div className={`rounded-lg border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50'}`}>
                      {formatMoney(line.unitPrice)}
                    </div>
                  </div>
                  <div className="col-span-2 text-xs text-slate-500">
                    returnable: {line.maxQty}
                  </div>
                  <div className="col-span-1">
                    <button className="text-red-500 hover:text-red-600" title="Exclude line"
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
                  </div>
                  {line.requiresSerials && (
                    <div className="col-span-12 rounded-xl border border-indigo-200 bg-indigo-50/40 p-2.5 dark:border-indigo-900 dark:bg-indigo-950/30">
                      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] font-bold text-indigo-800 dark:text-indigo-300">
                        <Barcode className="h-3.5 w-3.5" />
                        <span>
                          Serial numbers — scan Device, MAC and PON per unit ({line.deviceSerials.length}{' '}
                          unit{line.deviceSerials.length === 1 ? '' : 's'})
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {line.deviceSerials.map((slot, sIdx) => {
                          const units = selectedInvoice
                            ? invoiceSerialUnits(selectedInvoice.items, line.productId)
                            : [];
                          const matched = Boolean(findInvoiceSerialUnit(units, slot.deviceSerial));
                          const duplicateIdx = duplicateSerialSlotIndex(
                            line.deviceSerials,
                            slot.deviceSerial,
                            sIdx
                          );
                          return (
                            <div
                              key={sIdx}
                              className="rounded-xl border border-indigo-200 bg-white p-2.5 text-xs shadow-xs dark:border-indigo-900 dark:bg-slate-900"
                            >
                              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1">
                                <span className="font-mono text-[10px] font-bold text-slate-400">Unit #{sIdx + 1}</span>
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                  Device required · MAC/PON from invoice
                                </span>
                              </div>
                              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                                <input
                                  id={`ret-serial-device-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="Device Serial #"
                                  value={slot.deviceSerial}
                                  onChange={(e) => updateLineDeviceSerial(idx, sIdx, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    // A scan of the unit that the invoice already identifies
                                    // has its MAC/PON filled, so Enter goes straight to the
                                    // next unit; otherwise it walks the identity fields.
                                    if (slot.macAddress || slot.ponSerial) {
                                      focusNextDeviceSlot(idx, sIdx);
                                    } else {
                                      focusReturnField(`ret-serial-mac-${idx}-${sIdx}`);
                                    }
                                  }}
                                  className="w-full rounded-lg border border-blue-200 bg-blue-50/50 px-2.5 py-1 text-[11px] font-mono font-bold text-blue-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-200 dark:focus:bg-slate-900"
                                />
                                <input
                                  id={`ret-serial-mac-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="MAC Address"
                                  value={slot.macAddress}
                                  onChange={(e) =>
                                    updateLineSerial(idx, sIdx, { macAddress: e.target.value })
                                  }
                                  onBlur={() => normalizeLineMac(idx, sIdx)}
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    normalizeLineMac(idx, sIdx);
                                    focusReturnField(`ret-serial-pon-${idx}-${sIdx}`);
                                  }}
                                  className="w-full rounded-lg border border-emerald-200 bg-emerald-50/50 px-2.5 py-1 text-[11px] font-mono font-bold text-emerald-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200 dark:focus:bg-slate-900"
                                />
                                <input
                                  id={`ret-serial-pon-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="PON Serial # (optional)"
                                  value={slot.ponSerial}
                                  onChange={(e) =>
                                    updateLineSerial(idx, sIdx, { ponSerial: e.target.value })
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key !== 'Enter') return;
                                    e.preventDefault();
                                    focusNextDeviceSlot(idx, sIdx);
                                  }}
                                  className="w-full rounded-lg border border-indigo-200 bg-indigo-50/50 px-2.5 py-1 text-[11px] font-mono font-bold text-indigo-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200 dark:focus:bg-slate-900"
                                />
                              </div>
                              {slot.deviceSerial.trim() && duplicateIdx >= 0 && (
                                <div className="mt-1 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                                  Already used on unit #{duplicateIdx + 1}.
                                </div>
                              )}
                              {slot.deviceSerial.trim() && duplicateIdx < 0 && matched && (
                                <div className="mt-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                  On the original invoice — MAC/PON filled from it.
                                </div>
                              )}
                              {slot.deviceSerial.trim() && duplicateIdx < 0 && !matched && (
                                <div className="mt-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                  Not recorded on the original invoice line — check the serial.
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className={`rounded-lg border p-3 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex justify-between"><span>Taxable</span><span>{formatMoney(lineTotals.taxable)}</span></div>
            <div className="flex justify-between"><span>VAT ({getDefaultTaxRate()}%)</span><span>{formatMoney(lineTotals.vat)}</span></div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold" style={{ borderColor: isDarkMode ? '#334155' : '#e2e8f0' }}>
              <span>{isPurchase ? 'Debit Note Total' : 'Credit Note Total'}</span><span>{formatMoney(lineTotals.grand)}</span>
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
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
              Post Return
            </button>
          </div>
        </div>
      ) : (
        <>
          <FilterCard
            searchPlaceholder="Return #, invoice #, party…"
            searchValue={query}
            onSearchApply={setQuery}
            onClearAll={() => { setBranchFilter('ALL'); setStatusFilter('ALL'); setQuery(''); }}
            hasActiveFilters={branchFilter !== 'ALL' || statusFilter !== 'ALL' || !!query}
            filterChildren={
              <div className="flex gap-3">
                <div className="w-48">
                  <label className={labelClass}>Branch</label>
                  <select className={inputClass} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                    <option value="ALL">All Branches</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="w-40">
                  <label className={labelClass}>Status</label>
                  <select className={inputClass} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="ALL">All</option>
                    <option value="POSTED">POSTED</option>
                    <option value="DRAFT">DRAFT (APPROVAL)</option>
                    <option value="CANCELLED">CANCELLED</option>
                  </select>
                </div>
              </div>
            }
          />

          {retLoadError && (
            <RegisterLoadError
              subject="this page of returns"
              message={retLoadError}
              hasCachedRows={filtered.length > 0}
              loading={retLoading}
              onRetry={() => { void loadRetPage(); }}
            />
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0f1218]">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'} text-left text-xs uppercase text-slate-500`}>
                  <th className="px-4 py-3">Return #</th>
                  <th className="px-4 py-3">Original Invoice</th>
                  <th className="px-4 py-3">{isPurchase ? 'Supplier' : 'Customer'}</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((ret: any) => (
                  <tr key={ret.id} className={`border-b ${isDarkMode ? 'border-slate-800' : 'border-slate-100'} hover:bg-slate-50 dark:hover:bg-slate-800/40`}>
                    <td className="px-4 py-2 font-medium">{ret.returnNumber}</td>
                    <td className="px-4 py-2">{ret.originalInvoiceNumber || '—'}</td>
                    <td className="px-4 py-2">{partyName(ret)}</td>
                    <td className="px-4 py-2">{branchName(ret.branchId)}</td>
                    <td className="px-4 py-2">{dateMode === 'BS' && ret.returnDateBS ? ret.returnDateBS : ret.returnDateAD}</td>
                    <td className="px-4 py-2">{String(ret.reason || '').replace('_', ' ')}</td>
                    <td className="px-4 py-2">{statusChip(ret.status)}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(ret.grandTotal)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <button className="mr-2 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400" title="View"
                        onClick={() => { setViewing(ret); }}>
                        <Eye className="h-4 w-4" />
                      </button>
                      {ret.status === 'DRAFT' && onApproveReturn && (
                        <button className="mr-2 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400" title="Approve & post (applies stock + ledger)"
                          onClick={async () => {
                            const ok = await confirmDialog(
                              `Approve ${ret.returnNumber}? This posts the return: stock, ledger entries and serial statuses are applied now.`,
                              { title: 'Approve Return', confirmLabel: 'Approve & Post', cancelLabel: 'Not yet' }
                            );
                            if (ok) {
                              try { await onApproveReturn(ret.id); setRetRefreshKey((k) => k + 1); } catch (e: any) { setFormError(e?.message || 'Failed to approve the return.'); }
                            }
                          }}>
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                      )}
                      {ret.status === 'POSTED' && onCancelReturn && (
                        <button className="text-red-500 hover:text-red-600" title="Cancel return"
                          onClick={() => cancel(ret)}>
                          <Ban className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-500">No returns recorded yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={page}
            pageSize={pageSize}
            totalItems={totalItems}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
};

export default ReturnsRegister;
