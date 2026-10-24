/**
 * Vendor Ledger & Payments — mirrors the Customer Ledger for the purchase side.
 *
 * Lines: supplier bills (debits), recorded payments and payment reversals
 * (credits). Closing balance is what the business still owes the supplier.
 *
 * The document itself (filter card, score cards, seven-column table, CSV
 * export) is the shared LedgerView; this file supplies the purchase vocabulary
 * — the party picker, the number labels and the color direction (a payable is
 * healthy when NEGATIVE, the mirror image of the customer ledger) — and owns
 * the api.getVendorLedger call.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useActivationKey, useTabActive } from '../../components/common/KeepMounted';
import {
  LedgerView,
  ledgerExportColumns,
  SubLedgerData,
  LedgerFilters,
} from '../../components/common/LedgerView';
import { Supplier, Branch } from '../../types';
import { api } from '../../services/api';
import { createLatestOnly } from '../../utils/latestOnly';
import { ArrowDownRight, ArrowUpRight, Building, Undo2, Wallet } from 'lucide-react';

interface VendorLedgerProps {
  suppliers: Supplier[];
  branches: Branch[];
  dateMode: 'BS' | 'AD';
  /**
   * Procurement register counter (App's `registerRefresh.purchaseInvoices`),
   * bumped by a procurement SSE burst and by every full refresh. With a
   * supplier selected, a billed/payment/return event re-reads the ledger in
   * place instead of leaving the closing balance at activation-time figures
   * (DF-14).
   */
  sseRefreshKey?: number;
}

export const VendorLedger: React.FC<VendorLedgerProps> = ({
  suppliers,
  branches,
  dateMode,
  sseRefreshKey,
}) => {
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
  const [filters, setFilters] = useState<LedgerFilters>({ fromAd: '', toAd: '', branchId: 'ALL' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ledgerData, setLedgerData] = useState<SubLedgerData | null>(null);

  // Sequence guard (DF-08): switching supplier while a request is in flight
  // must not let the slower previous response paint over the newer one.
  const fetchSeq = useRef(createLatestOnly()).current;

  const fetchLedger = async () => {
    if (!selectedSupplierId) return;
    const ticket = fetchSeq.begin();
    setLoading(true);
    setError('');
    try {
      const data = await api.getVendorLedger(selectedSupplierId, {
        fromAd: filters.fromAd || undefined,
        toAd: filters.toAd || undefined,
        branchId: filters.branchId === 'ALL' ? undefined : filters.branchId,
      });
      if (!fetchSeq.isCurrent(ticket)) return;
      setLedgerData({
        partyName: data.supplier.name,
        openingBalance: data.openingBalance,
        totalDebit: data.totalDebit,
        totalCredit: data.totalCredit,
        closingBalance: data.closingBalance,
        ledger: data.ledger,
      });
    } catch (err: any) {
      if (!fetchSeq.isCurrent(ticket)) return;
      setError(err?.message || 'Failed to load vendor ledger.');
      setLedgerData(null);
    } finally {
      if (fetchSeq.isCurrent(ticket)) setLoading(false);
    }
  };

  // Refetch the selected supplier's ledger on every tab re-activation, and in
  // place when procurement changes it while the tab is open (DF-14). A hidden
  // keep-mounted tab skips the read: the next activation re-runs it, so an
  // event burst elsewhere cannot issue a ledger request nobody can see.
  const activationKey = useActivationKey('vendor-ledger');
  const isVisible = useTabActive('vendor-ledger');

  useEffect(() => {
    if (!isVisible) return;
    // fetchLedger() is a no-op while no supplier is selected.
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupplierId, activationKey, sseRefreshKey, isVisible]);

  return (
    <LedgerView
      title="Vendor Ledger & Payments"
      subtitle="Sub-ledger of supplier bills (debits), recorded payments (credits) with running balance, bank & reversal details."
      partyLabel="Supplier"
      parties={suppliers.map((s) => ({ id: s.id, label: s.name }))}
      selectedPartyId={selectedSupplierId}
      onSelectParty={setSelectedSupplierId}
      branches={branches}
      filters={filters}
      onFilterChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      onLoad={fetchLedger}
      loading={loading}
      error={error}
      data={ledgerData}
      dateMode={dateMode}
      headerIcon={Wallet}
      partyIcon={Building}
      scoreCards={(d) => [
        { label: 'Opening Balance', value: d.openingBalance, tone: d.openingBalance > 0 ? 'rose' : 'emerald' },
        { label: 'Total Purchases (Debit)', value: d.totalDebit, tone: 'rose' },
        { label: 'Total Payments (Credit)', value: d.totalCredit, tone: 'emerald' },
        { label: 'Closing Balance', value: d.closingBalance, tone: d.closingBalance > 0 ? 'rose' : 'emerald' },
      ]}
      tones={{
        opening: { positive: 'rose', negative: 'emerald' },
        debit: 'rose',
        credit: 'emerald',
        closing: { positive: 'rose', negative: 'emerald' },
        debitCell: 'text-red-600 dark:text-red-400',
        creditCell: 'text-emerald-600 dark:text-emerald-400',
        balancePositive: 'text-red-700 dark:text-red-300',
        balanceNeutral: 'text-emerald-700 dark:text-emerald-300',
      }}
      columns={{ debit: 'Debit (Purchases)', credit: 'Credit (Payments)' }}
      badges={{
        INVOICE: {
          label: 'Bill',
          className: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
          Icon: ArrowDownRight,
        },
        RETURN: {
          label: 'Debit Note',
          className: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
          Icon: Undo2,
        },
        PAYMENT: {
          label: 'Payment',
          className: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
          Icon: ArrowUpRight,
        },
      }}
      closingLabel="Closing Balance"
      exportFilenamePrefix="Vendor_Ledger_"
      exportColumns={ledgerExportColumns(
        {
          documentNumber: 'Document Number',
          type: 'Type',
          debit: 'Debit / Purchases (NPR)',
          credit: 'Credit / Payments (NPR)',
          balance: 'Running Balance (NPR)',
          notes: 'Notes',
        },
        dateMode
      )}
      emptyPrompt="Select a supplier to view their payment ledger."
    />
  );
};

export default VendorLedger;
