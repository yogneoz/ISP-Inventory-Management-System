/**
 * Customer Ledger & Receivables — mirrors the Vendor Ledger for the sales side.
 *
 * Lines: sales invoices (debits), payments recorded on invoices (credits),
 * and posted sales returns / credit notes (credits). Closing balance is the
 * customer's outstanding receivable.
 *
 * The document itself (filter card, score cards, seven-column table, CSV
 * export) is the shared LedgerView; this file supplies the sales vocabulary —
 * the party picker, the number labels and the color direction (a receivable is
 * healthy when positive) — and owns the api.getCustomerLedger call.
 */
import React, { useCallback, useState, useEffect } from 'react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import {
  LedgerView,
  ledgerExportColumns,
  SubLedgerData,
  SubLedgerLine,
  LedgerFilters,
} from '../../components/common/LedgerView';
import { Branch } from '../../types';
import type { SalesInvoice } from '../../types';
import { api } from '../../services/api';
import type { CustomerLedgerResponse } from '../../services/api/sales';
import { CustomerPicker } from '../../components/common/CustomerPicker';
import { ModalPanel } from '../../components/common/ModalPanel';
import { KeysetLoadMore } from '../../components/common/KeysetLoadMore';
import { useKeysetPager, type KeysetPage } from '../../hooks/useKeysetPager';
import { formCardClass } from '../../components/common/FormCard';
import { inputClass, labelClass, btnPrimary, btnGhost } from '../../components/common/styleConstants';
import { formatMoney } from '../../utils/nprFormat';
import { localTodayAD } from '../../utils/localDate';
import { ArrowDownRight, ArrowUpRight, Banknote, BookOpen, Loader2, SlidersHorizontal, Undo2, Users, Wallet } from 'lucide-react';
import { useBootstrapData } from '../../contexts/AppProviders';

interface CustomerLedgerProps {
  dateMode: 'BS' | 'AD';
  /** A directory row asked this register to open on one customer. */
  focusRequest?: { partyId: string; partyLabel?: string; token: number } | null;
  /**
   * Sales register counter (App's `registerRefresh.salesInvoices`), bumped by
   * a sales SSE burst and by every full refresh. With a customer selected, an
   * invoice/payment event re-reads the ledger in place instead of leaving the
   * receivable at activation-time figures (DF-14).
   */
  sseRefreshKey?: number;
  /**
   * Returns register counter (App's `registerRefresh.returnsRegister`): a
   * posted or cancelled credit note moves the receivable too, and the two
   * counters are a deliberate superset — one extra read is cheaper than a
   * missed credit-note event.
   */
  returnsRefreshKey?: number;
}

