import React, { useState } from 'react';
import { CustomerDeviceRecord, Asset, Branch, Product } from '../../types';
import { getWarrantyInfo } from '../../utils/warranty';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import {
  ShieldCheck,
  ShieldAlert,
  Clock,
  Search,
  Building2,
  Barcode,
  Wifi,
  MapPin,
  Calendar,
  Filter,
  CheckCircle2,
  Tag,
  Info,
  X,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface WarrantyProductsProps {
  customerDevices: CustomerDeviceRecord[];
  assets: Asset[];
  branches: Branch[];
  products: Product[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';}

export const WarrantyProducts: React.FC<WarrantyProductsProps> = ({
  customerDevices = [],
  assets = [],
  branches = [],
  products = [],
  selectedBranchId,
  dateMode,}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [warrantyFilter, setWarrantyFilter] = useState<'ALL' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED'>('VALID');
  const [categoryType, setCategoryType] = useState<'ALL' | 'CPE' | 'FIXED_ASSET'>('ALL');
  // Commissioned date range (canonical AD values; DateField converts BS picks).
  // Narrows items by issuedDateAD; an empty bound is open-ended.
  const [issuedFromAD, setIssuedFromAD] = useState('');
  const [issuedToAD, setIssuedToAD] = useState('');

  // Build combined list of warranty-tracked items (CPE customer devices + fixed assets)
  const cpeItems = customerDevices.map((c) => {
    const wInfo = getWarrantyInfo(c.issuedDateAD, c.warrantyMonths || 12);
    const branch = branches.find((b) => b.id === c.branchId);
    return {
      id: c.id,
      type: 'CPE' as const,
      name: c.productName,
      serialOrTag: c.deviceSerial,
      secondarySerial: c.ponSerial,
      macAddress: c.macAddress,
      assignedTo: `${c.customerName} (${c.customerCode})`,
      assignedAddress: c.installationAddress,
      branchId: c.branchId,
      branchName: branch?.name || c.branchId,
      issuedDateAD: c.issuedDateAD,
      status: c.status,
      warrantyInfo: wInfo,
      purchaseBillRef: c.purchaseBillRef,
    };
  });

  const assetItems = assets.map((a) => {
    const wInfo = getWarrantyInfo(a.acquisitionDateAD, 12);
    const branch = branches.find((b) => b.id === a.branchId);
    let assigned = a.assignedCustomerName ? `Customer: ${a.assignedCustomerName}` : a.assignedLocationName ? `Location: ${a.assignedLocationName}` : 'Internal Branch Office / Node';
    return {
      id: a.id,
      type: 'FIXED_ASSET' as const,
      name: a.name,
      serialOrTag: a.tagNumber,
      secondarySerial: '-',
      macAddress: undefined,
      assignedTo: assigned,
      assignedAddress: branch?.location || '-',
      branchId: a.branchId,
      branchName: branch?.name || a.branchId,
      issuedDateAD: a.acquisitionDateAD,
      status: a.status,
      warrantyInfo: wInfo,
      purchaseBillRef: a.invoiceNo,
    };
  });

  const allWarrantyItems = [...cpeItems, ...assetItems];

  const filteredItems = allWarrantyItems.filter((item) => {
    const matchesBranch = selectedBranchId === 'ALL' || item.branchId === selectedBranchId;
    const matchesWarranty =
      warrantyFilter === 'ALL' || item.warrantyInfo.status === warrantyFilter;
    const matchesCat = categoryType === 'ALL' || item.type === categoryType;
    const day = (item.issuedDateAD || '').split('T')[0];
    const matchesDate =
      (!issuedFromAD || (day && day >= issuedFromAD)) &&
      (!issuedToAD || (day && day <= issuedToAD));

    if (!searchQuery.trim()) return matchesBranch && matchesWarranty && matchesCat && matchesDate;

    const q = (searchQuery || '').toLowerCase().trim();
    const matchesQuery =
      (item?.name || '').toLowerCase().includes(q) ||
      (item?.serialOrTag || '').toLowerCase().includes(q) ||
      (item.secondarySerial && (item?.secondarySerial || '').toLowerCase().includes(q)) ||
      (item?.assignedTo || '').toLowerCase().includes(q) ||
      (item?.branchName || '').toLowerCase().includes(q);

    return matchesBranch && matchesWarranty && matchesCat && matchesDate && matchesQuery;
  });

  // Metrics
  const validCount = allWarrantyItems.filter((i) => i.warrantyInfo.status === 'VALID').length;
  const expiringSoonCount = allWarrantyItems.filter((i) => i.warrantyInfo.status === 'EXPIRING_SOON').length;
  const expiredCount = allWarrantyItems.filter((i) => i.warrantyInfo.status === 'EXPIRED').length;

  const warrantyPagination = useClientPagination(filteredItems, 15, [
    searchQuery,
    warrantyFilter,
    categoryType,
    selectedBranchId,
    issuedFromAD,
    issuedToAD,
  ]);

  return (
    <div className="space-y-3">
      {/* Page Title & Sub-Heading */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold text-slate-900 dark:text-slate-100 tracking-tight flex items-center gap-2 break-words leading-tight">
            <ShieldCheck className={`h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0`} />
            <span>Warranty Valid Products Directory</span>
          </h2>
          <p className="truncate text-slate-500 dark:text-slate-400 text-xs mt-1 break-words leading-normal max-w-3xl">
            Centralized registry of active CPE routers, ONU devices, set-top boxes, and fixed assets with active manufacturer or ISP warranty status.
          </p>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className={`rounded-2xl p-4 border shadow-xs transition-colors bg-white border-slate-200 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}>
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 break-words">Total Registered Hardware</div>
          <div className="text-xl font-mono font-bold text-slate-900 dark:text-white mt-1">
            {allWarrantyItems.length} Items
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors bg-emerald-50/50 border-emerald-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}>
          <div className="text-xs font-bold text-emerald-800 dark:text-emerald-400 break-words flex items-center gap-1.5">
            <ShieldCheck className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
            <span>Valid Active Warranty</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-emerald-700 dark:text-emerald-400 mt-1">
            {validCount} Items
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors bg-amber-50/50 border-amber-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}>
          <div className="text-xs font-bold text-amber-800 dark:text-amber-400 break-words flex items-center gap-1.5">
            <Clock className={`h-4 w-4 text-amber-600 dark:text-amber-400`} />
            <span>Expiring Within 30 Days</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-amber-700 dark:text-amber-400 mt-1">
            {expiringSoonCount} Items
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors bg-rose-50/50 border-rose-200 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}>
          <div className="text-xs font-bold text-rose-800 dark:text-rose-400 break-words flex items-center gap-1.5">
            <ShieldAlert className={`h-4 w-4 text-rose-600 dark:text-rose-400`} />
            <span>Expired Warranties</span>
          </div>
          <div className="text-xl font-mono font-extrabold text-rose-700 dark:text-rose-400 mt-1">
            {expiredCount} Items
          </div>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-col md:flex-row md:items-center justify-start gap-3 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
          <Search className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by Device Serial, Tag #, Customer, Product Name, Branch..."
            className="w-full pl-10 pr-4 py-2.5 text-xs text-slate-900 dark:text-slate-100 font-medium bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-xl focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Warranty:</span>
            <select
              value={warrantyFilter}
              onChange={(e) => setWarrantyFilter(e.target.value as any)}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200`}
            >
              <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Statuses</option>
              <option value="VALID" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-emerald-400 dark:font-semibold">VALID (Active)</option>
              <option value="EXPIRING_SOON" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-amber-400 dark:font-semibold">EXPIRING SOON (&lt;30 Days)</option>
              <option value="EXPIRED" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-rose-400 dark:font-semibold">EXPIRED</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Type:</span>
            <select
              value={categoryType}
              onChange={(e) => setCategoryType(e.target.value as any)}
              className={`rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200`}
            >
              <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Types</option>
              <option value="CPE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-blue-400 dark:font-semibold">Customer CPE Devices</option>
              <option value="FIXED_ASSET" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-purple-400 dark:font-semibold">Fixed Assets</option>
            </select>
          </div>

          {/* Commissioned date range (inclusive) — follows the global BS/AD mode */}
          <div className="w-36 sm:w-40">
            <DateField
              mode={dateMode}
              value={issuedFromAD}
              onChange={setIssuedFromAD}
              compact
              max={issuedToAD || undefined}
            />
          </div>
          <span className="text-[10px] font-bold text-slate-400">→</span>
          <div className="w-36 sm:w-40">
            <DateField
              mode={dateMode}
              value={issuedToAD}
              onChange={setIssuedToAD}
              compact
              min={issuedFromAD || undefined}
            />
          </div>
          {(issuedFromAD || issuedToAD) && (
            <button
              type="button"
              onClick={() => { setIssuedFromAD(''); setIssuedToAD(''); }}
              title="Clear date range"
              className="px-1.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Warranty Data Table */}
      <div className={`rounded-2xl border shadow-xs overflow-hidden bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100/90 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 font-bold text-[10px] tracking-wider border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-2.5 py-1.5 break-words max-w-[200px]">Hardware & Category</th>
                <th className="px-2.5 py-1.5 break-words">Serial Number / Tag</th>
                <th className="px-2.5 py-1.5 break-words">Assigned Location / Account</th>
                <th className="px-2.5 py-1.5 break-words">Branch</th>
                <th className="px-2.5 py-1.5 break-words">Commissioned Date</th>
                <th className="px-2.5 py-1.5 break-words">Warranty Expiry</th>
                <th className="px-2.5 py-1.5 text-center break-words">Warranty Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500 dark:text-slate-400 text-xs">
                    No warranty products found matching your current filter criteria.
                  </td>
                </tr>
              ) : (
                warrantyPagination.pagedItems.map((item) => {
                  const w = item.warrantyInfo;
                  return (
                    <tr key={`${item.type}-${item.id}`} className="hover:bg-slate-100/80 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="p-2.5">
                        <div className="font-bold text-slate-900 dark:text-slate-100 text-sm break-words leading-snug">{item.name}</div>
                        <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-md mt-1 ${
                          item.type === 'CPE'
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                            : 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                        }`}>
                          {item.type === 'CPE' ? 'Customer CPE Router' : 'Fixed Asset'}
                        </span>
                      </td>

                      <td className="p-2.5">
                        <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 w-fit font-mono font-bold text-slate-800 dark:text-slate-200 text-xs">
                          <Barcode className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                          <span>{item.serialOrTag}</span>
                        </div>
                        {item.secondarySerial && item.secondarySerial !== '-' && (
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono mt-1">
                            PON: {item.secondarySerial}
                          </div>
                        )}
                      </td>

                      <td className="p-2.5">
                        <div className="font-semibold text-slate-800 dark:text-slate-200 text-xs break-words">{item.assignedTo}</div>
                        {item.assignedAddress && item.assignedAddress !== '-' && (
                          <div className="text-slate-400 dark:text-slate-400 text-[11px] flex items-center gap-1 mt-0.5 break-words">
                            <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                            <span>{item.assignedAddress}</span>
                          </div>
                        )}
                      </td>

                      <td className="p-2.5">
                        <div className="font-bold text-slate-800 dark:text-slate-200 text-xs break-words">{item.branchName}</div>
                      </td>

                      <td className="p-2.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                        {formatDualDate(item.issuedDateAD, dateMode)}
                      </td>

                      <td className="p-2.5 font-mono text-[11px] font-bold text-slate-900 dark:text-slate-100">
                        {formatDualDate(w.warrantyEndDateAD, dateMode)}
                      </td>

                      <td className="p-2.5 text-center">
                        <div
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold uppercase border whitespace-normal break-words max-w-[160px] text-center justify-center ${
                            w.status === 'VALID'
                              ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                              : w.status === 'EXPIRING_SOON'
                              ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                              : 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                          }`}
                        >
                          {w.status === 'VALID' && <ShieldCheck className={`h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0`} />}
                          {w.status === 'EXPIRING_SOON' && <Clock className={`h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0`} />}
                          {w.status === 'EXPIRED' && <ShieldAlert className={`h-3.5 w-3.5 text-rose-600 dark:text-rose-400 shrink-0`} />}
                          <span>{w.label}</span>
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
          page={warrantyPagination.page}
          pageCount={warrantyPagination.pageCount}
          totalItems={warrantyPagination.totalItems}
          rangeStart={warrantyPagination.rangeStart}
          rangeEnd={warrantyPagination.rangeEnd}
          pageSize={warrantyPagination.pageSize}
          onPageChange={warrantyPagination.setPage}
          onPageSizeChange={warrantyPagination.setPageSize}
          className="mt-1"
        />
      </div>
    </div>
  );
};
