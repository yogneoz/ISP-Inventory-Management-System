import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Shipment,
} from '../../../types';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Tag,
  Inbox,
  ArrowRight,
  ShieldAlert,
  PackageCheck,
  RotateCcw,
  Clock,
  XCircle,
} from 'lucide-react';

/**
 * ReceiveTransferPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const ReceiveTransferPanel: React.FC = () => {
  const { activeTab, allowedBranches, approvalRequests, branchFilter, branches, canSeeAll, currentUser, expandedShipmentId, onReceiveShipment, openReceiveModal, products, selectedBranchId, setBranchFilter, setCancelPendingRequestModal, setDirectCancelModalShipment, setDirectCancelReason, setExpandedShipmentId, setRequestCancelModalShipment, setRequestCancelReason, setTransferStatusFilter, shipments, transferStatusFilter } = useStockOperationsCtx();
  return (
    <>
      {activeTab === 'RECEIVE_TRANSFER' && (
        <div className="space-y-3">
          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <Inbox className={`h-4 w-4 text-amber-500 dark:text-amber-400`} />
                <span>Inter-Branch Transfer Dispatches & Incoming Stock</span>
              </h3>
            </div>

            {/* Status Filter Tabs & Header Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
                {(() => {
                  const isUserRelatedShipment = (sh: Shipment) => {
                    const userBranchId = currentUser?.branchId;
                    const userBranchIds = allowedBranches.map((b) => b.id);
                    if (canSeeAll) {
                      if (branchFilter === 'ALL') return true;
                      return sh.sourceBranchId === branchFilter || sh.destinationBranchId === branchFilter;
                    }
                    if (branchFilter !== 'ALL') {
                      return sh.sourceBranchId === branchFilter || sh.destinationBranchId === branchFilter;
                    }
                    return (
                      sh.sourceBranchId === userBranchId ||
                      sh.destinationBranchId === userBranchId ||
                      (sh.sourceBranchId ? userBranchIds.includes(sh.sourceBranchId) : false) ||
                      userBranchIds.includes(sh.destinationBranchId)
                    );
                  };

                  const totalCount = shipments.filter(isUserRelatedShipment).length;
                  const inTransitCount = shipments.filter((sh) => isUserRelatedShipment(sh) && sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED' && sh.status !== 'CANCELLED').length;
                  const cancelPendingCount = shipments.filter((sh) => {
                    const isRelated = isUserRelatedShipment(sh);
                    const hasPendingReq = approvalRequests?.some(
                      (r) => (r.type === 'CANCEL_TRANSFER' || r.type === 'CANCEL_IN_TRANSIT_TRANSFER' || r.type === 'CANCEL_RECEIVE_TRANSFER') && (r.targetId === sh.id || r.deviceSerial === sh.trackingCode || r.customerName === sh.trackingCode) && r.status === 'PENDING'
                    );
                    return isRelated && hasPendingReq && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED';
                  }).length;
                  const receivedCount = shipments.filter((sh) => isUserRelatedShipment(sh) && (sh.status === 'RECEIVED' || sh.status === 'DELIVERED')).length;
                  const cancelledCount = shipments.filter((sh) => isUserRelatedShipment(sh) && sh.status === 'CANCELLED').length;

                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => setTransferStatusFilter('ALL')}
                        className={`px-3 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 ${transferStatusFilter === 'ALL' ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:bg-slate-700'}`}
                      >
                        All Transfers ({totalCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferStatusFilter('IN_TRANSIT')}
                        className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shrink-0 ${transferStatusFilter === 'IN_TRANSIT' ? 'bg-sky-600 text-white shadow-xs' : 'bg-sky-50 text-sky-800 border border-sky-200 hover:bg-sky-100 dark:bg-slate-800/80 dark:text-sky-400 dark:hover:bg-slate-700'}`}
                      >
                        <Clock className="h-3 w-3" />
                        <span>In Transit ({inTransitCount})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferStatusFilter('CANCEL_PENDING')}
                        className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shrink-0 ${transferStatusFilter === 'CANCEL_PENDING' ? 'bg-amber-600 text-white shadow-xs' : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 dark:bg-slate-800/80 dark:text-amber-400 dark:hover:bg-slate-700'}`}
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Cancel Pending ({cancelPendingCount})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferStatusFilter('RECEIVED')}
                        className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shrink-0 ${transferStatusFilter === 'RECEIVED' ? 'bg-emerald-600 text-white shadow-xs' : 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 dark:bg-slate-800/80 dark:text-emerald-400 dark:hover:bg-slate-700'}`}
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        <span>Stock Received ({receivedCount})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferStatusFilter('CANCELLED')}
                        className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer shrink-0 ${transferStatusFilter === 'CANCELLED' ? 'bg-rose-600 text-white shadow-xs' : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100 dark:bg-slate-800/80 dark:text-rose-400 dark:hover:bg-slate-700'}`}
                      >
                        <XCircle className="h-3 w-3" />
                        <span>Cancelled ({cancelledCount})</span>
                      </button>
                    </>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-medium shrink-0">Branch Context:</span>
                <select
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  className={`rounded-xl border px-3 py-1 text-xs font-medium focus:outline-none bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {canSeeAll ? (
                    <option value="ALL">All Branches</option>
                  ) : allowedBranches.length > 1 ? (
                    <option value="ALL">All My Assigned Branches ({allowedBranches.length})</option>
                  ) : null}
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>
            </div>

            {/* HIGH DENSITY EXPANDABLE TABLE LAYOUT */}
            <div className={`overflow-x-auto rounded-2xl border shadow-xs border-slate-200 bg-white text-slate-900 dark:border-slate-800 dark:bg-[#0f1218] dark:text-slate-200`}>
              <table className="w-full text-left border-collapse text-xs">
                <thead className={`text-[11px] font-bold tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/90 dark:text-slate-400 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-1.5 w-10 text-center">#</th>
                    <th className="px-2.5 py-1.5">Transfer Code</th>
                    <th className="px-2.5 py-1.5">Route (Sender ➔ Recipient)</th>
                    <th className="px-2.5 py-1.5">Dispatch Date</th>
                    <th className="px-2.5 py-1.5 text-center">Items & Qty</th>
                    <th className="px-2.5 py-1.5 text-right">Valuation (NPR)</th>
                    <th className="px-2.5 py-1.5 text-center">Status</th>
                    <th className="px-2.5 py-1.5 text-right">Action Controls</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200/80 dark:divide-slate-800/80`}>
                  {(() => {
                    const userBranchId = currentUser?.branchId;
                    const userBranchIds = allowedBranches.map((b) => b.id);

                    const isUserRelatedShipment = (sh: Shipment) => {
                      if (canSeeAll) {
                        if (branchFilter === 'ALL') return true;
                        return sh.sourceBranchId === branchFilter || sh.destinationBranchId === branchFilter;
                      }
                      if (branchFilter !== 'ALL') {
                        return sh.sourceBranchId === branchFilter || sh.destinationBranchId === branchFilter;
                      }
                      return (
                        sh.sourceBranchId === userBranchId ||
                        sh.destinationBranchId === userBranchId ||
                        (sh.sourceBranchId && userBranchIds.includes(sh.sourceBranchId)) ||
                        (sh.destinationBranchId && userBranchIds.includes(sh.destinationBranchId))
                      );
                    };

                    const filteredShipments = shipments.filter((sh) => {
                      if (!isUserRelatedShipment(sh)) return false;

                      const hasPendingReq = approvalRequests?.some(
                        (r) => (r.type === 'CANCEL_TRANSFER' || r.type === 'CANCEL_IN_TRANSIT_TRANSFER' || r.type === 'CANCEL_RECEIVE_TRANSFER') && (r.targetId === sh.id || r.deviceSerial === sh.trackingCode || r.customerName === sh.trackingCode) && r.status === 'PENDING'
                      );

                      if (transferStatusFilter === 'IN_TRANSIT') return sh.status !== 'RECEIVED' && sh.status !== 'DELIVERED' && sh.status !== 'CANCELLED';
                      if (transferStatusFilter === 'RECEIVED') return sh.status === 'RECEIVED' || sh.status === 'DELIVERED';
                      if (transferStatusFilter === 'CANCEL_PENDING') return hasPendingReq && sh.status !== 'CANCELLED' && sh.status !== 'RECEIVED';
                      if (transferStatusFilter === 'CANCELLED') return sh.status === 'CANCELLED';
                      return true;
                    });

                    if (filteredShipments.length === 0) {
                      return (
                        <tr>
                          <td colSpan={8} className="p-8 text-center text-slate-400">
                            <Inbox className="h-10 w-10 mx-auto mb-2 opacity-40" />
                            <p className="font-semibold text-sm">No transfer dispatches match the selected branch and status filter.</p>
                          </td>
                        </tr>
                      );
                    }

                    return filteredShipments.map((sh) => {
                      const isExpanded = expandedShipmentId === sh.id;
                      const pendingCancelReq = approvalRequests?.find(
                        (r) =>
                          (r.type === 'CANCEL_TRANSFER' || r.type === 'CANCEL_IN_TRANSIT_TRANSFER' || r.type === 'CANCEL_RECEIVE_TRANSFER') &&
                          (r.targetId === sh.id || r.deviceSerial === sh.trackingCode || r.customerName === sh.trackingCode) &&
                          r.status === 'PENDING'
                      );

                      const isReceived = sh.status === 'RECEIVED' || sh.status === 'DELIVERED';
                      const isCancelled = sh.status === 'CANCELLED';
                      const isInTransit = !isReceived && !isCancelled;

                      const totalQty = sh.items?.reduce((sum, item) => sum + (Number(item.quantitySent) || 0), 0) || 0;
                      const totalValue = sh.items?.reduce((sum, item) => sum + ((Number(item.quantitySent) || 0) * (item.costPrice || 0)), 0) || 0;

                      const activeBranchId = selectedBranchId || currentUser?.branchId || '';
                      const activeBranchObj = branches.find((b) => b.id === activeBranchId || b.id === currentUser?.branchId);
                      const activeBranchName = activeBranchObj?.name || '';

                      const isSenderBranch = Boolean(
                        (sh.sourceBranchId && (sh.sourceBranchId === activeBranchId || sh.sourceBranchId === currentUser?.branchId || userBranchIds.includes(sh.sourceBranchId))) ||
                        (sh.sourceBranchName && activeBranchName && (
                          sh.sourceBranchName.toLowerCase().includes(activeBranchName.toLowerCase()) ||
                          activeBranchName.toLowerCase().includes(sh.sourceBranchName.toLowerCase())
                        ))
                      );

                      const isRecipientBranch = Boolean(
                        (sh.destinationBranchId && (sh.destinationBranchId === activeBranchId || sh.destinationBranchId === currentUser?.branchId || userBranchIds.includes(sh.destinationBranchId))) ||
                        (sh.destinationBranchName && activeBranchName && (
                          sh.destinationBranchName.toLowerCase().includes(activeBranchName.toLowerCase()) ||
                          activeBranchName.toLowerCase().includes(sh.destinationBranchName.toLowerCase())
                        ))
                      );

                      const canDirectCancelTransfer = isOperationAllowed('branch-transfer-cancel-receive', currentUser?.role);
                      const canRequestCancelTransfer = isOperationAllowed('branch-transfer-request-cancel', currentUser?.role);
                      const canSuperCancelTransfers = canDirectCancelTransfer || canRequestCancelTransfer;

                      // STRICT WORKFLOW RULES:
                      // 1. Creator/Sender Branch:
                      //    - CANNOT see "Verify & Receive Stock"
                      //    - CAN see "Cancel Request" (if in-transit & not received yet)
                      // 2. Receiver/Destination Branch:
                      //    - CAN see "Verify & Receive Stock"
                      //    - CANNOT see "Cancel Request"
                      const canShowReceiveBtn = isInTransit && (isRecipientBranch || (canSuperCancelTransfers && !isSenderBranch)) && !isSenderBranch;
                      const canShowCancelBtn = isInTransit && (isSenderBranch || (canSuperCancelTransfers && !isRecipientBranch)) && !isRecipientBranch;

                      return (
                        <React.Fragment key={sh.id}>
                          <tr className={`transition-colors ${isExpanded ? 'bg-indigo-50/60 dark:bg-indigo-950/20' : 'hover:bg-slate-200 dark:hover:bg-slate-800/40'}`}>
                            {/* 1. Toggle button */}
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => setExpandedShipmentId(isExpanded ? null : sh.id)}
                                className={`p-1.5 rounded-lg border transition-all cursor-pointer ${isExpanded ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-100 text-slate-600 hover:text-slate-900 border-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-white dark:border-slate-700'}`}
                                title={isExpanded ? "Collapse item details" : "Expand itemized stock breakdown"}
                              >
                                {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              </button>
                            </td>

                            {/* 2. Transfer Code */}
                            <td className="p-2.5">
                              <div className={`font-mono font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5`}>
                                <span>{sh.trackingCode}</span>
                                {isSenderBranch && (
                                  <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30`}>
                                    OUTBOUND
                                  </span>
                                )}
                                {isRecipientBranch && (
                                  <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/30`}>
                                    INBOUND
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* 3. Route */}
                            <td className="p-2.5">
                              <div className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                                <span>{sh.sourceBranchName || sh.sourceBranchId}</span>
                                <ArrowRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                                <span>{sh.destinationBranchName || sh.destinationBranchId}</span>
                              </div>
                            </td>

                            {/* 4. Dispatch Date */}
                            <td className="p-2.5 whitespace-nowrap">
                              <div className="font-mono text-slate-700 dark:text-slate-300 font-medium">
                                {sh.dispatchDateAD || 'N/A'}
                              </div>
                              {sh.dispatchDateBS && <div className="text-[10px] text-slate-400 font-mono">{sh.dispatchDateBS}</div>}
                            </td>

                            {/* 5. Items & Qty */}
                            <td className="p-2.5 text-center whitespace-nowrap">
                              <span className={`font-bold text-sky-600 dark:text-sky-400 font-mono`}>
                                {sh.items?.length || 0} SKUs ({totalQty} Pcs)
                              </span>
                            </td>

                            {/* 6. Valuation */}
                            <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white whitespace-nowrap">
                              {formatNPR(totalValue)}
                            </td>

                            {/* 7. Status */}
                            <td className="p-2.5 text-center whitespace-nowrap">
                              {pendingCancelReq ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border-amber-300 flex items-center justify-center gap-1 animate-pulse">
                                  <Clock className="h-3 w-3 animate-spin" />
                                  <span>CANCEL PENDING ({pendingCancelReq.requestNumber})</span>
                                </span>
                              ) : isCancelled ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-rose-100 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 flex items-center justify-center gap-1">
                                  <XCircle className="h-3 w-3" />
                                  <span>CANCELLED</span>
                                </span>
                              ) : isReceived ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 flex items-center justify-center gap-1">
                                  <CheckCircle2 className="h-3 w-3" />
                                  <span>STOCK RECEIVED</span>
                                </span>
                              ) : (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border bg-sky-50 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border-sky-300 flex items-center justify-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  <span>IN TRANSIT</span>
                                </span>
                              )}
                            </td>

                            {/* 8. Actions */}
                            <td className="p-2.5 text-right whitespace-nowrap">
                              {pendingCancelReq ? (
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    onClick={() => setCancelPendingRequestModal({ req: pendingCancelReq, shipment: sh })}
                                    className="flex items-center gap-1 px-3 py-1 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white shadow-xs cursor-pointer transition-all"
                                    title={`Manage pending cancellation request #${pendingCancelReq.requestNumber}`}
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                    <span>Manage Request</span>
                                  </button>
                                </div>
                              ) : isCancelled ? (
                                <span className="text-[11px] text-slate-400 italic">Restocked to Source</span>
                              ) : isReceived ? (
                                <span className={`text-[11px] font-semibold text-emerald-600 dark:text-emerald-400`}>Completed</span>
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  {canShowReceiveBtn && onReceiveShipment && (
                                    <button
                                      onClick={() => openReceiveModal(sh)}
                                      title="Verify physical quantities & hardware serial/MAC checklist before adding to branch stock"
                                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm cursor-pointer transition-all"
                                    >
                                      <PackageCheck className="h-3.5 w-3.5" />
                                      <span>Verify & Receive Stock</span>
                                    </button>
                                  )}

                                  {canShowCancelBtn && canDirectCancelTransfer && (
                                      <button
                                        onClick={() => {
                                          setDirectCancelModalShipment(sh);
                                          setDirectCancelReason('');
                                        }}
                                        title="Cancel in-transit transfer and refund stock back to source branch"
                                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-xs cursor-pointer transition-all"
                                      >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                        <span>Cancel Transfer</span>
                                      </button>
                                    )}

                                    {canShowCancelBtn && !canDirectCancelTransfer && canRequestCancelTransfer && (
                                      <button
                                        onClick={() => {
                                          setRequestCancelModalShipment(sh);
                                          setRequestCancelReason('');
                                        }}
                                        title="Submit request to Workflow Approval Center to cancel this in-transit transfer"
                                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-xs cursor-pointer transition-all"
                                      >
                                        <ShieldAlert className="h-3.5 w-3.5" />
                                        <span>Cancel Request</span>
                                      </button>
                                    )}

                                    {canShowCancelBtn && !canDirectCancelTransfer && !canRequestCancelTransfer && (
                                      <span className="text-[11px] text-slate-400 italic">In Transit</span>
                                    )}

                                  {!canShowReceiveBtn && !canShowCancelBtn && (
                                    <span className="text-[11px] text-slate-400 italic">In Transit (Pending Recipient)</span>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>

                          {/* EXPANDED ROW DETAIL PANEL */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={8} className="p-0 border-b border-indigo-500/20">
                                <div className={`p-4 space-y-3 bg-slate-50/90 border-t border-slate-200 dark:bg-slate-900/90 dark:border-t dark:border-slate-800`}>
                                  {/* Metadata Header Bar */}
                                  <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-xl border text-xs bg-white border-slate-200 text-slate-800 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-200`}>
                                    <div>
                                      <span className="text-slate-400 font-medium block text-[10px] uppercase">Dispatcher Officer</span>
                                      <span className="font-bold text-slate-800 dark:text-slate-200">Branch Stock Officer</span>
                                    </div>
                                    <div>
                                      <span className="text-slate-400 font-medium block text-[10px] uppercase">Transit Carrier & Waybill</span>
                                      <span className="font-bold text-slate-800 dark:text-slate-200">Internal Branch Transit</span>
                                    </div>
                                    <div>
                                      <span className="text-slate-400 font-medium block text-[10px] uppercase">Dispatch Notes</span>
                                      <span className="italic text-slate-600 dark:text-slate-400">{sh.notes || 'No dispatch notes recorded.'}</span>
                                    </div>
                                  </div>

                                  {/* Itemized Table */}
                                  <div className={`overflow-hidden rounded-xl border text-xs border-slate-200 bg-white text-slate-800 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200`}>
                                    <table className="w-full text-left border-collapse">
                                      <thead className={`text-[10px] font-bold tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-800`}>
                                        <tr>
                                          <th className="px-2.5 py-1.5">Product & SKU</th>
                                          <th className="px-2.5 py-1.5 text-center">Qty Sent</th>
                                          <th className="px-2.5 py-1.5 text-right">Unit Cost (NPR)</th>
                                          <th className="px-2.5 py-1.5 text-right">Subtotal Value (NPR)</th>
                                          <th className="px-2.5 py-1.5">Device Serials & MAC Tracking</th>
                                        </tr>
                                      </thead>
                                      <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                                        {sh.items?.map((item, idx) => {
                                          const prod = products.find((p) => p.id === item.productId || p.sku === item.sku);
                                          const qty = item.quantitySent || 1;
                                          const cost = item.costPrice || prod?.costPrice || 0;
                                          const isSerialized = Boolean(
                                            item.deviceSerials?.length || 
                                            prod?.requiresSerialTracking || 
                                            prod?.trackingType === 'SERIAL_MAC_PON'
                                          );

                                          return (
                                            <tr key={item.id || idx}>
                                              <td className="p-2.5">
                                                <div className="font-bold text-slate-900 dark:text-white">{item.productName}</div>
                                                <div className="text-[10px] font-mono text-slate-400">SKU: {item.sku || prod?.sku || 'N/A'}</div>
                                              </td>
                                              <td className={`p-2.5 text-center font-mono font-bold text-sky-600 dark:text-sky-400`}>
                                                {qty} {prod?.unit || 'pcs'}
                                              </td>
                                              <td className="p-2.5 text-right font-mono text-slate-700 dark:text-slate-300">
                                                {formatNPR(cost)}
                                              </td>
                                              <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                                                {formatNPR(qty * cost)}
                                              </td>
                                              <td className="p-2.5">
                                                {isSerialized ? (
                                                  <div className="space-y-1">
                                                    <div className={`flex items-center gap-1.5 text-[10px] font-bold text-amber-600 dark:text-amber-400`}>
                                                      <Tag className="h-3 w-3" />
                                                      <span>Serial Tracked ({item.deviceSerials?.length || qty} Units)</span>
                                                    </div>
                                                    {item.deviceSerials && item.deviceSerials.length > 0 ? (
                                                      <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                                                        {item.deviceSerials.map((ser, sIdx) => (
                                                          <div key={sIdx} className={`p-1.5 rounded-lg border font-mono text-[10px] space-y-0.5 bg-slate-50 border-slate-200 dark:bg-slate-800 dark:border-slate-700`}>
                                                            <div className="text-slate-800 dark:text-slate-200 font-bold flex items-center justify-between">
                                                              <span>SN: {ser.deviceSerial}</span>
                                                              <span className="text-[9px] px-1 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-extrabold">VERIFIED</span>
                                                            </div>
                                                            {ser.ponSerial && <div className="text-slate-500 dark:text-slate-400 text-[9.5px]">PON: {ser.ponSerial}</div>}
                                                          </div>
                                                        ))}
                                                      </div>
                                                    ) : (
                                                      <div className="text-[10px] font-mono text-slate-500 bg-amber-50 dark:bg-amber-950/40 p-1.5 rounded border border-amber-200 dark:border-amber-800">
                                                        Auto Serial Generation on Physical Verification
                                                      </div>
                                                    )}
                                                  </div>
                                                ) : (
                                                  <span className="text-slate-400 text-[10px] italic">Non-serialized bulk material</span>
                                                )}
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
