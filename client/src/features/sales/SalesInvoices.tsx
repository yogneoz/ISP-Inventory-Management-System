/**
 * Sales Invoices — register + create form (INV-… documents).
 *
 * Lean sales module: posting decrements branch stock (server-guarded against
 * negative stock) and appends SALES_INVOICE ledger rows. Sales Returns
 * validate against the sold quantities recorded here.
 */
import React, { useMemo, useState } from 'react';
import {
  PlusCircle,
  Receipt,
  ArrowLeft,
  Loader2,
  Eye,
  Banknote,
} from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { formCardClass } from '../../components/common/FormCard';
import { FilterCard } from '../../components/common/FilterCard';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDialog } from '../../components/common/DialogProvider';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { formatMoney } from '../../utils/nprFormat';
import { inputClass, labelClass, btnPrimary, btnGhost } from '../../components/common/styleConstants';
import { api } from '../../services/api';
import type {
  SalesInvoice, SalesInvoiceItem, Product, Branch, InventoryStock, CompanyProfile, User,
} from '../../types';

interface SalesInvoicesProps {
  companyProfile?: CompanyProfile | null;
  currentUser?: User | null;
  invoices: SalesInvoice[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  activeTab?: 'create-sale' | 'sales-list';
  onCreateInvoice: (inv: Omit<SalesInvoice, 'id' | 'invoiceNumber'>) => Promise<void>;
  /** Records a dated customer receipt (customer_payments sub-ledger). */
  onRecordPayment?: (invoice: SalesInvoice, amount: number, paymentMethod: string) => Promise<void>;
}



interface FormLine {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  isTaxExempt: boolean;
}

export const SalesInvoices: React.FC<SalesInvoicesProps> = ({
  companyProfile,
  currentUser,
  invoices,
  products,
  branches,
  stock,
  selectedBranchId,
  dateMode,
  activeTab = 'sales-list',
  onCreateInvoice,
  onRecordPayment,
}) => {
  const { isDarkMode } = useDarkMode();
  const { confirm } = useDialog();
  const [internalTab, setInternalTab] = useState<'LIST' | 'CREATE'>(
    activeTab === 'create-sale' ? 'CREATE' : 'LIST'
  );
  const [viewing, setViewing] = useState<SalesInvoice | null>(null);

  // Create-form state
  const [branchId, setBranchId] = useState(selectedBranchId || branches[0]?.id || '');
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [invDateAD, setInvDateAD] = useState(() => new Date().toISOString().split('T')[0]);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'CREDIT' | 'BANK_TRANSFER' | 'CHEQUE' | 'ONLINE' | 'CARD' | 'OTHER'>('CASH');
  const [amountPaid, setAmountPaid] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<FormLine[]>([
    { productId: '', productName: '', sku: '', unit: '', quantity: 1, unitPrice: 0, isTaxExempt: false },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [query, setQuery] = useState('');

  // Record-payment state (customer_payments sub-ledger)
  const [payInvoice, setPayInvoice] = useState<SalesInvoice | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [payError, setPayError] = useState('');

  const lineTotals = useMemo(() => {
    let taxable = 0, nonTaxable = 0, vat = 0;
    for (const l of lines) {
      if (!l.productId) continue;
      const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
      if (l.isTaxExempt) { nonTaxable += gross; continue; }
      taxable += gross;
      vat += (gross * 13) / 100;
    }
    return { taxable, nonTaxable, vat, grand: taxable + nonTaxable + vat };
  }, [lines]);

  const stockFor = (productId: string): number =>
    stock.find((s) => s.productId === productId && s.branchId === branchId)?.quantityOnHand ?? 0;

  const updateLine = (idx: number, patch: Partial<FormLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const pickProduct = (idx: number, productId: string) => {
    const p = products.find((pr) => pr.id === productId);
    if (!p) { updateLine(idx, { productId: '' }); return; }
    updateLine(idx, {
      productId,
      productName: p.name,
      sku: p.sku || '',
      unit: p.unit || '',
      unitPrice: Number(p.sellingPrice) || 0,
      isTaxExempt: (Number(p.taxRate) || 0) === 0,
    });
  };

  const resetForm = () => {
    setCustomerId(''); setCustomerName(''); setNotes(''); setAmountPaid('0');
    setLines([{ productId: '', productName: '', sku: '', unit: '', quantity: 1, unitPrice: 0, isTaxExempt: false }]);
    setFormError('');
  };

  const submit = async () => {
    setFormError('');
    const validLines = lines.filter((l) => l.productId && (Number(l.quantity) || 0) > 0);
    if (validLines.length === 0) { setFormError('Add at least one product line with a quantity.'); return; }
    const overselling = validLines.find((l) => (Number(l.quantity) || 0) > stockFor(l.productId));
    if (overselling) {
      setFormError(`Insufficient stock for ${overselling.productName}: ${stockFor(overselling.productId)} on hand at this branch.`);
      return;
    }
    setSubmitting(true);
    try {
      const items: SalesInvoiceItem[] = validLines.map((l, i) => {
        const gross = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
        return {
          id: `sii-${Date.now()}-${i}`,
          productId: l.productId,
          productName: l.productName,
          sku: l.sku,
          unit: l.unit,
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          isTaxExempt: l.isTaxExempt,
          taxRate: l.isTaxExempt ? 0 : 13,
          subtotal: gross,
          taxAmount: l.isTaxExempt ? 0 : (gross * 13) / 100,
          total: l.isTaxExempt ? gross : gross * 1.13,
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

  const submitPayment = async () => {
    if (!payInvoice) return;
    const amt = Number(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setPayError('Enter a payment amount greater than 0.'); return; }
    setPaySubmitting(true);
    setPayError('');
    try {
      await onRecordPayment?.(payInvoice, amt, payMethod);
      setPayInvoice(null);
    } catch (e: any) {
      setPayError(e?.message || 'Failed to record the payment.');
    } finally {
      setPaySubmitting(false);
    }
  };

  const filtered = useMemo(() => {
    let list = invoices;
    if (branchFilter !== 'ALL') list = list.filter((i) => i.branchId === branchFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((i) =>
        i.invoiceNumber.toLowerCase().includes(q) ||
        (i.customerName || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [invoices, branchFilter, query]);

  const { pagedItems: pageRows, page, pageSize, setPage, pageCount, rangeStart, rangeEnd } = useClientPagination(filtered, 25);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name || id;

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
            <button className={btnGhost} onClick={() => setViewing(null)}>
              <ArrowLeft className="h-4 w-4" /> Back to Register
            </button>
          ) : internalTab === 'CREATE' ? (
            <button className={btnGhost} onClick={() => setInternalTab('LIST')}>
              <ArrowLeft className="h-4 w-4" /> Back to Register
            </button>
          ) : (
            <button className={btnPrimary} onClick={() => setInternalTab('CREATE')}>
              <PlusCircle className="h-4 w-4" /> New Sales Invoice
            </button>
          )
        }
      />

      {viewing ? (
        <div className={`${formCardClass} space-y-4`}>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div><div className={labelClass}>Invoice #</div><div className="font-medium">{viewing.invoiceNumber}</div></div>
            <div><div className={labelClass}>Customer</div><div className="font-medium">{viewing.customerName}</div></div>
            <div><div className={labelClass}>Branch</div><div className="font-medium">{branchName(viewing.branchId)}</div></div>
            <div><div className={labelClass}>Date</div><div className="font-medium">{dateMode === 'BS' && viewing.invoiceDateBS ? viewing.invoiceDateBS : viewing.invoiceDateAD}</div></div>
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
                  <th className="py-2">Unit Price</th><th className="py-2">Tax</th><th className="py-2">Total</th>
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
                    <td className="py-2">{formatMoney(it.total || 0)}</td>
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
              <label className={labelClass}>Branch *</label>
              <select className={inputClass} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Customer</label>
              <input className={inputClass} value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in Customer" />
            </div>
            <div>
              <label className={labelClass}>Invoice Date (AD) *</label>
              <input type="date" className={inputClass} value={invDateAD} onChange={(e) => setInvDateAD(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Payment Method</label>
              <select className={inputClass} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as any)}>
                {['CASH', 'CREDIT', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass}>Amount Paid</label>
              <input type="number" min="0" className={inputClass} value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Notes</label>
              <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Items</div>
            {lines.map((line, idx) => (
              <div key={idx} className="grid grid-cols-12 items-end gap-2">
                <div className="col-span-5">
                  <select
                    className={inputClass}
                    value={line.productId}
                    onChange={(e) => pickProduct(idx, e.target.value)}
                  >
                    <option value="">— Select product —</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <input type="number" min="1" className={inputClass} value={line.quantity}
                    onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })} placeholder="Qty" />
                </div>
                <div className="col-span-2">
                  <input type="number" min="0" step="0.01" className={inputClass} value={line.unitPrice}
                    onChange={(e) => updateLine(idx, { unitPrice: Number(e.target.value) })} placeholder="Rate" />
                </div>
                <div className="col-span-2 text-xs text-slate-500">
                  {line.productId ? `${stockFor(line.productId)} in stock` : ''}
                </div>
                <div className="col-span-1">
                  {lines.length > 1 && (
                    <button className="text-red-500 hover:text-red-600" title="Remove line"
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}>✕</button>
                  )}
                </div>
              </div>
            ))}
            <button
              className="text-sm text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
              onClick={() => setLines((prev) => [...prev, { productId: '', productName: '', sku: '', unit: '', quantity: 1, unitPrice: 0, isTaxExempt: false }])}
            >
              + Add line
            </button>
          </div>

          <div className={`rounded-lg border p-3 text-sm ${isDarkMode ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex justify-between"><span>Taxable</span><span>{formatMoney(lineTotals.taxable)}</span></div>
            <div className="flex justify-between"><span>Non-taxable</span><span>{formatMoney(lineTotals.nonTaxable)}</span></div>
            <div className="flex justify-between"><span>VAT (13%)</span><span>{formatMoney(lineTotals.vat)}</span></div>
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold dark:border-slate-700" style={{ borderColor: isDarkMode ? '#334155' : '#e2e8f0' }}>
              <span>Grand Total</span><span>{formatMoney(lineTotals.grand)}</span>
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

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#0f1218]">
            <table className="w-full text-sm">
              <thead>
                <tr className={`border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-200'} text-left text-xs uppercase text-slate-500`}>
                  <th className="px-4 py-3">Invoice #</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3">Date</th>
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
                    <td className="px-4 py-2">{inv.paymentStatus}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(inv.grandTotal)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <button className="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400" title="View"
                        onClick={() => { setViewing(inv); }}>
                        <Eye className="h-4 w-4" />
                      </button>
                      {onRecordPayment && inv.paymentStatus !== 'PAID' && (
                        <button className="ml-2 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400" title="Record payment"
                          onClick={() => openPayment(inv)}>
                          <Banknote className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No sales invoices yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={page}
            pageSize={pageSize}
            totalItems={filtered.length}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onPageChange={setPage}
          />
        </>
      )}

      {payInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !paySubmitting && setPayInvoice(null)}>
          <div className={`${formCardClass} w-full max-w-md space-y-4`} onClick={(e) => e.stopPropagation()}>
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
                {['CASH', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'CARD', 'OTHER'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
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
          </div>
        </div>
      )}
    </div>
  );
};

export default SalesInvoices;
