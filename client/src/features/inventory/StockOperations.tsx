import React, { useState, useEffect, useMemo } from 'react';
import {
  StockOperation,
  Product,
  Branch,
  InventoryStock,
  PulloutItem,
  ShipmentItem,
  SaleItem,
  ConsumableIssueItem,
  DeviceSerialPair,
  User,
  Shipment,
  Asset,
  LocationRecord,
  CustomerRecord,
  CustomerDeviceRecord,
  ApprovalRequest,
} from '../../types';
import { formatDualDate, hasExactBSDayRecord, tryConvertADToBS, getNepaliFiscalYear } from '../../utils/nepaliCalendar';
import { DateField } from '../../components/DateField';
import { FilterCard } from '../../components/common/FilterCard';
import { api } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR } from '../../utils/nprFormat';
import { exportToCSV } from '../../utils/exportUtils';
import {
  AlertOctagon,
  Plus,
  Trash2,
  X,
  Search,
  Barcode,
  Package,
  CheckCircle2,
  Truck,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  Tag,
  Send,
  Inbox,
  Wrench,
  PackageMinus,
  MapPin,
  Wifi,
  UserCheck,
  ArrowRight,
  ShieldAlert,
  Lock,
  ClipboardList,
  RotateCcw,
  PackageCheck,
  AlertCircle,
  XCircle,
  Clock,
  Undo2,
  Download,
} from 'lucide-react';
import { isOperationAllowed, canUserSeeAllBranches, getAllowedBranches, getAllowedBranchIds } from '../../utils/permissions';
import { BarcodeScannerModal } from '../../components/common/BarcodeScannerModal';
import { FormCard } from '../../components/common/FormCard';
import { ProductSearchBar } from './ProductSearchBar';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface StockOperationsProps {
  operations: StockOperation[];
  products: Product[];
  branches: Branch[];
  stock?: InventoryStock[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  initialType?: string;
  autoOpenModal?: boolean;
  currentUser?: User | null;
  shipments?: Shipment[];
  assets?: Asset[];
  locations?: LocationRecord[];
  customers?: CustomerRecord[];
  customerDevices?: CustomerDeviceRecord[];
  approvalRequests?: ApprovalRequest[];
  onCreateOperation: (op: Partial<StockOperation>) => Promise<void>;
  onReceiveOperation?: (id: string) => Promise<void>;
  onCreateShipment?: (sh: Partial<Shipment>) => Promise<void>;
  onReceiveShipment?: (
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
    requestData: Omit<
      ApprovalRequest,
      'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'
    >
  ) => Promise<void>;
  onCancelApproval?: (id: string) => Promise<void>;
  onReverseOperation?: (id: string, reason?: string) => Promise<void>;
  onReverseConsumableIssue?: (id: string, reason?: string) => Promise<void>;
  onUpdateAssetStatus?: (id: string, updates: Asset['status'] | Partial<Asset>) => Promise<void>;
}

interface DamageSerialEntry {
  deviceSerial: string;
  ponSerial: string;
}

// Local transfer form line: ShipmentItem plus form-only mirror fields (unit label, quantity)
interface TransferFormLine extends ShipmentItem {
  unit?: string;
  quantity?: number;
}

// Central warehouse / head-office detection used by the inter-branch transfer
// flow. Matches the legacy inline predicates (WH001, isWarehouse, WH-* codes,
// and names containing warehouse / head office / central).
const isWarehouseOrHeadOffice = (b?: Branch | null): boolean =>
  Boolean(
    b &&
      (b.isHeadquarters ||
        b.isWarehouse ||
        b.id === 'WH001' ||
        b.code.toUpperCase().startsWith('WH') ||
        (b.name || '').toLowerCase().includes('warehouse') ||
        (b.name || '').toLowerCase().includes('head office') ||
        (b.name || '').toLowerCase().includes('central'))
  );

export const StockOperations: React.FC<StockOperationsProps> = ({
  operations,
  products,
  branches,
  stock = [],
  selectedBranchId,
  dateMode,
  initialType = 'PULLOUT',
  autoOpenModal = false,
  currentUser = null,
  shipments = [],
  assets = [],
  locations = [],
  customers = [],
  customerDevices = [],
  approvalRequests = [],
  onCreateOperation,
  onReceiveOperation,
  onCreateShipment,
  onReceiveShipment,
  onCancelReceiveShipment,
  onRequestApproval,
  onCancelApproval,
  onReverseOperation,
  onReverseConsumableIssue,
  onUpdateAssetStatus,
}) => {
  const { isDarkMode } = useDarkMode();
  const { confirm: confirmDialog, prompt: promptDialog } = useDialog();
  // Determine role permissions for Damage Labeling & Stock Control
  const isSuperOrInventory =
    currentUser?.role === 'SUPER_ADMIN' ||
    currentUser?.role === 'INVENTORY_MANAGER' ||
    (currentUser?.role as string) === 'INVENTORY_CONTROLLER';

  // Map initial tab
  const getInitialTab = (): 'PULLOUT_BINS' | 'CREATE_PULLOUT' | 'DAMAGE_TRACKING' | 'LABEL_DAMAGE' | 'RECEIVE_TRANSFER' | 'CREATE_TRANSFER' | 'ASSIGN_ASSET' | 'CONSUMABLE_ISSUE' | 'CONSUMABLES_REGISTER' | 'PRODUCT_SALE' | 'DEVICE_EXCHANGE' | 'LOGS' => {
    if (initialType === 'DEVICE_EXCHANGE') return 'DEVICE_EXCHANGE';
    if (initialType === 'CONSUMABLES_REGISTER') return 'CONSUMABLES_REGISTER';
    if (initialType === 'CONSUMABLE_ISSUE') return 'CONSUMABLE_ISSUE';
    if (initialType === 'DAMAGE') return 'LABEL_DAMAGE';
    if (initialType === 'PULLOUT_REPORT') return 'PULLOUT_BINS';
    if (initialType === 'DAMAGE_REPORT') return 'DAMAGE_TRACKING';
    if (initialType === 'RECEIVE_TRANSFER' || initialType === 'RECEIVE') return 'RECEIVE_TRANSFER';
    if (initialType === 'CREATE_TRANSFER' || initialType === 'TRANSFER') return 'CREATE_TRANSFER';
    if (initialType === 'ASSIGN_ASSET' || initialType === 'ASSIGN') return 'ASSIGN_ASSET';
    if (initialType === 'STOCK_OUT' || initialType === 'PRODUCT_SALE') return 'PRODUCT_SALE';
    if (initialType === 'LOGS') return 'LOGS';
    return 'CREATE_PULLOUT';
  };

  const [activeTab, setActiveTab] = useState<
    'PULLOUT_BINS' | 'CREATE_PULLOUT' | 'DAMAGE_TRACKING' | 'LABEL_DAMAGE' | 'RECEIVE_TRANSFER' | 'CREATE_TRANSFER' | 'ASSIGN_ASSET' | 'CONSUMABLE_ISSUE' | 'CONSUMABLES_REGISTER' | 'PRODUCT_SALE' | 'DEVICE_EXCHANGE' | 'LOGS'
  >(getInitialTab());

  useEffect(() => {
    setActiveTab(getInitialTab());
  }, [initialType]);

  // ---------------------------------------------------------------------------
  // BS Calendar Gate: stock operations are only allowed when today's AD date
  // has a seeded Nepali (BS) day record in bs_day_records. Missing months are
  // seeded/updated by the admin from System Settings -> BS Calendar Utility.
  // ---------------------------------------------------------------------------
  const [bsDateStatus, setBsDateStatus] = useState<'checking' | 'available' | 'missing'>('checking');
  const [bsDateCheckedFor, setBsDateCheckedFor] = useState<string>(new Date().toISOString().split('T')[0]);

  const checkBsDateAvailability = async () => {
    const todayAD = new Date().toISOString().split('T')[0];
    try {
      const res = await api.getBsDayRecordByAdDate(todayAD);
      setBsDateCheckedFor(todayAD);
      setBsDateStatus(res?.found ? 'available' : 'missing');
    } catch (_err) {
      // Server unreachable -> fall back to the strict client-side calendar check
      setBsDateCheckedFor(todayAD);
      setBsDateStatus(hasExactBSDayRecord(todayAD) ? 'available' : 'missing');
    }
  };

  useEffect(() => {
    checkBsDateAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureBsDateAvailable = (): boolean => {
    if (bsDateStatus === 'missing') {
      alert(
        'BS date is not available. Stock operations are locked.\n\n' +
          `Today (${bsDateCheckedFor}) has no Nepali (BS) date record in the BS calendar database (bs_day_records).\n` +
          'Please contact your system administrator for BS month seeding.\n\n' +
          'Admin path: System Settings -> BS Calendar Utility -> Seed / Update BS month.'
      );
      return false;
    }
    return true;
  };

  const isStandalonePage = Boolean(initialType);

  // Filter state
  const [branchFilter, setBranchFilter] = useState<string>(selectedBranchId);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedBinId, setExpandedBinId] = useState<string | null>(null);
  const [expandedShipmentId, setExpandedShipmentId] = useState<string | null>(null);

  // Modals state
  const [isPulloutModalOpen, setIsPulloutModalOpen] = useState(autoOpenModal && initialType === 'PULLOUT');
  const [isDamageModalOpen, setIsDamageModalOpen] = useState(autoOpenModal && initialType === 'DAMAGE');
  const [isAssignModalOpen, setIsAssignModalOpen] = useState(false);
  const [isBarcodeScannerOpen, setIsBarcodeScannerOpen] = useState(false);

  // Selected asset or product for assignment modal
  const [selectedAssetForAssign, setSelectedAssetForAssign] = useState<Asset | null>(null);
  const [selectedProductForAssign, setSelectedProductForAssign] = useState<Product | null>(null);
  const [productAssignSerial, setProductAssignSerial] = useState<string>('');
  const [productAssignPon, setProductAssignPon] = useState<string>('');
  const [productAssignMac, setProductAssignMac] = useState<string>('');
  const [productAssignTag, setProductAssignTag] = useState<string>('');
  const [customerSearchInAssignModal, setCustomerSearchInAssignModal] = useState<string>('');
  const [isCustomerDropdownOpen, setIsCustomerDropdownOpen] = useState<boolean>(false);

  // Device Exchange Tab State
  const [exchangeCustomerDevices, setExchangeCustomerDevices] = useState<CustomerDeviceRecord[]>([]);
  const [isLoadingExchangeDevices, setIsLoadingExchangeDevices] = useState<boolean>(false);
  const [selectedDeviceForExchange, setSelectedDeviceForExchange] = useState<CustomerDeviceRecord | null>(null);
  const [exchangeSearchQuery, setExchangeSearchQuery] = useState<string>('');
  const [exchangeReason, setExchangeReason] = useState<string>('Defective / Hardware Fault (No Power / Optical Loss)');
  const [oldDeviceAction, setOldDeviceAction] = useState<'DAMAGE' | 'RESTOCK' | 'DISPOSED'>('RESTOCK');
  const [exchangeProductName, setExchangeProductName] = useState<string>('');
  const [exchangeNewSerial, setExchangeNewSerial] = useState<string>('');
  const [exchangeNewPon, setExchangeNewPon] = useState<string>('');
  const [exchangeNewMac, setExchangeNewMac] = useState<string>('');
  const [exchangeNotes, setExchangeNotes] = useState<string>('');
  const [isSubmittingExchange, setIsSubmittingExchange] = useState<boolean>(false);

  // Allowed branches for current user
  const allowedBranches = getAllowedBranches(currentUser, branches);
  const allowedBranchIds = getAllowedBranchIds(currentUser, branches);
  const canSeeAll = canUserSeeAllBranches(currentUser);

  // Central warehouse dispatch is a warehouse function: only roles granted
  // `wh-restrict-transfer` (Super Admin / Inventory Manager by default) may
  // create inter-branch transfers originating from the warehouse.
  const canDispatchFromWarehouse = isOperationAllowed('wh-restrict-transfer', currentUser?.role);

  // --- FORM STATES ---

  // Filter Central Warehouse & Warehouse locations for pullouts (exclude standard retail branches)
  const warehouseLocations = branches.filter(
    (b) =>
      b.isHeadquarters ||
      b.isWarehouse ||
      b.code.toUpperCase().startsWith('WH') ||
      (b?.name || '').toLowerCase().includes('warehouse') ||
      (b?.name || '').toLowerCase().includes('head office') ||
      (b?.name || '').toLowerCase().includes('central')
  );
  const destWarehouseOptions = warehouseLocations.length > 0 ? warehouseLocations : branches.filter((b) => b.isHeadquarters);

  // Filter source branches for pullouts: ONLY retail / store branches (exclude Head Office / WH001 / warehouses)
  const pulloutSourceBranches = allowedBranches.filter(
    (b) =>
      !b.isHeadquarters &&
      !b.isWarehouse &&
      b.id !== 'WH001' &&
      !b.code.toUpperCase().startsWith('WH') &&
      !(b?.name || '').toLowerCase().includes('head office') &&
      !(b?.name || '').toLowerCase().includes('central warehouse')
  );
  const effectivePulloutSourceBranches =
    pulloutSourceBranches.length > 0
      ? pulloutSourceBranches
      : allowedBranches.filter((b) => b.id !== 'WH001');

  // 1. Pullout Bin Form State
  const userBranchId = allowedBranches[0]?.id || branches[0]?.id || '';
  const initialPulloutSourceBranchId =
    effectivePulloutSourceBranches.find((b) => b.id === userBranchId)?.id ||
    effectivePulloutSourceBranches[0]?.id ||
    allowedBranches.find((b) => b.id !== 'WH001')?.id ||
    'BRH01';

  const [sourceBranchId, setSourceBranchId] = useState<string>(initialPulloutSourceBranchId);
  const [destWarehouseId, setDestWarehouseId] = useState<string>(
    destWarehouseOptions[0]?.id || branches.find((b) => b.isHeadquarters)?.id || 'WH001'
  );

  useEffect(() => {
    if (effectivePulloutSourceBranches.length > 0) {
      if (!effectivePulloutSourceBranches.some((b) => b.id === sourceBranchId)) {
        setSourceBranchId(effectivePulloutSourceBranches[0].id);
      }
    }
  }, [effectivePulloutSourceBranches, sourceBranchId]);
  const [transferStatusFilter, setTransferStatusFilter] = useState<'ALL' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCEL_PENDING' | 'CANCELLED'>('ALL');
  const [binInspector, setBinInspector] = useState<string>(currentUser?.name || 'Logistics Officer');
  const [binNotes, setBinNotes] = useState<string>('Overstock / Damaged stock return dispatch to central warehouse');
  const [pulloutItems, setPulloutItems] = useState<PulloutItem[]>([]);
  const [prodSearchInput, setProdSearchInput] = useState<string>('');
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);

  // 2. Damage Labeling Form State
  const defaultDamageBranch = userBranchId;
  const [damageBranchId, setDamageBranchId] = useState<string>(defaultDamageBranch);
  const [damageItems, setDamageItems] = useState<PulloutItem[]>([]);
  const [damageReason, setDamageReason] = useState<string>('Overstock transit damage / defective hardware unit');
  const [damageInspector, setDamageInspector] = useState<string>(currentUser?.name || 'Branch Quality Inspector');

  // 3. Create Transfer Form State (Multi-Item Shipment Dispatch)
  const initialValidDestBranch = branches.find(
    (b) =>
      b.id !== userBranchId &&
      !b.isWarehouse &&
      !b.isHeadquarters &&
      b.id !== 'WH001' &&
      !b.code.toUpperCase().startsWith('WH') &&
      !(b?.name || '').toLowerCase().includes('warehouse') &&
      !(b?.name || '').toLowerCase().includes('head office') &&
      !(b?.name || '').toLowerCase().includes('central')
  )?.id || '';

  const [xferSourceBranchId, setXferSourceBranchId] = useState<string>(userBranchId);
  const [xferDestBranchId, setXferDestBranchId] = useState<string>(initialValidDestBranch);
  const [xferNotes, setXferNotes] = useState<string>('Inter-branch inventory transfer dispatch');
  const [transferItems, setTransferItems] = useState<TransferFormLine[]>([]);

  useEffect(() => {
    const srcBranch = branches.find((b) => b.id === xferSourceBranchId || b.code === xferSourceBranchId);
    const warehouseOrigin = isWarehouseOrHeadOffice(srcBranch);
    const validDestBranches = branches.filter(
      (b) =>
        b.id !== xferSourceBranchId &&
        !b.isWarehouse &&
        !b.isHeadquarters &&
        b.id !== 'WH001' &&
        !b.code.toUpperCase().startsWith('WH') &&
        !(b?.name || '').toLowerCase().includes('warehouse') &&
        !(b?.name || '').toLowerCase().includes('head office') &&
        !(b?.name || '').toLowerCase().includes('central') &&
        (!warehouseOrigin || b.allowWarehouseTransfer !== false)
    );

    if (validDestBranches.length > 0) {
      if (!validDestBranches.some((b) => b.id === xferDestBranchId)) {
        setXferDestBranchId(validDestBranches[0].id);
      }
    }
  }, [xferSourceBranchId, branches, xferDestBranchId]);

  // 4. Assign Fixed Asset Form State
  const [assignTargetType, setAssignTargetType] = useState<'LOCATION' | 'CUSTOMER'>('LOCATION');
  const [assignLocationId, setAssignLocationId] = useState<string>(locations[0]?.id || '');
  const [assignCustomerId, setAssignCustomerId] = useState<string>(customers[0]?.id || '');
  const [assignNotes, setAssignNotes] = useState<string>('Installed & commissioned as operational fixed asset');

  // 5. Product Sale Form State (Multi-Item Sales Invoice)
  const [saleCustomerId, setSaleCustomerId] = useState<string>(customers[0]?.id || '');
  const [saleBranchId, setSaleBranchId] = useState<string>(userBranchId);
  const [salePaymentMethod, setSalePaymentMethod] = useState<string>('Cash / Direct Payment');
  const [saleNotes, setSaleNotes] = useState<string>('Direct retail product item sale to customer');
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);

  // 6. Consumable Issue Form State (Multi-Item Requisition)
  const [consumableBranchId, setConsumableBranchId] = useState<string>(userBranchId);
  const [consumableTechnician, setConsumableTechnician] = useState<string>('Field Splicing Technician');
  const [consumableWorkOrder, setConsumableWorkOrder] = useState<string>('WO-2081-SPLIT-01');
  const [consumableReason, setConsumableReason] = useState<string>('Field fiber splicing & customer drop installation material usage');
  const [consumableItems, setConsumableItems] = useState<ConsumableIssueItem[]>([]);

  // Consumables Register (Serial-Log-Register-style ledger) view state
  const [consumableRegisterQuery, setConsumableRegisterQuery] = useState('');
  const [consumableRegisterBranch, setConsumableRegisterBranch] = useState('ALL');
  const [consumableRegisterStatus, setConsumableRegisterStatus] = useState('ALL');
  const [consumableRegisterDateFrom, setConsumableRegisterDateFrom] = useState('');
  const [consumableRegisterDateTo, setConsumableRegisterDateTo] = useState('');
  const [consumableRegisterExpandedId, setConsumableRegisterExpandedId] = useState<string | null>(null);

  // 7. Receive Stock Physical Verification Modal State
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
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 5000);
  };

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

  // Filtered products for pullout search
  const matchingProducts = products.filter((p) => {
    if (!prodSearchInput.trim()) return false;
    const q = (prodSearchInput || '').toLowerCase().trim();
    return (
      (p?.sku || '').toLowerCase().includes(q) ||
      (p?.barcode || '').toLowerCase().includes(q) ||
      (p?.name || '').toLowerCase().includes(q) ||
      (p?.category || '').toLowerCase().includes(q)
    );
  });

  // Helper to focus element by ID safely
  const focusInput = (id: string) => {
    setTimeout(() => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) {
        el.focus();
        if ('select' in el) el.select();
      }
    }, 60);
  };

  // Pullout Item Handlers
  const handleAddProductToPullout = (prod: Product) => {
    const isSerialized = prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY';
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    const existingIdx = pulloutItems.findIndex((i) => i.productId === prod.id);
    if (existingIdx !== -1) {
      targetLineIdx = existingIdx;
      setPulloutItems((prev) =>
        prev.map((i, idx) => {
          if (idx !== existingIdx) return i;
          const newQty = i.quantity + 1;
          const currentSerials = [...(i.deviceSerials || [])];
          targetSerialIdx = currentSerials.length;
          if (isSerialized) {
            currentSerials.push({ deviceSerial: '', ponSerial: '' });
          }
          return {
            ...i,
            quantity: newQty,
            totalValue: newQty * i.unitCost,
            deviceSerials: isSerialized ? currentSerials : undefined,
          };
        })
      );
    } else {
      targetLineIdx = pulloutItems.length;
      targetSerialIdx = 0;
      const srcStock = stock.find((s) => s.productId === prod.id && s.branchId === sourceBranchId);
      const availDamaged = srcStock?.damagedQty || 0;
      const defaultCond = availDamaged > 0 ? 'DAMAGED_STOCK' : 'OVERSTOCK';

      setPulloutItems((prev) => [
        ...prev,
        {
          id: `pli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          unit: prod.unit,
          quantity: 1,
          condition: defaultCond,
          unitCost: prod.costPrice,
          totalValue: prod.costPrice,
          reason: defaultCond === 'DAMAGED_STOCK' ? 'Damaged inventory return' : 'Surplus overstock return to warehouse',
          deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
        },
      ]);
    }
    setProdSearchInput('');
    setIsSearchOpen(false);

    if (isSerialized) {
      focusInput(`pullout-serial-device-${targetLineIdx}-${targetSerialIdx}`);
    }
  };

  const updatePulloutDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    setPulloutItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const updatePulloutPonSerial = (lineIdx: number, sIdx: number, val: string) => {
    setPulloutItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], ponSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const handleUpdatePulloutItem = (id: string, updates: Partial<PulloutItem>) => {
    setPulloutItems(
      pulloutItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.quantity !== undefined || updates.unitCost !== undefined) {
          updated.totalValue = updated.quantity * updated.unitCost;
          // Sync serials count if quantity changed and serials exist
          const prod = products.find((p) => p.id === updated.productId);
          if (prod && prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY') {
            const curSerials = [...(updated.deviceSerials || [])];
            while (curSerials.length < updated.quantity) {
              curSerials.push({ deviceSerial: '', ponSerial: '' });
            }
            updated.deviceSerials = curSerials.slice(0, updated.quantity);
          }
        }
        return updated;
      })
    );
  };

  const handleRemovePulloutItem = (id: string) => {
    setPulloutItems(pulloutItems.filter((i) => i.id !== id));
  };

  // Transfer Items Handlers
  const handleResetTransferForm = () => {
    setTransferItems([]);
    setXferNotes('Inter-branch inventory transfer dispatch');
    setXferSourceBranchId(userBranchId);
    setXferDestBranchId(branches.find((b) => b.id !== userBranchId)?.id || branches[1]?.id || '');
  };

  const updateTransferDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    setTransferItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const updateTransferPonSerial = (lineIdx: number, sIdx: number, val: string) => {
    setTransferItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], ponSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const handleAddTransferItem = (prodId?: string) => {
    const selProd = products.find((p) => p.id === prodId) || products[0];
    if (!selProd) return;

    const isSerialized = selProd.requiresSerialTracking !== false && selProd.trackingType !== 'QUANTITY_ONLY';
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    const existingIdx = transferItems.findIndex((i) => i.productId === selProd.id);
    if (existingIdx !== -1) {
      targetLineIdx = existingIdx;
      setTransferItems((prev) =>
        prev.map((item, idx) => {
          if (idx !== existingIdx) return item;
          const newQty = item.quantitySent + 1;
          const currentSerials = [...(item.deviceSerials || [])];
          targetSerialIdx = currentSerials.length;
          if (isSerialized) {
            currentSerials.push({ deviceSerial: '', ponSerial: '' });
          }
          return {
            ...item,
            quantity: newQty,
            quantitySent: newQty,
            deviceSerials: isSerialized ? currentSerials : undefined,
          };
        })
      );
    } else {
      targetLineIdx = transferItems.length;
      targetSerialIdx = 0;
      setTransferItems((prev) => [
        ...prev,
        {
          id: `xfer-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: selProd.id,
          productName: selProd.name,
          sku: selProd.sku,
          unit: selProd.unit,
          quantity: 1,
          quantitySent: 1,
          deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
        },
      ]);
    }

    if (isSerialized) {
      focusInput(`transfer-serial-device-${targetLineIdx}-${targetSerialIdx}`);
    }
  };

  const handleUpdateTransferItem = (id: string, updates: Partial<TransferFormLine>) => {
    setTransferItems(
      transferItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.productId) {
          const selProd = products.find((p) => p.id === updates.productId);
          if (selProd) {
            updated.productName = selProd.name;
            updated.sku = selProd.sku;
            updated.unit = selProd.unit;
          }
        }
        if (updates.quantitySent !== undefined) {
          updated.quantity = updated.quantitySent;
          const prod = products.find((p) => p.id === updated.productId);
          if (prod && prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY') {
            const curSerials = [...(updated.deviceSerials || [])];
            while (curSerials.length < updated.quantitySent) {
              curSerials.push({ deviceSerial: '', ponSerial: '' });
            }
            updated.deviceSerials = curSerials.slice(0, updated.quantitySent);
          }
        }
        return updated;
      })
    );
  };

  const handleRemoveTransferItem = (id: string) => {
    setTransferItems(transferItems.filter((i) => i.id !== id));
  };

  // Sale Items Handlers
  const handleResetSaleForm = () => {
    setSaleItems([]);
    setSaleCustomerId(customers[0]?.id || '');
    setSaleBranchId(userBranchId);
    setSalePaymentMethod('Cash / Direct Payment');
    setSaleNotes('Direct retail product item sale to customer');
  };

  const updateSaleDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    setSaleItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const updateSalePonSerial = (lineIdx: number, sIdx: number, val: string) => {
    setSaleItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], ponSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const handleAddSaleItem = (prodId?: string) => {
    const selProd = products.find((p) => p.id === prodId) || products[0];
    if (!selProd) return;

    const isSerialized = selProd.requiresSerialTracking !== false && selProd.trackingType !== 'QUANTITY_ONLY';
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    const existingIdx = saleItems.findIndex((i) => i.productId === selProd.id);
    if (existingIdx !== -1) {
      targetLineIdx = existingIdx;
      setSaleItems((prev) =>
        prev.map((item, idx) => {
          if (idx !== existingIdx) return item;
          const newQty = item.quantity + 1;
          const currentSerials = [...(item.deviceSerials || [])];
          targetSerialIdx = currentSerials.length;
          if (isSerialized) {
            currentSerials.push({ deviceSerial: '', ponSerial: '' });
          }
          return {
            ...item,
            quantity: newQty,
            totalValue: Math.max(0, newQty * item.sellingPrice - item.discount),
            deviceSerials: isSerialized ? currentSerials : undefined,
          };
        })
      );
    } else {
      targetLineIdx = saleItems.length;
      targetSerialIdx = 0;
      const price = selProd.sellingPrice || 1000;
      setSaleItems((prev) => [
        ...prev,
        {
          id: `sli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: selProd.id,
          productName: selProd.name,
          sku: selProd.sku,
          unit: selProd.unit,
          quantity: 1,
          sellingPrice: price,
          discount: 0,
          totalValue: price,
          deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
        },
      ]);
    }

    if (isSerialized) {
      focusInput(`sale-serial-device-${targetLineIdx}-${targetSerialIdx}`);
    }
  };

  const handleUpdateSaleItem = (id: string, updates: Partial<SaleItem>) => {
    setSaleItems(
      saleItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.productId) {
          const selProd = products.find((p) => p.id === updates.productId);
          if (selProd) {
            updated.productName = selProd.name;
            updated.sku = selProd.sku;
            updated.unit = selProd.unit;
            if (updates.sellingPrice === undefined) {
              updated.sellingPrice = selProd.sellingPrice || 1000;
            }
          }
        }
        if (updates.quantity !== undefined || updates.sellingPrice !== undefined || updates.discount !== undefined) {
          updated.totalValue = Math.max(0, (updated.quantity * updated.sellingPrice) - updated.discount);
          const prod = products.find((p) => p.id === updated.productId);
          if (prod && prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY') {
            const curSerials = [...(updated.deviceSerials || [])];
            while (curSerials.length < updated.quantity) {
              curSerials.push({ deviceSerial: '', ponSerial: '' });
            }
            updated.deviceSerials = curSerials.slice(0, updated.quantity);
          }
        }
        return updated;
      })
    );
  };

  const handleRemoveSaleItem = (id: string) => {
    setSaleItems(saleItems.filter((i) => i.id !== id));
  };

  // Consumable Items Handlers
  const handleResetConsumableForm = () => {
    setConsumableItems([]);
    setConsumableBranchId(userBranchId);
    setConsumableTechnician('Field Splicing Technician');
    setConsumableWorkOrder('WO-2081-SPLIT-01');
    setConsumableReason('Field fiber splicing & customer drop installation material usage');
  };

  const handleAddConsumableItem = (prodId?: string) => {
    const consumableProducts = products.filter(p => p.productGroup === 'Consumable Item' || p.category.includes('Consumable'));
    const selProd = products.find((p) => p.id === prodId) || consumableProducts[0] || products[0];
    if (!selProd) return;

    const existingItem = consumableItems.find((i) => i.productId === selProd.id);
    if (existingItem) {
      handleUpdateConsumableItem(existingItem.id, { quantity: existingItem.quantity + 1 });
      return;
    }

    setConsumableItems([
      ...consumableItems,
      {
        id: `cni-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        productId: selProd.id,
        productName: selProd.name,
        sku: selProd.sku,
        unit: selProd.unit,
        quantity: 5,
        unitCost: selProd.costPrice,
        totalValue: 5 * selProd.costPrice,
        usedAtType: 'FIELD',
      },
    ]);
  };

  const handleUpdateConsumableItem = (id: string, updates: Partial<ConsumableIssueItem>) => {
    setConsumableItems(
      consumableItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.productId) {
          const selProd = products.find((p) => p.id === updates.productId);
          if (selProd) {
            updated.productName = selProd.name;
            updated.sku = selProd.sku;
            updated.unit = selProd.unit;
            updated.unitCost = selProd.costPrice;
          }
        }
        if (updates.quantity !== undefined || updates.unitCost !== undefined) {
          updated.totalValue = updated.quantity * updated.unitCost;
        }
        return updated;
      })
    );
  };

  const handleRemoveConsumableItem = (id: string) => {
    setConsumableItems(consumableItems.filter((i) => i.id !== id));
  };

  // Shared Branch Inventory & Serial Register Validation
  const validateSourceBranchStockAndSerials = (
    branchId: string,
    branchName: string,
    items: {
      productId: string;
      productName: string;
      quantity: number;
      condition?: string;
      deviceSerials?: { deviceSerial: string; ponSerial?: string }[];
    }[]
  ): boolean => {
    const seenSerials = new Set<string>();

    for (const item of items) {
      const prod = products.find((p) => p.id === item.productId);
      const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;
      const srcStock = stock.find((s) => s.productId === item.productId && s.branchId === branchId);

      const isDamagedPullout = item.condition === 'DAMAGED_STOCK';
      const availStock = srcStock ? (isDamagedPullout ? (srcStock.damagedQty || 0) : srcStock.quantityOnHand) : 0;

      // 1. Every stock-out operation must have a real branch stock record.
      if (!srcStock || availStock < item.quantity) {
        alert(
          `Insufficient inventory: "${branchName}" has ${availStock} ${isDamagedPullout ? 'damaged' : 'usable'} unit(s) of "${item.productName}", but ${item.quantity} unit(s) were requested.`
        );
        return false;
      }

      // 2. Validate Serial Tracking & Register for Serialized Items
      if (isSerialized) {
        if (!item.deviceSerials || item.deviceSerials.length < item.quantity) {
          alert(`Validation Error: Please enter serial numbers for all ${item.quantity} unit(s) of "${item.productName}".`);
          return false;
        }

        for (let sIdx = 0; sIdx < item.quantity; sIdx++) {
          const s = item.deviceSerials[sIdx];
          if (!s || !s.deviceSerial?.trim()) {
            alert(`Validation Error: Device Serial # is required for "${item.productName}" (Unit #${sIdx + 1}).`);
            return false;
          }

          const cleanSerial = s.deviceSerial.trim().toUpperCase();
          const cleanPon = s.ponSerial?.trim().toUpperCase();
          if (prod?.trackingType === 'SERIAL_MAC_PON' && !cleanPon) {
            alert(`Validation Error: PON Serial # is required for "${item.productName}" (Unit #${sIdx + 1}).`);
            return false;
          }

          if (seenSerials.has(cleanSerial)) {
            alert(`Validation Error: Duplicate Device Serial #${cleanSerial} detected in requested items.`);
            return false;
          }
          seenSerials.add(cleanSerial);

          const match = customerDevices.find(
            (cd) =>
              cd.deviceSerial?.trim().toUpperCase() === cleanSerial &&
              (!cleanPon || cd.ponSerial?.trim().toUpperCase() === cleanPon) &&
              cd.branchId === branchId &&
              cd.status === 'IN_STOCK' &&
              (!cd.productName || cd.productName.trim().toLowerCase() === item.productName.trim().toLowerCase())
          );
          if (!match) {
            alert(`Serial Register Error: Device Serial #${cleanSerial}${cleanPon ? ` / PON #${cleanPon}` : ''} must match an IN_STOCK ${item.productName} record at ${branchName}.`);
            return false;
          }
        }
      }
    }

    return true;
  };

  // 1. Submit Pullout Dispatch
  const handleSubmitPulloutBin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (pulloutItems.length === 0) {
      alert('Please add at least one stock item to the pullout bin.');
      return;
    }

    const srcBranch = branches.find((b) => b.id === sourceBranchId);
    const destWh = branches.find((b) => b.id === destWarehouseId);

    // Strict validation for Branch Stock Quantity and Serial Register
    if (
      !validateSourceBranchStockAndSerials(
        sourceBranchId,
        srcBranch?.name || sourceBranchId,
        pulloutItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          condition: i.condition,
          deviceSerials: i.deviceSerials,
        }))
      )
    ) {
      return;
    }

    const grandTotal = pulloutItems.reduce((sum, item) => sum + item.totalValue, 0);

    await onCreateOperation({
      type: 'PULLOUT',
      branchId: sourceBranchId,
      branchName: srcBranch?.name,
      destinationWarehouseId: destWarehouseId,
      destinationWarehouseName: destWh?.name,
      items: pulloutItems,
      totalValue: grandTotal,
      reason: binNotes,
      inspectorName: binInspector,
      status: 'DISPATCHED',
    });

    alert(`✓ Pullout Bin successfully created and dispatched from ${srcBranch?.name || sourceBranchId} to ${destWh?.name || 'Central Warehouse'}!\n\nThe Warehouse Manager can now inspect and receive this pullout under:\nWarehouse Logistics ➔ Receive Inbound Stock & Pullouts`);

    setIsPulloutModalOpen(false);
    setActiveTab('PULLOUT_BINS');
    setPulloutItems([]);
  };

  // 2. Submit Local Damage Tagging
  const handleSubmitDamageTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const targetBranch = !isSuperOrInventory && currentUser?.branchId ? currentUser.branchId : damageBranchId;
    if (damageItems.length === 0) {
      alert('Add at least one product to the damaged stock list.');
      return;
    }

    if (
      !validateSourceBranchStockAndSerials(
        targetBranch,
        branches.find((b) => b.id === targetBranch)?.name || targetBranch,
        damageItems.map(({ condition: _condition, ...item }) => item)
      )
    ) {
      return;
    }

    await onCreateOperation({
      type: 'DAMAGE',
      branchId: targetBranch,
      productId: damageItems.length === 1 ? damageItems[0].productId : undefined,
      productName: damageItems.length === 1 ? damageItems[0].productName : undefined,
      quantityChanged: damageItems.reduce((sum, item) => sum + item.quantity, 0),
      costPerUnit: damageItems.length === 1 ? damageItems[0].unitCost : 0,
      totalValue: damageItems.reduce((sum, item) => sum + item.totalValue, 0),
      reason: damageReason,
      inspectorName: damageInspector,
      status: 'LOGGED',
      items: damageItems,
    });

    setIsDamageModalOpen(false);
    setActiveTab('DAMAGE_TRACKING');
    setDamageItems([]);
  };

  // 2b. Reverse a recorded damage entry (Safe-guarded; Super Admin / Inventory Manager only).
  const canReverseDamage =
    currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'INVENTORY_MANAGER';

  const isReversibleDamageOp = (op: StockOperation): boolean =>
    op.type === 'DAMAGE' && op.status !== 'CANCELLED' && !op.id.startsWith('syn-');

  const handleReverseDamageRecord = async (op: StockOperation) => {
    if (!canReverseDamage) {
      showToast('Only Super Admin and Inventory Manager can reverse damage records.');
      return;
    }
    const reason = await promptDialog(
      `You are about to reverse damage record ${op.referenceNumber}.\n\n` +
        `● Product: ${op.productName || op.productId}\n` +
        `● Units: ${Math.abs(op.quantityChanged || 0)} Pcs\n` +
        `● Valuation: ${formatNPR(op.totalValue)}\n` +
        `● Branch: ${op.branchId}\n\n` +
        `Reversing restores the units back to available stock and marks this record CANCELLED. ` +
        `This action is irreversible and is logged to the audit trail under your credentials.`,
      {
        title: 'Reverse Damage Entry — Safeguard',
        confirmLabel: 'Reverse & Restore Stock',
        cancelLabel: 'Keep Record',
        placeholder: 'Required: reason for reversal (audit trail)',
      }
    );
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('Reversal aborted — a reason is required as a safeguard.');
      return;
    }
    try {
      if (onReverseOperation) {
        await onReverseOperation(op.id, reason.trim());
      } else {
        await api.reverseStockOperation(op.id, reason.trim(), currentUser);
      }
      showToast(`Damage record ${op.referenceNumber} reversed. Units restored to available stock.`);
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };

  // Reverse a logged consumable issue (guarded by 'consumable-issue-reverse').
  // Returns the issued units to branch stock and marks the record CANCELLED.
  const handleReverseConsumableIssue = async (op: StockOperation) => {
    const reason = await promptDialog(
      `You are about to reverse consumable issue ${op.referenceNumber}.\n\n` +
        `● Items: ${(op.items || []).length} line item(s)\n` +
        `● Valuation: ${formatNPR(op.totalValue)}\n` +
        `● Branch: ${op.branchId}\n` +
        `● Technician: ${op.technicianName || 'N/A'}\n\n` +
        `Reversing returns the units to available branch stock and marks this record CANCELLED. ` +
        `This action is irreversible and is logged to the audit trail under your credentials.`,
      {
        title: 'Reverse Consumable Issue — Safeguard',
        confirmLabel: 'Reverse & Return Stock',
        cancelLabel: 'Keep Record',
        placeholder: 'Required: reason for reversal (audit trail)',
      }
    );
    if (reason === null) return;
    if (!reason.trim()) {
      showToast('Reversal aborted — a reason is required as a safeguard.');
      return;
    }
    try {
      if (onReverseConsumableIssue) {
        await onReverseConsumableIssue(op.id, reason.trim());
      } else {
        await api.reverseConsumableIssue(op.id, reason.trim(), currentUser);
      }
      showToast(`Consumable issue ${op.referenceNumber} reversed. Units returned to available stock.`);
    } catch (err: any) {
      showToast(`Reversal failed: ${err.message || 'Unknown error'}`);
    }
  };

  const handleAddDamageItem = (product: Product) => {
    const isSerialized = product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY';
    setDamageItems((previous) => {
      const existing = previous.find((item) => item.productId === product.id);
      if (existing) {
        return previous.map((item) => item.productId === product.id ? {
          ...item,
          quantity: item.quantity + 1,
          totalValue: (item.quantity + 1) * item.unitCost,
          deviceSerials: isSerialized ? [...(item.deviceSerials || []), { deviceSerial: '', ponSerial: '' }] : undefined,
        } : item);
      }
      return [...previous, {
        id: `damage-${Date.now()}-${product.id}`,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        unit: product.unit,
        quantity: 1,
        condition: 'DAMAGED_STOCK',
        unitCost: product.costPrice,
        totalValue: product.costPrice,
        deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
      }];
    });
  };

  const updateDamageItem = (id: string, updates: Partial<PulloutItem>) => {
    setDamageItems((previous) => previous.map((item) => {
      if (item.id !== id) return item;
      const updated = { ...item, ...updates };
      if (updates.quantity !== undefined) {
        const product = products.find((entry) => entry.id === item.productId);
        const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : false;
        updated.totalValue = updated.quantity * updated.unitCost;
        updated.deviceSerials = isSerialized ? Array.from({ length: updated.quantity }, (_, index) => item.deviceSerials?.[index] || { deviceSerial: '', ponSerial: '' }) : undefined;
      }
      return updated;
    }));
  };

  const updateDamageItemSerial = (itemId: string, index: number, field: keyof DamageSerialEntry, value: string) => {
    setDamageItems((previous) => previous.map((item) => item.id === itemId ? {
      ...item,
      deviceSerials: (item.deviceSerials || []).map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry),
    } : item));
  };

  // 3. Submit Create Transfer
  const handleSubmitCreateTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const srcBranch = branches.find((b) => b.id === xferSourceBranchId || b.code === xferSourceBranchId);
    const destBranch = branches.find((b) => b.id === xferDestBranchId || b.code === xferDestBranchId);

    if (!srcBranch || !destBranch) {
      alert('Please select both a valid Source Branch and Destination Branch.');
      return;
    }

    if (xferSourceBranchId === xferDestBranchId) {
      alert('Source and Destination branches must be different.');
      return;
    }

    // Warehouse functions (wh-restrict-transfer): warehouse-origin transfers are
    // limited to the Super Admin / Inventory Manager roles and to destination
    // branches configured to accept warehouse transfers (allowWarehouseTransfer).
    if (isWarehouseOrHeadOffice(srcBranch)) {
      if (!isOperationAllowed('wh-restrict-transfer', currentUser?.role)) {
        alert('Warehouse stock transfers are restricted to the Super Admin and Inventory Manager roles only.');
        return;
      }
      if (destBranch.allowWarehouseTransfer === false) {
        alert(
          `${destBranch.name} (${destBranch.code}) is not authorized to receive warehouse transfers. ` +
            'Enable "Allow Warehouse Transfers" for this branch in Branch Settings first.'
        );
        return;
      }
    }

    if (transferItems.length === 0) {
      alert('Please add at least one product item to transfer.');
      return;
    }

    if (
      !validateSourceBranchStockAndSerials(
        xferSourceBranchId,
        srcBranch.name,
        transferItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantitySent,
          deviceSerials: i.deviceSerials,
        }))
      )
    ) {
      return;
    }

    if (onCreateShipment) {
      // Date integrity: AD dispatch date is canonical; BS is derived from the seeded calendar.
      const dispatchDateAD = new Date().toISOString().split('T')[0];
      const dispatchBS = tryConvertADToBS(dispatchDateAD);
      await onCreateShipment({
        trackingCode: `TRF-BR-${Math.floor(100000 + Math.random() * 900000)}`,
        type: 'INTER_BRANCH',
        sourceBranchId: xferSourceBranchId,
        sourceBranchName: srcBranch.name,
        destinationBranchId: xferDestBranchId,
        destinationBranchName: destBranch.name,
        dispatchDateAD,
        dispatchDateBS: dispatchBS?.formattedBSShort || '',
        estimatedArrivalAD: new Date(Date.now() + 86400000 * 2).toISOString().split('T')[0],
        status: 'DISPATCHED',
        items: transferItems,
        notes: xferNotes,
      });
      alert(`Inter-Branch Stock Transfer with ${transferItems.length} line item(s) successfully dispatched!`);
      setTransferItems([]);
      setActiveTab('RECEIVE_TRANSFER');
    }
  };

  // 4. Submit Assign Fixed Asset
  const handleOpenAssignModal = (asset: Asset) => {
    setSelectedAssetForAssign(asset);
    setSelectedProductForAssign(null);
    setIsAssignModalOpen(true);
  };

  const handleOpenProductAssignModal = (prod: Product) => {
    setSelectedProductForAssign(prod);
    setSelectedAssetForAssign(null);
    setProductAssignTag(`FA-ONU-${Math.floor(1000 + Math.random() * 9000)}`);
    setProductAssignSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`);
    setProductAssignPon(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`);
    setProductAssignMac('00:1A:2B:3C:4D:5E');
    setAssignTargetType('CUSTOMER');
    setAssignCustomerId(customers[0]?.id || '');
    setAssignLocationId(locations[0]?.id || '');
    setAssignNotes('Deployed as Customer Rental CPE Asset from inventory stock.');
    setIsAssignModalOpen(true);
  };

  const handleSubmitAssignAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const todayAD = new Date().toISOString().split('T')[0];
    // Derive the BS date from the seeded calendar — never hardcode.
    const todayBS = tryConvertADToBS(todayAD)?.formattedBSShort || '';

    // A) If assigning a Product directly as a Fixed Asset / Rental CPE
    if (selectedProductForAssign) {
      const custObj = customers.find((c) => c.id === assignCustomerId);
      const locObj = locations.find((l) => l.id === assignLocationId);
      const assetBranchId = selectedBranchId === 'ALL' ? 'WH001' : selectedBranchId;
      const availableAssetStock = stock.find((entry) => entry.productId === selectedProductForAssign.id && entry.branchId === assetBranchId);
      if (!availableAssetStock || availableAssetStock.quantityOnHand < 1) {
        alert(`Cannot assign "${selectedProductForAssign.name}": no available stock exists at the selected branch.`);
        return;
      }
      const assetIsSerialized = selectedProductForAssign.requiresSerialTracking !== false && selectedProductForAssign.trackingType !== 'QUANTITY_ONLY';
      if (assetIsSerialized) {
        const matchingAssetDevice = customerDevices.find(
          (device) =>
            device.deviceSerial?.trim().toUpperCase() === productAssignSerial.trim().toUpperCase() &&
            device.ponSerial?.trim().toUpperCase() === productAssignPon.trim().toUpperCase() &&
            device.branchId === assetBranchId &&
            device.status === 'IN_STOCK' &&
            device.productName?.trim().toLowerCase() === selectedProductForAssign.name.trim().toLowerCase()
        );
        if (!matchingAssetDevice) {
          alert('The assigned serialized product must use a matching Device Serial/PON pair from IN_STOCK inventory.');
          return;
        }
      }

      await api.createAsset({
        tagNumber: productAssignTag || `FA-ONU-${Math.floor(1000 + Math.random() * 9000)}`,
        name: selectedProductForAssign.name,
        category: selectedProductForAssign.category || 'IT Equipment',
        branchId: assetBranchId,
        acquisitionDateAD: todayAD,
        acquisitionDateBS: todayBS,
        acquisitionCost: selectedProductForAssign.costPrice,
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationRatePercent: selectedProductForAssign.depreciationRate || 15,
        status: assignTargetType === 'CUSTOMER' ? 'ASSIGNED_TO_CUSTOMER' : 'ASSIGNED_TO_LOCATION',
        assignedType: assignTargetType,
        assignedCustomerId: assignTargetType === 'CUSTOMER' ? assignCustomerId : undefined,
        assignedCustomerName: assignTargetType === 'CUSTOMER' ? (custObj ? `${custObj.customerName} (${custObj.customerId})` : assignCustomerId) : undefined,
        assignedLocationId: assignTargetType === 'LOCATION' ? assignLocationId : undefined,
        assignedLocationName: assignTargetType === 'LOCATION' ? (locObj?.name || assignLocationId) : undefined,
        assignmentDateAD: todayAD,
        assignmentDateBS: todayBS,
        assignmentNotes: assignNotes,
      });

      if (assignTargetType === 'CUSTOMER' && custObj) {
        await api.createCustomerDevice({
          customerId: custObj.id,
          customerName: custObj.customerName,
          customerCode: custObj.customerId,
          contactPhone: custObj.contactNumber || '9800000000',
          installationAddress: custObj.address || 'Nepal',
          branchId: assetBranchId,
          productName: selectedProductForAssign.name,
          deviceSerial: productAssignSerial || `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
          ponSerial: productAssignPon || `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
          macAddress: productAssignMac || undefined,
          status: 'RENTAL',
          issuedDateAD: todayAD,
          issuedDateBS: todayBS,
          notes: `[RENTAL CPE ASSET - Tag: ${productAssignTag}] ${assignNotes}`,
        });
      }

      setIsAssignModalOpen(false);
      setSelectedProductForAssign(null);
      alert(`Product "${selectedProductForAssign.name}" successfully registered as Fixed Asset Tag ${productAssignTag} & assigned!`);
      if (typeof window !== 'undefined') window.location.reload();
      return;
    }

    // B) If assigning an existing Asset from Asset Ledger
    if (!selectedAssetForAssign || !onUpdateAssetStatus) return;

    if (assignTargetType === 'LOCATION') {
      const locObj = locations.find((l) => l.id === assignLocationId);
      await onUpdateAssetStatus(selectedAssetForAssign.id, {
        status: 'ASSIGNED_TO_LOCATION',
        assignedType: 'LOCATION',
        assignedLocationId: assignLocationId,
        assignedLocationName: locObj?.name || assignLocationId,
        assignmentDateAD: todayAD,
        assignmentDateBS: todayBS,
        assignmentNotes: assignNotes,
      });
    } else {
      const custObj = customers.find((c) => c.id === assignCustomerId);
      await onUpdateAssetStatus(selectedAssetForAssign.id, {
        status: 'ASSIGNED_TO_CUSTOMER',
        assignedType: 'CUSTOMER',
        assignedCustomerId: assignCustomerId,
        assignedCustomerName: custObj ? `${custObj.customerName} (${custObj.customerId})` : assignCustomerId,
        assignmentDateAD: todayAD,
        assignmentDateBS: todayBS,
        assignmentNotes: assignNotes,
      });

      if (custObj) {
        await api.createCustomerDevice({
          customerId: custObj.id,
          customerName: custObj.customerName,
          customerCode: custObj.customerId,
          contactPhone: custObj.contactNumber || '9800000000',
          installationAddress: custObj.address || 'Nepal',
          branchId: selectedAssetForAssign.branchId || 'WH001',
          productName: selectedAssetForAssign.name,
          deviceSerial: `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
          ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
          status: 'RENTAL',
          issuedDateAD: todayAD,
          issuedDateBS: todayBS,
          notes: `[FIXED ASSET CPE - Tag: ${selectedAssetForAssign.tagNumber}] ${assignNotes}`,
        });
      }
    }

    setIsAssignModalOpen(false);
    setSelectedAssetForAssign(null);
  };

  const handleUnassignAsset = async (asset: Asset) => {
    if (!ensureBsDateAvailable()) return;
    if (!onUpdateAssetStatus) return;
    if (await confirmDialog(`Unassign "${asset.name}" (${asset.tagNumber}) and return it to Available Stock?`)) {
      await onUpdateAssetStatus(asset.id, {
        status: 'ACTIVE',
        assignedType: undefined,
        assignedLocationId: undefined,
        assignedLocationName: undefined,
        assignedCustomerId: undefined,
        assignedCustomerName: undefined,
        assignmentDateAD: undefined,
        assignmentDateBS: undefined,
        assignmentNotes: undefined,
      });
    }
  };

  // 6. Submit Consumable Issue to Technician / Work Order Field Usage
  const handleSubmitConsumableIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (consumableItems.length === 0) {
      alert('Please add at least one consumable item to issue.');
      return;
    }

    const branchObj = branches.find((b) => b.id === consumableBranchId);

    if (
      !validateSourceBranchStockAndSerials(
        consumableBranchId,
        branchObj?.name || consumableBranchId,
        consumableItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
        }))
      )
    ) {
      return;
    }

    const grandTotal = consumableItems.reduce((sum, item) => sum + item.totalValue, 0);

    // Compact per-line destination summary embedded in the reason (shown in
    // registers that render only the operation-level reason text).
    const usedAtSummary = consumableItems
      .map((item) => {
        if (item.usedAtType === 'POP' && item.usedAtLocationName) return `${item.productName} @ POP ${item.usedAtLocationName}`;
        if (item.usedAtType === 'CUSTOMER' && item.usedAtCustomerName) return `${item.productName} @ ${item.usedAtCustomerName}`;
        return null;
      })
      .filter(Boolean)
      .join('; ');

    await onCreateOperation({
      type: 'CONSUMABLE_ISSUE',
      branchId: consumableBranchId,
      branchName: branchObj?.name,
      items: consumableItems,
      totalValue: grandTotal,
      technicianName: consumableTechnician,
      workOrderRef: consumableWorkOrder,
      reason: `Consumable Field Issue: WO ${consumableWorkOrder} (${consumableTechnician}) - ${consumableReason}${usedAtSummary ? ` — Used at: ${usedAtSummary}` : ''}`,
      inspectorName: currentUser?.name || 'Store Supervisor',
      status: 'LOGGED',
    });

    alert(`Successfully issued ${consumableItems.length} consumable material line item(s) to Technician ${consumableTechnician} for Work Order ${consumableWorkOrder}!`);
    setConsumableItems([]);
    setConsumableReason('Field fiber splicing & customer drop installation material usage');
  };

  // 5. Submit Product Sale to Customer
  const handleSubmitProductSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const cust = customers.find((c) => c.id === saleCustomerId);
    const branchObj = branches.find((b) => b.id === saleBranchId);

    if (!cust) return;

    if (saleItems.length === 0) {
      alert('Please add at least one product item to the sales invoice.');
      return;
    }

    // Strict validation for Branch Stock Quantity and Serial Register
    if (
      !validateSourceBranchStockAndSerials(
        saleBranchId,
        branchObj?.name || saleBranchId,
        saleItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          deviceSerials: i.deviceSerials,
        }))
      )
    ) {
      return;
    }

    const grossTotal = saleItems.reduce((s, i) => s + (i.quantity * i.sellingPrice), 0);
    const totalDiscount = saleItems.reduce((s, i) => s + i.discount, 0);
    const netSaleAmount = Math.max(0, grossTotal - totalDiscount);

    await onCreateOperation({
      type: 'STOCK_OUT',
      branchId: saleBranchId,
      branchName: branchObj?.name,
      items: saleItems,
      totalValue: netSaleAmount,
      customerId: cust.id,
      customerName: `${cust.customerName} (${cust.customerId})`,
      paymentMethod: salePaymentMethod,
      reason: `Customer Product Sale Invoice (${saleItems.length} items): ${cust.customerName} - ${saleNotes}`,
      inspectorName: currentUser?.name || 'Sales Representative',
      status: 'LOGGED',
    });

    alert(`Multi-item Product Sales Invoice logged successfully! Net Bill Amount: ${formatNPR(netSaleAmount)}.\nSold device(s) tagged as SOLD in Customer Device Directory.`);
    setSaleItems([]);
  };

  // Helper to check if an operation belongs to user's allowed branches
  const isOpInAllowedBranch = (op: StockOperation) => {
    if (canSeeAll) return true;
    return (
      (op.branchId && allowedBranchIds.includes(op.branchId)) ||
      (op.destinationWarehouseId && allowedBranchIds.includes(op.destinationWarehouseId))
    );
  };

  // Synthesize missing stock operation entries for inventory stock items that have damagedQty > 0
  const existingDamageOps = operations.filter((op) => op.type === 'DAMAGE' && isOpInAllowedBranch(op));
  const synthesizedDamageOps: StockOperation[] = [];
  stock.forEach((stk) => {
    if (stk.damagedQty && stk.damagedQty > 0) {
      if (isOpInAllowedBranch({ branchId: stk.branchId } as any)) {
        const hasMatchingOp = existingDamageOps.some(
          (op) => op.productId === stk.productId && op.branchId === stk.branchId
        );
        if (!hasMatchingOp) {
          const prod = products.find((p) => p.id === stk.productId);
          // Date integrity: derive BS + fiscal year from the AD date (no hardcoded values).
          const synDateAD = stk.lastUpdated ? stk.lastUpdated.split('T')[0] : new Date().toISOString().split('T')[0];
          const synDateBS = tryConvertADToBS(synDateAD);
          synthesizedDamageOps.push({
            id: `syn-dmg-${stk.id}`,
            referenceNumber: `DMG-${stk.branchId}-${stk.productId.replace('prod-', '').toUpperCase().slice(0, 8)}`,
            type: 'DAMAGE',
            branchId: stk.branchId,
            productId: stk.productId,
            productName: prod?.name || 'Damaged Stock Item',
            quantityChanged: -stk.damagedQty,
            costPerUnit: prod?.costPrice || 0,
            totalValue: stk.damagedQty * (prod?.costPrice || 0),
            reason: 'Physical branch inventory inspection & transit damage tag',
            inspectorName: 'Branch Quality Inspector',
            dateAD: synDateAD,
            dateBS: synDateBS?.formattedBSShort || '',
            fiscalYear: getNepaliFiscalYear(synDateAD),
          });
        }
      }
    }
  });

  const damageOperations = [...existingDamageOps, ...synthesizedDamageOps];
  const pulloutOperations = operations.filter((op) => op.type === 'PULLOUT' && isOpInAllowedBranch(op));
  const consumableOperations = operations.filter((op) => op.type === 'CONSUMABLE_ISSUE' && isOpInAllowedBranch(op));
  const saleOperations = operations.filter((op) => op.type === 'STOCK_OUT' && isOpInAllowedBranch(op));

  // Consumables Register: filtered CONSUMABLE_ISSUE ledger rows (search + branch + status)
  const consumableRegisterOps = useMemo(() => {
    const q = consumableRegisterQuery.trim().toLowerCase();
    return consumableOperations.filter((op) => {
      if (consumableRegisterBranch !== 'ALL' && op.branchId !== consumableRegisterBranch) return false;
      if (consumableRegisterStatus !== 'ALL' && (op.status || 'LOGGED') !== consumableRegisterStatus) return false;
      // AD date range (inclusive): an op matches when dateAD falls between
      // the bounds; a bound left empty is open-ended.
      if (consumableRegisterDateFrom && (op.dateAD || '') < consumableRegisterDateFrom) return false;
      if (consumableRegisterDateTo && (op.dateAD || '') > consumableRegisterDateTo) return false;
      if (!q) return true;
      const items = (op.items || []) as ConsumableIssueItem[];
      const haystack = [
        op.referenceNumber,
        op.technicianName,
        op.workOrderRef,
        op.reason,
        ...items.map((i) => i.productName),
        ...items.map((i) => i.sku),
        ...items.map((i) => i.usedAtLocationName),
        ...items.map((i) => i.usedAtCustomerName),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [consumableOperations, consumableRegisterQuery, consumableRegisterBranch, consumableRegisterStatus, consumableRegisterDateFrom, consumableRegisterDateTo]);

  // Fetch Customer Devices for Exchange Tab
  useEffect(() => {
    const fetchDevices = async () => {
      setIsLoadingExchangeDevices(true);
      try {
        const devs = await api.getCustomerDevices(selectedBranchId === 'ALL' ? undefined : selectedBranchId);
        setExchangeCustomerDevices(devs);
      } catch (err) {
        console.error('Failed to load customer devices for exchange tab:', err);
      } finally {
        setIsLoadingExchangeDevices(false);
      }
    };
    fetchDevices();
  }, [selectedBranchId]);

  const handlePerformExchange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!selectedDeviceForExchange) {
      alert('Please select a customer device to exchange.');
      return;
    }
    if (!exchangeNewSerial.trim() || !exchangeNewPon.trim()) {
      alert('Please enter new device serial number (SN) and PON serial number.');
      return;
    }
    const exchangeBranchId = selectedBranchId === 'ALL' ? selectedDeviceForExchange.branchId : selectedBranchId;
    const replacementDevice = customerDevices.find(
      (device) =>
        device.deviceSerial?.trim().toUpperCase() === exchangeNewSerial.trim().toUpperCase() &&
        device.ponSerial?.trim().toUpperCase() === exchangeNewPon.trim().toUpperCase() &&
        device.branchId === exchangeBranchId &&
        device.status === 'IN_STOCK' &&
        device.productName?.trim().toLowerCase() === (exchangeProductName || selectedDeviceForExchange.productName).trim().toLowerCase()
    );
    if (!replacementDevice) {
      alert('The replacement Device Serial/PON pair must match an IN_STOCK device at the selected branch.');
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
        branchId: exchangeBranchId,
      });

      const actionText =
        oldDeviceAction === 'RESTOCK'
          ? 'Old device serial restored to branch available inventory stock (+1)'
          : oldDeviceAction === 'DAMAGE'
          ? 'Old device serial moved to defective stock bin'
          : 'Old device serial marked as scrapped/disposed';

      alert(`Device Exchange Successful!\nCustomer: ${selectedDeviceForExchange.customerName}\nNew Serial: ${exchangeNewSerial.trim()}\n${actionText}`);

      setSelectedDeviceForExchange(null);
      setExchangeNewSerial('');
      setExchangeNewPon('');
      setExchangeNewMac('');
      setExchangeNotes('');

      // Refresh list
      const updatedDevs = await api.getCustomerDevices(selectedBranchId === 'ALL' ? undefined : selectedBranchId);
      setExchangeCustomerDevices(updatedDevs);
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (err: any) {
      alert(err?.message || 'Failed to exchange device.');
    } finally {
      setIsSubmittingExchange(false);
    }
  };

  const filteredExchangeDevices = exchangeCustomerDevices.filter((d) => {
    // Only RENTAL (or legacy ACTIVE) CPE products are eligible for hardware exchange
    if (d.status !== 'RENTAL' && d.status !== 'ACTIVE') return false;
    if (!exchangeSearchQuery.trim()) return true;
    const q = (exchangeSearchQuery || '').toLowerCase();
    return (
      (d?.customerName || '').toLowerCase().includes(q) ||
      (d?.customerCode || '').toLowerCase().includes(q) ||
      (d?.deviceSerial || '').toLowerCase().includes(q) ||
      (d?.ponSerial || '').toLowerCase().includes(q) ||
      (d?.productName || '').toLowerCase().includes(q) ||
      (d.contactPhone && d.contactPhone.includes(q))
    );
  });

  const filteredCustomersInAssignModal = customers.filter((c) => {
    if (!customerSearchInAssignModal.trim()) return true;
    const q = (customerSearchInAssignModal || '').toLowerCase();
    return (
      (c?.customerName || '').toLowerCase().includes(q) ||
      (c?.customerId || '').toLowerCase().includes(q) ||
      (c.contactNumber && c.contactNumber.includes(q)) ||
      (c.address && (c?.address || '').toLowerCase().includes(q))
    );
  });

  const allCombinedOps = [...operations, ...synthesizedDamageOps];

  // Filters for Stock Operations Logs
  const filteredOperations = allCombinedOps.filter((op) => {
    if (!isOpInAllowedBranch(op)) return false;

    const matchesBranch =
      branchFilter === 'ALL'
        ? true
        : op.branchId === branchFilter || op.destinationWarehouseId === branchFilter;

    if (!matchesBranch) return false;

    if (activeTab === 'PULLOUT_BINS') return op.type === 'PULLOUT';
    if (activeTab === 'DAMAGE_TRACKING') return op.type === 'DAMAGE' || op.type === 'DISPOSAL';
    if (activeTab === 'CONSUMABLE_ISSUE') return op.type === 'CONSUMABLE_ISSUE';
    if (activeTab === 'PRODUCT_SALE') return op.type === 'STOCK_OUT';
    return true;
  });

  // Available vs Assigned Fixed Assets
  const availableStockAssets = assets.filter(
    (a) => a.status === 'ACTIVE' && !a.assignedType
  );
  const assignedAssets = assets.filter(
    (a) => a.status === 'ASSIGNED_TO_LOCATION' || a.status === 'ASSIGNED_TO_CUSTOMER' || Boolean(a.assignedType)
  );

  // Catalog Products suitable for Fixed Asset & Customer Rental CPE deployment
  const catalogFixedAssetProducts = products.filter(
    (p) =>
      p.productGroup === 'Fixed Asset' ||
      (p?.category || '').toLowerCase().includes('router') ||
      (p?.category || '').toLowerCase().includes('onu') ||
      (p?.category || '').toLowerCase().includes('stb') ||
      (p?.category || '').toLowerCase().includes('equipment') ||
      (p?.name || '').toLowerCase().includes('onu') ||
      (p?.name || '').toLowerCase().includes('router')
  );

  return (
    <div className="space-y-3">
      {/* BS Calendar Gate Banner: blocks stock operations until today's BS date record exists */}
      {bsDateStatus === 'missing' && (
        <div className="p-3 rounded-2xl bg-red-500/10 border border-red-500/40 text-red-900 dark:text-red-200 flex flex-col sm:flex-row sm:items-center justify-start gap-3">
          <div className="flex items-start gap-3">
            <ShieldAlert className={`h-6 w-6 text-red-500 dark:text-red-400 flex-shrink-0 mt-0.5`} />
            <div>
              <p className="text-sm font-bold">
                BS date is not available. Please contact your system administrator for BS month seeding.
              </p>
              <p className="text-xs mt-1 opacity-90">
                Today ({bsDateCheckedFor}) has no Nepali (BS) date record in the BS calendar database (bs_day_records),
                so all stock operations (pullouts, sales, damage logs, transfers, asset assignments) are temporarily
                locked. Seed the missing BS month from <strong>System Settings &rarr; BS Calendar Utility</strong>, then re-check.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={checkBsDateAvailability}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-colors cursor-pointer flex-shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Re-check BS Date
          </button>
        </div>
      )}

      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <AlertOctagon className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
            <span>Stock Operations & Logistics Center</span>
          </h2>
          <p className="truncate text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Manage overstock pullouts, branch damage labeling, inter-branch transfers, fixed asset site assignments, and customer product sales.
          </p>
        </div>

        {/* Top Action Buttons */}
        <div className="shrink-0 flex flex-wrap items-center gap-2">
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      {!isStandalonePage && <div className={`flex items-center gap-1 border-b pb-1 overflow-x-auto border-slate-200 dark:border-slate-800`}>
        {initialType !== 'PULLOUT' && initialType !== 'DAMAGE' && initialType !== 'PULLOUT_REPORT' && initialType !== 'DAMAGE_REPORT' && (() => {
          const canPullout = isOperationAllowed('branch-pullout-dispatch', currentUser?.role);
          return (
            <button
              disabled={!canPullout}
              title={!canPullout ? 'Pullout dispatch is disabled for your role permissions' : 'Warehouse pullout dispatch'}
              onClick={() => {
                if (!canPullout) {
                  alert('Pullout dispatch operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('PULLOUT_BINS');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canPullout
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'PULLOUT_BINS'
                  ? 'bg-indigo-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canPullout ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Truck className="h-4 w-4" />}
              <span>Warehouse Pullout ({pulloutOperations.length})</span>
            </button>
          );
        })()}

        {initialType !== 'PULLOUT' && initialType !== 'DAMAGE' && initialType !== 'PULLOUT_REPORT' && initialType !== 'DAMAGE_REPORT' && (() => {
          const canDamage = isOperationAllowed('branch-damage-mark', currentUser?.role);
          return (
            <button
              disabled={!canDamage}
              title={!canDamage ? 'Damaged stock registration is disabled for your role permissions' : 'Damaged stock log'}
              onClick={() => {
                if (!canDamage) {
                  alert('Damaged stock registration operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('DAMAGE_TRACKING');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canDamage
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'DAMAGE_TRACKING'
                  ? 'bg-rose-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canDamage ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <AlertTriangle className="h-4 w-4" />}
              <span>Damaged Stock ({damageOperations.length})</span>
            </button>
          );
        })()}

        {(() => {
          const canReceive = isOperationAllowed('branch-transfer-receive', currentUser?.role);
          return (
            <button
              disabled={!canReceive}
              title={!canReceive ? 'Transfer receiving is disabled for your role permissions' : 'Receive incoming transfer shipments'}
              onClick={() => {
                if (!canReceive) {
                  alert('Transfer receiving operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('RECEIVE_TRANSFER');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canReceive
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'RECEIVE_TRANSFER'
                  ? 'bg-amber-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canReceive ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Inbox className="h-4 w-4" />}
              <span>Receive Transfer ({shipments.length})</span>
            </button>
          );
        })()}

        {(() => {
          const canCreateXfer = isOperationAllowed('branch-transfer-create', currentUser?.role);
          return (
            <button
              disabled={!canCreateXfer}
              title={!canCreateXfer ? 'Inter-branch transfer creation is disabled for your role permissions' : 'Create inter-branch stock transfer'}
              onClick={() => {
                if (!canCreateXfer) {
                  alert('Stock transfer creation operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('CREATE_TRANSFER');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canCreateXfer
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'CREATE_TRANSFER'
                  ? 'bg-sky-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canCreateXfer ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Send className="h-4 w-4" />}
              <span>Create Transfer</span>
            </button>
          );
        })()}

        {(() => {
          const canAssignAsset = isOperationAllowed('branch-asset-assign', currentUser?.role);
          return (
            <button
              disabled={!canAssignAsset}
              title={!canAssignAsset ? 'Fixed asset commissioning is disabled for your role permissions' : 'Assign fixed asset to location/customer'}
              onClick={() => {
                if (!canAssignAsset) {
                  alert('Fixed asset assignment operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('ASSIGN_ASSET');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canAssignAsset
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'ASSIGN_ASSET'
                  ? 'bg-emerald-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canAssignAsset ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Wrench className="h-4 w-4" />}
              <span>Assign Fixed Asset ({availableStockAssets.length} Avail)</span>
            </button>
          );
        })()}

        {(() => {
          return (
            <button
              title="Issue Consumables (Splitters, Protection Sleeves, Couplers, Fast Connectors) to Field Technicians"
              onClick={() => setActiveTab('CONSUMABLE_ISSUE')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${activeTab === 'CONSUMABLE_ISSUE' ? 'bg-amber-600 text-white shadow-sm cursor-pointer' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'}`}
            >
              <Wrench className="h-4 w-4 text-amber-300" />
              <span>Issue Consumables ({consumableOperations.length})</span>
            </button>
          );
        })()}

        {(() => {
          return (
            <button
              title="Consumables Register — log of every consumable issue with per-line POP/customer destinations"
              onClick={() => setActiveTab('CONSUMABLES_REGISTER')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${activeTab === 'CONSUMABLES_REGISTER' ? 'bg-amber-600 text-white shadow-sm cursor-pointer' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'}`}
            >
              <ClipboardList className="h-4 w-4 text-amber-300" />
              <span>Consumables Register</span>
            </button>
          );
        })()}

        {(() => {
          const canSale = isOperationAllowed('stock-out', currentUser?.role);
          return (
            <button
              disabled={!canSale}
              title={!canSale ? 'Product sales operation is disabled for your role permissions' : 'Direct retail product item sale'}
              onClick={() => {
                if (!canSale) {
                  alert('Product sale operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('PRODUCT_SALE');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canSale
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'PRODUCT_SALE'
                  ? 'bg-purple-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canSale ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <PackageMinus className="h-4 w-4" />}
              <span>Product Sale ({saleOperations.length})</span>
            </button>
          );
        })()}

        <button
          onClick={() => setActiveTab('DEVICE_EXCHANGE')}
          title="Exchange customer ONU/STB device, enter replacement serials, and return old unit to stock"
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${activeTab === 'DEVICE_EXCHANGE' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <RefreshCw className="h-4 w-4 text-indigo-300" />
          <span>Device Exchange ({exchangeCustomerDevices.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('LOGS')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${activeTab === 'LOGS' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <Package className="h-4 w-4" />
          <span>Logs ({operations.length})</span>
        </button>
      </div>}

      {/* ------------------------------------------------------------- */}
      {/* TAB 1: PULLOUT BINS (Warehouse Return) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'PULLOUT_BINS' && (
        <div className="space-y-3">
          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <Truck className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                <span>Overstock & Damaged Stock Warehouse Pullout Dispatches</span>
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                Showing {filteredOperations.length} dispatches
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredOperations.map((op) => (
                <div
                  key={op.id}
                  className={`p-4 rounded-xl border flex flex-col justify-between space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className={`font-mono text-xs font-bold text-indigo-600 dark:text-indigo-400`}>
                        {op.referenceNumber}
                      </span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30`}>
                        {op.status || 'DISPATCHED'}
                      </span>
                    </div>

                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Source: {op.branchName || op.branchId} → Warehouse: {op.destinationWarehouseName || 'Central Hub'}
                    </div>

                    <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{op.reason}</p>

                    {op.items && op.items.length > 0 && (
                      <div className="mt-2 text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-white/50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/50 dark:border-slate-700/50">
                        <span className="font-bold">Contents: </span>
                        {op.items.map((i) => `${i.productName} (${i.quantity} ${i.unit || 'pcs'} - ${i.condition})`).join(', ')}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200 dark:border-slate-800">
                    <span className="text-slate-400 font-mono text-[11px]">{op.dateAD}</span>
                    <div className="flex items-center gap-2">
                      <span className={`font-bold font-mono text-indigo-600 dark:text-indigo-400`}>
                        {formatNPR(op.totalValue)}
                      </span>
                      {op.status !== 'RECEIVED' && isOperationAllowed('wh-receive-pullouts', currentUser?.role) && onReceiveOperation && (
                        <button
                          onClick={async () => {
                            if (await confirmDialog(`Confirm receipt of Pullout Bin ${op.referenceNumber} into Warehouse Stock?`)) {
                              await onReceiveOperation(op.id);
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 text-white font-bold text-[10px] hover:bg-indigo-500 shadow-xs cursor-pointer"
                        >
                          Receive at WH001
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 2: DAMAGED STOCK LABELING & TRACKING */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'DAMAGE_TRACKING' && (
        <div className="space-y-3">
          {!isSuperOrInventory && (
            <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-center gap-2.5 text-xs font-medium">
              <ShieldAlert className={`h-5 w-5 flex-shrink-0 text-amber-500 dark:text-amber-400`} />
              <span>
                <strong>Branch Role Restriction Active:</strong> As a branch user, you can label damaged stock exclusively for your assigned branch stock. Super Admins and Inventory Controllers can manage damage across all branches.
              </span>
            </div>
          )}

          {/* KPI Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className={`p-3.5 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
              <div className="text-xs font-semibold text-slate-500 mb-1">Total Damaged Log Records</div>
              <div className={`text-xl font-bold font-mono text-rose-600 dark:text-rose-400`}>
                {filteredOperations.length} Records
              </div>
            </div>
            <div className={`p-3.5 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
              <div className="text-xs font-semibold text-slate-500 mb-1">Total Damaged Stock Units</div>
              <div className={`text-xl font-bold font-mono text-amber-600 dark:text-amber-400`}>
                {filteredOperations.reduce((sum, op) => sum + Math.abs(op.quantityChanged || 1), 0)} Pcs
              </div>
            </div>
            <div className={`p-3.5 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
              <div className="text-xs font-semibold text-slate-500 mb-1">Total Estimated Loss Valuation</div>
              <div className={`text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400`}>
                {formatNPR(filteredOperations.reduce((sum, op) => sum + (op.totalValue || 0), 0))}
              </div>
            </div>
          </div>

          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <AlertTriangle className={`h-4 w-4 text-rose-500 dark:text-rose-400`} />
                <span>Locally Tagged Damaged Stock Logs</span>
              </h3>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-1.5">Reference #</th>
                    <th className="px-2.5 py-1.5">Op Type</th>
                    <th className="px-2.5 py-1.5">Branch</th>
                    <th className="px-2.5 py-1.5">Product Name</th>
                    <th className="px-2.5 py-1.5">Qty</th>
                    <th className="px-2.5 py-1.5">Valuation</th>
                    <th className="px-2.5 py-1.5">Reason & Method</th>
                    <th className="px-2.5 py-1.5">Inspector / Officer</th>
                    <th className="px-2.5 py-1.5">Actions</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                  {filteredOperations.map((op) => (
                    <tr key={op.id} className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 ${op.status === 'CANCELLED' ? 'opacity-60' : ''}`}>
                      <td className={`p-2.5 font-mono font-bold text-rose-600 dark:text-rose-400`}>{op.referenceNumber}</td>
                      <td className="p-2.5">
                        {op.type === 'DISPOSAL' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-rose-600 text-white shadow-xs">
                            🔥 DISPOSAL
                          </span>
                        ) : op.status === 'CANCELLED' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-slate-600 text-white shadow-xs">
                            <Undo2 className="h-3 w-3" />
                            REVERSED
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30`}>
                            ⚠️ DAMAGED
                          </span>
                        )}
                      </td>
                      <td className="p-2.5 font-semibold text-slate-800 dark:text-slate-200">{op.branchId}</td>
                      <td className="p-2.5 font-medium text-slate-900 dark:text-white">{op.productName}</td>
                      <td className={`p-2.5 font-mono font-bold text-rose-600 dark:text-rose-400`}>{Math.abs(op.quantityChanged || 1)} Pcs</td>
                      <td className="p-2.5 font-mono font-bold text-slate-800 dark:text-slate-200">
                        <div>{formatNPR(op.totalValue)}</div>
                        {op.netWriteOffLoss !== undefined && (
                          <div className={`text-[10px] font-normal text-rose-500 dark:text-rose-400`}>
                            Net Loss: {formatNPR(op.netWriteOffLoss)}
                          </div>
                        )}
                      </td>
                      <td className="p-2.5 text-slate-500 text-[11px]">{op.reason}</td>
                      <td className="p-2.5 font-medium text-slate-600 dark:text-slate-400">{op.inspectorName}</td>
                      <td className="p-2.5">
                        {op.status === 'CANCELLED' ? (
                          <div className="text-[9px] font-semibold text-slate-400 leading-tight">
                            <div>Reversed by {op.reversedBy || 'Admin'}</div>
                            {op.reversedAtAD && <div>{op.reversedAtAD}</div>}
                          </div>
                        ) : isReversibleDamageOp(op) && canReverseDamage ? (
                          <button
                            type="button"
                            title="Reverse this damage entry (restores units to available stock)"
                            onClick={() => handleReverseDamageRecord(op)}
                            className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/40 text-amber-700 dark:text-amber-300 px-2 py-1 text-[10px] font-bold transition-colors cursor-pointer"
                          >
                            <Undo2 className="h-3.5 w-3.5" />
                            Reverse
                          </button>
                        ) : (
                          <span className="text-[10px] italic text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 3: RECEIVE TRANSFER */}
      {/* ------------------------------------------------------------- */}
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

      {/* ------------------------------------------------------------- */}
      {/* ------------------------------------------------------------- */}
      {/* TAB 4: CREATE TRANSFER (Multi-Item Inter-Branch Dispatch) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'CREATE_TRANSFER' && (
        <FormCard className="space-y-4">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-serif font-bold flex items-center gap-2">
              <Send className="h-5 w-5 text-sky-500" />
              <span>Create Inter-Branch Multi-Stock Transfer Dispatch</span>
            </h3>
            <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-200 border border-sky-200 dark:border-sky-800">
              Inter-Branch Shipment GRN
            </span>
          </div>

          <form onSubmit={handleSubmitCreateTransfer} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold mb-1">Source Dispatch Branch *</label>
                <select
                  value={xferSourceBranchId}
                  onChange={(e) => setXferSourceBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches
                    .filter((b) => (isWarehouseOrHeadOffice(b) ? canDispatchFromWarehouse : true))
                    .map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Destination Receiving Branch *</label>
                <select
                  value={xferDestBranchId}
                  onChange={(e) => setXferDestBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {branches
                    .filter((b) => {
                      const srcBranch = branches.find((s) => s.id === xferSourceBranchId || s.code === xferSourceBranchId);
                      const warehouseOrigin = isWarehouseOrHeadOffice(srcBranch);
                      return (
                        b.id !== xferSourceBranchId &&
                        !b.isWarehouse &&
                        !b.isHeadquarters &&
                        b.id !== 'WH001' &&
                        !b.code.toUpperCase().startsWith('WH') &&
                        !(b?.name || '').toLowerCase().includes('warehouse') &&
                        !(b?.name || '').toLowerCase().includes('head office') &&
                        !(b?.name || '').toLowerCase().includes('central') &&
                        (!warehouseOrigin || b.allowWarehouseTransfer !== false)
                      );
                    })
                    .map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                </select>
                {(() => {
                  const srcBranch = branches.find((s) => s.id === xferSourceBranchId || s.code === xferSourceBranchId);
                  if (isWarehouseOrHeadOffice(srcBranch)) {
                    return (
                      <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        Warehouse dispatch: destination limited to branches with warehouse-transfer receiving enabled.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            {/* Multi-Item Transfer Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddTransferItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU to Add to Transfer..."
                  inputId="transfer-product-search-input"
                  stock={stock}
                  selectedBranchId={xferSourceBranchId}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Transfer Line Items ({transferItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddTransferItem()}
                  className="px-3 py-1 rounded-lg bg-sky-600 text-white font-bold text-[11px] hover:bg-sky-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Line Item</span>
                </button>
              </div>

              {transferItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <Package className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No stock items added to this inter-branch transfer yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddTransferItem()}
                    className={`mt-2 text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add products to transfer
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Product SKU & Name</th>
                        <th className="px-2.5 py-1.5 text-center">Branch Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Transfer Qty</th>
                        <th className="px-2.5 py-1.5 min-w-[280px]">Serials & PON Scanning</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {transferItems.map((item, idx) => {
                        const prod = products.find((p) => p.id === item.productId);
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === xferSourceBranchId);
                        const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5">
                              <div className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                                <Package className="h-4 w-4 text-sky-500 shrink-0" />
                                <span>{item.productName || prod?.name || 'Stock Item'}</span>
                              </div>
                              <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
                                <span>SKU: {item.sku || prod?.sku || 'N/A'}</span>
                                <span className="text-slate-300 dark:text-slate-700">•</span>
                                <span>Unit: {item.unit || prod?.unit || 'Pcs'}</span>
                              </div>
                            </td>

                            <td className="p-2.5 text-center font-mono font-bold text-slate-500">
                              {stk?.quantityOnHand || 0} {item.unit}
                            </td>

                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                required
                                value={item.quantitySent}
                                onChange={(e) => handleUpdateTransferItem(item.id, { quantitySent: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5">
                              {isSerialized ? (
                                <div className="space-y-1.5">
                                  <span className={`text-[10px] text-sky-600 dark:text-sky-400 font-bold block`}>
                                    ✓ Scan Serials for {item.productName} ({item.quantitySent} Unit{item.quantitySent > 1 ? 's' : ''})
                                  </span>
                                  {Array.from({ length: item.quantitySent }).map((_, sIdx) => (
                                    <div key={sIdx} className="bg-sky-50/50 dark:bg-sky-950/40 p-1.5 rounded-lg border border-sky-200 dark:border-sky-800 flex items-center gap-1.5 text-xs">
                                      <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                      <input
                                        id={`transfer-serial-device-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="Device Serial #"
                                        value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                        onChange={(e) => updateTransferDeviceSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const nextEl = document.getElementById(`transfer-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                            if (nextEl) {
                                              nextEl.focus();
                                              if ('select' in nextEl) nextEl.select();
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-sky-500 text-sky-900 bg-white border-sky-300 dark:text-sky-200 dark:bg-slate-800 dark:border-sky-700 `}
                                      />
                                      <input
                                        id={`transfer-serial-pon-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="PON Serial #"
                                        value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                        onChange={(e) => updateTransferPonSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (sIdx + 1 < item.quantitySent) {
                                              const nextDev = document.getElementById(`transfer-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                              if (nextDev) {
                                                nextDev.focus();
                                                if ('select' in nextDev) nextDev.select();
                                              }
                                            } else {
                                              const searchInput = document.getElementById('transfer-product-search-input') as HTMLInputElement;
                                              if (searchInput) {
                                                searchInput.focus();
                                                if ('select' in searchInput) searchInput.select();
                                              }
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 text-indigo-900 bg-white border-indigo-300 dark:text-indigo-200 dark:bg-slate-800 dark:border-indigo-700`}
                                      />
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-slate-400 italic text-[11px]">Non-serialized bulk product</span>
                              )}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveTransferItem(item.id)}
                                className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <label className="block font-bold mb-1">Dispatch Notes / Courier Reference</label>
              <textarea
                rows={2}
                value={xferNotes}
                onChange={(e) => setXferNotes(e.target.value)}
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetTransferForm}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-sky-600 text-white font-bold hover:bg-sky-500 shadow-md flex items-center gap-2 cursor-pointer"
              >
                <Send className="h-4 w-4" />
                <span>Dispatch Multi-Item Transfer Shipment</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 5: ASSIGN FIXED ASSET (Locations & Customer Sites) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'ASSIGN_ASSET' && (
        <div className="space-y-3">
          <div className="p-3.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-800 dark:text-indigo-300 flex items-center justify-between text-xs font-medium">
            <div className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-indigo-500 flex-shrink-0" />
              <span>
                <strong>Fixed Asset Location & Customer Assignment:</strong> Fixed Assets & CPE Devices (Routers/ONUs/STBs) deployed in POP Server Rooms, Fiber Network Nodes, or Customer Sites are assigned directly to their operational location or rented to customers and managed as depreciable assets.
              </span>
            </div>
          </div>

          {/* Section A: Catalog Routers, ONUs & Fixed Asset Products (Deploy from Available Inventory) */}
          <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-bold text-sm flex items-center gap-2 text-slate-900 dark:text-white`}>
                <Wifi className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                <span>Product Catalog: Routers, ONUs & Fixed Assets for Rental CPE Deployment ({catalogFixedAssetProducts.length})</span>
              </h3>
              <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-800">
                Deploy / Rent Product Item
              </span>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              Items defined with Product Group <strong>"Fixed Asset"</strong> or ONU/Router hardware can be directly deployed to customer homes as Rental CPEs or assigned to POP network locations.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[320px] overflow-y-auto pr-1">
              {catalogFixedAssetProducts.length === 0 ? (
                <p className="text-xs text-slate-400 p-4 text-center col-span-3">No Fixed Asset or ONU Router products found in product catalog.</p>
              ) : (
                catalogFixedAssetProducts.map((prod) => {
                  const branchStock = stock.filter((s) => s.productId === prod.id);
                  const totalOnHand = branchStock.reduce((acc, s) => acc + s.quantityOnHand, 0);

                  return (
                    <div
                      key={prod.id}
                      className={`p-3.5 rounded-2xl border flex flex-col justify-between transition-all hover:border-indigo-500/50 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono font-bold text-slate-400">{prod.sku}</span>
                          <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-md ${
                            prod.productGroup === 'Fixed Asset'
                              ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                          }`}>
                            {prod.productGroup || 'Product / Rental'}
                          </span>
                        </div>
                        <h4 className="font-bold text-xs text-slate-900 dark:text-white mt-1 line-clamp-1">{prod.name}</h4>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          Cost: {formatNPR(prod.costPrice)} | Cat: {prod.category}
                        </p>
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <span className={`text-[10px] font-bold text-emerald-600 dark:text-emerald-400 font-mono`}>
                          Stock: {totalOnHand} Pcs
                        </span>
                        <button
                          onClick={() => handleOpenProductAssignModal(prod)}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold shadow-xs cursor-pointer"
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          <span>Assign / Rent CPE</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Available Fixed Assets in Stock */}
            <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
              <h3 className={`font-bold text-sm mb-3 flex items-center justify-between text-slate-900 dark:text-white`}>
                <span className="flex items-center gap-2">
                  <Package className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
                  <span>Available Fixed Assets in Stock ({availableStockAssets.length})</span>
                </span>
                <span className={`text-[10px] text-emerald-600 dark:text-emerald-400 font-mono font-bold`}>Unassigned</span>
              </h3>

              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {availableStockAssets.length === 0 ? (
                  <p className="text-xs text-slate-400 p-6 text-center">No unassigned fixed assets available in stock.</p>
                ) : (
                  availableStockAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className={`p-3 rounded-xl border flex items-center justify-between gap-2 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                    >
                      <div>
                        <span className={`text-[10px] font-mono font-bold text-indigo-600 dark:text-indigo-400 block`}>
                          Tag: {asset.tagNumber}
                        </span>
                        <h4 className="font-bold text-xs text-slate-900 dark:text-white line-clamp-1">{asset.name}</h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          Cost: {formatNPR(asset.acquisitionCost)} | Category: {asset.category}
                        </p>
                      </div>

                      <button
                        onClick={() => handleOpenAssignModal(asset)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-500 shadow-xs cursor-pointer flex-shrink-0"
                      >
                        <Wrench className="h-3.5 w-3.5" />
                        <span>Assign Asset</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Assigned Fixed Assets Register */}
            <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
              <h3 className={`font-bold text-sm mb-3 flex items-center justify-between text-slate-900 dark:text-white`}>
                <span className="flex items-center gap-2">
                  <MapPin className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                  <span>Assigned & Deployed Fixed Assets ({assignedAssets.length})</span>
                </span>
                <span className={`text-[10px] text-indigo-600 dark:text-indigo-400 font-mono font-bold`}>In-Use / Installed</span>
              </h3>

              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {assignedAssets.length === 0 ? (
                  <p className="text-xs text-slate-400 p-6 text-center">No assigned assets logged yet.</p>
                ) : (
                  assignedAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className={`p-3 rounded-xl border flex flex-col justify-between space-y-2 bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className={`text-[10px] font-mono font-bold text-indigo-600 dark:text-indigo-400 block`}>
                            Tag: {asset.tagNumber}
                          </span>
                          <h4 className="font-bold text-xs text-slate-900 dark:text-white">{asset.name}</h4>
                        </div>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/30`}>
                          {asset.assignedType === 'LOCATION' ? 'POP / Node Site' : 'Customer Site'}
                        </span>
                      </div>

                      <div className="p-2 rounded-lg bg-white/60 dark:bg-slate-800/60 border border-slate-200/60 text-xs space-y-0.5">
                        <div className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1">
                          <MapPin className={`h-3 w-3 text-indigo-500 dark:text-indigo-400`} />
                          <span>
                            {asset.assignedType === 'LOCATION'
                              ? asset.assignedLocationName || asset.assignedLocationId
                              : asset.assignedCustomerName || asset.assignedCustomerId}
                          </span>
                        </div>
                        {asset.assignmentNotes && (
                          <div className="text-[10px] text-slate-400 italic">{asset.assignmentNotes}</div>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-1 text-[10px]">
                        <span className="text-slate-400 font-mono">Assigned: {asset.assignmentDateAD || '2026-08-01'}</span>
                        <button
                          onClick={() => handleUnassignAsset(asset)}
                          className={`text-rose-600 dark:text-rose-400 dark:text-rose-400 hover:underline font-bold cursor-pointer`}
                        >
                          Unassign / Return to Stock
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 6: CONSUMABLE ISSUE TO TECHNICIAN / FIELD USAGE */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'CONSUMABLE_ISSUE' && (
        <FormCard className="space-y-4">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-serif font-bold flex items-center gap-2">
              <Wrench className={`h-5 w-5 text-amber-500 dark:text-amber-400`} />
              <span>Issue Consumable Items (Splitter, Sleeve, Coupler, Fast Connector)</span>
            </h3>
            <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              Quantity Store Requisition
            </span>
          </div>

          <form onSubmit={handleSubmitConsumableIssue} className="space-y-4 text-xs">
            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-[11px] leading-relaxed">
              <strong>Consumables Operational Rule:</strong> Field materials (Splitters, Protection Sleeves, Couplers, Fast Connectors, Patch Cords, Drop Clamps) do NOT carry individual serial numbers. Issuing deducts store stock directly and logs the assigned field technician and work order ticket.
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-bold mb-1">Source Store Branch *</label>
                <select
                  value={consumableBranchId}
                  onChange={(e) => setConsumableBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Field Technician Name *</label>
                <input
                  type="text"
                  required
                  value={consumableTechnician}
                  onChange={(e) => setConsumableTechnician(e.target.value)}
                  placeholder="e.g. Ram Bahadur (Splicing Tech)"
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div>
                <label className="block font-bold mb-1">Work Order / Ticket Ref *</label>
                <input
                  type="text"
                  required
                  value={consumableWorkOrder}
                  onChange={(e) => setConsumableWorkOrder(e.target.value)}
                  placeholder="e.g. WO-2081-SPLIT-04"
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>
            </div>

            {/* Multi-Item Consumables Requisition Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Consumable Material / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddConsumableItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Consumable Product / SKU to Issue..."
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Consumable Material Line Items ({consumableItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddConsumableItem()}
                  className="px-3 py-1 rounded-lg bg-amber-600 text-white font-bold text-[11px] hover:bg-amber-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Material Line Item</span>
                </button>
              </div>

              {consumableItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <Wrench className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No consumable materials added to this requisition form yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddConsumableItem()}
                    className={`mt-2 text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add consumable products to issue
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Consumable Material</th>
                        <th className="px-2.5 py-1.5 text-center">Store Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Issue Qty</th>
                        <th className="px-2.5 py-1.5">Used At (POP / Customer)</th>
                        <th className="px-2.5 py-1.5">Remarks</th>
                        <th className="px-2.5 py-1.5 text-right">Unit Cost (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Total Cost (NPR)</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {consumableItems.map((item) => {
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === consumableBranchId);

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5">
                              <select
                                value={item.productId}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { productId: e.target.value })}
                                className={`w-full rounded-lg border p-1.5 font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    [{p.sku}] {p.name} ({p.unit})
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td className="p-2.5 text-center font-mono font-bold text-slate-500">
                              {stk?.quantityOnHand || 0} {item.unit}
                            </td>

                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                required
                                value={item.quantity}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            {/* Per-line Used-At destination: Field / POP Location / Customer */}
                            <td className="p-2.5">
                              <div className="space-y-1 min-w-[180px]">
                                <select
                                  value={item.usedAtType || 'FIELD'}
                                  onChange={(e) => {
                                    const t = e.target.value as ConsumableIssueItem['usedAtType'];
                                    handleUpdateConsumableItem(item.id, {
                                      usedAtType: t,
                                      usedAtLocationId: t === 'POP' ? item.usedAtLocationId : undefined,
                                      usedAtLocationName: t === 'POP' ? item.usedAtLocationName : undefined,
                                      usedAtCustomerId: t === 'CUSTOMER' ? item.usedAtCustomerId : undefined,
                                      usedAtCustomerName: t === 'CUSTOMER' ? item.usedAtCustomerName : undefined,
                                    });
                                  }}
                                  className={`w-full rounded-lg border p-1 text-[10px] font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                >
                                  <option value="FIELD">Field / Work Order</option>
                                  <option value="POP">POP Location</option>
                                  <option value="CUSTOMER">Customer</option>
                                </select>
                                {item.usedAtType === 'POP' && (
                                  <select
                                    value={item.usedAtLocationId || ''}
                                    onChange={(e) => {
                                      const loc = locations.find((l) => l.id === e.target.value);
                                      handleUpdateConsumableItem(item.id, {
                                        usedAtLocationId: loc?.id,
                                        usedAtLocationName: loc?.name,
                                      });
                                    }}
                                    className={`w-full rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                  >
                                    <option value="">Select POP location...</option>
                                    {locations
                                      .filter((l) => l.type === 'POP_SERVER_ROOM' || l.type === 'FIBER_NETWORK_NODE' || !l.type)
                                      .map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name}{l.address ? ` — ${l.address}` : ''}
                                        </option>
                                      ))}
                                  </select>
                                )}
                                {item.usedAtType === 'CUSTOMER' && (
                                  <select
                                    value={item.usedAtCustomerId || ''}
                                    onChange={(e) => {
                                      const cust = customers.find((c) => c.id === e.target.value);
                                      handleUpdateConsumableItem(item.id, {
                                        usedAtCustomerId: cust?.id,
                                        usedAtCustomerName: cust ? `${cust.customerName} (${cust.customerId})` : undefined,
                                      });
                                    }}
                                    className={`w-full rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                  >
                                    <option value="">Select customer...</option>
                                    {customers.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.customerName} ({c.customerId})
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            </td>

                            {/* Per-line remarks */}
                            <td className="p-2.5">
                              <input
                                type="text"
                                value={item.remarks || ''}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { remarks: e.target.value })}
                                placeholder="Circuit ID, notes..."
                                className={`w-full min-w-[120px] rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right font-mono text-slate-500">
                              {formatNPR(item.unitCost)}
                            </td>

                            <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                              {formatNPR(item.totalValue)}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveConsumableItem(item.id)}
                                className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <label className="block font-bold mb-1">Field Usage Description / Notes</label>
              <textarea
                rows={2}
                value={consumableReason}
                onChange={(e) => setConsumableReason(e.target.value)}
                placeholder="Reason or site location for material issue..."
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleResetConsumableForm}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="flex-1 py-3 rounded-xl font-bold text-xs text-white bg-amber-600 hover:bg-amber-500 shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <Wrench className="h-4 w-4" />
                <span>Record Multi-Item Consumable Issue & Deduct Stock</span>
              </button>
            </div>
          </form>

          {/* Table of Issued Consumables */}
          <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800">
            <h4 className="text-sm font-bold flex items-center gap-2 mb-3">
              <ClipboardList className={`h-4 w-4 text-amber-500 dark:text-amber-400`} />
              <span>Logged Consumable Field Issues ({consumableOperations.length})</span>
            </h4>

            {consumableOperations.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-3">No consumable field issues recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                    <tr>
                      <th className="px-2.5 py-1.5">Date</th>
                      <th className="px-2.5 py-1.5">Ref / WO</th>
                      <th className="px-2.5 py-1.5">Branch</th>
                      <th className="px-2.5 py-1.5">Consumable Material</th>
                      <th className="px-2.5 py-1.5 text-center">Qty Issued</th>
                      <th className="px-2.5 py-1.5">Technician</th>
                      <th className="px-2.5 py-1.5 text-right">Value (NPR)</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                    {consumableOperations.map((op) => (
                      <tr key={op.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                        <td className="p-2.5 font-mono text-slate-400 text-[11px]">{op.dateAD}</td>
                        <td className={`p-2.5 font-mono font-bold text-amber-600 dark:text-amber-400`}>{op.workOrderRef || op.referenceNumber}</td>
                        <td className="p-2.5 font-medium">{op.branchName || op.branchId}</td>
                        <td className="p-2.5 font-bold text-slate-900 dark:text-white">{op.productName || (op.items && op.items[0]?.productName) || 'Multiple Line Items'}</td>
                        <td className={`p-2.5 text-center font-mono font-bold text-rose-600 dark:text-rose-400`}>
                          {Math.abs(op.quantityChanged || (op.items ? op.items.reduce((s,i)=>s+i.quantity,0) : 1))} Pcs
                        </td>
                        <td className="p-2.5 font-medium text-slate-700 dark:text-slate-300">{op.technicianName || 'N/A'}</td>
                        <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                          {formatNPR(op.totalValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </FormCard>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 6b: CONSUMABLES REGISTER (Serial-Log-Register style ledger) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'CONSUMABLES_REGISTER' && (
        <div className="rounded-2xl border p-4 shadow-sm bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-serif font-bold flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-amber-500" />
              <span>Consumables Issue Register</span>
            </h3>
            <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              {consumableRegisterOps.length} Record(s)
            </span>
          </div>

          {/* Toolbar: shared inline FilterCard (search + branch/status/dates) */}
          <div className="mb-2">
            <FilterCard
              searchPlaceholder="Search reference, technician, work order, product, POP location or customer..."
              searchValue={consumableRegisterQuery}
              onSearchApply={setConsumableRegisterQuery}
              hasActiveFilters={
                Boolean(consumableRegisterQuery) || consumableRegisterBranch !== 'ALL' || consumableRegisterStatus !== 'ALL' ||
                Boolean(consumableRegisterDateFrom) || Boolean(consumableRegisterDateTo)
              }
              onClearAll={() => {
                setConsumableRegisterQuery('');
                setConsumableRegisterBranch('ALL');
                setConsumableRegisterStatus('ALL');
                setConsumableRegisterDateFrom('');
                setConsumableRegisterDateTo('');
              }}
              filterChildren={
                <>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
                    <select
                      value={consumableRegisterBranch}
                      onChange={(e) => setConsumableRegisterBranch(e.target.value)}
                      className={`w-44 rounded-xl border px-3 py-2 text-xs font-semibold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white cursor-pointer`}
                    >
                      <option value="ALL">All Branches</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Status</label>
                    <select
                      value={consumableRegisterStatus}
                      onChange={(e) => setConsumableRegisterStatus(e.target.value)}
                      className={`w-36 rounded-xl border px-3 py-2 text-xs font-semibold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white cursor-pointer`}
                    >
                      <option value="ALL">All Statuses</option>
                      <option value="LOGGED">Logged</option>
                      <option value="CANCELLED">Reversed</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Issue Date From</label>
                    <div className="w-40">
                      <DateField
                        mode={dateMode}
                        value={consumableRegisterDateFrom}
                        onChange={setConsumableRegisterDateFrom}
                        compact
                        showHint={false}
                        max={consumableRegisterDateTo || undefined}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Issue Date To</label>
                    <div className="w-40">
                      <DateField
                        mode={dateMode}
                        value={consumableRegisterDateTo}
                        onChange={setConsumableRegisterDateTo}
                        compact
                        showHint={false}
                        min={consumableRegisterDateFrom || undefined}
                      />
                    </div>
                  </div>
                </>
              }
              rightChildren={
                <button
                  type="button"
                  onClick={() =>
                    exportToCSV(
                  'Consumables_Issue_Register',
                  consumableRegisterOps.map((op) => ({
                    referenceNumber: op.referenceNumber,
                    dateAD: op.dateAD,
                    dateBS: op.dateBS,
                    branchId: op.branchId,
                    technician: op.technicianName || '',
                    workOrder: op.workOrderRef || '',
                    itemCount: (op.items || []).length,
                    totalValue: op.totalValue,
                    status: op.status || 'LOGGED',
                    reason: op.reason,
                  })),
                  [
                    { key: 'referenceNumber', label: 'Reference #' },
                    { key: 'dateAD', label: 'Date (AD)' },
                    { key: 'dateBS', label: 'Date (BS)' },
                    { key: 'branchId', label: 'Branch' },
                    { key: 'technician', label: 'Field Technician' },
                    { key: 'workOrder', label: 'Work Order' },
                    { key: 'itemCount', label: 'Line Items' },
                    { key: 'totalValue', label: 'Total Value (NPR)' },
                    { key: 'status', label: 'Status' },
                    { key: 'reason', label: 'Remarks / Reason' },
                  ]
                  )
                }
                className="px-3 py-2 rounded-xl border text-xs font-bold bg-white border-slate-300 text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
              >
                <Download className="h-4 w-4" />
                <span>Export CSV</span>
              </button>
              }
            />
          </div>

          {consumableRegisterOps.length === 0 ? (
            <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
              <ClipboardList className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
              <p>No consumable issue records match the current filters.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
              <table className="w-full text-left text-xs">
                <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                  <tr>
                    <th className="px-2.5 py-2 w-8"></th>
                    <th className="px-2.5 py-2">Date</th>
                    <th className="px-2.5 py-2">Reference #</th>
                    <th className="px-2.5 py-2">Product(s) / Used Location / Customer</th>
                    <th className="px-2.5 py-2 text-center">Quantity</th>
                    <th className="px-2.5 py-2">Field Technician</th>
                    <th className="px-2.5 py-2">Remarks</th>
                    <th className="px-2.5 py-2 text-right">Value (NPR)</th>
                    <th className="px-2.5 py-2 text-center">Status</th>
                    <th className="px-2.5 py-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                  {consumableRegisterOps.map((op) => {
                    const items = (op.items || []) as ConsumableIssueItem[];
                    const isReversed = op.status === 'CANCELLED';
                    const canReverseHere =
                      isOperationAllowed('consumable-issue-reverse', currentUser?.role) &&
                      !isReversed &&
                      !op.id.startsWith('syn-');
                    const isExpanded = consumableRegisterExpandedId === op.id;

                    return (
                      <React.Fragment key={op.id}>
                        <tr className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 ${isReversed ? 'opacity-60' : ''}`}>
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => setConsumableRegisterExpandedId(isExpanded ? null : op.id)}
                              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                              title={isExpanded ? 'Collapse line items' : 'Expand line items'}
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </button>
                          </td>
                          <td className="p-2.5 font-mono text-slate-400 text-[11px] whitespace-nowrap">
                            {dateMode === 'BS' ? op.dateBS : op.dateAD}
                          </td>
                          <td className="p-2.5 font-mono font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">{op.referenceNumber}</td>
                          <td className="p-2.5 font-medium text-slate-900 dark:text-white">
                            {items.length === 1
                              ? items[0].productName
                              : `${items.length} line items — ${items[0]?.productName || 'Multiple'}${items.length > 1 ? ' + more' : ''}`}
                          </td>
                          <td className="p-2.5 text-center font-mono font-bold text-rose-600 dark:text-rose-400">
                            -{items.reduce((s, i) => s + (Number(i.quantity) || 0), 0)}
                          </td>
                          <td className="p-2.5 font-medium text-slate-700 dark:text-slate-300">{op.technicianName || 'N/A'}</td>
                          <td className="p-2.5 text-slate-500 dark:text-slate-400 max-w-[220px] truncate" title={op.reason}>{op.workOrderRef || op.reason}</td>
                          <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">{formatNPR(op.totalValue)}</td>
                          <td className="p-2.5 text-center">
                            {isReversed ? (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400" title={`Reversed by ${op.reversedBy || '—'}: ${op.reversalReason || ''}`}>
                                Reversed
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                                Logged
                              </span>
                            )}
                          </td>
                          <td className="p-2.5 text-center">
                            {canReverseHere ? (
                              <button
                                type="button"
                                onClick={() => handleReverseConsumableIssue(op)}
                                className="px-2.5 py-1 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-bold text-[10px] cursor-pointer flex items-center gap-1 mx-auto"
                                title="Reverse this consumable issue — return units to branch stock"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>Reverse</span>
                              </button>
                            ) : (
                              <span className="text-[10px] text-slate-400">—</span>
                            )}
                          </td>
                        </tr>

                        {/* Expanded per-line detail: product / used-at / remarks */}
                        {isExpanded && (
                          <tr className="bg-slate-50 dark:bg-slate-900/60">
                            <td colSpan={10} className="px-6 py-3">
                              <div className="space-y-1.5">
                                {items.map((item) => (
                                  <div key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] border-b border-dashed border-slate-200 dark:border-slate-800 pb-1.5 last:border-0">
                                    <span className="font-bold text-slate-800 dark:text-slate-200">[{item.sku}] {item.productName}</span>
                                    <span className="font-mono text-slate-500">× {item.quantity} {item.unit || ''}</span>
                                    <span className="font-mono">{formatNPR(item.totalValue)}</span>
                                    {item.usedAtType === 'POP' && item.usedAtLocationName && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-semibold">
                                        POP: {item.usedAtLocationName}
                                      </span>
                                    )}
                                    {item.usedAtType === 'CUSTOMER' && item.usedAtCustomerName && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold">
                                        Customer: {item.usedAtCustomerName}
                                      </span>
                                    )}
                                    {item.usedAtType === 'FIELD' && (
                                      <span className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 font-semibold">
                                        Field / Work Order
                                      </span>
                                    )}
                                    {item.remarks && <span className="text-slate-400 italic">“{item.remarks}”</span>}
                                  </div>
                                ))}
                                {isReversed && op.reversalReason && (
                                  <p className="text-[11px] text-rose-500 pt-1">
                                    Reversed by {op.reversedBy || '—'} on {op.reversedAtAD || '—'}: {op.reversalReason}
                                  </p>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 7: PRODUCT SALE TO CUSTOMER (Multi-Item Sales Invoice) */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'PRODUCT_SALE' && (
        <FormCard className="space-y-4">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-base font-serif font-bold flex items-center gap-2">
              <PackageMinus className="h-5 w-5 text-purple-500" />
              <span>Multi-Item Product Sales Invoice (Stock Out)</span>
            </h3>
            <span className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-200 border border-purple-200 dark:border-purple-800">
              Retail Sales Invoice
            </span>
          </div>

          <div className="mb-4 p-2.5 rounded-xl bg-purple-50/80 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-purple-900 dark:text-purple-200 text-xs flex items-center justify-between font-medium">
            <span>🛍️ Devices sold via this form will be automatically registered and tagged as <strong>SOLD (Customer Owned)</strong> in the Customer Device Serials Directory.</span>
          </div>

          <form onSubmit={handleSubmitProductSale} className="space-y-4 text-xs">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-bold mb-1">Select Customer *</label>
                <select
                  value={saleCustomerId}
                  onChange={(e) => setSaleCustomerId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.customerName} ({c.customerId}) - {c.address}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Fulfilling Branch *</label>
                <select
                  value={saleBranchId}
                  onChange={(e) => setSaleBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Payment Method</label>
                <select
                  value={salePaymentMethod}
                  onChange={(e) => setSalePaymentMethod(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  <option value="Cash / Direct Payment">Cash / Direct Payment</option>
                  <option value="eSewa / Khalti Digital Mobile Wallet">eSewa / Khalti Digital Mobile Wallet</option>
                  <option value="Bank Transfer / Fonepay QR">Bank Transfer / Fonepay QR</option>
                  <option value="Customer Account Credit">Customer Account Credit</option>
                </select>
              </div>
            </div>

            {/* Multi-Item Sales Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddSaleItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU to Add to Sales Invoice..."
                  inputId="sale-product-search-input"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Sales Invoice Line Items ({saleItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddSaleItem()}
                  className="px-3 py-1 rounded-lg bg-purple-600 text-white font-bold text-[11px] hover:bg-purple-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Product to Invoice</span>
                </button>
              </div>

              {saleItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <PackageMinus className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No product items added to this sales invoice yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddSaleItem()}
                    className={`mt-2 text-purple-500 hover:text-purple-600 dark:text-purple-400 dark:hover:text-purple-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add products to sale invoice
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Product Name</th>
                        <th className="px-2.5 py-1.5 text-center">Branch Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Sale Qty</th>
                        <th className="px-2.5 py-1.5 text-right">Unit Price (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Discount (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Subtotal (NPR)</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {saleItems.map((item, idx) => {
                        const prod = products.find((p) => p.id === item.productId);
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === saleBranchId);
                        const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5 min-w-[240px]">
                              <select
                                value={item.productId}
                                onChange={(e) => handleUpdateSaleItem(item.id, { productId: e.target.value })}
                                className={`w-full rounded-lg border p-1.5 font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    [{p.sku}] {p.name} ({p.unit})
                                  </option>
                                ))}
                              </select>

                              {isSerialized && (
                                <div className="mt-2 space-y-1 bg-purple-50/50 dark:bg-purple-950/40 p-2 rounded-lg border border-purple-200 dark:border-purple-800/60">
                                  <span className="text-[10px] text-purple-700 dark:text-purple-300 font-bold block">
                                    ✓ Scan Serials for {item.productName} ({item.quantity} Unit{item.quantity > 1 ? 's' : ''})
                                  </span>
                                  {Array.from({ length: item.quantity }).map((_, sIdx) => (
                                    <div key={sIdx} className="flex items-center gap-1.5 mt-1 text-xs">
                                      <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                      <input
                                        id={`sale-serial-device-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="Device Serial #"
                                        value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                        onChange={(e) => updateSaleDeviceSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const nextEl = document.getElementById(`sale-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                            if (nextEl) {
                                              nextEl.focus();
                                              if ('select' in nextEl) nextEl.select();
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-purple-500 text-purple-900 bg-white border-purple-300 dark:text-purple-200 dark:bg-slate-800 dark:border-purple-700`}
                                      />
                                      <input
                                        id={`sale-serial-pon-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="PON Serial #"
                                        value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                        onChange={(e) => updateSalePonSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (sIdx + 1 < item.quantity) {
                                              const nextDev = document.getElementById(`sale-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                              if (nextDev) {
                                                nextDev.focus();
                                                if ('select' in nextDev) nextDev.select();
                                              }
                                            } else {
                                              const searchInput = document.getElementById('sale-product-search-input') as HTMLInputElement;
                                              if (searchInput) {
                                                searchInput.focus();
                                                if ('select' in searchInput) searchInput.select();
                                              }
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 text-indigo-900 bg-white border-indigo-300 dark:text-indigo-200 dark:bg-slate-800 dark:border-indigo-700`}
                                      />
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>

                            <td className="p-2.5 text-center font-mono font-bold text-slate-500">
                              {stk?.quantityOnHand || 0} {item.unit}
                            </td>

                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                required
                                value={item.quantity}
                                onChange={(e) => handleUpdateSaleItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-16 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                required
                                value={item.sellingPrice}
                                onChange={(e) => handleUpdateSaleItem(item.id, { sellingPrice: Number(e.target.value) })}
                                className={`w-24 rounded-lg border p-1 text-right font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                value={item.discount}
                                onChange={(e) => handleUpdateSaleItem(item.id, { discount: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-right font-mono text-amber-600 dark:text-amber-400 bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                              {formatNPR(item.totalValue)}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveSaleItem(item.id)}
                                className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Billing Summary Banner */}
            {saleItems.length > 0 && (
              <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl border bg-purple-50/50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800/60 text-xs">
                <div>
                  <span className="text-slate-400 block text-[10px]">Gross Product Bill</span>
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {formatNPR(saleItems.reduce((s, i) => s + ((i.quantity || 0) * (i.sellingPrice || 0)), 0))}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Total Discounts Applied</span>
                  <span className={`font-mono font-bold text-amber-600 dark:text-amber-400`}>
                    {formatNPR(saleItems.reduce((s, i) => s + (i.discount || 0), 0))}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Net Receivable Bill Amount</span>
                  <span className="font-mono font-extrabold text-purple-700 dark:text-purple-300 text-sm">
                    {formatNPR(Math.max(0, saleItems.reduce((s, i) => s + ((i.quantity || 0) * (i.sellingPrice || 0)), 0) - saleItems.reduce((s, i) => s + (i.discount || 0), 0)))}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block font-bold mb-1">Sale Notes / Remarks</label>
              <textarea
                rows={2}
                value={saleNotes}
                onChange={(e) => setSaleNotes(e.target.value)}
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetSaleForm}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-purple-600 text-white font-bold hover:bg-purple-500 shadow-md flex items-center gap-2 cursor-pointer"
              >
                <PackageMinus className="h-4 w-4" />
                <span>Submit Product Sales Invoice</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 8: DEVICE EXCHANGE / REPLACEMENT SWAP */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'DEVICE_EXCHANGE' && (
        <FormCard className="space-y-4">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-indigo-600 text-white">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <span>Customer Hardware Replacement & Exchange</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Swap customer routers/ONUs/STBs, assign new replacement serials, and return old serial units back to branch inventory stock.
                </p>
              </div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800">
              {exchangeCustomerDevices.length} Active Deployed Units
            </span>
          </div>

          <form onSubmit={handlePerformExchange} className="space-y-5 text-xs">
            {/* Step 1: Select Installed Customer Device */}
            <div className={`p-4 rounded-2xl border space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <div className="flex items-center justify-between">
                <h4 className={`font-bold text-xs flex items-center gap-2 text-slate-800 dark:text-slate-200`}>
                  <Search className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                  <span>Step 1: Select Installed Customer Device (Search Master Directory / Installed Stock) *</span>
                </h4>
                {selectedDeviceForExchange && (
                  <button
                    type="button"
                    onClick={() => setSelectedDeviceForExchange(null)}
                    className={`text-[11px] text-rose-500 dark:text-rose-400 hover:underline font-bold cursor-pointer`}
                  >
                    Clear Selection
                  </button>
                )}
              </div>

              {!selectedDeviceForExchange ? (
                <div className="space-y-3">
                  <div className="p-2.5 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-900 dark:text-indigo-200 text-xs font-medium flex items-center justify-between">
                    <span>🔄 <strong>Rental CPE Warranty Exchange Filter</strong>: Only customers with active <strong>RENTAL</strong> devices are eligible for exchange. Sold devices are customer-owned.</span>
                  </div>

 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search customer name, customer ID code, rental serial number (SN), or PON serial..."
                      value={exchangeSearchQuery}
                      onChange={(e) => setExchangeSearchQuery(e.target.value)}
                      className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs font-semibold border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white`}
                    />
                  </div>

                  <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    {isLoadingExchangeDevices ? (
                      <div className="p-4 text-center text-slate-400 text-xs">Loading customer devices...</div>
                    ) : filteredExchangeDevices.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 text-xs">No active RENTAL customer devices match your search query. (Sold products are excluded from device exchange).</div>
                    ) : (
                      filteredExchangeDevices.map((dev) => (
                        <div
                          key={dev.id}
                          onClick={() => {
                            setSelectedDeviceForExchange(dev);
                            setExchangeProductName(dev.productName);
                            setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`);
                            setExchangeNewPon(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`);
                            setExchangeNewMac('00:1A:2B:3C:4D:5E');
                          }}
                          className="p-3 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/60 cursor-pointer transition-all flex items-center justify-between"
                        >
                          <div>
                            <div className="font-bold text-xs text-slate-900 dark:text-white flex items-center gap-2">
                              <span>{dev.customerName}</span>
                              <span className={`font-mono text-indigo-600 dark:text-indigo-400 text-[11px]`}>({dev.customerCode})</span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Model: <strong>{dev.productName}</strong> | SN: <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{dev.deviceSerial}</span> | PON: <span className="font-mono text-slate-600 dark:text-slate-400">{dev.ponSerial}</span>
                            </div>
                            {dev.installationAddress && (
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                📍 {dev.installationAddress}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-bold text-[11px] shrink-0"
                          >
                            Select Device
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-xs">
                  <div className="flex items-center justify-between font-bold text-indigo-950 dark:text-indigo-200">
                    <span>Target Customer: {selectedDeviceForExchange.customerName} ({selectedDeviceForExchange.customerCode})</span>
                    <span>Contact: {selectedDeviceForExchange.contactPhone || 'N/A'}</span>
                  </div>
                  <div className="mt-2 text-slate-700 dark:text-slate-300 text-[11px] grid grid-cols-2 gap-2">
                    <div>
                      <strong>Installed Product:</strong> {selectedDeviceForExchange.productName}
                    </div>
                    <div>
                      <strong>Address:</strong> {selectedDeviceForExchange.installationAddress || 'N/A'}
                    </div>
                    <div>
                      <strong>Old Device Serial (SN):</strong> <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-300`}>{selectedDeviceForExchange.deviceSerial}</span>
                    </div>
                    <div>
                      <strong>Old PON Serial:</strong> <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-300`}>{selectedDeviceForExchange.ponSerial}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Step 2: Old Serial Disposition */}
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                Step 2: Old Device Disposition (Return Serial Unit Handling) *
              </label>
              <div className="grid grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => setOldDeviceAction('RESTOCK')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'RESTOCK'
                      ? 'bg-emerald-50 dark:bg-emerald-950/80 border-emerald-500 text-emerald-900 dark:text-emerald-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <CheckCircle2 className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
                    <span>Put Back to Available Inventory (+1 Stock)</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Return tested working device back to branch store stock for re-issue
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setOldDeviceAction('DAMAGE')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'DAMAGE'
                      ? 'bg-rose-50 dark:bg-rose-950/80 border-rose-500 text-rose-900 dark:text-rose-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <AlertTriangle className={`h-4 w-4 text-rose-500 dark:text-rose-400`} />
                    <span>Move to Defective Stock Bin</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Move hardware unit to branch damaged bin for RMA repair
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setOldDeviceAction('DISPOSED')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'DISPOSED'
                      ? 'bg-amber-50 dark:bg-amber-950/80 border-amber-500 text-amber-900 dark:text-amber-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <XCircle className={`h-4 w-4 text-amber-500 dark:text-amber-400`} />
                    <span>Scrap & Dispose Unit</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Scrap irreparable unit from company inventory
                  </p>
                </button>
              </div>
            </div>

            {/* Step 3: Replacement Device Details */}
            <div className={`p-4 rounded-2xl border space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <h4 className={`font-bold text-xs flex items-center gap-2 text-slate-800 dark:text-slate-200`}>
                <Plus className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                <span>Step 3: New Replacement Device Details *</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New Product Model *
                  </label>
                  <select
                    value={exchangeProductName}
                    onChange={(e) => setExchangeProductName(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 text-xs font-semibold border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name} ({p.category})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New Device Serial Number (SN) *
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      required
                      value={exchangeNewSerial}
                      onChange={(e) => setExchangeNewSerial(e.target.value)}
                      placeholder="e.g. SN-ONU24G-991203"
                      className={`w-full rounded-xl border p-2.5 pr-20 text-xs font-mono font-bold border-slate-300 bg-white text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-indigo-400`}
                    />
                    <button
                      type="button"
                      onClick={() => setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`)}
                      className="absolute right-1 top-1 bottom-1 px-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold hover:bg-indigo-200 cursor-pointer"
                    >
                      Auto-Gen
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New PON Serial Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={exchangeNewPon}
                    onChange={(e) => setExchangeNewPon(e.target.value)}
                    placeholder="e.g. HWTC-99182A3"
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono font-bold border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New MAC Address (Optional)
                  </label>
                  <input
                    type="text"
                    value={exchangeNewMac}
                    onChange={(e) => setExchangeNewMac(e.target.value)}
                    placeholder="e.g. 00:1A:2B:3C:4D:5E"
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  />
                </div>
              </div>
            </div>

            {/* Exchange Reason & Notes */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Reason for Device Exchange / Swap *
                </label>
                <select
                  value={exchangeReason}
                  onChange={(e) => setExchangeReason(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 text-xs border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                >
                  <option value="Defective / Hardware Fault (No Power / Optical Loss)">🛠️ Defective / Hardware Fault (No Power / Optical Loss)</option>
                  <option value="Model Upgrade (Single-Band to Dual-Band 5G ONU)">🚀 Model Upgrade (Single-Band to Dual-Band 5G ONU)</option>
                  <option value="Port Damage / Electrical Surge (Lightning Loss)">⚡ Port Damage / Electrical Surge (Lightning Loss)</option>
                  <option value="Routine Field Maintenance & Firmware Swap">🔧 Routine Field Maintenance & Firmware Swap</option>
                  <option value="Physical Fiber Drop Port Damage">📡 Physical Fiber Drop Port Damage</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Technician / Exchange Field Notes
                </label>
                <input
                  type="text"
                  value={exchangeNotes}
                  onChange={(e) => setExchangeNotes(e.target.value)}
                  placeholder="e.g. Replaced by Technician Suresh. Optical power -18.5dBm, signal online..."
                  className={`w-full rounded-xl border p-2.5 text-xs border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button
                type="submit"
                disabled={isSubmittingExchange || !selectedDeviceForExchange}
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                <span>{isSubmittingExchange ? 'Processing Exchange & Restocking...' : 'Confirm Hardware Exchange & Sync Inventory'}</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 7: LOGS */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'LOGS' && (
        <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <h3 className={`font-bold text-sm mb-3 text-slate-900 dark:text-white`}>
            Audit Log of All Stock Operations ({operations.length})
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">Ref #</th>
                  <th className="px-2.5 py-1.5">Type</th>
                  <th className="px-2.5 py-1.5">Branch</th>
                  <th className="px-2.5 py-1.5">Product / Details</th>
                  <th className="px-2.5 py-1.5">Value</th>
                  <th className="px-2.5 py-1.5">Inspector / Officer</th>
                  <th className="px-2.5 py-1.5">Date</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {operations.map((op) => (
                  <tr key={op.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                    <td className={`p-2.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>{op.referenceNumber}</td>
                    <td className="p-2.5 font-bold">{op.type}</td>
                    <td className="p-2.5">{op.branchId}</td>
                    <td className="p-2.5">{op.productName || op.reason}</td>
                    <td className="p-2.5 font-mono font-bold">{formatNPR(op.totalValue)}</td>
                    <td className="p-2.5">{op.inspectorName}</td>
                    <td className="p-2.5 font-mono text-slate-400">{op.dateAD}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL 1: Create Pullout Bin */}
      {/* ============================================================ */}
      {(isPulloutModalOpen || activeTab === 'CREATE_PULLOUT') && (
        <FormCard className="animate-fadeIn">
          <div className="w-full">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <Truck className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
                <span>Create Overstock / Damaged Stock Pullout Bin</span>
              </h3>
              <button onClick={() => { setIsPulloutModalOpen(false); setActiveTab('PULLOUT_BINS'); }} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitPulloutBin} className="space-y-4 mt-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">Source Branch *</label>
                  <select
                    value={sourceBranchId}
                    onChange={(e) => setSourceBranchId(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    {effectivePulloutSourceBranches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold mb-1">Destination Central Warehouse *</label>
                  <select
                    value={destWarehouseId}
                    onChange={(e) => setDestWarehouseId(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    {destWarehouseOptions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code}) {b.isHeadquarters ? '⭐ Central HQ' : '🏬 Warehouse'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold mb-1">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddProductToPullout(prod)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU for Pullout..."
                  inputId="pullout-product-search-input"
                  stock={stock}
                  selectedBranchId={sourceBranchId}
                />
              </div>

              {/* Added Pullout Items List */}
              <div className="space-y-2 max-h-72 overflow-y-auto border rounded-xl p-2">
                {pulloutItems.length === 0 ? (
                  <p className="text-slate-400 text-center py-4 text-xs">No items added to pullout bin yet. Search above to add items.</p>
                ) : (
                  pulloutItems.map((item, idx) => {
                    const prod = products.find((p) => p.id === item.productId);
                    const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;
                    const srcStock = stock.find((s) => s.productId === item.productId && s.branchId === sourceBranchId);
                    const usableQty = srcStock ? (srcStock.quantityOnHand || 0) : 0;
                    const damagedQty = srcStock ? (srcStock.damagedQty || 0) : 0;
                    const availForCondition = item.condition === 'DAMAGED_STOCK' ? damagedQty : usableQty;
                    const isExceeded = item.quantity > availForCondition;
                    const srcBranchName = branches.find((b) => b.id === sourceBranchId)?.name || sourceBranchId;

                    return (
                      <div key={item.id} className={`p-2.5 rounded-xl border space-y-2 ${
                        isExceeded
                          ? 'bg-rose-50/50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800'
                          : `bg-slate-50 border-slate-200 dark:bg-slate-800/60 dark:border-slate-700`
                      }`}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1">
                            <span className="font-bold text-slate-900 dark:text-white block">{item.productName}</span>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-mono text-slate-400">SKU: {item.sku}</span>
                              <select
                                value={item.condition}
                                onChange={(e) => handleUpdatePulloutItem(item.id, { condition: e.target.value as any })}
                                className={`text-[10px] font-bold rounded border px-1.5 py-0.5 bg-white text-indigo-600 border-indigo-300 dark:bg-slate-800 dark:text-indigo-400 dark:border-slate-700`}
                              >
                                <option value="OVERSTOCK">OVERSTOCK</option>
                                <option value="DAMAGED_STOCK">DAMAGED_STOCK</option>
                              </select>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <div>
                              <span className="text-[9px] text-slate-400 block text-right">Pullout Qty</span>
                              <input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) => handleUpdatePulloutItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-16 rounded border p-1 text-center font-mono font-bold text-xs ${isExceeded ? 'bg-rose-100 dark:bg-rose-900 text-rose-800 dark:text-rose-100 border-rose-400' : 'bg-white text-slate-900 border-slate-300 dark:bg-slate-800 dark:text-white dark:border-slate-600'}`}
                              />
                            </div>

                            <div className="text-right">
                              <span className="text-[9px] text-slate-400 block">Total Val</span>
                              <span className={`font-mono font-bold text-xs text-indigo-600 dark:text-indigo-400`}>
                                {formatNPR(item.totalValue)}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleRemovePulloutItem(item.id)}
                              className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        {/* Branch Stock Availability Information & Live Validation Banner */}
                        <div className={`flex items-center justify-between text-[11px] p-2 rounded-lg border gap-2 flex-wrap bg-white/70 border-slate-200/80 dark:bg-slate-900/60 dark:border-slate-800`}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-slate-600 dark:text-slate-300">
                              Stock at {srcBranchName}:
                            </span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${
                              item.condition === 'OVERSTOCK' && isExceeded
                                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                : usableQty > 0
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300'
                                : 'bg-slate-100 text-slate-500'
                            }`}>
                              Usable: {usableQty} {item.unit || 'pcs'}
                            </span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${
                              item.condition === 'DAMAGED_STOCK' && isExceeded
                                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                : damagedQty > 0
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300'
                                : 'bg-slate-100 text-slate-500'
                            }`}>
                              Damaged: {damagedQty} {item.unit || 'pcs'}
                            </span>
                          </div>

                          {isExceeded && (
                            <button
                              type="button"
                              onClick={() => handleUpdatePulloutItem(item.id, { quantity: Math.max(1, availForCondition) })}
                              className="text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-100 dark:bg-rose-950/80 hover:bg-rose-200 px-2 py-1 rounded-md border border-rose-300 dark:border-rose-800 transition-all cursor-pointer flex items-center gap-1 shrink-0"
                            >
                              <RefreshCw className={`h-3 w-3 text-rose-600 dark:text-rose-400`} />
                              <span>Set to Available Max ({availForCondition})</span>
                            </button>
                          )}
                        </div>

                        {isExceeded && (
                          <div className="text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-100/90 dark:bg-rose-950/80 p-2 rounded-lg border border-rose-300 dark:border-rose-800 flex items-center gap-2">
                            <AlertTriangle className={`h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400`} />
                            <span>
                              Requested pullout quantity ({item.quantity} {item.unit || 'pcs'}) exceeds available {item.condition === 'DAMAGED_STOCK' ? 'damaged' : 'usable'} stock ({availForCondition} {item.unit || 'pcs'} available at {srcBranchName}).
                            </span>
                          </div>
                        )}

                        {/* Serial Tracking Inputs */}
                        {isSerialized && (
                          <div className="pt-2 border-t border-slate-200 dark:border-slate-700/60 space-y-1.5">
                            <div className={`flex items-center justify-between text-[10px] text-indigo-600 dark:text-indigo-400 font-bold`}>
                              <span>✓ Scan Serials for {item.productName} ({item.quantity} Unit{item.quantity > 1 ? 's' : ''})</span>
                            </div>
                            {Array.from({ length: item.quantity }).map((_, sIdx) => (
                              <div key={sIdx} className={`p-1.5 rounded-lg border flex items-center gap-1.5 text-xs bg-white dark:bg-slate-900/80`}>
                                <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                <input
                                  id={`pullout-serial-device-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="Device Serial #"
                                  value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                  onChange={(e) => updatePulloutDeviceSerial(idx, sIdx, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      const nextEl = document.getElementById(`pullout-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                      if (nextEl) {
                                        nextEl.focus();
                                        if ('select' in nextEl) nextEl.select();
                                      }
                                    }
                                  }}
                                  className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 text-indigo-900 bg-slate-50 border-indigo-200 dark:text-indigo-200 dark:bg-slate-950 dark:border-indigo-800`}
                                />
                                <input
                                  id={`pullout-serial-pon-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="PON Serial #"
                                  value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                  onChange={(e) => updatePulloutPonSerial(idx, sIdx, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      if (sIdx + 1 < item.quantity) {
                                        const nextDev = document.getElementById(`pullout-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                        if (nextDev) {
                                          nextDev.focus();
                                          if ('select' in nextDev) nextDev.select();
                                        }
                                      } else {
                                        const searchInput = document.getElementById('pullout-product-search-input') as HTMLInputElement;
                                        if (searchInput) {
                                          searchInput.focus();
                                          if ('select' in searchInput) searchInput.select();
                                        }
                                      }
                                    }
                                  }}
                                  className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-sky-500 text-sky-900 bg-slate-50 border-sky-200 dark:text-sky-200 dark:bg-slate-950 dark:border-sky-800`}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div>
                <label className="block font-bold mb-1">Dispatch Reason / Notes</label>
                <textarea
                  rows={2}
                  value={binNotes}
                  onChange={(e) => setBinNotes(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setPulloutItems([]);
                    setBinNotes('Warehouse overstock & damaged inventory pullout return dispatch');
                  }}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset Form</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsPulloutModalOpen(false); setActiveTab('PULLOUT_BINS'); }}
                    className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-500 shadow-md cursor-pointer"
                  >
                    Dispatch Pullout Bin
                  </button>
                </div>
              </div>
            </form>
          </div>
        </FormCard>
      )}

      {/* ============================================================ */}
      {/* MODAL 2: Label Local Damaged Stock */}
      {/* ============================================================ */}
      {(isDamageModalOpen || activeTab === 'LABEL_DAMAGE') && (
        <FormCard className="animate-fadeIn">
          <div className="w-full">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <AlertTriangle className={`h-5 w-5 text-rose-500 dark:text-rose-400`} />
                <span>Label Local Damaged Stock</span>
              </h3>
              <button onClick={() => { setIsDamageModalOpen(false); setActiveTab('DAMAGE_TRACKING'); }} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitDamageTag} className="space-y-4 mt-4 text-xs">
              {!isSuperOrInventory && (
                <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[11px] font-bold flex items-center gap-1.5">
                  <ShieldAlert className={`h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400`} />
                  <span>Branch User Rule: Locked to your assigned branch ({currentUser?.branchId})</span>
                </div>
              )}

              <div>
                <label className="block font-bold mb-1">Target Branch *</label>
                <select
                  value={damageBranchId}
                  onChange={(e) => setDamageBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Scan Barcode or Search & Select Damaged Product *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={handleAddDamageItem}
                  placeholder="Scan Barcode or Search & Select Damaged Product..."
                  stock={stock}
                  selectedBranchId={damageBranchId}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center justify-between">
                  <label className="font-bold">Damaged Items ({damageItems.length}) *</label>
                  <span className="text-[10px] text-slate-500">Add products above</span>
                </div>
                {damageItems.length === 0 ? (
                  <p className="py-5 text-center text-xs text-slate-400">No damaged products added yet.</p>
                ) : damageItems.map((item) => {
                  const product = products.find((entry) => entry.id === item.productId);
                  const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : false;
                  return (
                    <div key={item.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex-1"><strong>{item.productName}</strong><div className="text-[10px] font-mono text-slate-500">SKU: {item.sku}</div></div>
                        <input type="number" min={1} value={item.quantity} onChange={(e) => updateDamageItem(item.id, { quantity: Math.max(1, Number(e.target.value) || 1) })} className="w-20 rounded-lg border p-2 text-center font-mono" />
                        <button type="button" onClick={() => setDamageItems((previous) => previous.filter((entry) => entry.id !== item.id))} className="text-rose-500 dark:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                      </div>
                      {isSerialized && <div className="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-2">
                        {item.deviceSerials?.map((entry, index) => <div key={index} className="grid grid-cols-[2rem_1fr_1fr] gap-2 items-center">
                          <span className="text-[10px] font-mono">#{index + 1}</span>
                          <input required value={entry.deviceSerial} onChange={(e) => updateDamageItemSerial(item.id, index, 'deviceSerial', e.target.value)} placeholder="Device Serial #" className="rounded-lg border p-2 font-mono" />
                          <input required value={entry.ponSerial} onChange={(e) => updateDamageItemSerial(item.id, index, 'ponSerial', e.target.value)} placeholder="PON Serial #" className="rounded-lg border p-2 font-mono" />
                        </div>)}
                      </div>}
                    </div>
                  );
                })}
              </div>

              <div>
                <label className="block font-bold mb-1">Reason for Damage</label>
                <textarea
                  rows={2}
                  required
                  value={damageReason}
                  onChange={(e) => setDamageReason(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div>
                <label className="block font-bold mb-1">Inspector / Officer Name</label>
                <input
                  type="text"
                  required
                  value={damageInspector}
                  onChange={(e) => setDamageInspector(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setDamageItems([]);
                    setDamageReason('');
                    setDamageInspector('Stores Quality Inspector');
                  }}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset Form</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsDamageModalOpen(false); setActiveTab('DAMAGE_TRACKING'); }}
                    className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl bg-rose-600 text-white font-bold hover:bg-rose-500 shadow-md cursor-pointer"
                  >
                    Save Damaged Stock Tag
                  </button>
                </div>
              </div>
            </form>
          </div>
        </FormCard>
      )}

      {/* ============================================================ */}
      {/* MODAL 3: Assign Fixed Asset / Product Rental CPE Modal */}
      {/* ============================================================ */}
      {isAssignModalOpen && (selectedAssetForAssign || selectedProductForAssign) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn">
          <div className={`w-full max-w-xl rounded-3xl border shadow-2xl overflow-hidden p-6 max-h-[90vh] overflow-y-auto bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-white`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <Wrench className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
                <span>
                  {selectedProductForAssign
                    ? `Deploy Catalog Product as CPE Rental: ${selectedProductForAssign.name}`
                    : `Assign Fixed Asset: ${selectedAssetForAssign?.name}`}
                </span>
              </h3>
              <button onClick={() => { setIsAssignModalOpen(false); setSelectedProductForAssign(null); setSelectedAssetForAssign(null); }} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitAssignAsset} className="space-y-4 mt-4 text-xs">
              {selectedAssetForAssign ? (
                <div className="p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-slate-700 dark:text-slate-300 font-mono text-[11px]">
                  Tag: <strong>{selectedAssetForAssign.tagNumber}</strong> | Category: {selectedAssetForAssign.category}
                </div>
              ) : selectedProductForAssign ? (
                <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 space-y-3">
                  <div className="flex items-center justify-between font-bold text-indigo-950 dark:text-indigo-200 text-xs">
                    <span>Product: {selectedProductForAssign.name}</span>
                    <span>SKU: {selectedProductForAssign.sku}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-bold text-[10px] text-slate-600 dark:text-slate-400 mb-1">Asset Tag Number *</label>
                      <input
                        type="text"
                        required
                        value={productAssignTag}
                        onChange={(e) => setProductAssignTag(e.target.value)}
                        className={`w-full rounded-xl border p-2 font-mono font-bold border-slate-300 bg-white text-indigo-600 dark:border-slate-600 dark:bg-slate-800 dark:text-indigo-400`}
                      />
                    </div>

                    <div>
                      <label className="block font-bold text-[10px] text-slate-600 dark:text-slate-400 mb-1">Device Serial (SN) *</label>
                      <input
                        type="text"
                        required
                        value={productAssignSerial}
                        onChange={(e) => setProductAssignSerial(e.target.value)}
                        className={`w-full rounded-xl border p-2 font-mono font-bold border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                      />
                    </div>

                    <div>
                      <label className="block font-bold text-[10px] text-slate-600 dark:text-slate-400 mb-1">PON Serial Number *</label>
                      <input
                        type="text"
                        required
                        value={productAssignPon}
                        onChange={(e) => setProductAssignPon(e.target.value)}
                        className={`w-full rounded-xl border p-2 font-mono font-bold border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                      />
                    </div>

                    <div>
                      <label className="block font-bold text-[10px] text-slate-600 dark:text-slate-400 mb-1">MAC Address (Optional)</label>
                      <input
                        type="text"
                        value={productAssignMac}
                        onChange={(e) => setProductAssignMac(e.target.value)}
                        className={`w-full rounded-xl border p-2 font-mono border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              <div>
                <label className="block font-bold mb-1">Assign Target Category *</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setAssignTargetType('LOCATION')}
                    className={`p-2.5 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${assignTargetType === 'LOCATION' ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-slate-50 border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300'}`}
                  >
                    <MapPin className="h-4 w-4" />
                    <span>POP / Network Site</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAssignTargetType('CUSTOMER')}
                    className={`p-2.5 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${assignTargetType === 'CUSTOMER' ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-slate-50 border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300'}`}
                  >
                    <UserCheck className="h-4 w-4" />
                    <span>Customer Home / Rental CPE</span>
                  </button>
                </div>
              </div>

              {assignTargetType === 'LOCATION' ? (
                <div>
                  <label className="block font-bold mb-1">Select POP / Network Location *</label>
                  <select
                    value={assignLocationId}
                    onChange={(e) => setAssignLocationId(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} ({loc.type.replace(/_/g, ' ')}) - {loc.address}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block font-bold">Select Customer (Customer Master Directory Search) *</label>
                    <span className="text-[10px] text-indigo-500 font-mono font-bold">
                      {customers.length} Directory Records
                    </span>
                  </div>

 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Type customer name, account ID, phone, or location to filter..."
                      value={customerSearchInAssignModal}
                      onChange={(e) => setCustomerSearchInAssignModal(e.target.value)}
                      className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs font-semibold bg-slate-50 border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-white`}
                    />
                  </div>

                  <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredCustomersInAssignModal.length === 0 ? (
                      <div className="p-3 text-center text-slate-400 text-xs">
                        No customer matching "{customerSearchInAssignModal}" in Master Directory.
                      </div>
                    ) : (
                      filteredCustomersInAssignModal.map((c) => {
                        const isSelected = assignCustomerId === c.id;
                        return (
                          <div
                            key={c.id}
                            onClick={() => setAssignCustomerId(c.id)}
                            className={`p-2.5 text-left flex items-center justify-between hover:bg-indigo-50 dark:hover:bg-indigo-950/60 cursor-pointer transition-all ${
                              isSelected
                                ? 'bg-indigo-100 dark:bg-indigo-950/90 border-l-4 border-indigo-600 font-bold'
                                : ''
                            }`}
                          >
                            <div>
                              <div className="text-xs font-bold text-slate-900 dark:text-white">
                                {c.customerName} <span className={`font-mono text-indigo-600 dark:text-indigo-400 text-[11px]`}>({c.customerId})</span>
                              </div>
                              <div className="text-[10px] text-slate-500">
                                📍 {c.address} | 📞 {c.contactNumber}
                              </div>
                            </div>
                            {isSelected && (
                              <CheckCircle2 className={`h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0`} />
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="block font-bold mb-1">Installation / Assignment Remarks</label>
                <textarea
                  rows={2}
                  value={assignNotes}
                  onChange={(e) => setAssignNotes(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAssignModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-200 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-500 shadow-md cursor-pointer"
                >
                  Confirm Asset Assignment
                </button>
              </div>
            </form>
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

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 px-4 py-3 rounded-2xl shadow-2xl border border-slate-700 dark:border-slate-300 text-xs font-semibold flex items-center justify-between gap-3 animate-in fade-in slide-in-from-bottom-5">
          <span>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="p-1 hover:bg-slate-800 dark:hover:bg-slate-200 rounded-lg cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
