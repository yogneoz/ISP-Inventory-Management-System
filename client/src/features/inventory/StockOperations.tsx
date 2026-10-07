import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PageHeader } from '../../components/common/PageHeader';
import {
  StockOperation,
  Product,
  Branch,
  InventoryStock,
  PulloutItem,
  SaleItem,
  ConsumableIssueItem,
  User,
  Shipment,
  Asset,
  LocationRecord,
  CustomerRecord,
  CustomerDeviceRecord,
  ApprovalRequest,
  SerialLog,
} from '../../types';
import { hasExactBSDayRecord, tryConvertADToBS, getNepaliFiscalYear } from '../../utils/nepaliCalendar';
import { api } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import { formatNPR } from '../../utils/nprFormat';
import {
  AlertOctagon,
  Trash2,
  X,
  Barcode,
  Package,
  CheckCircle2,
  Truck,
  AlertTriangle,
  RefreshCw,
  Send,
  Inbox,
  Wrench,
  PackageMinus,
  ArrowRight,
  ShieldAlert,
  Lock,
  ClipboardList,
  RotateCcw,
  PackageCheck,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import { isOperationAllowed, canUserSeeAllBranches, getAllowedBranches, getAllowedBranchIds } from '../../utils/permissions';
import { StockOperationsProvider, type StockOperationsCtx, type DamageSerialEntry, type TransferFormLine, type AssignBinLine } from './stockops/StockOperationsContext';
import { PulloutBinsPanel } from './stockops/PulloutBinsPanel';
import { DamageTrackingPanel } from './stockops/DamageTrackingPanel';
import { ReceiveTransferPanel } from './stockops/ReceiveTransferPanel';
import { CreateTransferPanel } from './stockops/CreateTransferPanel';
import { AssignAssetPanel } from './stockops/AssignAssetPanel';
import { ConsumableIssuePanel } from './stockops/ConsumableIssuePanel';
import { ConsumablesRegisterPanel } from './stockops/ConsumablesRegisterPanel';
import { ProductSalePanel } from './stockops/ProductSalePanel';
import { DeviceExchangePanel } from './stockops/DeviceExchangePanel';
import { CreatePulloutPanel } from './stockops/CreatePulloutPanel';
import { LabelDamagePanel } from './stockops/LabelDamagePanel';
import { LogsPanel } from './stockops/LogsPanel';

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
  /** Bumped by App's SSE handler when stock-operation events arrive — re-runs the consumable register's paged fetch. */
  sseRefreshKey?: number;
}


// Local transfer form line: ShipmentItem plus form-only mirror fields (unit label, quantity)

