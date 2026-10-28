import React, { useEffect, useState } from 'react';
import { Layers, Plus, Edit2, Trash2, X, ShieldCheck } from 'lucide-react';
import { useActivationKey } from '../../components/common/KeepMounted';
import { Product, ProductGroup, ProductGroupBehavior, User } from '../../types';
import { isOperationAllowed } from '../../utils/permissions';
import { api } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadStateNotice } from '../../components/common/LoadStateNotice';
import {
  PRODUCT_GROUP_BEHAVIORS,
  PRODUCT_GROUP_BEHAVIOR_LABELS,
  productGroupBadgeClass,
  productGroupBadgeIcon,
  setProductGroups as setBehaviorCache,
} from '../../utils/productGroupBehavior';

interface ProductGroupManagementProps {
  currentUser?: User | null;
  /** Catalog rows, used for live product counts (the server also returns one). */
  products?: Product[];
}

/**
 * Product group master data.
 *
 * Operators name their own groups ("Product Item", "Vehicles", "Network
 * Equipment", ...) and pick ONE fixed behaviour per group. Behaviour is what
 * sales eligibility, consumable issuing and depreciation key off, so a rename
 * or a new group never needs a code change — and never silently changes what a
 * product does.
 *
 * Deleting is deliberately narrow: a built-in group cannot be deleted, and a
 * group any product still uses answers 409 with a "move them first / retire it"
 * message (the server enforces the same rule through the products foreign key).
 */
