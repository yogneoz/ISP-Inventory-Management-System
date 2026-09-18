import React, { useState } from 'react';
import { Asset, Branch, CompanyProfile } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { calculateFixedAssetValues } from '../../utils/depreciation';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import { DocumentLetterhead } from '../../components/common/DocumentLetterhead';
import {
  Calculator,
  Download,
  Printer,
  Search,
  TrendingDown,
  Landmark,
  ChevronDown,
  ChevronRight,
  Calendar,
  Layers,
  FileText,
  Tag,
} from 'lucide-react';

interface DepreciationRegisterProps {
  assets: Asset[];
  branches: Branch[];
  selectedBranchId: string;
  asOfDateAD?: string;
  dateMode: 'BS' | 'AD';
  companyProfile?: CompanyProfile | null;
}

interface AssetGroup {
  key: string;
  masterName: string;
  category: string;
  depreciationMethod?: string;
  depreciationRatePercent?: number;
  totalCost: number;
  totalAccumDep: number;
  totalNBV: number;
  lotCount: number;
  lots: Asset[];
}

export const DepreciationRegister: React.FC<DepreciationRegisterProps> = ({
  assets,
  branches,
  selectedBranchId,
  asOfDateAD,
  dateMode,
  companyProfile,
}) => {
  const [activeTab, setActiveTab] = useState<'SUMMARY' | 'DATE_WISE'>('SUMMARY');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toggleGroupExpand = (groupKey: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const filteredAssets = (assets || []).filter((asset) => {
    const matchesBranch = selectedBranchId === 'ALL' || asset.branchId === selectedBranchId;
    const matchesSearch =
      !searchQuery ||
      asset.name?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      asset.tagNumber?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      asset.invoiceNo?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      asset.supplierName?.toLowerCase().includes((searchQuery || '').toLowerCase());
    const matchesCategory = categoryFilter === 'ALL' || asset.category === categoryFilter;

    return matchesBranch && matchesSearch && matchesCategory;
  });

  // Group assets by Master Asset Name / Category for Summary view
  const groupedSummaryMap = filteredAssets.reduce((acc, asset) => {
    // Strip trailing "(Lot Qty: X)" if present to get standard master title
    const cleanMasterName = asset.name ? asset.name.replace(/\s*\(Lot Qty:\s*\d+\)/i, '').trim() : 'Uncategorized Asset';
    const key = `${asset.category}___${cleanMasterName}`;

    if (!acc[key]) {
      acc[key] = {
        key,
        masterName: cleanMasterName,
        category: asset.category,
        depreciationMethod: asset.depreciationMethod,
        depreciationRatePercent: asset.depreciationRatePercent,
        totalCost: 0,
        totalAccumDep: 0,
        totalNBV: 0,
        lotCount: 0,
        lots: [],
      };
    }

    const financials = calculateFixedAssetValues({ ...asset, acquisitionDateAD: asset.placedInServiceDateAD || asset.acquisitionDateAD, asOfDateAD });
    acc[key].totalCost += Number(asset.acquisitionCost ?? 0);
    acc[key].totalAccumDep += Number(financials.accumulatedDepreciation ?? 0);
    acc[key].totalNBV += Number(financials.netBookValue ?? 0);
    acc[key].lotCount += 1;
    acc[key].lots.push(asset);

    return acc;
  }, {} as Record<string, AssetGroup>);

  const groupedSummaryList: AssetGroup[] = Object.values(groupedSummaryMap);

  // Overall KPI totals — ensure numeric addition by wrapping with Number()
  const totalCost = filteredAssets.reduce((sum, a) => sum + Number(a.acquisitionCost ?? 0), 0);
  const totalAccumDep = filteredAssets.reduce(
    (sum, a) => sum + Number(calculateFixedAssetValues({ ...a, acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD, asOfDateAD }).accumulatedDepreciation ?? 0),
    0
  );
  const totalNBV = filteredAssets.reduce(
    (sum, a) => sum + Number(calculateFixedAssetValues({ ...a, acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD, asOfDateAD }).netBookValue ?? 0),
    0
  );

  const categories = Array.from(new Set((assets || []).map((a) => a.category)));

  // Sorted list for Date wise view (Newest Party Invoice Date first)
  const sortedDatewiseAssets = [...filteredAssets].sort((a, b) => {
    const dateA = a.purchaseInvoiceDateAD || a.acquisitionDateAD || '';
    const dateB = b.purchaseInvoiceDateAD || b.acquisitionDateAD || '';
    return dateB.localeCompare(dateA);
  });

  const handleExportCSV = () => {
    if (activeTab === 'SUMMARY') {
      const data = groupedSummaryList.map((g) => ({
        AssetTitle: g.masterName,
        Category: g.category,
        PurchaseLotsCount: g.lotCount,
        Method: g.depreciationMethod === 'STRAIGHT_LINE' ? 'Straight Line' : 'Declining Balance / WDV',
        RatePercent: `${g.depreciationRatePercent ?? 0}%`,
        GrossAcquisitionCost: g.totalCost,
        AccumulatedDepreciation: g.totalAccumDep,
        NetBookValue: g.totalNBV,
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
      ]);
    } else {
      const data = sortedDatewiseAssets.map((a) => {
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
          AccumulatedDepreciation: a.accumulatedDepreciation,
          NetBookValue: a.netBookValue,
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
      {/* Official Company Letterhead */}
      <DocumentLetterhead
        companyProfile={companyProfile}
        title="Fixed Asset Depreciation Register"
        subtitle="Statutory tax depreciation schedules, lot-level acquisition date calculations, accumulated write-offs, and Net Book Value (NBV)."
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <Calculator className="h-5 w-5 text-indigo-500" />
            <span>Register Filter &amp; Overview</span>
          </h2>
          <p className="truncate text-slate-400 text-xs mt-0.5">
            Statutory tax depreciation schedules, lot-level acquisition date calculations, accumulated write-offs, and Net Book Value (NBV).
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export Schedule ({activeTab === 'SUMMARY' ? 'Summary' : 'Datewise'})</span>
          </button>

          <button
            onClick={handlePrint}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Register</span>
          </button>
        </div>
      </div>

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
            {groupedSummaryList.length}
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
            {sortedDatewiseAssets.length} Lots
          </span>
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div
          className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
            <span>GROSS ACQUISITION COST</span>
            <Landmark className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="text-xl font-bold font-mono text-slate-900 dark:text-white">
            {formatNPRPrecise(totalCost)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Total capital expenditure across {filteredAssets.length} purchase lots
          </p>
        </div>

        <div
          className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
            <span>TOTAL ACCUMULATED DEPRECIATION</span>
            <TrendingDown className="h-4 w-4 text-rose-500" />
          </div>
          <p className="text-xl font-bold font-mono text-rose-500">
            {formatNPRPrecise(totalAccumDep)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Cumulative depreciation write-offs to date
          </p>
        </div>

        <div
          className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
            <span>NET BOOK VALUE (NBV)</span>
            <Calculator className="h-4 w-4 text-indigo-500" />
          </div>
          <p className="text-xl font-bold font-mono text-indigo-500">
            {formatNPRPrecise(totalNBV)}
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Carrying value on corporate balance sheet
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        className={`p-3 rounded-2xl border flex flex-col md:flex-row gap-3 items-center justify-start bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
      >
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border w-full md:w-96 text-xs bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
        >
          <Search className="h-4 w-4 text-slate-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search Asset Title, Invoice #, Tag #, Supplier..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-transparent focus:outline-none placeholder:text-slate-400"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <span className="text-xs font-semibold text-slate-400">Category:</span>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className={`px-3 py-1.5 rounded-xl border text-xs font-semibold focus:outline-none bg-slate-50 border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
          >
            <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

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
                {groupedSummaryList.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                      No fixed assets found matching filter criteria.
                    </td>
                  </tr>
                ) : (
                  groupedSummaryList.map((grp) => {
                    const isExpanded = !!expandedGroups[grp.key];
                    return (
                      <React.Fragment key={grp.key}>
                        {/* Parent Summary Row */}
                        <tr
                          onClick={() => toggleGroupExpand(grp.key)}
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
                            {formatNPRPrecise(grp.totalCost)}
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono text-rose-500 font-bold">
                            {formatNPRPrecise(grp.totalAccumDep)}
                          </td>
                          <td className={`px-2.5 py-1.5 text-right font-mono font-bold text-emerald-600 dark:text-emerald-400`}>
                            {formatNPRPrecise(grp.totalNBV)}
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
                                    {grp.lots.map((lot) => (
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
                {sortedDatewiseAssets.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                      No purchase lots found matching filter criteria.
                    </td>
                  </tr>
                ) : (
                  sortedDatewiseAssets.map((asset) => (
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
        </div>
      )}
    </div>
  );
};
