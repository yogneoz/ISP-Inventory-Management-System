import React, { useState, useEffect, useMemo } from 'react';
import { Supplier, Branch } from '../../types';
import { api } from '../../services/api';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Wallet,
  Search,
  Download,
  Loader2,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Building,
} from 'lucide-react';

interface LedgerLine {
  id: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  amount: number;
  type: 'INVOICE' | 'PAYMENT';
  notes?: string | null;
  vatAmount?: number;
  paymentMethod?: string;
  debit: number;
  credit: number;
  balance: number;
}

interface VendorLedgerProps {
  suppliers: Supplier[];
  branches: Branch[];
  selectedBranchId?: string;
  dateMode: 'BS' | 'AD';
}

export const VendorLedger: React.FC<VendorLedgerProps> = ({
  suppliers,
  branches,
  selectedBranchId,
  dateMode,
}) => {
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>('');
  const [fromAd, setFromAd] = useState<string>('');
  const [toAd, setToAd] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('ALL');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ledgerData, setLedgerData] = useState<{
    supplier: { id: string; name: string };
    openingBalance: number;
    totalDebit: number;
    totalCredit: number;
    closingBalance: number;
    ledger: LedgerLine[];
  } | null>(null);

  const supplier = useMemo(
    () => suppliers.find((s) => s.id === selectedSupplierId) || null,
    [suppliers, selectedSupplierId]
  );

  const fetchLedger = async () => {
    if (!selectedSupplierId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.getVendorLedger(selectedSupplierId, {
        fromAd: fromAd || undefined,
        toAd: toAd || undefined,
        branchId: branchId === 'ALL' ? undefined : branchId,
      });
      setLedgerData(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load vendor ledger.');
      setLedgerData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupplierId]);

  const handleExport = () => {
    if (!ledgerData) return;
    const rows = ledgerData.ledger.map((line) => ({
      Date: dateMode === 'BS' ? line.dateBS : line.dateAD,
      'Document No': line.documentNumber,
      Type: line.type,
      'Debit (Purchase)': line.debit,
      'Credit (Payment)': line.credit,
      'Running Balance': line.balance,
      Notes: line.notes || '',
    }));
    exportToCSV(
      `Vendor_Ledger_${ledgerData.supplier.name.replace(/\s+/g, '_')}`,
      rows,
      [
        { key: 'Date', label: dateMode === 'BS' ? 'Nepali (BS) Date' : 'English (AD) Date' },
        { key: 'Document No', label: 'Document Number' },
        { key: 'Type', label: 'Type' },
        { key: 'Debit (Purchase)', label: 'Debit / Purchases (NPR)' },
        { key: 'Credit (Payment)', label: 'Credit / Payments (NPR)' },
        { key: 'Running Balance', label: 'Running Balance (NPR)' },
        { key: 'Notes', label: 'Notes' },
      ]
    );
  };

  const numberFmt = (value: number | string | undefined): string =>
    Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            Vendor Ledger & Payments
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sub-ledger of supplier bills (debits), recorded payments (credits) with running balance, bank & reversal details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchLedger}
            disabled={!selectedSupplierId || loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium transition"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handleExport}
            disabled={!ledgerData || ledgerData.ledger.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 text-sm font-medium transition"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60">
        <div className="lg:col-span-2">
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Supplier</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <select
              value={selectedSupplierId}
              onChange={(e) => setSelectedSupplierId(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-2 focus:ring-indigo-500 dark:text-white"
            >
              <option value="">Select supplier...</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">From (AD)</label>
          <input
            type="date"
            value={fromAd}
            onChange={(e) => setFromAd(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">To (AD)</label>
          <input
            type="date"
            value={toAd}
            onChange={(e) => setToAd(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Branch</label>
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm dark:text-white"
          >
            <option value="ALL">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="md:col-span-1 lg:col-span-5 flex items-end">
          <button
            onClick={fetchLedger}
            disabled={!selectedSupplierId || loading}
            className="w-full md:w-auto inline-flex items-center justify-center gap-2 px-5 py-2 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-80 disabled:opacity-40 text-sm font-medium transition"
          >
            <Search className="h-4 w-4" />
            Load Ledger
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Ledger summary + table */}
      {ledgerData && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Opening Balance</p>
              <p className={`mt-1 text-xl font-bold ${ledgerData.openingBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {numberFmt(ledgerData.openingBalance)}
              </p>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Total Purchases (Debit)</p>
              <p className="mt-1 text-xl font-bold text-red-600 dark:text-red-400">{numberFmt(ledgerData.totalDebit)}</p>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Total Payments (Credit)</p>
              <p className="mt-1 text-xl font-bold text-emerald-600 dark:text-emerald-400">{numberFmt(ledgerData.totalCredit)}</p>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Closing Balance</p>
              <p className={`mt-1 text-xl font-bold ${ledgerData.closingBalance > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {numberFmt(ledgerData.closingBalance)}
              </p>
            </div>
          </div>

          {/* Ledger table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                <Building className="h-4 w-4 text-indigo-500" />
                {ledgerData.supplier.name}
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                  {ledgerData.ledger.length} entries
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 text-left font-semibold">Date</th>
                    <th className="px-4 py-3 text-left font-semibold">Document No</th>
                    <th className="px-4 py-3 text-left font-semibold">Type</th>
                    <th className="px-4 py-3 text-right font-semibold">Debit (Purchases)</th>
                    <th className="px-4 py-3 text-right font-semibold">Credit (Payments)</th>
                    <th className="px-4 py-3 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30">
                    <td className="px-4 py-2 font-medium text-slate-600 dark:text-slate-300" colSpan={5}>Opening Balance</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-800 dark:text-slate-100">{numberFmt(ledgerData.openingBalance)}</td>
                  </tr>
                  {ledgerData.ledger.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-400 dark:text-slate-500">
                        No transactions found in the selected range.
                      </td>
                    </tr>
                  )}
                  {ledgerData.ledger.map((line, idx) => (
                    <tr key={`${line.id}-${idx}`} className="border-t border-slate-100 dark:border-slate-700/60">
                      <td className="px-4 py-2 whitespace-nowrap text-slate-700 dark:text-slate-300">
                        {dateMode === 'BS' ? line.dateBS : line.dateAD}
                      </td>
                      <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{line.documentNumber}</td>
                      <td className="px-4 py-2">
                        {line.type === 'INVOICE' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 text-xs font-medium">
                            <ArrowDownRight className="h-3 w-3" /> Bill
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
                            <ArrowUpRight className="h-3 w-3" /> Payment{line.paymentMethod ? ` (${line.paymentMethod})` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-red-600 dark:text-red-400">{line.debit > 0 ? numberFmt(line.debit) : '—'}</td>
                      <td className="px-4 py-2 text-right text-emerald-600 dark:text-emerald-400">{line.credit > 0 ? numberFmt(line.credit) : '—'}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${line.balance > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                        {numberFmt(line.balance)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 font-semibold">
                    <td className="px-4 py-3 text-slate-800 dark:text-slate-100" colSpan={5}>Closing Balance</td>
                    <td className={`px-4 py-3 text-right ${ledgerData.closingBalance > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                      {numberFmt(ledgerData.closingBalance)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!ledgerData && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
          <Wallet className="h-12 w-12 mb-3 opacity-40" />
          <p>Select a supplier to view their payment ledger.</p>
        </div>
      )}
    </div>
  );
};

export default VendorLedger;