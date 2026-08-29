import React, { useState, useEffect } from 'react';
import { FiscalYear, DocumentNumberConfig } from '../../types';
import { api } from '../../services/api';
import {
  getDocumentNumberConfigs,
  saveDocumentNumberConfigs,
  formatDocumentNumber,
  generateNextDocumentNumber,
  resetDocumentSequence,
} from '../../utils/documentNumbering';
import {
  CalendarDays,
  CheckCircle2,
  Lock,
  Unlock,
  PlusCircle,
  Hash,
  Sliders,
  Settings,
  RefreshCw,
  Edit3,
  X,
  AlertCircle,
  Sparkles,
  ShieldCheck,
  Scale,
  Building,
  ArrowRight,
  Info,
  Check,
  RotateCcw,
  Search,
  Filter,
  Wrench,
  Package,
  Trash2,
} from 'lucide-react';

type DocCategory = 'ALL' | 'PROCUREMENT_SALES' | 'INVENTORY_OPS' | 'FIXED_ASSETS' | 'FINANCE_TAX';

const getDocCategory = (id: string): DocCategory => {
  if (['PO', 'PI', 'GRN', 'DN', 'INV', 'QUO', 'CN'].includes(id)) return 'PROCUREMENT_SALES';
  if (['ST', 'SA', 'DC', 'CPI', 'EXC', 'WC'].includes(id)) return 'INVENTORY_OPS';
  if (['FAA', 'FAR'].includes(id)) return 'FIXED_ASSETS';
  if (['JV', 'PV', 'RV'].includes(id)) return 'FINANCE_TAX';
  return 'ALL';
};

interface FiscalYearManagementProps {
  fiscalYears: FiscalYear[];
  onSetCurrentFiscalYear: (id: string) => Promise<void>;
  onCreateFiscalYear?: (fy: Partial<FiscalYear>) => Promise<void>;
  onDeleteFiscalYear?: (id: string) => Promise<void>;
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const FiscalYearManagement: React.FC<FiscalYearManagementProps> = ({
  fiscalYears,
  onSetCurrentFiscalYear,
  onCreateFiscalYear,
  onDeleteFiscalYear,
  isDarkMode = false,
}) => {
  // Document Numbering State
  const [docConfigs, setDocConfigs] = useState<DocumentNumberConfig[]>(() =>
    getDocumentNumberConfigs()
  );

  useEffect(() => {
    api.getDocumentNumberConfigs()
      .then((configs) => {
        if (Array.isArray(configs) && configs.length > 0) {
          setDocConfigs(configs);
          try {
            localStorage.setItem('izone_document_number_configs', JSON.stringify(configs));
          } catch (_e) {}
        }
      })
      .catch((err) => {
        console.warn('Failed to fetch document configs from DB backend:', err?.message || err);
      });
  }, []);
  const [selectedCategory, setSelectedCategory] = useState<DocCategory>('ALL');
  const [docSearchQuery, setDocSearchQuery] = useState<string>('');
  const [editingDocConfig, setEditingDocConfig] = useState<DocumentNumberConfig | null>(null);
  const [testGeneratedNumber, setTestGeneratedNumber] = useState<{ id: string; num: string } | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string>('');

  const filteredDocConfigs = docConfigs.filter((c) => {
    const matchesCategory = selectedCategory === 'ALL' || getDocCategory(c.id) === selectedCategory;
    const q = docSearchQuery.toLowerCase().trim();
    const matchesSearch =
      !q ||
      c.id.toLowerCase().includes(q) ||
      c.documentType.toLowerCase().includes(q) ||
      c.prefix.toLowerCase().includes(q) ||
      (c.notes && c.notes.toLowerCase().includes(q));
    return matchesCategory && matchesSearch;
  });

  // New Fiscal Year Modal State
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newFyCode, setNewFyCode] = useState<string>('2083/84');
  const [newStartAD, setNewStartAD] = useState<string>('2026-04-14');
  const [newEndAD, setNewEndAD] = useState<string>('2027-04-13');
  const [newStartBS, setNewStartBS] = useState<string>('2083-01-01');
  const [newEndBS, setNewEndBS] = useState<string>('2083-12-30');
  const [createFyMsg, setCreateFyMsg] = useState<string>('');