// Asset deployment bin line: one assignable row inside the multi-item
// Assign Fixed Asset form (Product Sale pattern).

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
  sseRefreshKey,
}) => {
  const { confirm: confirmDialog, prompt: promptDialog, alert: alertDialog } = useDialog();
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
      alertDialog(
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
  const [expandedShipmentId, setExpandedShipmentId] = useState<string | null>(null);

  // Modals state
  const [isPulloutModalOpen, setIsPulloutModalOpen] = useState(autoOpenModal && initialType === 'PULLOUT');
  const [isDamageModalOpen, setIsDamageModalOpen] = useState(autoOpenModal && initialType === 'DAMAGE');
  const [, setIsBarcodeScannerOpen] = useState(false);

  // Selected asset or product for assignment modal
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

  // Product-group filtered catalogs (types/index.ts: 'Product Item' | 'Fixed Asset' |
  // 'Consumable Item'; absent productGroup defaults to 'Product Item' everywhere else
  // in the app, matching ProductManagement's display convention).
  const saleEligibleProducts = useMemo(
    () => products.filter((p) => (p.productGroup || 'Product Item') === 'Product Item'),
    [products]
  );
  const consumableProducts = useMemo(
    () => products.filter((p) => (p.productGroup || 'Product Item') === 'Consumable Item'),
    [products]
  );

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
  const [binInspector] = useState<string>(currentUser?.name || 'Logistics Officer');
  const [binNotes, setBinNotes] = useState<string>('Overstock / Damaged stock return dispatch to central warehouse');
  const [pulloutItems, setPulloutItems] = useState<PulloutItem[]>([]);
  const [, setProdSearchInput] = useState<string>('');
  const [, setIsSearchOpen] = useState<boolean>(false);

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

  // 4. Assign Fixed Asset Form State (multi-item bin, Product Sale pattern)
  const [assignBranchId, setAssignBranchId] = useState<string>(userBranchId);
  const [assignItems, setAssignItems] = useState<AssignBinLine[]>([]);
  const [assignProductSearch, setAssignProductSearch] = useState<string>('');
  const [isAssignProductDropdownOpen, setIsAssignProductDropdownOpen] = useState<boolean>(false);
  const assignProductDropdownRef = useRef<HTMLDivElement | null>(null);
  // Serial-log cache for IN_STOCK serial-pair validation. The bootstrap
  // payload excludes serialLogs, so this mount-once fetch IS the register
  // this form validates against.
  const [assignSerialLogCache, setAssignSerialLogCache] = useState<SerialLog[]>([]);
  const assignSerialLogLoaded = useRef(false);
  useEffect(() => {
    if (assignSerialLogLoaded.current) return;
    assignSerialLogLoaded.current = true;
    api.getSerialLogs({ all: true })
      .then((res) => {
        const rows = Array.isArray(res) ? res : res.data;
        setAssignSerialLogCache(rows || []);
      })
      .catch(() => setAssignSerialLogCache([]));
  }, []);

  // Catalog candidates: productGroup 'Fixed Asset' plus ONU/Router/STB hardware.
  const assignableCatalogProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.productGroup === 'Fixed Asset' ||
          (p?.category || '').toLowerCase().includes('router') ||
          (p?.category || '').toLowerCase().includes('onu') ||
          (p?.category || '').toLowerCase().includes('stb') ||
          (p?.category || '').toLowerCase().includes('equipment') ||
          (p?.name || '').toLowerCase().includes('onu') ||
          (p?.name || '').toLowerCase().includes('router')
      ),
    [products]
  );

  const assetIsSerializedProduct = (p: Product): boolean =>
    p.requiresSerialTracking !== false && p.trackingType !== 'QUANTITY_ONLY';

  const filteredAssignProducts = useMemo(() => {
    const q = assignProductSearch.trim().toLowerCase();
    if (!q) return assignableCatalogProducts;
    return assignableCatalogProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
    );
  }, [assignableCatalogProducts, assignProductSearch]);

  // Close the product dropdown on outside click.
  useEffect(() => {
    if (!isAssignProductDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (assignProductDropdownRef.current && !assignProductDropdownRef.current.contains(e.target as Node)) {
        setIsAssignProductDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isAssignProductDropdownOpen]);

  // 6. Consumable Issue Form State (Multi-Item Requisition)
  const [consumableBranchId, setConsumableBranchId] = useState<string>(userBranchId);
  const [consumableTechnician, setConsumableTechnician] = useState<string>('Field Splicing Technician');
  const [consumableWorkOrder, setConsumableWorkOrder] = useState<string>('WO-2081-SPLIT-01');
  const [consumableReason, setConsumableReason] = useState<string>('Field fiber splicing & customer drop installation material usage');
  const [consumableItems, setConsumableItems] = useState<ConsumableIssueItem[]>([]);
  // Dismissible "Consumables Operational Rule" banner (resets on reload —
  // intentionally not persisted so new sessions see the rule once).
  const [isConsumableRuleBannerVisible, setIsConsumableRuleBannerVisible] = useState(true);

  // Consumables Register (Serial-Log-Register-style ledger) view state
  const [consumableRegisterQuery, setConsumableRegisterQuery] = useState('');
  const [consumableRegisterBranch, setConsumableRegisterBranch] = useState('ALL');
  const [consumableRegisterStatus, setConsumableRegisterStatus] = useState('ALL');
  const [consumableRegisterDateFrom, setConsumableRegisterDateFrom] = useState('');
  const [consumableRegisterDateTo, setConsumableRegisterDateTo] = useState('');
  const [consumableRegisterExpandedId, setConsumableRegisterExpandedId] = useState<string | null>(null);
  // Server-side paged fetch state: the register asks /api/stock-operations
  // for one page of filtered CONSUMABLE_ISSUE rows instead of receiving the
  // whole ledger through props.
  const [consumableRegisterRows, setConsumableRegisterRows] = useState<StockOperation[]>([]);
  const [consumableRegisterTotal, setConsumableRegisterTotal] = useState(0);
  const [consumableRegisterPage, setConsumableRegisterPage] = useState(1);
  const [consumableRegisterPageSize, setConsumableRegisterPageSize] = useState(20);
  const [consumableRegisterLoading, setConsumableRegisterLoading] = useState(false);
  const [consumableRegisterError, setConsumableRegisterError] = useState('');

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
  const handleResetSellForm = () => {
    setSellItems([]);
    const first = customers[0];
    setSellCustomerId(first?.id || '');
    setSellCustomerQuery(first ? sellCustomerDisplay(first) : '');
    setSellBranchId(userBranchId);
    setSellPaymentMethod('Cash / Direct Payment');
    setSellNotes('Direct retail product item sale to customer');
  };

  const updateSellDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    setSellItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const updateSellPonSerial = (lineIdx: number, sIdx: number, val: string) => {
    setSellItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], ponSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const handleAddSellItem = (prodId?: string) => {
    // Only 'Product Item' group products are sellable on this invoice.
    const selProd = saleEligibleProducts.find((p) => p.id === prodId) || saleEligibleProducts[0];
    if (!selProd) return;

    const isSerialized = selProd.requiresSerialTracking !== false && selProd.trackingType !== 'QUANTITY_ONLY';
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    const existingIdx = sellItems.findIndex((i) => i.productId === selProd.id);
    if (existingIdx !== -1) {
      targetLineIdx = existingIdx;
      setSellItems((prev) =>
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
      targetLineIdx = sellItems.length;
      targetSerialIdx = 0;
      const price = selProd.sellingPrice || 1000;
      setSellItems((prev) => [
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

  const handleUpdateSellItem = (id: string, updates: Partial<SaleItem>) => {
    setSellItems(
      sellItems.map((item) => {
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

  const handleRemoveSellItem = (id: string) => {
    setSellItems(sellItems.filter((i) => i.id !== id));
  };

  const handleSubmitSellProductSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const cust = customers.find((c) => c.id === sellCustomerId);
    const branchObj = branches.find((b) => b.id === sellBranchId);
    const branchName = branchObj?.name || sellBranchId;

    if (!cust) {
      alertDialog('Please select a customer from the search results before saving.');
      return;
    }
    if (sellItems.length === 0) {
      alertDialog('Please add at least one product item to the sales invoice.');
      return;
    }

    // Strict validation for Branch Stock Quantity and Serial Register
    if (
      !validateSourceBranchStockAndSerials(
        sellBranchId,
        branchName,
        sellItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          deviceSerials: i.deviceSerials,
        }))
      )
    ) {
      return;
    }

    const grossTotal = sellItems.reduce((s, i) => s + (i.quantity * i.sellingPrice), 0);
    const totalDiscount = sellItems.reduce((s, i) => s + i.discount, 0);
    const netSaleAmount = Math.max(0, grossTotal - totalDiscount);

    await onCreateOperation({
      type: 'STOCK_OUT',
      branchId: sellBranchId,
      branchName,
      items: sellItems,
      totalValue: netSaleAmount,
      customerId: cust.id,
      customerName: `${cust.customerName} (${cust.customerId})`,
      paymentMethod: sellPaymentMethod,
      reason: `Customer Product Sale Invoice (${sellItems.length} items): ${cust.customerName} - ${sellNotes}`,
      inspectorName: currentUser?.name || 'Sales Representative',
      status: 'LOGGED',
    });

    alertDialog(`Multi-item Product Sales Invoice logged successfully! Net Bill Amount: ${formatNPR(netSaleAmount)}.
Sold device(s) tagged as SOLD in Customer Device Directory.`);
    setSellItems([]);
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
    // Only 'Consumable Item' group products are issuable on this requisition.
    const selProd = consumableProducts.find((p) => p.id === prodId) || consumableProducts[0];
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
        alertDialog(
          `Insufficient inventory: "${branchName}" has ${availStock} ${isDamagedPullout ? 'damaged' : 'usable'} unit(s) of "${item.productName}", but ${item.quantity} unit(s) were requested.`
        );
        return false;
      }

      // 2. Validate Serial Tracking & Register for Serialized Items
      if (isSerialized) {
        if (!item.deviceSerials || item.deviceSerials.length < item.quantity) {
          alertDialog(`Validation Error: Please enter serial numbers for all ${item.quantity} unit(s) of "${item.productName}".`);
          return false;
        }

        for (let sIdx = 0; sIdx < item.quantity; sIdx++) {
          const s = item.deviceSerials[sIdx];
          if (!s || !s.deviceSerial?.trim()) {
            alertDialog(`Validation Error: Device Serial # is required for "${item.productName}" (Unit #${sIdx + 1}).`);
            return false;
          }

          const cleanSerial = s.deviceSerial.trim().toUpperCase();
          const cleanPon = s.ponSerial?.trim().toUpperCase();
          if (prod?.trackingType === 'SERIAL_MAC_PON' && !cleanPon) {
            alertDialog(`Validation Error: PON Serial # is required for "${item.productName}" (Unit #${sIdx + 1}).`);
            return false;
          }

          if (seenSerials.has(cleanSerial)) {
            alertDialog(`Validation Error: Duplicate Device Serial #${cleanSerial} detected in requested items.`);
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
            alertDialog(`Serial Register Error: Device Serial #${cleanSerial}${cleanPon ? ` / PON #${cleanPon}` : ''} must match an IN_STOCK ${item.productName} record at ${branchName}.`);
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
      alertDialog('Please add at least one stock item to the pullout bin.');
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

    alertDialog(`✓ Pullout Bin successfully created and dispatched from ${srcBranch?.name || sourceBranchId} to ${destWh?.name || 'Central Warehouse'}!\n\nThe Warehouse Manager can now inspect and receive this pullout under:\nWarehouse Logistics ➔ Receive Inbound Stock & Pullouts`);

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
      alertDialog('Add at least one product to the damaged stock list.');
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
      loadConsumableRegisterPage();
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
      alertDialog('Please select both a valid Source Branch and Destination Branch.');
      return;
    }

    if (xferSourceBranchId === xferDestBranchId) {
      alertDialog('Source and Destination branches must be different.');
      return;
    }

    // Warehouse functions (wh-restrict-transfer): warehouse-origin transfers are
    // limited to the Super Admin / Inventory Manager roles and to destination
    // branches configured to accept warehouse transfers (allowWarehouseTransfer).
    if (isWarehouseOrHeadOffice(srcBranch)) {
      if (!isOperationAllowed('wh-restrict-transfer', currentUser?.role)) {
        alertDialog('Warehouse stock transfers are restricted to the Super Admin and Inventory Manager roles only.');
        return;
      }
      if (destBranch.allowWarehouseTransfer === false) {
        alertDialog(
          `${destBranch.name} (${destBranch.code}) is not authorized to receive warehouse transfers. ` +
            'Enable "Allow Warehouse Transfers" for this branch in Branch Settings first.'
        );
        return;
      }
    }

    if (transferItems.length === 0) {
      alertDialog('Please add at least one product item to transfer.');
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
      alertDialog(`Inter-Branch Stock Transfer with ${transferItems.length} line item(s) successfully dispatched!`);
      setTransferItems([]);
      setActiveTab('RECEIVE_TRANSFER');
    }
  };

  // 4. Submit Assign Fixed Asset
  // --- Asset deployment bin handlers (Product Sale pattern) ---
  const handleAddAssignAssetToBin = (asset: Asset) => {
    setAssignItems((prev) => [
      ...prev,
      {
        id: `asg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        kind: 'ASSET' as const,
        assetId: asset.id,
        productName: asset.name,
        sku: asset.tagNumber,
        unit: 'Pcs',
        quantity: 1,
        isSerialized: false,
        deviceSerial: '',
        ponSerial: '',
        macAddress: '',
        usedAtType: 'FIELD' as const,
        remarks: '',
      },
    ]);
    setAssignProductSearch('');
    setIsAssignProductDropdownOpen(false);
  };

  const handleAddAssignProductToBin = (prod: Product) => {
    const serialized = assetIsSerializedProduct(prod);
    setAssignItems((prev) => [
      ...prev,
      {
        id: `asg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        kind: 'PRODUCT' as const,
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        unit: prod.unit,
        quantity: 1,
        isSerialized: serialized,
        deviceSerial: serialized ? `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}` : '',
        ponSerial: serialized ? `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}` : '',
        macAddress: serialized ? '00:1A:2B:3C:4D:5E' : '',
        usedAtType: 'FIELD' as const,
        remarks: '',
      },
    ]);
    setAssignProductSearch('');
    setIsAssignProductDropdownOpen(false);
  };

  const handleUpdateAssignItem = (id: string, updates: Partial<AssignBinLine>) => {
    setAssignItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  };

  const handleRemoveAssignItem = (id: string) => {
    setAssignItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleResetAssignForm = () => {
    setAssignItems([]);
    setAssignProductSearch('');
    setAssignBranchId(userBranchId);
  };

  // 4. Submit Assign Fixed Asset (multi-bin deployment)
  const handleSubmitAssignAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (assignItems.length === 0) {
      alertDialog('Add at least one asset/product line to the deployment bin.');
      return;
    }
    const todayAD = new Date().toISOString().split('T')[0];
    const todayBS = tryConvertADToBS(todayAD)?.formattedBSShort || '';

    // Per-line validation: destination + stock + serial pairs.
    for (const item of assignItems) {
      if (item.usedAtType === 'POP' && !item.usedAtLocationId) {
        alertDialog(`Line "${item.productName}": select a POP / Network Location.`);
        return;
      }
      if (item.usedAtType === 'CUSTOMER' && !item.usedAtCustomerId) {
        alertDialog(`Line "${item.productName}": select a Customer.`);
        return;
      }
      if (item.kind === 'PRODUCT') {
        const availableAssetStock = stock.find((entry) => entry.productId === item.productId && entry.branchId === assignBranchId);
        if (!availableAssetStock || availableAssetStock.quantityOnHand < item.quantity) {
          alertDialog(`Cannot assign "${item.productName}": requested ${item.quantity} unit(s) but only ${availableAssetStock?.quantityOnHand || 0} available at the selected branch.`);
          return;
        }
        if (item.isSerialized) {
          // IN_STOCK serial identity lives in the serial_log register (branch
          // stock intake), so validate against it. customer_device_records only
          // holds devices already issued to customers — kept as a fallback for
          // legacy flows that seed that table directly.
          const pair = (sn?: string, pon?: string) => ({
            sn: (sn || '').trim().toUpperCase(),
            pon: (pon || '').trim().toUpperCase(),
          });
          const want = pair(item.deviceSerial, item.ponSerial);
          const inStockInSerialLog = assignSerialLogCache.some((log) => {
            const got = pair(log.deviceSerial, log.ponSerial);
            return (
              got.sn === want.sn &&
              got.pon === want.pon &&
              log.branchId === assignBranchId &&
              log.status === 'IN_STOCK' &&
              (log.productName || '').trim().toLowerCase() === (item.productName || '').trim().toLowerCase()
            );
          });
          const matchingAssetDevice = inStockInSerialLog
            ? true
            : customerDevices.find(
                (device) =>
                  device.deviceSerial?.trim().toUpperCase() === item.deviceSerial.trim().toUpperCase() &&
                  device.ponSerial?.trim().toUpperCase() === item.ponSerial.trim().toUpperCase() &&
                  device.branchId === assignBranchId &&
                  device.status === 'IN_STOCK' &&
                  device.productName?.trim().toLowerCase() === item.productName.trim().toLowerCase()
              );
          if (!matchingAssetDevice) {
            alertDialog(`Line "${item.productName}": the Device Serial/PON pair must match an IN_STOCK unit at the selected branch.`);
            return;
          }
        }
      }
    }

    const createdTags: string[] = [];

    for (const item of assignItems) {
      if (item.kind === 'PRODUCT') {
        const prodMeta = products.find((p) => p.id === item.productId);
        for (let unitIdx = 0; unitIdx < item.quantity; unitIdx++) {
          const unitTag = `FA-${item.sku.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)}-${Math.floor(1000 + Math.random() * 9000)}`;
          await api.createAsset({
            tagNumber: unitTag,
            name: item.productName,
            category: prodMeta?.category || 'IT Equipment',
            branchId: assignBranchId,
            acquisitionDateAD: todayAD,
            acquisitionDateBS: todayBS,
            acquisitionCost: prodMeta?.costPrice || 0,
            depreciationMethod: 'STRAIGHT_LINE',
            depreciationRatePercent: prodMeta?.depreciationRate || 15,
            productId: item.productId,
            status: item.usedAtType === 'CUSTOMER' ? 'ASSIGNED_TO_CUSTOMER' : 'ASSIGNED_TO_LOCATION',
            assignedType: item.usedAtType === 'CUSTOMER' ? 'CUSTOMER' : 'LOCATION',
            assignedCustomerId: item.usedAtType === 'CUSTOMER' ? item.usedAtCustomerId : undefined,
            assignedCustomerName: item.usedAtType === 'CUSTOMER' ? item.usedAtCustomerName : undefined,
            assignedLocationId: item.usedAtType !== 'CUSTOMER' ? item.usedAtLocationId : undefined,
            assignedLocationName: item.usedAtType !== 'CUSTOMER' ? item.usedAtLocationName : undefined,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
            deployFromStock: true,
            deviceSerial: item.deviceSerial || undefined,
          });
          createdTags.push(unitTag);

          if (item.usedAtType === 'CUSTOMER' && item.usedAtCustomerId) {
            const custObj = customers.find((c) => c.id === item.usedAtCustomerId);
            if (custObj) {
              await api.createCustomerDevice({
                customerId: custObj.id,
                customerName: custObj.customerName,
                customerCode: custObj.customerId,
                contactPhone: custObj.contactNumber || '9800000000',
                installationAddress: custObj.address || 'Nepal',
                branchId: assignBranchId,
                productName: item.productName,
                deviceSerial: unitIdx === 0
                  ? (item.deviceSerial || `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`)
                  : `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
                ponSerial: unitIdx === 0
                  ? (item.ponSerial || `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`)
                  : `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
                macAddress: unitIdx === 0 ? (item.macAddress || undefined) : undefined,
                status: 'RENTAL',
                issuedDateAD: todayAD,
                issuedDateBS: todayBS,
                notes: `[RENTAL CPE ASSET - Tag: ${unitTag}] ${item.remarks}`,
              });
            }
          }
        }
      } else if (item.kind === 'ASSET' && item.assetId && onUpdateAssetStatus) {
        const ledgerAsset = assets.find((x) => x.id === item.assetId);
        if (item.usedAtType === 'CUSTOMER') {
          const custObj = customers.find((c) => c.id === item.usedAtCustomerId);
          await onUpdateAssetStatus(item.assetId, {
            status: 'ASSIGNED_TO_CUSTOMER',
            assignedType: 'CUSTOMER',
            assignedCustomerId: item.usedAtCustomerId,
            assignedCustomerName: item.usedAtCustomerName,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
          });
          if (custObj) {
            await api.createCustomerDevice({
              customerId: custObj.id,
              customerName: custObj.customerName,
              customerCode: custObj.customerId,
              contactPhone: custObj.contactNumber || '9800000000',
              installationAddress: custObj.address || 'Nepal',
              branchId: ledgerAsset?.branchId || assignBranchId,
              productName: ledgerAsset?.name || item.productName,
              deviceSerial: `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
              ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
              status: 'RENTAL',
              issuedDateAD: todayAD,
              issuedDateBS: todayBS,
              notes: `[FIXED ASSET CPE - Tag: ${ledgerAsset?.tagNumber}] ${item.remarks}`,
            });
          }
        } else {
          await onUpdateAssetStatus(item.assetId, {
            status: 'ASSIGNED_TO_LOCATION',
            assignedType: 'LOCATION',
            assignedLocationId: item.usedAtLocationId,
            assignedLocationName: item.usedAtLocationName,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
          });
        }
        createdTags.push(ledgerAsset?.tagNumber || item.sku);
      }
    }

    alertDialog(`Deployment complete — ${assignItems.length} bin line(s) processed. Tags: ${createdTags.join(', ')}`);
    handleResetAssignForm();
    if (typeof window !== 'undefined') window.location.reload();
  };

  // 6. Submit Consumable Issue to Technician / Work Order Field Usage
  const handleSubmitConsumableIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (consumableItems.length === 0) {
      alertDialog('Please add at least one consumable item to issue.');
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

    alertDialog(`Successfully issued ${consumableItems.length} consumable material line item(s) to Technician ${consumableTechnician} for Work Order ${consumableWorkOrder}!`);
    setConsumableItems([]);
    setConsumableReason('Field fiber splicing & customer drop installation material usage');
  };

  // 5. Submit Product Sale to Customer
  // 5. (PHASE 1) Product Sale form state — provisionally re-exported for
  //    the merge into SalesInvoices.tsx (Phase 2). Retained in this file
  //    until the refactor target is approved.
  const [sellCustomerId, setSellCustomerId] = useState<string>(customers[0]?.id || '');
  const [sellBranchId, setSellBranchId] = useState<string>(userBranchId);
  const [sellPaymentMethod, setSellPaymentMethod] = useState<string>('Cash / Direct Payment');
  const [sellNotes, setSellNotes] = useState<string>('Direct retail product item sale to customer');
  const [sellItems, setSellItems] = useState<SaleItem[]>([]);

  // Customer SEARCH field state (searchable input + dropdown, not a native select).
  // `sellCustomerQuery` is the visible text; `sellCustomerId` stays the canonical FK.
  const sellCustomerDropdownRef = useRef<HTMLDivElement | null>(null);
  const [sellCustomerQuery, setSellCustomerQuery] = useState<string>(() => {
    const c = customers[0];
    return c ? `${c.customerName} (${c.customerId})` : '';
  });
  const [isSellCustomerDropdownOpen, setIsSellCustomerDropdownOpen] = useState<boolean>(false);

  const sellCustomerDisplay = (c: CustomerRecord) => `${c.customerName} (${c.customerId})`;

  // Helper to check if an operation belongs to user's allowed branches
  const isOpInAllowedBranch = (op: StockOperation) => {
    if (canSeeAll) return true;
    return (
      (op.branchId && allowedBranchIds.includes(op.branchId)) ||
      (op.destinationWarehouseId && allowedBranchIds.includes(op.destinationWarehouseId))
    );
  };

  // Filter the customer search dropdown by query text.
  const filteredSellCustomers = useMemo(() => {
    const q = sellCustomerQuery.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        c.customerId.toLowerCase().includes(q) ||
        (c.contactNumber || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q)
    );
  }, [customers, sellCustomerQuery]);

  // Close the customer dropdown on outside click.
  useEffect(() => {
    if (!isSellCustomerDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (sellCustomerDropdownRef.current && !sellCustomerDropdownRef.current.contains(e.target as Node)) {
        setIsSellCustomerDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isSellCustomerDropdownOpen]);
  // (form reset, customers list loads, default selection).
  useEffect(() => {
    const c = customers.find((x) => x.id === sellCustomerId);
    if (c) setSellCustomerQuery(sellCustomerDisplay(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellCustomerId, customers]);

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

  // Consumables Register: client-side fallback filter (search + branch +
  // status + dates). Used only when the paged server fetch fails, so the
  // register degrades to the previous prop-fed behavior instead of breaking.
  const filterConsumableRegisterOps = useCallback((ops: StockOperation[]) => {
    const q = consumableRegisterQuery.trim().toLowerCase();
    return ops.filter((op) => {
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
  }, [consumableRegisterQuery, consumableRegisterBranch, consumableRegisterStatus, consumableRegisterDateFrom, consumableRegisterDateTo]);

  const consumableRegisterFallbackOps = useMemo(
    () => filterConsumableRegisterOps(consumableOperations),
    [filterConsumableRegisterOps, consumableOperations]
  );

  // Server-side paged fetch: one page of filtered CONSUMABLE_ISSUE rows.
  const consumableRegisterFetchSeq = useRef(0);
  const loadConsumableRegisterPage = useCallback(async () => {
    const seq = ++consumableRegisterFetchSeq.current;
    setConsumableRegisterLoading(true);
    setConsumableRegisterError('');
    try {
      const envelope = await api.getStockOperations({
        type: 'CONSUMABLE_ISSUE',
        branchId: consumableRegisterBranch !== 'ALL' ? consumableRegisterBranch : undefined,
        status: consumableRegisterStatus,
        query: consumableRegisterQuery.trim() || undefined,
        dateFromAD: consumableRegisterDateFrom || undefined,
        dateToAD: consumableRegisterDateTo || undefined,
        page: consumableRegisterPage,
        pageSize: consumableRegisterPageSize,
      }) as { data: StockOperation[]; totalItems: number };
      if (seq !== consumableRegisterFetchSeq.current) return; // superseded
      setConsumableRegisterRows(envelope.data || []);
      setConsumableRegisterTotal(envelope.totalItems || 0);
    } catch (err: any) {
      if (seq !== consumableRegisterFetchSeq.current) return;
      setConsumableRegisterError(err?.message || 'Failed to load the register');
    } finally {
      if (seq === consumableRegisterFetchSeq.current) setConsumableRegisterLoading(false);
    }
  }, [consumableRegisterBranch, consumableRegisterStatus, consumableRegisterQuery, consumableRegisterDateFrom, consumableRegisterDateTo, consumableRegisterPage, consumableRegisterPageSize]);

  useEffect(() => {
    loadConsumableRegisterPage();
  }, [loadConsumableRegisterPage, sseRefreshKey]);

  // Filter changes snap the server page back to 1.
  useEffect(() => {
    setConsumableRegisterPage(1);
  }, [consumableRegisterBranch, consumableRegisterStatus, consumableRegisterQuery, consumableRegisterDateFrom, consumableRegisterDateTo]);

  // Rows to render: the server page, or the client-side fallback after a
  // fetch failure so the ledger still displays.
  const consumableRegisterOps = consumableRegisterError ? consumableRegisterFallbackOps : consumableRegisterRows;
  const consumableRegisterCount = consumableRegisterError ? consumableRegisterFallbackOps.length : consumableRegisterTotal;

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
      alertDialog('Please select a customer device to exchange.');
      return;
    }
    if (!exchangeNewSerial.trim() || !exchangeNewPon.trim()) {
      alertDialog('Please enter new device serial number (SN) and PON serial number.');
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
      alertDialog('The replacement Device Serial/PON pair must match an IN_STOCK device at the selected branch.');
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

      alertDialog(`Device Exchange Successful!\nCustomer: ${selectedDeviceForExchange.customerName}\nNew Serial: ${exchangeNewSerial.trim()}\n${actionText}`);

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
      alertDialog(err?.message || 'Failed to exchange device.');
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

  const allCombinedOps = [...operations, ...synthesizedDamageOps];

  // Damage-log register pagination: the DAMAGE_TRACKING tab renders this list
  // without any server-side window, so cap the DOM with client pagination
  // (same pattern as DamagedStockTracking).
  const [damageLogPage, setDamageLogPage] = useState(1);
  const [damageLogPageSize, setDamageLogPageSize] = useState(20);
  const damageLogOps = useMemo(() => {
    if (activeTab !== 'DAMAGE_TRACKING') return [];
    return allCombinedOps.filter((op) => op.type === 'DAMAGE' || op.type === 'DISPOSAL');
  }, [allCombinedOps, activeTab]);
  const damageLogPageCount = Math.max(1, Math.ceil(damageLogOps.length / damageLogPageSize));
  const safeDamageLogPage = Math.min(damageLogPage, damageLogPageCount);
  const pagedDamageLogOps = useMemo(
    () => damageLogOps.slice((safeDamageLogPage - 1) * damageLogPageSize, safeDamageLogPage * damageLogPageSize),
    [damageLogOps, safeDamageLogPage, damageLogPageSize]
  );

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

  // Catalog Products suitable for Fixed Asset & Customer Rental CPE deployment
  // Panel context (Section G pure move): the host owns every piece of state and
  // every handler; panels destructure exactly what they render.
  const ctx: StockOperationsCtx = {
    activeTab,
    allowedBranches,
    approvalRequests,
    assetIsSerializedProduct,
    assignBranchId,
    assignItems,
    assignProductDropdownRef,
    assignProductSearch,
    availableStockAssets,
    binNotes,
    branchFilter,
    branches,
    canDispatchFromWarehouse,
    canReverseDamage,
    canSeeAll,
    confirmDialog,
    currentUser,
    customers,
    consumableBranchId,
    consumableItems,
    consumableProducts,
    consumableReason,
    consumableRegisterBranch,
    consumableRegisterCount,
    consumableRegisterDateFrom,
    consumableRegisterDateTo,
    consumableRegisterError,
    consumableRegisterExpandedId,
    consumableRegisterLoading,
    consumableRegisterOps,
    consumableRegisterPage,
    consumableRegisterPageSize,
    consumableRegisterQuery,
    consumableRegisterStatus,
    consumableTechnician,
    consumableWorkOrder,
    damageBranchId,
    damageInspector,
    damageItems,
    damageLogOps,
    damageLogPageCount,
    damageLogPageSize,
    damageReason,
    dateMode,
    destWarehouseId,
    destWarehouseOptions,
    effectivePulloutSourceBranches,
    exchangeCustomerDevices,
    exchangeNewMac,
    exchangeNewPon,
    exchangeNewSerial,
    exchangeNotes,
    exchangeProductName,
    exchangeReason,
    exchangeSearchQuery,
    expandedShipmentId,
    filteredAssignProducts,
    filteredExchangeDevices,
    filteredOperations,
    filteredSellCustomers,
    handleAddAssignAssetToBin,
    handleAddAssignProductToBin,
    handleAddConsumableItem,
    handleAddDamageItem,
    handleAddProductToPullout,
    handleAddSellItem,
    handleAddTransferItem,
    handlePerformExchange,
    handleRemoveAssignItem,
    handleRemoveConsumableItem,
    handleRemovePulloutItem,
    handleRemoveSellItem,
    handleRemoveTransferItem,
    handleResetAssignForm,
    handleResetConsumableForm,
    handleResetSellForm,
    handleResetTransferForm,
    handleReverseConsumableIssue,
    handleReverseDamageRecord,
    handleSubmitAssignAsset,
    handleSubmitConsumableIssue,
    handleSubmitCreateTransfer,
    handleSubmitDamageTag,
    handleSubmitPulloutBin,
    handleSubmitSellProductSale,
    handleUpdateAssignItem,
    handleUpdateConsumableItem,
    handleUpdatePulloutItem,
    handleUpdateSellItem,
    handleUpdateTransferItem,
    isAssignProductDropdownOpen,
    isConsumableRuleBannerVisible,
    isDamageModalOpen,
    isLoadingExchangeDevices,
    isPulloutModalOpen,
    isReversibleDamageOp,
    isSellCustomerDropdownOpen,
    isSubmittingExchange,
    isSuperOrInventory,
    isWarehouseOrHeadOffice,
    locations,
    oldDeviceAction,
    onReceiveOperation,
    onReceiveShipment,
    openReceiveModal,
    operations,
    pagedDamageLogOps,
    products,
    pulloutItems,
    safeDamageLogPage,
    saleEligibleProducts,
    selectedBranchId,
    selectedDeviceForExchange,
    sellBranchId,
    sellCustomerDisplay,
    sellCustomerDropdownRef,
    sellCustomerId,
    sellCustomerQuery,
    sellItems,
    sellNotes,
    sellPaymentMethod,
    sourceBranchId,
    shipments,
    stock,
    transferItems,
    transferStatusFilter,
    updateDamageItem,
    updateDamageItemSerial,
    updatePulloutDeviceSerial,
    updatePulloutPonSerial,
    updateSellDeviceSerial,
    updateSellPonSerial,
    updateTransferDeviceSerial,
    updateTransferPonSerial,
    userBranchId,
    xferDestBranchId,
    xferNotes,
    xferSourceBranchId,
    setActiveTab,
    setAssignBranchId,
    setAssignProductSearch,
    setBinNotes,
    setBranchFilter,
    setCancelPendingRequestModal,
    setConsumableBranchId,
    setConsumableReason,
    setConsumableRegisterBranch,
    setConsumableRegisterDateFrom,
    setConsumableRegisterDateTo,
    setConsumableRegisterExpandedId,
    setConsumableRegisterPage,
    setConsumableRegisterPageSize,
    setConsumableRegisterQuery,
    setConsumableRegisterStatus,
    setConsumableTechnician,
    setConsumableWorkOrder,
    setDamageBranchId,
    setDamageInspector,
    setDamageItems,
    setDamageLogPage,
    setDamageLogPageSize,
    setDamageReason,
    setDestWarehouseId,
    setDirectCancelModalShipment,
    setDirectCancelReason,
    setExchangeNewMac,
    setExchangeNewPon,
    setExchangeNewSerial,
    setExchangeNotes,
    setExchangeProductName,
    setExchangeReason,
    setExchangeSearchQuery,
    setExpandedShipmentId,
    setIsAssignProductDropdownOpen,
    setIsBarcodeScannerOpen,
    setIsConsumableRuleBannerVisible,
    setIsDamageModalOpen,
    setIsPulloutModalOpen,
    setIsSellCustomerDropdownOpen,
    setOldDeviceAction,
    setPulloutItems,
    setRequestCancelModalShipment,
    setRequestCancelReason,
    setSelectedDeviceForExchange,
    setSellBranchId,
    setSellCustomerId,
    setSellCustomerQuery,
    setSellNotes,
    setSellPaymentMethod,
    setSourceBranchId,
    setTransferStatusFilter,
    setXferDestBranchId,
    setXferNotes,
    setXferSourceBranchId,
  };

  return (
    <StockOperationsProvider value={ctx}>
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

      {/* Top Header — shared PageHeader (single h2 per screen rule) */}
      <PageHeader
        title="Stock Operations & Logistics Center"
        description="Manage overstock pullouts, branch damage labeling, inter-branch transfers, fixed asset site assignments, and customer product sales."
        icon={<AlertOctagon className="h-5 w-5 text-indigo-500 dark:text-indigo-400" />}
      />

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
                  alertDialog('Pullout dispatch operation is disabled for your role permissions.');
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
                  alertDialog('Damaged stock registration operation is disabled for your role permissions.');
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
                  alertDialog('Transfer receiving operation is disabled for your role permissions.');
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
                  alertDialog('Stock transfer creation operation is disabled for your role permissions.');
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
                  alertDialog('Fixed asset assignment operation is disabled for your role permissions.');
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
                  alertDialog('Product sale operation is disabled for your role permissions.');
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
{(() => {
        switch (activeTab) {
          case 'PULLOUT_BINS': return <PulloutBinsPanel />;
          case 'DAMAGE_TRACKING': return <DamageTrackingPanel />;
          case 'RECEIVE_TRANSFER': return <ReceiveTransferPanel />;
          case 'CREATE_TRANSFER': return <CreateTransferPanel />;
          case 'ASSIGN_ASSET': return <AssignAssetPanel />;
          case 'CONSUMABLE_ISSUE': return <ConsumableIssuePanel />;
          case 'CONSUMABLES_REGISTER': return <ConsumablesRegisterPanel />;
          case 'PRODUCT_SALE': return <ProductSalePanel />;
          case 'DEVICE_EXCHANGE': return <DeviceExchangePanel />;
          case 'CREATE_PULLOUT': return <CreatePulloutPanel />;
          case 'LABEL_DAMAGE': return <LabelDamagePanel />;
          case 'LOGS': return <LogsPanel />;
          default: return null;
        }
      })()}

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
    </StockOperationsProvider>
  );
};
