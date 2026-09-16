import React, { useState } from 'react';
import { Branch, User } from '../../types';
import { Building2, Plus, Search, CheckCircle2, Phone, MapPin, Star, Edit, Trash2 } from 'lucide-react';
import { isOperationAllowed } from '../../utils/permissions';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDialog } from '../../components/common/DialogProvider';

interface BranchesManagementProps {
  branches: Branch[];
  currentUser?: User | null;
  onCreateBranch?: (branch: Omit<Branch, 'id'>) => Promise<void>;
  onUpdateBranch?: (id: string, branch: Partial<Branch>) => Promise<void>;
  onDeleteBranch?: (id: string) => Promise<void>;
}

export const BranchesManagement: React.FC<BranchesManagementProps> = ({
  branches,
  currentUser,
  onCreateBranch,
  onUpdateBranch,
  onDeleteBranch,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const canManageBranches = isOperationAllowed('admin-branches', currentUser?.role);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [location, setLocation] = useState('');
  const [phone, setPhone] = useState('');
  const [isHeadquarters, setIsHeadquarters] = useState(false);
  const [isWarehouse, setIsWarehouse] = useState(false);
  const [allowProcurement, setAllowProcurement] = useState(true);

  const filtered = branches.filter(
    (b) =>
      (b?.name || '').toLowerCase().includes((search || '').toLowerCase()) ||
      (b?.code || '').toLowerCase().includes((search || '').toLowerCase()) ||
      (b?.location || '').toLowerCase().includes((search || '').toLowerCase())
  );

  const branchPagination = useClientPagination(filtered, 12, [search]);

  const handleOpenAddModal = () => {
    setEditingBranch(null);
    setName('');
    setCode('');
    setLocation('');
    setPhone('');
    setIsHeadquarters(false);
    setIsWarehouse(false);
    setAllowProcurement(true);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (b: Branch) => {
    setEditingBranch(b);
    setName(b.name);
    setCode(b.code);
    setLocation(b.location);
    setPhone(b.phone);
    setIsHeadquarters(b.isHeadquarters);
    setIsWarehouse(!!b.isWarehouse || b.code.toUpperCase().startsWith('WH'));
    setAllowProcurement(b.allowProcurement !== false);
    setIsModalOpen(true);
  };

  const handleDelete = async (b: Branch) => {
    if (await confirmDialog(`Are you sure you want to delete branch "${b.name}" (${b.code})?`)) {
      if (onDeleteBranch) {
        await onDeleteBranch(b.id);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !code || !location) return;

    if (editingBranch) {
      if (onUpdateBranch) {
        await onUpdateBranch(editingBranch.id, {
          name,
          code,
          location,
          phone: phone || '+977-1-4200000',
          isHeadquarters,
          isWarehouse,
          allowProcurement,
        });
      }
    } else {
      if (onCreateBranch) {
        await onCreateBranch({
          name,
          code,
          location,
          phone: phone || '+977-1-4200000',
          isHeadquarters,
          isWarehouse,
          active: true,
          allowProcurement,
        });
      }
    }

    setName('');
    setCode('');
    setLocation('');
    setPhone('');
    setIsHeadquarters(false);
    setAllowProcurement(true);
    setEditingBranch(null);
    setIsModalOpen(false);
  };

  const cardBg = 'bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300';

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Building2 className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <span>Branch Directory & Administration</span>
          </h2>
          <p className="truncate text-slate-500 text-xs mt-0.5">
            Add, update, or remove operational branches across Nepal with regional codes and location mapping.
          </p>
        </div>
        {canManageBranches && (
          <button
            onClick={handleOpenAddModal}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add New Branch</span>
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div className={`p-4 rounded-xl border ${cardBg}`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search branch by name, code, or location..."
            className={`w-full rounded-lg pl-9 pr-4 py-2 text-xs focus:outline-none border border-slate-200 bg-slate-50 text-slate-800 placeholder-slate-400 dark:border dark:border-slate-800 dark:bg-slate-900 dark:text-white dark:placeholder-slate-500`}
          />
        </div>
      </div>

      {/* Branches Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {branchPagination.pagedItems.map((b) => (
          <div
            key={b.id}
            className={`p-4 rounded-2xl border transition-all ${cardBg} ${
              b.isHeadquarters ? 'border-indigo-500/50 ring-1 ring-indigo-500/20' : ''
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg">{b.isHeadquarters ? '⭐' : '🏪'}</span>
                <div>
                  <h3 className="font-bold text-sm text-slate-900 dark:text-white">{b.name}</h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-semibold">
                    {b.code}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {b.isHeadquarters && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-700 flex items-center gap-1 mr-1">
                    <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> HQ
                  </span>
                )}
                {canManageBranches && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(b)}
                      title="Edit Branch"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 transition-colors cursor-pointer"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(b)}
                      title="Delete Branch"
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/60 transition-colors cursor-pointer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                <span>{b.location}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                <span>{b.phone}</span>
              </div>
              <div className="pt-1 flex items-center gap-1.5">
                {b.allowProcurement !== false ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                    🛒 Procurement Enabled
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                    🚫 Procurement Disabled
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px]">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Active Branch
              </span>
              <span className="text-slate-400 font-mono">ID: {b.id}</span>
            </div>
          </div>
        ))}
      </div>
      <TablePagination
        page={branchPagination.page}
        pageCount={branchPagination.pageCount}
        totalItems={branchPagination.totalItems}
        rangeStart={branchPagination.rangeStart}
        rangeEnd={branchPagination.rangeEnd}
        pageSize={branchPagination.pageSize}
        onPageChange={branchPagination.setPage}
        onPageSizeChange={branchPagination.setPageSize}
        className="mt-1"
      />

      {/* Modal Add / Edit Branch */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white`}
          >
            <h3 className="text-base font-bold mb-4">
              {editingBranch ? '✏️ Edit Branch Details' : '➕ Add New Branch'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold mb-1">Branch Name *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Branch 1 (Head Office)"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Branch Code *</label>
                  <input
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="e.g., PKR-02"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Phone</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+977-61-530122"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Location / Address *</label>
                <input
                  type="text"
                  required
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Example Street, Example City"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="hq-check"
                    checked={isHeadquarters}
                    onChange={(e) => setIsHeadquarters(e.target.checked)}
                    className="h-4 w-4 rounded text-indigo-600 cursor-pointer"
                  />
                  <label htmlFor="hq-check" className="font-semibold cursor-pointer">
                    Mark as Central Warehouse / Headquarters (HQ)
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="wh-check"
                    checked={isWarehouse}
                    onChange={(e) => setIsWarehouse(e.target.checked)}
                    className="h-4 w-4 rounded text-indigo-600 cursor-pointer"
                  />
                  <label htmlFor="wh-check" className="font-semibold cursor-pointer">
                    Mark as Regional Warehouse / Distribution Facility
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="procurement-check"
                    checked={allowProcurement}
                    onChange={(e) => setAllowProcurement(e.target.checked)}
                    className="h-4 w-4 rounded text-indigo-600 cursor-pointer"
                  />
                  <label htmlFor="procurement-check" className="font-semibold cursor-pointer">
                    Enable Procurement & Purchasing Permission
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold cursor-pointer"
                >
                  {editingBranch ? 'Update Branch' : 'Save Branch'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
