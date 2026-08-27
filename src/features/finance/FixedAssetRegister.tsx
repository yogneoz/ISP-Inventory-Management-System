import React, { useState } from 'react';
import { Asset, Branch, User } from '../../types';
import { formatDualDate, convertADToBS } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed } from '../../utils/permissions';
import {
  Landmark,
  Plus,
  Search,
  Calculator,
  ShieldAlert,
  CheckCircle2,
  X,
  FileSpreadsheet,
  MapPin,
  Building,
  Layers,
  Info,
  Download,
} from 'lucide-react';

interface FixedAssetRegisterProps {
  assets: Asset[];
  branches: Branch[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  autoOpenModal?: boolean;
  currentUser?: User | null;
  isDarkMode?: boolean;
  onCreateAsset: (
    asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'>
  ) => Promise<void>;
  onUpdateAssetStatus: (id: string, status: Asset['status']) => Promise<void>;
}

export const FixedAssetRegister: React.FC<FixedAssetRegisterProps> = ({
  assets,
  branches,
  selectedBranchId,
  dateMode,
  autoOpenModal = false,
  currentUser,
  isDarkMode = false,
  onCreateAsset,
  onUpdateAssetStatus,
}) => {
  const canManageAssets = isOperationAllowed('assets-manage', currentUser?.role);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(autoOpenModal);
  const [selectedAssetDetail, setSelectedAssetDetail] = useState<Asset | null>(null);

  // Form state
  const [tagNumber, setTagNumber] = useState(`AST-${Math.floor(1000 + Math.random() * 9000)}`);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Asset['category']>('IT Equipment');
  const [branchId, setBranchId] = useState(branches[0]?.id || '');
  const [acquisitionCost, setAcquisitionCost] = useState(50000);
  const [depreciationMethod, setDepreciationMethod] = useState<Asset['depreciationMethod']>(
    'STRAIGHT_LINE'
  );
  const [depreciationRatePercent, setDepreciationRatePercent] = useState(15);
  const [acquisitionDateAD, setAcquisitionDateAD] = useState(
    new Date().toISOString().split('T')[0]
  );

  const filteredAssets = assets.filter((a) => {
    const matchesBranch = selectedBranchId === 'ALL' || a.branchId === selectedBranchId;
    const matchesSearch =
      !search ||
      (a?.name || '').toLowerCase().includes((search || '').toLowerCase()) ||
      (a?.tagNumber || '').toLowerCase().includes((search || '').toLowerCase());
    return matchesBranch && matchesSearch;
  });

  const totalCost = filteredAssets.reduce((sum, a) => sum + a.acquisitionCost, 0);
  const totalAccumDep = filteredAssets.reduce((sum, a) => sum + a.accumulatedDepreciation, 0);
  const totalNBV = filteredAssets.reduce((sum, a) => sum + a.netBookValue, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const bsObj = convertADToBS(acquisitionDateAD);

    await onCreateAsset({
      tagNumber,
      name,
      category,
      branchId,
      acquisitionDateAD,
      acquisitionDateBS: bsObj.formattedBSShort,
      acquisitionCost: Number(acquisitionCost),
      depreciationMethod,
      depreciationRatePercent: Number(depreciationRatePercent),
      status: 'ACTIVE',
    });

    setIsModalOpen(false);
  };

  const selectedBranchObj = branches.find((b) => b.id === selectedAssetDetail?.branchId);

  const handleExportCSV = () => {
    exportToCSV('IZone_Fixed_Asset_Register', filteredAssets, [
      { key: 'tagNumber', label: 'Tag Number' },
      { key: 'name', label: 'Asset Title' },
      { key: 'category', label: 'Category' },
      { key: 'branchId', label: 'Branch ID', formatter: (val) => branches.find((b) => b.id === val)?.name || val },
      { key: 'acquisitionDateAD', label: 'Acquisition Date (AD)' },
      { key: 'acquisitionDateBS', label: 'Acquisition Date (BS)' },
      { key: 'acquisitionCost', label: 'Gross Cost (NPR)' },
      { key: 'depreciationMethod', label: 'Dep. Method' },
      { key: 'depreciationRatePercent', label: 'Dep. Rate %' },
      { key: 'accumulatedDepreciation', label: 'Accumulated Dep. (NPR)' },
      { key: 'netBookValue', label: 'Net Book Value (NPR)' },
      { key: 'status', label: 'Status' },
    ]);
  };

  return (
    <div className="space-y-6">
      {/* Header & Stats */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-serif font-bold text-slate-900 dark:text-slate-100 tracking-tight flex items-center gap-2">
            <Landmark className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <span>Fixed Asset Register & Depreciation Ledger</span>
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Click any asset row to view branch allocation, physical location, and quantity details.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleExportCSV}
            title="Export Assets to CSV"
            className="flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-300 shadow-xs transition-all cursor-pointer"
          >
            <Download className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>

          {canManageAssets && (
            <button
              onClick={() => {
                setTagNumber(`AST-${Math.floor(1000 + Math.random() * 9000)}`);
                setName('');
                setIsModalOpen(true);
              }}
              className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700 shadow-md shadow-blue-600/20 transition-all cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>Register Fixed Asset</span>
            </button>
          )}
        </div>
      </div>

      {/* Asset Valuation Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 shadow-xs">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Gross Asset Cost</div>
          <div className="text-lg font-mono font-bold text-slate-900 dark:text-white mt-1">
            {(totalCost ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="rounded-2xl bg-white dark:bg-slate-900 p-4 border border-slate-200 dark:border-slate-800 shadow-xs">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Accumulated Depreciation</div>
          <div className="text-lg font-mono font-bold text-rose-600 dark:text-rose-400 mt-1">
            {(totalAccumDep ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="rounded-2xl bg-emerald-50/30 dark:bg-slate-900 p-4 border border-emerald-200 dark:border-slate-800 shadow-xs">
          <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-400">Net Book Value (NBV)</div>
          <div className="text-lg font-mono font-extrabold text-emerald-700 dark:text-emerald-400 mt-1">
            {(totalNBV ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {/* Search control */}
      <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-xs flex items-center max-w-md">
        <Search className="h-4 w-4 text-slate-400 mr-2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Scan Barcode or Search & Enter Product Name / SKU:"
          className="w-full text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 bg-transparent focus:outline-none"
        />
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100/90 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 font-bold uppercase text-[10px] tracking-wider border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="p-3.5">Tag #</th>
                <th className="p-3.5">Asset Name</th>
                <th className="p-3.5">Category</th>
                <th className="p-3.5">Branch Used In</th>
                <th className="p-3.5">Acquired Date</th>
                <th className="p-3.5 text-right">Cost</th>
                <th className="p-3.5 text-right">Method & Rate</th>
                <th className="p-3.5 text-right">Net Book Value</th>
                <th className="p-3.5 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredAssets.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400 text-xs">
                    No fixed assets registered for this branch.
                  </td>
                </tr>
              ) : (
                filteredAssets.map((asset) => {
                  const branch = branches.find((b) => b.id === asset.branchId);
                  return (
                    <tr
                      key={asset.id}
                      onClick={() => setSelectedAssetDetail(asset)}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group"
                    >
                      <td className="p-3.5 font-mono font-bold text-blue-600 dark:text-blue-400 group-hover:underline">
                        {asset.tagNumber}
                      </td>
                      <td className="p-3.5 font-bold text-slate-900 dark:text-slate-100">{asset.name}</td>
                      <td className="p-3.5">
                        <span className="rounded bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                          {asset.category}
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-800 dark:text-slate-200 font-semibold">{branch?.name || asset.branchId}</td>
                      <td className="p-3.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {formatDualDate(asset.acquisitionDateAD, dateMode)}
                      </td>
                      <td className="p-3.5 text-right font-mono font-medium text-slate-800 dark:text-slate-200">
                        {(asset.acquisitionCost ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="p-3.5 text-right text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                        {asset.depreciationMethod === 'STRAIGHT_LINE' ? 'SL' : 'RB'} @ {asset.depreciationRatePercent}%
                      </td>
                      <td className="p-3.5 text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                        {(asset.netBookValue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="p-3.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <select
                          value={asset.status}
                          onChange={(e) => onUpdateAssetStatus(asset.id, e.target.value as any)}
                          className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase cursor-pointer ${
                            asset.status === 'ACTIVE'
                              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                              : asset.status === 'MAINTENANCE'
                              ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700'
                          }`}
                        >
                          <option value="ACTIVE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-emerald-400 font-bold">ACTIVE</option>
                          <option value="MAINTENANCE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-amber-400 font-bold">MAINTENANCE</option>
                          <option value="DISPOSED" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-400 font-bold">DISPOSED</option>
                        </select>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Asset Location & Quantity Details Modal */}
      {selectedAssetDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden text-slate-800 dark:text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-4">
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm flex items-center gap-2">
                <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span>Fixed Asset Branch Allocation & Deployment Details</span>
              </h3>
              <button
                onClick={() => setSelectedAssetDetail(null)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="bg-blue-50 dark:bg-blue-950/40 p-3.5 rounded-xl border border-blue-200 dark:border-blue-900">
                <span className="text-[10px] font-bold text-blue-800 dark:text-blue-300 uppercase tracking-wider">
                  Asset Identification
                </span>
                <div className="text-base font-extrabold text-slate-900 dark:text-white mt-0.5">
                  {selectedAssetDetail.name}
                </div>
                <div className="text-xs font-mono font-bold text-blue-700 dark:text-blue-400 mt-0.5">
                  Tag Number: {selectedAssetDetail.tagNumber}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                    <Building className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    Branch Used In
                  </span>
                  <div className="text-xs font-bold text-slate-900 dark:text-slate-100 mt-1">
                    {selectedBranchObj?.name || selectedAssetDetail.branchId}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1">
                    <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                    {selectedBranchObj?.location || 'Central Facility'}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800">
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase flex items-center gap-1">
                    <Layers className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                    Quantity Deployed
                  </span>
                  <div className="text-base font-mono font-extrabold text-blue-700 dark:text-blue-400 mt-1">
                    1 Unit (Tracked Asset)
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Category: {selectedAssetDetail.category}
                  </div>
                </div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Party Invoice / Purchase Date:</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{selectedAssetDetail.acquisitionDateAD} ({selectedAssetDetail.acquisitionDateBS})</span>
                </div>
                {selectedAssetDetail.invoiceNo && (
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Party Invoice Ref #:</span>
                    <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{selectedAssetDetail.invoiceNo}</span>
                  </div>
                )}
                {selectedAssetDetail.supplierName && (
                  <div className="flex justify-between text-slate-600 dark:text-slate-400">
                    <span>Supplier / Vendor:</span>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{selectedAssetDetail.supplierName}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Gross Acquisition Cost:</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{(selectedAssetDetail.acquisitionCost ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-rose-600 dark:text-rose-400">
                  <span>Accumulated Depreciation:</span>
                  <span className="font-mono font-bold">{(selectedAssetDetail.accumulatedDepreciation ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between text-emerald-700 dark:text-emerald-400 font-bold border-t border-slate-200 dark:border-slate-800 pt-2">
                  <span>Current Net Book Value:</span>
                  <span className="font-mono">{(selectedAssetDetail.netBookValue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setSelectedAssetDetail(null)}
                  className="rounded-xl bg-blue-600 text-white px-4 py-2 text-xs font-bold hover:bg-blue-700 cursor-pointer shadow-xs"
                >
                  Close Window
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Asset Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden my-8 text-slate-800 dark:text-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-4">
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">
                Register New Fixed Asset
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Asset Tag Number
                  </label>
                  <input
                    type="text"
                    required
                    value={tagNumber}
                    onChange={(e) => setTagNumber(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 font-mono text-xs text-slate-900 dark:text-slate-100 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Category
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as any)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="IT Equipment" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">IT Equipment</option>
                    <option value="Furniture" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Furniture</option>
                    <option value="Machinery" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Machinery</option>
                    <option value="Vehicles" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Vehicles</option>
                    <option value="Fixtures" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Fixtures</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Asset Description / Title
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Cisco Optical Core Switch Catalyst 9300"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Location Branch
                  </label>
                  <select
                    value={branchId}
                    onChange={(e) => setBranchId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id} className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Acquisition Date (AD)
                  </label>
                  <input
                    type="date"
                    required
                    value={acquisitionDateAD}
                    onChange={(e) => setAcquisitionDateAD(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Cost
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    value={acquisitionCost}
                    onChange={(e) => setAcquisitionCost(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Method
                  </label>
                  <select
                    value={depreciationMethod}
                    onChange={(e) => setDepreciationMethod(e.target.value as any)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="STRAIGHT_LINE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Straight Line</option>
                    <option value="REDUCING_BALANCE" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">Reducing Balance</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Dep. Rate %
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    max={100}
                    value={depreciationRatePercent}
                    onChange={(e) => setDepreciationRatePercent(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 font-mono"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 shadow-md shadow-blue-600/20 cursor-pointer"
                >
                  Save Asset
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
