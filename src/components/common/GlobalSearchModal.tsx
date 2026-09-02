import React, { useEffect, useRef } from 'react';
import {
  Product,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  Asset,
  CustomerDeviceRecord,
  Supplier,
  Branch,
  InventoryStock,
} from '../../types';
import { NavTab } from '../layout/Sidebar';
import {
  Search,
  Package,
  FileText,
  Receipt,
  Truck,
  Monitor,
  Wrench,
  Users,
  Building2,
  X,
  ArrowRight,
} from 'lucide-react';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  products: Product[];
  purchaseOrders: PurchaseOrder[];
  invoices: PurchaseInvoice[];
  shipments: Shipment[];
  assets: Asset[];
  customerDevices: CustomerDeviceRecord[];
  suppliers: Supplier[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  onSelectResult: (tab: NavTab, filterText?: string) => void;
  isDarkMode?: boolean;
}

export const GlobalSearchModal: React.FC<GlobalSearchModalProps> = ({
  isOpen,
  onClose,
  searchQuery,
  onSearchChange,
  products = [],
  purchaseOrders = [],
  invoices = [],
  shipments = [],
  assets = [],
  customerDevices = [],
  suppliers = [],
  branches = [],
  stock = [],
  selectedBranchId = 'ALL',
  onSelectResult,
  isDarkMode = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const query = (searchQuery || '').trim().toLowerCase();

  // Helper to calculate total stock for a product
  const getProductStockQty = (prodId: string) => {
    if (!stock || stock.length === 0) return 0;
    const items = stock.filter(
      (s) => s.productId === prodId && (selectedBranchId === 'ALL' || s.branchId === selectedBranchId)
    );
    return items.reduce((sum, item) => sum + item.quantityOnHand, 0);
  };

  // Filter products safely
  const matchedProducts = query
    ? products.filter(
        (p) =>
          (p.name && (p?.name || '').toLowerCase().includes(query)) ||
          (p.sku && (p?.sku || '').toLowerCase().includes(query)) ||
          (p.barcode && (p?.barcode || '').toLowerCase().includes(query)) ||
          (p.category && (p?.category || '').toLowerCase().includes(query))
      ).slice(0, 5)
    : [];

  // Filter Purchase Orders safely
  const matchedOrders = query
    ? purchaseOrders.filter(
        (po) =>
          (po.poNumber && (po?.poNumber || '').toLowerCase().includes(query)) ||
          (po.supplierName && (po?.supplierName || '').toLowerCase().includes(query)) ||
          (po.status && (po?.status || '').toLowerCase().includes(query))
      ).slice(0, 4)
    : [];

  // Filter Invoices safely
  const matchedInvoices = query
    ? invoices.filter(
        (inv) =>
          (inv.invoiceNumber && (inv?.invoiceNumber || '').toLowerCase().includes(query)) ||
          (inv.vendorBillNumber && (inv?.vendorBillNumber || '').toLowerCase().includes(query)) ||
          (inv.supplierName && (inv?.supplierName || '').toLowerCase().includes(query))
      ).slice(0, 4)
    : [];

  // Filter Shipments safely
  const matchedShipments = query
    ? shipments.filter(
        (sh) =>
          (sh.trackingCode && (sh?.trackingCode || '').toLowerCase().includes(query)) ||
          (sh.sourceBranchName && (sh?.sourceBranchName || '').toLowerCase().includes(query)) ||
          (sh.destinationBranchName && (sh?.destinationBranchName || '').toLowerCase().includes(query)) ||
          (sh.status && (sh?.status || '').toLowerCase().includes(query))
      ).slice(0, 4)
    : [];

  // Filter Assets safely
  const matchedAssets = query
    ? assets.filter(
        (a) =>
          (a.tagNumber && (a?.tagNumber || '').toLowerCase().includes(query)) ||
          (a.name && (a?.name || '').toLowerCase().includes(query)) ||
          (a.category && (a?.category || '').toLowerCase().includes(query))
      ).slice(0, 4)
    : [];

  // Filter Customer Devices safely
  const matchedDevices = query
    ? customerDevices.filter(
        (d) =>
          (d.customerCode && (d?.customerCode || '').toLowerCase().includes(query)) ||
          (d.customerName && (d?.customerName || '').toLowerCase().includes(query)) ||
          (d.productName && (d?.productName || '').toLowerCase().includes(query)) ||
          (d.deviceSerial && (d?.deviceSerial || '').toLowerCase().includes(query)) ||
          (d.contactPhone && (d?.contactPhone || '').toLowerCase().includes(query))
      ).slice(0, 4)
    : [];

  // Filter Suppliers safely
  const matchedSuppliers = query
    ? suppliers.filter(
        (s) =>
          (s.name && (s?.name || '').toLowerCase().includes(query)) ||
          (s.contactPerson && (s?.contactPerson || '').toLowerCase().includes(query)) ||
          (s.panVatNumber && (s?.panVatNumber || '').toLowerCase().includes(query)) ||
          (s.phone && (s?.phone || '').toLowerCase().includes(query))
      ).slice(0, 3)
    : [];

  // Filter Branches safely
  const matchedBranches = query
    ? branches.filter(
        (b) =>
          (b.name && (b?.name || '').toLowerCase().includes(query)) ||
          (b.code && (b?.code || '').toLowerCase().includes(query)) ||
          (b.location && (b?.location || '').toLowerCase().includes(query))
      ).slice(0, 3)
    : [];

  const totalResultsCount =
    matchedProducts.length +
    matchedOrders.length +
    matchedInvoices.length +
    matchedShipments.length +
    matchedAssets.length +
    matchedDevices.length +
    matchedSuppliers.length +
    matchedBranches.length;

  const handleItemClick = (tab: NavTab, text?: string) => {
    onSelectResult(tab, text || searchQuery);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 md:pt-20 px-4 bg-slate-950/70 backdrop-blur-sm transition-all animate-fadeIn">
      {/* Click outside backdrop */}
      <div className="fixed inset-0" onClick={onClose} />

      {/* Main Dialog Modal */}
      <div
        className={`relative w-full max-w-3xl rounded-2xl shadow-2xl border overflow-hidden flex flex-col max-h-[85vh] z-10 transition-all ${
          isDarkMode
            ? 'bg-[#0f1218] border-slate-800 text-slate-100'
            : 'bg-white border-slate-200 text-slate-900'
        }`}
      >
        {/* Search Header Input Bar */}
        <div
          className={`flex items-center gap-3 px-4 py-3.5 border-b ${
            isDarkMode ? 'border-slate-800 bg-slate-900/50' : 'border-slate-100 bg-slate-50/80'
          }`}
        >
          <Search className={`h-5 w-5 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Scan Barcode or Search & Enter Product Name / SKU:"
            className="w-full bg-transparent text-sm font-medium focus:outline-none placeholder:text-slate-400"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className={`text-xs px-2 py-1 rounded-md transition-colors ${
                isDarkMode ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
              }`}
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors ${
              isDarkMode ? 'hover:bg-slate-800 text-slate-400 hover:text-slate-200' : 'hover:bg-slate-200 text-slate-500 hover:text-slate-800'
            }`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search Results Area */}
        <div className="overflow-y-auto p-4 space-y-6 flex-1 custom-scrollbar">
          {!query ? (
            <div className="py-12 text-center">
              <Search className={`h-12 w-12 mx-auto mb-3 opacity-30 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`} />
              <p className={`text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                Global System Quick Search
              </p>
              <p className={`text-xs mt-1 max-w-md mx-auto ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                Search across all system databases instantly by entering item names, SKUs, barcode, purchase order numbers, invoice bills, serial numbers, customer details, or branch codes.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-4 text-[11px]">
                <span className={`px-2.5 py-1 rounded-full border ${isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                  e.g. "iPhone 15"
                </span>
                <span className={`px-2.5 py-1 rounded-full border ${isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                  e.g. "PO-2082"
                </span>
                <span className={`px-2.5 py-1 rounded-full border ${isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                  e.g. "INV-1092"
                </span>
                <span className={`px-2.5 py-1 rounded-full border ${isDarkMode ? 'border-slate-800 bg-slate-900 text-slate-400' : 'border-slate-200 bg-slate-100 text-slate-600'}`}>
                  e.g. "Branch 2"
                </span>
              </div>
            </div>
          ) : totalResultsCount === 0 ? (
            <div className="py-12 text-center">
              <Package className="h-10 w-10 mx-auto mb-2 text-slate-400 opacity-40" />
              <p className={`text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                No matching records found
              </p>
              <p className={`text-xs mt-1 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                No products, invoices, orders, or records matched "{searchQuery}".
              </p>
            </div>
          ) : (
            <>
              {/* Products Section */}
              {matchedProducts.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-indigo-500">
                      <Package className="h-4 w-4" /> Products & Inventory Stock ({matchedProducts.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('all-stock', searchQuery)}
                      className="text-xs text-indigo-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View in Catalog <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedProducts.map((p) => {
                      const totalQty = getProductStockQty(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => handleItemClick('all-stock', p.sku)}
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                            isDarkMode
                              ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-indigo-500/50'
                              : 'bg-white border-slate-200 hover:bg-indigo-50/50 hover:border-indigo-300'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-indigo-950/60 text-indigo-300' : 'bg-indigo-100 text-indigo-700'}`}>
                              <Package className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="font-bold text-xs flex items-center gap-2">
                                <span>{p.name}</span>
                                <span className="font-mono text-[10px] text-indigo-400 px-1.5 py-0.5 rounded bg-indigo-950/40 border border-indigo-500/20">
                                  {p.sku}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-400 flex items-center gap-3 mt-0.5">
                                <span>Category: {p.category}</span>
                                <span>•</span>
                                <span>Price: NPR {(p.sellingPrice || 0).toLocaleString('en-IN')}</span>
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <span
                              className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${
                                totalQty === 0
                                  ? 'bg-rose-950/50 text-rose-300 border border-rose-500/30'
                                  : totalQty <= (p.minReorderLevel || 0)
                                  ? 'bg-amber-950/50 text-amber-300 border border-amber-500/30'
                                  : 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/30'
                              }`}
                            >
                              Stock: {totalQty} {p.unit || 'Pcs'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Purchase Orders Section */}
              {matchedOrders.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-500">
                      <FileText className="h-4 w-4" /> Purchase Orders ({matchedOrders.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('po-list', searchQuery)}
                      className="text-xs text-amber-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View PO Register <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedOrders.map((po) => (
                      <div
                        key={po.id}
                        onClick={() => handleItemClick('po-list', po.poNumber)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-amber-500/50'
                            : 'bg-white border-slate-200 hover:bg-amber-50/50 hover:border-amber-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-amber-950/60 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>
                            <FileText className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>{po.poNumber}</span>
                              <span className="text-slate-400 text-[11px] font-normal">• {po.supplierName}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Date: {po.orderDateBS} BS | Total: NPR {(po.totalAmount || 0).toLocaleString('en-IN')}
                            </div>
                          </div>
                        </div>
                        <div>
                          <span
                            className={`text-[11px] font-bold px-2.5 py-1 rounded-full uppercase ${
                              po.status === 'RECEIVED'
                                ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/30'
                                : po.status === 'APPROVED'
                                ? 'bg-blue-950/50 text-blue-300 border border-blue-500/30'
                                : 'bg-amber-950/50 text-amber-300 border border-amber-500/30'
                            }`}
                          >
                            {po.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Purchase Invoices Section */}
              {matchedInvoices.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-emerald-500">
                      <Receipt className="h-4 w-4" /> Invoices & Bills ({matchedInvoices.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('purchase-list', searchQuery)}
                      className="text-xs text-emerald-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Invoice Ledger <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedInvoices.map((inv) => (
                      <div
                        key={inv.id}
                        onClick={() => handleItemClick('purchase-list', inv.invoiceNumber)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-emerald-500/50'
                            : 'bg-white border-slate-200 hover:bg-emerald-50/50 hover:border-emerald-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-emerald-950/60 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>
                            <Receipt className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>Inv #{inv.invoiceNumber}</span>
                              {inv.vendorBillNumber && (
                                <span className="text-slate-400 text-[11px] font-normal">(Bill: {inv.vendorBillNumber})</span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Supplier: {inv.supplierName} | Grand Total: NPR {(inv.grandTotal || 0).toLocaleString('en-IN')}
                            </div>
                          </div>
                        </div>
                        <div>
                          <span
                            className={`text-[11px] font-bold px-2.5 py-1 rounded-full uppercase ${
                              inv.paymentStatus === 'PAID'
                                ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/30'
                                : inv.paymentStatus === 'PARTIAL'
                                ? 'bg-amber-950/50 text-amber-300 border border-amber-500/30'
                                : 'bg-rose-950/50 text-rose-300 border border-rose-500/30'
                            }`}
                          >
                            {inv.paymentStatus}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Stock Transfers / Shipments */}
              {matchedShipments.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-purple-500">
                      <Truck className="h-4 w-4" /> Shipments & Transfers ({matchedShipments.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('shipment-list', searchQuery)}
                      className="text-xs text-purple-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Transfers <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedShipments.map((sh) => (
                      <div
                        key={sh.id}
                        onClick={() => handleItemClick('shipment-list', sh.trackingCode)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-purple-500/50'
                            : 'bg-white border-slate-200 hover:bg-purple-50/50 hover:border-purple-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-purple-950/60 text-purple-300' : 'bg-purple-100 text-purple-700'}`}>
                            <Truck className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>Code: {sh.trackingCode}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              {sh.sourceBranchName || 'HQ'} ➔ {sh.destinationBranchName} ({sh.items?.length || 0} items)
                            </div>
                          </div>
                        </div>
                        <div>
                          <span
                            className={`text-[11px] font-bold px-2.5 py-1 rounded-full uppercase ${
                              sh.status === 'RECEIVED'
                                ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/30'
                                : 'bg-purple-950/50 text-purple-300 border border-purple-500/30'
                            }`}
                          >
                            {sh.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Fixed Assets */}
              {matchedAssets.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-500">
                      <Monitor className="h-4 w-4" /> Fixed Assets ({matchedAssets.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('fixed-assets', searchQuery)}
                      className="text-xs text-cyan-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Fixed Assets <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedAssets.map((ast) => (
                      <div
                        key={ast.id}
                        onClick={() => handleItemClick('fixed-assets', ast.tagNumber)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-cyan-500/50'
                            : 'bg-white border-slate-200 hover:bg-cyan-50/50 hover:border-cyan-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-cyan-950/60 text-cyan-300' : 'bg-cyan-100 text-cyan-700'}`}>
                            <Monitor className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>{ast.name}</span>
                              <span className="font-mono text-[10px] text-cyan-400">({ast.tagNumber})</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Category: {ast.category} | Cost: NPR {(ast.acquisitionCost || 0).toLocaleString('en-IN')}
                            </div>
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            {ast.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Customer Devices */}
              {matchedDevices.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-rose-500">
                      <Wrench className="h-4 w-4" /> Customer Devices ({matchedDevices.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('customers', searchQuery)}
                      className="text-xs text-rose-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Devices <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedDevices.map((dev) => (
                      <div
                        key={dev.id}
                        onClick={() => handleItemClick('customers', dev.customerCode)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-rose-500/50'
                            : 'bg-white border-slate-200 hover:bg-rose-50/50 hover:border-rose-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-rose-950/60 text-rose-300' : 'bg-rose-100 text-rose-700'}`}>
                            <Wrench className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>{dev.productName}</span>
                              <span className="text-slate-400 text-[11px] font-normal">({dev.customerName})</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Code: {dev.customerCode} | Serial: {dev.deviceSerial}
                            </div>
                          </div>
                        </div>
                        <div>
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-rose-950/50 text-rose-300 border border-rose-500/30">
                            {dev.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suppliers */}
              {matchedSuppliers.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-500">
                      <Users className="h-4 w-4" /> Suppliers ({matchedSuppliers.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('suppliers', searchQuery)}
                      className="text-xs text-teal-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Suppliers <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedSuppliers.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => handleItemClick('suppliers', s.name)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-teal-500/50'
                            : 'bg-white border-slate-200 hover:bg-teal-50/50 hover:border-teal-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-teal-950/60 text-teal-300' : 'bg-teal-100 text-teal-700'}`}>
                            <Users className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs">{s.name}</div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              PAN/VAT: {s.panVatNumber} | Contact: {s.contactPerson} ({s.phone})
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Branches */}
              {matchedBranches.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-indigo-500">
                      <Building2 className="h-4 w-4" /> Branches ({matchedBranches.length})
                    </span>
                    <button
                      onClick={() => handleItemClick('branches', searchQuery)}
                      className="text-xs text-indigo-400 hover:underline flex items-center gap-1 font-medium"
                    >
                      View Branches <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {matchedBranches.map((b) => (
                      <div
                        key={b.id}
                        onClick={() => handleItemClick('branches', b.name)}
                        className={`flex items-center justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                          isDarkMode
                            ? 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-800/80 hover:border-indigo-500/50'
                            : 'bg-white border-slate-200 hover:bg-indigo-50/50 hover:border-indigo-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-indigo-950/60 text-indigo-300' : 'bg-indigo-100 text-indigo-700'}`}>
                            <Building2 className="h-5 w-5" />
                          </div>
                          <div>
                            <div className="font-bold text-xs flex items-center gap-2">
                              <span>{b.name}</span>
                              <span className="text-slate-400 text-[11px] font-normal">({b.code})</span>
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Location: {b.location} | Phone: {b.phone}
                            </div>
                          </div>
                        </div>
                        <div>
                          {b.isHeadquarters && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-500/30">
                              Headquarters
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div
          className={`px-4 py-2.5 border-t flex items-center justify-between text-xs ${
            isDarkMode ? 'border-slate-800 bg-slate-900/50 text-slate-400' : 'border-slate-100 bg-slate-50 text-slate-500'
          }`}
        >
          <div className="flex items-center gap-3">
            <span>
              Tip: Press <kbd className="px-1.5 py-0.5 rounded border border-slate-600 bg-slate-800 text-slate-200 font-mono text-[10px]">ESC</kbd> to close
            </span>
            <span>
              Press <kbd className="px-1.5 py-0.5 rounded border border-slate-600 bg-slate-800 text-slate-200 font-mono text-[10px]">Ctrl + K</kbd> to search anytime
            </span>
          </div>
          {totalResultsCount > 0 && (
            <span className="font-semibold text-indigo-400">
              {totalResultsCount} results found
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
