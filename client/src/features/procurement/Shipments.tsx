import React, { useState, useEffect } from 'react';
import { Shipment, Product, Branch, InventoryStock, User, CustomerDeviceRecord, ApprovalRequest } from '../../types';
import { Truck, Search, PackageCheck, History, Send, Eye, X, Barcode, ArrowRight, Info } from 'lucide-react';
import { PageHeader } from '../../components/common/PageHeader';
import { KeepMounted } from '../../components/common/KeepMounted';
import { useDarkMode } from '../../contexts/DarkModeContext';
import { ShipmentRegister } from './ShipmentRegister';
import { CreateShipmentForm, type ShipmentFormLine } from './CreateShipmentForm';

interface ShipmentsProps {
  currentUser?: User | null;
  activeTab?: string;
  shipments: Shipment[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  customerDevices?: CustomerDeviceRecord[];
  approvalRequests?: ApprovalRequest[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  onCreateShipment: (
    shipment: Omit<Shipment, 'id' | 'trackingCode'>
  ) => Promise<void>;
  onReceiveShipment: (
    id: string,
    verificationData?: {
      receivedItems?: {
        itemId: string;
        quantityReceived: number;
        receivedSerials?: { deviceSerial: string; ponSerial?: string }[];
        itemDiscrepancyNotes?: string;
      }[];
      receivedByNotes?: string;
    }
  ) => Promise<void>;
  onCancelReceiveShipment?: (id: string, reason?: string) => Promise<void>;
  onRequestApproval?: (
    requestData: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>
  ) => Promise<void>;
  onCancelApproval?: (requestId: string) => Promise<void>;
  isDarkMode?: boolean;
}

export const Shipments: React.FC<ShipmentsProps> = ({
  currentUser,
  activeTab = 'shipment-list',
  shipments,
  products,
  branches,
  stock,
  customerDevices = [],
  approvalRequests = [],
  selectedBranchId,
  dateMode,
  onCreateShipment,
  onReceiveShipment,
  onCancelReceiveShipment,
  onRequestApproval,
  onCancelApproval,
}) => {
  const { isDarkMode } = useDarkMode();
  const [internalTab, setInternalTab] = useState<'REGISTER' | 'CREATE_SHIPMENT' | 'VIEW'>(
    activeTab === 'create-shipment' ? 'CREATE_SHIPMENT' : 'REGISTER'
  );
  const [viewingShipment, setViewingShipment] = useState<Shipment | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Report Filters (dispatch date range, status, transfer direction)
  const [startDateAD, setStartDateAD] = useState<string>('');
  const [endDateAD, setEndDateAD] = useState<string>('');
  const [shipmentStatusFilter, setShipmentStatusFilter] = useState<string>('ALL');
  const [shipmentMode, setShipmentMode] = useState<'ALL' | 'CREATED' | 'RECEIVED'>('ALL');

  useEffect(() => {
    if (activeTab === 'create-shipment') {
      setInternalTab('CREATE_SHIPMENT');
    } else if (activeTab === 'shipment-list') {
      setInternalTab('REGISTER');
    }
  }, [activeTab]);

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 5000);
  };

  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const userBranchId = currentUser?.branchId && currentUser.branchId !== 'ALL' ? currentUser.branchId : null;

  // Multi-Item Transfer Lines with Serial tracking
  const [lines, setLines] = useState<ShipmentFormLine[]>([]);

  const filteredShipments = shipments.filter((sh) => {
    // If branch user, show shipments involving their branch
    const effectiveBranchId = userBranchId || selectedBranchId;
    const matchesBranch =
      effectiveBranchId === 'ALL' ||
      sh.destinationBranchId === effectiveBranchId ||
      sh.sourceBranchId === effectiveBranchId;
    const matchesSearch =
      (sh?.trackingCode || '').toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      (sh.sourceBranchName && (sh?.sourceBranchName || '').toLowerCase().includes((searchQuery || '').toLowerCase())) ||
      (sh?.destinationBranchName || '').toLowerCase().includes((searchQuery || '').toLowerCase());
    if (!matchesBranch || !matchesSearch) return false;

    // Dispatch date range filter (AD)
    if (startDateAD && sh.dispatchDateAD < startDateAD) return false;
    if (endDateAD && sh.dispatchDateAD > endDateAD) return false;

    // Transfer direction relative to the user's / selected branch
    const referenceBranchId = userBranchId || (selectedBranchId !== 'ALL' ? selectedBranchId : null);
    if (shipmentMode === 'CREATED') {
      if (!sh.sourceBranchId) return false;
      if (referenceBranchId && sh.sourceBranchId !== referenceBranchId) return false;
    } else if (shipmentMode === 'RECEIVED') {
      if (!sh.destinationBranchId) return false;
      if (referenceBranchId && sh.destinationBranchId !== referenceBranchId) return false;
    }

    // Status filter
    if (shipmentStatusFilter !== 'ALL' && sh.status !== shipmentStatusFilter) return false;

    return true;
  });

