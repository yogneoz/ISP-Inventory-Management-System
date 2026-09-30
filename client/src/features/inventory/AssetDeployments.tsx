import React, { useMemo, useState } from 'react';
import { MapPin, UserCheck, Building, Download } from 'lucide-react';
import { Asset, Branch, LocationRecord, CustomerRecord, User } from '../../types';
import { FilterCard } from '../../components/common/FilterCard';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { formatNPR } from '../../utils/nprFormat';
import { exportToCSV } from '../../utils/exportUtils';
import { getAllowedBranches } from '../../utils/permissions';
import { useDialog } from '../../components/common/DialogProvider';

interface AssetDeploymentsProps {
  assets: Asset[];
  branches: Branch[];
  locations: LocationRecord[];
  customers: CustomerRecord[];
  currentUser?: User | null;
  dateMode: 'BS' | 'AD';
  /** Marks the asset unassigned (back to ACTIVE stock) — same payload as StockOperations' unassign flow. */
  onUnassignAsset: (id: string, updates: Partial<Asset>) => Promise<void>;
}

/**
 * ASSET DEPLOYMENTS — operational register of every assigned fixed asset
 * (POP/network-site deployments AND customer rental CPEs).
 *
 * Exists separately from the finance Fixed Asset Register (depreciation/NBV
 * view) and from Serial Log (serialized devices only): assets WITHOUT serials
 * are invisible there, but fully tracked here once assigned.
 */
