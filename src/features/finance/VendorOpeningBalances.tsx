import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Layers,
  Lock,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Wallet,
} from 'lucide-react';
import { api } from '../../services/api';
import { exportToCSV, CSVColumn } from '../../utils/exportUtils';
import { filterFiscalYears } from '../../utils/permissions';
import { FiscalYearSelect } from '../../components/common/FiscalYearSelect';
import { formatNPR } from '../../utils/nprFormat';
import {
  Branch,
  FiscalYear,
  User,
  VendorOpeningBalanceResponse,
  VendorOpeningBalanceRow,
} from '../../types';

interface VendorOpeningBalancesProps {
  currentUser?: User | null;
  fiscalYears: FiscalYear[];
  branches: Branch[];
  onRefreshData?: () => void;
  /** Globally selected fiscal year id (app-wide scope). */
  selectedFiscalYearId?: string;
  /** Update the global fiscal-year view when the user changes it here. */
  onSelectFiscalYear?: (fiscalYearId: string) => void;
}

/**
 * Vendor Opening Balances (Accounts Payable) — standalone register tab.
 *
 * Supplier × branch opening payables rolled forward from the Vendor Ledger
 * close step in the Fiscal Year Closing Wizard. Editable while the fiscal
 * year is open; corrections are stamped MANUAL_ADJUSTMENT and audited.
 */
