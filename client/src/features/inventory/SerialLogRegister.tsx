import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Branch, SerialLog, SerialLookupResult, User } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { api } from '../../services/api';
import { DateField } from '../../components/DateField';
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
import { FilterCard } from '../../components/common/FilterCard';

interface SerialLogRegisterProps {
  serialLogs: SerialLog[];
  branches: Branch[];
  selectedBranchId: string;
  currentUser?: User | null;
  /** Global calendar mode from the header toggle (BS Nepali picker / AD native picker). */
  dateMode?: 'BS' | 'AD';
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
  dateMode = 'BS',
  onRefreshData,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterBranch, setFilterBranch] = useState<string>('ALL');
  // Register date range (canonical AD values; DateField converts BS picks).
  // Narrows rows by their latest activity date (updatedAt, falling back to
  // createdAt); an empty bound is open-ended.
  const [dateFromAD, setDateFromAD] = useState('');
  const [dateToAD, setDateToAD] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<DisplayLog | null>(null);
  const [editForm, setEditForm] = useState({ deviceSerial: '', ponSerial: '', macAddress: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');
  // Dual-panel state: when a typed value collides with another device, the
  // modal expands and the conflicting device gets its own editable panel.
  const [conflictDevice, setConflictDevice] = useState<SerialLookupResult | null>(null);
  const [conflictField, setConflictField] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [bForm, setBForm] = useState({ deviceSerial: '', ponSerial: '', macAddress: '' });

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
    // Latest-activity date (updatedAt || createdAt), AD YYYY-MM-DD prefix.
    if (dateFromAD || dateToAD) {
      result = result.filter((d) => {
        const day = String(d.updatedAt || d.createdAt || '').split('T')[0];
        if (!day) return false;
        if (dateFromAD && day < dateFromAD) return false;
        if (dateToAD && day > dateToAD) return false;
        return true;
      });
    }
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
  }, [register, filterBranch, filterStatus, searchQuery, selectedBranchId, dateFromAD, dateToAD]);

  const pagination = useClientPagination(filtered, 20, [searchQuery, filterBranch, filterStatus, selectedBranchId, dateFromAD, dateToAD]);

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
    setConflictDevice(null);
    setConflictField('');
    setBForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
  };

  // Normalize an identifier for case-insensitive duplicate comparison.
  const norm = (v: string | undefined | null) => String(v || '').trim().toUpperCase();

  // Rows that must not hold any final value: everything except the edited row
  // and (in dual mode) the conflicting device, which is being re-serialled too.
  const otherRows = useMemo(() => {
    if (!editingRow) return [];
    const conflictKeys = conflictDevice
      ? new Set(
          [conflictDevice.deviceSerial, conflictDevice.ponSerial, conflictDevice.macAddress]
            .map((v) => norm(v))
            .filter(Boolean)
        )
      : new Set<string>();
    return register.filter((r) => {
      if (r.id === editingRow.id) return false;
      if (
        conflictKeys.size > 0 &&
        (conflictKeys.has(norm(r.deviceSerial)) || conflictKeys.has(norm(r.ponSerial)) || conflictKeys.has(norm(r.macAddress)))
      ) {
        return false;
      }
      return true;
    });
  }, [register, editingRow, conflictDevice]);

  const findConflict = (value: string): DisplayLog | null => {
    const v = norm(value);
    if (!v) return null;
    return (
      otherRows.find(
        (r) => norm(r.deviceSerial) === v || norm(r.ponSerial) === v || norm(r.macAddress) === v
      ) || null
    );
  };

  const deviceConflict = useMemo(() => findConflict(editForm.deviceSerial), [editForm.deviceSerial, otherRows]);
  const ponConflict = useMemo(() => findConflict(editForm.ponSerial), [editForm.ponSerial, otherRows]);
  const macConflict = useMemo(() => findConflict(editForm.macAddress), [editForm.macAddress, otherRows]);
  const bDeviceConflict = useMemo(() => (conflictDevice ? findConflict(bForm.deviceSerial) : null), [bForm.deviceSerial, otherRows, conflictDevice]);
  const bPonConflict = useMemo(() => (conflictDevice ? findConflict(bForm.ponSerial) : null), [bForm.ponSerial, otherRows, conflictDevice]);
  const bMacConflict = useMemo(() => (conflictDevice ? findConflict(bForm.macAddress) : null), [bForm.macAddress, otherRows, conflictDevice]);

  // Cross-panel rule: the two devices must not end up sharing any value.
  const crossPanelClash = useMemo(() => {
    if (!conflictDevice) return false;
    const aVals = new Set(
      [editForm.deviceSerial, editForm.ponSerial, editForm.macAddress].map(norm).filter(Boolean)
    );
    const bVals = [bForm.deviceSerial, bForm.ponSerial, bForm.macAddress].map(norm).filter(Boolean);
    return bVals.some((v) => aVals.has(v));
  }, [conflictDevice, editForm, bForm]);

  const hasAnyConflict = !!(deviceConflict || ponConflict || macConflict);
  const bHasAnyConflict = !!(bDeviceConflict || bPonConflict || bMacConflict);

  const allFieldsChanged = useMemo(() => {
    if (!editingRow) return false;
    return (
      editForm.deviceSerial.trim().toUpperCase() !== editingRow.deviceSerial.toUpperCase() ||
      editForm.ponSerial.trim().toUpperCase() !== (editingRow.ponSerial || '').toUpperCase() ||
      editForm.macAddress.trim().toUpperCase() !== (editingRow.macAddress || '').toUpperCase()
    );
  }, [editingRow, editForm]);

  const bChanged = useMemo(() => {
    if (!conflictDevice) return false;
    return (
      norm(bForm.deviceSerial) !== norm(conflictDevice.deviceSerial) ||
      norm(bForm.ponSerial) !== norm(conflictDevice.ponSerial) ||
      norm(bForm.macAddress) !== norm(conflictDevice.macAddress)
    );
  }, [conflictDevice, bForm]);

  const canSave =
    !!editingRow &&
    !!editForm.deviceSerial.trim() &&
    !!editForm.ponSerial.trim() &&
    !hasAnyConflict &&
    !crossPanelClash &&
    allFieldsChanged &&
    (!conflictDevice || (!!bForm.deviceSerial.trim() && !!bForm.ponSerial.trim() && !bHasAnyConflict));

  // ------------------------------------------------------------------
  // Live duplicate detection: whenever a serial field is typed into,
  // ask the server which device already holds that value. A hit expands
  // the modal with a second editable panel for the conflicting device.
  // ------------------------------------------------------------------
  const lookupSeq = useRef(0);
  // Remembers which conflicting device the B-form was prefilled for, so the
  // lookup effect only re-prefills when a DIFFERENT device conflicts — not on
  // every keystroke (which would clobber user edits and the swap button).
  const prefilledForRef = useRef('');
  useEffect(() => {
    if (!editingRow) return;
    const candidates: Array<{ field: string; value: string }> = [
      { field: 'deviceSerial', value: editForm.deviceSerial.trim().toUpperCase() },
      { field: 'ponSerial', value: editForm.ponSerial.trim().toUpperCase() },
      { field: 'macAddress', value: editForm.macAddress.trim().toUpperCase() },
    ].filter((c) => c.value);

    const ownValues = new Set(
      [editingRow.deviceSerial, editingRow.ponSerial, editingRow.macAddress].map(norm).filter(Boolean)
    );
    const conflicting = candidates.filter((c) => !ownValues.has(norm(c.value)));

    if (conflicting.length === 0) {
      // No live conflict typed in — collapse the dual panel.
      setConflictDevice(null);
      setConflictField('');
      setBForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
      prefilledForRef.current = '';
      return;
    }

    const seq = ++lookupSeq.current;
    const timer = setTimeout(async () => {
      setLookupLoading(true);
      try {
        for (const c of conflicting) {
          const hit = await api.lookupSerial(c.value, [editingRow.deviceSerial, editingRow.ponSerial, editingRow.macAddress].filter(Boolean) as string[]);
          if (seq !== lookupSeq.current) return; // stale response
          if (hit) {
            const hitKey = String(hit.deviceSerial || '').trim().toUpperCase();
            if (prefilledForRef.current !== hitKey) {
              prefilledForRef.current = hitKey;
              setConflictDevice(hit);
              setConflictField(c.field);
              setBForm({
                deviceSerial: hit.deviceSerial || '',
                ponSerial: hit.ponSerial || '',
                macAddress: hit.macAddress || '',
              });
            }
            return;
          }
        }
        // Server confirms no conflict — collapse.
        setConflictDevice(null);
        setConflictField('');
        setBForm({ deviceSerial: '', ponSerial: '', macAddress: '' });
        prefilledForRef.current = '';
      } catch {
        // Lookup failure is non-fatal; server still validates on save.
      } finally {
        if (seq === lookupSeq.current) setLookupLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [editingRow, editForm.deviceSerial, editForm.ponSerial, editForm.macAddress]);

  const buildEditPayload = (form: { deviceSerial: string; ponSerial: string; macAddress: string }) => ({
    deviceSerial: form.deviceSerial.trim().toUpperCase(),
    ponSerial: form.ponSerial.trim().toUpperCase(),
    macAddress: form.macAddress.trim().toUpperCase() || undefined,
  });

  const handleEditSave = async () => {
    if (!editingRow) return;
    if (!editForm.deviceSerial.trim() || !editForm.ponSerial.trim()) {
      setEditError('Device serial and PON serial are required.');
      return;
    }
    if (conflictDevice && (!bForm.deviceSerial.trim() || !bForm.ponSerial.trim())) {
      setEditError('Device serial and PON serial are required for the second device too.');
      return;
    }
    if (hasAnyConflict || bHasAnyConflict || crossPanelClash) {
      const conflict = deviceConflict || ponConflict || macConflict || bDeviceConflict || bPonConflict || bMacConflict;
      if (conflict) {
        const fieldLabel = deviceConflict || bDeviceConflict ? 'Device serial' : ponConflict || bPonConflict ? 'PON serial' : 'MAC address';
        const conflictValue = norm(
          deviceConflict ? editForm.deviceSerial
          : bDeviceConflict ? bForm.deviceSerial
          : ponConflict ? editForm.ponSerial
          : bPonConflict ? bForm.ponSerial
          : macConflict ? editForm.macAddress
          : bForm.macAddress
        );
        setEditError(
          `${fieldLabel} "${conflictValue}" already exists on device "${conflict.deviceSerial}"` +
            (conflict.productName ? ` (${conflict.productName})` : '') +
            '. Correct the highlighted field before saving.'
        );
      } else if (crossPanelClash) {
        setEditError('Both devices cannot end up with the same serial value. Correct one of the panels — or use the swap by exchanging the values between them.');
      }
      return;
    }
    if (!allFieldsChanged) {
      setEditError('At least one field must differ from the current values to save a correction.');
      return;
    }
    setEditLoading(true);
    setEditError('');
    try {
      const aPayload = {
        // No `id`: the register row is not a customer-device record, and the
        // server resolves the target by matching the old serial across sources.
        oldDeviceSerial: editingRow.deviceSerial,
        oldPonSerial: editingRow.ponSerial,
        oldMacAddress: editingRow.macAddress,
        ...buildEditPayload(editForm),
        branchId: editingRow.branchId,
      };
      if (conflictDevice && bChanged) {
        // Dual save — both devices corrected in one operation (swaps included).
        await api.updateDeviceSerialsDual(aPayload, {
          oldDeviceSerial: conflictDevice.deviceSerial,
          oldPonSerial: conflictDevice.ponSerial || '',
          oldMacAddress: conflictDevice.macAddress || '',
          ...buildEditPayload(bForm),
          branchId: conflictDevice.branchId || editingRow.branchId,
        });
      } else {
        await api.updateDeviceSerials(aPayload);
      }
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

      {/* Search & Filter Card — shared inline card */}
      <FilterCard
        searchPlaceholder="Search serial, PON, MAC, product, customer, branch..."
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={
          Boolean(searchQuery) || filterBranch !== 'ALL' || filterStatus !== 'ALL' || Boolean(dateFromAD) || Boolean(dateToAD)
        }
        onClearAll={() => {
          setSearchQuery('');
          setFilterBranch('ALL');
          setFilterStatus('ALL');
          setDateFromAD('');
          setDateToAD('');
        }}
        filterChildren={
          <>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
              <select
                value={filterBranch}
                onChange={(e) => setFilterBranch(e.target.value)}
                className="w-44 px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white cursor-pointer"
              >
                <option value="ALL">All Branches</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Status</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-40 px-3 py-2 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white cursor-pointer"
              >
                <option value="ALL">All Status</option>
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Activity From</label>
              <div className="w-40">
                <DateField
                  mode={dateMode}
                  value={dateFromAD}
                  onChange={setDateFromAD}
                  compact
                  showHint={false}
                  max={dateToAD || undefined}
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Activity To</label>
              <div className="w-40">
                <DateField
                  mode={dateMode}
                  value={dateToAD}
                  onChange={setDateToAD}
                  compact
                  showHint={false}
                  min={dateFromAD || undefined}
                />
              </div>
            </div>
          </>
        }
        rightChildren={
          <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            Showing <strong className="text-slate-900 dark:text-white font-mono">{filtered.length}</strong> serials
          </span>
        }
      />

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
          <div className={`bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full border border-slate-200 dark:border-slate-700 overflow-hidden max-h-[92vh] flex flex-col ${
            conflictDevice ? 'max-w-4xl' : 'max-w-lg'
          }`}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <div>
                <h3 className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2 flex-wrap">
                  <Edit2 className="h-4 w-4 text-indigo-500" />
                  <span>Correct Serial Numbers</span>
                  {conflictDevice && (
                    <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                      Dual Edit — resolve on both devices
                    </span>
                  )}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                  {editingRow.deviceSerial}{conflictDevice ? `  ↔  ${conflictDevice.deviceSerial}` : ''}
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

            <div className="p-5 space-y-4 overflow-y-auto">
              <div className={`flex gap-2.5 p-3 rounded-xl border ${
                conflictDevice
                  ? 'bg-indigo-50 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-800'
                  : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800'
              }`}>
                <Info className={`h-4 w-4 mt-0.5 shrink-0 ${conflictDevice ? 'text-indigo-500' : 'text-amber-500'}`} />
                <p className={`text-[11px] leading-relaxed ${conflictDevice ? 'text-indigo-700 dark:text-indigo-300' : 'text-amber-700 dark:text-amber-300'}`}>
                  {conflictDevice ? (
                    <>
                      The serial you typed already exists on <span className="font-bold">{conflictDevice.deviceSerial}</span>
                      {conflictDevice.productName ? ` (${conflictDevice.productName})` : ''}
                      {conflictDevice.source === 'CUSTOMER_DEVICE' && conflictDevice.customerName ? ` — assigned to ${conflictDevice.customerName}` : ''}
                      {conflictDevice.source === 'FIXED_ASSET' ? ' — fixed asset' : ''}. Both devices are now editable side by side:
                      give each a unique serial, or use the swap button to exchange the values. The correction applies across all records.
                    </>
                  ) : (
                    <>Serial numbers must be unique — a device serial, PON serial, or MAC address that already
                    exists on another device cannot be saved. The correction applies across
                    all records and is logged in the serial history.</>
                  )}
                  {lookupLoading && <span className="ml-1 opacity-60">Checking serials…</span>}
                </p>
              </div>

              {editError && (
                <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 rounded-xl">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {editError}
                </div>
              )}

              <div className={`grid gap-5 ${conflictDevice ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
                {/* -------- Panel A: the device being corrected -------- */}
                <div className={`space-y-4 rounded-xl p-3 border ${
                  conflictDevice
                    ? 'border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/20'
                    : 'border-transparent p-0'
                }`}>
                  {conflictDevice && (
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                        Device 1 — {editingRow.productName || 'Original'}
                      </span>
                      <span className="text-[9px] rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 font-bold">
                        REGISTER
                      </span>
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
                    deviceConflict
                      ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                      : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                  }`}
                />
                {deviceConflict && (
                  <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Already exists on{' '}
                    <span className="font-semibold">{deviceConflict.deviceSerial}</span>
                    {deviceConflict.productName && (
                      <> — <span className="font-semibold">{deviceConflict.productName}</span></>
                    )}
                    {deviceConflict.branchName && (
                      <> in <span className="font-semibold">{deviceConflict.branchName}</span></>
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
                  className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                    ponConflict
                      ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                      : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                  }`}
                />
                {ponConflict && (
                  <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Already exists on{' '}
                    <span className="font-semibold">{ponConflict.deviceSerial}</span>
                    {ponConflict.productName && (
                      <> — <span className="font-semibold">{ponConflict.productName}</span></>
                    )}
                    {ponConflict.branchName && (
                      <> in <span className="font-semibold">{ponConflict.branchName}</span></>
                    )}
                  </p>
                )}
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
                  className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                    macConflict
                      ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                      : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                  }`}
                />
                {macConflict && (
                  <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Already exists on{' '}
                    <span className="font-semibold">{macConflict.deviceSerial}</span>
                    {macConflict.productName && (
                      <> — <span className="font-semibold">{macConflict.productName}</span></>
                    )}
                    {macConflict.branchName && (
                      <> in <span className="font-semibold">{macConflict.branchName}</span></>
                    )}
                  </p>
                )}
              </div>
                </div>

                {/* -------- Panel B: the conflicting device (only when detected) -------- */}
                {conflictDevice && (
                  <div className="space-y-4 rounded-xl p-3 border border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/20">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                        Device 2 — {conflictDevice.productName || 'Conflicting device'}
                      </span>
                      <span className="text-[9px] rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 font-bold">
                        {conflictDevice.source === 'SERIAL_LOG' ? 'REGISTER' : conflictDevice.source === 'CUSTOMER_DEVICE' ? 'CUSTOMER DEVICE' : 'FIXED ASSET'}
                      </span>
                    </div>
                    {conflictDevice.customerName && (
                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                        Customer: <span className="font-semibold">{conflictDevice.customerName}</span>
                      </p>
                    )}
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        Device Serial <span className="text-rose-500">*</span>
                      </label>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                        Current: {conflictDevice.deviceSerial}
                      </p>
                      <input
                        type="text"
                        value={bForm.deviceSerial}
                        onChange={(e) => setBForm({ ...bForm, deviceSerial: e.target.value })}
                        disabled={editLoading}
                        className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                          bDeviceConflict
                            ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                            : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                        }`}
                      />
                      {bDeviceConflict && (
                        <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          Already exists on <span className="font-semibold">{bDeviceConflict.deviceSerial}</span>
                          {bDeviceConflict.productName && <> — <span className="font-semibold">{bDeviceConflict.productName}</span></>}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        PON Serial <span className="text-rose-500">*</span>
                      </label>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                        Current: {conflictDevice.ponSerial || '—'}
                      </p>
                      <input
                        type="text"
                        value={bForm.ponSerial}
                        onChange={(e) => setBForm({ ...bForm, ponSerial: e.target.value })}
                        disabled={editLoading}
                        className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                          bPonConflict
                            ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                            : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                        }`}
                      />
                      {bPonConflict && (
                        <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          Already exists on <span className="font-semibold">{bPonConflict.deviceSerial}</span>
                          {bPonConflict.productName && <> — <span className="font-semibold">{bPonConflict.productName}</span></>}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        MAC Address
                      </label>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                        Current: {conflictDevice.macAddress || '—'}
                      </p>
                      <input
                        type="text"
                        value={bForm.macAddress}
                        onChange={(e) => setBForm({ ...bForm, macAddress: e.target.value })}
                        disabled={editLoading}
                        className={`w-full px-3 py-2.5 text-xs rounded-xl border bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-mono transition-colors ${
                          bMacConflict
                            ? 'border-rose-400 dark:border-rose-600 bg-rose-50 dark:bg-rose-950/20'
                            : 'border-slate-300 dark:border-slate-700 focus:border-indigo-500 dark:focus:border-indigo-400 focus:ring-1 focus:ring-indigo-500/30'
                        }`}
                      />
                      {bMacConflict && (
                        <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-rose-600 dark:text-rose-400">
                          <AlertCircle className="h-3 w-3 shrink-0" />
                          Already exists on <span className="font-semibold">{bMacConflict.deviceSerial}</span>
                          {bMacConflict.productName && <> — <span className="font-semibold">{bMacConflict.productName}</span></>}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setBForm({ ...editForm });
                        setEditForm({ ...bForm });
                      }}
                      disabled={editLoading}
                      className="w-full px-3 py-2 text-[11px] font-bold rounded-xl border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors cursor-pointer"
                    >
                      ⇄ Swap values between the two devices
                    </button>
                  </div>
                )}
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
                {editLoading ? 'Saving...' : conflictDevice && bChanged ? 'Save Both Corrections' : 'Save Correction'}
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