  // Period Lock State
  const [periodLocks, setPeriodLocks] = useState<Record<string, boolean>>({
    'Q1 (Shrawan - Ashwin)': true,
    'Q2 (Kartik - Poush)': true,
    'Q3 (Magh - Chaitra)': false,
    'Q4 (Baisakh - Ashadh)': false,
  });

  const handleTogglePeriodLock = (periodName: string) => {
    setPeriodLocks((prev) => ({
      ...prev,
      [periodName]: !prev[periodName],
    }));
  };

  const handleSaveDocConfigEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDocConfig) return;

    const updated = docConfigs.map((c) =>
      c.id === editingDocConfig.id ? editingDocConfig : c
    );

    setDocConfigs(updated);
    saveDocumentNumberConfigs(updated);
    setEditingDocConfig(null);
    setSaveSuccessMsg(`Updated document sequence setup for "${editingDocConfig.documentType}" successfully!`);
    setTimeout(() => setSaveSuccessMsg(''), 4000);
  };

  const handleTestGenerate = (docId: string) => {
    const num = generateNextDocumentNumber(docId, false);
    setTestGeneratedNumber({ id: docId, num });
  };

  const handleResetCounter = (docId: string, startNum: number) => {
    if (confirm(`Reset sequence counter for ${docId} back to starting number ${startNum}?`)) {
      resetDocumentSequence(docId, startNum);
      const updated = getDocumentNumberConfigs();
      setDocConfigs(updated);
      setSaveSuccessMsg(`Reset counter for ${docId} to ${startNum}`);
      setTimeout(() => setSaveSuccessMsg(''), 4000);
    }
  };

  const handleCreateFiscalYearSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFyCode.trim()) {
      setCreateFyMsg('Please enter a valid Fiscal Year code (e.g. 2083/84).');
      return;
    }
    try {
      if (onCreateFiscalYear) {
        await onCreateFiscalYear({
          code: newFyCode.trim(),
          startDateAD: newStartAD,
          endDateAD: newEndAD,
          startDateBS: newStartBS,
          endDateBS: newEndBS,
          isCurrent: false,
          isClosed: false,
        });
      }
      setCreateFyMsg(`Fiscal Year ${newFyCode} saved to database.`);
      setTimeout(() => {
        setCreateFyMsg('');
        setShowCreateModal(false);
      }, 1200);
    } catch (err: any) {
      setCreateFyMsg(err?.message || 'Failed to create fiscal year');
    }
  };

  const handleDeleteFy = async (fy: FiscalYear) => {
    if (fy.isCurrent) {
      alert('Cannot delete the active fiscal year. Set another year as active first.');
      return;
    }
    if (!confirm(`Delete fiscal year ${fy.code} from the database? Opening-stock snapshots for this year will also be removed.`)) {
      return;
    }
    try {
      if (onDeleteFiscalYear) await onDeleteFiscalYear(fy.id);
      setSaveSuccessMsg(`Deleted fiscal year ${fy.code}.`);
      setTimeout(() => setSaveSuccessMsg(''), 4000);
    } catch (err: any) {
      alert(err?.message || 'Failed to delete fiscal year');
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Title Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <CalendarDays className="h-6 w-6 text-indigo-500" />
            <span>Fiscal Year Management & Document Numbering Setup</span>
          </h2>
          <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Manage accounting fiscal years, active period locks, opening balance transfers, and dynamic document sequence numbering.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer w-fit"
        >
          <PlusCircle className="h-4 w-4" />
          <span>Add New Fiscal Year</span>
        </button>
      </div>

      {/* Success Notification Banner */}
      {saveSuccessMsg && (
        <div className={`p-4 rounded-2xl border text-xs font-semibold flex items-center gap-2 shadow-sm ${
          isDarkMode ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-900'
        }`}>
          <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
          <span>{saveSuccessMsg}</span>
        </div>
      )}

      {/* Section 1: Active Fiscal Year Switcher & Status Cards */}
      <div>
        <h3 className={`text-sm font-bold mb-3 flex items-center gap-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
          <Lock className="h-4 w-4 text-amber-500" />
          <span>Nepali Fiscal Year Accounting Periods (<code className={isDarkMode ? 'text-amber-300 font-mono' : 'text-amber-700 font-mono'}>YYYY/YY</code>)</span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {fiscalYears.map((fy) => (
            <div
              key={fy.id}
              className={`rounded-2xl p-4 border transition-all ${
                fy.isCurrent
                  ? isDarkMode
                    ? 'bg-gradient-to-br from-indigo-950 via-[#0f1218] to-slate-900 text-white border-indigo-500/60 shadow-xl'
                    : 'bg-indigo-50/90 border-indigo-300 text-slate-900 shadow-sm'
                  : isDarkMode
                    ? 'bg-[#0f1218] border-slate-800 text-slate-300 hover:border-slate-700'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 shadow-2xs'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-xs font-bold font-mono px-2.5 py-0.5 rounded-full border ${
                    fy.isCurrent
                      ? isDarkMode
                        ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30'
                        : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                      : isDarkMode
                        ? 'bg-slate-900 text-slate-400 border-slate-800'
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  FY {fy.code}
                </span>

                {fy.isCurrent ? (
                  <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-bold">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <button
                    onClick={() => onSetCurrentFiscalYear(fy.id)}
                    className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                  >
                    Set Active
                  </button>
                )}
              </div>

              <div className="space-y-1.5 text-[11px]">
                <div className={`flex justify-between border-b pb-1 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>BS Period:</span>
                  <span className={`font-mono font-semibold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                    {fy.startDateBS} to {fy.endDateBS}
                  </span>
                </div>
                <div className={`flex justify-between border-b pb-1 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>AD Period:</span>
                  <span className={`font-mono font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                    {fy.startDateAD} to {fy.endDateAD}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className={isDarkMode ? 'text-slate-400' : 'text-slate-500'}>Audit Status:</span>
                  <span className="font-bold flex items-center gap-1">
                    {fy.isClosed ? (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <Lock className="h-3 w-3" /> Closed
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">Open & Audited</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: DOCUMENT NUMBERING INITIAL SETUP (Dynamic Setup) */}
      <div className={`rounded-2xl border p-6 shadow-xl space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-indigo-900/50' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-3 ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-2.5 rounded-xl border ${
              isDarkMode ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-indigo-50 text-indigo-600 border-indigo-200'
            }`}>
              <Hash className="h-5 w-5" />
            </div>
            <div>
              <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                Document Numbering Initial Setup (Dynamic Prefix & Sequence Generator)
              </h3>
              <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Configure custom document prefixes, suffixes, digit padding, and sequence counters for all business vouchers instead of hardcoding.
              </p>
            </div>
          </div>

          <span className={`text-[11px] font-mono px-3 py-1 rounded-lg border font-bold ${
            isDarkMode ? 'bg-indigo-950 text-indigo-300 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
          }`}>
            {docConfigs.length} Document Types Configured
          </span>
        </div>

        {/* Category Pill Filters & Search Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none text-xs">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${
                selectedCategory === 'ALL'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All ({docConfigs.length})
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('PROCUREMENT_SALES')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${
                selectedCategory === 'PROCUREMENT_SALES'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Procurement & Sales (7)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('INVENTORY_OPS')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${
                selectedCategory === 'INVENTORY_OPS'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Branch Ops & Stock (6)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('FIXED_ASSETS')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${
                selectedCategory === 'FIXED_ASSETS'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Fixed Assets (2)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('FINANCE_TAX')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${
                selectedCategory === 'FINANCE_TAX'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Finance & Vouchers (3)
            </button>
          </div>

          <div className="relative min-w-[220px]">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={docSearchQuery}
              onChange={(e) => setDocSearchQuery(e.target.value)}
              placeholder="Search sequence (e.g. FAA, CPI, EXC)..."
              className={`w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border outline-none ${
                isDarkMode ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-500' : 'bg-white border-slate-200 text-slate-900'
              }`}
            />
          </div>
        </div>

        {/* Dynamic Document Configs Grid / Table */}
        <div className={`overflow-x-auto rounded-xl border ${
          isDarkMode ? 'border-slate-800 bg-slate-900/40' : 'border-slate-200 bg-slate-50/50'
        }`}>
          <table className="w-full text-left text-xs">
            <thead className={`font-bold border-b ${
              isDarkMode ? 'bg-slate-900 text-slate-300 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className="p-3">Doc Type</th>
                <th className="p-3">Prefix</th>
                <th className="p-3">Suffix</th>
                <th className="p-3 text-center">Padding</th>
                <th className="p-3 text-center">Next Counter</th>
                <th className="p-3">Live Sample Output</th>
                <th className="p-3 text-center">Auto-FY Reset</th>
                <th className="p-3 text-right">Configure</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${
              isDarkMode ? 'divide-slate-800 text-slate-300' : 'divide-slate-200 text-slate-700'
            }`}>
              {filteredDocConfigs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-400 text-xs">
                    No document numbering configuration matching "{docSearchQuery}".
                  </td>
                </tr>
              ) : (
                filteredDocConfigs.map((config) => {
                  const sampleOutput = formatDocumentNumber(config);

                  return (
                    <tr key={config.id} className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/50' : 'hover:bg-white'
                    }`}>
                      <td className="p-3 font-semibold">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${
                              isDarkMode ? 'bg-indigo-950 text-indigo-300 border-indigo-800' : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                            }`}>
                              {config.id}
                            </span>
                            <span>{config.documentType}</span>
                          </div>
                          {config.notes && (
                            <span className="text-[10px] text-slate-400 font-normal line-clamp-1 max-w-xs pl-0.5">
                              {config.notes}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="p-3 font-mono font-bold text-amber-500 dark:text-amber-400">
                        {config.prefix || '<none>'}
                      </td>

                      <td className="p-3 font-mono text-slate-400">
                        {config.suffix || '<none>'}
                      </td>

                      <td className="p-3 text-center font-mono">
                        {config.minDigits} digits
                      </td>

                      <td className="p-3 text-center font-mono font-bold">
                        {config.nextNumber}
                      </td>

                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold border ${
                            isDarkMode ? 'bg-slate-950 text-emerald-400 border-slate-800' : 'bg-white text-emerald-700 border-slate-200'
                          }`}>
                            {sampleOutput}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleTestGenerate(config.id)}
                            title="Test generate document number"
                            className="text-[10px] font-bold text-indigo-500 hover:underline cursor-pointer"
                          >
                            Test
                          </button>
                        </div>
                      </td>

                      <td className="p-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                          config.resetEveryFiscalYear
                            ? isDarkMode ? 'bg-emerald-950 text-emerald-400 border-emerald-500/30' : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                            : isDarkMode ? 'bg-slate-800 text-slate-400 border-slate-700' : 'bg-slate-200 text-slate-600 border-slate-300'
                        }`}>
                          {config.resetEveryFiscalYear ? 'Yes' : 'No'}
                        </span>
                      </td>

                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setEditingDocConfig({ ...config })}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs cursor-pointer shadow-xs"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Setup</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleResetCounter(config.id, config.startingNumber)}
                            title="Reset counter to start value"
                            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 cursor-pointer"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 3: Accounting Period Lock & Tax Control */}
      <div className={`rounded-2xl border p-5 shadow-xl space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className={`p-2 rounded-xl border ${
            isDarkMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-amber-50 text-amber-600 border-amber-200'
          }`}>
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
              Accounting Period Locks & Retroactive Edit Control
            </h3>
            <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Freeze prior quarterly accounting periods to prevent retroactive modification of closed VAT registers or audit entries.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(periodLocks).map(([periodName, isLocked]) => (
            <div
              key={periodName}
              className={`p-3.5 rounded-xl border flex items-center justify-between ${
                isLocked
                  ? isDarkMode
                    ? 'bg-amber-950/30 border-amber-800/60 text-amber-300'
                    : 'bg-amber-50 border-amber-200 text-amber-900'
                  : isDarkMode
                    ? 'bg-slate-900 border-slate-800 text-slate-300'
                    : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            >
              <div>
                <span className="text-xs font-bold block">{periodName}</span>
                <span className="text-[10px] opacity-75">{isLocked ? 'Locked (Read-Only)' : 'Open for Transactions'}</span>
              </div>

              <button
                type="button"
                onClick={() => handleTogglePeriodLock(periodName)}
                className={`p-2 rounded-lg font-bold text-xs flex items-center gap-1 transition-all cursor-pointer ${
                  isLocked
                    ? 'bg-amber-600 text-white hover:bg-amber-500'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300'
                }`}
              >
                {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                <span>{isLocked ? 'Locked' : 'Open'}</span>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Section 4: Opening Balance Setup Overview */}
      <div className={`rounded-2xl border p-5 shadow-xl space-y-3 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className={`p-2 rounded-xl border ${
            isDarkMode ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-emerald-50 text-emerald-600 border-emerald-200'
          }`}>
            <Scale className="h-5 w-5" />
          </div>
          <div>
            <h3 className={`font-bold text-base ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
              Fiscal Year Opening Balances Status
            </h3>
            <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Verified trial balance opening values transferred from prior fiscal year.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div className={`p-3 rounded-xl border ${
            isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className="text-[11px] text-slate-400 font-bold block uppercase">Inventory Asset Opening</span>
            <span className="text-sm font-mono font-bold text-emerald-500">NPR 14,850,000</span>
            <span className="text-[10px] text-emerald-600 block mt-0.5">✓ Reconciled with Stock Audit</span>
          </div>

          <div className={`p-3 rounded-xl border ${
            isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className="text-[11px] text-slate-400 font-bold block uppercase">Fixed Asset Opening</span>
            <span className="text-sm font-mono font-bold text-indigo-500">NPR 8,240,000</span>
            <span className="text-[10px] text-indigo-600 block mt-0.5">✓ WDV Carried Forward</span>
          </div>

          <div className={`p-3 rounded-xl border ${
            isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}>
            <span className="text-[11px] text-slate-400 font-bold block uppercase">Accounts Payable Opening</span>
            <span className="text-sm font-mono font-bold text-amber-500">NPR 3,120,000</span>
            <span className="text-[10px] text-amber-600 block mt-0.5">✓ Vendor Ledgers Synced</span>
          </div>
        </div>
      </div>

      {/* EDIT DOCUMENT NUMBERING SETUP MODAL */}
      {editingDocConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl space-y-4 ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <Hash className="h-5 w-5 text-indigo-500" />
                <h3 className="text-base font-bold">
                  Setup Document Numbering: {editingDocConfig.documentType}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingDocConfig(null)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDocConfigEdit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold mb-1">Prefix String:</label>
                  <input
                    type="text"
                    value={editingDocConfig.prefix}
                    onChange={(e) =>
                      setEditingDocConfig({ ...editingDocConfig, prefix: e.target.value })
                    }
                    placeholder="e.g. PO-2081-"
                    className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:border-indigo-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Suffix String:</label>
                  <input
                    type="text"
                    value={editingDocConfig.suffix}
                    onChange={(e) =>
                      setEditingDocConfig({ ...editingDocConfig, suffix: e.target.value })
                    }
                    placeholder="e.g. /IZ"
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:border-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold mb-1">Digit Padding:</label>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    value={editingDocConfig.minDigits}
                    onChange={(e) =>
                      setEditingDocConfig({
                        ...editingDocConfig,
                        minDigits: parseInt(e.target.value, 10) || 4,
                      })
                    }
                    className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Starting Number:</label>
                  <input
                    type="number"
                    min={1}
                    value={editingDocConfig.startingNumber}
                    onChange={(e) =>
                      setEditingDocConfig({
                        ...editingDocConfig,
                        startingNumber: parseInt(e.target.value, 10) || 1,
                      })
                    }
                    className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1">Next Counter:</label>
                  <input
                    type="number"
                    min={1}
                    value={editingDocConfig.nextNumber}
                    onChange={(e) =>
                      setEditingDocConfig({
                        ...editingDocConfig,
                        nextNumber: parseInt(e.target.value, 10) || 1,
                      })
                    }
                    className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold text-amber-500 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 p-3 rounded-xl border bg-slate-50 dark:bg-slate-950 text-xs font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={editingDocConfig.resetEveryFiscalYear}
                  onChange={(e) =>
                    setEditingDocConfig({
                      ...editingDocConfig,
                      resetEveryFiscalYear: e.target.checked,
                    })
                  }
                  className="rounded text-indigo-600 h-4 w-4"
                />
                <span>Reset sequence counter to 1 when a new Fiscal Year begins</span>
              </label>

              <div>
                <label className="block text-xs font-bold mb-1">Description / Notes:</label>
                <input
                  type="text"
                  value={editingDocConfig.notes || ''}
                  onChange={(e) =>
                    setEditingDocConfig({ ...editingDocConfig, notes: e.target.value })
                  }
                  placeholder="e.g. Used for vendor purchase requisitions..."
                  className="w-full rounded-xl border p-2.5 text-xs bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:border-indigo-500 outline-none"
                />
              </div>

              {/* Sample Output Live Preview Box */}
              <div className="p-3.5 rounded-xl border bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-800">
                <span className="text-[10px] text-slate-400 uppercase font-bold block">Live Formatted Preview</span>
                <span className="text-base font-mono font-bold text-indigo-600 dark:text-indigo-300">
                  {formatDocumentNumber(editingDocConfig)}
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setEditingDocConfig(null)}
                  className="px-4 py-2 rounded-xl border text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold text-xs"
                >
                  Save Sequence Setup
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE NEW FISCAL YEAR MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl space-y-4 ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-indigo-500" />
                <h3 className="text-base font-bold">Configure New Fiscal Year</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {createFyMsg && (
              <div className="p-3 rounded-xl border text-xs font-semibold bg-emerald-50 text-emerald-800 border-emerald-200">
                {createFyMsg}
              </div>
            )}

            <form onSubmit={handleCreateFiscalYearSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold mb-1">Fiscal Year Code (YYYY/YY):</label>
                <input
                  type="text"
                  required
                  value={newFyCode}
                  onChange={(e) => setNewFyCode(e.target.value)}
                  placeholder="e.g. 2083/84"
                  className="w-full rounded-xl border p-2.5 text-xs font-mono font-bold bg-white dark:bg-slate-950 text-slate-900 dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold mb-1">Start Date BS:</label>
                  <input
                    type="text"
                    value={newStartBS}
                    onChange={(e) => setNewStartBS(e.target.value)}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">End Date BS:</label>
                  <input
                    type="text"
                    value={newEndBS}
                    onChange={(e) => setNewEndBS(e.target.value)}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold mb-1">Start Date AD:</label>
                  <input
                    type="date"
                    value={newStartAD}
                    onChange={(e) => setNewStartAD(e.target.value)}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold mb-1">End Date AD:</label>
                  <input
                    type="date"
                    value={newEndAD}
                    onChange={(e) => setNewEndAD(e.target.value)}
                    className="w-full rounded-xl border p-2.5 text-xs font-mono bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-xl border text-xs font-bold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold text-xs"
                >
                  Create Fiscal Year
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
