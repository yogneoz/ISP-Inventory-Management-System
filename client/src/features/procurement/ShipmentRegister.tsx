import React, { useState } from 'react';
import { Shipment, Branch, User, ApprovalRequest } from '../../types';
import { formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { FilterCard } from '../../components/common/FilterCard';
import { exportToCSV } from '../../utils/exportUtils';
import { isOperationAllowed } from '../../utils/permissions';
import { api } from '../../services/api';
import {
  Eye,
  CheckCircle2,
  X,
  ArrowRight,
  AlertCircle,
  RotateCcw,
  ShieldAlert,
  Clock,
  XCircle,
  Info,
  Barcode,
  PackageCheck,
  FileSpreadsheet,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface ShipmentRegisterProps {
  currentUser?: User | null;
  /** Branch the user belongs to (null = global/ALL) — export scope. */
  userBranchId: string | null;
  branches: Branch[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  approvalRequests?: ApprovalRequest[];
  /** Rows already filtered by the host (it owns the filter primitives so the header search and the tab badge can share them). */
  filteredShipments: Shipment[];
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  startDateAD: string;
  setStartDateAD: React.Dispatch<React.SetStateAction<string>>;
  endDateAD: string;
  setEndDateAD: React.Dispatch<React.SetStateAction<string>>;
  shipmentStatusFilter: string;
  setShipmentStatusFilter: React.Dispatch<React.SetStateAction<string>>;
  shipmentMode: 'ALL' | 'CREATED' | 'RECEIVED';
  setShipmentMode: React.Dispatch<React.SetStateAction<'ALL' | 'CREATED' | 'RECEIVED'>>;
  /** Clear every filter (FilterCard's Clear button). */
  onClearFilters: () => void;
  /** Open the manifest viewer — the host owns it and flips the VIEW sub-tab. */
  onViewShipment: (sh: Shipment) => void;
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
  /** Floating toast sink (the host renders the toast). */
  onShowToast: (msg: string) => void;
}

/**
 * Register sub-component (Shipments decomposition, 2026-10-09): metrics,
 * report filters, the transfer table with pagination/CSV export, and the
 * receive + cancel-receive modal flows (including their api.* fallbacks
 * when the host passes no App callback).
 */
export const ShipmentRegister: React.FC<ShipmentRegisterProps> = ({
  currentUser,
  userBranchId,
  branches,
  selectedBranchId,
  dateMode,
  approvalRequests = [],
  filteredShipments,
  searchQuery,
  setSearchQuery,
  startDateAD,
  setStartDateAD,
  endDateAD,
  setEndDateAD,
  shipmentStatusFilter,
  setShipmentStatusFilter,
  shipmentMode,
  setShipmentMode,
  onClearFilters,
  onViewShipment,
  onReceiveShipment,
  onCancelReceiveShipment,
  onRequestApproval,
  onCancelApproval,
  onShowToast: showToast,
}) => {
  const { isDarkMode } = useDarkMode();

  // Receiving Verification Modal State
  const [receivingShipmentModal, setReceivingShipmentModal] = useState<Shipment | null>(null);
  const [receiveItemStates, setReceiveItemStates] = useState<{
    [itemId: string]: {
      quantityReceived: number;
      verifiedSerials: { deviceSerial: string; ponSerial?: string; isChecked: boolean }[];
      notes: string;
    };
  }>({});
  const [receivingByNotes, setReceivingByNotes] = useState<string>('');

  // Cancel Received Transfer States (Direct Super Admin / Inventory Manager & Workflow Requests)
  const [directCancelModalShipment, setDirectCancelModalShipment] = useState<Shipment | null>(null);
  const [directCancelReason, setDirectCancelReason] = useState<string>('');
  const [requestCancelModalShipment, setRequestCancelModalShipment] = useState<Shipment | null>(null);
  const [requestCancelReason, setRequestCancelReason] = useState<string>('');
  const [cancelPendingRequestModal, setCancelPendingRequestModal] = useState<{
    req: ApprovalRequest;
    shipment: Shipment;
  } | null>(null);
  const [isProcessingCancel, setIsProcessingCancel] = useState<boolean>(false);

  const canDirectCancelTransfer =
    isOperationAllowed('branch-transfer-cancel-receive', currentUser?.role);
  const canRequestCancelTransfer =
    isOperationAllowed('branch-transfer-request-cancel', currentUser?.role);

  // Execute direct cancellation (Super Admin & Inventory Manager)
  const handleDirectCancelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!directCancelModalShipment) return;

    setIsProcessingCancel(true);
    try {
      if (onCancelReceiveShipment) {
        await onCancelReceiveShipment(
          directCancelModalShipment.id,
          directCancelReason.trim() || undefined
        );
      } else {
        await api.cancelReceiveShipment(
          directCancelModalShipment.id,
          currentUser,
          directCancelReason.trim() || undefined
        );
      }
      showToast(
        `Transfer ${directCancelModalShipment.trackingCode} receipt cancelled successfully. Inventory and serials restored to In-Transit status.`
      );
      setDirectCancelModalShipment(null);
      setDirectCancelReason('');
    } catch (err: any) {
      showToast(`Cancellation failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

  // Submit cancel request for Super Admin approval (Branch Managers / Frontdesk)
  const handleRequestCancelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestCancelModalShipment) return;
    if (!requestCancelReason.trim()) {
      showToast('Please provide a justification reason for requesting transfer receipt cancellation.');
      return;
    }

    setIsProcessingCancel(true);
    try {
      const itemsSummary = requestCancelModalShipment.items
        .map((i) => `${i.productName} (${i.quantityReceived || i.quantitySent || (i as any).quantity || 1} pcs)`)
        .join(', ');

      const totalQty = requestCancelModalShipment.items.reduce(
        (sum, i) => sum + (i.quantityReceived || i.quantitySent || (i as any).quantity || 1),
        0
      );

      const requestPayload: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'> = {
        type: 'CANCEL_RECEIVE_TRANSFER',
        targetId: requestCancelModalShipment.id,
        customerName: requestCancelModalShipment.trackingCode,
        customerCode: `TRF-${requestCancelModalShipment.destinationBranchId || 'BRANCH'}`,
        deviceSerial: requestCancelModalShipment.trackingCode,
        productName: itemsSummary || 'Inter-Branch Transferred Stock',
        currentStatus: 'RECEIVED',
        requestedStatus: 'IN_TRANSIT',
        requestedByRole: currentUser?.role || 'BRANCH_MANAGER',
        requestedByEmail: currentUser?.email || 'user@example.com',
        requestedByName: currentUser?.name || 'Authorized Staff',
        branchId: requestCancelModalShipment.destinationBranchId,
        branchName: requestCancelModalShipment.destinationBranchName || requestCancelModalShipment.destinationBranchId,
        reason: requestCancelReason.trim(),
        shipmentData: {
          shipmentId: requestCancelModalShipment.id,
          trackingCode: requestCancelModalShipment.trackingCode,
          sourceBranchName: requestCancelModalShipment.sourceBranchName || requestCancelModalShipment.sourceBranchId,
          destinationBranchName: requestCancelModalShipment.destinationBranchName || requestCancelModalShipment.destinationBranchId,
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
        `Cancellation approval request submitted successfully for Transfer ${requestCancelModalShipment.trackingCode}. Routed to Workflow Approval Center.`
      );
      setRequestCancelModalShipment(null);
      setRequestCancelReason('');
    } catch (err: any) {
      showToast(`Failed to submit request: ${err.message || 'Unknown error'}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

  // Cancel / Withdraw a pending request
  const handleWithdrawCancelRequest = async () => {
    if (!cancelPendingRequestModal) return;

    setIsProcessingCancel(true);
    try {
      if (onCancelApproval) {
        await onCancelApproval(cancelPendingRequestModal.req.id);
      } else {
        await api.cancelApprovalRequest(
          cancelPendingRequestModal.req.id,
          currentUser
        );
      }
      showToast(`Request #${cancelPendingRequestModal.req.requestNumber} cancelled & withdrawn.`);
      setCancelPendingRequestModal(null);
    } catch (err: any) {
      showToast(`Failed to cancel request: ${err.message}`);
    } finally {
      setIsProcessingCancel(false);
    }
  };

  const openReceiveModal = (sh: Shipment) => {
    setReceivingShipmentModal(sh);
    setReceivingByNotes('');
    const initialStates: any = {};
    sh.items.forEach((item) => {
      initialStates[item.id] = {
        quantityReceived: item.quantityReceived !== undefined ? item.quantityReceived : item.quantitySent,
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
    if (!receivingShipmentModal) return;

    const payloadItems = receivingShipmentModal.items.map((item) => {
      const st = receiveItemStates[item.id];
      const qty = st ? Number(st.quantityReceived) : item.quantitySent;
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

  const shipmentPagination = useClientPagination(filteredShipments, 15, [
    searchQuery,
    selectedBranchId,
    shipmentMode,
    shipmentStatusFilter,
    startDateAD,
    endDateAD,
  ]);

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

    const effectiveBranchId = userBranchId || selectedBranchId;
    const branchName =
      effectiveBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === effectiveBranchId)?.name || `Branch ${effectiveBranchId}`;

    exportToCSV({
      filename: 'Shipments_Transfer_History',
      reportTitle: 'Multi-Branch Transfer & Logistics Shipment Report',
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredShipments,
      columns,
    });
  };

  return (
    <div className="space-y-3">
      {/* Shipment Metrics */}
      <div className="flex-none grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className={`rounded-2xl p-4 border shadow-sm ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <span className={`text-xs font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Total Transfers Recorded</span>
          <div className={`text-xl font-mono font-bold mt-1 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
            {filteredShipments.length} Shipments
          </div>
        </div>
        <div className="rounded-2xl p-4 border border-amber-500/30 bg-amber-500/5 shadow-sm">
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">Stock In-Transit</span>
          <div className="text-xl font-mono font-extrabold text-amber-600 dark:text-amber-400 mt-1">
            {filteredShipments.filter((s) => s.status === 'IN_TRANSIT' || s.status === 'DISPATCHED').length} Active
          </div>
        </div>
        <div className="rounded-2xl p-4 border border-emerald-500/30 bg-emerald-500/5 shadow-sm">
          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Received Stock Transfers</span>
          <div className="text-xl font-mono font-extrabold text-emerald-600 dark:text-emerald-400 mt-1">
            {filteredShipments.filter((s) => s.status === 'RECEIVED').length} Received
          </div>
        </div>
        <div className="rounded-2xl p-4 border border-indigo-500/30 bg-indigo-500/5 shadow-sm">
          <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">Total In-Transit Quantity</span>
          <div className="text-xl font-mono font-extrabold text-indigo-600 dark:text-indigo-400 mt-1">
            {filteredShipments
              .filter((s) => s.status !== 'RECEIVED')
              .reduce((acc, s) => acc + s.items.reduce((iAcc, item) => iAcc + item.quantitySent, 0), 0)}{' '}
            Units
          </div>
        </div>
      </div>

      {/* Report Filters & Export Toolbar — shared inline filter card */}
      <FilterCard
        searchPlaceholder="Search Tracking Code..."
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={
          Boolean(searchQuery) || shipmentStatusFilter !== 'ALL' || shipmentMode !== 'ALL' || Boolean(startDateAD) || Boolean(endDateAD)
        }
        onClearAll={onClearFilters}
        filterChildren={
          <>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Dispatch From</label>
              <div className="w-40">
                <DateField
                  mode={dateMode}
                  value={startDateAD}
                  onChange={setStartDateAD}
                  compact
                  showHint={false}
                  max={endDateAD || undefined}
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Dispatch To</label>
              <div className="w-40">
                <DateField
                  mode={dateMode}
                  value={endDateAD}
                  onChange={setEndDateAD}
                  compact
                  showHint={false}
                  min={startDateAD || undefined}
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Status</label>
              <select
                value={shipmentStatusFilter}
                onChange={(e) => setShipmentStatusFilter(e.target.value)}
                className={`rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none cursor-pointer w-40 ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
                }`}
              >
                <option value="ALL">All Statuses</option>
                <option value="DISPATCHED">Dispatched</option>
                <option value="IN_TRANSIT">In Transit</option>
                <option value="DELIVERED">Delivered</option>
                <option value="RECEIVED">Received</option>
                <option value="DISCREPANCY">Discrepancy</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Direction</label>
              <select
                value={shipmentMode}
                onChange={(e) => setShipmentMode(e.target.value as 'ALL' | 'CREATED' | 'RECEIVED')}
                className={`rounded-xl border px-3 py-2 text-xs font-medium focus:outline-none cursor-pointer w-40 ${
                  isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-white border-slate-300 text-slate-800'
                }`}
              >
                <option value="ALL">All Directions</option>
                <option value="CREATED">Outbound (Dispatched From)</option>
                <option value="RECEIVED">Inbound (Received At)</option>
              </select>
            </div>
          </>
        }
        rightChildren={
          <button
            type="button"
            onClick={exportShipmentsCSV}
            className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-bold text-white hover:bg-amber-500 shadow-md shadow-amber-900/20 transition-all cursor-pointer"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>Export History CSV ({filteredShipments.length})</span>
          </button>
        }
      />

      {/* Shipment Table */}
      <div className={`rounded-2xl border shadow-lg overflow-hidden ${
        isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className={`sticky top-0 z-20 font-bold text-[10px] tracking-wider border-b shadow-xs ${
              isDarkMode ? 'bg-[#12161f] text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
            }`}>
              <tr>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Tracking Code</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Shipment Type</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">From (Source)</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">To (Destination)</th>
                <th className="px-2.5 py-1.5 sticky top-0 bg-inherit">Dispatch Date</th>
                <th className="px-2.5 py-1.5 text-center">Transfer Items</th>
                <th className="px-2.5 py-1.5 text-center">Status</th>
                <th className="px-2.5 py-1.5 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredShipments.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500 text-xs">
                    No shipments or stock transfers recorded.
                  </td>
                </tr>
              ) : (
                shipmentPagination.pagedItems.map((sh) => {
                  const pendingCancelReq = approvalRequests?.find(
                    (r) =>
                      (r.type === 'CANCEL_RECEIVE_TRANSFER' ||
                        r.type === 'CANCEL_IN_TRANSIT_TRANSFER' ||
                        r.type === 'CANCEL_TRANSFER') &&
                      (r.targetId === sh.id || r.deviceSerial === sh.trackingCode || r.customerName === sh.trackingCode) &&
                      r.status === 'PENDING'
                  );

                  // Receiving is destination-side and lane-scoped, mirroring
                  // the server's post_receive gate: the warehouse lane
                  // (pullouts/inbound) needs wh-receive-pullouts, the branch
                  // lane needs branch-transfer-receive, and the destination
                  // must be a branch this account operates. Low-privilege
                  // roles therefore get a view-only row.
                  const destBranchObj = branches.find((b) => b.id === sh.destinationBranchId);
                  const destIsWarehouse =
                    sh.destinationBranchId === 'WH001' ||
                    Boolean(destBranchObj?.isHeadquarters || destBranchObj?.isWarehouse) ||
                    (destBranchObj?.code || '').toUpperCase().startsWith('WH') ||
                    /warehouse|head office/i.test(destBranchObj?.name || '');
                  const laneReceiveOp = destIsWarehouse ? 'wh-receive-pullouts' : 'branch-transfer-receive';
                  const canReceiveLane = isOperationAllowed(laneReceiveOp, currentUser?.role);
                  const receiverBranches = new Set<string>([
                    currentUser?.branchId || '',
                    ...(currentUser?.allowedBranchIds || []),
                  ]);
                  const destInScope =
                    !currentUser?.branchId ||
                    currentUser.branchId === 'ALL' ||
                    receiverBranches.has(sh.destinationBranchId);
                  const receiverActive = !['RECEIVED', 'DELIVERED', 'CANCELLED'].includes(sh.status);
                  const canShowReceiveButton = canReceiveLane && destInScope && receiverActive;

                  return (
                  <tr key={sh.id} className={`transition-colors ${
                    pendingCancelReq
                      ? isDarkMode
                        ? 'bg-amber-950/20 hover:bg-amber-950/30'
                        : 'bg-amber-50/40 hover:bg-amber-50/70'
                      : isDarkMode
                      ? 'hover:bg-slate-800/40'
                      : 'hover:bg-slate-50'
                  }`}>
                    <td className="p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                      {sh.trackingCode}
                    </td>
                    <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">
                      {sh.type === 'INTER_BRANCH' ? 'Inter-Branch Transfer' : 'Supplier Inbound'}
                    </td>
                    <td className="p-2.5 text-slate-600 dark:text-slate-300">
                      {sh.sourceBranchName || 'External Vendor'}
                    </td>
                    <td className="p-2.5 text-slate-900 dark:text-white font-bold">
                      {sh.destinationBranchName}
                    </td>
                    <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                      {formatDualDate(sh.dispatchDateAD, dateMode)}
                    </td>
                    <td className="p-2.5 text-center">
                      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-300 font-mono">
                        {sh.items.reduce((s, i) => s + (i.quantityReceived || i.quantitySent || (i as any).quantity || 1), 0)} Units ({sh.items.length} skus)
                      </span>
                    </td>
                    <td className="p-2.5 text-center">
                      {pendingCancelReq ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold rounded-md bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 animate-pulse whitespace-nowrap">
                          <Clock className="h-3 w-3 animate-spin" />
                          <span>CANCEL PENDING ({pendingCancelReq.requestNumber})</span>
                        </span>
                      ) : (
                        <span
                          className={`rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                            sh.status === 'RECEIVED'
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                              : sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED'
                              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                              : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                          }`}
                        >
                          {sh.status.replace('_', ' ')}
                        </span>
                      )}
                    </td>
                    <td className="p-2.5 text-center">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        <button
                          onClick={() => onViewShipment(sh)}
                          title="View Shipment Details"
                          className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>

                        {/* Receiving verification button — destination-side, lane- and scope-gated */}
                        {canShowReceiveButton && (
                          <button
                            onClick={() => openReceiveModal(sh)}
                            title="Acknowledge & Receive Inbound Stock"
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] shadow-xs cursor-pointer transition-all"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Receive Stock</span>
                          </button>
                        )}

                        {/* Cancellation Request / Action */}
                        {sh.status === 'RECEIVED' && !pendingCancelReq && (
                          canRequestCancelTransfer && !canDirectCancelTransfer ? (
                            <button
                              onClick={() => {
                                setRequestCancelModalShipment(sh);
                                setRequestCancelReason('');
                              }}
                              title="Request Super Admin approval to cancel received stock transfer"
                              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30 font-semibold text-[11px] cursor-pointer transition-all"
                            >
                              <RotateCcw className={`h-3.5 w-3.5 ${isDarkMode ? 'text-amber-400' : 'text-amber-500'}`} />
                              <span>Request Cancel</span>
                            </button>
                          ) : canDirectCancelTransfer ? (
                            <button
                              onClick={() => {
                                setDirectCancelModalShipment(sh);
                                setDirectCancelReason('');
                              }}
                              title="Cancel received stock transfer and revert to In-Transit"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold text-[11px] shadow-xs cursor-pointer transition-all"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Cancel Receive Transfer</span>
                            </button>
                          ) : null
                        )}
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
          page={shipmentPagination.page}
          pageCount={shipmentPagination.pageCount}
          totalItems={shipmentPagination.totalItems}
          rangeStart={shipmentPagination.rangeStart}
          rangeEnd={shipmentPagination.rangeEnd}
          pageSize={shipmentPagination.pageSize}
          onPageChange={shipmentPagination.setPage}
          onPageSizeChange={shipmentPagination.setPageSize}
          className="mt-1"
        />
      </div>

      {/* Inbound Physical Stock Verification & Security Audit Modal */}
      {receivingShipmentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-4xl rounded-2xl shadow-2xl border overflow-hidden my-6 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className={`p-4 border-b flex items-center justify-between ${
              isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'
            }`}>
              <div className="flex items-center gap-2">
                <PackageCheck className={`h-5 w-5 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-500'}`} />
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
              <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Dispatched From</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.sourceBranchName || 'Central Warehouse'}</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className={`font-mono text-[10px] font-bold ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`}>{receivingShipmentModal.dispatchDateAD}</span>
                  <ArrowRight className={`h-4 w-4 my-0.5 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`} />
                  <span className="text-[10px] text-emerald-600 font-bold uppercase">Receiving Inspection</span>
                </div>
                <div className="text-right">
                  <span className="text-slate-400 block text-[10px] uppercase font-bold">Destination Branch</span>
                  <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.destinationBranchName}</span>
                </div>
              </div>

              {/* Security Advisory */}
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
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
                    quantityReceived: item.quantitySent,
                    verifiedSerials: [],
                    notes: '',
                  };
                  const diff = st.quantityReceived - item.quantitySent;
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
                            Dispatched Quantity: <strong className="text-slate-700 dark:text-slate-300 font-mono">{item.quantitySent} Units</strong>
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
                            max={item.quantitySent * 2}
                            value={st.quantityReceived}
                            onChange={(e) => updateReceiveQty(item.id, Number(e.target.value))}
                            className="w-20 text-center font-mono font-bold text-sm rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-900 p-1.5 focus:ring-2 focus:ring-indigo-500"
                          />

                          {diff === 0 ? (
                            <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold text-[10px] border border-emerald-500/20">
                              ✓ Full Match
                            </span>
                          ) : diff < 0 ? (
                            <span className="px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold text-[10px] border border-amber-500/20">
                              ⚠ Shortage ({diff} Units)
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold text-[10px] border border-blue-500/20">
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
                              <Barcode className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                              <span>Device Serial & MAC/PON Check-Off Checklist ({st.verifiedSerials.filter(s => s.isChecked).length} / {item.deviceSerials?.length} Checked):</span>
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {st.verifiedSerials.map((s, sIdx) => (
                              <label
                                key={sIdx}
                                className={`p-2 rounded-lg border flex items-center gap-2 cursor-pointer transition-colors ${
                                  s.isChecked
                                    ? 'bg-white dark:bg-slate-900 border-emerald-300 dark:border-emerald-800'
                                    : 'bg-rose-50/60 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={s.isChecked}
                                  onChange={() => toggleSerialCheck(item.id, sIdx)}
                                  className="rounded text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                                />
                                <div className="flex-1 font-mono text-[11px] min-w-0">
                                  <div className="font-bold text-slate-900 dark:text-slate-100 truncate">
                                    {s.deviceSerial}
                                  </div>
                                  {s.ponSerial && (
                                    <div className="text-[10px] text-blue-600 dark:text-blue-400 truncate">
                                      PON: {s.ponSerial}
                                    </div>
                                  )}
                                </div>
                                <span className={`text-[10px] font-bold uppercase ${s.isChecked ? (isDarkMode ? 'text-emerald-400' : 'text-emerald-600') : (isDarkMode ? 'text-rose-400' : 'text-rose-500')}`}>
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
                          className="w-full text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 focus:outline-none"
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
                  className="w-full text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 focus:outline-none"
                />
              </div>
            </div>

            {/* Modal Actions Footer */}
            <div className={`p-4 border-t flex items-center justify-between ${
              isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'
            }`}>
              <button
                type="button"
                onClick={() => setReceivingShipmentModal(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
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

      {/* ------------------------------------------------------------- */}
      {/* 1. DIRECT CANCEL RECEIVE TRANSFER MODAL (Super Admin / Inventory Manager) */}
      {/* ------------------------------------------------------------- */}
      {directCancelModalShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-xl rounded-2xl shadow-2xl border overflow-hidden my-6 ${
            isDarkMode ? 'bg-[#0f1218] border-rose-900/50 text-slate-200' : 'bg-white border-rose-200 text-slate-800'
          }`}>
            {/* Header */}
            <div className="p-4 bg-rose-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-white/20">
                  <RotateCcw className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-base">Cancel Stock Transfer Receiving</h3>
                  <p className="text-xs text-rose-100 font-mono">
                    Transfer #{directCancelModalShipment.trackingCode}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDirectCancelModalShipment(null)}
                className="p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleDirectCancelSubmit} className="p-5 space-y-4">
              <div className={`p-3.5 rounded-xl border flex items-start gap-3 text-xs ${
                isDarkMode ? 'bg-rose-950/30 border-rose-800/50 text-rose-300' : 'bg-rose-50 border-rose-200 text-rose-800'
              }`}>
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-600" />
                <div className="space-y-1">
                  <div className="font-bold">Inventory Reversal Warning</div>
                  <p>
                    Cancelling this received transfer will deduct the received items from <span className="font-bold underline">{directCancelModalShipment.destinationBranchName || directCancelModalShipment.destinationBranchId}</span> and revert the shipment status back to <span className="font-bold uppercase text-amber-600 dark:text-amber-400">IN_TRANSIT</span>.
                  </p>
                </div>
              </div>

              {/* Items Summary Table */}
              <div className={`p-3 rounded-xl border space-y-2 ${isDarkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center justify-between">
                  <span>Stock Items to Revert</span>
                  <span className="font-mono text-indigo-600 dark:text-indigo-400">
                    {directCancelModalShipment.items.reduce((s, i) => s + (i.quantityReceived || i.quantitySent || (i as any).quantity || 1), 0)} Total Units
                  </span>
                </div>
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {directCancelModalShipment.items.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between text-xs py-1 border-b border-dashed border-slate-200 dark:border-slate-800 last:border-0">
                      <span className="font-semibold text-slate-900 dark:text-slate-100 truncate pr-2">
                        {item.productName || item.productId}
                      </span>
                      <span className="font-mono font-bold text-rose-600 shrink-0">
                        -{item.quantityReceived || item.quantitySent || (item as any).quantity || 1} units
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Reason Input */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Reason for Cancellation / Correction <span className="text-slate-400 font-normal">(Optional)</span>
                </label>
                <textarea
                  rows={2}
                  value={directCancelReason}
                  onChange={(e) => setDirectCancelReason(e.target.value)}
                  placeholder="e.g. Accidental confirmation by receiving staff, wrong shipment selected, or transit dispute..."
                  className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-rose-500 ${
                    isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300'
                  }`}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={() => setDirectCancelModalShipment(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isProcessingCancel}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1.5 shadow-md shadow-rose-600/30 cursor-pointer disabled:opacity-50"
                >
                  {isProcessingCancel ? (
                    <Clock className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  <span>{isProcessingCancel ? 'Processing Reversal...' : 'Confirm Cancellation & Revert Stock'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. REQUEST CANCEL RECEIVE TRANSFER MODAL (Staff Workflow) */}
      {/* ------------------------------------------------------------- */}
      {requestCancelModalShipment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-xl rounded-2xl shadow-2xl border overflow-hidden my-6 ${
            isDarkMode ? 'bg-[#0f1218] border-amber-900/50 text-slate-200' : 'bg-white border-amber-200 text-slate-800'
          }`}>
            {/* Header */}
            <div className="p-4 bg-amber-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-white/20">
                  <ShieldAlert className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-base">Request Transfer Receipt Cancellation</h3>
                  <p className="text-xs text-amber-100 font-mono">
                    Transfer #{requestCancelModalShipment.trackingCode}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setRequestCancelModalShipment(null)}
                className="p-1 rounded-lg text-white/80 hover:text-white hover:bg-white/10 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleRequestCancelSubmit} className="p-5 space-y-4">
              <div className={`p-3.5 rounded-xl border flex items-start gap-3 text-xs ${
                isDarkMode ? 'bg-amber-950/30 border-amber-800/50 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}>
                <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
                <div className="space-y-1">
                  <div className="font-bold">Workflow Approval Process</div>
                  <p>
                    As a branch operator, this cancellation request will be submitted to the <span className="font-bold underline">Workflow Approval Center</span> for Super Admin or Inventory Manager review and authorization.
                  </p>
                </div>
              </div>

              {/* Transfer Details Card */}
              <div className={`p-3 rounded-xl border text-xs space-y-2 ${isDarkMode ? 'bg-slate-900/50 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center justify-between text-slate-500 font-medium">
                  <span>Transfer Route:</span>
                  <span className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1">
                    {requestCancelModalShipment.sourceBranchName} <ArrowRight className="h-3 w-3" /> {requestCancelModalShipment.destinationBranchName}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-500 font-medium">
                  <span>Items Count:</span>
                  <span className="font-bold text-slate-900 dark:text-slate-100">
                    {requestCancelModalShipment.items.reduce((s, i) => s + (i.quantityReceived || i.quantitySent || (i as any).quantity || 1), 0)} Total Units
                  </span>
                </div>
              </div>

              {/* Reason Input (Mandatory) */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Justification / Cancellation Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={requestCancelReason}
                  onChange={(e) => setRequestCancelReason(e.target.value)}
                  placeholder="Explain why this transfer receipt needs to be cancelled and reverted to In-Transit..."
                  className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                    isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300'
                  }`}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={() => setRequestCancelModalShipment(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isProcessingCancel}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-600 hover:bg-amber-500 text-white flex items-center gap-1.5 shadow-md shadow-amber-600/30 cursor-pointer disabled:opacity-50"
                >
                  {isProcessingCancel ? (
                    <Clock className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5" />
                  )}
                  <span>{isProcessingCancel ? 'Submitting Request...' : 'Submit Cancellation Request'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. WITHDRAW PENDING CANCEL REQUEST MODAL */}
      {/* ------------------------------------------------------------- */}
      {cancelPendingRequestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-md rounded-2xl shadow-2xl border overflow-hidden my-6 ${
            isDarkMode ? 'bg-[#0f1218] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-amber-400" />
                <h3 className="font-bold text-sm">Withdraw Cancellation Request</h3>
              </div>
              <button
                onClick={() => setCancelPendingRequestModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <p>
                Are you sure you want to withdraw the pending cancellation request for transfer <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{cancelPendingRequestModal.shipment.trackingCode}</span>?
              </p>
              <div className={`p-3 rounded-xl border ${isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                <div className="font-bold text-slate-700 dark:text-slate-300">Request #{cancelPendingRequestModal.req.requestNumber}</div>
                <div className="text-slate-500 mt-1">Reason: {cancelPendingRequestModal.req.reason}</div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={() => setCancelPendingRequestModal(null)}
                  className="px-4 py-2 rounded-xl font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Keep Request
                </button>
                <button
                  type="button"
                  disabled={isProcessingCancel}
                  onClick={handleWithdrawCancelRequest}
                  className="px-4 py-2 rounded-xl font-bold bg-amber-600 hover:bg-amber-500 text-white flex items-center gap-1 cursor-pointer disabled:opacity-50"
                >
                  {isProcessingCancel ? <Clock className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                  <span>{isProcessingCancel ? 'Cancelling...' : 'Withdraw Request'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
