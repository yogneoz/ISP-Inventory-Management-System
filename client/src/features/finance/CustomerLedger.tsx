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
import React, { useState, useEffect, useRef } from 'react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import {
  LedgerView,
  ledgerExportColumns,
  SubLedgerData,
  LedgerFilters,
} from '../../components/common/LedgerView';
import { CustomerRecord, Branch } from '../../types';
import { api } from '../../services/api';
import { createLatestOnly } from '../../utils/latestOnly';
import { ArrowDownRight, ArrowUpRight, Undo2, Users, Wallet } from 'lucide-react';

interface CustomerLedgerProps {
  customers: CustomerRecord[];
  branches: Branch[];
  dateMode: 'BS' | 'AD';
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
  customers,
  branches,
  dateMode,
  sseRefreshKey,
  returnsRefreshKey,
}) => {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [filters, setFilters] = useState<LedgerFilters>({ fromAd: '', toAd: '', branchId: 'ALL' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ledgerData, setLedgerData] = useState<SubLedgerData | null>(null);

  // Sequence guard (DF-08): switching customer while a request is in flight
  // must not let the slower previous response paint over the newer one.
  const fetchSeq = useRef(createLatestOnly()).current;

  const fetchLedger = async () => {
    if (!selectedCustomerId) return;
    const ticket = fetchSeq.begin();
    setLoading(true);
    setError('');
    try {
      const data = await api.getCustomerLedger(selectedCustomerId, {
        fromAd: filters.fromAd || undefined,
        toAd: filters.toAd || undefined,
        branchId: filters.branchId === 'ALL' ? undefined : filters.branchId,
      });
      if (!fetchSeq.isCurrent(ticket)) return;
      setLedgerData({
        partyName: data.customer.name,
        partyCode: data.customer.customerId,
        openingBalance: data.openingBalance,
        totalDebit: data.totalDebit,
        totalCredit: data.totalCredit,
        closingBalance: data.closingBalance,
        ledger: data.ledger,
      });
    } catch (err: any) {
      if (!fetchSeq.isCurrent(ticket)) return;
      setError(err?.message || 'Failed to load customer ledger.');
      setLedgerData(null);
    } finally {
      if (fetchSeq.isCurrent(ticket)) setLoading(false);
    }
  };

  // Refetch the selected customer's ledger on every tab re-activation, and in
  // place when sales or a credit note changes it while the tab is open (DF-14).
  // A hidden keep-mounted tab skips the read: the next activation re-runs it,
  // so an event burst elsewhere cannot issue a ledger request nobody can see.
  const activationKey = useActivationKey('customer-ledger');
  const isVisible = useTabActive('customer-ledger');

  useEffect(() => {
    if (!isVisible) return;
    // fetchLedger() is a no-op while no customer is selected.
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId, activationKey, sseRefreshKey, returnsRefreshKey, isVisible]);

  return (
    <LedgerView
      title="Customer Ledger & Receivables"
      subtitle="Sub-ledger of customer sales invoices (debits), recorded payments and credit notes from sales returns (credits) with running balance."
      partyLabel="Customer"
      parties={customers.map((c) => ({ id: c.id, label: `${c.customerName} (${c.customerId})` }))}
      selectedPartyId={selectedCustomerId}
      onSelectParty={setSelectedCustomerId}
      branches={branches}
      filters={filters}
      onFilterChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      onLoad={fetchLedger}
      loading={loading}
      error={error}
      data={ledgerData}
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
    />
  );
};

export default CustomerLedger;
