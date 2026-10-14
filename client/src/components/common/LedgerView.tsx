/**
 * Shared party sub-ledger view — the presentational half of the two finance
 * ledgers (Customer Ledger & Receivables, Vendor Ledger & Payments).
 *
 * The two screens are the same document with different vocabulary: same
 * filter card, same four score cards, same seven-column table with an opening
 * row and a closing row, same CSV export. Only the words, the icon, the color
 * direction (a receivable is good when it is positive, a payable is not) and
 * the party picker differ, so this file owns the markup and every screen
 * supplies its own vocabulary through a small config.
 *
 * Ownership split (deliberate):
 *   - the SCREEN owns the request: party selection, the AD range, the branch
 *     filter, the `api.*` call, `useActivationKey` and the fetch effect. That
 *     keeps each screen's server surface pinned where the register-refresh
 *     guards look for it, and keeps refetch-on-reactivation screen-local.
 *   - this VIEW owns the DOM: header chrome, filter card, error banner, score
 *     cards, table, empty state and the CSV export.
 *
 * Lives under components/common (not features/finance) on purpose: it is not a
 * screen, so it must stay out of the screen-count and screen-surface tables.
 */
import React from 'react';
import { Search, Download, RefreshCw, Wallet } from 'lucide-react';
import StatCard, { StatCardTone } from './StatCard';
import { formatNumber } from '../../utils/nprFormat';
import { exportToCSV, CSVColumn } from '../../utils/exportUtils';
import type { Branch } from '../../types';

/** One posted line of a party sub-ledger. */
export interface SubLedgerLine {
  id: string;
  documentNumber: string;
  dateAD: string;
  dateBS: string;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN';
  notes?: string | null;
  paymentMethod?: string;
  debit: number;
  credit: number;
  balance: number;
}

/** The API payload both ledgers return, normalized to one party-agnostic shape. */
export interface SubLedgerData {
  /** Party display name (customer or supplier). */
  partyName: string;
  /** Optional secondary identifier rendered beside the name (customer code). */
  partyCode?: string;
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  ledger: SubLedgerLine[];
}

export interface LedgerFilters {
  fromAd: string;
  toAd: string;
  branchId: string;
}

/** Pill shown in the Type column for one line kind. */
export interface LedgerBadge {
  label: string;
  className: string;
  Icon: React.ComponentType<{ className?: string }>;
}

/**
 * Per-screen color direction. StatCard tones tint the score cards; the
 * `*Cell` classes tint the table cells. A vendor ledger is the mirror image of
 * a customer ledger (positive = payable = rose), hence the per-screen values.
 */
export interface LedgerTones {
  opening: { positive: StatCardTone; negative: StatCardTone };
  debit: StatCardTone;
  credit: StatCardTone;
  closing: { positive: StatCardTone; negative: StatCardTone };
  debitCell: string;
  creditCell: string;
  balancePositive: string;
  balanceNeutral: string;
}

export interface LedgerScoreCard {
  label: string;
  value: number;
  tone: StatCardTone;
}

export interface LedgerViewProps {
  title: string;
  subtitle: string;
  /** Filter/column vocabulary, e.g. 'Customer' | 'Supplier'. */
  partyLabel: string;
  parties: Array<{ id: string; label: string }>;
  selectedPartyId: string;
  onSelectParty: (partyId: string) => void;
  branches: Branch[];
  filters: LedgerFilters;
  onFilterChange: (patch: Partial<LedgerFilters>) => void;
  /** Runs the screen's own fetch with the screen's current filters. */
  onLoad: () => void;
  loading: boolean;
  error: string;
  data: SubLedgerData | null;
  dateMode: 'BS' | 'AD';
  /** Page icon shown in the header. */
  headerIcon: React.ComponentType<{ className?: string }>;
  /** Party icon shown beside the loaded party's name. */
  partyIcon: React.ComponentType<{ className?: string }>;
  /** The four score cards, in render order. */
  scoreCards: (data: SubLedgerData) => LedgerScoreCard[];
  tones: LedgerTones;
  columns: { debit: string; credit: string };
  badges: Record<SubLedgerLine['type'], LedgerBadge>;
  /** Label of the final totals row, e.g. 'Receivable (Closing Balance)'. */
  closingLabel: string;
  /** CSV filename prefix; the party name is appended at export time. */
  exportFilenamePrefix: string;
  exportColumns: CSVColumn<Record<string, any>>[];
  /** Shown before the first successful load. Omit for no empty-state panel. */
  emptyPrompt?: string;
}

/**
 * The export row keys are shared by every screen; a screen only changes the
 * column LABELS, so the generated file keeps its wording while the row shape
 * lives here.
 */
const EXPORT_COLUMN_KEYS = {
  date: 'Date',
  documentNumber: 'Document No',
  type: 'Type',
  debit: 'Debit',
  credit: 'Credit',
  balance: 'Running Balance',
  notes: 'Notes',
} as const;

/** The export column labels every ledger shares, with the per-screen overrides
 *  applied: the AD/BS date column always honours `dateMode` unless a screen
 *  names it explicitly. */
export function ledgerExportColumns(
  labels: Partial<Record<keyof typeof EXPORT_COLUMN_KEYS, string>>,
  dateMode: 'BS' | 'AD'
): CSVColumn<Record<string, any>>[] {
  return (Object.keys(EXPORT_COLUMN_KEYS) as Array<keyof typeof EXPORT_COLUMN_KEYS>).map((key) => ({
    key: EXPORT_COLUMN_KEYS[key],
    label:
      labels[key] ??
      (key === 'date'
        ? dateMode === 'BS'
          ? 'Nepali (BS) Date'
          : 'English (AD) Date'
        : EXPORT_COLUMN_KEYS[key]),
  }));
}

