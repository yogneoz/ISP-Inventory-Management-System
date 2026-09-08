import React, { useState, useEffect } from 'react';
import { Category, Product, User } from '../../types';
import { Grid, Plus, Edit2, Trash2, Tag, Search, X, Layers, CheckCircle2 } from 'lucide-react';
import { isOperationAllowed } from '../../utils/permissions';
import { api } from '../../services/api';

interface CategoryManagementProps {
  products: Product[];
  currentUser?: User | null;
  isDarkMode?: boolean;
}

export const CategoryManagement: React.FC<CategoryManagementProps> = ({
  products,
  currentUser,
  isDarkMode = false,
}) => {
  const canEdit = isOperationAllowed('prod-edit', currentUser?.role);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<Category | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');

  const loadCategoriesFromDb = async () => {
    try {
      const data = await api.getCategories();
      if (Array.isArray(data)) {
        setCategories(data);
      }
    } catch (err) {
      console.warn('Could not load categories from database:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCategoriesFromDb();
  }, []);

  // Calculate live product counts per category
  const getProductCountForCategory = (catName: string) => {
    return products.filter((p) => (p?.category || '').toLowerCase().trim() === catName.toLowerCase().trim()).length;
  };

  const filteredCategories = categories.filter(
    (c) =>
      (c?.name || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (c?.code || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (c.description && (c?.description || '').toLowerCase().includes((searchQuery || '').toLowerCase()))
  );

  const openCreateModal = () => {
    setEditingCat(null);
    setName('');
    setCode(`CAT-${Math.floor(100 + Math.random() * 900)}`);
    setDescription('');
    setIsModalOpen(true);
  };

  const openEditModal = (c: Category) => {
    setEditingCat(c);
    setName(c.name);
    setCode(c.code);
    setDescription(c.description || '');
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      if (editingCat) {
        const updated = await api.updateCategory(editingCat.id, { name, code, description });
        setCategories(categories.map((c) => (c.id === editingCat.id ? updated : c)));
      } else {
        const created = await api.createCategory({
          id: `cat-${Date.now()}`,
          code,
          name,
          description,
        });
        setCategories([...categories, created]);
      }
      setIsModalOpen(false);
    } catch (err: any) {
      alert(`Failed to save category: ${err?.message || 'Database error'}`);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this category?')) {
      try {
        await api.deleteCategory(id);
        setCategories(categories.filter((c) => c.id !== id));
      } catch (err: any) {
        alert(`Failed to delete category: ${err?.message || 'Database error'}`);
      }
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      {/* Header */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <Grid className="h-5 w-5 text-indigo-500" />
            <span>Category Management</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Organize inventory items and fixed assets into distinct classification categories.
          </p>
        </div>

        {canEdit && (
          <button
            onClick={openCreateModal}
            className="flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add Category</span>
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-none">
        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
        }`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Total Categories</span>
          <div className={`text-xl font-bold font-mono ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>{categories.length}</div>
        </div>

        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
        }`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Categorized Catalog SKUs</span>
          <div className={`text-xl font-bold font-mono ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>{products.length} Items</div>
        </div>

        <div className={`p-2.5 rounded-xl border ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200 shadow-2xs'
        }`}>
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 block mb-0.5">Primary Asset Group</span>
          <div className="text-xs font-bold text-slate-800 dark:text-slate-200">Fixed Assets & Fiber Gear</div>
        </div>
      </div>

      {/* Filter bar */}
      <div className={`p-2 rounded-xl border shadow-2xs flex items-center justify-between gap-2 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search Category Name, Code, or Description..."
            className={`w-full rounded-lg border pl-8 pr-2.5 py-1 text-xs focus:outline-none focus:border-indigo-500 ${
              isDarkMode
                ? 'bg-slate-900 border-slate-800 text-slate-200 placeholder-slate-500'
                : 'bg-slate-50 border-slate-200 text-slate-800 placeholder-slate-400'
            }`}
          />
        </div>
      </div>

      {/* Categories Table */}
      <div className={`flex-1 min-h-0 flex flex-col rounded-xl border shadow-md overflow-hidden ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="flex-1 min-h-0 overflow-auto relative">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-2xs ${
              isDarkMode ? 'bg-[#12161f] text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Category Code</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Category Name</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Description</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Associated SKUs</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit text-center">Actions</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
              {filteredCategories.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-500">
                    No categories found matching your filter criteria.
                  </td>
                </tr>
              ) : (
                filteredCategories.map((c) => {
                  const count = getProductCountForCategory(c.name);
                  return (
                    <tr key={c.id} className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'
                    }`}>
                      <td className={`px-2.5 py-1.5 font-mono font-bold ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                        {c.code}
                      </td>
                      <td className="px-2.5 py-1.5 font-bold text-slate-900 dark:text-white">
                        <div className="flex items-center gap-1.5">
                          <Tag className="h-3.5 w-3.5 text-indigo-500" />
                          <span>{c.name}</span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-slate-500 dark:text-slate-400">
                        {c.description || '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-center font-mono">
                        <span className="inline-flex items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/80 px-2 py-0.2 text-[10px] text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-800">
                          {count} Products
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        {canEdit ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => openEditModal(c)}
                              title="Edit Category"
                              className={`p-1.5 text-slate-400 ${isDarkMode ? 'hover:text-indigo-400 hover:bg-slate-800' : 'hover:text-indigo-600 hover:bg-slate-100'} rounded transition-colors cursor-pointer`}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(c.id)}
                              title="Delete Category"
                              className={`p-1.5 text-slate-400 ${isDarkMode ? 'hover:text-rose-400 hover:bg-rose-950/30' : 'hover:text-rose-600 hover:bg-rose-50'} rounded transition-colors cursor-pointer`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">Read Only</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border overflow-hidden ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
          }`}>
            <div className={`flex items-center justify-between border-b p-4 ${
              isDarkMode ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
            }`}>
              <h3 className={`font-bold text-sm ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                {editingCat ? 'Edit Category' : 'Create Category'}
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
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Category Code</label>
                <input
                  type="text"
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-indigo-500 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                  }`}
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Category Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Routers & ONTs"
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                  }`}
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold mb-1 opacity-80">Description</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Category specification / usage notes..."
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500 ${
                    isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-900'
                  }`}
                />
              </div>

              <div className={`pt-3 border-t flex items-center justify-end gap-2 ${
                isDarkMode ? 'border-slate-800' : 'border-slate-200'
              }`}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    isDarkMode
                      ? 'border-slate-700 text-slate-400 hover:bg-slate-800'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Save Category
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
