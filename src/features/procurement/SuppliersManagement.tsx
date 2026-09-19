import React, { useState } from 'react';
import { Supplier, User } from '../../types';
import { Factory, Plus, Search, Mail, Phone, MapPin, CheckCircle2, Edit, Trash2 } from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { isOperationAllowed } from '../../utils/permissions';
import { useDialog } from '../../components/common/DialogProvider';

interface SuppliersManagementProps {
  suppliers: Supplier[];
  currentUser?: User | null;
  onCreateSupplier?: (supplier: Omit<Supplier, 'id' | 'rating'>) => Promise<void>;
  onUpdateSupplier?: (id: string, supplier: Partial<Supplier>) => Promise<void>;
  onDeleteSupplier?: (id: string) => Promise<void>;
}

export const SuppliersManagement: React.FC<SuppliersManagementProps> = ({
  suppliers,
  currentUser,
  onCreateSupplier,
  onUpdateSupplier,
  onDeleteSupplier,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const canManageSuppliers = isOperationAllowed('suppliers-manage', currentUser?.role);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const [name, setName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [panVatNumber, setPanVatNumber] = useState('');

  const filtered = suppliers.filter(
    (s) =>
      (s?.name || '').toLowerCase().includes((search || '').toLowerCase()) ||
      s.panVatNumber.includes(search) ||
      (s?.address || '').toLowerCase().includes((search || '').toLowerCase())
  );

  const suppliersPagination = useClientPagination(filtered, 12, [search]);

  const handleOpenAddModal = () => {
    setEditingSupplier(null);
    setName('');
    setContactPerson('');
    setPhone('');
    setEmail('');
    setAddress('');
    setPanVatNumber('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (s: Supplier) => {
    setEditingSupplier(s);
    setName(s.name);
    setContactPerson(s.contactPerson);
    setPhone(s.phone);
    setEmail(s.email);
    setAddress(s.address);
    setPanVatNumber(s.panVatNumber);
    setIsModalOpen(true);
  };

  const handleDelete = async (s: Supplier) => {
    if (await confirmDialog(`Are you sure you want to delete supplier "${s.name}"?`)) {
      if (onDeleteSupplier) {
        await onDeleteSupplier(s.id);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    if (editingSupplier) {
      if (onUpdateSupplier) {
        await onUpdateSupplier(editingSupplier.id, {
          name,
          contactPerson: contactPerson || 'General Sales',
          phone: phone || '+977-01-0000000',
          email: email || 'sales@supplier.example.com',
          address: address || 'Example City, Nepal',
          panVatNumber: panVatNumber || '300000000',
        });
      }
    } else {
      if (onCreateSupplier) {
        await onCreateSupplier({
          name,
          contactPerson: contactPerson || 'General Sales',
          phone: phone || '+977-01-0000000',
          email: email || 'sales@supplier.example.com',
          address: address || 'Example City, Nepal',
          panVatNumber: panVatNumber || '300000000',
        });
      }
    }

    setName('');
    setContactPerson('');
    setPhone('');
    setEmail('');
    setAddress('');
    setPanVatNumber('');
    setEditingSupplier(null);
    setIsModalOpen(false);
  };

  const cardBg = 'bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-300';

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Factory className={`h-5 w-5 text-indigo-600 dark:text-indigo-400`} />
            <span>Supplier & Vendor Register</span>
          </h2>
          <p className="truncate text-slate-500 text-xs mt-0.5">
            Add, edit, or remove hardware suppliers, PAN/VAT details, contact persons, and ratings.
          </p>
        </div>
        {canManageSuppliers && (
          <button
            onClick={handleOpenAddModal}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs font-bold text-white shadow-xs transition-colors cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Add New Supplier</span>
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
            placeholder="🔍 Search supplier by name or PAN/VAT number..."
            className={`w-full rounded-lg pl-9 pr-4 py-2 text-xs focus:outline-none border border-slate-200 bg-slate-50 text-slate-800 placeholder-slate-400 dark:border dark:border-slate-800 dark:bg-slate-900 dark:text-white dark:placeholder-slate-500`}
          />
        </div>
      </div>

      {/* Grid of Suppliers */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {suppliersPagination.pagedItems.map((s) => (
          <div key={s.id} className={`p-4 rounded-2xl border transition-all ${cardBg}`}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-bold text-sm text-slate-900 dark:text-white">{s.name}</h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 font-semibold mt-1 inline-block">
                  PAN/VAT: {s.panVatNumber}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-amber-500 bg-amber-50 dark:bg-amber-950/80 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-800 mr-1">
                  ⭐ {s.rating || 5.0}
                </span>
                {canManageSuppliers && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleOpenEditModal(s)}
                      title="Edit Supplier"
                      className={`p-1.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:text-indigo-400 dark:hover:bg-indigo-950/60 transition-colors cursor-pointer`}
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(s)}
                      title="Delete Supplier"
                      className={`p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:text-rose-400 dark:hover:bg-rose-950/60 transition-colors cursor-pointer`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-2 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-200">Contact:</span>
                <span>{s.contactPerson}</span>
              </div>
              <div className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 text-indigo-500 flex-shrink-0" />
                <span>{s.phone}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                <span>{s.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-rose-500 flex-shrink-0" />
                <span>{s.address}</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px]">
              <span className={`text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1`}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Verified Vendor
              </span>
              <span className="text-slate-400 font-mono">ID: {s.id}</span>
            </div>
          </div>
        ))}
      </div>
      <TablePagination
        page={suppliersPagination.page}
        pageCount={suppliersPagination.pageCount}
        totalItems={suppliersPagination.totalItems}
        rangeStart={suppliersPagination.rangeStart}
        rangeEnd={suppliersPagination.rangeEnd}
        pageSize={suppliersPagination.pageSize}
        onPageChange={suppliersPagination.setPage}
        onPageSizeChange={suppliersPagination.setPageSize}
        className="mt-1"
      />

      {/* Modal Add/Edit Supplier */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white`}
          >
            <h3 className="text-base font-bold mb-4">
              {editingSupplier ? '✏️ Edit Supplier Details' : '🏭 Register New Supplier'}
            </h3>
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold mb-1">Company / Supplier Name *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Fiber Optics Nepal Pvt. Ltd."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Contact Person</label>
                  <input
                    type="text"
                    value={contactPerson}
                    onChange={(e) => setContactPerson(e.target.value)}
                    placeholder="e.g., Rajesh Hamal"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">PAN / VAT No. *</label>
                  <input
                    type="text"
                    required
                    value={panVatNumber}
                    onChange={(e) => setPanVatNumber(e.target.value)}
                    placeholder="301928374"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Phone</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+977-1-4200000"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="orders@vendor.com.np"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Office / Warehouse Address</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Example Street, Example City"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
                />
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
                  {editingSupplier ? 'Update Supplier' : 'Save Supplier'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
