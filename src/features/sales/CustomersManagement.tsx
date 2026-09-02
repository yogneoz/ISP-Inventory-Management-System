import React, { useState, useEffect } from 'react';
import { CustomerDeviceRecord, CustomerRecord, Branch, Product, User, ApprovalRequest } from '../../types';
import { formatDualDate, convertADToBS, formatBSDate } from '../../utils/nepaliCalendar';
import { getWarrantyInfo } from '../../utils/warranty';
import { isOperationAllowed, getAllowedBranches } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { api } from '../../services/api';
import {
  Users,
  Search,
  Plus,
  Barcode,
  Wifi,
  MapPin,
  Phone,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  Building2,
  X,
  FileText,
  Tag,
  Clock,
  Tv,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  SlidersHorizontal,
  Send,
  Lock,
  ExternalLink,
  UserCheck,
  Download,
  FileSpreadsheet,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface CustomersManagementProps {
  customerDevices: CustomerDeviceRecord[];
  customers?: CustomerRecord[];
  branches: Branch[];
  products: Product[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  autoOpenModal?: boolean;
  currentUser?: User | null;
  isDarkMode?: boolean;
  approvalRequests?: ApprovalRequest[];
  onCreateCustomerDevice: (record: Omit<CustomerDeviceRecord, 'id'>) => Promise<void>;
  onUpdateStatus: (id: string, status: CustomerDeviceRecord['status']) => Promise<void>;
  onExchangeSuccess?: () => Promise<void>;
  onRequestApproval?: (request: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>) => Promise<void>;
  onCancelApproval?: (id: string) => Promise<void>;
  onNavigateToMaster?: () => void;
}

export const CustomersManagement: React.FC<CustomersManagementProps> = ({
  customerDevices = [],
  customers = [],
  branches = [],
  products = [],
  selectedBranchId,
  dateMode,
  autoOpenModal = false,
  currentUser,
  isDarkMode = false,
  approvalRequests = [],
  onCreateCustomerDevice,
  onUpdateStatus,
  onExchangeSuccess,
  onRequestApproval,
  onCancelApproval,
  onNavigateToMaster,
}) => {
  const canManageCustomers = isOperationAllowed('customers-manage', currentUser?.role);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [isModalOpen, setIsModalOpen] = useState(autoOpenModal);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [viewingRecord, setViewingRecord] = useState<CustomerDeviceRecord | null>(null);

  // Approval Request Modal State
  const [approvalTarget, setApprovalTarget] = useState<{
    record: CustomerDeviceRecord;
    targetStatus: CustomerDeviceRecord['status'];
  } | null>(null);
  const [approvalReason, setApprovalReason] = useState('');
  const [approvalRestock, setApprovalRestock] = useState(true);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Cancellation State
  const [cancellingRequestId, setCancellingRequestId] = useState<string | null>(null);
  const [confirmCancelTarget, setConfirmCancelTarget] = useState<{
    request: ApprovalRequest;
    record: CustomerDeviceRecord;
  } | null>(null);

  // Lookup helper for pending disconnect approval requests
  const getPendingDisconnectRequest = (rec: CustomerDeviceRecord): ApprovalRequest | undefined => {
    return (approvalRequests || []).find(
      (req) =>
        req.status === 'PENDING' &&
        (req.targetId === rec.id || req.deviceSerial === rec.deviceSerial) &&
        (req.requestedStatus === 'DISCONNECTED' || req.requestedStatus === 'ROUTER_COLLECTED')
    );
  };

  const handleCancelDisconnectRequest = (request: ApprovalRequest, record: CustomerDeviceRecord) => {
    setConfirmCancelTarget({ request, record });
  };

  const handleConfirmCancelApproval = async () => {
    if (!confirmCancelTarget) return;
    const { request, record } = confirmCancelTarget;
    setCancellingRequestId(request.id);
    try {
      if (onCancelApproval) {
        await onCancelApproval(request.id);
      } else {
        await api.cancelApprovalRequest(request.id, currentUser);
      }
      setToastMessage(`✓ Disconnect request #${request.requestNumber} for ${record.customerName} has been cancelled.`);
      setConfirmCancelTarget(null);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      alert(err?.message || 'Failed to cancel approval request.');
    } finally {
      setCancellingRequestId(null);
    }
  };

  // Device Exchange Modal State
  const [isExchangeModalOpen, setIsExchangeModalOpen] = useState(false);
  const [selectedDeviceForExchange, setSelectedDeviceForExchange] = useState<CustomerDeviceRecord | null>(null);
  const [exchangeReason, setExchangeReason] = useState<string>('Defective / Hardware Fault (No Power / Optical Loss)');
  const [oldDeviceAction, setOldDeviceAction] = useState<'DAMAGE' | 'RESTOCK' | 'DISPOSED'>('DAMAGE');
  const [exchangeProductName, setExchangeProductName] = useState<string>('');
  const [exchangeNewSerial, setExchangeNewSerial] = useState<string>('');
  const [exchangeNewPon, setExchangeNewPon] = useState<string>('');
  const [exchangeNewMac, setExchangeNewMac] = useState<string>('');
  const [exchangeNotes, setExchangeNotes] = useState<string>('');
  const [isSubmittingExchange, setIsSubmittingExchange] = useState<boolean>(false);

  const handleOpenExchangeModal = (record: CustomerDeviceRecord) => {
    setSelectedDeviceForExchange(record);
    setExchangeProductName(record.productName);
    setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`);
    setExchangeNewPon(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`);
    setExchangeNewMac('00:1A:2B:3C:4D:5E');
    setExchangeReason('Defective / Hardware Fault (No Power / Optical Loss)');
    setOldDeviceAction('DAMAGE');
    setExchangeNotes('');
    setIsExchangeModalOpen(true);
  };

  const handlePerformExchange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDeviceForExchange) return;
    if (!exchangeNewSerial.trim() || !exchangeNewPon.trim()) {
      alert('Please fill new device serial number and PON serial number.');
      return;
    }

    setIsSubmittingExchange(true);
    try {
      await api.exchangeCustomerDevice({
        oldDeviceId: selectedDeviceForExchange.id,
        exchangeReason,
        oldDeviceAction,
        newProductName: exchangeProductName || selectedDeviceForExchange.productName,
        newDeviceSerial: exchangeNewSerial.trim(),
        newPonSerial: exchangeNewPon.trim(),
        newMacAddress: exchangeNewMac.trim() || undefined,
        notes: exchangeNotes.trim() || undefined,
        branchId: selectedDeviceForExchange.branchId,
      });

      const customerName = selectedDeviceForExchange.customerName;
      const serial = exchangeNewSerial;
      setIsExchangeModalOpen(false);
      setSelectedDeviceForExchange(null);

      if (onExchangeSuccess) {
        await onExchangeSuccess();
      }
      setToastMessage(`✓ Device successfully exchanged for ${customerName}! New Serial: ${serial}`);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      alert(err?.message || 'Failed to perform device exchange.');
    } finally {
      setIsSubmittingExchange(false);
    }
  };

  const handleStatusChangeAttempt = async (
    rec: CustomerDeviceRecord,
    newSt: CustomerDeviceRecord['status']
  ) => {
    if (rec.status === newSt) return;

    const isDisconnect = newSt === 'DISCONNECTED' || newSt === 'ROUTER_COLLECTED';
    const targetSt = isDisconnect ? 'ROUTER_COLLECTED' : newSt;

    const requiresApproval = ['DISCONNECTED', 'ROUTER_COLLECTED', 'REFUND', 'RETURNED', 'IN_STOCK'].includes(
      newSt
    );
    const isBranchStaff =
      currentUser?.role === 'BRANCH_MANAGER' || currentUser?.role === 'FRONT_DESK';

    // Disconnect requests MUST always go through approval workflow to be set to Router Collected
    if (isDisconnect || (requiresApproval && isBranchStaff)) {
      setApprovalTarget({ record: rec, targetStatus: targetSt });
      setApprovalReason('');
      setApprovalRestock(isDisconnect || newSt === 'REFUND' || newSt === 'RETURNED' || newSt === 'IN_STOCK');
    } else {
      await onUpdateStatus(rec.id, newSt);
      setToastMessage(`Device status updated to ${newSt}.`);
      setTimeout(() => setToastMessage(null), 4000);
    }
  };

  const handleConfirmSubmitApproval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approvalTarget) return;
    if (!approvalReason.trim()) {
      alert('Please provide a justification / reason for this status change request.');
      return;
    }

    setIsSubmittingApproval(true);
    try {
      const branchName =
        branches.find((b) => b.id === approvalTarget.record.branchId)?.name || 'Branch Office';
      const reqData = {
        type: 'CUSTOMER_DEVICE_STATUS',
        targetId: approvalTarget.record.id,
        customerName: approvalTarget.record.customerName,
        customerCode: approvalTarget.record.customerCode,
        deviceSerial: approvalTarget.record.deviceSerial,
        ponSerial: approvalTarget.record.ponSerial,
        productName: approvalTarget.record.productName,
        currentStatus: approvalTarget.record.status,
        requestedStatus: approvalTarget.targetStatus,
        requestedByRole: currentUser?.role || 'FRONT_DESK',
        requestedByEmail: currentUser?.email || 'staff@example.com',
        requestedByName: currentUser?.name || 'Branch Staff',
        branchId: approvalTarget.record.branchId,
        branchName,
        reason: approvalReason.trim(),
        restockQtyOnApproval: approvalRestock,
      };

      if (onRequestApproval) {
        await onRequestApproval(reqData);
      } else {
        await api.createApprovalRequest(reqData);
      }

      setToastMessage(
        `Approval request submitted successfully! Request pending Inventory Manager / Super Admin authorization.`
      );
      setApprovalTarget(null);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      alert(`Failed to submit approval request: ${err.message}`);
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  // Modal Form State
  const [assignType, setAssignType] = useState<'RENTAL' | 'SOLD'>('RENTAL');
  const [customerName, setCustomerName] = useState('');
  const [customerCode, setCustomerCode] = useState(`CUST-${Math.floor(1000 + Math.random() * 9000)}`);
  const [contactPhone, setContactPhone] = useState('+977-98');
  const [installationAddress, setInstallationAddress] = useState('');
  const [branchId, setBranchId] = useState(
    selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || ''
  );

  // Sync branchId when branches load or selectedBranchId changes
  useEffect(() => {
    const allowed = getAllowedBranches(currentUser, branches);
    if (allowed.length > 0) {
      if (selectedBranchId !== 'ALL' && allowed.some((b) => b.id === selectedBranchId)) {
        setBranchId(selectedBranchId);
      } else if (!allowed.some((b) => b.id === branchId)) {
        setBranchId(allowed[0].id);
      }
    }
  }, [selectedBranchId, branches, currentUser]);
  const [productName, setProductName] = useState('ONU ROUTER 2.4G');
  const [deviceSerial, setDeviceSerial] = useState('');
  const [ponSerial, setPonSerial] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [issuedDateAD, setIssuedDateAD] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [purchaseBillRef, setPurchaseBillRef] = useState('BILL-9021');
  const [notes, setNotes] = useState('');

  const filteredRecords = customerDevices.filter((rec) => {
    const matchesBranch = selectedBranchId === 'ALL' || rec.branchId === selectedBranchId;
    let matchesStatus = selectedStatus === 'ALL';
    if (selectedStatus === 'RENTAL') {
      matchesStatus = rec.status === 'RENTAL' || rec.status === 'ACTIVE';
    } else if (selectedStatus === 'ROUTER_COLLECTED') {
      matchesStatus = rec.status === 'ROUTER_COLLECTED' || rec.status === 'DISCONNECTED';
    } else if (selectedStatus !== 'ALL') {
      matchesStatus = rec.status === selectedStatus;
    }
    
    if (!searchQuery.trim()) return matchesBranch && matchesStatus;

    const q = (searchQuery || '').toLowerCase().trim();
    const matchesQuery =
      (rec?.deviceSerial || '').toLowerCase().includes(q) ||
      (rec?.ponSerial || '').toLowerCase().includes(q) ||
      (rec.macAddress && (rec?.macAddress || '').toLowerCase().includes(q)) ||
      (rec?.customerName || '').toLowerCase().includes(q) ||
      (rec?.customerCode || '').toLowerCase().includes(q) ||
      (rec?.contactPhone || '').toLowerCase().includes(q) ||
      (rec?.productName || '').toLowerCase().includes(q) ||
      (rec.purchaseBillRef && (rec?.purchaseBillRef || '').toLowerCase().includes(q));

    return matchesBranch && matchesStatus && matchesQuery;
  });

  const recordsPagination = useClientPagination(filteredRecords, 15, [searchQuery, selectedBranchId, selectedStatus]);

  // Metrics
  const rentalCount = customerDevices.filter((c) => c.status === 'RENTAL' || c.status === 'ACTIVE').length;
  const soldCount = customerDevices.filter((c) => c.status === 'SOLD').length;
  const routerCollectedCount = customerDevices.filter((c) => c.status === 'ROUTER_COLLECTED' || c.status === 'DISCONNECTED').length;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const handleExportCSV = () => {
    const branchName =
      selectedBranchId === 'ALL'
        ? 'All Branches (Consolidated)'
        : branches.find((b) => b.id === selectedBranchId)?.name || `Branch ${selectedBranchId}`;

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
      { key: 'productName', label: 'Product / Model Name' },
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
      { key: 'customerName', label: 'Customer / Holder Name' },
      { key: 'customerCode', label: 'Customer Code' },
      { key: 'contactPhone', label: 'Contact Phone' },
      { key: 'installationAddress', label: 'Installation Address' },
      { key: 'purchaseBillRef', label: 'Purchase Bill Ref', formatter: (val: string) => val || '-' },
      { key: 'notes', label: 'Notes', formatter: (val: string) => val || '-' },
    ];

    exportToCSV({
      filename: `Customer_Device_Serials_${selectedBranchId}`,
      reportTitle: `Customer Hardware Devices & Serial Numbers Lookup Report (${selectedStatus})`,
      branchName,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || 'System User',
      data: filteredRecords,
      columns,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim() || !deviceSerial.trim() || !ponSerial.trim()) {
      alert('Please fill customer name, device serial number, and PON serial number.');
      return;
    }

    const dateBSObj = convertADToBS(issuedDateAD);

    await onCreateCustomerDevice({
      customerId: `c-${Date.now()}`,
      customerName,
      customerCode,
      contactPhone,
      installationAddress,
      branchId,
      productName,
      deviceSerial,
      ponSerial,
      macAddress: macAddress.trim() || undefined,
      status: assignType,
      issuedDateAD,
      issuedDateBS: dateBSObj.formattedBSShort,
      purchaseBillRef: purchaseBillRef.trim() || undefined,
      notes: notes.trim() || undefined,
    });

    setIsModalOpen(false);
  };

  return (
    <div className="space-y-3">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 break-words leading-tight ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <Wifi className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>Customer Hardware Directory & Serial Number Lookup</span>
          </h2>
          <p className={`truncate text-xs mt-1 break-words leading-normal max-w-3xl ${
            isDarkMode ? 'text-slate-400' : 'text-slate-500'
          }`}>
            Lookup router, ONU, or set-top box devices by Device Serial, PON Serial, MAC address, or Customer name.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2.5">
          <button
            onClick={handleExportCSV}
            className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold border transition-all cursor-pointer shadow-xs ${
              isDarkMode
                ? 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700 hover:text-white'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <Download className="h-4 w-4 text-blue-500" />
            <span>Export CSV ({filteredRecords.length})</span>
          </button>

          {canManageCustomers && (
            <button
              onClick={() => {
                setAssignType('RENTAL');
                setCustomerCode(`CUST-${Math.floor(1000 + Math.random() * 9000)}`);
                setDeviceSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`);
                setPonSerial(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`);
                setIsModalOpen(true);
              }}
              className="flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-blue-600/20 cursor-pointer transition-all shrink-0"
            >
              <Plus className="h-4 w-4" />
              <span>Assign Customer Device</span>
            </button>
          )}
        </div>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className={`rounded-2xl p-4 border shadow-xs transition-colors ${
          isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
        }`}>
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Tracked Serials</div>
          <div className="text-xl font-mono font-bold mt-1 text-slate-900 dark:text-white">
            {customerDevices.length} Devices
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors ${
          isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-blue-50/20 border-blue-200'
        }`}>
          <div className={`text-xs font-semibold ${isDarkMode ? 'text-blue-400' : 'text-blue-800'}`}>
            Rental Products (CPE)
          </div>
          <div className={`text-xl font-mono font-extrabold mt-1 ${isDarkMode ? 'text-blue-400' : 'text-blue-700'}`}>
            {rentalCount} Rental
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors ${
          isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-purple-50/20 border-purple-200'
        }`}>
          <div className={`text-xs font-semibold ${isDarkMode ? 'text-purple-400' : 'text-purple-800'}`}>
            Sold Products (Customer)
          </div>
          <div className={`text-xl font-mono font-extrabold mt-1 ${isDarkMode ? 'text-purple-400' : 'text-purple-700'}`}>
            {soldCount} Sold
          </div>
        </div>

        <div className={`rounded-2xl p-4 border shadow-xs transition-colors ${
          isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-rose-50/20 border-rose-200'
        }`}>
          <div className={`text-xs font-semibold ${isDarkMode ? 'text-rose-400' : 'text-rose-800'}`}>
            Router Collected (Restocked)
          </div>
          <div className={`text-xl font-mono font-extrabold mt-1 ${isDarkMode ? 'text-rose-400' : 'text-rose-700'}`}>
            {routerCollectedCount} Collected
          </div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className={`p-3 rounded-2xl border shadow-xs flex flex-col md:flex-row md:items-center justify-start gap-3 ${
        isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}>
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-blue-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="🔍 Instant Lookup by Device Serial (e.g. SN-ONU24G-881923), PON Serial, MAC, Customer, Phone..."
            className={`w-full pl-10 pr-4 py-2.5 text-xs font-medium border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
              isDarkMode
                ? 'bg-slate-800 border-slate-700 text-white placeholder-slate-500'
                : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
            }`}
          />
        </div>

        <div className="flex items-center gap-3">
          <span className={`text-xs font-bold uppercase tracking-wider ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Status:
          </span>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className={`rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              isDarkMode
                ? 'bg-slate-800 border-slate-700 text-white'
                : 'bg-white border-slate-200 text-slate-700'
            }`}
          >
            <option value="ALL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100">All Statuses</option>
            <option value="RENTAL" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-blue-400">RENTAL (Rental Product)</option>
            <option value="SOLD" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-purple-400">SOLD (Sold Product)</option>
            <option value="ROUTER_COLLECTED" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-rose-400">ROUTER COLLECTED (Disconnected)</option>
            <option value="EXCHANGED" className="bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-400">EXCHANGED</option>
          </select>
        </div>
      </div>

      {/* Customer & Serial Number Table */}
      <div className={`rounded-2xl border shadow-xs overflow-hidden ${
        isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
      }`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={`font-bold text-[10px] tracking-wider border-b ${
              isDarkMode ? 'bg-slate-800/80 text-slate-400 border-slate-800' : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}>
              <tr>
                <th className="px-2.5 py-1.5 break-words">Customer & Account</th>
                <th className="px-2.5 py-1.5 break-words">Branch & Address</th>
                <th className="px-2.5 py-1.5 break-words">Hardware Item</th>
                <th className="px-2.5 py-1.5 break-words">Device Serial #</th>
                <th className="px-2.5 py-1.5 break-words">PON Serial #</th>
                <th className="px-2.5 py-1.5 break-words">Issued Date</th>
                <th className="px-2.5 py-1.5 text-center break-words">Warranty Status</th>
                <th className="px-2.5 py-1.5 text-center break-words">Device Status & Stock Sync</th>
                <th className="px-2.5 py-1.5 text-center break-words">Action</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400 text-xs break-words">
                    No matching customer devices found. Use the search bar above to query Device Serial or PON Serial numbers.
                  </td>
                </tr>
              ) : (
                recordsPagination.pagedItems.map((rec) => {
                  const branch = branches.find((b) => b.id === rec.branchId);
                  const wInfo = getWarrantyInfo(rec.issuedDateAD, rec.warrantyMonths || 12);
                  const pendingDisconnect = getPendingDisconnectRequest(rec);
                  return (
                    <tr key={rec.id} className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/50 text-slate-200' : 'hover:bg-blue-50/40 text-slate-800'
                    }`}>
                      <td className="p-2.5">
                        <div className={`font-bold text-sm break-words leading-snug ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                          {rec.customerName}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 flex items-center gap-2 mt-0.5 break-words">
                          <span className="text-blue-600 dark:text-blue-400 font-semibold">{rec.customerCode}</span>
                          <span className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
                            <Phone className="h-3 w-3 shrink-0" /> {rec.contactPhone}
                          </span>
                        </div>
                      </td>

                      <td className="p-2.5">
                        <div className={`font-bold text-xs break-words ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                          {branch?.name || rec.branchId}
                        </div>
                        <div className="text-slate-500 dark:text-slate-400 text-[11px] flex items-center gap-1 mt-0.5 break-words">
                          <MapPin className="h-3 w-3 text-slate-400 shrink-0" />
                          <span>{rec.installationAddress}</span>
                        </div>
                      </td>

                      <td className="p-2.5">
                        <span className={`font-bold px-2 py-1 rounded-lg text-xs inline-block break-words border ${
                          isDarkMode
                            ? 'bg-slate-800 text-slate-200 border-slate-700'
                            : 'bg-slate-100 text-slate-900 border-slate-200'
                        }`}>
                          {rec.productName}
                        </span>
                        {rec.purchaseBillRef && (
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono mt-1 break-words">
                            Bill Ref: <strong className={isDarkMode ? 'text-slate-300' : 'text-slate-700'}>{rec.purchaseBillRef}</strong>
                          </div>
                        )}
                      </td>

                      {/* Device Serial Number */}
                      <td className="p-2.5">
                        <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1 w-fit ${
                          isDarkMode ? 'bg-blue-950/60 border-blue-800' : 'bg-blue-50 border-blue-200'
                        }`}>
                          <Barcode className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                          <span className={`font-mono font-extrabold text-xs select-all break-all ${
                            isDarkMode ? 'text-blue-300' : 'text-blue-900'
                          }`}>
                            {rec.deviceSerial}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(rec.deviceSerial)}
                            title="Copy Device Serial"
                            className="p-0.5 text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 cursor-pointer ml-1 shrink-0"
                          >
                            {copiedText === rec.deviceSerial ? (
                              <Check className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                        {rec.macAddress && (
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5 break-all">
                            MAC: {rec.macAddress}
                          </div>
                        )}
                      </td>

                      {/* PON Serial Number */}
                      <td className="p-2.5">
                        <div className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1 w-fit ${
                          isDarkMode ? 'bg-indigo-950/60 border-indigo-800' : 'bg-indigo-50 border-indigo-200'
                        }`}>
                          <Wifi className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                          <span className={`font-mono font-extrabold text-xs select-all break-all ${
                            isDarkMode ? 'text-indigo-300' : 'text-indigo-900'
                          }`}>
                            {rec.ponSerial}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(rec.ponSerial)}
                            title="Copy PON Serial"
                            className="p-0.5 text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 cursor-pointer ml-1 shrink-0"
                          >
                            {copiedText === rec.ponSerial ? (
                              <Check className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      <td className="p-2.5 font-mono text-[11px] text-slate-500 dark:text-slate-400 break-words">
                        {formatDualDate(rec.issuedDateAD, dateMode)}
                      </td>

                      {/* Warranty Status Column */}
                      <td className="p-2.5 text-center">
                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase border whitespace-normal break-words max-w-[130px] text-center justify-center ${
                          wInfo.status === 'VALID'
                            ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                            : wInfo.status === 'EXPIRING_SOON'
                            ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                            : 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                        }`}>
                          {wInfo.status === 'VALID' && <ShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                          {wInfo.status === 'EXPIRING_SOON' && <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />}
                          {wInfo.status === 'EXPIRED' && <ShieldAlert className="h-3 w-3 text-rose-600 dark:text-rose-400 shrink-0" />}
                          <span>{wInfo.label}</span>
                        </div>
                      </td>

                      {/* Device Status & Disconnect Date */}
                      <td className="p-2.5 text-center">
                        <div className="flex flex-col items-center gap-1">
                          <span
                            className={`px-2.5 py-1 text-[10px] font-extrabold uppercase rounded-xl border shadow-2xs ${
                              rec.status === 'ACTIVE' || rec.status === 'RENTAL'
                                ? 'bg-blue-100 dark:bg-blue-950/80 text-blue-800 dark:text-blue-300 border-blue-300 dark:border-blue-800'
                                : rec.status === 'SOLD'
                                ? 'bg-purple-100 dark:bg-purple-950/80 text-purple-800 dark:text-purple-300 border-purple-300 dark:border-purple-800'
                                : rec.status === 'ROUTER_COLLECTED' || rec.status === 'DISCONNECTED'
                                ? 'bg-rose-100 dark:bg-rose-950/80 text-rose-800 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700'
                            }`}
                          >
                            {rec.status === 'ACTIVE' || rec.status === 'RENTAL' 
                              ? '🔵 Rental (CPE Asset)' 
                              : rec.status === 'SOLD' 
                              ? '🛍️ Sold (Customer Owned)' 
                              : rec.status === 'ROUTER_COLLECTED' || rec.status === 'DISCONNECTED'
                              ? '📦 Router Collected' 
                              : rec.status === 'EXCHANGED' 
                              ? '🔄 Exchanged' 
                              : rec.status}
                          </span>

                          {pendingDisconnect && (
                            <div className="inline-flex flex-col items-center gap-0.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-amber-100 dark:bg-amber-950/90 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 animate-pulse">
                                <Clock className="h-2.5 w-2.5 shrink-0" />
                                <span>Disconnect Pending</span>
                              </span>
                              <span className="text-[9px] font-mono font-bold text-amber-600 dark:text-amber-400">
                                {pendingDisconnect.requestNumber}
                              </span>
                            </div>
                          )}

                          {(rec.status === 'ROUTER_COLLECTED' || rec.status === 'DISCONNECTED') && (
                            <div className="text-[10px] font-mono text-rose-700 dark:text-rose-400 font-semibold mt-0.5 whitespace-nowrap">
                              Disc: {rec.disconnectedDateAD || 'Collected'} {rec.disconnectedDateBS ? `(${rec.disconnectedDateBS})` : ''}
                            </div>
                          )}
                        </div>
                      </td>

                      <td className="p-2.5 text-center">
                        <div className="flex items-center justify-center gap-1.5 flex-wrap min-w-[140px]">
                          <button
                            onClick={() => setViewingRecord(rec)}
                            className={`px-2.5 py-1 text-[11px] font-bold rounded-lg border cursor-pointer ${
                              isDarkMode
                                ? 'text-blue-400 border-blue-800 hover:bg-blue-950/50'
                                : 'text-blue-600 border-blue-200 hover:bg-blue-100'
                            }`}
                          >
                            Details
                          </button>

                          {(rec.status === 'ACTIVE' || rec.status === 'RENTAL' || rec.status === 'SOLD') && (
                            <button
                              onClick={() => handleOpenExchangeModal(rec)}
                              title="Perform Hardware Warranty Exchange for this device"
                              className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs cursor-pointer flex items-center gap-1"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>Exchange</span>
                            </button>
                          )}

                          {(rec.status === 'ACTIVE' || rec.status === 'RENTAL') && (
                            pendingDisconnect ? (
                              <button
                                onClick={() => handleCancelDisconnectRequest(pendingDisconnect, rec)}
                                disabled={cancellingRequestId === pendingDisconnect.id}
                                title={`Cancel pending disconnect approval request #${pendingDisconnect.requestNumber}`}
                                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white shadow-xs border border-amber-600/30 cursor-pointer disabled:opacity-50 transition-all"
                              >
                                <XCircle className="h-3.5 w-3.5 shrink-0" />
                                <span>{cancellingRequestId === pendingDisconnect.id ? 'Cancelling...' : 'Cancel Request'}</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => handleStatusChangeAttempt(rec, 'ROUTER_COLLECTED')}
                                title="Request Disconnect: Send for approval to set status to Router Collected and add stock to branch inventory"
                                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-rose-600 hover:bg-rose-500 text-white shadow-xs cursor-pointer"
                              >
                                <Lock className="h-3 w-3" />
                                <span>Disconnect Request</span>
                              </button>
                            )
                          )}

                          {(rec.status === 'ROUTER_COLLECTED' || rec.status === 'DISCONNECTED') && (
                            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-md border border-emerald-200 dark:border-emerald-800">
                              ✓ Collected & Restocked
                            </span>
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
          page={recordsPagination.page}
          pageCount={recordsPagination.pageCount}
          totalItems={recordsPagination.totalItems}
          rangeStart={recordsPagination.rangeStart}
          rangeEnd={recordsPagination.rangeEnd}
          pageSize={recordsPagination.pageSize}
          onPageChange={recordsPagination.setPage}
          onPageSizeChange={recordsPagination.setPageSize}
          isDarkMode={isDarkMode}
          className="mt-1"
        />
      </div>

      {/* Customer Record Detail Modal */}
      {viewingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-xl rounded-2xl shadow-2xl border overflow-hidden ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className={`flex items-center justify-between border-b p-4 ${
              isDarkMode ? 'border-slate-800 bg-slate-900/80' : 'border-slate-200 bg-slate-50'
            }`}>
              <h3 className={`font-bold text-sm flex items-center gap-2 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                <Wifi className="h-4 w-4 text-blue-500" />
                <span>Customer Hardware Deployment Details</span>
              </h3>
              <button
                onClick={() => setViewingRecord(null)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className={`p-4 rounded-xl border flex justify-between items-center ${
                isDarkMode ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-50 border-slate-200'
              }`}>
                <div>
                  <div className={`text-base font-extrabold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                    {viewingRecord.customerName}
                  </div>
                  <div className="text-xs text-blue-500 dark:text-blue-400 font-mono font-bold mt-0.5">
                    Account: {viewingRecord.customerCode} | Phone: {viewingRecord.contactPhone}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-slate-400" />
                    <span>{viewingRecord.installationAddress}</span>
                  </div>
                </div>

                <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                  viewingRecord.status === 'ACTIVE' || viewingRecord.status === 'RENTAL'
                    ? 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300'
                    : viewingRecord.status === 'SOLD'
                    ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300'
                    : viewingRecord.status === 'ROUTER_COLLECTED' || viewingRecord.status === 'DISCONNECTED'
                    ? 'bg-rose-100 dark:bg-rose-950 text-rose-800 dark:text-rose-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-300'
                }`}>
                  {viewingRecord.status === 'ACTIVE' || viewingRecord.status === 'RENTAL' ? 'Rental (CPE Asset)' : viewingRecord.status === 'SOLD' ? 'Sold (Customer Owned)' : viewingRecord.status === 'ROUTER_COLLECTED' || viewingRecord.status === 'DISCONNECTED' ? 'Router Collected (Disconnected)' : viewingRecord.status}
                </span>
              </div>

              {/* Pending Disconnect Approval Notice if applicable */}
              {(() => {
                const viewingPending = getPendingDisconnectRequest(viewingRecord);
                if (!viewingPending) return null;
                return (
                  <div className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700 flex items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <div className="p-1.5 rounded-lg bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 shrink-0 mt-0.5">
                        <Clock className="h-4 w-4 animate-spin" />
                      </div>
                      <div>
                        <div className="font-extrabold text-amber-900 dark:text-amber-200 text-xs">
                          Disconnect Approval Request Pending ({viewingPending.requestNumber})
                        </div>
                        <div className="text-[11px] text-amber-800 dark:text-amber-300 mt-0.5">
                          <strong>Requested by:</strong> {viewingPending.requestedByName} ({viewingPending.requestedByRole})<br />
                          <strong>Reason:</strong> {viewingPending.reason}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const req = viewingPending;
                        const rec = viewingRecord;
                        setViewingRecord(null);
                        handleCancelDisconnectRequest(req, rec);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs flex items-center gap-1 shadow-xs cursor-pointer shrink-0"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Cancel Request</span>
                    </button>
                  </div>
                );
              })()}

              {/* Serials Card */}
              <div className="grid grid-cols-2 gap-3">
                <div className={`p-3.5 rounded-xl border ${
                  isDarkMode ? 'bg-blue-950/40 border-blue-800/80' : 'bg-blue-50/80 border-blue-200'
                }`}>
                  <span className={`text-[10px] font-bold uppercase tracking-wider block ${
                    isDarkMode ? 'text-blue-300' : 'text-blue-700'
                  }`}>
                    Device Serial Number
                  </span>
                  <div className={`text-sm font-mono font-extrabold mt-1 select-all ${
                    isDarkMode ? 'text-blue-200' : 'text-blue-900'
                  }`}>
                    {viewingRecord.deviceSerial}
                  </div>
                  <div className="text-[10px] text-blue-500 mt-0.5">Physical Barcode Label</div>
                </div>

                <div className={`p-3.5 rounded-xl border ${
                  isDarkMode ? 'bg-indigo-950/40 border-indigo-800/80' : 'bg-indigo-50/80 border-indigo-200'
                }`}>
                  <span className={`text-[10px] font-bold uppercase tracking-wider block ${
                    isDarkMode ? 'text-indigo-300' : 'text-indigo-700'
                  }`}>
                    PON Serial Number
                  </span>
                  <div className={`text-sm font-mono font-extrabold mt-1 select-all ${
                    isDarkMode ? 'text-indigo-200' : 'text-indigo-900'
                  }`}>
                    {viewingRecord.ponSerial}
                  </div>
                  <div className="text-[10px] text-indigo-500 mt-0.5">Optical Line Terminal ID</div>
                </div>
              </div>

              <div className={`p-3.5 rounded-xl border space-y-2 ${
                isDarkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200'
              }`}>
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>Device Hardware Model:</span>
                  <span className={`font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{viewingRecord.productName}</span>
                </div>
                {viewingRecord.macAddress && (
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>MAC Address:</span>
                    <span className={`font-mono font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{viewingRecord.macAddress}</span>
                  </div>
                )}
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>Assigned Branch:</span>
                  <span className={`font-bold ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{branches.find(b => b.id === viewingRecord.branchId)?.name || viewingRecord.branchId}</span>
                </div>
                <div className="flex justify-between text-slate-500 dark:text-slate-400">
                  <span>Issued Date:</span>
                  <span className="font-mono font-bold">{viewingRecord.issuedDateAD} ({viewingRecord.issuedDateBS})</span>
                </div>
                {(viewingRecord.status === 'ROUTER_COLLECTED' || viewingRecord.status === 'DISCONNECTED' || viewingRecord.disconnectedDateAD) && (
                  <div className="flex justify-between text-rose-600 dark:text-rose-400 font-semibold p-2 rounded-lg bg-rose-50/80 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800">
                    <span>Disconnected Date:</span>
                    <span className="font-mono font-extrabold text-rose-700 dark:text-rose-300">
                      {viewingRecord.disconnectedDateAD || 'Collected'} {viewingRecord.disconnectedDateBS ? `(${viewingRecord.disconnectedDateBS})` : ''}
                    </span>
                  </div>
                )}
                {viewingRecord.purchaseBillRef && (
                  <div className="flex justify-between text-slate-500 dark:text-slate-400">
                    <span>Origin Purchase Bill #:</span>
                    <span className="font-mono font-bold text-blue-500">{viewingRecord.purchaseBillRef}</span>
                  </div>
                )}
              </div>

              {viewingRecord.notes && (
                <div className={`p-3 rounded-xl border text-xs ${
                  isDarkMode ? 'bg-amber-950/40 border-amber-800 text-amber-200' : 'bg-amber-50/60 border-amber-200 text-amber-900'
                }`}>
                  <strong className="block font-bold mb-0.5">Technical Notes:</strong>
                  {viewingRecord.notes}
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2">
                {(viewingRecord.status === 'ACTIVE' || viewingRecord.status === 'RENTAL' || viewingRecord.status === 'SOLD') && (
                  <button
                    type="button"
                    onClick={() => {
                      const rec = viewingRecord;
                      setViewingRecord(null);
                      handleOpenExchangeModal(rec);
                    }}
                    className="rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-xs"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Exchange Device</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setViewingRecord(null)}
                  className="rounded-xl bg-blue-600 text-white px-5 py-2 text-xs font-bold hover:bg-blue-700 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Assign Customer Device Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
          <div className={`w-full max-w-lg rounded-2xl shadow-2xl border overflow-hidden my-8 ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className={`flex items-center justify-between border-b p-4 ${
              isDarkMode ? 'border-slate-800 bg-slate-900/90' : 'border-slate-200 bg-slate-50'
            }`}>
              <h3 className={`font-bold text-sm flex items-center gap-2 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                <Wifi className="h-4 w-4 text-blue-500" />
                <span>Assign Customer Device (Device & PON Serial Entry)</span>
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
              {/* Product Classification / Ownership Selection */}
              <div>
                <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1.5 ${
                  isDarkMode ? 'text-slate-300' : 'text-slate-700'
                }`}>
                  Device Assignment Type & Ownership *
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setAssignType('RENTAL')}
                    className={`p-2.5 rounded-xl border text-left flex items-start gap-2 cursor-pointer transition-all ${
                      assignType === 'RENTAL'
                        ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-950/60 ring-2 ring-blue-500/20'
                        : isDarkMode
                        ? 'border-slate-700 bg-slate-800/60 text-slate-400'
                        : 'border-slate-200 bg-slate-50 text-slate-600'
                    }`}
                  >
                    <div className={`mt-0.5 h-3.5 w-3.5 rounded-full border flex items-center justify-center ${
                      assignType === 'RENTAL' ? 'border-blue-600 bg-blue-600' : 'border-slate-400'
                    }`}>
                      {assignType === 'RENTAL' && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </div>
                    <div>
                      <div className={`font-bold text-xs ${assignType === 'RENTAL' ? 'text-blue-900 dark:text-blue-200' : 'text-slate-700 dark:text-slate-300'}`}>
                        Rental Product (CPE Asset)
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">
                        Company-owned asset. Subject to disconnect approval & router return.
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAssignType('SOLD')}
                    className={`p-2.5 rounded-xl border text-left flex items-start gap-2 cursor-pointer transition-all ${
                      assignType === 'SOLD'
                        ? 'border-purple-500 bg-purple-50/80 dark:bg-purple-950/60 ring-2 ring-purple-500/20'
                        : isDarkMode
                        ? 'border-slate-700 bg-slate-800/60 text-slate-400'
                        : 'border-slate-200 bg-slate-50 text-slate-600'
                    }`}
                  >
                    <div className={`mt-0.5 h-3.5 w-3.5 rounded-full border flex items-center justify-center ${
                      assignType === 'SOLD' ? 'border-purple-600 bg-purple-600' : 'border-slate-400'
                    }`}>
                      {assignType === 'SOLD' && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </div>
                    <div>
                      <div className={`font-bold text-xs ${assignType === 'SOLD' ? 'text-purple-900 dark:text-purple-200' : 'text-slate-700 dark:text-slate-300'}`}>
                        Sold Product (Customer Owned)
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">
                        Customer owns device. No return required upon service disconnection.
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              {/* Optional Auto-fill from Customer Master Directory */}
              {customers.length > 0 && (
                <div className={`p-3 rounded-xl border ${
                  isDarkMode ? 'bg-indigo-950/50 border-indigo-800' : 'bg-indigo-50/80 border-indigo-200'
                }`}>
                  <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 flex items-center justify-between ${
                    isDarkMode ? 'text-indigo-300' : 'text-indigo-900'
                  }`}>
                    <span className="flex items-center gap-1">
                      <UserCheck className="h-3.5 w-3.5 text-indigo-500" />
                      Auto-fill from Customer Master Directory
                    </span>
                    {onNavigateToMaster && (
                      <button
                        type="button"
                        onClick={onNavigateToMaster}
                        className="text-[10px] text-indigo-500 hover:underline flex items-center gap-0.5 cursor-pointer font-semibold"
                      >
                        Master Directory <ExternalLink className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </label>
                  <select
                    onChange={(e) => {
                      const selectedId = e.target.value;
                      if (!selectedId) return;
                      const cust = customers.find((c) => c.id === selectedId || c.customerId === selectedId);
                      if (cust) {
                        setCustomerName(cust.customerName);
                        setCustomerCode(cust.customerId || cust.id);
                        setContactPhone(cust.contactNumber || '');
                        if (cust.branchId) setBranchId(cust.branchId);
                        if (cust.address) setInstallationAddress(cust.address);
                      }
                    }}
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs font-semibold focus:ring-2 focus:ring-indigo-500 ${
                      isDarkMode
                        ? 'bg-slate-800 border-slate-700 text-indigo-200'
                        : 'bg-white border-indigo-300 text-indigo-900'
                    }`}
                  >
                    <option value="">-- Choose Existing Customer Profile --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.customerName} ({c.customerId || c.id}) - {c.contactNumber}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                    isDarkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    Customer Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="e.g. Aashish Subedi"
                    className={`w-full rounded-xl border px-3 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  />
                </div>

                <div>
                  <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                    isDarkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    Account / Code
                  </label>
                  <input
                    type="text"
                    required
                    value={customerCode}
                    onChange={(e) => setCustomerCode(e.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 text-xs font-mono font-bold focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode ? 'bg-slate-800 border-slate-700 text-blue-400' : 'bg-white border-slate-300 text-blue-700'
                    }`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                    isDarkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    Contact Phone *
                  </label>
                  <input
                    type="text"
                    required
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 text-xs font-semibold focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  />
                </div>

                <div>
                  <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                    isDarkMode ? 'text-slate-300' : 'text-slate-600'
                  }`}>
                    Serving Branch
                  </label>
                  <select
                    value={branchId}
                    onChange={(e) => setBranchId(e.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500 ${
                      isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                    }`}
                  >
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                  isDarkMode ? 'text-slate-300' : 'text-slate-600'
                }`}>
                  Installation Address *
                </label>
                <input
                  type="text"
                  required
                  value={installationAddress}
                  onChange={(e) => setInstallationAddress(e.target.value)}
                  placeholder="e.g. Example Street, Example City"
                  className={`w-full rounded-xl border px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 ${
                    isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                  }`}
                />
              </div>

              <div>
                <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 ${
                  isDarkMode ? 'text-slate-300' : 'text-slate-600'
                }`}>
                  Device Hardware Model
                </label>
                <select
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className={`w-full rounded-xl border px-3 py-2 text-xs font-bold focus:ring-2 focus:ring-blue-500 ${
                    isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'
                  }`}
                >
                  <option value="ONU ROUTER 2.4G">ONU ROUTER 2.4G</option>
                  <option value="ONU ROUTER 5G">ONU ROUTER 5G</option>
                  <option value="IP TV SETUP BOX">IP TV SETUP BOX</option>
                  <option value="SWITCH (HUAWEI S6700-24-EI)-FA">SWITCH (HUAWEI S6700-24-EI)</option>
                  <option value="MIKROTIK HEX RB750Gr3">MIKROTIK HEX RB750Gr3</option>
                </select>
              </div>

              {/* Highlighted Serial Inputs */}
              <div className={`p-4 rounded-xl border space-y-3 ${
                isDarkMode ? 'bg-blue-950/40 border-blue-800/80' : 'bg-blue-50/70 border-blue-200'
              }`}>
                <span className={`text-xs font-bold block flex items-center gap-1 ${
                  isDarkMode ? 'text-blue-300' : 'text-blue-900'
                }`}>
                  <Barcode className="h-4 w-4 text-blue-500" />
                  Hardware Device Identification Numbers
                </span>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${
                      isDarkMode ? 'text-blue-300' : 'text-blue-800'
                    }`}>
                      Device Serial Number *
                    </label>
                    <input
                      type="text"
                      required
                      value={deviceSerial}
                      onChange={(e) => setDeviceSerial(e.target.value)}
                      placeholder="e.g. SN-ONU24G-881923"
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs font-extrabold focus:ring-2 focus:ring-blue-500 ${
                        isDarkMode
                          ? 'bg-slate-800 border-blue-700 text-blue-200'
                          : 'bg-white border-blue-300 text-blue-900'
                      }`}
                    />
                  </div>

                  <div>
                    <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${
                      isDarkMode ? 'text-indigo-300' : 'text-indigo-800'
                    }`}>
                      PON Serial Number *
                    </label>
                    <input
                      type="text"
                      required
                      value={ponSerial}
                      onChange={(e) => setPonSerial(e.target.value)}
                      placeholder="e.g. HWTC-90A812C4"
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs font-extrabold focus:ring-2 focus:ring-indigo-500 ${
                        isDarkMode
                          ? 'bg-slate-800 border-indigo-700 text-indigo-200'
                          : 'bg-white border-indigo-300 text-indigo-900'
                      }`}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      MAC Address (Optional)
                    </label>
                    <input
                      type="text"
                      value={macAddress}
                      onChange={(e) => setMacAddress(e.target.value)}
                      placeholder="e.g. 70:A8:E3:4B:91:10"
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs ${
                        isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-800'
                      }`}
                    />
                  </div>

                  <div>
                    <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${
                      isDarkMode ? 'text-slate-400' : 'text-slate-600'
                    }`}>
                      Vendor Purchase Bill Ref
                    </label>
                    <input
                      type="text"
                      value={purchaseBillRef}
                      onChange={(e) => setPurchaseBillRef(e.target.value)}
                      placeholder="e.g. BILL-9021"
                      className={`w-full rounded-lg border px-2.5 py-1.5 font-mono text-xs ${
                        isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-800'
                      }`}
                    />
                  </div>
                </div>
              </div>

              <div className={`pt-2 flex items-center justify-end gap-3 border-t ${
                isDarkMode ? 'border-slate-800' : 'border-slate-200'
              }`}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className={`rounded-xl border px-4 py-2 text-xs font-semibold cursor-pointer ${
                    isDarkMode
                      ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-blue-600 hover:bg-blue-700 px-5 py-2 text-xs font-bold text-white shadow-md shadow-blue-600/20 cursor-pointer"
                >
                  Save Device Record
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md bg-slate-900 text-white p-4 rounded-2xl shadow-2xl border border-slate-700 flex items-start gap-3 animate-slide-up">
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-xs leading-relaxed font-medium">
            {toastMessage}
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Trigger Approval Request Modal */}
      {approvalTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-xl w-full border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="p-5 bg-gradient-to-r from-amber-500 to-amber-600 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-white/20 rounded-xl">
                  <Lock className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base">Send Approval Request</h3>
                  <p className="text-amber-100 text-xs">
                    Workflow Authorization: Branch Staff ➔ Inventory Manager / Super Admin
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setApprovalTarget(null)}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmSubmitApproval} className="p-6 space-y-4">
              <div className={`p-3.5 rounded-2xl border text-xs flex items-start gap-2.5 ${
                approvalTarget.targetStatus === 'ROUTER_COLLECTED' || approvalTarget.targetStatus === 'DISCONNECTED'
                  ? 'bg-rose-50/90 border-rose-200 text-rose-950 dark:bg-rose-950/40 dark:border-rose-800 dark:text-rose-200'
                  : 'bg-amber-50/80 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200'
              }`}>
                <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${
                  approvalTarget.targetStatus === 'ROUTER_COLLECTED' || approvalTarget.targetStatus === 'DISCONNECTED'
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`} />
                <div>
                  {approvalTarget.targetStatus === 'ROUTER_COLLECTED' || approvalTarget.targetStatus === 'DISCONNECTED' ? (
                    <span>
                      <strong>Disconnect & Collection Workflow:</strong> Disconnecting a customer router will not immediately disconnect the device. A formal request is sent to an authorized person (Inventory Manager / Admin). Once approved, <strong>+1 unit will be added to inventory of the related branch</strong> and status will be updated to <strong>Router Collected</strong>.
                    </span>
                  ) : (
                    <span>
                      <strong>Role Restriction Notice:</strong> As a <strong>{currentUser?.role || 'Staff Member'}</strong>, changing status to <strong>{approvalTarget.targetStatus}</strong> requires formal approval. Upon authorization, the record will update automatically.
                    </span>
                  )}
                </div>
              </div>

              {/* Target Summary Card */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2 text-xs">
                <div className="flex items-center justify-between font-bold text-slate-800 dark:text-slate-100">
                  <span>Customer: {approvalTarget.record.customerName}</span>
                  <span className="font-mono text-[10px] bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded">
                    {approvalTarget.record.customerCode}
                  </span>
                </div>
                <div className="text-slate-500 flex items-center justify-between font-mono text-[11px]">
                  <span>Device SN: {approvalTarget.record.deviceSerial}</span>
                  <span>Model: {approvalTarget.record.productName}</span>
                </div>

                <div className="pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
                  <span className="text-slate-500 font-semibold">Status Change:</span>
                  <div className="flex items-center gap-2 font-bold text-[11px]">
                    <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700">
                      {approvalTarget.record.status}
                    </span>
                    <span>➔</span>
                    <span className="px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 uppercase">
                      {approvalTarget.targetStatus === 'DISCONNECTED' || approvalTarget.targetStatus === 'ROUTER_COLLECTED' ? 'ROUTER COLLECTED' : approvalTarget.targetStatus}
                    </span>
                  </div>
                </div>
              </div>

              {/* Reason Input */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Reason / Justification for Request *
                </label>
                <textarea
                  required
                  rows={3}
                  value={approvalReason}
                  onChange={(e) => setApprovalReason(e.target.value)}
                  placeholder={
                    approvalTarget.targetStatus === 'ROUTER_COLLECTED' || approvalTarget.targetStatus === 'DISCONNECTED'
                      ? "e.g. Customer requested service disconnect; ONU router and adapter inspected and collected in working condition..."
                      : "e.g. Customer returned ONU router in good condition. Requested deposit refund NPR 3,500..."
                  }
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-amber-500"
                />
              </div>

              {/* Restock Toggle */}
              {(approvalTarget.targetStatus === 'ROUTER_COLLECTED' || approvalTarget.targetStatus === 'DISCONNECTED' || approvalTarget.targetStatus === 'REFUND' || approvalTarget.targetStatus === 'RETURNED' || approvalTarget.targetStatus === 'IN_STOCK') && (
                <div className="flex items-center gap-2.5 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900">
                  <input
                    type="checkbox"
                    id="restockCheck"
                    checked={approvalRestock}
                    onChange={(e) => setApprovalRestock(e.target.checked)}
                    className="h-4 w-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <label htmlFor="restockCheck" className="text-xs font-bold text-blue-900 dark:text-blue-200 cursor-pointer">
                    Synchronize Inventory: Restock +1 unit back to related branch stock upon approval
                  </label>
                </div>
              )}

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setApprovalTarget(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingApproval}
                  className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-amber-600/20 cursor-pointer disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>{isSubmittingApproval ? 'Submitting...' : 'Send Approval Request'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Hardware Warranty Device Exchange Modal */}
      {isExchangeModalOpen && selectedDeviceForExchange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-2xl rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/80 dark:bg-slate-800/60">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                  <RefreshCw className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-slate-900 dark:text-white text-sm">
                    Device Warranty Exchange Form
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Replace customer ONU router & record return disposition
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsExchangeModalOpen(false);
                  setSelectedDeviceForExchange(null);
                }}
                className="h-8 w-8 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800 flex items-center justify-center text-slate-500 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal Body / Form */}
            <form onSubmit={handlePerformExchange} className="p-5 space-y-4 overflow-y-auto flex-1 text-xs">
              {/* Existing Customer & Device Summary */}
              <div className="p-3.5 rounded-2xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-indigo-900 dark:text-indigo-300 uppercase tracking-wider">
                    Current Assigned Device (To Be Replaced)
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-200 dark:bg-indigo-900 text-indigo-900 dark:text-indigo-200">
                    {selectedDeviceForExchange.status}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-500 block">Customer Name</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-bold">{selectedDeviceForExchange.customerName}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Customer Code</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-mono">{selectedDeviceForExchange.customerCode || 'N/A'}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Branch</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-bold">
                      {branches.find(b => b.id === selectedDeviceForExchange.branchId)?.name || selectedDeviceForExchange.branchId}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Current Model</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-bold">{selectedDeviceForExchange.productName}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Current Serial #</span>
                    <strong className="text-indigo-700 dark:text-indigo-300 font-mono">{selectedDeviceForExchange.deviceSerial}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block">Current PON Serial</span>
                    <strong className="text-indigo-700 dark:text-indigo-300 font-mono">{selectedDeviceForExchange.ponSerial}</strong>
                  </div>
                </div>
              </div>

              {/* Exchange Reason & Return Disposition */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Exchange Reason / Fault Diagnosis *
                  </label>
                  <select
                    value={exchangeReason}
                    onChange={(e) => setExchangeReason(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="Defective / Hardware Fault (No Power / Optical Loss)">Defective / Hardware Fault (No Power / Optical Loss)</option>
                    <option value="Frequent Reboot / Thermal Degradation">Frequent Reboot / Thermal Degradation</option>
                    <option value="Ethernet LAN Port / WAN Failure">Ethernet LAN Port / WAN Failure</option>
                    <option value="Customer Plan Upgrade (Dual Band 5G Migration)">Customer Plan Upgrade (Dual Band 5G Migration)</option>
                    <option value="Surge / Lightning Damage (RMA)">Surge / Lightning Damage (RMA)</option>
                    <option value="Physical Enclosure Damage / Burnt Power Adapter">Physical Enclosure Damage / Burnt Adapter</option>
                    <option value="Other Technical Replacement">Other Technical Replacement</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                    Returned Old Device Action *
                  </label>
                  <select
                    value={oldDeviceAction}
                    onChange={(e) => setOldDeviceAction(e.target.value as any)}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="DAMAGE">Flag as Defective / Quarantined RMA Stock</option>
                    <option value="RESTOCK">Tested Working - Restock to Branch (+1 Stock)</option>
                    <option value="DISPOSED">Beyond Repair - Disposed / E-Waste Scrap</option>
                  </select>
                </div>
              </div>

              {/* Replacement Device Details */}
              <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <Wifi className="h-3.5 w-3.5 text-indigo-600" />
                    <span>New Replacement Device Allocation</span>
                  </span>
                </div>

                {/* Replacement Product Model */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Replacement Model / Product
                  </label>
                  {products.length > 0 ? (
                    <select
                      value={exchangeProductName}
                      onChange={(e) => setExchangeProductName(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    >
                      {products.map((p) => (
                        <option key={p.id} value={p.name}>
                          {p.name} ({p.sku || p.category})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={exchangeProductName}
                      onChange={(e) => setExchangeProductName(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  )}
                </div>

                {/* New Serials */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        New Device Serial # *
                      </label>
                      <button
                        type="button"
                        onClick={() => setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`)}
                        className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-bold"
                      >
                        🎲 Auto-Gen
                      </button>
                    </div>
                    <input
                      type="text"
                      required
                      value={exchangeNewSerial}
                      onChange={(e) => setExchangeNewSerial(e.target.value)}
                      placeholder="e.g. SN-ONU24G-902188"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 uppercase"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                        New PON Serial # *
                      </label>
                      <button
                        type="button"
                        onClick={() => setExchangeNewPon(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`)}
                        className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-bold"
                      >
                        🎲 Auto-Gen
                      </button>
                    </div>
                    <input
                      type="text"
                      required
                      value={exchangeNewPon}
                      onChange={(e) => setExchangeNewPon(e.target.value)}
                      placeholder="e.g. HWTC-6789ABCD"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 uppercase"
                    />
                  </div>
                </div>

                {/* New MAC Address */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    New MAC Address (Optional)
                  </label>
                  <input
                    type="text"
                    value={exchangeNewMac}
                    onChange={(e) => setExchangeNewMac(e.target.value)}
                    placeholder="e.g. 00:1A:2B:3C:4D:5E"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 uppercase"
                  />
                </div>
              </div>

              {/* Technician Notes */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Exchange Remarks / Technician Notes
                </label>
                <textarea
                  rows={2}
                  value={exchangeNotes}
                  onChange={(e) => setExchangeNotes(e.target.value)}
                  placeholder="e.g. Replaced defective 2.4G router on-site. Verified optical Rx power -19 dBm, tested internet connectivity..."
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 text-xs text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setIsExchangeModalOpen(false);
                    setSelectedDeviceForExchange(null);
                  }}
                  className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingExchange}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isSubmittingExchange ? 'animate-spin' : ''}`} />
                  <span>{isSubmittingExchange ? 'Processing Exchange...' : 'Confirm & Execute Exchange'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Cancelling Disconnect Request */}
      {confirmCancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs animate-in fade-in">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl border overflow-hidden p-6 space-y-4 ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-800'
          }`}>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl bg-amber-100 dark:bg-amber-950/80 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-extrabold text-base text-slate-900 dark:text-white">
                  Cancel Disconnect Request?
                </h3>
                <p className="text-xs text-slate-500 font-mono">
                  {confirmCancelTarget.request.requestNumber}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">Customer:</span>
                <span className="font-bold text-slate-800 dark:text-slate-200">{confirmCancelTarget.record.customerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Device Serial:</span>
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">{confirmCancelTarget.record.deviceSerial}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Requested Status:</span>
                <span className="font-bold text-rose-600 dark:text-rose-400">{confirmCancelTarget.request.requestedStatus}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Requested By:</span>
                <span className="font-semibold text-slate-700 dark:text-slate-300">{confirmCancelTarget.request.requestedByName}</span>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 pt-2 border-t border-slate-200 dark:border-slate-700">
                Cancelling will set the approval request status to <strong>CANCELLED</strong> in the Workflow Authorization Center. The customer device will remain in active <strong>Rental</strong> status.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmCancelTarget(null)}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                Keep Request
              </button>
              <button
                type="button"
                onClick={handleConfirmCancelApproval}
                disabled={cancellingRequestId === confirmCancelTarget.request.id}
                className="px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 active:bg-amber-800 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-amber-600/20 cursor-pointer disabled:opacity-50"
              >
                <XCircle className={`h-4 w-4 ${cancellingRequestId ? 'animate-spin' : ''}`} />
                <span>{cancellingRequestId ? 'Cancelling...' : 'Confirm & Cancel Request'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
