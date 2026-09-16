import React, { useState } from 'react';
import {
  Inbox,
  Truck,
  CheckCircle2,
  Clock,
  Search,
  Filter,
  PackageCheck,
  AlertTriangle,
  RotateCcw,
  Eye,
  X,
  Building,
  ArrowRight,
  ShieldAlert,
  ClipboardCheck,
  Package,
  Layers,
  FileText,
} from 'lucide-react';
import {
  User,
  StockOperation,
  Shipment,
  Product,
  Branch,
  InventoryStock,
  ApprovalRequest,
} from '../../types';
import { formatNPR } from '../../utils/nprFormat';

interface ReceiveInboundWarehouseProps {
  currentUser: User | null;
  operations: StockOperation[];
  shipments: Shipment[];
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  approvalRequests?: ApprovalRequest[];
  dateMode?: 'AD' | 'BS';
  onReceiveOperation: (id: string) => Promise<void>;
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
}

export const ReceiveInboundWarehouse: React.FC<ReceiveInboundWarehouseProps> = ({
  currentUser,
  operations = [],
  shipments = [],
  products = [],
  branches = [],
  stock = [],
  approvalRequests = [],
  dateMode = 'AD',
  onReceiveOperation,
  onReceiveShipment,
  onCancelReceiveShipment,
}) => {
  const isWarehouseStaffOrAdmin =
    currentUser?.role === 'SUPER_ADMIN' ||
    currentUser?.role === 'INVENTORY_MANAGER' ||
    currentUser?.branchId === 'WH001' ||
    !currentUser?.branchId ||
    currentUser?.branchId === 'ALL';

  if (!isWarehouseStaffOrAdmin) {
    return (
      <div className={`p-10 rounded-3xl border text-center space-y-4 max-w-2xl mx-auto my-8 bg-rose-50 border-rose-200 text-rose-900 dark:bg-rose-950/20 dark:border-rose-900/40 dark:text-rose-300`}>
        <ShieldAlert className="h-14 w-14 text-rose-500 mx-auto animate-bounce" />
        <h2 className="text-xl font-bold font-serif">Access Denied — Headquarters Warehouse Role Required</h2>
        <p className="text-xs leading-relaxed max-w-md mx-auto opacity-90">
          Receiving inbound pullout stock and warehouse shipments is restricted exclusively to Headquarters Warehouse Managers and Inventory Controllers. As a branch user (<strong>{currentUser?.branchId}</strong>), you can manage incoming transfers sent to your branch under <strong>Branch Operations ➔ Receive Branch Stock Transfer</strong>.
        </p>
      </div>
    );
  }

  const [activeTab, setActiveTab] = useState<'PULLOUTS' | 'SHIPMENTS'>('PULLOUTS');

  // Pullouts Filter state
  const [pulloutStatusFilter, setPulloutStatusFilter] = useState<'PENDING' | 'RECEIVED' | 'ALL'>('PENDING');
  const [pulloutBranchFilter, setPulloutBranchFilter] = useState<string>('ALL');
  const [pulloutSearchQuery, setPulloutSearchQuery] = useState<string>('');

  // Shipments Filter state
  const [shipmentStatusFilter, setShipmentStatusFilter] = useState<'PENDING' | 'RECEIVED' | 'ALL'>('PENDING');
  const [shipmentBranchFilter, setShipmentBranchFilter] = useState<string>('ALL');
  const [shipmentSearchQuery, setShipmentSearchQuery] = useState<string>('');

  // Modals state
  const [selectedPulloutToReceive, setSelectedPulloutToReceive] = useState<StockOperation | null>(null);
  const [pulloutReceiveNotes, setPulloutReceiveNotes] = useState<string>('');
  const [isReceivingPullout, setIsReceivingPullout] = useState<boolean>(false);

  const [selectedShipmentToReceive, setSelectedShipmentToReceive] = useState<Shipment | null>(null);

  // Filter Pullout operations (type === 'PULLOUT')
  const allPullouts = operations.filter((op) => op.type === 'PULLOUT');
  
  const filteredPullouts = allPullouts.filter((op) => {
    // Status filter
    if (pulloutStatusFilter === 'PENDING' && op.status === 'RECEIVED') return false;
    if (pulloutStatusFilter === 'RECEIVED' && op.status !== 'RECEIVED') return false;

    // Branch filter
    if (pulloutBranchFilter !== 'ALL' && op.branchId !== pulloutBranchFilter) return false;

    // Search query
    if (pulloutSearchQuery.trim() !== '') {
      const q = pulloutSearchQuery.toLowerCase();
      const matchRef = op.referenceNumber.toLowerCase().includes(q);
      const matchInspector = op.inspectorName?.toLowerCase().includes(q);
      const matchBranch = op.branchName?.toLowerCase().includes(q) || op.branchId.toLowerCase().includes(q);
      const matchReason = op.reason?.toLowerCase().includes(q);
      const matchItem = op.items?.some((i) => i.productName.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
      if (!matchRef && !matchInspector && !matchBranch && !matchReason && !matchItem) return false;
    }

    return true;
  });

  const pendingPulloutCount = allPullouts.filter((op) => op.status !== 'RECEIVED').length;
  const receivedPulloutCount = allPullouts.filter((op) => op.status === 'RECEIVED').length;

  // Filter Inbound Shipments destined for Central Warehouse / HQ
  const warehouseBranchIds = branches
    .filter(
      (b) =>
        b.isHeadquarters ||
        b.isWarehouse ||
        b.id === 'WH001' ||
        b.code.toUpperCase().startsWith('WH') ||
        b.name.toLowerCase().includes('warehouse') ||
        b.name.toLowerCase().includes('head office')
    )
    .map((b) => b.id);

  const inboundShipments = shipments.filter(
    (sh) =>
      sh.destinationBranchId === 'WH001' ||
      warehouseBranchIds.includes(sh.destinationBranchId) ||
      (sh.type === 'SUPPLIER_INBOUND' && (!sh.destinationBranchId || warehouseBranchIds.includes(sh.destinationBranchId)))
  );

  const filteredShipments = inboundShipments.filter((sh) => {
    const isReceived = sh.status === 'RECEIVED' || sh.status === 'DELIVERED';
    if (shipmentStatusFilter === 'PENDING' && isReceived) return false;
    if (shipmentStatusFilter === 'RECEIVED' && !isReceived) return false;

    if (shipmentBranchFilter !== 'ALL' && sh.sourceBranchId !== shipmentBranchFilter) return false;

    if (shipmentSearchQuery.trim() !== '') {
      const q = shipmentSearchQuery.toLowerCase();
      const matchTracking = sh.trackingCode.toLowerCase().includes(q);
      const matchSource = sh.sourceBranchName?.toLowerCase().includes(q) || sh.sourceBranchId?.toLowerCase().includes(q);
      const matchItem = sh.items?.some((i) => i.productName.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q));
      if (!matchTracking && !matchSource && !matchItem) return false;
    }

    return true;
  });

  const pendingShipmentCount = inboundShipments.filter((sh) => sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED').length;

  // Handle Receiving Pullout Bin
  const handleConfirmReceivePullout = async () => {
    if (!selectedPulloutToReceive) return;
    try {
      setIsReceivingPullout(true);
      await onReceiveOperation(selectedPulloutToReceive.id);
      setSelectedPulloutToReceive(null);
      setPulloutReceiveNotes('');
    } catch (err: any) {
      alert(`Failed to receive pullout bin: ${err?.message || err}`);
    } finally {
      setIsReceivingPullout(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {/* Header Banner - Compact Modern Redesign */}
      <div className="p-3.5 md:p-4 rounded-2xl border shadow-xs relative overflow-hidden bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 border-indigo-900/50 text-white">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 relative z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-400/30 flex items-center gap-1">
                <Building className="h-2.5 w-2.5" />
                HQ Intake
              </span>
              <span className="px-2 py-0.5 rounded-md text-[9px] font-extrabold uppercase tracking-wider bg-indigo-500/20 text-indigo-200 border border-indigo-400/30">
                WH001 Central Hub
              </span>
            </div>
            <h1 className="text-base md:text-lg font-serif font-bold tracking-tight text-white flex items-center gap-2">
              <Inbox className="h-4.5 w-4.5 text-indigo-400 shrink-0" />
              <span>Receive Inbound Stock & Branch Pullouts</span>
            </h1>
            <p className="text-[11px] text-indigo-200/80 mt-0.5 max-w-xl truncate">
              Inspect incoming branch returns, overstock pullouts, and shipments to credit directly into Central Warehouse inventory.
            </p>
          </div>

          {/* Quick Metrics Badges */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="px-3 py-1.5 rounded-xl bg-white/10 backdrop-blur-md border border-white/10 flex items-center gap-2.5">
              <Truck className="h-4 w-4 text-amber-400" />
              <div>
                <div className="text-[9px] font-bold text-indigo-200 uppercase tracking-wider">Pending Pullouts</div>
                <div className="text-sm font-bold font-mono text-amber-300 leading-tight">{pendingPulloutCount} Bins</div>
              </div>
            </div>
            <div className="px-3 py-1.5 rounded-xl bg-white/10 backdrop-blur-md border border-white/10 flex items-center gap-2.5">
              <Package className="h-4 w-4 text-sky-400" />
              <div>
                <div className="text-[9px] font-bold text-indigo-200 uppercase tracking-wider">Inbound Shipments</div>
                <div className="text-sm font-bold font-mono text-sky-300 leading-tight">{pendingShipmentCount} Consignments</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Primary Tab Switcher - Compact */}
      <div className="flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-1.5">
        <button
          onClick={() => setActiveTab('PULLOUTS')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-bold text-xs transition-all cursor-pointer ${activeTab === 'PULLOUTS' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-white dark:border-slate-800'}`}
        >
          <Truck className="h-3.5 w-3.5" />
          <span>1. Inbound Branch Pullout Bins</span>
          {pendingPulloutCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-extrabold bg-amber-500 text-white">
              {pendingPulloutCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('SHIPMENTS')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-bold text-xs transition-all cursor-pointer ${activeTab === 'SHIPMENTS' ? 'bg-sky-600 text-white shadow-xs' : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:hover:text-white dark:border-slate-800'}`}
        >
          <Package className="h-3.5 w-3.5" />
          <span>2. Inbound Warehouse Shipments</span>
          {pendingShipmentCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-extrabold bg-sky-500 text-white">
              {pendingShipmentCount}
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: INBOUND BRANCH PULLOUT BINS */}
      {activeTab === 'PULLOUTS' && (
        <div className="space-y-2.5">
          {/* Controls Bar */}
          <div className="p-2.5 rounded-xl border flex flex-wrap items-center justify-between gap-2.5 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
              <button
                onClick={() => setPulloutStatusFilter('PENDING')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${pulloutStatusFilter === 'PENDING' ? 'bg-amber-600 text-white shadow-xs' : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 dark:bg-slate-800 dark:text-amber-400 dark:hover:bg-slate-700'}`}
              >
                <Clock className="h-3 w-3" />
                <span>Pending Receipt ({pendingPulloutCount})</span>
              </button>

              <button
                onClick={() => setPulloutStatusFilter('RECEIVED')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${pulloutStatusFilter === 'RECEIVED' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 dark:bg-slate-800 dark:text-emerald-400 dark:hover:bg-slate-700'}`}
              >
                <CheckCircle2 className="h-3 w-3" />
                <span>Received ({receivedPulloutCount})</span>
              </button>

              <button
                onClick={() => setPulloutStatusFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer shrink-0 ${pulloutStatusFilter === 'ALL' ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
              >
                <span>All Bins ({allPullouts.length})</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {/* Branch Filter */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-slate-400 font-medium shrink-0 text-[11px]">Source:</span>
                <select
                  value={pulloutBranchFilter}
                  onChange={(e) => setPulloutBranchFilter(e.target.value)}
                  className="rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
                >
                  <option value="ALL">All Branches</option>
                  {branches.filter((b) => !b.isHeadquarters && b.id !== 'WH001').map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              {/* Search */}
              <div className="relative w-44 md:w-56 shrink-0">
                <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2" />
                <input
                  type="text"
                  placeholder="Search Ref #, Inspector, SKU..."
                  value={pulloutSearchQuery}
                  onChange={(e) => setPulloutSearchQuery(e.target.value)}
                  className="pl-7 pr-2.5 py-1 rounded-lg border text-xs focus:outline-none w-full bg-slate-50 border-slate-300 placeholder-slate-400 dark:bg-slate-900 dark:border-slate-800 dark:text-white dark:placeholder-slate-500"
                />
              </div>
            </div>
          </div>

          {/* List of Pullout Bins */}
          {filteredPullouts.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed text-center bg-white border-slate-300 text-slate-500 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-400">
              <Truck className="h-9 w-9 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
              <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200">No Branch Pullouts Found</h3>
              <p className="text-[11px] text-slate-400 max-w-md mx-auto mt-0.5">
                {pulloutStatusFilter === 'PENDING'
                  ? 'There are currently no pending pullout bins awaiting intake at Central Warehouse (WH001).'
                  : 'No pullout bins matching your search filter parameters.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5">
              {filteredPullouts.map((op) => {
                const isReceived = op.status === 'RECEIVED';

                return (
                  <div
                    key={op.id}
                    className={`p-3.5 rounded-2xl border transition-all ${isReceived ? 'bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800' : 'bg-gradient-to-br from-indigo-50/40 via-white to-white border-indigo-200 shadow-2xs dark:bg-gradient-to-br dark:from-indigo-950/20 dark:via-slate-900 dark:to-slate-900 dark:border-indigo-900/40'}`}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-2.5 border-b border-slate-200 dark:border-slate-800">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="font-mono text-[11px] font-extrabold text-indigo-600 bg-indigo-100 dark:text-indigo-400 dark:bg-indigo-950/80 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
                            {op.referenceNumber}
                          </span>
                          {isReceived ? (
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800 flex items-center gap-1">
                              <CheckCircle2 className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />
                              <span>RECEIVED AT WH001</span>
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800 flex items-center gap-1">
                              <Clock className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
                              <span>PENDING INTAKE</span>
                            </span>
                          )}
                        </div>

                        <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                          <span className="text-slate-400 font-normal text-[11px]">From:</span>
                          <span className="text-indigo-600 dark:text-indigo-400 font-bold">{op.branchName || op.branchId}</span>
                          <ArrowRight className="h-3 w-3 text-slate-400" />
                          <span className="text-slate-400 font-normal text-[11px]">To:</span>
                          <span className="text-slate-800 dark:text-slate-200 font-bold">{op.destinationWarehouseName || 'HQ WH001'}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <div className="text-right">
                          <div className="text-[9px] text-slate-400 font-mono">Date</div>
                          <div className="text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300">{op.dateAD}</div>
                        </div>

                        {!isReceived ? (
                          <button
                            onClick={() => setSelectedPulloutToReceive(op)}
                            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-xs flex items-center gap-1.5 transition-all cursor-pointer"
                          >
                            <PackageCheck className="h-3.5 w-3.5" />
                            <span>Verify & Receive</span>
                          </button>
                        ) : (
                          <div className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 text-[11px] font-bold flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                            <span>In WH001 Stock</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Pullout Reason & Details */}
                    <div className="py-1.5 text-[11px] text-slate-600 dark:text-slate-300 flex items-center justify-between gap-3">
                      <div className="truncate">
                        <span className="font-semibold text-slate-400">Notes: </span>
                        <span>{op.reason || 'Overstock / damaged stock return'}</span>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-semibold text-slate-400">Officer: </span>
                        <span className="font-medium text-slate-800 dark:text-slate-200">{op.inspectorName}</span>
                      </div>
                    </div>

                    {/* Itemized Contents Table */}
                    {op.items && op.items.length > 0 && (
                      <div className="mt-1.5 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                        <table className="w-full text-left text-xs">
                          <thead className="font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/80 dark:text-slate-400 dark:border-slate-800">
                            <tr>
                              <th className="px-2 py-1">Product SKU & Name</th>
                              <th className="px-2 py-1 text-center">Condition</th>
                              <th className="px-2 py-1 text-center">Qty</th>
                              <th className="px-2 py-1 text-right">Unit Price</th>
                              <th className="px-2 py-1 text-right">Valuation</th>
                              <th className="px-2 py-1 min-w-[180px]">Serials & PON</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-[11px]">
                            {op.items.map((item) => (
                              <tr key={item.id} className="hover:bg-slate-100/60 dark:hover:bg-slate-800/40">
                                <td className="p-2">
                                  <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400 text-[10px] block">
                                    [{item.sku}]
                                  </span>
                                  <span className="font-bold text-slate-900 dark:text-white">{item.productName}</span>
                                </td>

                                <td className="p-2 text-center">
                                  {item.condition === 'DAMAGED_STOCK' ? (
                                    <span className="px-1.5 py-0.2 rounded bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 font-extrabold text-[9px] border border-rose-200 dark:border-rose-800">
                                      ⚠️ DAMAGED
                                    </span>
                                  ) : (
                                    <span className="px-1.5 py-0.2 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 font-extrabold text-[9px] border border-emerald-200 dark:border-emerald-800">
                                      ✓ USABLE
                                    </span>
                                  )}
                                </td>

                                <td className="p-2 text-center font-mono font-bold text-slate-900 dark:text-white">
                                  {item.quantity} {item.unit || 'Pcs'}
                                </td>

                                <td className="p-2 text-right font-mono text-slate-500 text-[10px]">
                                  {formatNPR(item.unitCost)}
                                </td>

                                <td className="p-2 text-right font-mono font-bold text-slate-900 dark:text-white text-[10px]">
                                  {formatNPR(item.totalValue)}
                                </td>

                                <td className="p-2">
                                  {item.deviceSerials && item.deviceSerials.length > 0 ? (
                                    <div className="space-y-0.5">
                                      {item.deviceSerials.map((s, sIdx) => (
                                        <div key={sIdx} className="text-[9px] font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 flex items-center justify-between">
                                          <span>SN: {s.deviceSerial}</span>
                                          {s.ponSerial && <span className="text-indigo-500">PON: {s.ponSerial}</span>}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-slate-400 italic text-[9px]">Bulk product</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: INBOUND WAREHOUSE SHIPMENTS */}
      {activeTab === 'SHIPMENTS' && (
        <div className="space-y-2.5">
          <div className="p-2.5 rounded-xl border flex flex-wrap items-center justify-between gap-2.5 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShipmentStatusFilter('PENDING')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${shipmentStatusFilter === 'PENDING' ? 'bg-sky-600 text-white shadow-xs' : 'bg-sky-50 text-sky-800 border border-sky-200 hover:bg-sky-100 dark:bg-slate-800 dark:text-sky-400 dark:hover:bg-slate-700'}`}
              >
                <Clock className="h-3 w-3" />
                <span>In-Transit ({pendingShipmentCount})</span>
              </button>

              <button
                onClick={() => setShipmentStatusFilter('RECEIVED')}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${shipmentStatusFilter === 'RECEIVED' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 dark:bg-slate-800 dark:text-emerald-400 dark:hover:bg-slate-700'}`}
              >
                <CheckCircle2 className="h-3 w-3" />
                <span>Received ({inboundShipments.length - pendingShipmentCount})</span>
              </button>
            </div>

            <div className="relative w-44 md:w-56 shrink-0">
              <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                placeholder="Search tracking code or source..."
                value={shipmentSearchQuery}
                onChange={(e) => setShipmentSearchQuery(e.target.value)}
                className="pl-7 pr-2.5 py-1 rounded-lg border text-xs focus:outline-none w-full bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
              />
            </div>
          </div>

          {filteredShipments.length === 0 ? (
            <div className="p-8 rounded-2xl border border-dashed text-center bg-white border-slate-300 text-slate-500 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-400">
              <Package className="h-9 w-9 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
              <h3 className="font-bold text-xs text-slate-800 dark:text-slate-200">No Inbound Warehouse Shipments Found</h3>
              <p className="text-[11px] text-slate-400 max-w-md mx-auto mt-0.5">
                No shipments matching your filter parameters are currently in-transit to Headquarters Warehouse.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {filteredShipments.map((sh) => {
                const isReceived = sh.status === 'RECEIVED' || sh.status === 'DELIVERED';

                return (
                  <div
                    key={sh.id}
                    className="p-3.5 rounded-2xl border flex flex-col justify-between space-y-2 bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-mono text-xs font-bold text-sky-600 dark:text-sky-400">
                          {sh.trackingCode}
                        </span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${
                          isReceived
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-400 dark:border-emerald-800'
                            : 'bg-sky-50 text-sky-700 border-sky-300 dark:bg-sky-950/60 dark:text-sky-400 dark:border-sky-800'
                        }`}>
                          {sh.status}
                        </span>
                      </div>

                      <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5 mt-0.5">
                        <span className="truncate">{sh.sourceBranchName || sh.sourceBranchId || 'Supplier / Dispatch'}</span>
                        <ArrowRight className="h-3 w-3 text-slate-400 shrink-0" />
                        <span className="truncate">{sh.destinationBranchName || 'HQ WH001'}</span>
                      </div>

                      <div className="mt-1.5 text-[11px] text-slate-500 space-y-0.5">
                        <div>Items: <strong className="text-slate-800 dark:text-slate-200">{sh.items?.length || 0} Products</strong></div>
                        {sh.notes && <div className="italic text-[10px] truncate">Notes: {sh.notes}</div>}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400 font-mono">Dispatched: {sh.dispatchDateAD}</span>
                      {!isReceived && (
                        <button
                          onClick={() => onReceiveShipment(sh.id)}
                          className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs shadow-xs cursor-pointer flex items-center gap-1"
                        >
                          <PackageCheck className="h-3 w-3" />
                          <span>Receive Shipment</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* VERIFY & RECEIVE PULLOUT MODAL */}
      {selectedPulloutToReceive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="w-full max-w-xl rounded-2xl border shadow-2xl p-5 overflow-hidden bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white">
            <div className="flex items-center justify-between pb-2.5 border-b border-slate-200 dark:border-slate-800 mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-500">
                  <PackageCheck className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="font-serif font-bold text-sm">Verify & Receive Inbound Pullout</h3>
                  <p className="text-[10px] text-slate-400 font-mono">Bin Ref: {selectedPulloutToReceive.referenceNumber}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPulloutToReceive(null)}
                className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-white transition-all cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              {/* Summary Banner */}
              <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 text-indigo-900 dark:text-indigo-200 leading-relaxed text-[11px]">
                <strong>Warehouse Intake Rule:</strong> Verifying this pullout bin will update its status to <strong>RECEIVED</strong> and credit stock directly into Central Warehouse (WH001).
                <ul className="mt-0.5 list-disc list-inside text-[10px] space-y-0.5">
                  <li><strong>Usable Overstock:</strong> Added to WH001 Usable Inventory On-Hand.</li>
                  <li><strong>Damaged Stock:</strong> Added to WH001 Damaged / Defective Stock Bin for vendor RMA.</li>
                </ul>
              </div>

              {/* Source & Details */}
              <div className="grid grid-cols-2 gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[11px]">
                <div>
                  <span className="text-[9px] text-slate-400 font-bold block">SOURCE BRANCH</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{selectedPulloutToReceive.branchName || selectedPulloutToReceive.branchId}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-400 font-bold block">INSPECTOR / OFFICER</span>
                  <span className="font-bold text-slate-800 dark:text-slate-200">{selectedPulloutToReceive.inspectorName}</span>
                </div>
              </div>

              {/* Items List */}
              <div>
                <label className="block font-bold mb-1 text-[11px]">Inspected Pullout Stock Items ({selectedPulloutToReceive.items?.length || 0}):</label>
                <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1.5 space-y-1.5">
                  {selectedPulloutToReceive.items?.map((item) => (
                    <div key={item.id} className="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 flex items-center justify-between text-[11px]">
                      <div>
                        <span className="font-mono text-[9px] text-indigo-500 font-bold">[{item.sku}] </span>
                        <span className="font-bold">{item.productName}</span>
                        <div className="text-[9px] text-slate-400">
                          Condition: <strong className={item.condition === 'DAMAGED_STOCK' ? 'text-rose-500' : 'text-emerald-500'}>{item.condition}</strong>
                        </div>
                      </div>
                      <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        {item.quantity} {item.unit || 'pcs'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Verification Notes */}
              <div>
                <label className="block font-bold mb-1 text-[11px]">Receiver Notes (Optional)</label>
                <textarea
                  rows={2}
                  value={pulloutReceiveNotes}
                  onChange={(e) => setPulloutReceiveNotes(e.target.value)}
                  placeholder="e.g. Verified physical quantities and device serials match bin dispatch manifest..."
                  className="w-full rounded-xl border p-2 text-xs bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white"
                />
              </div>

              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedPulloutToReceive(null)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold text-xs hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isReceivingPullout}
                  onClick={handleConfirmReceivePullout}
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-xs cursor-pointer flex items-center gap-1.5"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>{isReceivingPullout ? 'Receiving...' : 'Confirm Receipt & Credit WH001 Stock'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
