import React, { useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  ApprovalRequest,
  Shipment,
} from '../../../types';
import { api } from '../../../services/api';
import { formatNPR } from '../../../utils/nprFormat';
import { isOperationAllowed } from '../../../utils/permissions';
import {
  AlertCircle,
  AlertTriangle,
  Barcode,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Send,
  Tag,
  Inbox,
  ArrowRight,
  ShieldAlert,
  PackageCheck,
  RotateCcw,
  Clock,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

/**
 * ReceiveTransferPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const ReceiveTransferPanel: React.FC = () => {
  const { activeTab, allowedBranches, approvalRequests, branchFilter, branches, canSeeAll, currentUser, ensureBsDateAvailable, onCancelApproval, onCancelReceiveShipment, onRequestApproval, onReceiveShipment, products, selectedBranchId, setBranchFilter, shipments, showToast } = useStockOperationsCtx();

  const [expandedShipmentId, setExpandedShipmentId] = useState<string | null>(null);

  const [transferStatusFilter, setTransferStatusFilter] = useState<'ALL' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCEL_PENDING' | 'CANCELLED'>('ALL');

  const [receivingShipmentModal, setReceivingShipmentModal] = useState<Shipment | null>(null);
  const [receiveItemStates, setReceiveItemStates] = useState<{
    [itemId: string]: {
      quantityReceived: number;
      verifiedSerials: { deviceSerial: string; ponSerial?: string; isChecked: boolean }[];
      notes: string;
    };
  }>({});
  const [receivingByNotes, setReceivingByNotes] = useState<string>('');

  const openReceiveModal = (sh: Shipment) => {
    setReceivingShipmentModal(sh);
    setReceivingByNotes('');
    const initialStates: any = {};
    sh.items?.forEach((item) => {
      initialStates[item.id] = {
        quantityReceived: item.quantityReceived !== undefined ? item.quantityReceived : (item.quantitySent || (item as any).quantity || 1),
        verifiedSerials: (item.deviceSerials || []).map((s) => ({
          deviceSerial: s.deviceSerial,
          ponSerial: s.ponSerial || '',
          isChecked: true,
        })),
        notes: item.itemDiscrepancyNotes || '',
      };
    });
    setReceiveItemStates(initialStates);
  };

  const updateReceiveQty = (itemId: string, qty: number) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId] || { quantityReceived: 1, verifiedSerials: [], notes: '' };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          quantityReceived: Math.max(0, qty),
        },
      };
    });
  };

  const toggleSerialCheck = (itemId: string, sIdx: number) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId];
      if (!curr) return prev;
      const updatedSerials = [...curr.verifiedSerials];
      updatedSerials[sIdx] = {
        ...updatedSerials[sIdx],
        isChecked: !updatedSerials[sIdx].isChecked,
      };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          verifiedSerials: updatedSerials,
        },
      };
    });
  };

  const updateItemDiscrepancyNotes = (itemId: string, notes: string) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId] || { quantityReceived: 1, verifiedSerials: [], notes: '' };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          notes,
        },
      };
    });
  };

  const handleConfirmReceiveVerification = async () => {
    if (!ensureBsDateAvailable()) return;
    if (!receivingShipmentModal || !onReceiveShipment) return;

    const payloadItems = receivingShipmentModal.items.map((item) => {
      const st = receiveItemStates[item.id];
      const qty = st ? Number(st.quantityReceived) : (item.quantitySent || (item as any).quantity || 1);
      const receivedSerials = st
        ? st.verifiedSerials.filter((s) => s.isChecked).map((s) => ({ deviceSerial: s.deviceSerial, ponSerial: s.ponSerial }))
        : item.deviceSerials || [];

      return {
        itemId: item.id,
        quantityReceived: qty,
        receivedSerials,
        itemDiscrepancyNotes: st?.notes || '',
      };
    });

    await onReceiveShipment(receivingShipmentModal.id, {
      receivedItems: payloadItems,
      receivedByNotes: receivingByNotes,
    });

    setReceivingShipmentModal(null);
  };


  // 8. Cancel Received Transfer States (Direct Super Admin / Inventory Manager & Workflow Requests)
  const [directCancelModalShipment, setDirectCancelModalShipment] = useState<Shipment | null>(null);
  const [directCancelReason, setDirectCancelReason] = useState<string>('');
  const [requestCancelModalShipment, setRequestCancelModalShipment] = useState<Shipment | null>(null);
  const [requestCancelReason, setRequestCancelReason] = useState<string>('');
  const [cancelPendingRequestModal, setCancelPendingRequestModal] = useState<{
    req: ApprovalRequest;
    shipment: Shipment;
  } | null>(null);
  const [isProcessingCancel, setIsProcessingCancel] = useState<boolean>(false);

  // Execute direct cancellation (Super Admin & Inventory Manager)
  const handleDirectCancelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!directCancelModalShipment) return;

    setIsProcessingCancel(true);
    try {
      if (onCancelReceiveShipment) {
        await onCancelReceiveShipment(
          directCancelModalShipment.id,
          directCancelReason.trim() || undefined
        );
      } else {
        await api.cancelShipment(
          directCancelModalShipment.id,
          currentUser,
          directCancelReason.trim() || undefined
        );
      }

      showToast(
        `In-Transit Transfer ${directCancelModalShipment.trackingCode} cancelled successfully. Sent items have been refunded to ${directCancelModalShipment.sourceBranchName || 'Source Branch'} stock.`
      );
      setDirectCancelModalShipment(null);
      setDirectCancelReason('');
    } catch (err: any) {
      showToast(`Cancellation failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

  // Submit approval request for cancellation (Other Roles: Branch Manager, Front Desk, etc.)
  const handleRequestCancelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!requestCancelModalShipment) return;
    if (!requestCancelReason.trim()) {
      showToast('Please provide a reason for requesting cancellation.');
      return;
    }

    setIsProcessingCancel(true);
    try {
      const itemsSummary = requestCancelModalShipment.items
        ?.map((it) => `${it.quantitySent}x ${it.productName}`)
        .join(', ') || 'Transfer Items';

      const totalQty = requestCancelModalShipment.items?.reduce(
        (sum, it) => sum + (it.quantitySent || 1),
        0
      ) || 0;

      const requestPayload = {
        type: 'CANCEL_TRANSFER',
        targetId: requestCancelModalShipment.id,
        customerName: requestCancelModalShipment.trackingCode,
        customerCode: 'TRANSFER_IN_TRANSIT',
        deviceSerial: requestCancelModalShipment.trackingCode,
        productName: itemsSummary,
        currentStatus: requestCancelModalShipment.status,
        requestedStatus: 'CANCELLED',
        requestedByRole: currentUser?.role || 'BRANCH_MANAGER',
        requestedByEmail: currentUser?.email || 'user@system.com.np',
        requestedByName: currentUser?.name || 'Staff User',
        branchId: requestCancelModalShipment.sourceBranchId || requestCancelModalShipment.destinationBranchId,
        branchName: requestCancelModalShipment.sourceBranchName || requestCancelModalShipment.destinationBranchName,
        reason: requestCancelReason.trim(),
        shipmentData: {
          shipmentId: requestCancelModalShipment.id,
          trackingCode: requestCancelModalShipment.trackingCode,
          sourceBranchName: requestCancelModalShipment.sourceBranchName,
          destinationBranchName: requestCancelModalShipment.destinationBranchName,
          itemSummary: itemsSummary,
          totalQuantity: totalQty,
        },
      };

      if (onRequestApproval) {
        await onRequestApproval(requestPayload);
      } else {
        await api.createApprovalRequest(requestPayload);
      }

      showToast(
        `Cancellation request for In-Transit transfer ${requestCancelModalShipment.trackingCode} submitted to Workflow Approval Center. Authorized approval required.`
      );
      setRequestCancelModalShipment(null);
      setRequestCancelReason('');
    } catch (err: any) {
      showToast(`Failed to submit request: ${err.message || 'Unknown error'}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

  // Withdraw / Cancel pending approval request
  const handleConfirmWithdrawRequest = async () => {
    if (!cancelPendingRequestModal) return;

    setIsProcessingCancel(true);
    try {
      if (onCancelApproval) {
        await onCancelApproval(cancelPendingRequestModal.req.id);
      } else {
        await api.cancelApprovalRequest(cancelPendingRequestModal.req.id);
      }

      showToast(
        `Approval request #${cancelPendingRequestModal.req.requestNumber} for ${cancelPendingRequestModal.shipment.trackingCode} has been cancelled.`
      );
      setCancelPendingRequestModal(null);
    } catch (err: any) {
      showToast(`Failed to cancel request: ${err.message || 'Unknown error'}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

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
      {/* Inbound Physical Stock Verification & Security Audit Modal */}
      {receivingShipmentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-4xl rounded-2xl shadow-2xl border overflow-hidden my-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
            <div className={`p-4 border-b flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60`}>
              <div className="flex items-center gap-2">
                <PackageCheck className={`h-5 w-5 text-emerald-500 dark:text-emerald-400`} />
                <div>
                  <h3 className="font-bold text-sm">
                    Inbound Stock Physical Verification — {receivingShipmentModal.trackingCode}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Verify physical incoming quantities & device serial/MAC numbers before updating destination branch inventory.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReceivingShipmentModal(null)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Route Summary Card */}
              <div className={`flex justify-between items-center p-3.5 rounded-xl border text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Dispatched From</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.sourceBranchName || 'Central Warehouse'}</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-mono text-[10px] text-indigo-500 font-bold">{receivingShipmentModal.dispatchDateAD}</span>
                  <ArrowRight className="h-4 w-4 text-indigo-500 my-0.5" />
                  <span className={`text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase`}>Receiving Inspection</span>
                </div>
                <div className="text-right">
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Destination Branch</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.destinationBranchName}</span>
                </div>
              </div>

              {/* Security Advisory */}
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                <AlertCircle className={`h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5`} />
                <div>
                  <span className="font-bold block">Security Audit Requirement:</span>
                  <span>
                    Receiver branch must count non-serial quantities and physically scan/verify each Device Serial & PON/MAC address unpacked from shipments. Any shortage or unverified unit will be logged as an <strong>In-Transit Discrepancy</strong> for management audit.
                  </span>
                </div>
              </div>

              {/* Item Lines Verification Table */}
              <div className="space-y-3">
                {receivingShipmentModal.items.map((item, idx) => {
                  const st = receiveItemStates[item.id] || {
                    quantityReceived: item.quantitySent || (item as any).quantity || 1,
                    verifiedSerials: [],
                    notes: '',
                  };
                  const sentQty = item.quantitySent || (item as any).quantity || 1;
                  const diff = st.quantityReceived - sentQty;
                  const hasSerials = item.deviceSerials && item.deviceSerials.length > 0;

                  return (
                    <div
                      key={item.id || idx}
                      className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-3 text-xs"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
                        <div>
                          <div className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                            <span>{idx + 1}. {item.productName}</span>
                            <span className="font-mono text-xs font-semibold text-slate-500">[{item.sku}]</span>
                          </div>
                          <span className="text-[11px] text-slate-500">
                            Dispatched Quantity: <strong className="text-slate-700 dark:text-slate-300 font-mono">{sentQty} Units</strong>
                          </span>
                        </div>

                        {/* Received Qty Entry */}
                        <div className="flex items-center gap-3">
                          <label className="font-bold text-slate-700 dark:text-slate-300">
                            Actual Received Qty:
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={sentQty * 2}
                            value={st.quantityReceived}
                            onChange={(e) => updateReceiveQty(item.id, Number(e.target.value))}
                            className={`w-20 text-center font-mono font-bold text-sm rounded-lg border p-1.5 focus:ring-2 focus:ring-indigo-500 border-indigo-300 bg-white text-slate-800 dark:border-indigo-700 dark:bg-slate-800 dark:text-slate-100`}
                          />

                          {diff === 0 ? (
                            <span className={`px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold text-[10px] border border-emerald-500/20`}>
                              ✓ Full Match
                            </span>
                          ) : diff < 0 ? (
                            <span className={`px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold text-[10px] border border-amber-500/20`}>
                              ⚠ Shortage ({diff} Units)
                            </span>
                          ) : (
                            <span className={`px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold text-[10px] border border-blue-500/20`}>
                              ℹ Surplus (+{diff} Units)
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Serial Check-Off List for Hardware */}
                      {hasSerials && (
                        <div className="p-3 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/40 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5 text-[11px]">
                              <Barcode className={`h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400`} />
                              <span>Device Serial & MAC/PON Check-Off Checklist ({st.verifiedSerials.filter(s => s.isChecked).length} / {item.deviceSerials?.length} Checked):</span>
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {st.verifiedSerials.map((s, sIdx) => (
                              <label
                                key={sIdx}
                                className={`p-2 rounded-lg border flex items-center gap-2 cursor-pointer transition-colors ${s.isChecked ? 'bg-white border-emerald-300 dark:bg-slate-800 dark:border-emerald-800' : 'bg-rose-50/60 border-rose-200 text-rose-700 dark:bg-rose-950/30 dark:border-rose-900 dark:text-rose-300'}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={s.isChecked}
                                  onChange={() => toggleSerialCheck(item.id, sIdx)}
                                  className={`rounded text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 h-4 w-4`}
                                />
                                <div className="flex-1 font-mono text-[11px] min-w-0">
                                  <div className="font-bold text-slate-900 dark:text-slate-100 truncate">
                                    {s.deviceSerial}
                                  </div>
                                  {s.ponSerial && (
                                    <div className={`text-[10px] text-blue-600 dark:text-blue-400 truncate`}>
                                      PON: {s.ponSerial}
                                    </div>
                                  )}
                                </div>
                                <span className={`text-[10px] font-bold uppercase ${s.isChecked ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                  {s.isChecked ? 'Verified' : 'Missing'}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Item Discrepancy Remarks */}
                      <div>
                        <input
                          type="text"
                          placeholder="Discrepancy / Damage notes for this item (if any)..."
                          value={st.notes}
                          onChange={(e) => updateItemDiscrepancyNotes(item.id, e.target.value)}
                          className={`w-full text-xs rounded-lg border px-3 py-1.5 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* General Receiving Officer Notes */}
              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  Receiving Inspection Officer Notes & Waybill Remarks
                </label>
                <input
                  type="text"
                  placeholder="e.g. Received by [name] at [branch]. Seal was intact, counted & checked."
                  value={receivingByNotes}
                  onChange={(e) => setReceivingByNotes(e.target.value)}
                  className={`w-full text-xs rounded-xl border px-3 py-1.5 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                />
              </div>
            </div>

            {/* Modal Actions Footer */}
            <div className={`p-4 border-t flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60`}>
              <button
                type="button"
                onClick={() => setReceivingShipmentModal(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleConfirmReceiveVerification}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-600/30 transition-all cursor-pointer"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>Confirm Physical Receiving & Add to Branch Stock</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. Direct Cancel In-Transit Transfer Modal (Super Admin / Inventory Manager Only) */}
      {directCancelModalShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden p-4 bg-white border-rose-200 text-slate-800 dark:bg-slate-900 dark:border-rose-900/60 dark:text-slate-200`}>
            <div className="flex items-center justify-between border-b border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 p-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-rose-100 dark:bg-rose-900/80 text-rose-700 dark:text-rose-300">
                  <RotateCcw className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-rose-900 dark:text-rose-200">
                    Cancel In-Transit Transfer Bin
                  </h3>
                  <span className="font-mono text-xs text-rose-700 dark:text-rose-400 font-bold">
                    #{directCancelModalShipment.trackingCode}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDirectCancelModalShipment(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleDirectCancelSubmit} className="p-5 space-y-4 text-xs">
              <div className="p-3.5 rounded-xl bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/40 space-y-2">
                <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                  <span>Transfer Route:</span>
                  <span>
                    {directCancelModalShipment.sourceBranchName || directCancelModalShipment.sourceBranchId} → {directCancelModalShipment.destinationBranchName || directCancelModalShipment.destinationBranchId}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
                  <span className="font-bold block">Transferred Items Refunded to Source Branch:</span>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {directCancelModalShipment.items?.map((it, idx) => (
                      <li key={idx}>
                        <strong>{it.quantitySent ?? 1} units</strong> of {it.productName}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-[11px] text-amber-900 dark:text-amber-300 space-y-1">
                <div className="flex items-center gap-1.5 font-bold">
                  <AlertTriangle className={`h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0`} />
                  <span>Action Effects & Inventory Restocking:</span>
                </div>
                <ul className="list-disc pl-5 space-y-0.5">
                  <li>Immediately restores all sent quantities back to <strong>{directCancelModalShipment.sourceBranchName || 'Source Branch'}</strong> on-hand stock.</li>
                  <li>Removes the incoming expected quantity from {directCancelModalShipment.destinationBranchName || 'Destination Branch'}.</li>
                  <li>Sets shipment status to <strong>CANCELLED</strong>.</li>
                  <li>Restores serialized device records back to in-stock status at source branch.</li>
                  <li>Logs an auditable reversal trail under your credentials ({currentUser?.name}).</li>
                </ul>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-600 dark:text-slate-300 mb-1">
                  Cancellation Reason (Optional)
                </label>
                <textarea
                  rows={2}
                  value={directCancelReason}
                  onChange={(e) => setDirectCancelReason(e.target.value)}
                  placeholder="e.g. Transfer cancelled by dispatch officer, wrong destination selected, duplicate dispatch bin..."
                  className={`w-full rounded-xl border p-2.5 text-xs focus:ring-2 focus:ring-rose-500 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={() => setDirectCancelModalShipment(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isProcessingCancel}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold text-xs shadow-lg shadow-rose-600/30 cursor-pointer disabled:opacity-50 transition-all"
                >
                  {isProcessingCancel ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Cancelling Transfer...</span>
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Confirm & Cancel Transfer</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 9. Request Cancel Transfer Modal (Workflow for Branch Managers & other staff) */}
      {requestCancelModalShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden p-4 bg-white border-amber-200 text-slate-800 dark:bg-slate-900 dark:border-amber-900/60 dark:text-slate-200`}>
            <div className="flex items-center justify-between border-b border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 p-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-amber-100 dark:bg-amber-900/80 text-amber-700 dark:text-amber-300">
                  <ShieldAlert className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm text-amber-900 dark:text-amber-200">
                    Request Cancel Transfer (In-Transit)
                  </h3>
                  <span className="font-mono text-xs text-amber-700 dark:text-amber-400 font-bold">
                    #{requestCancelModalShipment.trackingCode}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRequestCancelModalShipment(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleRequestCancelSubmit} className="p-5 space-y-4 text-xs">
              <div className={`p-3 rounded-xl border space-y-1.5 bg-slate-50 border-slate-200 dark:bg-slate-800/60 dark:border-slate-700/60`}>
                <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                  <span>Transfer Route:</span>
                  <span>
                    {requestCancelModalShipment.sourceBranchName || requestCancelModalShipment.sourceBranchId} → {requestCancelModalShipment.destinationBranchName || requestCancelModalShipment.destinationBranchId}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 dark:text-slate-300">
                  <span>Items: </span>
                  <strong>
                    {requestCancelModalShipment.items?.map((it) => `${it.quantitySent || 1}x ${it.productName}`).join(', ')}
                  </strong>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 text-[11px] text-amber-900 dark:text-amber-300">
                <span>
                  <strong>Workflow Approval Notice:</strong> Since you are logged in as{' '}
                  <span className="font-bold underline">{currentUser?.role || 'Staff'}</span>, submitting this will list an official transfer cancellation order in the <strong>Workflow Approval Center</strong>. Once an authorized person approves, the in-transit transfer will be cancelled and stock will be returned to the source branch.
                </span>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-700 dark:text-slate-300 mb-1">
                  Reason for Transfer Cancellation Request <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={requestCancelReason}
                  onChange={(e) => setRequestCancelReason(e.target.value)}
                  placeholder="Explain why this in-transit transfer needs to be cancelled (e.g. Customer cancelled order, wrong items scanned, dispatched by mistake)..."
                  className={`w-full rounded-xl border p-2.5 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={() => setRequestCancelModalShipment(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessingCancel}
                  className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white font-bold text-xs shadow-lg shadow-amber-600/30 cursor-pointer disabled:opacity-50 transition-all"
                >
                  {isProcessingCancel ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Submitting Request...</span>
                    </>
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      <span>Submit Cancellation Request</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 10. Withdraw / Cancel Pending Approval Request Modal */}
      {cancelPendingRequestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border p-6 space-y-4 bg-white border-amber-200 text-slate-800 dark:bg-slate-900 dark:border-amber-900/60 dark:text-slate-200`}>
            <div className={`flex items-center gap-2.5 text-amber-600 dark:text-amber-400 font-extrabold text-base`}>
              <XCircle className="h-6 w-6" />
              <span>Cancel Pending Approval Request</span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Are you sure you want to cancel and withdraw the pending cancellation request{' '}
              <strong>#{cancelPendingRequestModal.req.requestNumber}</strong> for transfer{' '}
              <strong>{cancelPendingRequestModal.shipment.trackingCode}</strong>?
            </p>

            <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-[11px] space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500">Submitted by:</span>
                <span className="font-bold">{cancelPendingRequestModal.req.requestedByName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Submitted Reason:</span>
                <span className="italic truncate max-w-[200px]">"{cancelPendingRequestModal.req.reason}"</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                disabled={isProcessingCancel}
                onClick={() => setCancelPendingRequestModal(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                Keep Request
              </button>
              <button
                type="button"
                disabled={isProcessingCancel}
                onClick={handleConfirmWithdrawRequest}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold text-xs shadow-md cursor-pointer disabled:opacity-50 transition-all"
              >
                {isProcessingCancel ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Cancelling...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Confirm Cancel Request</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}


    </>
  );
};
