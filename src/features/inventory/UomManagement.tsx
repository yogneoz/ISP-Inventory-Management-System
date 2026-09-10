import React, { useState, useEffect } from 'react';
import { UnitOfMeasure, User } from '../../types';
import { Ruler, Plus, Edit2, Trash2, Search, X, CheckCircle2, Layers } from 'lucide-react';
import { isOperationAllowed } from '../../utils/permissions';
import { api } from '../../services/api';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface UomManagementProps {
  currentUser?: User | null;
}

export const UomManagement: React.FC<UomManagementProps> = ({ currentUser }) => {
  const { isDarkMode } = useDarkMode();
  const canManageUom = isOperationAllowed('uom-manage', currentUser?.role);
  const [uoms, setUoms] = useState<UnitOfMeasure[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUom, setEditingUom] = useState<UnitOfMeasure | null>(null);

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [type, setType] = useState<UnitOfMeasure['type']>('Count');
  const [isBaseUnit, setIsBaseUnit] = useState(false);

  const loadUoms = async () => {
    try {
      setLoading(true);
      const data = await api.getUoms();
      setUoms(data || []);
    } catch (err) {
      console.error('Failed to load UOMs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUoms();
  }, []);

  const filteredUoms = uoms.filter(
    (u) =>
      (u?.name || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (u?.symbol || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (u?.type || '').toLowerCase().includes((searchQuery || '').toLowerCase())
  );

  const openCreateModal = () => {
    setEditingUom(null);
    setName('');
    setSymbol('');
    setType('Count');
    setIsBaseUnit(false);
    setIsModalOpen(true);
  };

  const openEditModal = (u: UnitOfMeasure) => {
    setEditingUom(u);
    setName(u.name);
    setSymbol(u.symbol);
    setType(u.type);
    setIsBaseUnit(!!u.isBaseUnit);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !symbol.trim()) return;

    try {
      if (editingUom) {
        await api.updateUom(editingUom.id, { name, symbol, type, isBaseUnit });
      } else {
        await api.createUom({ name, symbol, type, isBaseUnit });
      }
      setIsModalOpen(false);
      await loadUoms();
    } catch (err) {
      console.error('Failed to save UOM:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this Unit of Measure?')) {
      try {
        await api.deleteUom(id);
        await loadUoms();
      } catch (err) {
        console.error('Failed to delete UOM:', err);
      }
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      {/* Header */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Ruler className="h-5 w-5 text-indigo-500" />
            <span>Unit of Measure (UoM) Management</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Define and standardise quantitative measurement units for inventory tracking.
          </p>
        </div>

        {canManageUom && (
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add New UoM</span>
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-none">
        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Defined Units</span>
          <div className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400">{uoms.length} UoMs</div>
        </div>

        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Base Counting Unit</span>
          <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">Pcs & Mtr</div>
        </div>

        <div className={`p-2.5 rounded-xl border bg-white border-slate-200 shadow-2xs dark:bg-[#0f1218] dark:border-slate-800`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Measurement Types</span>
          <div className="text-xs font-bold text-slate-800 dark:text-slate-200">Count, Length, Package, Weight</div>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`p-2 rounded-xl border shadow-2xs flex items-center justify-between gap-2 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Unit Name, Symbol, or Type..."
            className={`w-full rounded-lg border pl-8 pr-2.5 py-1 text-xs focus:outline-none focus:border-indigo-500 bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200 dark:placeholder-slate-500`}
          />
        </div>
      </div>

      {/* Table */}
      <div className={`flex-1 min-h-0 flex flex-col rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
        <div className="flex-1 min-h-0 overflow-auto relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-2xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
              <tr>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">UoM Symbol</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Unit Full Name</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Dimension Category</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Standard Base Unit</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
              {filteredUoms.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    No Unit of Measure entries found.
                  </td>
                </tr>
              ) : (
                filteredUoms.map((u) => (
                  <tr key={u.id} className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40`}>
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {u.symbol}
                    </td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      {u.name}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800`}>
                        {u.type}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-center font-mono">
                      {u.isBaseUnit ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/80 px-2 py-0.2 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold border border-emerald-300 dark:border-emerald-800">
                          <CheckCircle2 className="h-3 w-3" />
                          Base Unit
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[10px]">Derived Unit</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      {canManageUom ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEditModal(u)}
                            title="Edit UoM"
                            className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDelete(u.id)}
                            title="Delete UoM"
                            className="p-1.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded transition-colors cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic">Read Only</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-700 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300`}>
            <div className={`flex items-center justify-between border-b p-4 border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50`}>
              <h3 className={`font-bold text-sm text-slate-900 dark:text-white`}>
                {editingUom ? 'Edit Unit of Measure' : 'Create Unit of Measure'}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">Unit Symbol / Code</label>
                  <input
                    type="text"
                    required
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    placeholder="e.g. Pcs"
                    className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 opacity-80">Dimension Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as any)}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                  >
                    <option value="Count">Count / Quantity</option>
                    <option value="Length">Length / Distance</option>
                    <option value="Weight">Weight / Mass</option>
                    <option value="Volume">Volume / Liquid</option>
                    <option value="Package">Package / Bundle</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Full Unit Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Pieces, Meters, Box"
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="uom-base-check"
                  checked={isBaseUnit}
                  onChange={(e) => setIsBaseUnit(e.target.checked)}
                  className="rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <label htmlFor="uom-base-check" className="text-xs cursor-pointer select-none">
                  Set as System Standard Base Unit
                </label>
              </div>

              <div className={`pt-3 border-t flex items-center justify-end gap-2 border-slate-200 dark:border-slate-800`}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Save UoM
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
