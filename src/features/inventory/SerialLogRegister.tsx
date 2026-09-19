import React, { useState, useMemo } from 'react';
import { Branch, SerialLog, User } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { api } from '../../services/api';
import {
  Search,
  Download,
  Barcode,
  Wifi,
  AlertCircle,
  CheckCircle,
  Clock,
  Truck,
  ShoppingCart,
  ChevronDown,
  ChevronRight,
  History,
  Edit2,
  Save,
  X,
  Info,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface SerialLogRegisterProps {
  serialLogs: SerialLog[];
  branches: Branch[];
  selectedBranchId: string;
  currentUser?: User | null;
  onRefreshData?: () => void;
}

type DisplayLog = SerialLog & { branchName?: string };

const STATUS_META: Record<string, { badge: string; icon: React.ReactNode }> = {
  IN_STOCK: {
    badge: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
    icon: <CheckCircle className="h-4 w-4" />,
  },
  IN_TRANSIT: {
    badge: 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800',
    icon: <Truck className="h-4 w-4" />,
  },
  CUSTOMER_ASSIGNED: {
    badge: 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800',
    icon: <ShoppingCart className="h-4 w-4" />,
  },
  POP_LOCATION_ASSIGNED: {
    badge: 'bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800',
    icon: <Wifi className="h-4 w-4" />,
  },
  DAMAGED: {
    badge: 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800',
    icon: <AlertCircle className="h-4 w-4" />,
  },
  RETURNED: {
    badge: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
    icon: <Clock className="h-4 w-4" />,
  },
};

const ALL_STATUSES = ['IN_STOCK', 'IN_TRANSIT', 'CUSTOMER_ASSIGNED', 'POP_LOCATION_ASSIGNED', 'DAMAGED', 'RETURNED'];

export const SerialLogRegister: React.FC<SerialLogRegisterProps> = ({
  serialLogs = [],
  branches = [],
  selectedBranchId,
  currentUser,
  onRefreshData,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterBranch, setFilterBranch] = useState<string>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<DisplayLog | null>(null);
  const [editForm, setEditForm] = useState({ deviceSerial: '', ponSerial: '', macAddress: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');

  const register = useMemo<DisplayLog[]>(() => {
    const bySerial = new Map<string, DisplayLog>();
    for (const row of serialLogs) {
      const rawHistory: unknown = (row as any).history ?? (row as any).historyJson ?? [];
      let history: SerialLog['history'] = [];
      if (Array.isArray(rawHistory)) history = rawHistory;
      else if (typeof rawHistory === 'string') {
        try {
          const parsed = JSON.parse(rawHistory || '[]');
          history = Array.isArray(parsed) ? parsed : [];
        } catch {
          history = [];
        }
      }
      const key = String(row.deviceSerial || '').trim().toLowerCase();
      if (!key) continue;
      const entry: DisplayLog = {
        ...row,
        history,
        branchName: branches.find((b) => b.id === row.branchId)?.name,
      };
      const prev = bySerial.get(key);
      if (!prev || String(entry.updatedAt || entry.createdAt || '') >= String(prev.updatedAt || prev.createdAt || '')) {
        bySerial.set(key, entry);
      }
    }
    return [...bySerial.values()].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  }, [serialLogs, branches]);

  const filtered = useMemo(() => {
    let result = register;
    const scopeBranch = filterBranch !== 'ALL' ? filterBranch : selectedBranchId !== 'ALL' ? selectedBranchId : 'ALL';
    if (scopeBranch !== 'ALL') result = result.filter((d) => d.branchId === scopeBranch);
    if (filterStatus !== 'ALL') result = result.filter((d) => d.status === filterStatus);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (d) =>
          d.deviceSerial.toLowerCase().includes(q) ||
          (d.ponSerial?.toLowerCase() || '').includes(q) ||
          (d.macAddress?.toLowerCase() || '').includes(q) ||
          (d.productName || '').toLowerCase().includes(q) ||
          (d.customerName?.toLowerCase() || '').includes(q) ||
          (d.branchName?.toLowerCase() || '').includes(q)
      );
    }
    return result;
  }, [register, filterBranch, filterStatus, searchQuery, selectedBranchId]);

  const pagination = useClientPagination(filtered, 20, [searchQuery, filterBranch, filterStatus, selectedBranchId]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of ALL_STATUSES) counts[s] = register.filter((d) => d.status === s).length;
    return counts;
  }, [register]);

  const handleExportCSV = () => {
    exportToCSV({
      filename: 'Serial_Log_Register',
      reportTitle: 'Serial Log Register (one row per serial)',
      branchName: filterBranch === 'ALL' ? 'All Branches' : branches.find((b) => b.id === filterBranch)?.name || filterBranch,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filtered.map((d) => ({
        deviceSerial: d.deviceSerial,
        ponSerial: d.ponSerial || '-',
        macAddress: d.macAddress || '-',
        productName: d.productName || '-',
        status: d.status,
        branchName: d.branchName || '-',
        customerName: d.customerName || 'Unassigned Stock',
        historyEvents: (d.history || []).length,
        lastUpdated: d.updatedAt || d.createdAt || '-',
      })),
      columns: [
        { key: 'deviceSerial', label: 'Device Serial' },
        { key: 'ponSerial', label: 'PON Serial' },
        { key: 'macAddress', label: 'MAC Address' },
        { key: 'productName', label: 'Product Name' },
        { key: 'status', label: 'Status' },
        { key: 'branchName', label: 'Branch' },
        { key: 'customerName', label: 'Customer (if assigned)' },
        { key: 'historyEvents', label: 'History Events' },
        { key: 'lastUpdated', label: 'Last Updated' },
      ],
    });
  };

  const canEditSerials = isOperationAllowed('edit-device-serials', currentUser?.role);

  const openEdit = (row: DisplayLog) => {
    setEditingRow(row);
    setEditForm({
      deviceSerial: row.deviceSerial,
      ponSerial: row.ponSerial || '',
      macAddress: row.macAddress || '',
    });
    setEditError('');
  };

  const handleEditCancel = () => {
    setEditingRow(null);
    setEditForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
    setEditError('');
  };

  const serialDuplicate = useMemo(() => {
    if (!editingRow) return null;
    const val = editForm.deviceSerial.trim().toUpperCase();
    if (!val) return null;
    return register.find(
      (r) => r.id !== editingRow.id && String(r.deviceSerial || '').trim().toUpperCase() === val
    ) || null;
  }, [editingRow, editForm.deviceSerial, register]);

  const allFieldsChanged = useMemo(() => {
    if (!editingRow) return false;
    return (
      editForm.deviceSerial.trim().toUpperCase() !== editingRow.deviceSerial.toUpperCase() ||
      editForm.ponSerial.trim().toUpperCase() !== (editingRow.ponSerial || '').toUpperCase() ||
      editForm.macAddress.trim().toUpperCase() !== (editingRow.macAddress || '').toUpperCase()
    );
  }, [editingRow, editForm]);

  const canSave = !!editingRow && !!editForm.deviceSerial.trim() && !!editForm.ponSerial.trim() && !serialDuplicate && allFieldsChanged;

  const handleEditSave = async () => {
    if (!editingRow) return;
    if (!editForm.deviceSerial.trim() || !editForm.ponSerial.trim()) {
      setEditError('Device serial and PON serial are required.');
      return;
    }
    if (serialDuplicate) {
      setEditError(`Serial number "${editForm.deviceSerial.trim().toUpperCase()}" already exists for product "${serialDuplicate.productName || 'Unknown'}".`);
      return;
    }
    if (!allFieldsChanged) {
      setEditError('At least one field must differ from the current values to save a correction.');
      return;
    }
    setEditLoading(true);
    setEditError('');
    try {
      await api.updateDeviceSerials({
        // No `id`: the register row is not a customer-device record, and the
        // server resolves the target by matching the old serial across sources.
        oldDeviceSerial: editingRow.deviceSerial,
        oldPonSerial: editingRow.ponSerial,
        oldMacAddress: editingRow.macAddress,
        deviceSerial: editForm.deviceSerial.trim().toUpperCase(),
        ponSerial: editForm.ponSerial.trim().toUpperCase(),
        macAddress: editForm.macAddress.trim().toUpperCase() || undefined,
        branchId: editingRow.branchId,
      });
      handleEditCancel();
      onRefreshData?.();
    } catch (err: any) {
      setEditError(err?.message || 'Failed to update serial information');
    } finally {
      setEditLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
            <Barcode className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <span>Serial Log Register</span>
          </h2>
          <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">
            One row per device serial with full lifecycle history — purchases, transfers, customer assignments, returns and damage, converged from all sources.
          </p>
        </div>
        <button
          onClick={handleExportCSV}
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold border transition-all cursor-pointer shadow-xs bg-white border-slate-300 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <Download className="h-4 w-4" />
          <span>Export CSV</span>
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {[
          { key: 'IN_STOCK', label: 'In Stock', color: 'emerald' },
          { key: 'IN_TRANSIT', label: 'In Transit', color: 'blue' },
          { key: 'CUSTOMER_ASSIGNED', label: 'Customer', color: 'purple' },
          { key: 'POP_LOCATION_ASSIGNED', label: 'POP Location', color: 'indigo' },
          { key: 'DAMAGED', label: 'Damaged', color: 'rose' },
          { key: 'RETURNED', label: 'Returned', color: 'amber' },
        ].map((stat) => (
          <div
            key={stat.key}
            className={`rounded-lg p-2.5 border text-center bg-${stat.color}-50/30 border-${stat.color}-200 dark:bg-slate-900/50 dark:border-slate-800`}
          >
            <div className={`text-[10px] font-semibold text-${stat.color}-900 dark:text-${stat.color}-400`}>{stat.label}</div>
            <div className={`text-lg font-mono font-bold mt-0.5 text-${stat.color}-700 dark:text-${stat.color}-300`}>
              {statusCounts[stat.key] || 0}
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 rounded-xl border flex flex-wrap items-center gap-3 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search serial, PON, MAC, product, customer, branch..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-500 dark:placeholder-slate-400"
          />
        </div>
        <select
          value={filterBranch}
          onChange={(e) => setFilterBranch(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
        >
          <option value="ALL">All Branches</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name} ({branch.code})
            </option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
        >
          <option value="ALL">All Status</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0 rounded-xl border shadow-md overflow-hidden bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800">
        <div className="h-full overflow-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
              <tr>
                <th className="px-2.5 py-2 w-8"></th>
                <th className="px-2.5 py-2">Device Serial</th>
                <th className="px-2.5 py-2">PON Serial</th>
                <th className="px-2.5 py-2">MAC Address</th>
                <th className="px-2.5 py-2">Product</th>
                <th className="px-2.5 py-2 text-center">Status</th>
                <th className="px-2.5 py-2">Branch / Customer</th>
                <th className="px-2.5 py-2">History</th>
                {canEditSerials && <th className="px-2.5 py-2 text-center">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={canEditSerials ? 9 : 8} className="p-6 text-center text-slate-500 dark:text-slate-400">
                    No serial devices found matching the filters.
                  </td>
                </tr>
              ) : (
                pagination.pagedItems.map((device) => {
                  const meta = STATUS_META[device.status] || STATUS_META.IN_STOCK;
                  const isOpen = expandedId === device.id;
                  return (
                    <React.Fragment key={device.id}>
                      <tr className="hover:bg-slate-100 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="px-2.5 py-2">
                          <button
                            onClick={() => setExpandedId(isOpen ? null : device.id)}
                            className="p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                            title={isOpen ? 'Hide history' : 'Show history'}
                          >
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="px-2.5 py-2 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                          {device.deviceSerial}
                        </td>
                        <td className="px-2.5 py-2 font-mono text-slate-600 dark:text-slate-400">
                          {device.ponSerial || '-'}
                        </td>
                        <td className="px-2.5 py-2 font-mono text-slate-600 dark:text-slate-400">
                          {device.macAddress || '-'}
                        </td>
                        <td className="px-2.5 py-2">
                          <div className="font-semibold text-slate-900 dark:text-white">{device.productName || '-'}</div>
                        </td>
                        <td className="px-2.5 py-2 text-center">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 border text-[10px] font-bold ${meta.badge}`}>
                            {meta.icon}
                            {device.status.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-2.5 py-2">
                          <div className="font-semibold text-slate-900 dark:text-white">{device.branchName || '-'}</div>
                          <div className="text-[9px] text-slate-500 dark:text-slate-400">
                            {device.customerName || 'Unassigned Stock'}
                          </div>
                        </td>
                        <td className="px-2.5 py-2">
                          <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                            <History className="h-3 w-3" />
                            {(device.history || []).length} event{(device.history || []).length === 1 ? '' : 's'}
                          </span>
                        </td>
                        {canEditSerials && (
                          <td className="px-2.5 py-2 text-center">
                            <button
                              onClick={() => openEdit(device)}
                              className="p-1 text-slate-600 hover:bg-slate-100 rounded dark:hover:bg-slate-800 dark:text-slate-300"
                              title="Correct serial numbers (wrong entry)"
                            >
                              <Edit2 className="h-4 w-4" />
                            </button>
                          </td>
                        )}
                      </tr>
                      {isOpen && (
                        <tr className="bg-slate-50 dark:bg-slate-800/30">
                          <td></td>
                          <td colSpan={canEditSerials ? 8 : 7} className="px-2.5 py-2">
                            {(device.history || []).length === 0 ? (
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">No history events recorded.</div>
                            ) : (
                              <ol className="space-y-1.5 py-1">
                                {(device.history || []).map((h, i) => (
                                  <li key={i} className="flex flex-wrap items-center gap-2 text-[11px]">
                                    <span className="font-mono font-bold text-slate-700 dark:text-slate-200">
                                      {h.dateAD ? formatDualDate(h.dateAD, 'AD') : '-'}
                                    </span>
                                    <span className="rounded-full px-2 py-0.5 border text-[10px] font-bold bg-white border-slate-300 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200">
                                      {String(h.status || '').replace(/_/g, ' ')}
                                    </span>
                                    <span className="text-slate-500 dark:text-slate-400">{h.sourceType || ''}</span>
                                    {h.notes && <span className="text-slate-500 dark:text-slate-400">— {h.notes}</span>}
                                  </li>
                                ))}
                              </ol>
                            )}
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
      </div>

      {editingRow && (
        <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-lg w-full border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <div>
                <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                  <Edit2 className="h-4 w-4 text-indigo-500" />
                  Correct Serial Numbers
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                  {editingRow.deviceSerial}
                </p>
              </div>
              <button
                onClick={handleEditCancel}
                disabled={editLoading}
                className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex gap-2.5 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                <Info className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  All three serial numbers must be corrected together as a unit. The correction applies across
                  all records and is logged in the serial history.
                </p>
              </div>

              {editError && (
                <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 rounded-xl">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {editError}
                </div>
              )}

              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Device Serial <span className="text-rose-500">*</span>
                </label>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                  Current: {editingRow.deviceSerial}
                </p>
                <input
                  type="text"
                  value={editForm.deviceSerial}
                  onChange={(e) => setEditForm({ ...editForm, deviceSerial: e.target.value })}
                  disabled={editLoading}
                  className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                    serialDuplicate
                      ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                      : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                  }`}
                />
                {serialDuplicate && (
                  <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Already exists for{' '}
                    <span className="font-semibold">{serialDuplicate.productName || 'Unknown'}</span>
                    {serialDuplicate.branchName && (
                      <> in <span className="font-semibold">{serialDuplicate.branchName}</span></>
                    )}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  PON Serial <span className="text-rose-500">*</span>
                </label>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                  Current: {editingRow.ponSerial || '—'}
                </p>
                <input
                  type="text"
                  value={editForm.ponSerial}
                  onChange={(e) => setEditForm({ ...editForm, ponSerial: e.target.value })}
                  disabled={editLoading}
                  className="w-full px-3 py-2.5 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  MAC Address
                </label>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                  Current: {editingRow.macAddress || '—'}
                </p>
                <input
                  type="text"
                  value={editForm.macAddress}
                  onChange={(e) => setEditForm({ ...editForm, macAddress: e.target.value })}
                  disabled={editLoading}
                  className="w-full px-3 py-2.5 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                />
              </div>
            </div>

            <div className="flex gap-3 px-5 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <button
                onClick={handleEditCancel}
                disabled={editLoading}
                className="flex-1 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-600 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={!canSave || editLoading}
                className="flex-1 px-4 py-2.5 text-xs font-bold rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <Save className="h-3.5 w-3.5" />
                {editLoading ? 'Saving...' : 'Save Correction'}
              </button>
            </div>
          </div>
        </div>
      )}

      {filtered.length > 0 && (
        <TablePagination
          page={pagination.page}
          pageCount={pagination.pageCount}
          totalItems={pagination.totalItems}
          rangeStart={pagination.rangeStart}
          rangeEnd={pagination.rangeEnd}
          pageSize={pagination.pageSize}
          onPageChange={pagination.setPage}
        />
      )}
    </div>
  );
};
