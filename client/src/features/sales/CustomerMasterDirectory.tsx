import React, { useCallback, useEffect, useRef, useState } from 'react';

import { CustomerRecord, CustomerDeviceRecord, Branch, User } from '../../types';
import { formatNPR } from '../../utils/nprFormat';
import { exportToCSV } from '../../utils/exportUtils';
import { api } from '../../services/api';
import {
  Users,
  Plus,
  Upload,
  Edit2,
  Trash2,
  X,
  UserCheck,
  Building2,
  Phone,
  Mail,
  MapPin,
  CheckCircle2,
  XCircle,
  FileSpreadsheet,
  ChevronDown,
  ChevronUp,
  Smartphone,
  Wifi,
  ExternalLink,
  Copy,
  Check,
  AlertTriangle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { TablePagination } from '../../components/common/TablePagination';
import { useDialog } from '../../components/common/DialogProvider';
import { FilterCard } from '../../components/common/FilterCard';
import StatCard from '../../components/common/StatCard';

interface CustomerMasterDirectoryProps {
  branches: Branch[];
  currentUser?: User | null;
  onNavigateToImport: () => void;
  onSelectTab?: (tab: string, searchQuery?: string) => void;
  /**
   * Notified after a customer create/update/delete so App can refresh its own
   * bootstrap slices (the Sell-to-Customer picker, dashboards). This screen
   * owns its CRUD and its own paged rows; without this callback the rest of
   * the app kept serving the pre-mutation customer list.
   */
  onCustomersChanged?: () => void;
  refreshKey?: number;
  sseRefreshKey?: number;
}

export const CustomerMasterDirectory: React.FC<CustomerMasterDirectoryProps> = ({
  branches,
  currentUser,
  onNavigateToImport,
  onSelectTab,
  onCustomersChanged,
  refreshKey,
  sseRefreshKey = refreshKey ?? 0,
}) => {
  const { alert: alertDialog } = useDialog();
  // Check permission: Only Super Admin and Inventory Manager can Edit / Delete master customer records
  const canManageMaster =
    currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';

  // Branch Managers and Frontdesk can also Add new customer records
  const canAddCustomer =
    !currentUser ||
    currentUser.role === 'SUPER_ADMIN' ||
    currentUser.role === 'INVENTORY_MANAGER' ||
    currentUser.role === 'BRANCH_MANAGER' ||
    currentUser.role === 'FRONT_DESK';

  // Export / Import restricted from Branch Manager and Frontdesk
  const canExportImport =
    currentUser?.role === 'SUPER_ADMIN' ||
    currentUser?.role === 'INVENTORY_MANAGER' ||
    currentUser?.role === 'ACCOUNTANT';

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBranchFilter, setSelectedBranchFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');

  // Expanded customer rows state to show assigned device serials
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Modal States
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerRecord | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<CustomerRecord | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form Field States
  const userDefaultBranch = (currentUser?.branchId && currentUser.branchId !== 'ALL')
    ? currentUser.branchId
    : (branches[0]?.id || 'WH001');

  const [formData, setFormData] = useState({
    customerName: '',
    username: '',
    contactNumber: '',
    branchId: userDefaultBranch,
    address: '',
    email: '',
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
    creditLimit: 0,
  });

  const resetForm = () => {
    setFormData({
      customerName: '',
      username: '',
      contactNumber: '',
      branchId: (currentUser?.branchId && currentUser.branchId !== 'ALL') ? currentUser.branchId : (branches[0]?.id || 'WH001'),
      address: '',
      email: '',
      status: 'ACTIVE',
      creditLimit: 0,
    });
  };

  const handleOpenAddModal = () => {
    resetForm();
    setIsAddModalOpen(true);
  };

  const handleOpenEditModal = (customer: CustomerRecord) => {
    setEditingCustomer(customer);
    setFormData({
      customerName: customer.customerName,
      username: customer.username,
      contactNumber: customer.contactNumber,
      branchId: customer.branchId,
      address: customer.address || '',
      email: customer.email || '',
      status: customer.status || 'ACTIVE',
      creditLimit: customer.creditLimit || 0,
    });
  };

  // Server-side create: never fabricate a client-side CUS-<random> key. The
  // server POST /api/customers issues the id/customerId, so this payload carries
  // only the user-supplied fields and the register re-reads the authoritative
  // DB-issued row.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.customerName.trim() || !formData.contactNumber.trim() || !formData.username.trim()) {
      alertDialog('Please fill in Customer Name, Username, and Primary Mobile Number.');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await api.createCustomer({
        customerId: formData.customerName,
        customerName: formData.customerName,
        username: formData.username,
        contactNumber: formData.contactNumber,
        branchId: formData.branchId,
        address: formData.address,
        email: formData.email,
        status: formData.status,
        creditLimit: Number(formData.creditLimit) || 0,
      });
      if (created) {
        setIsAddModalOpen(false);
        setEditingCustomer(null);
        resetForm();
        await refreshCustomersFromDb();
      }
    } catch (err: any) {
      alertDialog(`Save Failed: ${err.message || 'Error creating customer record'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Server-side update: PUT /api/customers/:id matches by id or customer_id.
  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.customerName.trim() || !formData.contactNumber.trim() || !formData.username.trim()) {
      alertDialog('Please fill in Customer Name, Username, and Primary Mobile Number.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (editingCustomer) {
        const updated = await api.updateCustomer(editingCustomer.id, {
          customerName: formData.customerName,
          username: formData.username,
          contactNumber: formData.contactNumber,
          branchId: formData.branchId,
          address: formData.address,
          email: formData.email,
          status: formData.status,
          creditLimit: Number(formData.creditLimit) || 0,
        });
        setEditingCustomer(null);
        if (updated) {
          await refreshCustomersFromDb();
        }
      } else {
        await handleSubmit(e);
      }
    } catch (err: any) {
      alertDialog(`Save Failed: ${err.message || 'Error updating customer database'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteAndRefresh = async (id: string) => {
    await api.deleteCustomer(id);
    await refreshCustomersFromDb();
  };

  const refreshCustomersFromDb = async () => {
    // Re-run the current server page through the load effect below; App also
    // refreshes its bootstrap customer slice for the pickers and dashboards.
    // Mutations are the only callers, so this never fires on filter changes.
    setCustomersRefreshKey((key) => key + 1);
    onCustomersChanged?.();
  };

  const handleDeleteConfirm = async () => {
    if (!deletingCustomer) return;
    setIsSubmitting(true);
    try {
      await handleDeleteAndRefresh(deletingCustomer.id);
      setDeletingCustomer(null);
    } catch (err: any) {
      alertDialog(`Delete Failed: ${err.message || 'Could not delete customer record'}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Server-side read: page/pageSize/status are forwarded to the paged
  // GET /api/customers endpoint. React holds ONLY the current page slice; the
  // response also carries the filtered totals so the KPI cards describe the
  // whole result set, not just the visible page.
  const [customersPage, setCustomersPage] = useState(1);
  const [customersPageSize, setCustomersPageSize] = useState(15);
  const [customersRows, setCustomersRows] = useState<CustomerRecord[]>([]);
  const [customersTotalItems, setCustomersTotalItems] = useState(0);
  const [customersActiveItems, setCustomersActiveItems] = useState(0);
  const [customersTotalCredit, setCustomersTotalCredit] = useState(0);
  const [customersLoadError, setCustomersLoadError] = useState('');
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customersRefreshKey, setCustomersRefreshKey] = useState(0);
  const customersFetchSeq = useRef(0);

  const loadCustomersPage = useCallback(async () => {
    const seq = ++customersFetchSeq.current;
    setCustomersLoading(true);
    setCustomersLoadError('');
    try {
      const envelope = await api.getCustomers({
        branchId: selectedBranchFilter !== 'ALL' ? selectedBranchFilter : undefined,
        query: searchQuery.trim() || undefined,
        status: statusFilter !== 'ALL' ? statusFilter : undefined,
        page: customersPage,
        pageSize: customersPageSize,
      });
      if (seq !== customersFetchSeq.current) return; // a newer request owns the page
      setCustomersRows(envelope.data);
      setCustomersTotalItems(envelope.totalItems);
      setCustomersActiveItems(envelope.activeItems);
      setCustomersTotalCredit(envelope.totalCreditLimit);
    } catch (err: any) {
      if (seq !== customersFetchSeq.current) return;
      // Keep the last good page on screen; the banner says it may be stale.
      setCustomersLoadError(err?.message || 'Could not load the customer directory.');
    } finally {
      if (seq === customersFetchSeq.current) setCustomersLoading(false);
    }
  }, [selectedBranchFilter, searchQuery, statusFilter, customersPage, customersPageSize]);

  useEffect(() => {
    loadCustomersPage();
  }, [loadCustomersPage, customersRefreshKey, sseRefreshKey]);

  // A delete can remove the last row of the last page; never keep asking the
  // server for a page that no longer exists.
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(customersTotalItems / customersPageSize));
    if (customersPage > lastPage) setCustomersPage(lastPage);
  }, [customersTotalItems, customersPageSize, customersPage]);

  const customersPageCount = Math.max(1, Math.ceil(customersTotalItems / customersPageSize));
  const customersSafePage = Math.min(customersPage, customersPageCount);
  const customersRangeStart = customersTotalItems === 0 ? 0 : (customersSafePage - 1) * customersPageSize + 1;
  const customersRangeEnd = Math.min(customersSafePage * customersPageSize, customersTotalItems);

  // Server-side device reads for the Assigned Hardware column. The endpoint is
  // paged and applies branch + text filter in PostgreSQL; user-facing page
  // state is the current slice.
  const [devicesPage] = useState(1);
  const [devicesPageSize] = useState(20);
  const [customerDevicesRows, setCustomerDevicesRows] = useState<CustomerDeviceRecord[]>([]);
  const [, setCustomerDevicesTotalItems] = useState(0);
  const [, setDevicesLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const rows = await api.getCustomerDevices(
          selectedBranchFilter !== 'ALL' ? selectedBranchFilter : undefined,
          searchQuery.trim() || undefined
        );

        if (!cancelled) {
          // Bare array response (see CustomersManagement): the old envelope
          // cast silently rendered [] here too.
          setCustomerDevicesRows(Array.isArray(rows) ? rows : []);
          setCustomerDevicesTotalItems(Array.isArray(rows) ? rows.length : 0);
          setDevicesLoadError(false);
        }
      } catch {
        if (!cancelled) setDevicesLoadError(true);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [selectedBranchFilter, searchQuery, devicesPage, devicesPageSize, sseRefreshKey]);

  const getAssignedDeviceCount = (customer: CustomerRecord): number => {
    return customerDevicesRows.filter(
      (d) => d.customerCode === customer.customerId || d.customerId === customer.id || (d?.customerName || '').toLowerCase() === (customer?.customerName || '').toLowerCase()
    ).length;
  };

  // Export CSV: ask for every row matching the current filters (`all=1`), not
  // just the page on screen — a "master database" export that silently stops
  // at page 1 is worse than no export at all.
  const [isExporting, setIsExporting] = useState(false);
  const handleExportCSV = async () => {
    if (customersTotalItems === 0) {
      alertDialog('No customer master records available to export.');
      return;
    }
    setIsExporting(true);
    try {
      const envelope = await api.getCustomers({
        branchId: selectedBranchFilter !== 'ALL' ? selectedBranchFilter : undefined,
        query: searchQuery.trim() || undefined,
        status: statusFilter !== 'ALL' ? statusFilter : undefined,
        all: true,
      });
      const exportRows = envelope.data.map((c) => {
        const branchObj = branches.find((b) => b.id === c.branchId);
        return {
          'Cus. Code': c.customerId || c.id,
          'Customer Name': c.customerName,
          'Username': c.username,
          'Primary Mobile': c.contactNumber,
          'Branch Code': branchObj ? branchObj.code : c.branchId,
          'Branch Name': branchObj ? branchObj.name : c.branchId,
          'Address': c.address || '',
          'Email': c.email || '',
          'Status': c.status,
          'Credit Limit (NPR)': c.creditLimit || 0,
          'Assigned Hardware Count': getAssignedDeviceCount(c),
        };
      });

      exportToCSV({
        filename: `Customer_Master_Database_${new Date().toISOString().slice(0, 10)}`,
        reportTitle: 'Customer Master Database Directory',
        branchName: selectedBranchFilter === 'ALL'
          ? 'All Branches (Consolidated)'
          : branches.find((b) => b.id === selectedBranchFilter)?.name || selectedBranchFilter,
        generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : 'System User',
        data: exportRows,
        columns: [
          { key: 'Cus. Code', label: 'Cus. Code' },
          { key: 'Customer Name', label: 'Customer Name' },
          { key: 'Username', label: 'Username' },
          { key: 'Primary Mobile', label: 'Primary Mobile' },
          { key: 'Branch Code', label: 'Branch Code' },
          { key: 'Branch Name', label: 'Branch Name' },
          { key: 'Address', label: 'Address' },
          { key: 'Email', label: 'Email' },
          { key: 'Status', label: 'Status' },
          { key: 'Credit Limit (NPR)', label: 'Credit Limit (NPR)' },
          { key: 'Assigned Hardware Count', label: 'Assigned Hardware Count' },
        ],
      });
    } catch (err: any) {
      alertDialog(`Export Failed: ${err?.message || 'Could not load the customer records to export.'}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Top Header Banner */}
      <div className={`px-4 py-3 rounded-2xl border shadow-sm bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">Customer Master Directory</h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Central master table for customer records, usernames, primary mobile numbers, branch assignments, and credit profiles.
                  Every row below is served from the database (GET /api/customers). No register on this screen runs from a browser-memory snapshot.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canExportImport && (
              <button
                onClick={() => { void handleExportCSV(); }}
                disabled={isExporting}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors cursor-pointer border-slate-300 bg-slate-50 hover:bg-slate-200 text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200`}
              >
                {isExporting
                  ? <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
                  : <FileSpreadsheet className="h-4 w-4 text-emerald-600" />}
                <span>{isExporting ? 'Exporting…' : 'Export CSV'}</span>
              </button>
            )}

            {canExportImport && (
              <button
                onClick={onNavigateToImport}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors cursor-pointer border-slate-300 bg-slate-50 hover:bg-slate-200 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200`}
              >
                <Upload className="h-4 w-4 text-indigo-600" />
                <span>Import CSV</span>
              </button>
            )}

            {canAddCustomer && (
              <button
                onClick={handleOpenAddModal}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-all cursor-pointer"
              >
                <Plus className="h-4 w-4" />
                <span>Add Customer Record</span>
              </button>
            )}
          </div>
        </div>

        {/* Quick Summary Cards — shared compact StatCard component */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80">
          <StatCard
            label="Total Registered Customers"
            value={`${customersTotalItems} Accounts`}
            tone="slate"
          />

          <StatCard
            label="Active Status Accounts"
            value={`${customersActiveItems} Active`}
            tone="emerald"
          />

          <StatCard
            label="Tracked Device Serials"
            value={`${customerDevicesRows.length} Hardware Devices`}
            tone="indigo"
          />

          <StatCard
            label="Total Credit Capacity"
            value={formatNPR(customersTotalCredit)}
            tone="amber"
          />
        </div>
      </div>

      {/* Filter and Search Bar */}
      <FilterCard
        searchPlaceholder="Search by Cus. Code, Name, Username, Primary Mobile, Email, or Address..."
        searchValue={searchQuery}
        onSearchApply={(query) => {
          setSearchQuery(query);
          setCustomersPage(1);
        }}
        hasActiveFilters={Boolean(searchQuery) || selectedBranchFilter !== 'ALL' || statusFilter !== 'ALL'}
        onClearAll={() => {
          setSearchQuery('');
          setSelectedBranchFilter('ALL');
          setStatusFilter('ALL');
          setCustomersPage(1);
        }}
        filterChildren={
          <>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
              <select
                value={selectedBranchFilter}
                onChange={(e) => {
                  setSelectedBranchFilter(e.target.value);
                  setCustomersPage(1);
                }}
                className="px-3 py-2 text-xs rounded-xl border outline-none font-medium bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-white cursor-pointer"
              >
                <option value="ALL">All Branches ({branches.length})</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Status</label>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as any);
                  setCustomersPage(1);
                }}
                className="px-3 py-2 text-xs rounded-xl border outline-none font-medium bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-white cursor-pointer"
              >
                <option value="ALL">All Statuses</option>
                <option value="ACTIVE">Active Only</option>
                <option value="INACTIVE">Inactive Only</option>
              </select>
            </div>
          </>
        }
      />

      {customersLoadError && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 text-rose-800 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-xs font-bold">Could not load the customer directory</p>
              <p className="text-[11px] leading-5">
                {customersLoadError}
                {customersRows.length > 0 ? ' Showing the last loaded page — it may be out of date.' : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void loadCustomersPage(); }}
            disabled={customersLoading}
            className="flex items-center gap-1.5 rounded-lg border border-rose-300 px-2.5 py-1 text-[11px] font-bold hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/40 dark:hover:bg-rose-900/40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${customersLoading ? 'animate-spin' : ''}`} />
            Retry
          </button>
        </div>
      )}

      {/* Customer Master Directory Table */}
      <div className={`rounded-2xl border shadow-sm overflow-hidden bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className={`border-b text-[11px] font-bold tracking-wider bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-800/90 dark:border-slate-700 dark:text-slate-300`}>
                <th className="px-2.5 py-1.5">Cus. Code</th>
                <th className="px-2.5 py-1.5">Customer Name & Username</th>
                <th className="px-2.5 py-1.5">Primary Mobile</th>
                <th className="px-2.5 py-1.5">Branch</th>
                <th className="px-2.5 py-1.5">Contact Details & Address</th>
                <th className="px-2.5 py-1.5 text-center">Assigned Hardware</th>
                <th className="px-2.5 py-1.5 text-right">Credit Limit (NPR)</th>
                <th className="px-2.5 py-1.5 text-center">Status</th>
                <th className="px-2.5 py-1.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {customersLoading && customersRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400">
                    <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin text-indigo-500" />
                    <p className="text-xs font-semibold">Loading customer records…</p>
                  </td>
                </tr>
              ) : customersRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400">
                    <Users className="h-10 w-10 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
                    <p className="font-semibold text-base">
                      {customersLoadError ? 'Customer records could not be loaded' : 'No Customer Records Found'}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      {customersLoadError
                        ? 'Use Retry above to load the directory again.'
                        : searchQuery
                          ? 'Try adjusting your search query or filters.'
                          : 'Add a customer or import from CSV.'}
                    </p>
                  </td>
                </tr>
              ) : (
                customersRows.map((customer) => {
                  const branchObj = branches.find((b) => b.id === customer.branchId);
                  const matchingDevices = customerDevicesRows.filter(
                    (d) =>
                      d.customerCode === customer.customerId ||
                      d.customerId === customer.id ||
                      (d?.customerName || '').toLowerCase() === (customer?.customerName || '').toLowerCase()
                  );
                  const isExpanded = expandedCustomerId === customer.id;

                  return (
                    <React.Fragment key={customer.id}>
                      <tr
                        className={`hover:bg-slate-100/80 dark:hover:bg-slate-800/50 transition-colors ${isExpanded ? 'bg-indigo-50/30 dark:bg-slate-800/60' : 'text-slate-800 dark:text-slate-200'}`}
                      >
                        <td className="p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap">
                          {customer.customerId || customer.id}
                        </td>

                        <td className="p-2.5">
                          <div className="font-bold text-slate-900 dark:text-white">
                            {customer.customerName}
                          </div>
                          <div className="text-xs text-slate-500 font-mono mt-0.5">
                            @{customer.username}
                          </div>
                        </td>

                        <td className="p-2.5 font-mono text-slate-900 dark:text-white whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Phone className="h-3.5 w-3.5 text-slate-400" />
                            <span>{customer.contactNumber}</span>
                          </div>
                        </td>

                        <td className="p-2.5 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                            <Building2 className="h-3 w-3 text-indigo-500" />
                            {branchObj ? `${branchObj.name} (${branchObj.code})` : customer.branchId}
                          </span>
                        </td>

                        <td className="p-2.5 max-w-xs">
                          {customer.email && (
                            <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 mb-0.5 truncate">
                              <Mail className="h-3 w-3 text-slate-400 flex-shrink-0" />
                              <span className="truncate">{customer.email}</span>
                            </div>
                          )}
                          <div className="flex items-start gap-1 text-xs text-slate-600 dark:text-slate-300 line-clamp-1">
                            <MapPin className="h-3 w-3 text-slate-400 mt-0.5 flex-shrink-0" />
                            <span>{customer.address || 'N/A'}</span>
                          </div>
                        </td>

                        <td className="p-2.5 text-center whitespace-nowrap">
                          <button
                            onClick={() => setExpandedCustomerId(isExpanded ? null : customer.id)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${matchingDevices.length > 0 ? 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900' : 'bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400'}`}
                          >
                            <Smartphone className="h-3.5 w-3.5 text-indigo-500" />
                            <span>{matchingDevices.length} Serials</span>
                            {isExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5 ml-1 text-indigo-500" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 ml-1 text-indigo-500" />
                            )}
                          </button>
                        </td>

                        <td className="p-2.5 text-right font-mono font-semibold text-slate-900 dark:text-white whitespace-nowrap">
                          {formatNPR(customer.creditLimit)}
                        </td>

                        <td className="p-2.5 text-center whitespace-nowrap">
                          {customer.status === 'ACTIVE' ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                              <CheckCircle2 className="h-3 w-3" />
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                              <XCircle className="h-3 w-3" />
                              Inactive
                            </span>
                          )}
                        </td>

                        <td className="p-2.5 text-right whitespace-nowrap">
                          {canManageMaster ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => handleOpenEditModal(customer)}
                                title="Edit Customer Master Record"
                                className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                              >
                                <Edit2 className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setDeletingCustomer(customer)}
                                title="Delete Customer Master Record"
                                className="p-1.5 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition-colors cursor-pointer"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400 italic">View Only</span>
                          )}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr>
                          <td colSpan={9} className={`p-2.5 border-y bg-indigo-50/40 border-indigo-100 dark:bg-slate-950/90 dark:border-indigo-900/40`}>
                            <div className="rounded-xl border border-indigo-200 dark:border-indigo-900/50 p-4 bg-white dark:bg-slate-900 shadow-sm">
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-100 dark:border-slate-800">
                                <div className="flex items-center gap-2">
                                  <Wifi className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                                  <span className="font-bold text-xs text-slate-900 dark:text-white uppercase tracking-wider">
                                    Hardware & Device Serials assigned to {customer.customerName} ({customer.customerId})
                                  </span>
                                </div>
                                {onSelectTab && (
                                  <button
                                    onClick={() => onSelectTab('customer-devices', customer.customerName)}
                                    className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 transition-colors cursor-pointer"
                                  >
                                    <span>Filter in Customer Device Serials View</span>
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>

                              {matchingDevices.length === 0 ? (
                                <div className="p-4 text-center text-slate-500 text-xs">
                                  <p className="font-semibold">No Hardware Serials Assigned</p>
                                  <p className="text-[11px] text-slate-400 mt-0.5">
                                    No router, ONU, or STB devices are currently linked to this customer code in the serials directory.
                                  </p>
                                  {onSelectTab && (
                                    <button
                                      onClick={() => onSelectTab('customer-devices', customer.customerName)}
                                      className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-all cursor-pointer"
                                    >
                                      <Plus className="h-3.5 w-3.5" />
                                      <span>Assign Hardware Device</span>
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-left text-xs border-collapse">
                                    <thead>
                                      <tr className={`border-b text-[10px] font-bold tracking-wider bg-slate-100 text-slate-700 dark:bg-slate-800/90 dark:text-slate-300`}>
                                        <th className="px-2.5 py-1.5">Hardware Model</th>
                                        <th className="px-2.5 py-1.5">Device Serial #</th>
                                        <th className="px-2.5 py-1.5">PON Serial #</th>
                                        <th className="px-2.5 py-1.5">MAC Address</th>
                                        <th className="px-2.5 py-1.5">Issued Date</th>
                                        <th className="px-2.5 py-1.5 text-center">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                      {matchingDevices.map((dev) => (
                                        <tr key={dev.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                                          <td className="p-2.5 font-semibold text-slate-900 dark:text-white">
                                            {dev.productName}
                                          </td>
                                          <td className="p-2.5 font-mono font-bold text-blue-600 dark:text-blue-400">
                                            <div className="flex items-center gap-1">
                                              <span>{dev.deviceSerial}</span>
                                              <button
                                                onClick={() => {
                                                  navigator.clipboard.writeText(dev.deviceSerial);
                                                  setCopiedText(dev.deviceSerial);
                                                  setTimeout(() => setCopiedText(null), 2000);
                                                }}
                                                className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded text-slate-400 hover:text-slate-600 cursor-pointer"
                                                title="Copy Device Serial"
                                              >
                                                {copiedText === dev.deviceSerial ? (
                                                  <Check className="h-3 w-3 text-emerald-500" />
                                                ) : (
                                                  <Copy className="h-3 w-3" />
                                                )}
                                              </button>
                                            </div>
                                          </td>
                                          <td className="p-2.5 font-mono text-slate-700 dark:text-slate-300">
                                            {dev.ponSerial}
                                          </td>
                                          <td className="p-2.5 font-mono text-slate-500">
                                            {dev.macAddress || 'N/A'}
                                          </td>
                                          <td className="p-2.5 text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                            {dev.issuedDateAD} ({dev.issuedDateBS || 'BS'})
                                          </td>
                                          <td className="p-2.5 text-center whitespace-nowrap">
                                            <span className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-bold ${dev.status === 'RENTAL' || dev.status === 'ACTIVE'
                                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                                              : dev.status === 'SOLD'
                                                ? 'bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300'
                                                : dev.status === 'ROUTER_COLLECTED' || dev.status === 'DISCONNECTED'
                                                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300'
                                                  : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                                              }`}>
                                              {dev.status === 'RENTAL' || dev.status === 'ACTIVE'
                                                ? 'RENTAL (CPE ASSET)'
                                                : dev.status === 'SOLD'
                                                  ? 'SOLD (CUSTOMER OWNED)'
                                                  : dev.status === 'ROUTER_COLLECTED' || dev.status === 'DISCONNECTED'
                                                    ? `ROUTER COLLECTED${dev.disconnectedDateAD ? ` (${dev.disconnectedDateAD})` : ''}`
                                                    : dev.status}
                                            </span>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={customersSafePage}
          pageCount={customersPageCount}
          totalItems={customersTotalItems}
          rangeStart={customersRangeStart}
          rangeEnd={customersRangeEnd}
          pageSize={customersPageSize}
          onPageChange={setCustomersPage}
          onPageSizeChange={(size) => {
            setCustomersPageSize(size);
            setCustomersPage(1);
          }}
          className="mt-1"
        />
      </div>

      {/* Add / Edit Customer Modal */}
      {(isAddModalOpen || editingCustomer) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
          <div className={`w-full max-w-xl rounded-2xl shadow-2xl border p-5 overflow-hidden bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <UserCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-lg">
                    {editingCustomer ? 'Edit Customer Master Record' : 'Add New Customer Record'}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {editingCustomer
                      ? `Updating master database profile for ${editingCustomer.customerName}`
                      : 'Create a new customer profile in the master database'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsAddModalOpen(false);
                  setEditingCustomer(null);
                }}
                className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCustomer} className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Customer Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.customerName}
                    onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                    placeholder="e.g. Aarav Sharma"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none font-semibold bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Username *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="e.g. aarav.sharma"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Cus. Code (Customer ID)
                </label>
                <input
                  type="text"
                  required
                  readOnly
                  value={editingCustomer?.customerId || '— (server-issued)'}
                  className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none font-mono bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white ${editingCustomer ? 'cursor-not-allowed opacity-70' : ''}`}
                />
                {editingCustomer && (
                  <p className="text-[11px] text-slate-400 mt-1 font-mono">
                    Server-issued ID: <span className="text-indigo-600 dark:text-indigo-400">{editingCustomer.customerId || editingCustomer.id}</span>
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Primary Mobile Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.contactNumber}
                    onChange={(e) => setFormData({ ...formData, contactNumber: e.target.value })}
                    placeholder="e.g. 9800000001"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none font-mono bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Assigned Branch *
                  </label>
                  <select
                    value={formData.branchId}
                    onChange={(e) => setFormData({ ...formData, branchId: e.target.value })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="e.g. aarav@gmail.com"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Credit Limit (NPR)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={formData.creditLimit}
                    onChange={(e) => setFormData({ ...formData, creditLimit: Number(e.target.value) || 0 })}
                    placeholder="0"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none font-mono bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Customer Address / Location
                  </label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    placeholder="e.g. Example Street, Example City, Nepal"
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Account Status
                  </label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                    className={`w-full px-3 py-1.5 text-xs rounded-xl border outline-none bg-slate-50 border-slate-300 dark:bg-slate-800 dark:border-slate-700 dark:text-white`}
                  >
                    <option value="ACTIVE">Active Account</option>
                    <option value="INACTIVE">Inactive / Suspended</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setIsAddModalOpen(false);
                    setEditingCustomer(null);
                  }}
                  className="px-4 py-2 text-sm font-semibold rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 text-sm font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition-all cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : editingCustomer ? 'Update Record' : 'Save Customer Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border p-5 bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}>
            <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400 mb-3">
              <div className="p-2 rounded-xl bg-rose-500/10">
                <Trash2 className="h-6 w-6" />
              </div>
              <h3 className="font-bold text-lg">Confirm Delete Customer</h3>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Are you sure you want to permanently delete customer account{' '}
              <span className="font-bold font-mono text-indigo-600">{deletingCustomer.customerId || deletingCustomer.id}</span> ({deletingCustomer.customerName}) from the master directory?
            </p>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-100 dark:border-slate-800">
              <button
                onClick={() => setDeletingCustomer(null)}
                className="px-4 py-2 text-sm font-semibold rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-semibold rounded-xl bg-rose-600 hover:bg-rose-700 text-white shadow-sm cursor-pointer disabled:opacity-50"
              >
                {isSubmitting ? 'Deleting...' : 'Delete Customer Record'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