export const AssetDeployments: React.FC<AssetDeploymentsProps> = ({
  assets,
  branches,
  locations,
  currentUser,
  dateMode,
  onUnassignAsset,
}) => {
  const { confirm: confirmDialog } = useDialog();
  const [appliedSearch, setAppliedSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('ALL');
  const [locationFilter, setLocationFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'LOCATION' | 'CUSTOMER'>('ALL');

  const allowedBranches = useMemo(() => getAllowedBranches(currentUser, branches), [currentUser, branches]);
  const popLocations = useMemo(
    () => locations.filter((l) => l.type === 'POP_SERVER_ROOM' || l.type === 'FIBER_NETWORK_NODE' || !l.type),
    [locations]
  );

  const assignedAssets = useMemo(
    () =>
      assets.filter(
        (a) => a.status === 'ASSIGNED_TO_LOCATION' || a.status === 'ASSIGNED_TO_CUSTOMER' || Boolean(a.assignedType)
      ),
    [assets]
  );

  const filtered = useMemo(() => {
    const q = appliedSearch.trim().toLowerCase();
    return assignedAssets.filter((a) => {
      if (branchFilter !== 'ALL' && a.branchId !== branchFilter) return false;
      if (typeFilter !== 'ALL' && a.assignedType !== typeFilter) return false;
      if (locationFilter !== 'ALL' && a.assignedLocationId !== locationFilter) return false;
      if (!q) return true;
      return (
        a.tagNumber.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.assignedCustomerName || '').toLowerCase().includes(q) ||
        (a.assignedLocationName || '').toLowerCase().includes(q) ||
        (a.assignmentNotes || '').toLowerCase().includes(q)
      );
    });
  }, [assignedAssets, appliedSearch, branchFilter, locationFilter, typeFilter]);

  const pagination = useClientPagination(filtered, 15, [appliedSearch, branchFilter, locationFilter, typeFilter]);

  const handleUnassign = async (asset: Asset) => {
    if (
      await confirmDialog(
        `Unassign "${asset.name}" (${asset.tagNumber}) and return it to Available Stock?`
      )
    ) {
      await onUnassignAsset(asset.id, {
        status: 'ACTIVE',
        assignedType: undefined,
        assignedLocationId: undefined,
        assignedLocationName: undefined,
        assignedCustomerId: undefined,
        assignedCustomerName: undefined,
        assignmentDateAD: undefined,
        assignmentDateBS: undefined,
        assignmentNotes: undefined,
      });
    }
  };

  const handleExport = () => {
    exportToCSV({
      filename: 'Asset_Deployments',
      reportTitle: 'Asset Deployments (assigned fixed assets & rental CPEs)',
      branchName: branchFilter === 'ALL' ? 'All Branches' : branches.find((b) => b.id === branchFilter)?.name || branchFilter,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filtered.map((a) => ({
        tagNumber: a.tagNumber,
        name: a.name,
        category: a.category,
        deployedTo:
          a.assignedType === 'LOCATION'
            ? a.assignedLocationName || a.assignedLocationId || ''
            : a.assignedCustomerName || a.assignedCustomerId || '',
        deploymentType: a.assignedType === 'LOCATION' ? 'POP / Network Site' : 'Customer Site',
        branchName: branches.find((b) => b.id === a.branchId)?.name || a.branchId,
        assignedDate: dateMode === 'BS' ? a.assignmentDateBS || '' : a.assignmentDateAD || '',
        notes: a.assignmentNotes || '',
        netBookValue: a.netBookValue,
      })),
      columns: [
        { key: 'tagNumber', label: 'Asset Tag' },
        { key: 'name', label: 'Asset Name' },
        { key: 'category', label: 'Category' },
        { key: 'deployedTo', label: 'Deployed To' },
        { key: 'deploymentType', label: 'Deployment Type' },
        { key: 'branchName', label: 'Branch' },
        { key: 'assignedDate', label: `Assigned Date (${dateMode})` },
        { key: 'notes', label: 'Notes' },
        { key: 'netBookValue', label: 'NBV (NPR)' },
      ],
    });
  };

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
            <MapPin className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <span>Asset Deployments</span>
          </h2>
          <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">
            Every assigned fixed asset — POP / network-site deployments and customer rental CPEs — including items without device serials (not visible in the Serial Log).
          </p>
        </div>
        <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800">
          {filtered.length} Deployment{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Filters */}
      <FilterCard
        searchPlaceholder="Search asset tag, name, customer, location, or notes..."
        searchValue={appliedSearch}
        onSearchApply={setAppliedSearch}
        hasActiveFilters={
          Boolean(appliedSearch) || branchFilter !== 'ALL' || locationFilter !== 'ALL' || typeFilter !== 'ALL'
        }
        onClearAll={() => {
          setAppliedSearch('');
          setBranchFilter('ALL');
          setLocationFilter('ALL');
          setTypeFilter('ALL');
        }}
        filterChildren={
          <>
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
            >
              <option value="ALL">All Branches</option>
              {allowedBranches.map((b) => (
                <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
              ))}
            </select>

            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
            >
              <option value="ALL">All POP Locations</option>
              {popLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'ALL' | 'LOCATION' | 'CUSTOMER')}
              className="rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
            >
              <option value="ALL">All Types</option>
              <option value="LOCATION">POP / Network Site</option>
              <option value="CUSTOMER">Customer Site</option>
            </select>
          </>
        }
        rightChildren={
          <button
            onClick={handleExport}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
        }
      />

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="p-8 rounded-2xl border border-dashed text-center bg-white border-slate-300 text-slate-500 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-400">
          <Building className="h-9 w-9 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
          <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200">No Asset Deployments Found</h3>
          <p className="text-[11px] text-slate-400 max-w-md mx-auto mt-0.5">
            No assigned assets match the current filters. Deployed assets appear here the moment they are assigned from the Assign Fixed Asset form.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800">
                <tr>
                  <th className="px-2.5 py-2">Asset Tag</th>
                  <th className="px-2.5 py-2">Asset</th>
                  <th className="px-2.5 py-2">Category</th>
                  <th className="px-2.5 py-2">Deployed To</th>
                  <th className="px-2.5 py-2">Type</th>
                  <th className="px-2.5 py-2">Branch</th>
                  <th className="px-2.5 py-2">Assigned ({dateMode})</th>
                  <th className="px-2.5 py-2 text-right">NBV (NPR)</th>
                  <th className="px-2.5 py-2 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {pagination.pagedItems.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-200/60 dark:hover:bg-slate-800/40">
                    <td className="p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">{a.tagNumber}</td>
                    <td className="p-2.5 font-bold text-slate-900 dark:text-white">
                      {a.name}
                      {a.assignmentNotes && (
                        <div className="text-[10px] text-slate-400 italic font-normal truncate max-w-[220px]">{a.assignmentNotes}</div>
                      )}
                    </td>
                    <td className="p-2.5 text-slate-500">{a.category}</td>
                    <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">
                      <span className="flex items-center gap-1.5">
                        {a.assignedType === 'LOCATION' ? (
                          <MapPin className="h-3 w-3 text-indigo-500 shrink-0" />
                        ) : (
                          <UserCheck className="h-3 w-3 text-purple-500 shrink-0" />
                        )}
                        <span className="truncate max-w-[220px]">
                          {a.assignedType === 'LOCATION'
                            ? a.assignedLocationName || a.assignedLocationId
                            : a.assignedCustomerName || a.assignedCustomerId}
                        </span>
                      </span>
                    </td>
                    <td className="p-2.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                        a.assignedType === 'LOCATION'
                          ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
                          : 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30'
                      }`}>
                        {a.assignedType === 'LOCATION' ? 'POP / Node' : 'Customer'}
                      </span>
                    </td>
                    <td className="p-2.5 text-slate-500">{branches.find((b) => b.id === a.branchId)?.name || a.branchId}</td>
                    <td className="p-2.5 font-mono text-slate-400 text-[11px]">
                      {dateMode === 'BS' ? a.assignmentDateBS || '—' : a.assignmentDateAD || '—'}
                    </td>
                    <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">{formatNPR(a.netBookValue)}</td>
                    <td className="p-2.5 text-center">
                      <button
                        onClick={() => handleUnassign(a)}
                        className="text-rose-600 dark:text-rose-400 hover:underline font-bold cursor-pointer text-[11px]"
                      >
                        Unassign
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={pagination.page}
            pageCount={pagination.pageCount}
            totalItems={pagination.totalItems}
            rangeStart={pagination.rangeStart}
            rangeEnd={pagination.rangeEnd}
            pageSize={pagination.pageSize}
            onPageChange={pagination.setPage}
            onPageSizeChange={pagination.setPageSize}
          />
        </div>
      )}
    </div>
  );
};

export default AssetDeployments;
