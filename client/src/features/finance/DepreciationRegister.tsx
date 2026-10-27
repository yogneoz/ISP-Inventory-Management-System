import React, { useEffect, useRef, useState } from 'react';
import { Asset, Branch, CompanyProfile, FixedAssetGroup, FixedAssetTotals } from '../../types';
import { api } from '../../services/api';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { calculateFixedAssetValues } from '../../utils/depreciation';
import { formatNPRPrecise } from '../../utils/nprFormat';
import { DocumentLetterhead } from '../../components/common/DocumentLetterhead';
import { FilterCard } from '../../components/common/FilterCard';
import { PageHeader } from '../../components/common/PageHeader';
import {
  Calculator,
  Download,
  Printer,
  TrendingDown,
  Landmark,
  ChevronDown,
  ChevronRight,
  Calendar,
  Layers,
  FileText,
} from 'lucide-react';
import { StatCard } from '../../components/common/StatCard';
import { useServerPageClamp, TablePagination } from '../../components/common/TablePagination';
import { RegisterLoadError } from '../../components/common/RegisterLoadError';
import { useDialog } from '../../components/common/DialogProvider';

const ZERO_TOTALS: FixedAssetTotals = { acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 };

interface DepreciationRegisterProps {
  /** ASSET-1: grouped summary + overview from the server; date-wise view paged. */
  refreshToken?: number;
  branches: Branch[];
  selectedBranchId: string;
  asOfDateAD?: string;
  dateMode: 'BS' | 'AD';
  companyProfile?: CompanyProfile | null;
}