export const VendorOpeningBalances: React.FC<VendorOpeningBalancesProps> = ({
  currentUser,
  fiscalYears,
  branches,
  onRefreshData,
  selectedFiscalYearId,
  onSelectFiscalYear,
}) => {
  const role = currentUser?.role;
  const canView = role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' || role === 'ACCOUNTANT';
  const canEditRole = role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER';

  const defaultFyId = useMemo(() => {
    // Prioritize current fiscal year, then first open, then first available
    const current = fiscalYears.find((f) => f.isCurrent);
    if (current) return current.id;
    const open = fiscalYears.find((f) => !f.isClosed);
    if (open) return open.id;
    return fiscalYears[0]?.id || '';
  }, [fiscalYears]);

  // Filter fiscal years using shared utility: show closed, current, and within-date-range years only
  const availableFiscalYears = useMemo(() => filterFiscalYears(fiscalYears), [fiscalYears]);

  const [selectedFyId, setSelectedFyId] = useState<string>(defaultFyId);
  const [vendorData, setVendorData] = useState<VendorOpeningBalanceResponse | null>(null);
  const [vendorLoading, setVendorLoading] = useState<boolean>(false);
  const [vendorLoadError, setVendorLoadError] = useState<string>('');
  const [vendorDrafts, setVendorDrafts] = useState<Record<string, { openingBalance: string }>>({});
  const [vendorSaving, setVendorSaving] = useState<boolean>(false);
  const [vendorSaveMessage, setVendorSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [vendorGenerating, setVendorGenerating] = useState<boolean>(false);
  const [vendorGenMessage, setVendorGenMessage] = useState<string>('');
  const [vendorSearch, setVendorSearch] = useState<string>('');
  const [vendorBranchFilter, setVendorBranchFilter] = useState<string>('ALL');
  const [vendorNonZeroOnly, setVendorNonZeroOnly] = useState<boolean>(false);
  const [vendorChangedOnly, setVendorChangedOnly] = useState<boolean>(false);

  useEffect(() => {
    if (!fiscalYears.some((f) => f.id === selectedFyId)) {
      setSelectedFyId(defaultFyId);
    }
  }, [fiscalYears, selectedFyId, defaultFyId]);

  // Keep the register in sync with the app-wide fiscal-year view (header /
  // fiscal year closing wizard) whenever the user changes it elsewhere.
  useEffect(() => {
    if (selectedFiscalYearId && fiscalYears.some((f) => f.id === selectedFiscalYearId) && selectedFiscalYearId !== selectedFyId) {
      setSelectedFyId(selectedFiscalYearId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiscalYearId, fiscalYears]);

  const fetchVendorRegister = useCallback(async (fyId: string) => {
    if (!fyId) return;
    setVendorLoading(true);
    setVendorLoadError('');
    setVendorSaveMessage(null);
    setVendorDrafts({});
    try {
      const res = await api.getVendorOpeningBalances(fyId);
      setVendorData(res);
    } catch (error) {
      setVendorData(null);
      setVendorLoadError(error instanceof Error ? error.message : 'Unable to load the vendor opening-balance register.');
    } finally {
      setVendorLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVendorRegister(selectedFyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFyId, fetchVendorRegister]);

  const fy = vendorData?.fiscalYear;
  const periodLocked = Boolean(fy?.isClosed);
  const canEdit = canEditRole && !periodLocked;

  const previousFy = useMemo(() => {
    const sorted = [...fiscalYears].sort((a, b) => a.startDateAD.localeCompare(b.startDateAD));
    const idx = sorted.findIndex((f) => f.id === selectedFyId);
    return idx > 0 ? sorted[idx - 1] : null;
  }, [fiscalYears, selectedFyId]);

  const getVendorDraft = (row: VendorOpeningBalanceRow): { openingBalance: string } =>
    vendorDrafts[row.id] || { openingBalance: String(row.openingBalance) };
  const updateVendorDraft = (rowId: string, value: string) => {
    setVendorDrafts((prev) => ({
      ...prev,
      [rowId]: { openingBalance: value },
    }));
  };
  const isVendorRowChanged = (row: VendorOpeningBalanceRow): boolean => {
    if (!vendorDrafts[row.id]) return false;
    return Number(vendorDrafts[row.id].openingBalance) !== Number(row.openingBalance);
  };
  const changedVendorRows = useMemo(
    () => (vendorData ? vendorData.rows.filter(isVendorRowChanged) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendorData, vendorDrafts]
  );
  const filteredVendorRows = useMemo(() => {
    if (!vendorData) return [];
    const q = vendorSearch.trim().toLowerCase();
    return vendorData.rows.filter((row) => {
      if (vendorBranchFilter !== 'ALL' && row.branchId !== vendorBranchFilter) return false;
      if (vendorNonZeroOnly && Number(row.openingBalance) === 0) return false;
      if (vendorChangedOnly && !isVendorRowChanged(row)) return false;
      if (
        q &&
        !row.supplierName.toLowerCase().includes(q) &&
        !row.supplierCode.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorData, vendorSearch, vendorBranchFilter, vendorNonZeroOnly, vendorChangedOnly, vendorDrafts]);

  const validateVendorDraftRow = (row: VendorOpeningBalanceRow): string | null => {
    const d = getVendorDraft(row);
    const balance = Number(d.openingBalance);
    if (d.openingBalance === '' || Number.isNaN(balance)) {
      return `Opening balance must be a number for ${row.supplierName} @ ${row.branchName}.`;
    }
    return null;
  };

  const handleSaveVendorAdjustments = async () => {
    if (!vendorData || !canEdit) return;
    for (const row of changedVendorRows) {
      const issue = validateVendorDraftRow(row);
      if (issue) {
        setVendorSaveMessage({ type: 'error', text: issue });
        return;
      }
    }
    setVendorSaving(true);
    setVendorSaveMessage(null);
    try {
      const payload = changedVendorRows.map((row) => ({
        supplierId: row.supplierId,
        branchId: row.branchId,
        openingBalance: Number(getVendorDraft(row).openingBalance),
      }));
      const res = await api.adjustVendorOpeningBalances(selectedFyId, payload);
      setVendorSaveMessage({ type: 'success', text: res.message });
      await fetchVendorRegister(selectedFyId);
      onRefreshData?.();
    } catch (error) {
      setVendorSaveMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save vendor opening-balance adjustments.',
      });
    } finally {
      setVendorSaving(false);
    }
  };

  const handleGenerateVendorOpenings = async () => {
    if (!previousFy) {
      setVendorGenMessage(
        'No previous fiscal year exists. Vendor opening balances are rolled forward from the closing of a prior fiscal year — create and close one first (Fiscal Year Closing Wizard).'
      );
      return;
    }
    if (!previousFy.isClosed) {
      setVendorGenMessage(
        `The previous fiscal year (${previousFy.code}) must be closed first via the Fiscal Year Closing Wizard before vendor opening balances can be rolled forward for ${fy?.code || 'this year'}.`
      );
      return;
    }
    setVendorGenerating(true);
    setVendorGenMessage('');
    try {
      const res = await api.rollForwardVendorOpenings(previousFy.id);
      setVendorGenMessage(
        `${res.recordsCreated} vendor opening-balance record(s) rolled forward to FY ${res.targetFiscalYear.code} from closing balances of ${previousFy.code}.` +
          (res.manualRowsPreserved ? ` ${res.manualRowsPreserved} manual adjustment row(s) were preserved.` : '')
      );
      await fetchVendorRegister(selectedFyId);
      onRefreshData?.();
    } catch (error) {
      setVendorGenMessage(error instanceof Error ? error.message : 'Unable to roll forward vendor opening balances.');
    } finally {
      setVendorGenerating(false);
    }
  };

  const handleExportVendor = () => {
    if (!vendorData || filteredVendorRows.length === 0) return;
    const columns: CSVColumn<VendorOpeningBalanceRow>[] = [
      { key: 'supplierCode', label: 'Supplier Code' },
      { key: 'supplierName', label: 'Supplier' },
      { key: 'branchName', label: 'Branch' },
      { key: 'openingBalance', label: 'Opening Balance (NPR)' },
      { key: 'sourceType', label: 'Source' },
      { key: 'postedBy', label: 'Posted By' },
      { key: 'postedAt', label: 'Posted At' },
    ];
    exportToCSV({
      filename: `Fiscal_Opening_Vendors_${fy?.code || selectedFyId}`.replace(/\//g, '-'),
      data: filteredVendorRows,
      columns,
      reportTitle: `Fiscal Year Opening Register — Vendor Opening Balances — FY ${fy?.code || ''}`,
      generatedBy: currentUser?.name,
    });
  };

  if (!canView) {
    return (
      <div
        className={`flex flex-col items-center justify-center h-full min-h-[420px] text-center text-slate-500 dark:text-slate-400`}
      >
        <Lock className="h-10 w-10 mb-3 opacity-60" />
        <h2 className="text-lg font-bold">Permission Denied</h2>
        <p className="text-sm mt-1 max-w-md">
          The Vendor Opening Balances register is restricted to Super Admin, Inventory Manager, and Accountant roles.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      {/* ===== Header ===== */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 shadow-sm shrink-0 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-xl shrink-0 bg-emerald-50 dark:bg-emerald-500/10`}>
            <Wallet className={`h-6 w-6 text-emerald-600 dark:text-emerald-400`} />
          </div>
          <div className="min-w-0">
            <h2 className={`text-base font-bold truncate text-slate-900 dark:text-white`}>
              Vendor Opening Balances
            </h2>
            <p className={`text-xs mt-0.5 truncate text-slate-500 dark:text-slate-400`}>
              Supplier × branch opening payables (Accounts Payable) rolled forward from the Vendor Ledger close step in
              the Fiscal Year Closing Wizard. Editable while the fiscal year is open.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FiscalYearSelect
            fiscalYears={availableFiscalYears}
            value={selectedFyId}
            onChange={(fyId) => {
              setSelectedFyId(fyId);
              onSelectFiscalYear?.(fyId);
            }}
            pageSize={3}
            showFyPrefix
            triggerClassName="px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
          />
          {periodLocked ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-rose-500/10 text-rose-500">
              <Lock className="h-3.5 w-3.5" /> Period Locked
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Period Open
            </span>
          )}
        </div>
      </div>

      {/* ===== Period-lock / access banners ===== */}
      {periodLocked ? (
        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300`}
        >
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Period locked — fiscal year {fy?.code} is closed, so vendor opening balances are read-only. A Super Admin
            must reopen the fiscal year (Fiscal Year Closing Wizard) before adjustments are allowed again.
          </span>
        </div>
      ) : (
        !canEditRole && vendorData && vendorData.rows.length > 0 && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300`}
          >
            <Pencil className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Read-only for your role. Vendor opening-balance adjustments require Super Admin or Inventory Manager.
            </span>
          </div>
        )
      )}

      {/* ===== Vendor Opening Balances card ===== */}
      <div
        className={`rounded-xl border p-4 shadow-sm shrink-0 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2.5 rounded-xl shrink-0 bg-emerald-50 dark:bg-emerald-500/10`}>
              <Wallet className={`h-6 w-6 text-emerald-600 dark:text-emerald-400`} />
            </div>
            <div className="min-w-0">
              <h3 className={`text-base font-bold truncate text-slate-900 dark:text-white`}>
                Vendor Opening Balances (Accounts Payable)
              </h3>
              <p className={`text-xs mt-0.5 truncate text-slate-500 dark:text-slate-400`}>
                Supplier × branch opening payables rolled forward from the Vendor Ledger close step in the
                Fiscal Year Closing Wizard. Editable while the fiscal year is open.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && changedVendorRows.length > 0 && (
              <button
                type="button"
                onClick={handleSaveVendorAdjustments}
                disabled={vendorSaving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="h-3.5 w-3.5" /> Save {changedVendorRows.length} Adjustment{changedVendorRows.length > 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>

        {/* Vendor summary stats */}
        {vendorData && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
            {[
              { label: 'Registered Rows', value: String(vendorData.stats.totalRows), icon: Layers },
              { label: 'Manual Adjustments', value: String(vendorData.stats.manualAdjustments), icon: Pencil },
              { label: 'Opening Payables (Debit)', value: formatNPR(vendorData.stats.totalDebitOpening), icon: Wallet },
              { label: 'Opening Advances (Credit)', value: formatNPR(vendorData.stats.totalCreditOpening), icon: Wallet },
            ].map((card) => (
              <div
                key={card.label}
                className={`rounded-xl border p-3 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
              >
                <div className="flex items-center gap-2">
                  <card.icon className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
                  <span className={`text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500`}>
                    {card.label}
                  </span>
                </div>
                <div className={`text-lg font-extrabold mt-1 text-slate-900 dark:text-white`}>{card.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Vendor filters & actions */}
        <div
          className={`flex flex-wrap items-center gap-2 mt-3 rounded-xl border p-3 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          <div className="relative">
            <Search className={`h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500`} />
            <input
              value={vendorSearch}
              onChange={(e) => setVendorSearch(e.target.value)}
              placeholder="Search supplier…"
              className={`pl-8 pr-3 py-2 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500 w-56 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
            />
          </div>
          <select
            value={vendorBranchFilter}
            onChange={(e) => setVendorBranchFilter(e.target.value)}
            className={`px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
          >
            <option value="ALL">All Branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <label className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300`}>
            <input type="checkbox" checked={vendorNonZeroOnly} onChange={(e) => setVendorNonZeroOnly(e.target.checked)} className="rounded" />
            Non-zero only
          </label>
          <label className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300`}>
            <input type="checkbox" checked={vendorChangedOnly} onChange={(e) => setVendorChangedOnly(e.target.checked)} className="rounded" />
            Changed only
          </label>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleExportVendor}
            disabled={vendorLoading || filteredVendorRows.length === 0}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800`}
          >
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
          {canEditRole && (
            <button
              type="button"
              onClick={handleGenerateVendorOpenings}
              disabled={vendorGenerating}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${vendorGenerating ? 'animate-spin' : ''}`} />
              {vendorGenerating ? 'Rolling Forward…' : 'Roll Forward from Previous Close'}
            </button>
          )}
        </div>

        {/* Vendor save / generate feedback */}
        {(vendorSaveMessage || vendorGenMessage) && (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold mt-3 ${
              vendorSaveMessage?.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/30 dark:text-emerald-300'
            }`}
          >
            {vendorSaveMessage?.type === 'error' ? (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <span>{vendorSaveMessage ? vendorSaveMessage.text : vendorGenMessage}</span>
          </div>
        )}

        {/* Vendor register table / empty state */}
        <div
          className={`mt-3 min-h-0 flex flex-col rounded-xl border overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          {vendorLoading ? (
            <div className={`flex items-center justify-center text-sm font-semibold text-slate-500 dark:text-slate-400 py-10`}>
              Loading vendor opening balances…
            </div>
          ) : vendorLoadError ? (
            <div className={`flex flex-col items-center justify-center text-center p-8 gap-2 text-slate-500 dark:text-slate-400`}>
              <AlertTriangle className="h-8 w-8 text-rose-500" />
              <p className="text-sm font-semibold max-w-lg">{vendorLoadError}</p>
              <button
                type="button"
                onClick={() => fetchVendorRegister(selectedFyId)}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          ) : !vendorData || vendorData.rows.length === 0 ? (
            <div className={`flex flex-col items-center justify-center text-center p-8 gap-3 text-slate-500 dark:text-slate-400`}>
              <Wallet className="h-10 w-10 opacity-50" />
              <div>
                <p className="text-sm font-bold">No vendor opening balances posted for FY {fy?.code || '—'} yet.</p>
                <p className="text-xs mt-1 max-w-lg">
                  Roll the balances forward from the previous fiscal year's Vendor Ledger close, or add a supplier
                  opening manually while the fiscal year is open.
                </p>
              </div>
              {canEditRole && (
                <button
                  type="button"
                  onClick={handleGenerateVendorOpenings}
                  disabled={vendorGenerating}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${vendorGenerating ? 'animate-spin' : ''}`} />
                  {vendorGenerating ? 'Rolling Forward…' : 'Roll Forward from Previous Close'}
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    {['Supplier', 'Branch', 'Opening Balance (NPR)', 'Source', 'Posted'].map((h) => (
                      <th
                        key={h}
                        className={`px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b border-slate-200 dark:border-slate-800`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredVendorRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className={`px-3 py-8 text-center text-xs font-semibold text-slate-400 dark:text-slate-500`}>
                        No rows match the current filters.
                      </td>
                    </tr>
                  )}
                  {filteredVendorRows.map((row) => {
                    const changed = isVendorRowChanged(row);
                    const draft = getVendorDraft(row);
                    const effBalance = changed ? Number(draft.openingBalance) || 0 : row.openingBalance;
                    const inputBase = `px-2 py-1 rounded-md border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 ${changed ? 'border-amber-400' : ''}`;
                    return (
                      <tr
                        key={row.id}
                        className={`border-b transition-colors border-slate-100 dark:border-slate-800/70 ${changed ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                      >
                        <td className="px-3 py-2">
                          <div className={`text-xs font-bold text-slate-800 dark:text-slate-200`}>
                            {row.supplierName}
                          </div>
                          <div className={`text-[10px] text-slate-400 dark:text-slate-500`}>
                            {row.supplierCode}
                          </div>
                        </td>
                        <td className={`px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 dark:text-slate-300`}>
                          {row.branchName}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              step={0.01}
                              disabled={!canEdit}
                              value={changed ? draft.openingBalance : String(row.openingBalance)}
                              onChange={(e) => updateVendorDraft(row.id, e.target.value)}
                              className={`${inputBase} w-32 font-bold text-right`}
                            />
                            {changed && (
                              <span className="text-[10px] font-bold text-amber-500 whitespace-nowrap">
                                {row.openingBalance} → {effBalance}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {row.sourceType === 'MANUAL_ADJUSTMENT' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 whitespace-nowrap">
                              <Pencil className="h-3 w-3" /> Manual
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-500 whitespace-nowrap">
                              <CheckCircle2 className="h-3 w-3" /> Fiscal Close
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className={`text-[10px] leading-tight text-slate-400 dark:text-slate-500`}>
                            <div className="font-semibold truncate max-w-[130px]">{row.postedBy || '—'}</div>
                            <div>{row.postedAt ? row.postedAt.replace('T', ' ').slice(0, 16) : '—'}</div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VendorOpeningBalances;