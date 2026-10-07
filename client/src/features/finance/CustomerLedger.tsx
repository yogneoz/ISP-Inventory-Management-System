/**
 * Customer Ledger & Receivables — mirrors the Vendor Ledger for the sales side.
 *
 * Lines: sales invoices (debits), payments recorded on invoices (credits),
 * and posted sales returns / credit notes (credits). Closing balance is the
 * customer's outstanding receivable. CSV export matches the vendor ledger's.
 */
import React, { useState, useEffect } from 'react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { CustomerRecord, Branch } from '../../types';
import { api } from '../../services/api';
import { exportToCSV } from '../../utils/exportUtils';
import { formatNumber } from '../../utils/nprFormat';
import {
  Wallet,
  Search,
  Download,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Undo2,
  Users,
} from 'lucide-react';
import StatCard from '../../components/common/StatCard';

interface LedgerLine {
  id: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  amount: number;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN';
  notes?: string | null;
  paymentMethod?: string;
  debit: number;
  credit: number;
  balance: number;
}

interface CustomerLedgerProps {
  customers: CustomerRecord[];
  branches: Branch[];
  selectedBranchId?: string;
  dateMode: 'BS' | 'AD';
}

export const CustomerLedger: React.FC<CustomerLedgerProps> = ({
  customers,
  branches,
  selectedBranchId,
  dateMode,
}) => {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [fromAd, setFromAd] = useState<string>('');
  const [toAd, setToAd] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('ALL');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ledgerData, setLedgerData] = useState<{
    customer: { id: string; customerId?: string; name: string };
    openingBalance: number;
    totalDebit: number;
    totalCredit: number;
    closingBalance: number;
    ledger: LedgerLine[];
  } | null>(null);

  const fetchLedger = async () => {
    if (!selectedCustomerId) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.getCustomerLedger(selectedCustomerId, {
        fromAd: fromAd || undefined,
        toAd: toAd || undefined,
        branchId: branchId === 'ALL' ? undefined : branchId,
      });
      setLedgerData(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load customer ledger.');
      setLedgerData(null);
    } finally {
      setLoading(false);
    }
  };

  // Refetch the selected customer's ledger on every tab re-activation.
  const activationKey = useActivationKey('customer-ledger');

  useEffect(() => {
    fetchLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId, activationKey]);

  const handleExport = () => {
    if (!ledgerData) return;
    const rows = ledgerData.ledger.map((line) => ({
      Date: dateMode === 'BS' ? line.dateBS : line.dateAD,
      'Document No': line.documentNumber,
      Type: line.type,
      'Debit (Sale)': line.debit,
      'Credit (Payment/Return)': line.credit,
      'Running Balance': line.balance,
      Notes: line.notes || '',
    }));
    exportToCSV(
      `Customer_Ledger_${ledgerData.customer.name.replace(/\s+/g, '_')}`,
      rows,
      [
        { key: 'Date', label: dateMode === 'BS' ? 'Nepali (BS) Date' : 'English (AD) Date' },
        { key: 'Document No', label: 'Document Number' },
        { key: 'Type', label: 'Type' },
        { key: 'Debit (Sale)', label: 'Debit / Sales (NPR)' },
        { key: 'Credit (Payment/Return)', label: 'Credit / Payments & Credit Notes (NPR)' },
        { key: 'Running Balance', label: 'Running Balance (NPR)' },
        { key: 'Notes', label: 'Notes' },
      ]
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Wallet className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            Customer Ledger & Receivables
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sub-ledger of customer sales invoices (debits), recorded payments and credit notes from sales returns (credits) with running balance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchLedger}
            disabled={!selectedCustomerId || loading}
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
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Customer</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <select
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-2 focus:ring-indigo-500 dark:text-white"
            >
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.customerName} ({c.customerId})</option>
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
            disabled={!selectedCustomerId || loading}
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
            <StatCard
              label="Opening Balance"
              value={formatNumber(ledgerData.openingBalance)}
              tone={ledgerData.openingBalance > 0 ? 'emerald' : 'rose'}
            />
            <StatCard
              label="Total Sales (Debit)"
              value={formatNumber(ledgerData.totalDebit)}
              tone="emerald"
            />
            <StatCard
              label="Payments & Credit Notes"
              value={formatNumber(ledgerData.totalCredit)}
              tone="rose"
            />
            <StatCard
              label="Receivable (Closing)"
              value={formatNumber(ledgerData.closingBalance)}
              tone={ledgerData.closingBalance > 0 ? 'emerald' : 'rose'}
            />
          </div>

          {/* Ledger table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                <Users className="h-4 w-4 text-indigo-500" />
                {ledgerData.customer.name}
                {ledgerData.customer.customerId && (
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">({ledgerData.customer.customerId})</span>
                )}
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
                    <th className="px-4 py-3 text-right font-semibold">Debit (Sales)</th>
                    <th className="px-4 py-3 text-right font-semibold">Credit (Payment/Return)</th>
                    <th className="px-4 py-3 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30">
                    <td className="px-4 py-2 font-medium text-slate-600 dark:text-slate-300" colSpan={5}>Opening Balance</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-800 dark:text-slate-100">{formatNumber(ledgerData.openingBalance)}</td>
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
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
                            <ArrowDownRight className="h-3 w-3" /> Invoice
                          </span>
                        ) : line.type === 'RETURN' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-medium">
                            <Undo2 className="h-3 w-3" /> Credit Note
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 text-xs font-medium">
                            <ArrowUpRight className="h-3 w-3" /> Payment{line.paymentMethod ? ` (${line.paymentMethod})` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-emerald-600 dark:text-emerald-400">{line.debit > 0 ? formatNumber(line.debit) : '—'}</td>
                      <td className="px-4 py-2 text-right text-rose-600 dark:text-rose-400">{line.credit > 0 ? formatNumber(line.credit) : '—'}</td>
                      <td className={`px-4 py-2 text-right font-semibold ${line.balance > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-300'}`}>
                        {formatNumber(line.balance)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 font-semibold">
                    <td className="px-4 py-3 text-slate-800 dark:text-slate-100" colSpan={5}>Receivable (Closing Balance)</td>
                    <td className={`px-4 py-3 text-right ${ledgerData.closingBalance > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-300'}`}>
                      {formatNumber(ledgerData.closingBalance)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CustomerLedger;
