import React, { useState, useEffect } from 'react';
import { DocumentNumberConfig } from '../../types';
import { api } from '../../services/api';
import {
  getDocumentNumberConfigs,
  saveDocumentNumberConfigs,
  formatDocumentNumber,
  generateNextDocumentNumber,
  resetDocumentSequence,
} from '../../utils/documentNumbering';
import {
  Hash,
  CheckCircle2,
  Edit3,
  X,
  RotateCcw,
  Search,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

type DocCategory = 'ALL' | 'PROCUREMENT_SALES' | 'INVENTORY_OPS' | 'FIXED_ASSETS' | 'FINANCE_TAX';

const getDocCategory = (id: string): DocCategory => {
  if (['PO', 'PI', 'GRN', 'DN', 'INV', 'QUO', 'CN'].includes(id)) return 'PROCUREMENT_SALES';
  if (['ST', 'SA', 'DC', 'CPI', 'EXC', 'WC'].includes(id)) return 'INVENTORY_OPS';
  if (['FAA', 'FAR'].includes(id)) return 'FIXED_ASSETS';
  if (['JV', 'PV', 'RV', 'CP', 'CR', 'BP', 'BR'].includes(id)) return 'FINANCE_TAX';
  return 'ALL';
};

/**
 * Document Numbering Setup — the single place to configure dynamic document
 * prefix / suffix / padding / sequence counters for all business vouchers.
 *
 * Fiscal-year accounting periods (active / closed / reopen) are managed in the
 * Fiscal Year Closing Wizard, so this page stays focused on voucher numbering.
 */
export const FiscalYearManagement: React.FC = () => {
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
            localStorage.setItem('inventory_document_number_configs', JSON.stringify(configs));
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

  const docConfigsPagination = useClientPagination(filteredDocConfigs, 15, [selectedCategory, docSearchQuery]);

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

  return (
    <div className="space-y-3">
      {/* Page Title Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Hash className="h-5 w-5 text-indigo-500" />
            <span>Document Numbering Setup</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Configure dynamic document prefixes, suffixes, digit padding, and sequence counters for all business vouchers.
          </p>
        </div>
      </div>

      {/* Success Notification Banner */}
      {saveSuccessMsg && (
        <div className={`p-4 rounded-2xl border text-xs font-semibold flex items-center gap-2 shadow-sm bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/80 dark:border-emerald-500/40 dark:text-emerald-300`}>
          <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />
          <span>{saveSuccessMsg}</span>
        </div>
      )}

      {/* Section 2: DOCUMENT NUMBERING INITIAL SETUP (Dynamic Setup) */}
      <div className={`rounded-2xl border p-6 shadow-xl space-y-4 bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-indigo-900/50`}>
        <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-3 border-b pb-3 border-slate-200 dark:border-slate-800`}>
          <div className="flex items-center gap-2.5">
            <div className={`p-2.5 rounded-xl border bg-indigo-50 text-indigo-600 border-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20`}>
              <Hash className="h-5 w-5" />
            </div>
            <div>
              <h3 className={`font-bold text-base text-slate-900 dark:text-white`}>
                Document Numbering Initial Setup (Dynamic Prefix & Sequence Generator)
              </h3>
              <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                Configure custom document prefixes, suffixes, digit padding, and sequence counters for all business vouchers instead of hardcoding.
              </p>
            </div>
          </div>

          <span className={`text-[11px] font-mono px-3 py-1 rounded-lg border font-bold bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800`}>
            {docConfigs.length} Document Types Configured
          </span>
        </div>

        {/* Category Pill Filters & Search Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none text-xs">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${selectedCategory === 'ALL' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              All ({docConfigs.length})
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('PROCUREMENT_SALES')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${selectedCategory === 'PROCUREMENT_SALES' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              Procurement & Sales (7)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('INVENTORY_OPS')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${selectedCategory === 'INVENTORY_OPS' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              Branch Ops & Stock (6)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('FIXED_ASSETS')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${selectedCategory === 'FIXED_ASSETS' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              Fixed Assets (2)
            </button>
            <button
              type="button"
              onClick={() => setSelectedCategory('FINANCE_TAX')}
              className={`px-3 py-1.5 rounded-xl font-bold cursor-pointer transition-colors whitespace-nowrap ${selectedCategory === 'FINANCE_TAX' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              Finance & Vouchers (3)
            </button>
          </div>

 <div className="relative w-full md:w-80 lg:w-96 shrink-0 min-w-[220px]">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={docSearchQuery}
              onChange={(e) => setDocSearchQuery(e.target.value)}
              placeholder="Search sequence (e.g. FAA, CPI, EXC)..."
              className={`w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border outline-none bg-white border-slate-200 text-slate-900 dark:bg-slate-950 dark:border-slate-800 dark:text-white dark:placeholder-slate-500`}
            />
          </div>
        </div>

        {/* Dynamic Document Configs Grid / Table */}
        <div className={`overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40`}>
          <table className="w-full text-left text-xs">
            <thead className={`font-bold border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
              <tr>
                <th className="px-2.5 py-1.5">Doc Type</th>
                <th className="px-2.5 py-1.5">Prefix</th>
                <th className="px-2.5 py-1.5">Suffix</th>
                <th className="px-2.5 py-1.5 text-center">Padding</th>
                <th className="px-2.5 py-1.5 text-center">Next Counter</th>
                <th className="px-2.5 py-1.5">Live Sample Output</th>
                <th className="px-2.5 py-1.5 text-center">Auto-FY Reset</th>
                <th className="px-2.5 py-1.5 text-right">Configure</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 text-slate-700 dark:divide-slate-800 dark:text-slate-300`}>
              {filteredDocConfigs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-400 text-xs">
                    No document numbering configuration matching "{docSearchQuery}".
                  </td>
                </tr>
              ) : (
                docConfigsPagination.pagedItems.map((config) => {
                  const sampleOutput = formatDocumentNumber(config);

                  return (
                    <tr key={config.id} className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50`}>
                      <td className="p-2.5 font-semibold">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800`}>
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

                      <td className="p-2.5 font-mono font-bold text-amber-500 dark:text-amber-400">
                        {config.prefix || '<none>'}
                      </td>

                      <td className="p-2.5 font-mono text-slate-400">
                        {config.suffix || '<none>'}
                      </td>

                      <td className="p-2.5 text-center font-mono">
                        {config.minDigits} digits
                      </td>

                      <td className="p-2.5 text-center font-mono font-bold">
                        {config.nextNumber}
                      </td>

                      <td className="p-2.5">
                        <div className="flex items-center gap-2">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold border bg-white text-emerald-700 border-slate-200 dark:bg-slate-950 dark:text-emerald-400 dark:border-slate-800`}>
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

                      <td className="p-2.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${config.resetEveryFiscalYear ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-500/30' : 'bg-slate-200 text-slate-600 border-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
                          {config.resetEveryFiscalYear ? 'Yes' : 'No'}
                        </span>
                      </td>

                      <td className="p-2.5 text-right">
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
        <TablePagination
          page={docConfigsPagination.page}
          pageCount={docConfigsPagination.pageCount}
          totalItems={docConfigsPagination.totalItems}
          rangeStart={docConfigsPagination.rangeStart}
          rangeEnd={docConfigsPagination.rangeEnd}
          pageSize={docConfigsPagination.pageSize}
          onPageChange={docConfigsPagination.setPage}
          onPageSizeChange={docConfigsPagination.setPageSize}
          className="mt-1"
        />
      </div>

      {/* EDIT DOCUMENT NUMBERING SETUP MODAL */}
      {editingDocConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl space-y-4 bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}>
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
                    placeholder="e.g. /INV"
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
                  className={`rounded text-indigo-600 dark:text-indigo-400 h-4 w-4`}
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
                <span className={`text-base font-mono font-bold text-indigo-600 dark:text-indigo-300`}>
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
    </div>
  );
};
