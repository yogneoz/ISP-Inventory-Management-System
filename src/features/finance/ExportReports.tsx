import React, { useState } from 'react';
import { PurchaseOrder, PurchaseInvoice, Shipment, Branch, Supplier, User, CustomerDeviceRecord, Product } from '../../types';
import { exportToCSV } from '../../utils/exportUtils';
import { formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import { getAllowedBranches, canUserSeeAllBranches, getAllowedBranchIds } from '../../utils/permissions';
import {
  Download,
  FileSpreadsheet,
  Filter,
  Calendar,
  Building2,
  Truck,
  Receipt,
  FileText,
  Search,
  CheckCircle2,
  Clock,
  AlertCircle,
  Cpu,
  Wifi,
  Copy,
  Check,
} from 'lucide-react';

interface ExportReportsProps {
  currentUser?: User | null;
  purchaseOrders: PurchaseOrder[];
  invoices: PurchaseInvoice[];
  shipments: Shipment[];
  customerDevices?: CustomerDeviceRecord[];
  products?: Product[];
  branches: Branch[];
  suppliers: Supplier[];
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const ExportReports: React.FC<ExportReportsProps> = ({
  currentUser,
  purchaseOrders,
  invoices,
  shipments,
  customerDevices = [],
  products = [],
  branches,
  suppliers,
  dateMode,
  isDarkMode = false,
}) => {
  const [activeReportTab, setActiveReportTab] = useState<'PO' | 'PI' | 'SHIPMENTS' | 'SERIALIZED_DEVICES'>('PO');

  const allowedBranches = getAllowedBranches(currentUser, branches);
  const allowedBranchIds = getAllowedBranchIds(currentUser, branches);
  const canSeeAll = canUserSeeAllBranches(currentUser);

  // Common Date Filters
  const [startDateAD, setStartDateAD] = useState<string>('');
  const [endDateAD, setEndDateAD] = useState<string>('');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [selectedSupplierName, setSelectedSupplierName] = useState<string>('ALL');

  // Specific Filters
  const [poStatusFilter, setPoStatusFilter] = useState<string>('ALL');
  const [piPaymentStatusFilter, setPiPaymentStatusFilter] = useState<string>('ALL');
  const [shipmentStatusFilter, setShipmentStatusFilter] = useState<string>('ALL');
  const [shipmentMode, setShipmentMode] = useState<'ALL' | 'CREATED' | 'RECEIVED'>('ALL');
  const [deviceStatusFilter, setDeviceStatusFilter] = useState<string>('IN_STOCK');
  const [deviceModelFilter, setDeviceModelFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedSerial, setCopiedSerial] = useState<string | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSerial(text);
    setTimeout(() => setCopiedSerial(null), 2000);
  };

  // Reset Filters
  const handleResetFilters = () => {
    setStartDateAD('');
    setEndDateAD('');
    setSelectedBranchId('ALL');
    setSelectedSupplierName('ALL');
    setPoStatusFilter('ALL');
    setPiPaymentStatusFilter('ALL');
    setShipmentStatusFilter('ALL');
    setShipmentMode('ALL');
    setDeviceStatusFilter('IN_STOCK');
    setDeviceModelFilter('ALL');
    setSearchQuery('');
  };

  // Quick Preset Handlers
  const applyDatePreset = (preset: 'THIS_MONTH' | 'LAST_30_DAYS' | 'THIS_YEAR') => {
    const today = new Date();
    const endStr = today.toISOString().split('T')[0];

    if (preset === 'THIS_MONTH') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDateAD(start.toISOString().split('T')[0]);
      setEndDateAD(endStr);
    } else if (preset === 'LAST_30_DAYS') {
      const start = new Date();
      start.setDate(today.getDate() - 30);
      setStartDateAD(start.toISOString().split('T')[0]);
      setEndDateAD(endStr);
    } else if (preset === 'THIS_YEAR') {
      const start = new Date(today.getFullYear(), 0, 1);
      setStartDateAD(start.toISOString().split('T')[0]);
      setEndDateAD(endStr);
    }
  };

  // ----------------
  // 1. PO Filtering
  // ----------------
  const filteredPOs = purchaseOrders.filter((po) => {
    if (startDateAD && po.orderDateAD < startDateAD) return false;
    if (endDateAD && po.orderDateAD > endDateAD) return false;
    if (selectedBranchId !== 'ALL') {
      if (po.branchId !== selectedBranchId) return false;
    } else if (!canSeeAll) {
      if (!allowedBranchIds.includes(po.branchId)) return false;
    }
    if (selectedSupplierName !== 'ALL' && po.supplierName !== selectedSupplierName) return false;
    if (poStatusFilter !== 'ALL' && po.status !== poStatusFilter) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchNum = (po?.orderNumber || '').toLowerCase().includes(q);
      const matchSup = (po?.supplierName || '').toLowerCase().includes(q);
      const matchNotes = po.notes?.toLowerCase().includes(q);
      if (!matchNum && !matchSup && !matchNotes) return false;
    }
    return true;
  });

  const exportPOCSV = () => {
    const columns = [
      { key: 'orderNumber', label: 'PO Number' },
      { key: 'orderDateAD', label: 'Order Date (AD)' },
      {
        key: 'orderDateBS',
        label: 'Order Date (BS)',
        formatter: (_: any, row: any) => formatBSDate(row.orderDateAD || row.orderDateBS),
      },
      { key: 'supplierName', label: 'Supplier Name' },
      {
        key: 'branchId',
        label: 'Branch Location',
        formatter: (val: string) => branches.find((b) => b.id === val)?.name || val,
      },
      { key: 'taxableAmount', label: 'Taxable Amount (NPR)' },
      { key: 'vatAmount', label: 'VAT Amount (NPR)' },
      { key: 'grandTotal', label: 'Grand Total (NPR)' },
      { key: 'status', label: 'PO Status' },
      { key: 'notes', label: 'Notes' },
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Purchase_Orders_Report',
      reportTitle: 'Procurement Purchase Orders Audit Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredPOs,
      columns,
    });
  };

  // ----------------
  // 2. PI Filtering
  // ----------------
  const filteredPIs = invoices.filter((pi) => {
    if (startDateAD && pi.invoiceDateAD < startDateAD) return false;
    if (endDateAD && pi.invoiceDateAD > endDateAD) return false;
    if (selectedBranchId !== 'ALL') {
      if (pi.branchId !== selectedBranchId) return false;
    } else if (!canSeeAll) {
      if (!allowedBranchIds.includes(pi.branchId)) return false;
    }
    if (selectedSupplierName !== 'ALL' && pi.supplierName !== selectedSupplierName) return false;
    if (piPaymentStatusFilter !== 'ALL' && pi.paymentStatus !== piPaymentStatusFilter) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchInv = (pi?.invoiceNumber || '').toLowerCase().includes(q);
      const matchBill = pi.vendorBillNumber?.toLowerCase().includes(q);
      const matchSup = (pi?.supplierName || '').toLowerCase().includes(q);
      if (!matchInv && !matchBill && !matchSup) return false;
    }
    return true;
  });

  const exportPICSV = () => {
    const columns = [
      { key: 'invoiceNumber', label: 'Invoice Number' },
      { key: 'vendorBillNumber', label: 'Vendor Bill No.' },
      { key: 'poReferenceId', label: 'PO Ref' },
      { key: 'invoiceDateAD', label: 'Invoice Date (AD)' },
      {
        key: 'invoiceDateBS',
        label: 'Invoice Date (BS)',
        formatter: (_: any, row: any) => formatBSDate(row.invoiceDateAD || row.invoiceDateBS),
      },
      { key: 'dueDateAD', label: 'Due Date (AD)' },
      { key: 'supplierName', label: 'Supplier Name' },
      {
        key: 'branchId',
        label: 'Branch Location',
        formatter: (val: string) => branches.find((b) => b.id === val)?.name || val,
      },
      { key: 'taxableAmount', label: 'Taxable Subtotal (NPR)' },
      { key: 'vatAmount', label: 'VAT Amount (NPR)' },
      { key: 'grandTotal', label: 'Grand Total (NPR)' },
      { key: 'amountPaid', label: 'Amount Paid (NPR)' },
      {
        key: 'balanceDue',
        label: 'Balance Due (NPR)',
        formatter: (_: any, row: any) => String(Math.max(0, row.grandTotal - row.amountPaid)),
      },
      { key: 'paymentStatus', label: 'Payment Status' },
      { key: 'notes', label: 'Notes' },
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Purchase_Invoices_Report',
      reportTitle: 'Purchase Invoices & Vendor Payable Audit Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredPIs,
      columns,
    });
  };

  // --------------------
  // 3. Shipment Filtering
  // --------------------
  const filteredShipments = shipments.filter((sh) => {
    if (startDateAD && sh.dispatchDateAD < startDateAD) return false;
    if (endDateAD && sh.dispatchDateAD > endDateAD) return false;

    if (selectedBranchId !== 'ALL') {
      const isSource = sh.sourceBranchId === selectedBranchId;
      const isDest = sh.destinationBranchId === selectedBranchId;
      if (shipmentMode === 'CREATED' && !isSource) return false;
      if (shipmentMode === 'RECEIVED' && !isDest) return false;
      if (shipmentMode === 'ALL' && !isSource && !isDest) return false;
    } else if (!canSeeAll) {
      const isSourceAllowed = allowedBranchIds.includes(sh.sourceBranchId);
      const isDestAllowed = allowedBranchIds.includes(sh.destinationBranchId);
      if (!isSourceAllowed && !isDestAllowed) return false;
    } else {
      if (shipmentMode === 'CREATED' && !sh.sourceBranchId) return false;
    }

    if (shipmentStatusFilter !== 'ALL' && sh.status !== shipmentStatusFilter) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const matchCode = (sh?.trackingCode || '').toLowerCase().includes(q);
      const matchSrc = sh.sourceBranchName?.toLowerCase().includes(q);
      const matchDest = sh.destinationBranchName?.toLowerCase().includes(q);
      if (!matchCode && !matchSrc && !matchDest) return false;
    }
    return true;
  });

  const exportShipmentsCSV = () => {
    const columns = [
      { key: 'trackingCode', label: 'Tracking Code' },
      { key: 'dispatchDateAD', label: 'Dispatch Date (AD)' },
      {
        key: 'dispatchDateBS',
        label: 'Dispatch Date (BS)',
        formatter: (_: any, row: any) => formatBSDate(row.dispatchDateAD || row.dispatchDateBS),
      },
      { key: 'sourceBranchName', label: 'Source Branch' },
      { key: 'destinationBranchName', label: 'Destination Branch' },
      { key: 'status', label: 'Status' },
      {
        key: 'manifestSummary',
        label: 'Manifest Items',
        formatter: (_: any, row: any) =>
          row.items.map((i: any) => `${i.productName} (Sent: ${i.quantitySent}, Rec: ${i.quantityReceived || 0})`).join('; '),
      },
      { key: 'notes', label: 'Notes' },
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: 'Shipments_Transfer_Report',
      reportTitle: 'Multi-Branch Transfer & Logistics Shipment Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredShipments,
      columns,
    });
  };

  // -------------------------------------------------------------
  // 4. Serialized Devices Filtering (SN / PON / MAC / Branch)
  // -------------------------------------------------------------
  const filteredSerializedDevices = customerDevices.filter((dev) => {
    if (selectedBranchId !== 'ALL' && dev.branchId !== selectedBranchId) return false;

    if (deviceStatusFilter !== 'ALL') {
      if (deviceStatusFilter === 'IN_STOCK' && dev.status !== 'IN_STOCK') return false;
      if (deviceStatusFilter === 'RENTAL' && dev.status !== 'RENTAL') return false;
      if (deviceStatusFilter === 'ASSIGNED' && (dev.status === 'IN_STOCK' || dev.status === 'RETURNED')) return false;
    }

    if (deviceModelFilter !== 'ALL' && dev.productName !== deviceModelFilter) return false;

    if (startDateAD && dev.issuedDateAD && dev.issuedDateAD < startDateAD) return false;
    if (endDateAD && dev.issuedDateAD && dev.issuedDateAD > endDateAD) return false;

    if (searchQuery.trim()) {
      const q = (searchQuery || '').toLowerCase().trim();
      const br = branches.find((b) => b.id === dev.branchId);
      const matchSN = dev.deviceSerial?.toLowerCase().includes(q);
      const matchPON = dev.ponSerial?.toLowerCase().includes(q);
      const matchMAC = dev.macAddress?.toLowerCase().includes(q);
      const matchProd = dev.productName?.toLowerCase().includes(q);
      const matchCust = dev.customerName?.toLowerCase().includes(q);
      const matchBr = br?.name.toLowerCase().includes(q) || br?.code.toLowerCase().includes(q);
      if (!matchSN && !matchPON && !matchMAC && !matchProd && !matchCust && !matchBr) return false;
    }

    return true;
  });

  const exportSerializedDevicesCSV = () => {
    const columns = [
      {
        key: 'branchCode',
        label: 'Branch Code',
        formatter: (_: any, row: CustomerDeviceRecord) => branches.find((b) => b.id === row.branchId)?.code || row.branchId,
      },
      {
        key: 'branchName',
        label: 'Branch Location',
        formatter: (_: any, row: CustomerDeviceRecord) => branches.find((b) => b.id === row.branchId)?.name || row.branchId,
      },
      { key: 'productName', label: 'Product / Model' },
      { key: 'deviceSerial', label: 'Device Serial Number' },
      { key: 'ponSerial', label: 'PON Serial Number' },
      { key: 'macAddress', label: 'MAC Address', formatter: (val: string) => val || 'N/A' },
      { key: 'status', label: 'Status' },
      {
        key: 'issuedDateBS',
        label: 'Registered Date (BS)',
        formatter: (_: any, row: CustomerDeviceRecord) => formatBSDate(row.issuedDateAD || row.issuedDateBS),
      },
      { key: 'issuedDateAD', label: 'Registered Date (AD)' },
      { key: 'customerName', label: 'Location / Holder' },
      { key: 'purchaseBillRef', label: 'Purchase Ref / Batch', formatter: (val: string) => val || '-' },
    ];

    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

    exportToCSV({
      filename: `Serialized_Devices_${selectedBranchId}`,
      reportTitle: `Serialized Hardware Stock Report (SN / PON / MAC / Branch) - ${deviceStatusFilter}`,
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredSerializedDevices,
      columns,
    });
  };

  const serializedModels = Array.from(new Set(customerDevices.map((d) => d.productName)));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <Download className="h-5 w-5 text-indigo-500" />
            <span>Administration Export Reports</span>
          </h2>
          <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Generate and download audit-ready Excel/CSV reports for Serialized Stock (SN/PON/MAC), Purchase Orders, Invoices, and Shipments.
          </p>
        </div>

        {/* Action Trigger Button */}
        <div>
          {activeReportTab === 'SERIALIZED_DEVICES' && (
            <button
              onClick={exportSerializedDevicesCSV}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 shadow-md shadow-indigo-900/30 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-300" />
              <span>Export Serialized Stock CSV ({filteredSerializedDevices.length} Pcs)</span>
            </button>
          )}

          {activeReportTab === 'PO' && (
            <button
              onClick={exportPOCSV}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-500 shadow-md shadow-indigo-900/30 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-300" />
              <span>Export Purchase Orders CSV ({filteredPOs.length})</span>
            </button>
          )}

          {activeReportTab === 'PI' && (
            <button
              onClick={exportPICSV}
              className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 shadow-md shadow-emerald-900/30 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-white" />
              <span>Export Purchase Invoices CSV ({filteredPIs.length})</span>
            </button>
          )}

          {activeReportTab === 'SHIPMENTS' && (
            <button
              onClick={exportShipmentsCSV}
              className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 shadow-md shadow-amber-900/30 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4 text-white" />
              <span>Export Shipments Report CSV ({filteredShipments.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Tabs Selection */}
      <div className={`p-1.5 rounded-2xl border flex flex-wrap items-center gap-2 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-slate-100 border-slate-200'
      }`}>
        <button
          onClick={() => setActiveReportTab('SERIALIZED_DEVICES')}
          className={`flex-1 min-w-[200px] flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeReportTab === 'SERIALIZED_DEVICES'
              ? 'bg-indigo-600 text-white shadow-md'
              : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Cpu className="h-4 w-4" />
          <span>1. Serialized Stock (SN/PON/MAC)</span>
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono font-bold">
            {customerDevices.length}
          </span>
        </button>

        <button
          onClick={() => setActiveReportTab('PO')}
          className={`flex-1 min-w-[160px] flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeReportTab === 'PO'
              ? 'bg-indigo-600 text-white shadow-md'
              : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FileText className="h-4 w-4" />
          <span>2. Purchase Orders</span>
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono">
            {purchaseOrders.length}
          </span>
        </button>

        <button
          onClick={() => setActiveReportTab('PI')}
          className={`flex-1 min-w-[160px] flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeReportTab === 'PI'
              ? 'bg-emerald-600 text-white shadow-md'
              : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Receipt className="h-4 w-4" />
          <span>3. Purchase Invoices</span>
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono">
            {invoices.length}
          </span>
        </button>

        <button
          onClick={() => setActiveReportTab('SHIPMENTS')}
          className={`flex-1 min-w-[160px] flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeReportTab === 'SHIPMENTS'
              ? 'bg-amber-600 text-white shadow-md'
              : isDarkMode ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Truck className="h-4 w-4" />
          <span>4. Shipments</span>
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono">
            {shipments.length}
          </span>
        </button>
      </div>

      {/* Filter Control Bar */}
      <div className={`p-4 rounded-2xl border space-y-4 ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-indigo-500" />
            <span className={`text-xs font-bold uppercase tracking-wider ${
              isDarkMode ? 'text-slate-300' : 'text-slate-700'
            }`}>
              Report Filter Parameters
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => applyDatePreset('THIS_MONTH')}
              className="text-[11px] font-semibold text-indigo-500 hover:underline cursor-pointer"
            >
              This Month
            </button>
            <span className="text-slate-400">•</span>
            <button
              onClick={() => applyDatePreset('LAST_30_DAYS')}
              className="text-[11px] font-semibold text-indigo-500 hover:underline cursor-pointer"
            >
              Last 30 Days
            </button>
            <span className="text-slate-400">•</span>
            <button
              onClick={() => applyDatePreset('THIS_YEAR')}
              className="text-[11px] font-semibold text-indigo-500 hover:underline cursor-pointer"
            >
              This Year
            </button>
            <span className="text-slate-400">•</span>
            <button
              onClick={handleResetFilters}
              className="text-[11px] font-semibold text-rose-500 hover:underline cursor-pointer"
            >
              Reset Filters
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {/* Branch Filter */}
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
              Branch Location
            </label>
            <select
              value={selectedBranchId}
              onChange={(e) => setSelectedBranchId(e.target.value)}
              className={`w-full rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            >
              {canSeeAll && <option value="ALL">All 19 Branches (Consolidated)</option>}
              {allowedBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>

          {/* Date Range Start */}
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
              From Date (AD)
            </label>
            <input
              type="date"
              value={startDateAD}
              onChange={(e) => setStartDateAD(e.target.value)}
              className={`w-full rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none focus:border-indigo-500 ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
          </div>

          {/* Date Range End */}
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
              To Date (AD)
            </label>
            <input
              type="date"
              value={endDateAD}
              onChange={(e) => setEndDateAD(e.target.value)}
              className={`w-full rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none focus:border-indigo-500 ${
                isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
          </div>

          {/* Search Box */}
          <div>
            <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
              Search Text
            </label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search SN, PON, MAC, Number, Ref..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`w-full pl-8 pr-3 py-2 text-xs rounded-xl border focus:outline-none focus:border-indigo-500 ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                }`}
              />
            </div>
          </div>
        </div>

        {/* Tab Specific Second Row Filters */}
        {activeReportTab === 'SERIALIZED_DEVICES' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                Stock Status
              </label>
              <select
                value={deviceStatusFilter}
                onChange={(e) => setDeviceStatusFilter(e.target.value)}
                className={`w-full rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                }`}
              >
                <option value="IN_STOCK">Status: Available In-Store Only</option>
                <option value="RENTAL">Status: Rental CPE (Customer In-Use)</option>
                <option value="ASSIGNED">Status: All Assigned Devices</option>
                <option value="ALL">Status: All Statuses (In-Stock + Assigned)</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                Hardware Device Model
              </label>
              <select
                value={deviceModelFilter}
                onChange={(e) => setDeviceModelFilter(e.target.value)}
                className={`w-full rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none focus:border-indigo-500 cursor-pointer ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                }`}
              >
                <option value="ALL">All Hardware Models</option>
                {serializedModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* 1. Serialized Devices Table */}
      {activeReportTab === 'SERIALIZED_DEVICES' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-3.5">Branch</th>
                  <th className="p-3.5">Device Model</th>
                  <th className="p-3.5">Device Serial (SN)</th>
                  <th className="p-3.5">PON Serial Number</th>
                  <th className="p-3.5">MAC Address</th>
                  <th className="p-3.5 text-center">Status</th>
                  <th className="p-3.5">Location / Customer</th>
                  <th className="p-3.5 text-right">Registered (BS)</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredSerializedDevices.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      No serialized devices found matching selected criteria.
                    </td>
                  </tr>
                ) : (
                  filteredSerializedDevices.map((dev) => {
                    const br = branches.find((b) => b.id === dev.branchId);
                    const isAvailable = dev.status === 'IN_STOCK';

                    return (
                      <tr key={dev.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                        <td className="p-3.5 font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-indigo-500" />
                            <span>{br?.name || dev.branchId}</span>
                            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                              {br?.code || dev.branchId}
                            </span>
                          </span>
                        </td>
                        <td className="p-3.5 font-bold text-slate-900 dark:text-white whitespace-nowrap">
                          {dev.productName}
                        </td>
                        <td className="p-3.5 font-mono font-bold text-indigo-600 dark:text-indigo-400 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span>{dev.deviceSerial}</span>
                            <button
                              onClick={() => copyToClipboard(dev.deviceSerial)}
                              className="text-slate-400 hover:text-indigo-500 cursor-pointer transition-colors"
                              title="Copy Serial Number"
                            >
                              {copiedSerial === dev.deviceSerial ? (
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                        <td className="p-3.5 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800/80 font-semibold text-[11px]">
                            {dev.ponSerial || 'N/A'}
                          </span>
                        </td>
                        <td className="p-3.5 font-mono text-slate-600 dark:text-slate-400 whitespace-nowrap">
                          {dev.macAddress || 'N/A'}
                        </td>
                        <td className="p-3.5 text-center whitespace-nowrap">
                          {isAvailable ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                              <CheckCircle2 className="h-3 w-3" />
                              <span>IN STOCK</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/60">
                              <Wifi className="h-3 w-3" />
                              <span>{dev.status}</span>
                            </span>
                          )}
                        </td>
                        <td className="p-3.5 text-slate-600 dark:text-slate-400 truncate max-w-[200px]">
                          {dev.customerName}
                        </td>
                        <td className="p-3.5 text-right font-mono text-slate-500 whitespace-nowrap">
                          {formatBSDate(dev.issuedDateAD || dev.issuedDateBS)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 2. Purchase Orders Table */}
      {activeReportTab === 'PO' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-3.5">PO Number</th>
                  <th className="p-3.5">Order Date</th>
                  <th className="p-3.5">Supplier</th>
                  <th className="p-3.5">Branch</th>
                  <th className="p-3.5 text-right">Taxable (NPR)</th>
                  <th className="p-3.5 text-right">VAT (13%)</th>
                  <th className="p-3.5 text-right font-bold">Grand Total (NPR)</th>
                  <th className="p-3.5 text-center">Status</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredPOs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      No Purchase Orders found matching selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredPOs.map((po) => {
                    const branchName = branches.find((b) => b.id === po.branchId)?.name || po.branchId;
                    const dateFormatted = formatDualDate(po.orderDateAD, dateMode);

                    return (
                      <tr key={po.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                        <td className="p-3.5 font-bold font-mono text-indigo-500">{po.orderNumber}</td>
                        <td className="p-3.5 text-slate-500">{dateFormatted}</td>
                        <td className={`p-3.5 font-semibold ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>
                          {po.supplierName}
                        </td>
                        <td className="p-3.5 text-slate-500">{branchName}</td>
                        <td className="p-3.5 text-right font-mono">रु {(po.taxableAmount ?? 0).toLocaleString('en-IN')}</td>
                        <td className="p-3.5 text-right font-mono text-indigo-500">रु {(po.vatAmount ?? 0).toLocaleString('en-IN')}</td>
                        <td className={`p-3.5 text-right font-mono font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                          रु {(po.grandTotal ?? 0).toLocaleString('en-IN')}
                        </td>
                        <td className="p-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            po.status === 'APPROVED' || po.status === 'RECEIVED'
                              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                              : po.status === 'PENDING'
                              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                              : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                          }`}>
                            {po.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 3. Purchase Invoices Table */}
      {activeReportTab === 'PI' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-3.5">Invoice #</th>
                  <th className="p-3.5">Vendor Bill / PO</th>
                  <th className="p-3.5">Invoice Date</th>
                  <th className="p-3.5">Supplier</th>
                  <th className="p-3.5">Branch</th>
                  <th className="p-3.5 text-right">Taxable (NPR)</th>
                  <th className="p-3.5 text-right">VAT (13%)</th>
                  <th className="p-3.5 text-right font-bold">Grand Total</th>
                  <th className="p-3.5 text-right">Paid Amount</th>
                  <th className="p-3.5 text-center">Status</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredPIs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-500">
                      No Purchase Invoices found matching selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredPIs.map((pi) => {
                    const branchName = branches.find((b) => b.id === pi.branchId)?.name || pi.branchId;
                    const dateFormatted = formatDualDate(pi.invoiceDateAD, dateMode);

                    return (
                      <tr key={pi.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                        <td className="p-3.5 font-bold font-mono text-emerald-500">{pi.invoiceNumber}</td>
                        <td className="p-3.5 font-mono text-slate-400">{pi.vendorBillNumber || pi.poReferenceId || '-'}</td>
                        <td className="p-3.5 text-slate-500">{dateFormatted}</td>
                        <td className={`p-3.5 font-semibold ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>
                          {pi.supplierName}
                        </td>
                        <td className="p-3.5 text-slate-500">{branchName}</td>
                        <td className="p-3.5 text-right font-mono">रु {(pi.taxableAmount ?? 0).toLocaleString('en-IN')}</td>
                        <td className="p-3.5 text-right font-mono text-indigo-500">रु {(pi.vatAmount ?? 0).toLocaleString('en-IN')}</td>
                        <td className={`p-3.5 text-right font-mono font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                          रु {(pi.grandTotal ?? 0).toLocaleString('en-IN')}
                        </td>
                        <td className="p-3.5 text-right font-mono text-emerald-600 font-semibold">
                          रु {(pi.amountPaid ?? 0).toLocaleString('en-IN')}
                        </td>
                        <td className="p-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            pi.paymentStatus === 'PAID'
                              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                              : pi.paymentStatus === 'PARTIAL'
                              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                              : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                          }`}>
                            {pi.paymentStatus}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4. Shipments Table */}
      {activeReportTab === 'SHIPMENTS' && (
        <div className={`rounded-2xl border shadow-lg overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`font-bold uppercase text-[10px] tracking-wider border-b ${
                isDarkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="p-3.5">Tracking Code</th>
                  <th className="p-3.5">Dispatch Date</th>
                  <th className="p-3.5">Origin (From)</th>
                  <th className="p-3.5">Destination (To)</th>
                  <th className="p-3.5 text-center">Manifest Types</th>
                  <th className="p-3.5 text-center">Sent Units</th>
                  <th className="p-3.5 text-center">Received Units</th>
                  <th className="p-3.5 text-center">Status</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {filteredShipments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-slate-500">
                      No Shipment records found matching selected filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredShipments.map((sh) => {
                    const dateFormatted = formatDualDate(sh.dispatchDateAD, dateMode);
                    const sentUnits = sh.items.reduce((s, i) => s + i.quantitySent, 0);
                    const recUnits = sh.items.reduce((s, i) => s + (i.quantityReceived || 0), 0);

                    return (
                      <tr key={sh.id} className={isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}>
                        <td className="p-3.5 font-bold font-mono text-amber-500">{sh.trackingCode}</td>
                        <td className="p-3.5 text-slate-500">{dateFormatted}</td>
                        <td className="p-3.5 text-slate-400">{sh.sourceBranchName || 'Central HQ'}</td>
                        <td className={`p-3.5 font-semibold ${isDarkMode ? 'text-white' : 'text-slate-800'}`}>
                          {sh.destinationBranchName}
                        </td>
                        <td className="p-3.5 text-center font-mono">{sh.items?.length || 0} SKUs</td>
                        <td className="p-3.5 text-center font-mono font-bold">{sentUnits} Pcs</td>
                        <td className="p-3.5 text-center font-mono font-bold text-emerald-500">{recUnits} Pcs</td>
                        <td className="p-3.5 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            sh.status === 'RECEIVED' || sh.status === 'DELIVERED'
                              ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                              : sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED'
                              ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                              : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                          }`}>
                            {sh.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