  const handleResetShipmentFilters = () => {
    setStartDateAD('');
    setEndDateAD('');
    setShipmentStatusFilter('ALL');
    setShipmentMode('ALL');
    setSearchQuery('');
  };

  const onViewShipment = (sh: Shipment) => {
    setViewingShipment(sh);
    setInternalTab('VIEW');
  };

  return (
    <div className="space-y-3">
      {/* Header & Controls — shared PageHeader (single h2 per screen rule) */}
      <PageHeader
        title="Warehouse Logistics & Stock Dispatches"
        description="Scan barcode or search products to dispatch stock transfers to destination branches or process warehouse sales."
        icon={<Truck className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />}
        actions={
          <div className="flex items-center gap-3">
            <div className="relative w-full md:w-80 lg:w-96 shrink-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search Tracking Code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`pl-9 pr-3 py-2 text-xs rounded-xl border focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48 sm:w-64 ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
                }`}
              />
            </div>

            {!isSuperAdmin ? (
              <div className="flex items-center gap-1.5 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2 text-[11px] font-medium text-indigo-700 dark:text-indigo-300">
                <PackageCheck className={`h-4 w-4 flex-shrink-0 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`} />
                <span>Branch Inbound Mode: Receive incoming stock shipments below.</span>
              </div>
            ) : null}
          </div>
        }
      />

      {/* Rail Sub-Navigation Tabs Bar (Like Purchase Invoices) */}
      {activeTab !== 'create-shipment' && activeTab !== 'shipment-list' && <div
        className={`flex items-center gap-1.5 border-b pb-1 overflow-x-auto ${
          isDarkMode ? 'border-slate-800' : 'border-slate-200'
        }`}
      >
        <button
          type="button"
          id="tab-shipment-register"
          onClick={() => setInternalTab('REGISTER')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${
            internalTab === 'REGISTER'
              ? 'bg-indigo-600 text-white shadow-sm'
              : isDarkMode
              ? 'text-slate-400 hover:text-white hover:bg-slate-800'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <History className="h-4 w-4" />
          <span>Shipment & Transfer Register</span>
          <span
            className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
              internalTab === 'REGISTER'
                ? 'bg-indigo-800 text-white'
                : isDarkMode
                ? 'bg-slate-800 text-slate-300'
                : 'bg-slate-200 text-slate-700'
            }`}
          >
            {filteredShipments.length}
          </span>
        </button>

        <button
          type="button"
          id="tab-shipment-form"
          onClick={() => setInternalTab('CREATE_SHIPMENT')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${
            internalTab === 'CREATE_SHIPMENT'
              ? 'bg-indigo-600 text-white shadow-sm'
              : isDarkMode
              ? 'text-slate-400 hover:text-white hover:bg-slate-800'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <Send className="h-4 w-4" />
          <span>New Warehouse Dispatch & Sale Form (Inline POS & Scan)</span>
          {lines.length > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                internalTab === 'CREATE_SHIPMENT'
                  ? 'bg-indigo-800 text-white'
                  : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}
            >
              {lines.length} items
            </span>
          )}
        </button>

        {viewingShipment && (
          <button
            type="button"
            id="tab-shipment-view"
            onClick={() => setInternalTab('VIEW')}
            className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${
              internalTab === 'VIEW'
                ? 'bg-indigo-600 text-white shadow-sm'
                : isDarkMode
                ? 'text-slate-400 hover:text-white hover:bg-slate-800'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Eye className="h-4 w-4" />
            <span>Manifest Details #{viewingShipment.trackingCode}</span>
          </button>
        )}
      </div>}