export const ProductGroupManagement: React.FC<ProductGroupManagementProps> = ({
  currentUser,
  products = [],
}) => {
  const { confirm: confirmDialog, alert: alertDialog } = useDialog();
  const canEdit = isOperationAllowed('product-group-manage', currentUser?.role);

  const [groups, setGroups] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // A failed read must not render as "no groups configured" (DF-11).
  const [loadError, setLoadError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ProductGroup | null>(null);

  const [name, setName] = useState('');
  const [behavior, setBehavior] = useState<ProductGroupBehavior>('STOCK_ITEM');
  const [active, setActive] = useState(true);

  const loadGroups = async () => {
    setLoading(true);
    try {
      const data = await api.getProductGroups();
      const rows = Array.isArray(data) ? data : [];
      setGroups(rows);
      // Keep every screen's behaviour lookup in step with the table (sales
      // filters, asset pickers and the depreciation block close over this).
      setBehaviorCache(rows);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'The product group list could not be read.');
    } finally {
      setLoading(false);
    }
  };

  // Refetch on every tab re-activation (keep-mounted replacement for remounts).
  const activationKey = useActivationKey('product-group-management');

  useEffect(() => {
    loadGroups();
  }, [activationKey]);

  const countFor = (group: ProductGroup) => {
    if (typeof group.productCount === 'number') return group.productCount;
    return products.filter((p) => (p.productGroup || '') === group.name).length;
  };

  const filteredGroups = groups.filter((group) => {
    const needle = searchQuery.toLowerCase().trim();
    if (!needle) return true;
    return (
      (group.name || '').toLowerCase().includes(needle) ||
      (group.code || '').toLowerCase().includes(needle) ||
      PRODUCT_GROUP_BEHAVIOR_LABELS[group.behavior].toLowerCase().includes(needle)
    );
  });

  const openCreateModal = () => {
    setEditingGroup(null);
    setName('');
    setBehavior('STOCK_ITEM');
    setActive(true);
    setIsModalOpen(true);
  };

  const openEditModal = (group: ProductGroup) => {
    setEditingGroup(group);
    setName(group.name);
    setBehavior(group.behavior);
    setActive(group.active);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;

    try {
      if (editingGroup) {
        await api.updateProductGroup(editingGroup.id, { name: cleanName, behavior, active });
      } else {
        await api.createProductGroup({ name: cleanName, behavior, active });
      }
      setIsModalOpen(false);
      await loadGroups();
    } catch (err: any) {
      alertDialog(`Failed to save product group: ${err?.message || 'Database error'}`);
    }
  };

  const handleDelete = async (group: ProductGroup) => {
    if (group.isSystem) {
      alertDialog(
        `'${group.name}' is a built-in group and cannot be deleted. Turn its Active switch off to retire it instead — existing products keep working.`
      );
      return;
    }
    if (
      !(await confirmDialog(
        `Delete the product group '${group.name}'? Groups still assigned to products cannot be deleted — retire them instead.`
      ))
    ) {
      return;
    }
    try {
      await api.deleteProductGroup(group.id);
      await loadGroups();
    } catch (err: any) {
      alertDialog(`Failed to delete product group: ${err?.message || 'Database error'}`);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      <PageHeader
        title="Product Group Management"
        description={
          loadError && groups.length === 0
            ? 'Product group list unavailable — retry below'
            : `${groups.length} groups · each maps to one fixed behaviour that drives sales, consumable issuing and depreciation`
        }
        icon={<Layers className="h-5 w-5 text-indigo-500" />}
        actions={
          canEdit ? (
            <button
              onClick={openCreateModal}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>Add Product Group</span>
            </button>
          ) : null
        }
      />

      <FilterCard
        searchPlaceholder="Search Group Name, Code or Behaviour..."
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={Boolean(searchQuery)}
        onClearAll={() => setSearchQuery('')}
      />

      <LoadStateNotice
        subject="product groups"
        loading={loading}
        error={loadError}
        hasCachedRows={groups.length > 0}
        onRetry={loadGroups}
      />

      <div className="flex-1 min-h-0 flex flex-col rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800">
        <div className="flex-1 min-h-0 overflow-auto relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-2xs bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800">
              <tr>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Group Code</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Group Name</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Behaviour</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Products</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Status</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredGroups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    {loading
                      ? 'Loading product groups…'
                      : loadError
                        ? 'The product group list could not be loaded — use Retry above.'
                        : groups.length === 0
                          ? 'No product groups are configured. Add one to start classifying products.'
                          : 'No product groups match this search.'}
                  </td>
                </tr>
              ) : (
                filteredGroups.map((group) => (
                  <tr key={group.id} className="transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className="px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      <div className="flex items-center gap-1.5">
                        <span>{group.code}</span>
                        {group.isSystem ? (
                          <span title="Built-in group — can be renamed or retired, not deleted">
                            <ShieldCheck className="h-3 w-3 text-slate-400" />
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                      <div className="flex items-center gap-1.5">
                        <Layers className="h-3.5 w-3.5 text-indigo-500" />
                        <span>{group.name}</span>
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${productGroupBadgeClass(group.behavior)}`}
                      >
                        {productGroupBadgeIcon(group.behavior)}{' '}
                        {group.behavior === 'STOCK_ITEM'
                          ? 'Stock item'
                          : group.behavior === 'CONSUMABLE'
                            ? 'Consumable'
                            : 'Fixed asset'}
                      </span>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        {PRODUCT_GROUP_BEHAVIOR_LABELS[group.behavior]}
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-center font-mono">
                      <span className="inline-flex items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.2 text-[10px] text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-800">
                        {countFor(group)} Products
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.2 text-[10px] font-bold border ${
                          group.active
                            ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30'
                            : 'bg-slate-100 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-slate-700'
                        }`}
                      >
                        {group.active ? 'Active' : 'Retired'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-center">
                      {canEdit ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEditModal(group)}
                            title="Edit product group"
                            className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-200 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded transition-colors cursor-pointer"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => { void handleDelete(group); }}
                            title={group.isSystem ? 'Built-in group — retire it instead of deleting' : 'Delete product group'}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/30 rounded transition-colors cursor-pointer"
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

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-700 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300">
            <div className="flex items-center justify-between border-b p-4 border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50">
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                {editingGroup ? 'Edit Product Group' : 'Create Product Group'}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Group Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Network Equipment, Vehicles, Raw Material"
                  className="w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                />
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Free text. Renaming is safe: every product in the group follows the new name.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Behaviour</label>
                <select
                  value={behavior}
                  onChange={(e) => setBehavior(e.target.value as ProductGroupBehavior)}
                  className="w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 cursor-pointer border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  {PRODUCT_GROUP_BEHAVIORS.map((value) => (
                    <option key={value} value={value}>
                      {value === 'STOCK_ITEM'
                        ? 'Stock item (sellable)'
                        : value === 'CONSUMABLE'
                          ? 'Consumable (issued to jobs)'
                          : 'Fixed asset (depreciated)'}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-400 mt-1">
                  {PRODUCT_GROUP_BEHAVIOR_LABELS[behavior]}
                </p>
                {editingGroup && editingGroup.behavior !== behavior && countFor(editingGroup) > 0 ? (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                    This group already holds {countFor(editingGroup)} product(s) — changing the behaviour
                    changes how all of them are treated.
                  </p>
                ) : null}
              </div>

              {editingGroup ? (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      Active
                    </label>
                    <p className="text-[10px] text-slate-400 mt-0.5">
                      Retired groups stay on existing products but are not offered for new ones.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActive(!active)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer shrink-0 ml-3 ${
                      active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                        active ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              ) : null}

              <div className="pt-3 border-t flex items-center justify-end gap-2 border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Save Product Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
