import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Layers,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Scale,
  Search,
  X,
} from 'lucide-react';
import { api } from '../../services/api';
import { exportToCSV, CSVColumn } from '../../utils/exportUtils';
import { filterFiscalYears } from '../../utils/permissions';
import {
  Branch,
  FiscalYear,
  FiscalYearOpeningStockResponse,
  FiscalYearOpeningStockRow,
  Product,
  User,
} from '../../types';

interface OpeningStockManagerProps {
  currentUser?: User | null;
  fiscalYears: FiscalYear[];
  branches: Branch[];
  products: Product[];
  isDarkMode?: boolean;
  onRefreshData?: () => void;
}

type Draft = { quantityOnHand: string; damagedQty: string; unitCost: string };

const formatNPR = (value: number) =>
  `NPR ${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Fiscal Year Opening Stock Register (Setup).
 *
 * Enterprise period-lock model:
 *  - Opening balances are generated from the closing balances of the previous
 *    fiscal year (Fiscal Year Closing Wizard) for every product x branch.
 *  - While the fiscal year is OPEN, Super Admin / Inventory Manager may correct
 *    rows (quantity, damaged, unit cost). Corrections are stamped
 *    source_type = MANUAL_ADJUSTMENT with the authorizing user and are audited.
 *  - Once the fiscal year is CLOSED the register is strictly read-only; editing
 *    is allowed again only after a Super Admin reopen.
 */
export const OpeningStockManager: React.FC<OpeningStockManagerProps> = ({
  currentUser,
  fiscalYears,
  branches,
  products,
  isDarkMode = false,
  onRefreshData,
}) => {
  const role = currentUser?.role;
  const canView = role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER' || role === 'ACCOUNTANT';
  const canEditRole = role === 'SUPER_ADMIN' || role === 'INVENTORY_MANAGER';

  const defaultFyId = useMemo(() => {
    const open = fiscalYears.find((f) => !f.isClosed);
    return (open || fiscalYears[0])?.id || '';
  }, [fiscalYears]);

  // Filter fiscal years using shared utility: show closed, current, and within-date-range years only
  const availableFiscalYears = useMemo(() => filterFiscalYears(fiscalYears), [fiscalYears]);

  const [selectedFyId, setSelectedFyId] = useState<string>(defaultFyId);
  const [data, setData] = useState<FiscalYearOpeningStockResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [search, setSearch] = useState<string>('');
  const [branchFilter, setBranchFilter] = useState<string>('ALL');
  const [zeroOnly, setZeroOnly] = useState<boolean>(false);
  const [changedOnly, setChangedOnly] = useState<boolean>(false);

  const [generating, setGenerating] = useState<boolean>(false);
  const [genMessage, setGenMessage] = useState<string>('');

  const [showAddRow, setShowAddRow] = useState<boolean>(false);
  const [addProductId, setAddProductId] = useState<string>('');
  const [addBranchId, setAddBranchId] = useState<string>('');
  const [addQty, setAddQty] = useState<string>('0');
  const [addDamaged, setAddDamaged] = useState<string>('0');
  const [addCost, setAddCost] = useState<string>('0');
  const [adding, setAdding] = useState<boolean>(false);

  useEffect(() => {
    if (!fiscalYears.some((f) => f.id === selectedFyId)) {
      setSelectedFyId(defaultFyId);
    }
  }, [fiscalYears, selectedFyId, defaultFyId]);

  const fetchRegister = useCallback(async (fyId: string) => {
    if (!fyId) return;
    setLoading(true);
    setLoadError('');
    setSaveMessage(null);
    setDrafts({});
    try {
      const res = await api.getFiscalYearOpeningStock(fyId);
      setData(res);
    } catch (error) {
      setData(null);
      setLoadError(error instanceof Error ? error.message : 'Unable to load the opening-stock register.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRegister(selectedFyId);
  }, [selectedFyId, fetchRegister]);

  const fy = data?.fiscalYear;
  const periodLocked = Boolean(fy?.isClosed);
  const canEdit = canEditRole && !periodLocked;

  const previousFy = useMemo(() => {
    const sorted = [...fiscalYears].sort((a, b) => a.startDateAD.localeCompare(b.startDateAD));
    const idx = sorted.findIndex((f) => f.id === selectedFyId);
    return idx > 0 ? sorted[idx - 1] : null;
  }, [fiscalYears, selectedFyId]);

  const getDraft = (row: FiscalYearOpeningStockRow): Draft =>
    drafts[row.id] || {
      quantityOnHand: String(row.quantityOnHand),
      damagedQty: String(row.damagedQty),
      unitCost: String(row.unitCost),
    };
  const updateDraft = (rowId: string, field: keyof Draft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [rowId]: {
        quantityOnHand: prev[rowId]?.quantityOnHand ?? '',
        damagedQty: prev[rowId]?.damagedQty ?? '',
        unitCost: prev[rowId]?.unitCost ?? '',
        [field]: value,
      },
    }));
  };

  const isRowChanged = (row: FiscalYearOpeningStockRow): boolean => {
    if (!drafts[row.id]) return false;
    const d = drafts[row.id];
    return (
      Number(d.quantityOnHand) !== row.quantityOnHand ||
      Number(d.damagedQty) !== row.damagedQty ||
      Number(d.unitCost) !== row.unitCost
    );
  };

  const changedRows = useMemo(
    () => (data ? data.rows.filter(isRowChanged) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, drafts]
  );

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (branchFilter !== 'ALL' && row.branchId !== branchFilter) return false;
      if (zeroOnly && Number(row.quantityOnHand) !== 0) return false;
      if (changedOnly && !isRowChanged(row)) return false;
      if (q && !row.productName.toLowerCase().includes(q) && !row.productSku.toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, search, branchFilter, zeroOnly, changedOnly, drafts]);

  const validateDraftRow = (row: FiscalYearOpeningStockRow): string | null => {
    const d = getDraft(row);
    const qty = Number(d.quantityOnHand);
    const damaged = Number(d.damagedQty ?? 0);
    const cost = Number(d.unitCost ?? 0);
    const label = `${row.productName} @ ${row.branchName}`;
    if (d.quantityOnHand === '' || !Number.isInteger(qty) || qty < 0) {
      return `Quantity on hand must be a whole number >= 0 for ${label}.`;
    }
    if (d.damagedQty === '' || !Number.isInteger(damaged) || damaged < 0) {
      return `Damaged quantity must be a whole number >= 0 for ${label}.`;
    }
    if (damaged > qty) return `Damaged quantity cannot exceed quantity on hand for ${label}.`;
    if (d.unitCost === '' || Number.isNaN(cost) || cost < 0) {
      return `Unit cost must be a number >= 0 for ${label}.`;
    }
    return null;
  };
  const handleSaveAdjustments = async () => {
    if (!data || !canEdit) return;
    for (const row of changedRows) {
      const issue = validateDraftRow(row);
      if (issue) {
        setSaveMessage({ type: 'error', text: issue });
        return;
      }
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const payload = changedRows.map((row) => {
        const d = getDraft(row);
        return {
          productId: row.productId,
          branchId: row.branchId,
          quantityOnHand: Number(d.quantityOnHand),
          damagedQty: Number(d.damagedQty),
          unitCost: Number(d.unitCost),
        };
      });
      const res = await api.adjustFiscalYearOpeningStock(selectedFyId, payload);
      setSaveMessage({ type: 'success', text: res.message });
      await fetchRegister(selectedFyId);
      onRefreshData?.();
    } catch (error) {
      setSaveMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save opening-stock adjustments.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleGenerate = async () => {
    if (!previousFy) {
      setGenMessage(
        'No previous fiscal year exists. Opening stock is generated from the closing balances of a prior fiscal year — create and close one first (Fiscal Year Closing Wizard).'
      );
      return;
    }
    if (!previousFy.isClosed) {
      setGenMessage(
        `The previous fiscal year (${previousFy.code}) must be closed first via the Fiscal Year Closing Wizard before opening stock can be generated for ${fy?.code || 'this year'}.`
      );
      return;
    }
    setGenerating(true);
    setGenMessage('');
    try {
      const res = await api.initializeFiscalYearOpeningStock(previousFy.id);
      setGenMessage(
        `${res.recordsCreated} opening-stock records generated for FY ${res.targetFiscalYear.code} from closing balances of ${previousFy.code}.` +
          (res.manualRowsPreserved ? ` ${res.manualRowsPreserved} manual adjustment row(s) were preserved.` : '')
      );
      await fetchRegister(selectedFyId);
      onRefreshData?.();
    } catch (error) {
      setGenMessage(error instanceof Error ? error.message : 'Unable to generate opening stock.');
    } finally {
      setGenerating(false);
    }
  };

  const handleAddRow = async () => {
    if (!addProductId || !addBranchId) {
      setSaveMessage({ type: 'error', text: 'Select both a product and a branch to add an opening-stock row.' });
      return;
    }
    const qty = Number(addQty);
    const damaged = Number(addDamaged || 0);
    const cost = Number(addCost || 0);
    if (!Number.isInteger(qty) || qty < 0) {
      setSaveMessage({ type: 'error', text: 'Quantity on hand must be a whole number >= 0.' });
      return;
    }
    if (!Number.isInteger(damaged) || damaged < 0 || damaged > qty) {
      setSaveMessage({ type: 'error', text: 'Damaged quantity must be a whole number >= 0 and <= quantity on hand.' });
      return;
    }
    if (Number.isNaN(cost) || cost < 0) {
      setSaveMessage({ type: 'error', text: 'Unit cost must be a number >= 0.' });
      return;
    }
    setAdding(true);
    setSaveMessage(null);
    try {
      await api.adjustFiscalYearOpeningStock(selectedFyId, [
        { productId: addProductId, branchId: addBranchId, quantityOnHand: qty, damagedQty: damaged, unitCost: cost },
      ]);
      setShowAddRow(false);
      setAddProductId('');
      setAddBranchId('');
      setAddQty('0');
      setAddDamaged('0');
      setAddCost('0');
      setSaveMessage({ type: 'success', text: 'Opening-stock row saved.' });
      await fetchRegister(selectedFyId);
      onRefreshData?.();
    } catch (error) {
      setSaveMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to add opening-stock row.',
      });
    } finally {
      setAdding(false);
    }
  };

  const handleExport = () => {
    if (!data || filteredRows.length === 0) return;
    const columns: CSVColumn<FiscalYearOpeningStockRow>[] = [
      { key: 'productSku', label: 'SKU' },
      { key: 'productName', label: 'Product' },
      { key: 'branchName', label: 'Branch' },
      { key: 'quantityOnHand', label: 'Opening Qty' },
      { key: 'damagedQty', label: 'Damaged Qty' },
      { key: 'unitCost', label: 'Unit Cost (NPR)' },
      {
        key: 'value',
        label: 'Opening Value (NPR)',
        formatter: (_v: any, r: FiscalYearOpeningStockRow) => Number(r.quantityOnHand) * Number(r.unitCost),
      },
      { key: 'liveQty', label: 'Current Live Qty' },
      { key: 'sourceType', label: 'Source' },
      { key: 'postedBy', label: 'Posted By' },
      { key: 'postedAt', label: 'Posted At' },
    ];
    exportToCSV({
      filename: `Fiscal_Opening_Stock_${fy?.code || selectedFyId}`.replace(/\//g, '-'),
      data: filteredRows,
      columns,
      reportTitle: `Fiscal Year Opening Stock Register — FY ${fy?.code || ''}`,
      generatedBy: currentUser?.name,
    });
  };
  if (!canView) {
    return (
      <div
        className={`flex flex-col items-center justify-center h-full min-h-[420px] text-center ${
          isDarkMode ? 'text-slate-400' : 'text-slate-500'
        }`}
      >
        <Lock className="h-10 w-10 mb-3 opacity-60" />
        <h2 className="text-lg font-bold">Permission Denied</h2>
        <p className="text-sm mt-1 max-w-md">
          The Fiscal Year Opening Stock Register is restricted to Super Admin, Inventory Manager, and Accountant roles.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      {/* ===== Header ===== */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 shadow-sm shrink-0 ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-xl shrink-0 ${isDarkMode ? 'bg-indigo-500/10' : 'bg-indigo-50'}`}>
            <Scale className={`h-6 w-6 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
          </div>
          <div className="min-w-0">
            <h2 className={`text-base font-bold truncate ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
              Fiscal Year Opening Stock Register
            </h2>
            <p className={`text-xs mt-0.5 truncate ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Posted opening balances (product × branch) that all historical period calculations are based on.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedFyId}
            onChange={(e) => setSelectedFyId(e.target.value)}
            className={`px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
              isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
            }`}
          >
            {availableFiscalYears.length === 0 && <option value="">No fiscal years</option>}
            {availableFiscalYears.map((f) => (
              <option key={f.id} value={f.id}>
                FY {f.code}
                {f.isCurrent ? ' (Current)' : ''}
                {f.isClosed ? ' (Closed)' : ''}
              </option>
            ))}
          </select>
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
          className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 ${
            isDarkMode ? 'bg-rose-500/5 border-rose-500/30 text-rose-300' : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}
        >
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Period locked — fiscal year {fy?.code} is closed, so opening balances are read-only. A Super Admin must
            reopen the fiscal year (Fiscal Year Closing Wizard) before adjustments are allowed again.
          </span>
        </div>
      ) : (
        !canEditRole && data && data.rows.length > 0 && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 ${
              isDarkMode ? 'bg-amber-500/5 border-amber-500/30 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}
          >
            <Pencil className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Read-only for your role. Opening-stock adjustments require Super Admin or Inventory Manager.</span>
          </div>
        )
      )}

      {/* ===== Summary stats ===== */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
          {[
            { label: 'Registered Rows', value: String(data.stats.totalRows), icon: Layers },
            { label: 'Manual Adjustments', value: String(data.stats.manualAdjustments), icon: Pencil },
            { label: 'Zero-Qty Rows', value: String(data.stats.zeroQtyRows), icon: AlertTriangle },
            { label: 'Opening Value', value: formatNPR(data.stats.totalValue), icon: Scale },
          ].map((card) => (
            <div
              key={card.label}
              className={`rounded-xl border p-3 shadow-sm ${
                isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center gap-2">
                <card.icon className={`h-4 w-4 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
                <span className={`text-[11px] font-bold uppercase tracking-wide ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                  {card.label}
                </span>
              </div>
              <div className={`text-lg font-extrabold mt-1 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{card.value}</div>
            </div>
          ))}
        </div>
      )}
      {/* ===== Filters & actions ===== */}
      <div
        className={`flex flex-wrap items-center gap-2 rounded-xl border p-3 shadow-sm shrink-0 ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="relative">
          <Search className={`h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product name or SKU…"
            className={`pl-8 pr-3 py-2 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56 ${
              isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
            }`}
          />
        </div>
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className={`px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
            isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
          }`}
        >
          <option value="ALL">All Branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <label className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
          <input type="checkbox" checked={zeroOnly} onChange={(e) => setZeroOnly(e.target.checked)} className="rounded" />
          Zero-qty only
        </label>
        <label className={`flex items-center gap-1.5 text-xs font-semibold cursor-pointer ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} className="rounded" />
          Changed only
        </label>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleExport}
          disabled={loading || filteredRows.length === 0}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed ${
            isDarkMode ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
        {canEdit && data && data.rows.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAddRow(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold bg-white hover:bg-slate-50 ${isDarkMode ? 'text-indigo-400 border-indigo-800' : 'text-indigo-600 border-indigo-200'}`}
          >
            <Plus className="h-3.5 w-3.5" /> Add Row
          </button>
        )}
        {canEdit && changedRows.length > 0 && (
          <button
            type="button"
            onClick={handleSaveAdjustments}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-3.5 w-3.5" /> Save {changedRows.length} Adjustment{changedRows.length > 1 ? 's' : ''}
          </button>
        )}
      </div>

      {/* ===== Save / generate feedback ===== */}
      {(saveMessage || genMessage) && (
        <div
          className={`flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold shrink-0 ${
            saveMessage?.type === 'error' || (genMessage && !data?.rows.length)
              ? isDarkMode
                ? 'bg-rose-500/5 border-rose-500/30 text-rose-300'
                : 'bg-rose-50 border-rose-200 text-rose-700'
              : isDarkMode
              ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300'
              : 'bg-emerald-50 border-emerald-200 text-emerald-700'
          }`}
        >
          {saveMessage?.type === 'error' ? (
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <span>{saveMessage ? saveMessage.text : genMessage}</span>
        </div>
      )}
      {/* ===== Register table / empty state ===== */}
      <div
        className={`flex-1 min-h-0 flex flex-col rounded-xl border shadow-md overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        {loading ? (
          <div
            className={`flex-1 flex items-center justify-center text-sm font-semibold ${
              isDarkMode ? 'text-slate-400' : 'text-slate-500'
            }`}
          >
            Loading opening-stock register…
          </div>
        ) : loadError ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center p-8 gap-2 ${
              isDarkMode ? 'text-slate-400' : 'text-slate-500'
            }`}
          >
            <AlertTriangle className="h-8 w-8 text-rose-500" />
            <p className="text-sm font-semibold max-w-lg">{loadError}</p>
            <button
              type="button"
              onClick={() => fetchRegister(selectedFyId)}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div
            className={`flex-1 flex flex-col items-center justify-center text-center p-8 gap-3 ${
              isDarkMode ? 'text-slate-400' : 'text-slate-500'
            }`}
          >
            <Layers className="h-10 w-10 opacity-50" />
            <div>
              <p className="text-sm font-bold">No opening stock posted for FY {fy?.code || '—'} yet.</p>
              <p className="text-xs mt-1 max-w-lg">
                Generate the register from the closing balances of the previous fiscal year. Every product × branch
                combination is created, including zero-quantity rows, so nothing disappears from the new period.
              </p>
            </div>
            {canEditRole && (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${generating ? 'animate-spin' : ''}`} />
                {generating ? 'Generating…' : 'Generate from Closing Balances'}
              </button>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className={isDarkMode ? 'bg-slate-900 text-slate-400' : 'bg-slate-50 text-slate-500'}>
                  {[
                    'Product',
                    'Branch',
                    'Opening Qty',
                    'Damaged',
                    'Unit Cost (NPR)',
                    'Opening Value',
                    'Live Qty',
                    'Source',
                    'Posted',
                  ].map((h) => (
                    <th
                      key={h}
                      className={`px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b ${
                        isDarkMode ? 'border-slate-800' : 'border-slate-200'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className={`px-3 py-8 text-center text-xs font-semibold ${
                        isDarkMode ? 'text-slate-500' : 'text-slate-400'
                      }`}
                    >
                      No rows match the current filters.
                    </td>
                  </tr>
                )}
                {filteredRows.map((row) => {
                  const changed = isRowChanged(row);
                  const draft = getDraft(row);
                  const effQty = changed ? Number(draft.quantityOnHand) || 0 : row.quantityOnHand;
                  const effCost = changed ? Number(draft.unitCost) || 0 : row.unitCost;
                  const valueMismatchesLive = Number(row.liveQty) !== Number(row.quantityOnHand);
                  const inputBase = `px-2 py-1 rounded-md border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed ${
                    isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-700'
                  } ${changed ? 'border-amber-400' : ''}`;
                  return (
                    <tr
                      key={row.id}
                      className={`border-b transition-colors ${
                        isDarkMode ? 'border-slate-800/70' : 'border-slate-100'
                      } ${changed ? (isDarkMode ? 'bg-amber-500/10' : 'bg-amber-50') : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className={`text-xs font-bold ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                          {row.productName}
                        </div>
                        <div className={`text-[10px] ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                          {row.productSku}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-2 text-xs font-semibold whitespace-nowrap ${
                          isDarkMode ? 'text-slate-300' : 'text-slate-600'
                        }`}
                      >
                        {row.branchName}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            disabled={!canEdit}
                            value={changed ? draft.quantityOnHand : String(row.quantityOnHand)}
                            onChange={(e) => updateDraft(row.id, 'quantityOnHand', e.target.value)}
                            className={`${inputBase} w-20 font-bold`}
                          />
                          {changed && (
                            <span className="text-[10px] font-bold text-amber-500 whitespace-nowrap">
                              {row.quantityOnHand} → {effQty}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          disabled={!canEdit}
                          value={changed ? draft.damagedQty : String(row.damagedQty)}
                          onChange={(e) => updateDraft(row.id, 'damagedQty', e.target.value)}
                          className={`${inputBase} w-16`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          disabled={!canEdit}
                          value={changed ? draft.unitCost : String(row.unitCost)}
                          onChange={(e) => updateDraft(row.id, 'unitCost', e.target.value)}
                          className={`${inputBase} w-24`}
                        />
                      </td>
                      <td
                        className={`px-3 py-2 text-xs font-bold whitespace-nowrap ${
                          isDarkMode ? 'text-slate-200' : 'text-slate-800'
                        }`}
                      >
                        {formatNPR(effQty * effCost)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-xs font-semibold ${
                            valueMismatchesLive ? 'text-amber-500' : isDarkMode ? 'text-slate-500' : 'text-slate-400'
                          }`}
                        >
                          {row.liveQty}
                          {valueMismatchesLive ? ' ⚠' : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.sourceType === 'MANUAL_ADJUSTMENT' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 whitespace-nowrap">
                            <Pencil className="h-3 w-3" /> Manual
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/10 text-indigo-500 whitespace-nowrap">
                            <CheckCircle2 className="h-3 w-3" /> Fiscal Close
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className={`text-[10px] leading-tight ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
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
      {/* ===== Add Row Modal ===== */}
      {showAddRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowAddRow(false)}>
          <div
            className={`w-full max-w-md rounded-2xl border shadow-2xl ${
              isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`flex items-center justify-between px-5 py-4 border-b ${
                isDarkMode ? 'border-slate-800' : 'border-slate-200'
              }`}
            >
              <h3 className={`text-sm font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                Add Opening-Stock Row — FY {fy?.code || '—'}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddRow(false)}
                className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label
                  className={`block text-[11px] font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}
                >
                  Product
                </label>
                <select
                  value={addProductId}
                  onChange={(e) => setAddProductId(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
                  }`}
                >
                  <option value="">Select a product…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  className={`block text-[11px] font-bold uppercase mb-1 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}
                >
                  Branch
                </label>
                <select
                  value={addBranchId}
                  onChange={(e) => setAddBranchId(e.target.value)}
                  className={`w-full px-3 py-2 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                    isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
                  }`}
                >
                  <option value="">Select a branch…</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Qty', step: '1', value: addQty, set: setAddQty },
                  { label: 'Damaged', step: '1', value: addDamaged, set: setAddDamaged },
                  { label: 'Cost (NPR)', step: '0.01', value: addCost, set: setAddCost },
                ].map((f) => (
                  <div key={f.label}>
                    <label
                      className={`block text-[11px] font-bold uppercase mb-1 ${
                        isDarkMode ? 'text-slate-500' : 'text-slate-400'
                      }`}
                    >
                      {f.label}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={f.step}
                      value={f.value}
                      onChange={(e) => f.set(e.target.value)}
                      className={`w-full px-3 py-2 rounded-lg border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                        isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
                      }`}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div
              className={`flex justify-end gap-2 px-5 py-4 border-t ${
                isDarkMode ? 'border-slate-800' : 'border-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => setShowAddRow(false)}
                className={`px-4 py-2 rounded-lg border text-xs font-bold ${
                  isDarkMode ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddRow}
                disabled={adding}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="h-3.5 w-3.5" /> {adding ? 'Saving…' : 'Save Row'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};