export const CustomerLedger: React.FC<CustomerLedgerProps> = ({
  dateMode,
  focusRequest,
  sseRefreshKey,
  returnsRefreshKey,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches } = useBootstrapData();
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState<string>('');
  const [filters, setFilters] = useState<LedgerFilters>({ fromAd: '', toAd: '', branchId: 'ALL' });
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveSubmitting, setReceiveSubmitting] = useState(false);
  const [receiveError, setReceiveError] = useState('');
  const [receiveNotice, setReceiveNotice] = useState('');
  const [receiveAmount, setReceiveAmount] = useState('');
  const [receiveDate, setReceiveDate] = useState(localTodayAD());
  const [receiveMethod, setReceiveMethod] = useState<'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'CARD'>('CASH');
  const [receiveAllocations, setReceiveAllocations] = useState<Record<string, string>>({});

  const activationKey = useActivationKey('customer-ledger');
  const isVisible = useTabActive('customer-ledger');

  // The statement body is one keyset read. The first page also carries the
  // whole-filter opening/totals/tie-out; every later page keeps those figures
  // and appends only its entries, so a page boundary never restarts a balance.
  const fetchStatementPage = useCallback(async (
    cursor: string | null
  ): Promise<KeysetPage<SubLedgerLine, CustomerLedgerResponse | undefined>> => {
    if (!selectedCustomerId) return { items: [], nextCursor: null, hasMore: false, meta: undefined };
    const data = await api.getCustomerLedger(selectedCustomerId, {
      fromAd: filters.fromAd || undefined,
      toAd: filters.toAd || undefined,
      branchId: filters.branchId === 'ALL' ? undefined : filters.branchId,
      cursor,
      limit: 50,
    });
    return {
      items: data.items || data.ledger || [],
      nextCursor: data.nextCursor ?? null,
      hasMore: Boolean(data.hasMore),
      meta: data,
    };
  }, [selectedCustomerId, filters.fromAd, filters.toAd, filters.branchId]);

  const fetchLedgerExport = useCallback(async (): Promise<SubLedgerData> => {
    if (!selectedCustomerId) throw new Error('Select a customer before exporting the statement.');
    const data = await api.exportCustomerLedger(selectedCustomerId, {
      fromAd: filters.fromAd || undefined,
      toAd: filters.toAd || undefined,
      branchId: filters.branchId === 'ALL' ? undefined : filters.branchId,
    });
    return {
      partyName: data.customer.name,
      partyCode: data.customer.customerId,
      openingBalance: data.openingBalance,
      totalDebit: data.totalDebit,
      totalCredit: data.totalCredit,
      closingBalance: data.closingBalance,
      ledger: data.ledger,
      tieOut: data.tieOut,
    };
  }, [selectedCustomerId, filters.fromAd, filters.toAd, filters.branchId]);

  const ledgerPager = useKeysetPager<SubLedgerLine, CustomerLedgerResponse | undefined>({
    fetchPage: fetchStatementPage,
    resetKey: [
      selectedCustomerId,
      filters.fromAd,
      filters.toAd,
      filters.branchId,
      activationKey,
      sseRefreshKey ?? 0,
      returnsRefreshKey ?? 0,
    ].join('\u0000'),
    enabled: Boolean(selectedCustomerId) && isVisible,
  });
  // The statement header (party, opening/totals/closing, tie-out) is the page's
  // `meta` for the CURRENT query. It is cleared the moment the filters change,
  // so a previous range's balances can never head the new range's rows.
  const statement = ledgerPager.meta;
  const ledgerView: SubLedgerData | null = statement
    ? {
        partyName: statement.customer.name,
        partyCode: statement.customer.customerId,
        openingBalance: statement.openingBalance,
        totalDebit: statement.totalDebit,
        totalCredit: statement.totalCredit,
        closingBalance: statement.closingBalance,
        ledger: ledgerPager.rows,
        tieOut: statement.tieOut,
      }
    : null;

  const money = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
  const remainingOf = (invoice: SalesInvoice) =>
    Math.max(0, money(Number(invoice.grandTotal || 0) - Number(invoice.amountPaid || 0)));

  const fetchOpenInvoicePage = useCallback(async (cursor: string | null) => {
    if (!selectedCustomerId) return { items: [], nextCursor: null, hasMore: false };
    // `openOnly` is a server-side filter, not a client-side one: a customer
    // with a page of settled invoices would otherwise hide every invoice that
    // can still receive money.
    const result = await api.getSalesInvoices({
      customerId: selectedCustomerId,
      branchId: filters.branchId === 'ALL' ? undefined : filters.branchId,
      openOnly: true,
      cursor,
      limit: 20,
    });
    const envelope = Array.isArray(result)
      ? { items: result, nextCursor: null, hasMore: false }
      : {
          items: result.items || result.data || [],
          nextCursor: result.nextCursor ?? null,
          hasMore: Boolean(result.hasMore),
        };
    return envelope;
  }, [selectedCustomerId, filters.branchId]);

  const openInvoicePager = useKeysetPager<SalesInvoice>({
    fetchPage: fetchOpenInvoicePage,
    resetKey: [selectedCustomerId, filters.branchId, receiveOpen].join('\u0000'),
    enabled: receiveOpen && Boolean(selectedCustomerId),
    onPage: (page) => {
      setReceiveAllocations((current) => {
        const next = { ...current };
        for (const invoice of page.items) if (!(invoice.id in next)) next[invoice.id] = '';
        return next;
      });
    },
  });
  const openInvoices = openInvoicePager.rows.filter(
    (invoice) => invoice.status !== 'CANCELLED' && remainingOf(invoice) > 0.005
  );
  const receiveLoading = openInvoicePager.loading;
  const receiveListError = openInvoicePager.error;
  const receiveTotal = money(Number(receiveAmount) || 0);
  const receiveAllocated = money(
    openInvoices.reduce((sum, invoice) => sum + (Number(receiveAllocations[invoice.id]) || 0), 0)
  );
  const receiveUnapplied = Math.max(0, money(receiveTotal - receiveAllocated));

  const openReceive = async () => {
    if (!selectedCustomerId) return;
    setReceiveOpen(true);
    setReceiveError('');
    setReceiveNotice('');
    setReceiveAmount('');
    setReceiveDate(localTodayAD());
    setReceiveMethod('CASH');
    setReceiveAllocations({});
  };

  const submitReceive = async () => {
    if (!selectedCustomerId) return;
    if (!Number.isFinite(receiveTotal) || receiveTotal <= 0) {
      setReceiveError('Enter the total amount received.');
      return;
    }
    const allocations = openInvoices
      .map((invoice) => ({
        invoiceId: invoice.id,
        amount: money(Number(receiveAllocations[invoice.id]) || 0),
      }))
      .filter((row) => row.amount > 0);
    for (const row of allocations) {
      const invoice = openInvoices.find((entry) => entry.id === row.invoiceId);
      if (invoice && row.amount > remainingOf(invoice) + 0.005) {
        setReceiveError(`The allocation for ${invoice.invoiceNumber} exceeds its remaining balance.`);
        return;
      }
    }
    if (receiveAllocated > receiveTotal + 0.005) {
      setReceiveError('Allocated amounts cannot exceed the total received. Leave the excess unapplied.');
      return;
    }
    setReceiveSubmitting(true);
    setReceiveError('');
    try {
      await api.createCustomerPayment({
        customerId: selectedCustomerId,
        customerName: ledgerView?.partyName || selectedCustomerLabel,
        branchId: openInvoices[0]?.branchId || (filters.branchId === 'ALL' ? undefined : filters.branchId),
        paymentDateAD: receiveDate,
        amount: receiveTotal,
        paymentMethod: receiveMethod,
        allocations,
      });
      setReceiveOpen(false);
      setReceiveNotice(
        `Receipt recorded: ${formatMoney(receiveTotal)} received${receiveUnapplied > 0 ? `, ${formatMoney(receiveUnapplied)} left unapplied` : ''}.`
      );
      ledgerPager.reload();
    } catch (err: any) {
      setReceiveError(err?.message || 'Failed to record the receipt.');
    } finally {
      setReceiveSubmitting(false);
    }
  };

  useEffect(() => {
    if (!focusRequest?.partyId) return;
    setSelectedCustomerId(focusRequest.partyId);
    setSelectedCustomerLabel(focusRequest.partyLabel || focusRequest.partyId);
  }, [focusRequest?.token]);

  return (
    <div className="space-y-3">
      {receiveNotice && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          {receiveNotice}
        </div>
      )}
      <LedgerView
      title="Customer Ledger & Receivables"
      subtitle="Sub-ledger of customer sales invoices (debits), recorded payments and credit notes from sales returns (credits) with running balance."
      partyLabel="Customer"
      partySelector={
        <CustomerPicker
          value={
            selectedCustomerId
              ? { id: selectedCustomerId, label: selectedCustomerLabel }
              : null
          }
          onSelect={(customer) => {
            setSelectedCustomerId(customer?.id || '');
            setSelectedCustomerLabel(
              customer ? `${customer.customerName} (${customer.customerId})` : ''
            );
          }}
          search={api.searchCustomers}
          placeholder="Search customer name, code, phone, or address…"
          inputClassName="text-sm"
          ariaLabel="Customer"
        />
      }
      selectedPartyId={selectedCustomerId}
      onSelectParty={setSelectedCustomerId}
      branches={branches}
      filters={filters}
      onFilterChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      onLoad={ledgerPager.reload}
      headerActions={
        selectedCustomerId ? (
          <button
            type="button"
            onClick={openReceive}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-800 transition hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            <Banknote className="h-4 w-4" />
            Receive Payment
          </button>
        ) : null
      }
      loading={ledgerPager.loading}
      error={ledgerPager.error}
      data={ledgerView}
      fetchExport={fetchLedgerExport}
      dateMode={dateMode}
      headerIcon={Wallet}
      partyIcon={Users}
      scoreCards={(d) => [
        { label: 'Opening Balance', value: d.openingBalance, tone: d.openingBalance > 0 ? 'emerald' : 'rose' },
        { label: 'Total Sales (Debit)', value: d.totalDebit, tone: 'emerald' },
        { label: 'Payments & Credit Notes', value: d.totalCredit, tone: 'rose' },
        { label: 'Receivable (Closing)', value: d.closingBalance, tone: d.closingBalance > 0 ? 'emerald' : 'rose' },
      ]}
      tones={{
        opening: { positive: 'emerald', negative: 'rose' },
        debit: 'emerald',
        credit: 'rose',
        closing: { positive: 'emerald', negative: 'rose' },
        debitCell: 'text-emerald-600 dark:text-emerald-400',
        creditCell: 'text-rose-600 dark:text-rose-400',
        balancePositive: 'text-emerald-700 dark:text-emerald-300',
        balanceNeutral: 'text-slate-700 dark:text-slate-300',
      }}
      columns={{ debit: 'Debit (Sales)', credit: 'Credit (Payment/Return)' }}
      badges={{
        INVOICE: {
          label: 'Invoice',
          className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
          Icon: ArrowDownRight,
        },
        RETURN: {
          label: 'Credit Note',
          className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
          Icon: Undo2,
        },
        PAYMENT: {
          label: 'Payment',
          className: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
          Icon: ArrowUpRight,
        },
        OPENING: {
          label: 'Opening',
          className: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200',
          Icon: BookOpen,
        },
        ADJUSTMENT: {
          label: 'Journal',
          className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
          Icon: SlidersHorizontal,
        },
      }}
      closingLabel="Receivable (Closing Balance)"
      exportFilenamePrefix="Customer_Ledger_"
      exportColumns={ledgerExportColumns(
        {
          documentNumber: 'Document Number',
          type: 'Type',
          debit: 'Debit / Sales (NPR)',
          credit: 'Credit / Payments & Credit Notes (NPR)',
          balance: 'Running Balance (NPR)',
          notes: 'Notes',
        },
        dateMode
      )}
      footer={
        selectedCustomerId ? (
          <KeysetLoadMore
            loaded={ledgerPager.rows.length}
            hasMore={ledgerPager.hasMore}
            loadingMore={ledgerPager.loadingMore}
            onLoadMore={ledgerPager.loadMore}
            scopeError={ledgerPager.scopeError ? ledgerPager.error : ''}
          />
        ) : undefined
      }
      />
      {receiveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !receiveSubmitting && setReceiveOpen(false)}>
          <ModalPanel
            label="Receive Customer Payment"
            onClose={() => {
              if (!receiveSubmitting) setReceiveOpen(false);
            }}
            className={`${formCardClass} w-full max-w-2xl space-y-4`}
            onClick={(event) => event.stopPropagation()}
          >
            <div>
              <div className="text-lg font-semibold">Receive Customer Payment</div>
              <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {ledgerView?.partyName || selectedCustomerLabel || 'Customer'} · allocate across open invoices or leave the excess as an advance.
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className={labelClass}>Received on</label>
                <input type="date" className={inputClass} value={receiveDate} onChange={(event) => setReceiveDate(event.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Total received *</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className={inputClass}
                  value={receiveAmount}
                  onChange={(event) => setReceiveAmount(event.target.value)}
                />
              </div>
              <div>
                <label className={labelClass}>Method</label>
                <select className={inputClass} value={receiveMethod} onChange={(event) => setReceiveMethod(event.target.value as typeof receiveMethod)}>
                  <option value="CASH">Cash</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="CARD">Card</option>
                </select>
              </div>
            </div>

            <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2 text-right">Open</th>
                    <th className="px-3 py-2 text-right">Apply</th>
                  </tr>
                </thead>
                <tbody>
                  {receiveLoading && (
                    <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></td></tr>
                  )}
                  {!receiveLoading && openInvoices.length === 0 && (
                    <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500">No open invoices. The full amount will be recorded as an unapplied advance.</td></tr>
                  )}
                  {!receiveLoading && openInvoices.map((invoice) => (
                    <tr key={invoice.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2">
                        <div className="font-medium">{invoice.invoiceNumber}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{invoice.invoiceDateAD}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{formatMoney(remainingOf(invoice))}</td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          max={remainingOf(invoice)}
                          step="0.01"
                          className={`${inputClass} w-32 text-right`}
                          value={receiveAllocations[invoice.id] || ''}
                          onChange={(event) =>
                            setReceiveAllocations((current) => ({ ...current, [invoice.id]: event.target.value }))
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <KeysetLoadMore
              loaded={openInvoices.length}
              hasMore={openInvoicePager.hasMore}
              loadingMore={openInvoicePager.loadingMore}
              onLoadMore={openInvoicePager.loadMore}
              scopeError={openInvoicePager.scopeError ? openInvoicePager.error : ''}
            />

            <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
              <div><div className={labelClass}>Allocated</div><div className="font-mono font-semibold">{formatMoney(receiveAllocated)}</div></div>
              <div><div className={labelClass}>Unapplied advance</div><div className="font-mono font-semibold">{formatMoney(receiveUnapplied)}</div></div>
            </div>

            {(receiveListError || receiveError) && (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">{receiveListError || receiveError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button className={btnGhost} onClick={() => setReceiveOpen(false)} disabled={receiveSubmitting}>Cancel</button>
              <button className={btnPrimary} onClick={submitReceive} disabled={receiveSubmitting || receiveLoading}>
                {receiveSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                Record Receipt
              </button>
            </div>
          </ModalPanel>
        </div>
      )}
    </div>
  );
};

export default CustomerLedger;