export const DepreciationRegister: React.FC<DepreciationRegisterProps> = ({
  refreshToken = 0,
  branches,
  selectedBranchId,
  asOfDateAD,
  dateMode,
  companyProfile,
}) => {
  const { alert: alertDialog } = useDialog();
  const [activeTab, setActiveTab] = useState<'SUMMARY' | 'DATE_WISE'>('SUMMARY');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Server reads (ASSET-1). The summary groups and the KPI totals come from
  // /overview; the date-wise tab pages through /page ordered by invoice date.
  const [groups, setGroups] = useState<FixedAssetGroup[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [totals, setTotals] = useState<FixedAssetTotals>(ZERO_TOTALS);
  const [overviewTotal, setOverviewTotal] = useState(0);
  const [rows, setRows] = useState<Asset[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const [groupLots, setGroupLots] = useState<Record<string, Asset[]>>({});
  const [groupLoading, setGroupLoading] = useState<Record<string, boolean>>({});
  const requestSeq = useRef(0);

  const scopedParams = {
    branchId: selectedBranchId,
    query: searchQuery || undefined,
    category: categoryFilter === 'ALL' ? undefined : categoryFilter,
  } as const;

  const filterKey = [selectedBranchId, searchQuery, categoryFilter].join('|');
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey);
    if (page !== 1) setPage(1);
  }

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError('');
    Promise.all([
      api.getFixedAssetOverview({ ...scopedParams, asOf: asOfDateAD, groupBy: 'master', categories: true }),
      activeTab === 'DATE_WISE'
        ? api.getFixedAssetPage({ ...scopedParams, sort: 'invoiceDate' }, page, pageSize)
        : Promise.resolve(null),
    ])
      .then(([overview, pageResult]) => {
        if (seq !== requestSeq.current) return;
        setGroups(overview?.groups ?? []);
        setCategories(overview?.categories ?? []);
        setTotals(overview?.totals ?? ZERO_TOTALS);
        setOverviewTotal(Number(overview?.total) || 0);
        if (pageResult) {
          setRows(Array.isArray(pageResult.data) ? pageResult.data : []);
          setTotalItems(Number(pageResult.totalItems) || 0);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setLoadError(err?.message || 'Could not load the depreciation register.');
        setLoading(false);
      });
  }, [selectedBranchId, searchQuery, categoryFilter, asOfDateAD, activeTab, page, pageSize, refreshToken, retryToken]);

  const safePage = useServerPageClamp(page, pageSize, totalItems, setPage);
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const rangeEnd = Math.min(safePage * pageSize, totalItems);

  const toggleGroupExpand = (group: FixedAssetGroup) => {
    const willExpand = !expandedGroups[group.key];
    setExpandedGroups((prev) => ({ ...prev, [group.key]: willExpand }));
    // The group's purchase lots are fetched lazily, bounded, instead of being
    // carried with the whole table.
    if (!willExpand || groupLots[group.key] || groupLoading[group.key]) return;
    setGroupLoading((prev) => ({ ...prev, [group.key]: true }));
    api
      .getFixedAssetPage({ ...scopedParams, query: group.masterName, category: group.category }, 1, 200)
      .then((result) => setGroupLots((prev) => ({ ...prev, [group.key]: result.data })))
      .catch(() => setGroupLots((prev) => ({ ...prev, [group.key]: [] })))
      .finally(() => setGroupLoading((prev) => ({ ...prev, [group.key]: false })));
  };

  const totalCost = totals.acquisitionCost;
  const totalAccumDep = totals.accumulatedDepreciation;
  const totalNBV = totals.netBookValue;

  const handleExportCSV = async () => {
    if (activeTab === 'SUMMARY') {
      const data = groups.map((g) => ({
        AssetTitle: g.masterName,
        Category: g.category,
        PurchaseLotsCount: g.lotCount,
        Method: g.depreciationMethod === 'STRAIGHT_LINE' ? 'Straight Line' : 'Declining Balance / WDV',
        RatePercent: `${g.depreciationRatePercent ?? 0}%`,
        GrossAcquisitionCost: g.totals.acquisitionCost,
        AccumulatedDepreciation: g.totals.accumulatedDepreciation,
        NetBookValue: g.totals.netBookValue,
      }));

      exportToCSV('Fixed_Asset_Summary_Depreciation_Register', data, [
        { key: 'AssetTitle', label: 'Master Asset Title' },
        { key: 'Category', label: 'Category' },
        { key: 'PurchaseLotsCount', label: 'Purchase Lots' },
        { key: 'Method', label: 'Depreciation Method' },
        { key: 'RatePercent', label: 'Annual Rate' },
        { key: 'GrossAcquisitionCost', label: 'Gross Cost' },
        { key: 'AccumulatedDepreciation', label: 'Accumulated Depreciation' },
        { key: 'NetBookValue', label: 'Net Book Value' },
      ], companyProfile);
    } else {
      let exportRows = rows;
      let truncated = false;
      try {
        const exported = await api.getFixedAssetExport({ ...scopedParams, sort: 'invoiceDate' });
        exportRows = exported.data;
        truncated = Boolean(exported.truncated);
      } catch {
        // Keep the visible page rather than exporting nothing.
      }
      // ASSET-1: a capped export is reported, never silently cut at 20,000 rows.
      if (truncated) {
        await alertDialog(
          'The export was capped at 20,000 rows. Narrow the branch, category or search filters before exporting the rest.'
        );
      }
      const data = exportRows.map((a) => {
        const bObj = branches.find((b) => b.id === a.branchId);
        return {
          PartyInvoiceDateAD: a.purchaseInvoiceDateAD || a.acquisitionDateAD,
          PartyInvoiceDateBS: a.purchaseInvoiceDateBS || a.acquisitionDateBS,
          InvoiceNumber: a.invoiceNo || 'N/A',
          Supplier: a.supplierName || 'N/A',
          TagNumber: a.tagNumber,
          AssetTitle: a.name,
          Category: a.category,
          Branch: bObj?.name || 'Central Headquarter',
          AcquisitionCost: a.acquisitionCost,
          Method: a.depreciationMethod === 'STRAIGHT_LINE' ? 'Straight Line' : 'Declining Balance / WDV',
          RatePercent: `${a.depreciationRatePercent}%`,
          AccumulatedDepreciation: calculateFixedAssetValues({
            ...a,
            acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD,
            asOfDateAD,
          }).accumulatedDepreciation,
          NetBookValue: calculateFixedAssetValues({
            ...a,
            acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD,
            asOfDateAD,
          }).netBookValue,
        };
      });

      exportToCSV('Datewise_Purchase_Depreciation_Register', data, [
        { key: 'PartyInvoiceDateAD', label: 'Invoice Date (AD)' },
        { key: 'PartyInvoiceDateBS', label: 'Invoice Date (BS)' },
        { key: 'InvoiceNumber', label: 'Party Invoice #' },
        { key: 'Supplier', label: 'Supplier / Vendor' },
        { key: 'TagNumber', label: 'Tag Number' },
        { key: 'AssetTitle', label: 'Asset Title' },
        { key: 'Category', label: 'Category' },
        { key: 'AcquisitionCost', label: 'Purchase Cost' },
        { key: 'Method', label: 'Method' },
        { key: 'RatePercent', label: 'Annual Rate' },
        { key: 'AccumulatedDepreciation', label: 'Accumulated Depreciation' },
        { key: 'NetBookValue', label: 'Net Book Value' },
      ]);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="printable-document space-y-6">
      {/* Company letterhead — print/export only (hidden on screen) */}
      <DocumentLetterhead
        companyProfile={companyProfile}
        title="Fixed Asset Depreciation Register"
        subtitle="Statutory tax depreciation schedules, lot-level acquisition date calculations, accumulated write-offs, and Net Book Value (NBV)."
      />

      {/* Header — shared PageHeader (single h2 per screen rule). */}
      <PageHeader
        title="Tax Depreciation Schedule"
        description="Statutory tax depreciation schedules, lot-level acquisition date calculations, accumulated write-offs, and Net Book Value (NBV)."
        icon={<Calculator className="h-5 w-5 text-indigo-500" />}
        actions={
          <>
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5 text-slate-400" />
              <span>Export Schedule ({activeTab === 'SUMMARY' ? 'Summary' : 'Datewise'})</span>
            </button>

            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Printer className="h-3.5 w-3.5 text-slate-400" />
              <span>Print Register</span>
            </button>
          </>
        }
      />

      {/* Sub-menu Navigation Tabs */}
      <div className={`p-1.5 rounded-2xl border flex items-center gap-2 w-fit bg-slate-100 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
        <button
          onClick={() => setActiveTab('SUMMARY')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${activeTab === 'SUMMARY' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
        >
          <Layers className="h-4 w-4" />
          <span>Summary Register (Grouped by Asset)</span>
          <span className={`px-1.5 py-0.2 text-[10px] rounded-full font-mono ${
            activeTab === 'SUMMARY' ? 'bg-indigo-500/40 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
          }`}>
            {groups.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('DATE_WISE')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${activeTab === 'DATE_WISE' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}
        >
          <Calendar className="h-4 w-4" />
          <span>Datewise Purchase Register (Lot Audit Log)</span>
          <span className={`px-1.5 py-0.2 text-[10px] rounded-full font-mono ${
            activeTab === 'DATE_WISE' ? 'bg-indigo-500/40 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
          }`}>
            {totalItems.toLocaleString('en-IN')} Lots
          </span>
        </button>
      </div>

      {/* Summary KPI Cards — shared compact StatCard component */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          label="GROSS ACQUISITION COST"
          icon={<Landmark className="h-4 w-4" />}
          tone="emerald"
          value={formatNPRPrecise(totalCost)}
          hint={`Total capital expenditure across ${overviewTotal} purchase lots`}
        />
        <StatCard
          label="TOTAL ACCUMULATED DEPRECIATION"
          icon={<TrendingDown className="h-4 w-4" />}
          tone="rose"
          value={formatNPRPrecise(totalAccumDep)}
          hint="Cumulative depreciation write-offs to date"
        />
        <StatCard
          label="NET BOOK VALUE (NBV)"
          icon={<Calculator className="h-4 w-4" />}
          tone="indigo"
          value={formatNPRPrecise(totalNBV)}
          hint="Carrying value on corporate balance sheet"
        />
      </div>

      {/* Filter and Search Bar — shared FilterCard for register consistency. */}
      <FilterCard
        searchPlaceholder="Search Asset Title, Invoice #, Tag #, Supplier..."
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={Boolean(searchQuery) || categoryFilter !== 'ALL'}
        onClearAll={() => {
          setSearchQuery('');
          setCategoryFilter('ALL');
        }}
        filterChildren={
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Category</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border text-xs font-semibold focus:outline-none bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-white cursor-pointer"
            >
              <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                  {cat}
                </option>
              ))}
            </select>
          </div>
        }
      />

      {loadError && (
        <RegisterLoadError
          subject="the depreciation register"
          message={loadError}
          hasCachedRows={groups.length > 0 || rows.length > 0}
          loading={loading}
          onRetry={() => setRetryToken((n) => n + 1)}
        />
      )}

      {/* Active Register View Table */}
      {activeTab === 'SUMMARY' ? (
        /* SUMMARY REGISTER WITH EXPANDABLE PURCHASE LOT ROWS */
        <div
          className={`rounded-2xl border overflow-hidden bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`border-b font-bold uppercase tracking-wider text-[10px] bg-slate-50 border-slate-200 text-slate-500 dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-400`}
              >
                <tr>
                  <th className="w-10 px-2.5 py-1.5 text-center"></th>
                  <th className="px-2.5 py-1.5">Master Fixed Asset Title</th>
                  <th className="px-2.5 py-1.5">Category</th>
                  <th className="px-2.5 py-1.5 text-center">Purchase Lots</th>
                  <th className="px-2.5 py-1.5 text-center">Depr. Method & Rate</th>
                  <th className="px-2.5 py-1.5 text-right">Total Acquisition Cost (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Accumulated Depreciation (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Net Book Value (NPR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                {groups.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                      {loading ? 'Loading depreciation summary…' : 'No fixed assets found matching filter criteria.'}
                    </td>
                  </tr>
                ) : (
                  groups.map((grp) => {
                    const isExpanded = !!expandedGroups[grp.key];
                    return (
                      <React.Fragment key={grp.key}>
                        {/* Parent Summary Row */}
                        <tr
                          onClick={() => toggleGroupExpand(grp)}
                          className={`cursor-pointer transition-colors ${isExpanded ? 'bg-indigo-50/50 dark:bg-indigo-950/30' : 'hover:bg-slate-200 text-slate-800 dark:hover:bg-slate-800/40 dark:text-slate-200'}`}
                        >
                          <td className="px-2.5 py-1.5 text-center">
                            <button className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400">
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-indigo-500" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </td>
                          <td className="px-2.5 py-1.5">
                            <div className="font-bold text-sm text-slate-900 dark:text-white flex items-center gap-2">
                              <span>{grp.masterName}</span>
                              <span className="text-[10px] font-normal px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700">
                                {grp.lotCount} Lot{grp.lotCount > 1 ? 's' : ''}
                              </span>
                            </div>
                          </td>
                          <td className="px-2.5 py-1.5 text-slate-500">{grp.category}</td>
                          <td className="px-2.5 py-1.5 text-center">
                            <span className={`inline-flex items-center gap-1 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                              <Layers className="h-3.5 w-3.5" />
                              {grp.lotCount} Batch{grp.lotCount > 1 ? 'es' : ''}
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-center">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                              {grp.depreciationMethod === 'STRAIGHT_LINE' ? 'Straight Line' : 'Declining / WDV'} ({grp.depreciationRatePercent ?? 15}%)
                            </span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                            {formatNPRPrecise(grp.totals.acquisitionCost)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono text-rose-500 font-bold">
                            {formatNPRPrecise(grp.totals.accumulatedDepreciation)}
                          </td>
                          <td className={`px-2.5 py-1.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400`}>
                            {formatNPRPrecise(grp.totals.netBookValue)}
                          </td>
                        </tr>

                        {/* Expanded Child Purchase Lot Rows */}
                        {isExpanded && (
                          <tr className="bg-slate-50/80 dark:bg-slate-950/80">
                            <td colSpan={8} className="p-2.5 pl-12 border-t border-b border-indigo-200 dark:border-indigo-900/40">
                              <div className="space-y-2">
                                <div className={`text-[11px] font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5 uppercase tracking-wider`}>
                                  <FileText className="h-3.5 w-3.5" />
                                  <span>Individual Purchase Invoices & Datewise Depreciation Lots ({grp.masterName})</span>
                                </div>
                                {groupLoading[grp.key] && !groupLots[grp.key] && (
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Loading purchase lots…</p>
                                )}
                                {(groupLots[grp.key]?.length ?? 0) < grp.lotCount && !groupLoading[grp.key] && (
                                  <p className="text-[10px] text-slate-500 dark:text-slate-400">
                                    Showing {(groupLots[grp.key] || []).length} of {grp.lotCount} purchase lots — use the date-wise register or search to reach the rest.
                                  </p>
                                )}
                                <table className="w-full text-left text-[11px] border rounded-xl overflow-hidden bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800">
                                  <thead className="bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 font-bold text-[9px] tracking-wider">
                                    <tr>
                                      <th className="px-2.5 py-1.5">Party Invoice Date (AD / BS)</th>
                                      <th className="px-2.5 py-1.5">Party Invoice Ref #</th>
                                      <th className="px-2.5 py-1.5">Supplier / Vendor</th>
                                      <th className="px-2.5 py-1.5">Tag Number</th>
                                      <th className="px-2.5 py-1.5 text-right">Lot Cost (NPR)</th>
                                      <th className="px-2.5 py-1.5 text-right">Accumulated Depreciation (NPR)</th>
                                      <th className="px-2.5 py-1.5 text-right">Net Book Value (NPR)</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
                                    {(groupLots[grp.key] || []).map((lot) => (
                                      <tr key={lot.id} className="hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20">
                                        <td className={`px-2.5 py-1.5 font-bold text-indigo-600 dark:text-indigo-400`}>
                                          {lot.acquisitionDateAD} ({lot.acquisitionDateBS})
                                        </td>
                                        <td className="px-2.5 py-1.5 text-slate-700 dark:text-slate-300 font-semibold">
                                          {lot.invoiceNo || 'DIRECT-ENTRY'}
                                        </td>
                                        <td className="px-2.5 py-1.5 text-slate-600 dark:text-slate-400 font-sans">
                                          {lot.supplierName || 'N/A'}
                                        </td>
                                        <td className="px-2.5 py-1.5 font-bold text-slate-800 dark:text-slate-200">
                                          {lot.tagNumber}
                                        </td>
                                        <td className="px-2.5 py-1.5 text-right font-bold text-slate-900 dark:text-white">
                                          {formatNPRPrecise(lot.acquisitionCost)}
                                        </td>
                                        <td className="px-2.5 py-1.5 text-right text-rose-500 font-semibold">
                                          {formatNPRPrecise(calculateFixedAssetValues({ ...lot, acquisitionDateAD: lot.placedInServiceDateAD || lot.acquisitionDateAD, asOfDateAD }).accumulatedDepreciation)}
                                        </td>
                                        <td className={`px-2.5 py-1.5 text-right text-emerald-600 dark:text-emerald-400 font-extrabold`}>
                                          {formatNPRPrecise(calculateFixedAssetValues({ ...lot, acquisitionDateAD: lot.placedInServiceDateAD || lot.acquisitionDateAD, asOfDateAD }).netBookValue)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
              <tfoot
                className={`border-t font-bold text-xs bg-slate-100 border-slate-200 text-slate-800 dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-200`}
              >
                <tr>
                  <td colSpan={5} className="px-2.5 py-1.5 text-right uppercase tracking-wider">
                    Total Fixed Asset Summary Schedule:
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-slate-900 dark:text-white">
                    {formatNPRPrecise(totalCost)}
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-rose-500">
                    {formatNPRPrecise(totalAccumDep)}
                  </td>
                  <td className={`px-2.5 py-1.5 text-right font-mono text-indigo-600 dark:text-indigo-400`}>
                    {formatNPRPrecise(totalNBV)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : (
        /* DATEWISE PURCHASE REGISTER (DETAILED AUDIT LOG) */
        <div
          className={`rounded-2xl border overflow-hidden bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead
                className={`border-b font-bold uppercase tracking-wider text-[10px] bg-slate-50 border-slate-200 text-slate-500 dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-400`}
              >
                <tr>
                  <th className="px-2.5 py-1.5">Party Invoice Date</th>
                  <th className="px-2.5 py-1.5">Invoice Ref #</th>
                  <th className="px-2.5 py-1.5">Supplier / Vendor</th>
                  <th className="px-2.5 py-1.5">Asset Tag # & Title</th>
                  <th className="px-2.5 py-1.5">Category</th>
                  <th className="px-2.5 py-1.5 text-right">Purchase Cost (NPR)</th>
                  <th className="px-2.5 py-1.5 text-center">Depr. Rate</th>
                  <th className="px-2.5 py-1.5 text-right">Accum. Depr. (NPR)</th>
                  <th className="px-2.5 py-1.5 text-right">Net Book Value (NPR)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                      {loading ? 'Loading purchase lots…' : 'No purchase lots found matching filter criteria.'}
                    </td>
                  </tr>
                ) : (
                  rows.map((asset) => (
                    <tr
                      key={asset.id}
                      className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 transition-colors text-slate-800 dark:text-slate-300`}
                    >
                      <td className={`px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                        <div className="flex items-center gap-1.5">
                          <Calendar className="h-3.5 w-3.5 text-slate-400" />
                          <span>{formatDualDate(asset.acquisitionDateAD, dateMode)}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-normal">
                          {asset.acquisitionDateBS}
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                        {asset.invoiceNo || 'N/A'}
                      </td>
                      <td className="px-2.5 py-1.5 font-semibold text-slate-700 dark:text-slate-300">
                        {asset.supplierName || 'Central Procurement'}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <div className="font-mono text-indigo-500 font-bold text-[11px]">{asset.tagNumber}</div>
                        <div className="font-bold text-slate-900 dark:text-white">{asset.name}</div>
                      </td>
                      <td className="px-2.5 py-1.5 text-slate-500">{asset.category}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                        {formatNPRPrecise(asset.acquisitionCost)}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                          {asset.depreciationRatePercent ?? 15}% ({asset.depreciationMethod === 'STRAIGHT_LINE' ? 'SLM' : 'WDV'})
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono text-rose-500 font-semibold">
                        {formatNPRPrecise(calculateFixedAssetValues({ ...asset, acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD, asOfDateAD }).accumulatedDepreciation)}
                      </td>
                      <td className={`px-2.5 py-1.5 text-right font-mono font-extrabold text-emerald-600 dark:text-emerald-400`}>
                        {(calculateFixedAssetValues({ ...asset, acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD, asOfDateAD }).netBookValue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot
                className={`border-t font-bold text-xs bg-slate-100 border-slate-200 text-slate-800 dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-200`}
              >
                <tr>
                  <td colSpan={5} className="px-2.5 py-1.5 text-right uppercase tracking-wider">
                    Total Datewise Purchase Lots Schedule:
                  </td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-slate-900 dark:text-white">
                    {formatNPRPrecise(totalCost)}
                  </td>
                  <td></td>
                  <td className="px-2.5 py-1.5 text-right font-mono text-rose-500">
                    {formatNPRPrecise(totalAccumDep)}
                  </td>
                  <td className={`px-2.5 py-1.5 text-right font-mono text-indigo-600 dark:text-indigo-400`}>
                    {formatNPRPrecise(totalNBV)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <TablePagination
            page={safePage}
            pageCount={pageCount}
            totalItems={totalItems}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </div>
      )}
    </div>
  );
};