      {/* Register sub-component — kept mounted after first activation so the
          page number, open verification modals and filter draft survive
          sub-tab switches (the component-level state this file used to own). */}
      <KeepMounted visible={internalTab === 'REGISTER'}>
        <ShipmentRegister
          currentUser={currentUser}
          userBranchId={userBranchId}
          branches={branches}
          selectedBranchId={selectedBranchId}
          dateMode={dateMode}
          approvalRequests={approvalRequests}
          filteredShipments={filteredShipments}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          startDateAD={startDateAD}
          setStartDateAD={setStartDateAD}
          endDateAD={endDateAD}
          setEndDateAD={setEndDateAD}
          shipmentStatusFilter={shipmentStatusFilter}
          setShipmentStatusFilter={setShipmentStatusFilter}
          shipmentMode={shipmentMode}
          setShipmentMode={setShipmentMode}
          onClearFilters={handleResetShipmentFilters}
          onViewShipment={onViewShipment}
          onReceiveShipment={onReceiveShipment}
          onCancelReceiveShipment={onCancelReceiveShipment}
          onRequestApproval={onRequestApproval}
          onCancelApproval={onCancelApproval}
          onShowToast={showToast}
        />
      </KeepMounted>

      {/* Create-shipment sub-component — same keep-mounted treatment, so the
          half-filled form (branch pair, notes) survives a trip to the register. */}
      <KeepMounted visible={internalTab === 'CREATE_SHIPMENT'}>
        <CreateShipmentForm
          currentUser={currentUser}
          branches={branches}
          products={products}
          stock={stock}
          customerDevices={customerDevices}
          lines={lines}
          setLines={setLines}
          onCreateShipment={onCreateShipment}
          onShowToast={showToast}
          onDone={() => setInternalTab('REGISTER')}
        />
      </KeepMounted>

      {/* View Shipment Details Modal */}
      {viewingShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#0f1218] shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden text-slate-800 dark:text-slate-200 my-8">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 p-4">
              <h3 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                <Truck className={`h-4 w-4 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`} />
                <span>Stock Transfer Manifest — {viewingShipment.trackingCode}</span>
              </h3>
              <button
                onClick={() => setViewingShipment(null)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-4 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Source Branch</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{viewingShipment.sourceBranchName || 'Central Warehouse'}</span>
                </div>
                <ArrowRight className={`h-5 w-5 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`} />
                <div className="text-right">
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Destination Branch</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{viewingShipment.destinationBranchName}</span>
                </div>
              </div>

              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 dark:bg-slate-900 text-slate-500 font-bold text-[10px]">
                    <tr>
                      <th className="px-2.5 py-1.5">#</th>
                      <th className="px-2.5 py-1.5">Product Name</th>
                      <th className="px-2.5 py-1.5">SKU</th>
                      <th className="px-2.5 py-1.5 text-center">Qty Sent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {viewingShipment.items.map((item, idx) => (
                      <React.Fragment key={idx}>
                        <tr>
                          <td className="p-2.5 font-mono text-slate-400">{idx + 1}</td>
                          <td className="p-2.5 font-bold text-slate-800 dark:text-white">{item.productName}</td>
                          <td className="p-2.5 font-mono text-slate-500">{item.sku}</td>
                          <td className="p-2.5 text-center font-mono font-bold text-indigo-600 dark:text-indigo-400">{item.quantitySent} Units</td>
                        </tr>

                        {/* Render Serial Numbers if present */}
                        {item.deviceSerials && item.deviceSerials.length > 0 && (
                          <tr className="bg-indigo-50/40 dark:bg-indigo-950/30">
                            <td colSpan={4} className="p-2.5">
                              <div className="text-[11px] font-bold text-indigo-900 dark:text-indigo-300 mb-1.5 flex items-center gap-1.5">
                                <Barcode className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                                <span>Attached Device & PON Serial Numbers:</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {item.deviceSerials.map((s, sIdx) => (
                                  <div key={sIdx} className="bg-white dark:bg-slate-900 p-2 rounded border border-indigo-100 dark:border-indigo-900/50 flex items-center justify-between font-mono text-[11px]">
                                    <span className="text-slate-400 font-bold">#{sIdx + 1}</span>
                                    <span className="text-indigo-700 dark:text-indigo-300 font-bold">{s.deviceSerial}</span>
                                    {s.ponSerial && <span className="text-blue-600 dark:text-blue-400 font-semibold">{s.ponSerial}</span>}
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-2xl bg-slate-900 text-white shadow-2xl border border-slate-700 text-xs font-semibold animate-in slide-in-from-bottom duration-200">
          <Info className="h-4 w-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="ml-2 text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