export const LedgerView: React.FC<LedgerViewProps> = ({
  title,
  subtitle,
  partyLabel,
  parties,
  selectedPartyId,
  onSelectParty,
  branches,
  filters,
  onFilterChange,
  onLoad,
  loading,
  error,
  data,
  dateMode,
  headerIcon: HeaderIcon,
  partyIcon: PartyIcon,
  scoreCards,
  tones,
  columns,
  badges,
  closingLabel,
  exportFilenamePrefix,
  exportColumns,
  emptyPrompt,
}) => {
  const handleExport = () => {
    if (!data) return;
    const rows = data.ledger.map((line) => ({
      [EXPORT_COLUMN_KEYS.date]: dateMode === 'BS' ? line.dateBS : line.dateAD,
      [EXPORT_COLUMN_KEYS.documentNumber]: line.documentNumber,
      [EXPORT_COLUMN_KEYS.type]: line.type,
      [EXPORT_COLUMN_KEYS.debit]: line.debit,
      [EXPORT_COLUMN_KEYS.credit]: line.credit,
      [EXPORT_COLUMN_KEYS.balance]: line.balance,
      [EXPORT_COLUMN_KEYS.notes]: line.notes || '',
    }));
    exportToCSV(`${exportFilenamePrefix}${data.partyName.replace(/\s+/g, '_')}`, rows, exportColumns);
  };

  const loadDisabled = !selectedPartyId || loading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <HeaderIcon className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            {title}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onLoad}
            disabled={loadDisabled}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium transition"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handleExport}
            disabled={!data || data.ledger.length === 0}
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
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">{partyLabel}</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <select
              value={selectedPartyId}
              onChange={(e) => onSelectParty(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm focus:ring-2 focus:ring-indigo-500 dark:text-white"
            >
              <option value="">Select {partyLabel.toLowerCase()}...</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">From (AD)</label>
          <input
            type="date"
            value={filters.fromAd}
            onChange={(e) => onFilterChange({ fromAd: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">To (AD)</label>
          <input
            type="date"
            value={filters.toAd}
            onChange={(e) => onFilterChange({ toAd: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm dark:text-white"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">Branch</label>
          <select
            value={filters.branchId}
            onChange={(e) => onFilterChange({ branchId: e.target.value })}
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
            onClick={onLoad}
            disabled={loadDisabled}
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
      {data && (
        <>
          {/* Summary cards — shared compact StatCard component */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {scoreCards(data).map((card) => (
              <StatCard key={card.label} label={card.label} value={formatNumber(card.value)} tone={card.tone} />
            ))}
          </div>

          {/* Ledger table */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/60 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                <PartyIcon className="h-4 w-4 text-indigo-500" />
                {data.partyName}
                {data.partyCode && (
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">({data.partyCode})</span>
                )}
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                  {data.ledger.length} entries
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
                    <th className="px-4 py-3 text-right font-semibold">{columns.debit}</th>
                    <th className="px-4 py-3 text-right font-semibold">{columns.credit}</th>
                    <th className="px-4 py-3 text-right font-semibold">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30">
                    <td className="px-4 py-2 font-medium text-slate-600 dark:text-slate-300" colSpan={5}>Opening Balance</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-800 dark:text-slate-100">{formatNumber(data.openingBalance)}</td>
                  </tr>
                  {data.ledger.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-400 dark:text-slate-500">
                        No transactions found in the selected range.
                      </td>
                    </tr>
                  )}
                  {data.ledger.map((line, idx) => {
                    const badge = badges[line.type];
                    const BadgeIcon = badge.Icon;
                    return (
                      <tr key={`${line.id}-${idx}`} className="border-t border-slate-100 dark:border-slate-700/60">
                        <td className="px-4 py-2 whitespace-nowrap text-slate-700 dark:text-slate-300">
                          {dateMode === 'BS' ? line.dateBS : line.dateAD}
                        </td>
                        <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{line.documentNumber}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.className}`}>
                            <BadgeIcon className="h-3 w-3" /> {badge.label}
                            {line.type === 'PAYMENT' && line.paymentMethod ? ` (${line.paymentMethod})` : ''}
                          </span>
                        </td>
                        <td className={`px-4 py-2 text-right ${tones.debitCell}`}>{line.debit > 0 ? formatNumber(line.debit) : '—'}</td>
                        <td className={`px-4 py-2 text-right ${tones.creditCell}`}>{line.credit > 0 ? formatNumber(line.credit) : '—'}</td>
                        <td className={`px-4 py-2 text-right font-semibold ${line.balance > 0 ? tones.balancePositive : tones.balanceNeutral}`}>
                          {formatNumber(line.balance)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/50 font-semibold">
                    <td className="px-4 py-3 text-slate-800 dark:text-slate-100" colSpan={5}>{closingLabel}</td>
                    <td className={`px-4 py-3 text-right ${data.closingBalance > 0 ? tones.balancePositive : tones.balanceNeutral}`}>
                      {formatNumber(data.closingBalance)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {emptyPrompt && !data && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
          <Wallet className="h-12 w-12 mb-3 opacity-40" />
          <p>{emptyPrompt}</p>
        </div>
      )}
    </div>
  );
};

export default LedgerView;
