import React, { useState } from 'react';
import { ApprovalRequest, Branch, User } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { isOperationAllowed } from '../../utils/permissions';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Search,
  Filter,
  Check,
  X,
  AlertTriangle,
  UserCheck,
  Layers,
  FileText,
  Barcode,
  ArrowRight,
  RefreshCw,
  Send,
  Building2,
  RotateCcw,
  Truck,
  Package,
  ClipboardCheck,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface ApprovalWorkflowCenterProps {
  approvalRequests: ApprovalRequest[];
  branches: Branch[];
  currentUser?: User | null;
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
  onProcessApproval: (
    id: string,
    status: 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  ) => Promise<void>;
  onCancelApproval?: (id: string, reason?: string) => Promise<void>;
  onNavigateToStockAudit?: (branchId: string, auditReqId?: string) => void;
}

export const ApprovalWorkflowCenter: React.FC<ApprovalWorkflowCenterProps> = ({
  approvalRequests = [],
  branches = [],
  currentUser,
  dateMode,
  isDarkMode = false,
  onProcessApproval,
  onCancelApproval,
  onNavigateToStockAudit,
}) => {
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterType, setFilterType] = useState<'ALL' | 'CUSTOMER_DEVICE_STATUS' | 'CANCEL_TRANSFER' | 'CANCEL_RECEIVE_TRANSFER' | 'STOCK_AUDIT_RECONCILIATION'>('ALL');
  const [filterBranchId, setFilterBranchId] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [approvingReq, setApprovingReq] = useState<ApprovalRequest | null>(null);
  const [rejectingReq, setRejectingReq] = useState<ApprovalRequest | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState('');
  const [cancellingReq, setCancellingReq] = useState<ApprovalRequest | null>(null);
  const [cancelReasonInput, setCancelReasonInput] = useState('');
  const [viewingReq, setViewingReq] = useState<ApprovalRequest | null>(null);
  const [isProcessingId, setIsProcessingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const canApprove =
    isOperationAllowed('workflow-approval', currentUser?.role) ||
    currentUser?.role === 'SUPER_ADMIN' ||
    currentUser?.role === 'INVENTORY_MANAGER';

  // Branch Manager and Front Desk staff are not permitted to cancel approval requests.
  const canCancelApprovalRequest = Boolean(
    currentUser &&
    currentUser.role !== 'BRANCH_MANAGER' &&
    currentUser.role !== 'FRONT_DESK' &&
    (currentUser.role === 'SUPER_ADMIN' ||
      currentUser.role === 'INVENTORY_MANAGER' ||
      isOperationAllowed('workflow-approval-cancel', currentUser.role))
  );

  const pendingCount = approvalRequests.filter((r) => r.status === 'PENDING').length;
  const approvedCount = approvalRequests.filter((r) => r.status === 'APPROVED').length;
  const rejectedCount = approvalRequests.filter((r) => r.status === 'REJECTED').length;
  const cancelledCount = approvalRequests.filter((r) => r.status === 'CANCELLED').length;
  const inTransitCancelCount = approvalRequests.filter((r) => r.type === 'CANCEL_TRANSFER' || r.type === 'CANCEL_IN_TRANSIT_TRANSFER').length;
  const transferCancelCount = approvalRequests.filter((r) => r.type === 'CANCEL_TRANSFER' || r.type === 'CANCEL_IN_TRANSIT_TRANSFER' || r.type === 'CANCEL_RECEIVE_TRANSFER').length;
  const cpeStatusCount = approvalRequests.filter((r) => r.type === 'CUSTOMER_DEVICE_STATUS').length;
  const stockAuditCount = approvalRequests.filter((r) => r.type === 'STOCK_AUDIT_RECONCILIATION').length;

  const handleOpenCancelModal = (req: ApprovalRequest) => {
    if (!canCancelApprovalRequest) {
      setToastMessage('Branch Managers and Front Desk staff are not permitted to cancel approval requests.');
      setTimeout(() => setToastMessage(null), 4000);
      return;
    }
    setCancellingReq(req);
    setCancelReasonInput('');
  };

  const handleConfirmCancel = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!cancellingReq) return;

    setIsProcessingId(cancellingReq.id);
    try {
      if (onCancelApproval) {
        await onCancelApproval(cancellingReq.id, cancelReasonInput);
      }
      setToastMessage(`Request #${cancellingReq.requestNumber} has been cancelled successfully.`);
      setCancellingReq(null);
      setCancelReasonInput('');
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      setToastMessage(`Cancellation failed: ${err.message}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsProcessingId(null);
    }
  };

  const filteredList = approvalRequests.filter((req) => {
    const matchesStatus = filterStatus === 'ALL' || req.status === filterStatus;
    const matchesType =
      filterType === 'ALL'
        ? true
        : filterType === 'CANCEL_TRANSFER'
        ? req.type === 'CANCEL_TRANSFER' || req.type === 'CANCEL_IN_TRANSIT_TRANSFER'
        : req.type === filterType;
    const matchesBranch = filterBranchId === 'ALL' || req.branchId === filterBranchId;

    if (!searchQuery.trim()) return matchesStatus && matchesType && matchesBranch;

    const q = (searchQuery || '').toLowerCase().trim();
    const matchesQ =
      (req?.requestNumber || '').toLowerCase().includes(q) ||
      (req?.customerName || '').toLowerCase().includes(q) ||
      (req?.deviceSerial || '').toLowerCase().includes(q) ||
      (req.ponSerial && (req?.ponSerial || '').toLowerCase().includes(q)) ||
      (req?.requestedByName || '').toLowerCase().includes(q) ||
      (req?.productName || '').toLowerCase().includes(q) ||
      (req.auditData?.auditRefNumber && (req?.auditData?.auditRefNumber || '').toLowerCase().includes(q)) ||
      (req.auditData?.branchName && (req?.auditData?.branchName || '').toLowerCase().includes(q)) ||
      (req.shipmentData?.trackingCode && (req?.shipmentData?.trackingCode || '').toLowerCase().includes(q)) ||
      (req.shipmentData?.sourceBranchName && (req?.shipmentData?.sourceBranchName || '').toLowerCase().includes(q)) ||
      (req.shipmentData?.destinationBranchName && (req?.shipmentData?.destinationBranchName || '').toLowerCase().includes(q));

    return matchesStatus && matchesType && matchesBranch && matchesQ;
  });

  const requestsPagination = useClientPagination(filteredList, 15, [searchQuery, filterStatus, filterType, filterBranchId]);

  const handleApprove = (req: ApprovalRequest) => {
    if (!canApprove) {
      setToastMessage('Only Inventory Managers or Super Admins can authorize workflow approval requests.');
      setTimeout(() => setToastMessage(null), 4000);
      return;
    }
    setApprovingReq(req);
  };

  const handleConfirmApprove = async () => {
    if (!approvingReq) return;

    setIsProcessingId(approvingReq.id);
    try {
      await onProcessApproval(approvingReq.id, 'APPROVED');
      setToastMessage(`Approval Request #${approvingReq.requestNumber} for ${approvingReq.customerName} authorized & executed successfully!`);
      setApprovingReq(null);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      setToastMessage(`Approval failed: ${err.message}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsProcessingId(null);
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingReq) return;
    if (!rejectionReasonInput.trim()) {
      return;
    }

    setIsProcessingId(rejectingReq.id);
    try {
      await onProcessApproval(rejectingReq.id, 'REJECTED', rejectionReasonInput.trim());
      setToastMessage(`Request #${rejectingReq.requestNumber} rejected.`);
      setRejectingReq(null);
      setRejectionReasonInput('');
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      setToastMessage(`Rejection failed: ${err.message}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsProcessingId(null);
    }
  };

  const cardBg = isDarkMode
    ? 'bg-slate-900/80 border-slate-800 text-slate-100'
    : 'bg-white border-slate-200/80 text-slate-900';

  const subTextColor = isDarkMode ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className={`rounded-2xl border shadow-xs p-5 space-y-5 ${cardBg}`}>
      {/* Toast Banner */}
      {toastMessage && (
        <div className="p-3.5 rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center justify-between shadow-lg animate-fade-in">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <span>{toastMessage}</span>
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="p-1 rounded-lg hover:bg-white/20 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header & Role Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-slate-200/80 dark:border-slate-800">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-indigo-600/10 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-base sm:text-lg flex items-center gap-2">
                <span>Workflow Approval & Authorization Center</span>
                {pendingCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white animate-pulse">
                    {pendingCount} Pending Review
                  </span>
                )}
              </h3>
              <p className={`text-xs mt-0.5 ${subTextColor}`}>
                <strong>Request Flow:</strong> Branch Manager / Front Desk ➔ Inventory Manager / Super Admin. Formal authorization center for Suspend, Disconnect & Refund/Restock actions.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start md:self-auto">
          <span
            className={`text-xs px-3 py-1.5 rounded-xl font-bold border flex items-center gap-1.5 ${
              canApprove
                ? 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
                : 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
            }`}
          >
            <UserCheck className="h-4 w-4" />
            <span>
              {canApprove ? 'Authorized Approver Role' : 'Requester Role (Submit Mode)'}
            </span>
          </span>
        </div>
      </div>

      {/* Top Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div
          onClick={() => setFilterStatus('PENDING')}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
            filterStatus === 'PENDING'
              ? 'ring-2 ring-amber-500 bg-amber-500/10 border-amber-500/50'
              : isDarkMode
              ? 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
              : 'bg-amber-50/50 border-amber-200/80 hover:bg-amber-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-bold text-amber-700 dark:text-amber-400">
            <span>Pending</span>
            <Clock className="h-4 w-4" />
          </div>
          <div className="text-xl font-black text-amber-900 dark:text-amber-200 mt-1">
            {pendingCount}
          </div>
          <p className="text-[10px] text-amber-700/80 dark:text-amber-400 mt-0.5">
            Awaiting Super Admin review
          </p>
        </div>

        <div
          onClick={() => setFilterStatus('APPROVED')}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
            filterStatus === 'APPROVED'
              ? 'ring-2 ring-emerald-500 bg-emerald-500/10 border-emerald-500/50'
              : isDarkMode
              ? 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
              : 'bg-emerald-50/50 border-emerald-200/80 hover:bg-emerald-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-bold text-emerald-700 dark:text-emerald-400">
            <span>Approved</span>
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div className="text-xl font-black text-emerald-900 dark:text-emerald-200 mt-1">
            {approvedCount}
          </div>
          <p className="text-[10px] text-emerald-700/80 dark:text-emerald-400 mt-0.5">
            Executed & synchronized
          </p>
        </div>

        <div
          onClick={() => setFilterStatus('REJECTED')}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
            filterStatus === 'REJECTED'
              ? 'ring-2 ring-rose-500 bg-rose-500/10 border-rose-500/50'
              : isDarkMode
              ? 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
              : 'bg-rose-50/50 border-rose-200/80 hover:bg-rose-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-bold text-rose-700 dark:text-rose-400">
            <span>Rejected</span>
            <XCircle className="h-4 w-4" />
          </div>
          <div className="text-xl font-black text-rose-900 dark:text-rose-200 mt-1">
            {rejectedCount}
          </div>
          <p className="text-[10px] text-rose-700/80 dark:text-rose-400 mt-0.5">
            Declined with reason
          </p>
        </div>

        <div
          onClick={() => setFilterStatus('CANCELLED')}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
            filterStatus === 'CANCELLED'
              ? 'ring-2 ring-slate-500 bg-slate-500/10 border-slate-500/50'
              : isDarkMode
              ? 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
              : 'bg-slate-100/70 border-slate-300 hover:bg-slate-200/60'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
            <span>Cancelled</span>
            <X className="h-4 w-4" />
          </div>
          <div className="text-xl font-black text-slate-900 dark:text-slate-100 mt-1">
            {cancelledCount}
          </div>
          <p className="text-[10px] text-slate-600 dark:text-slate-400 mt-0.5">
            Withdrawn by requester
          </p>
        </div>

        <div
          onClick={() => setFilterStatus('ALL')}
          className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
            filterStatus === 'ALL'
              ? 'ring-2 ring-indigo-500 bg-indigo-500/10 border-indigo-500/50'
              : isDarkMode
              ? 'bg-slate-800/40 border-slate-700 hover:bg-slate-800'
              : 'bg-indigo-50/50 border-indigo-200/80 hover:bg-indigo-50'
          }`}
        >
          <div className="flex items-center justify-between text-xs font-bold text-indigo-700 dark:text-indigo-400">
            <span>Total</span>
            <Layers className="h-4 w-4" />
          </div>
          <div className="text-xl font-black text-indigo-900 dark:text-indigo-200 mt-1">
            {approvalRequests.length}
          </div>
          <p className="text-[10px] text-indigo-700/80 dark:text-indigo-400 mt-0.5">
            Full audit log trace
          </p>
        </div>
      </div>

      {/* Category / Type Tabs & Branch Search */}
      <div className="flex flex-col gap-3">
        {/* Request Type Selector */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <span className="text-xs font-bold text-slate-500 shrink-0">Type:</span>
          <button
            onClick={() => setFilterType('ALL')}
            className={`px-3 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 ${
              filterType === 'ALL'
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-xs'
                : isDarkMode
                ? 'bg-slate-800/80 text-slate-300 hover:bg-slate-700'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All Workflows ({approvalRequests.length})
          </button>
          <button
            onClick={() => setFilterType('CANCEL_TRANSFER')}
            className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
              filterType === 'CANCEL_TRANSFER'
                ? 'bg-rose-600 text-white shadow-xs'
                : isDarkMode
                ? 'bg-slate-800/80 text-rose-400 hover:bg-slate-700'
                : 'bg-rose-50 text-rose-800 border border-rose-200 hover:bg-rose-100'
            }`}
          >
            <RotateCcw className="h-3 w-3" />
            <span>Cancel In-Transit Transfers ({inTransitCancelCount})</span>
          </button>
          <button
            onClick={() => setFilterType('CANCEL_RECEIVE_TRANSFER')}
            className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
              filterType === 'CANCEL_RECEIVE_TRANSFER'
                ? 'bg-amber-600 text-white shadow-xs'
                : isDarkMode
                ? 'bg-slate-800/80 text-amber-400 hover:bg-slate-700'
                : 'bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100'
            }`}
          >
            <Truck className="h-3 w-3" />
            <span>Transfer Receipt Reversals ({transferCancelCount - inTransitCancelCount})</span>
          </button>
          <button
            onClick={() => setFilterType('STOCK_AUDIT_RECONCILIATION')}
            className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
              filterType === 'STOCK_AUDIT_RECONCILIATION'
                ? 'bg-purple-600 text-white shadow-xs'
                : isDarkMode
                ? 'bg-slate-800/80 text-purple-300 hover:bg-slate-700'
                : 'bg-purple-50 text-purple-800 border border-purple-200 hover:bg-purple-100'
            }`}
          >
            <ClipboardCheck className="h-3 w-3" />
            <span>Stock Audit Reconciliations ({stockAuditCount})</span>
          </button>
          <button
            onClick={() => setFilterType('CUSTOMER_DEVICE_STATUS')}
            className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 ${
              filterType === 'CUSTOMER_DEVICE_STATUS'
                ? 'bg-indigo-600 text-white shadow-xs'
                : isDarkMode
                ? 'bg-slate-800/80 text-indigo-300 hover:bg-slate-700'
                : 'bg-indigo-50 text-indigo-800 border border-indigo-200 hover:bg-indigo-100'
            }`}
          >
            <ShieldCheck className="h-3 w-3" />
            <span>CPE Status Authorizations ({cpeStatusCount})</span>
          </button>
        </div>

        {/* Filter Status Tabs & Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((st) => (
              <button
                key={st}
                onClick={() => setFilterStatus(st)}
                className={`px-3 py-1.5 rounded-xl text-xs font-extrabold uppercase transition-all cursor-pointer shrink-0 ${
                  filterStatus === st
                    ? st === 'PENDING'
                      ? 'bg-amber-600 text-white shadow-xs'
                      : st === 'APPROVED'
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : st === 'REJECTED'
                      ? 'bg-rose-600 text-white shadow-xs'
                      : st === 'CANCELLED'
                      ? 'bg-slate-700 text-white shadow-xs'
                      : 'bg-indigo-600 text-white shadow-xs'
                    : isDarkMode
                    ? 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {st === 'ALL' ? 'All Requests' : st === 'CANCELLED' ? 'Request Cancelled' : st}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {/* Branch Filter */}
            <select
              value={filterBranchId}
              onChange={(e) => setFilterBranchId(e.target.value)}
              className={`rounded-xl px-2.5 py-1.5 text-xs font-bold border cursor-pointer ${
                isDarkMode
                  ? 'bg-slate-800 border-slate-700 text-slate-200'
                  : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            >
              <option value="ALL">🏢 All Branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>

            {/* Search Box */}
 <div className="relative w-full md:w-80 lg:w-96 shrink-0 sm:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search serial, customer, transfer #..."
                className={`w-full pl-8 pr-3 py-1.5 text-xs rounded-xl border focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  isDarkMode
                    ? 'bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500'
                    : 'bg-slate-50 border-slate-200 text-slate-800 placeholder:text-slate-400'
                }`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Request Table List */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className={isDarkMode ? 'bg-slate-800/80 text-slate-300' : 'bg-slate-100/80 text-slate-700'}>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold">Request # & Date</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold">Customer & Serial</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold">Status Transition</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold">Requester & Branch</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold">Reason / Justification</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold text-center">Status</th>
              <th className="px-2.5 py-1.5 text-[11px] font-extrabold text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
            {filteredList.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-400">
                  <div className="flex flex-col items-center justify-center gap-1.5">
                    <ShieldCheck className="h-8 w-8 text-slate-300 dark:text-slate-600" />
                    <p className="font-bold text-sm">No authorization requests found</p>
                    <p className="text-xs">
                      Status change requests submitted by Branch Managers or Frontdesk will appear here.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              requestsPagination.pagedItems.map((req) => {
                const isPending = req.status === 'PENDING';
                const isApproved = req.status === 'APPROVED';
                const isRejected = req.status === 'REJECTED';
                const isCancelled = req.status === 'CANCELLED';

                return (
                  <tr
                    key={req.id}
                    className={`transition-colors ${
                      isPending
                        ? isDarkMode
                          ? 'bg-amber-950/20 hover:bg-amber-950/30'
                          : 'bg-amber-50/40 hover:bg-amber-50/80'
                        : isDarkMode
                        ? 'hover:bg-slate-800/50'
                        : 'hover:bg-slate-50'
                    }`}
                  >
                    {/* Request # & Date */}
                    <td className="p-2.5">
                      <div className="font-mono font-extrabold text-indigo-600 dark:text-indigo-400">
                        {req.requestNumber}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                        {formatDualDate(req.requestedAtAD, dateMode)}
                      </div>
                    </td>

                    {/* Customer / Transfer & Serial */}
                    <td className="p-2.5">
                      {req.type === 'STOCK_AUDIT_RECONCILIATION' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-extrabold text-purple-700 dark:text-purple-400">
                            <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
                            <span>Audit Batch #{req.auditData?.auditRefNumber || req.deviceSerial}</span>
                          </div>
                          <div className="text-[10px] font-bold text-slate-700 dark:text-slate-300 mt-0.5">
                            Branch: {req.branchName || req.auditData?.branchName || req.branchId}
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">
                            Discrepancies: {req.auditData?.discrepancyCount || 0} items (Shortage: -{req.auditData?.shortageQty || 0}, Excess: +{req.auditData?.excessQty || 0})
                          </div>
                        </div>
                      ) : req.type === 'CANCEL_TRANSFER' || req.type === 'CANCEL_IN_TRANSIT_TRANSFER' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-extrabold text-rose-700 dark:text-rose-400">
                            <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                            <span>Transfer #{req.customerName || req.deviceSerial}</span>
                          </div>
                          {req.shipmentData?.sourceBranchName && req.shipmentData?.destinationBranchName && (
                            <div className="text-[10px] font-medium text-slate-500 mt-0.5">
                              {req.shipmentData.sourceBranchName} ➔ {req.shipmentData.destinationBranchName}
                            </div>
                          )}
                          <div className="text-[10px] text-slate-400 font-medium truncate max-w-[200px]">
                            Items: {req.shipmentData?.itemSummary || req.productName}
                          </div>
                        </div>
                      ) : req.type === 'CANCEL_RECEIVE_TRANSFER' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-extrabold text-amber-700 dark:text-amber-400">
                            <Truck className="h-3.5 w-3.5 shrink-0" />
                            <span>Transfer #{req.customerName || req.deviceSerial}</span>
                          </div>
                          {req.shipmentData?.sourceBranchName && req.shipmentData?.destinationBranchName && (
                            <div className="text-[10px] font-medium text-slate-500 mt-0.5">
                              {req.shipmentData.sourceBranchName} ➔ {req.shipmentData.destinationBranchName}
                            </div>
                          )}
                          <div className="text-[10px] text-slate-400 font-medium truncate max-w-[200px]">
                            Items: {req.shipmentData?.itemSummary || req.productName}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="font-bold text-slate-900 dark:text-slate-100">
                            {req.customerName}
                          </div>
                          <div className="flex items-center gap-1 mt-0.5 text-[10px] font-mono text-slate-500">
                            <Barcode className="h-3 w-3 text-blue-500 shrink-0" />
                            <span className="font-bold text-blue-700 dark:text-blue-300">
                              {req.deviceSerial}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 font-medium">
                            Model: {req.productName}
                          </div>
                        </div>
                      )}
                    </td>

                    {/* Status Transition */}
                    <td className="p-2.5">
                      {req.type === 'STOCK_AUDIT_RECONCILIATION' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-bold text-[10px]">
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
                              COUNTED AUDIT
                            </span>
                            <ArrowRight className="h-3 w-3 text-slate-400" />
                            <span className="px-2 py-0.5 rounded-full bg-purple-600 text-white font-extrabold flex items-center gap-1">
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              <span>ADJUST & RECONCILE</span>
                            </span>
                          </div>
                          <div className="mt-1 text-[9px] font-mono font-bold text-purple-600 dark:text-purple-400 flex items-center gap-0.5">
                            <span>Net Impact: {req.auditData?.netValueVariance && req.auditData.netValueVariance >= 0 ? '+' : ''}NPR {(req.auditData?.netValueVariance || 0).toLocaleString()}</span>
                          </div>
                        </div>
                      ) : req.type === 'CANCEL_TRANSFER' || req.type === 'CANCEL_IN_TRANSIT_TRANSFER' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-bold text-[10px]">
                            <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-300 dark:bg-sky-950 dark:text-sky-300">
                              IN_TRANSIT
                            </span>
                            <ArrowRight className="h-3 w-3 text-slate-400" />
                            <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-extrabold flex items-center gap-1">
                              <XCircle className="h-2.5 w-2.5" />
                              <span>CANCELLED</span>
                            </span>
                          </div>
                          <div className="mt-1 text-[9px] text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-0.5">
                            <RefreshCw className="h-2.5 w-2.5 shrink-0" />
                            <span>Restores stock back to source branch</span>
                          </div>
                        </div>
                      ) : req.type === 'CANCEL_RECEIVE_TRANSFER' ? (
                        <div>
                          <div className="flex items-center gap-1.5 font-bold text-[10px]">
                            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300">
                              RECEIVED
                            </span>
                            <ArrowRight className="h-3 w-3 text-slate-400" />
                            <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300 dark:bg-rose-950 dark:text-rose-300 font-extrabold flex items-center gap-1">
                              <RotateCcw className="h-2.5 w-2.5" />
                              <span>IN_TRANSIT (REVERT)</span>
                            </span>
                          </div>
                          <div className="mt-1 text-[9px] text-rose-600 dark:text-rose-400 font-bold flex items-center gap-0.5">
                            <span>Reverts destination stock & serialized logs</span>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="flex items-center gap-1.5 font-bold text-[10px]">
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
                              {req.currentStatus}
                            </span>
                            <ArrowRight className="h-3 w-3 text-slate-400" />
                            <span
                              className={`px-2 py-0.5 rounded-full border uppercase ${
                                req.requestedStatus === 'REFUND'
                                  ? 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950 dark:text-purple-300'
                                  : req.requestedStatus === 'ROUTER_COLLECTED' || req.requestedStatus === 'DISCONNECTED'
                                  ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300'
                                  : 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950 dark:text-blue-300'
                              }`}
                            >
                              {req.requestedStatus === 'ROUTER_COLLECTED' ? 'ROUTER COLLECTED (DISCONNECT)' : req.requestedStatus}
                            </span>
                          </div>
                          {req.restockQtyOnApproval && (
                            <div className="mt-1 text-[9px] text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-0.5">
                              <RefreshCw className="h-2.5 w-2.5" />
                              <span>Restock +1 unit on approval</span>
                            </div>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Requester & Branch */}
                    <td className="p-2.5">
                      <div className="font-semibold text-slate-800 dark:text-slate-200">
                        {req.requestedByName}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
                        <span className="px-1.5 py-0.2 rounded bg-slate-200/80 dark:bg-slate-700 font-mono font-bold text-slate-700 dark:text-slate-300">
                          {req.requestedByRole}
                        </span>
                        <span>•</span>
                        <span>{req.branchName || req.branchId}</span>
                      </div>
                    </td>

                    {/* Reason */}
                    <td className="p-2.5 max-w-xs">
                      <p className="text-slate-600 dark:text-slate-300 text-[11px] line-clamp-2 leading-relaxed">
                        {req.reason}
                      </p>
                      {req.rejectionReason && (
                        <p className="text-rose-600 dark:text-rose-400 text-[10px] font-bold mt-1 line-clamp-1">
                          Rejection: {req.rejectionReason}
                        </p>
                      )}
                    </td>

                    {/* Status Badge */}
                    <td className="p-2.5 text-center">
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase border ${
                          isPending
                            ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300'
                            : isApproved
                            ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/80 dark:text-emerald-300'
                            : isRejected
                            ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300'
                            : 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
                        }`}
                      >
                        {isPending && <Clock className="h-3 w-3 animate-spin" />}
                        {isApproved && <CheckCircle2 className="h-3 w-3" />}
                        {isRejected && <XCircle className="h-3 w-3" />}
                        {isCancelled && <X className="h-3 w-3 text-slate-500" />}
                        <span>{isCancelled ? 'REQUEST CANCELLED' : req.status}</span>
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="p-2.5 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        {/* Dedicated Action for Stock Audit Reconciliation */}
                        {req.type === 'STOCK_AUDIT_RECONCILIATION' && onNavigateToStockAudit && (
                          <button
                            onClick={() => onNavigateToStockAudit(req.branchId || 'WH001', req.id)}
                            className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-bold text-[11px] shadow-xs flex items-center gap-1 cursor-pointer shrink-0"
                            title="Open Stock Count Table to Inspect Discrepancies & Reconcile"
                          >
                            <ClipboardCheck className="h-3.5 w-3.5" />
                            <span>Inspect & Reconcile in Table</span>
                          </button>
                        )}

                        {isPending && canApprove && (
                          <>
                            <button
                              onClick={() => handleApprove(req)}
                              disabled={isProcessingId === req.id}
                              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] shadow-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
                              title="Approve Request & Execute Status Change"
                            >
                              <Check className="h-3 w-3" />
                              <span>Approve</span>
                            </button>

                            <button
                              onClick={() => {
                                setRejectingReq(req);
                                setRejectionReasonInput('');
                              }}
                              disabled={isProcessingId === req.id}
                              className="px-2 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px] shadow-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
                              title="Reject Request"
                            >
                              <X className="h-3 w-3" />
                              <span>Reject</span>
                            </button>
                          </>
                        )}

                        {isPending && onCancelApproval && canCancelApprovalRequest && (
                          <button
                            onClick={() => handleOpenCancelModal(req)}
                            disabled={isProcessingId === req.id}
                            className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white font-bold text-[11px] shadow-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            title="Cancel this pending approval request"
                          >
                            <XCircle className="h-3 w-3" />
                            <span>Cancel</span>
                          </button>
                        )}

                        <button
                          onClick={() => setViewingReq(req)}
                          className="px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold text-[11px] cursor-pointer"
                        >
                          Details
                        </button>
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
        page={requestsPagination.page}
        pageCount={requestsPagination.pageCount}
        totalItems={requestsPagination.totalItems}
        rangeStart={requestsPagination.rangeStart}
        rangeEnd={requestsPagination.rangeEnd}
        pageSize={requestsPagination.pageSize}
        onPageChange={requestsPagination.setPage}
        onPageSizeChange={requestsPagination.setPageSize}
        isDarkMode={isDarkMode}
        className="mt-1"
      />

      {/* Modal for Approval Confirmation */}
      {approvingReq && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-lg w-full border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-emerald-600 font-extrabold text-base pb-2 border-b border-slate-200 dark:border-slate-800">
              <ShieldCheck className="h-6 w-6 text-emerald-600" />
              <span>Authorize Approval for Request #{approvingReq.requestNumber}</span>
            </div>

            <div className="p-3.5 rounded-2xl bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200/80 dark:border-emerald-800/60 space-y-2 text-xs">
              {approvingReq.type === 'STOCK_AUDIT_RECONCILIATION' ? (
                <>
                  <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                    <span className="flex items-center gap-1 text-purple-700 dark:text-purple-400 font-extrabold">
                      <ClipboardCheck className="h-4 w-4" />
                      <span>Audit Batch #{approvingReq.auditData?.auditRefNumber || approvingReq.deviceSerial}</span>
                    </span>
                    <span className="font-mono text-[10px] text-purple-700 dark:text-purple-400 font-bold">
                      STOCK AUDIT RECONCILIATION
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-700 dark:text-slate-300">
                    Branch: <strong>{approvingReq.branchName || approvingReq.auditData?.branchName}</strong>
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                    Variance Items: <strong>{approvingReq.auditData?.discrepancyCount || 0}</strong> (Shortage: -{approvingReq.auditData?.shortageQty || 0}, Excess: +{approvingReq.auditData?.excessQty || 0})
                  </div>
                  <div className="pt-2 flex items-center justify-between border-t border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Reconciliation Action:</span>
                    <div className="flex items-center gap-1.5 font-bold text-xs">
                      <span className="px-2 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        AUDIT COUNT
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="px-2 py-0.5 rounded-full bg-purple-600 text-white uppercase font-extrabold flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>ADJUST PHYSICAL STOCK</span>
                      </span>
                    </div>
                  </div>
                  <div className="p-2 rounded-xl bg-purple-50 dark:bg-purple-950/40 text-purple-800 dark:text-purple-300 font-bold text-[11px] flex items-center gap-1.5 mt-1">
                    <span>Net Financial Impact: {approvingReq.auditData?.netValueVariance && approvingReq.auditData.netValueVariance >= 0 ? '+' : ''}NPR {(approvingReq.auditData?.netValueVariance || 0).toLocaleString()}</span>
                  </div>
                </>
              ) : approvingReq.type === 'CANCEL_TRANSFER' || approvingReq.type === 'CANCEL_IN_TRANSIT_TRANSFER' ? (
                <>
                  <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                    <span className="flex items-center gap-1 text-rose-700 dark:text-rose-400">
                      <RotateCcw className="h-4 w-4" />
                      <span>Transfer #{approvingReq.customerName || approvingReq.deviceSerial}</span>
                    </span>
                    <span className="font-mono text-[10px] text-rose-700 dark:text-rose-400 font-bold">
                      IN-TRANSIT CANCELLATION
                    </span>
                  </div>
                  {approvingReq.shipmentData?.sourceBranchName && approvingReq.shipmentData?.destinationBranchName && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400">
                      Route: <strong>{approvingReq.shipmentData.sourceBranchName}</strong> ➔ <strong>{approvingReq.shipmentData.destinationBranchName}</strong>
                    </div>
                  )}
                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                    Items to Refund: <strong>{approvingReq.shipmentData?.itemSummary || approvingReq.productName}</strong>
                  </div>
                  <div className="pt-2 flex items-center justify-between border-t border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Action:</span>
                    <div className="flex items-center gap-1.5 font-bold text-xs">
                      <span className="px-2 py-0.5 rounded bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-300">
                        IN_TRANSIT
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white uppercase font-extrabold flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        <span>CANCELLED & RESTOCK SOURCE</span>
                      </span>
                    </div>
                  </div>
                </>
              ) : approvingReq.type === 'CANCEL_RECEIVE_TRANSFER' ? (
                <>
                  <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                    <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <Truck className="h-4 w-4" />
                      <span>Transfer #{approvingReq.customerName || approvingReq.deviceSerial}</span>
                    </span>
                    <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                      TRANSFER RECEIPT REVERSAL
                    </span>
                  </div>
                  {approvingReq.shipmentData?.sourceBranchName && approvingReq.shipmentData?.destinationBranchName && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400">
                      Route: <strong>{approvingReq.shipmentData.sourceBranchName}</strong> ➔ <strong>{approvingReq.shipmentData.destinationBranchName}</strong>
                    </div>
                  )}
                  <div className="text-[11px] text-slate-600 dark:text-slate-400">
                    Items: <strong>{approvingReq.shipmentData?.itemSummary || approvingReq.productName}</strong>
                  </div>
                  <div className="pt-2 flex items-center justify-between border-t border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Transfer Reversal:</span>
                    <div className="flex items-center gap-1.5 font-bold text-xs">
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
                        RECEIVED
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white uppercase font-extrabold flex items-center gap-1">
                        <RotateCcw className="h-3 w-3" />
                        <span>IN_TRANSIT</span>
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between font-bold text-slate-900 dark:text-slate-100">
                    <span>Customer: {approvingReq.customerName}</span>
                    <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                      {approvingReq.customerCode}
                    </span>
                  </div>
                  <div className="flex justify-between font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    <span>Serial #: {approvingReq.deviceSerial}</span>
                    <span>Model: {approvingReq.productName}</span>
                  </div>
                  <div className="pt-2 flex items-center justify-between border-t border-emerald-200/60 dark:border-emerald-800/40">
                    <span className="font-bold text-slate-700 dark:text-slate-300">Status Transition:</span>
                    <div className="flex items-center gap-1.5 font-bold text-xs">
                      <span className="px-2 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        {approvingReq.currentStatus}
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-emerald-600" />
                      <span className="px-2 py-0.5 rounded-full bg-emerald-600 text-white uppercase font-extrabold">
                        {approvingReq.requestedStatus}
                      </span>
                    </div>
                  </div>
                  {approvingReq.restockQtyOnApproval && (
                    <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 font-bold text-[11px] flex items-center gap-1.5 mt-1">
                      <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                      <span>+1 Unit will be automatically restocked to branch inventory stock.</span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="text-xs space-y-1.5">
              <span className="font-bold text-slate-700 dark:text-slate-300 block">
                Submitted Reason / Justification:
              </span>
              <p className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 leading-relaxed italic text-[11px]">
                "{approvingReq.reason}"
              </p>
            </div>

            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-[11px] text-amber-900 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Confirming authorization will instantly execute stock balance reconciliation or status change and record an official audit log trace.
              </span>
            </div>

            {approvingReq.type === 'STOCK_AUDIT_RECONCILIATION' && onNavigateToStockAudit && (
              <div className="p-3 rounded-2xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 flex items-center justify-between gap-2">
                <div className="text-xs text-purple-900 dark:text-purple-200">
                  <span className="font-bold block">Need to inspect full audit report or adjust counts?</span>
                  <span className="text-[11px] text-purple-700 dark:text-purple-300">Open the Stock Count Table for {approvingReq.branchName || 'this branch'} with dedicated Approve & Reconcile actions.</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const bId = approvingReq.branchId || 'WH001';
                    const reqId = approvingReq.id;
                    setApprovingReq(null);
                    onNavigateToStockAudit(bId, reqId);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs shrink-0 flex items-center gap-1 cursor-pointer"
                >
                  <ClipboardCheck className="h-3.5 w-3.5" />
                  <span>Open Stock Count Table</span>
                </button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setApprovingReq(null)}
                disabled={isProcessingId === approvingReq.id}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmApprove}
                disabled={isProcessingId === approvingReq.id}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold shadow-lg shadow-emerald-600/20 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isProcessingId === approvingReq.id ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Authorizing...</span>
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    <span>Confirm & Authorize Approval</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal for Rejection Reason */}
      {rejectingReq && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-md w-full border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-2 text-rose-600 font-extrabold text-base">
              <XCircle className="h-5 w-5" />
              <span>Reject Request #{rejectingReq.requestNumber}</span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300">
              Rejecting status change for <strong>{rejectingReq.customerName}</strong> ({rejectingReq.deviceSerial}). Please state the rejection reason:
            </p>

            <form onSubmit={handleConfirmReject} className="space-y-4">
              <textarea
                required
                rows={3}
                value={rejectionReasonInput}
                onChange={(e) => setRejectionReasonInput(e.target.value)}
                placeholder="e.g. Customer must return physical ONU router equipment to the branch office before disconnection..."
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-rose-500"
              />

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setRejectingReq(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessingId === rejectingReq.id}
                  className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-md shadow-rose-600/20 cursor-pointer disabled:opacity-50"
                >
                  Confirm Rejection
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal for Request Details */}
      {viewingReq && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-lg w-full border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <span className="font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400">
                  {viewingReq.requestNumber}
                </span>
                <h3 className="font-extrabold text-base text-slate-900 dark:text-slate-100">
                  Authorization Request Trace
                </h3>
              </div>
              <button
                onClick={() => setViewingReq(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border space-y-1.5">
                {viewingReq.type === 'STOCK_AUDIT_RECONCILIATION' ? (
                  <>
                    <div className="flex justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-purple-700 dark:text-purple-400 font-extrabold">
                        <ClipboardCheck className="h-4 w-4" />
                        <span>Audit Batch #{viewingReq.auditData?.auditRefNumber || viewingReq.deviceSerial}</span>
                      </span>
                      <span className="font-mono text-[10px] text-purple-600 font-bold">STOCK AUDIT RECONCILIATION</span>
                    </div>
                    <div className="text-slate-600 dark:text-slate-400 text-[11px]">
                      Branch: <strong>{viewingReq.branchName || viewingReq.auditData?.branchName || viewingReq.branchId}</strong>
                    </div>
                    <div className="text-slate-500 text-[11px]">
                      Summary: <strong>{viewingReq.auditData?.discrepancyCount || 0} discrepancy items</strong> (Shortage: -{viewingReq.auditData?.shortageQty || 0}, Excess: +{viewingReq.auditData?.excessQty || 0})
                    </div>
                    <div className="pt-1.5 flex justify-between font-bold text-[11px]">
                      <span>Reconciliation Action:</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-600">AUDIT COUNT</span>
                        <span>➔</span>
                        <span className="text-purple-600 uppercase font-extrabold flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>PHYSICAL STOCK ADJUSTMENT</span>
                        </span>
                      </div>
                    </div>
                    {viewingReq.auditData?.varianceItems && viewingReq.auditData.varianceItems.length > 0 && (
                      <div className="mt-2 border-t border-slate-200 dark:border-slate-700 pt-2 space-y-1">
                        <span className="font-bold text-[11px] text-slate-700 dark:text-slate-300 block">Variance Breakdown:</span>
                        <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                          {viewingReq.auditData.varianceItems.map((item, idx) => (
                            <div key={idx} className="p-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-[10px] flex items-center justify-between">
                              <div>
                                <span className="font-bold text-slate-800 dark:text-slate-200">{item.productName}</span>
                                <span className="text-slate-400 font-mono ml-1.5">({item.sku})</span>
                              </div>
                              <div className="text-right">
                                <span className={`font-extrabold ${item.varianceQty < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                                  {item.varianceQty > 0 ? `+${item.varianceQty}` : item.varianceQty} {item.unit}
                                </span>
                                <span className="text-slate-400 ml-1">
                                  (Sys: {item.bookQty} ➔ Act: {item.countedQty})
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : viewingReq.type === 'CANCEL_TRANSFER' || viewingReq.type === 'CANCEL_IN_TRANSIT_TRANSFER' ? (
                  <>
                    <div className="flex justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-rose-700 dark:text-rose-400">
                        <RotateCcw className="h-4 w-4" />
                        <span>Transfer #{viewingReq.customerName || viewingReq.deviceSerial}</span>
                      </span>
                      <span className="font-mono text-[10px] text-rose-600 font-bold">IN-TRANSIT CANCELLATION</span>
                    </div>
                    {viewingReq.shipmentData?.sourceBranchName && viewingReq.shipmentData?.destinationBranchName && (
                      <div className="text-slate-600 dark:text-slate-400 text-[11px]">
                        Route: <strong>{viewingReq.shipmentData.sourceBranchName}</strong> ➔ <strong>{viewingReq.shipmentData.destinationBranchName}</strong>
                      </div>
                    )}
                    <div className="text-slate-500 font-mono text-[11px]">
                      <span>Items to Refund: {viewingReq.shipmentData?.itemSummary || viewingReq.productName}</span>
                    </div>
                    <div className="pt-1.5 flex justify-between font-bold text-[11px]">
                      <span>Status Change:</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sky-600">IN_TRANSIT</span>
                        <span>➔</span>
                        <span className="text-rose-600 uppercase font-extrabold flex items-center gap-1">
                          <XCircle className="h-3 w-3" />
                          <span>CANCELLED (RESTOCK SOURCE)</span>
                        </span>
                      </div>
                    </div>
                  </>
                ) : viewingReq.type === 'CANCEL_RECEIVE_TRANSFER' ? (
                  <>
                    <div className="flex justify-between font-bold">
                      <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                        <Truck className="h-4 w-4" />
                        <span>Transfer #{viewingReq.customerName || viewingReq.deviceSerial}</span>
                      </span>
                      <span className="font-mono text-[10px] text-amber-600">TRANSFER RECEIPT REVERSAL</span>
                    </div>
                    {viewingReq.shipmentData?.sourceBranchName && viewingReq.shipmentData?.destinationBranchName && (
                      <div className="text-slate-600 dark:text-slate-400 text-[11px]">
                        Route: <strong>{viewingReq.shipmentData.sourceBranchName}</strong> ➔ <strong>{viewingReq.shipmentData.destinationBranchName}</strong>
                      </div>
                    )}
                    <div className="text-slate-500 font-mono text-[11px]">
                      <span>Items: {viewingReq.shipmentData?.itemSummary || viewingReq.productName}</span>
                    </div>
                    <div className="pt-1.5 flex justify-between font-bold text-[11px]">
                      <span>Status Change:</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-emerald-600">RECEIVED</span>
                        <span>➔</span>
                        <span className="text-rose-600 uppercase font-extrabold flex items-center gap-1">
                          <RotateCcw className="h-3 w-3" />
                          <span>IN_TRANSIT (REVERT)</span>
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between font-bold">
                      <span>Customer: {viewingReq.customerName}</span>
                      <span className="font-mono text-[10px]">{viewingReq.customerCode}</span>
                    </div>
                    <div className="flex justify-between text-slate-500 font-mono text-[11px]">
                      <span>Device Serial: {viewingReq.deviceSerial}</span>
                      <span>Model: {viewingReq.productName}</span>
                    </div>
                    <div className="pt-1.5 flex justify-between font-bold text-[11px]">
                      <span>Status Change:</span>
                      <div className="flex items-center gap-1.5">
                        <span>{viewingReq.currentStatus}</span>
                        <span>➔</span>
                        <span className="text-amber-600 uppercase">{viewingReq.requestedStatus}</span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div>
                <span className="font-bold text-slate-700 dark:text-slate-300 block mb-0.5">
                  Requester Details:
                </span>
                <p className="text-slate-600 dark:text-slate-400">
                  {viewingReq.requestedByName} ({viewingReq.requestedByRole}) • {viewingReq.requestedByEmail} • {viewingReq.branchName}
                </p>
              </div>

              <div>
                <span className="font-bold text-slate-700 dark:text-slate-300 block mb-0.5">
                  Reason / Justification:
                </span>
                <p className="p-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 leading-relaxed">
                  {viewingReq.reason}
                </p>
              </div>

              {viewingReq.processedByName && (
                <div className={`p-3 rounded-xl border space-y-1 ${
                  viewingReq.status === 'APPROVED'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800'
                    : viewingReq.status === 'REJECTED'
                    ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
                    : 'bg-slate-100 dark:bg-slate-800/80 border-slate-300 dark:border-slate-700'
                }`}>
                  <span className={`font-bold block ${
                    viewingReq.status === 'APPROVED'
                      ? 'text-emerald-900 dark:text-emerald-300'
                      : viewingReq.status === 'REJECTED'
                      ? 'text-rose-900 dark:text-rose-300'
                      : 'text-slate-800 dark:text-slate-200'
                  }`}>
                    {viewingReq.status === 'CANCELLED' ? 'Cancellation Record:' : `Processed Trace (${viewingReq.status}):`}
                  </span>
                  <p className="text-slate-700 dark:text-slate-300 text-[11px]">
                    By: {viewingReq.processedByName} ({viewingReq.processedByRole}) • {viewingReq.processedByEmail}
                  </p>
                  <p className="text-slate-500 dark:text-slate-400 font-mono text-[10px]">
                    At: {formatDualDate(viewingReq.processedAtAD || '', dateMode)}
                  </p>
                  {viewingReq.rejectionReason && (
                    <p className="text-rose-700 dark:text-rose-400 font-bold mt-1">
                      Reason: {viewingReq.rejectionReason}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {viewingReq.type === 'STOCK_AUDIT_RECONCILIATION' && onNavigateToStockAudit && (
                  <button
                    onClick={() => {
                      const bId = viewingReq.branchId || 'WH001';
                      const reqId = viewingReq.id;
                      setViewingReq(null);
                      onNavigateToStockAudit(bId, reqId);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
                  >
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    <span>Review in Stock Count Table</span>
                  </button>
                )}

                {viewingReq.status === 'PENDING' && canApprove && (
                  <>
                    <button
                      onClick={() => {
                        const target = viewingReq;
                        setViewingReq(null);
                        setApprovingReq(target);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Approve</span>
                    </button>
                    <button
                      onClick={() => {
                        const target = viewingReq;
                        setViewingReq(null);
                        setRejectingReq(target);
                        setRejectionReasonInput('');
                      }}
                      className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>Reject</span>
                    </button>
                  </>
                )}
                {viewingReq.status === 'PENDING' && onCancelApproval && canCancelApprovalRequest && (
                  <button
                    onClick={() => {
                      const target = viewingReq;
                      setViewingReq(null);
                      handleOpenCancelModal(target);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs flex items-center gap-1 cursor-pointer"
                    title="Cancel this pending approval request"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>Cancel Request</span>
                  </button>
                )}
              </div>
              <button
                onClick={() => setViewingReq(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold cursor-pointer hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal for Request Cancellation Confirmation */}
      {cancellingReq && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-md w-full border border-slate-200 dark:border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400 font-extrabold text-base">
              <AlertTriangle className="h-5 w-5" />
              <span>Cancel Request #{cancellingReq.requestNumber}</span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Are you sure you want to cancel this workflow approval request for{' '}
              <strong className="text-slate-900 dark:text-slate-100">
                {cancellingReq.type === 'CANCEL_TRANSFER' || cancellingReq.type === 'CANCEL_IN_TRANSIT_TRANSFER'
                  ? `Transfer #${cancellingReq.customerName || cancellingReq.deviceSerial}`
                  : cancellingReq.type === 'CANCEL_RECEIVE_TRANSFER'
                  ? `Transfer Reversal #${cancellingReq.customerName || cancellingReq.deviceSerial}`
                  : `${cancellingReq.customerName} (${cancellingReq.deviceSerial})`}
              </strong>
              ? Once cancelled, this ticket will be marked as <strong>CANCELLED</strong> and will no longer be pending.
            </p>

            <form onSubmit={handleConfirmCancel} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Cancellation Reason (Optional):
                </label>
                <textarea
                  rows={2}
                  value={cancelReasonInput}
                  onChange={(e) => setCancelReasonInput(e.target.value)}
                  placeholder="e.g. Request submitted in error or no longer required..."
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setCancellingReq(null)}
                  disabled={isProcessingId === cancellingReq.id}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  Keep Request
                </button>
                <button
                  type="submit"
                  disabled={isProcessingId === cancellingReq.id}
                  className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-extrabold shadow-md shadow-amber-600/20 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isProcessingId === cancellingReq.id ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Cancelling...</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Confirm & Cancel Request</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
