import React, { useState, useEffect } from 'react';
import { PageHeader } from '../../components/common/PageHeader';
import {
  StockOperation,
  Product,
  Branch,
  InventoryStock,
  User,
  Shipment,
  Asset,
  LocationRecord,
  CustomerRecord,
  CustomerDeviceRecord,
  ApprovalRequest,
} from '../../types';
import { hasExactBSDayRecord } from '../../utils/nepaliCalendar';
import { api } from '../../services/api';
import { useDialog } from '../../components/common/DialogProvider';
import {
  AlertOctagon,
  X,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { isOperationAllowed, canUserSeeAllBranches, getAllowedBranches, getAllowedBranchIds } from '../../utils/permissions';
import { StockOperationsProvider, type StockOperationsCtx } from './stockops/StockOperationsContext';
import { computeStockOperationViews } from './stockops/stockOperationViews';
import { StockOperationsTabBar } from './stockops/StockOperationsTabBar';
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
  // Modal auto-open flags (autoOpenModal comes from App's pullout/damage
  // entry points); precomputed here so the panels can own the flag state.
  const initialPulloutModalOpen = autoOpenModal && initialType === 'PULLOUT';
  const initialDamageModalOpen = autoOpenModal && initialType === 'DAMAGE';

  // Filter state (shared: ReceiveTransfer sets it, the register lists read it)
  const [branchFilter, setBranchFilter] = useState<string>(selectedBranchId);

  // Exchange tab's deployed-device list — loaded here (not in the panel)
  // because the Device Exchange tab-bar counter needs it before the panel
  // first mounts; the exchange FORM state lives in DeviceExchangePanel.
  const [exchangeCustomerDevices, setExchangeCustomerDevices] = useState<CustomerDeviceRecord[]>([]);
  const [isLoadingExchangeDevices, setIsLoadingExchangeDevices] = useState<boolean>(false);

  // Allowed branches for current user
  const allowedBranches = getAllowedBranches(currentUser, branches);
  const allowedBranchIds = getAllowedBranchIds(currentUser, branches);
  const canSeeAll = canUserSeeAllBranches(currentUser);

  // Central warehouse dispatch is a warehouse function: only roles granted
  // `wh-restrict-transfer` (Super Admin / Inventory Manager by default) may
  // create inter-branch transfers originating from the warehouse.
  const canDispatchFromWarehouse = isOperationAllowed('wh-restrict-transfer', currentUser?.role);

  // First allowed branch id — the shared default for every form's branch field.
  const userBranchId = allowedBranches[0]?.id || branches[0]?.id || '';

  // Floating toast (shared: every panel's handlers show it via ctx).
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 5000);
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
            // Serial-tracked products are HARD-BLOCKED here on purpose: a
            // serial that is not in this branch's IN_STOCK register cannot be
            // tagged, pulled, issued or sold — the server enforces the same
            // rule, so this is not a client-side limitation to route around.
            // The dialog therefore states the requirement and the exact next
            // step instead of a bare "must match" dead end.
            const known = customerDevices.find(
              (cd) => cd.deviceSerial?.trim().toUpperCase() === cleanSerial
            );
            const where = known
              ? `it is registered at "${branches.find((b) => b.id === known.branchId)?.name || known.branchId}" with status "${known.status}"`
              : `no device with that serial exists in the register yet`;
            alertDialog(
              `Serial Register Error: Device Serial #${cleanSerial}${cleanPon ? ` / PON #${cleanPon}` : ''} cannot be used for "${item.productName}" at ${branchName} — ${where}.\n\n` +
                `This product is serial-tracked, so the serial must already be in "${branchName}"'s register with status IN_STOCK before stock can move.\n\n` +
                `Next step: open Inventory & Stock ➔ Customer Device Serials and receive this unit into "${branchName}" (scan the serial, confirm the product), then retry this operation.`
            );
            return false;
          }
        }
      }
    }

    return true;
  };

  // Fetch Customer Devices for Exchange Tab — stays with the host: the
  // Device Exchange tab-bar counter needs the list before the panel first
  // mounts (the exchange FORM state lives in DeviceExchangePanel).
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

  // Shared view derivations — tab-bar counts, the synthesized damage log and
  // the filtered register lists — live in stockops/stockOperationViews.ts.
  const { damageOperations, pulloutOperations, consumableOperations, saleOperations, allCombinedOps, filteredOperations, availableStockAssets } =
    computeStockOperationViews({ operations, stock, products, assets, canSeeAll, allowedBranchIds, branchFilter, activeTab });

  // Panel context (Section G commit 2): the host owns only the shared
  // chrome state — active tab, BS-date gate, toast, shared filters, the
  // tab-bar lists and the props/callbacks — plus the two helpers several
  // panels validate through. Everything panel-specific (form state,
  // effects, submit handlers, modals) lives in the owning stockops/*Panel.
  const ctx: StockOperationsCtx = {
    activeTab,
    allowedBranches,
    allCombinedOps,
    alertDialog,
    approvalRequests,
    assets,
    availableStockAssets,
    branchFilter,
    branches,
    canDispatchFromWarehouse,
    canSeeAll,
    confirmDialog,
    consumableOperations,
    currentUser,
    customers,
    customerDevices,
    dateMode,
    damageOperations,
    ensureBsDateAvailable,
    exchangeCustomerDevices,
    filteredOperations,
    focusInput,
    initialDamageModalOpen,
    initialPulloutModalOpen,
    isLoadingExchangeDevices,
    isSuperOrInventory,
    isWarehouseOrHeadOffice,
    locations,
    onCancelApproval,
    onCancelReceiveShipment,
    onCreateOperation,
    onCreateShipment,
    // Report mode is view-only: PulloutBinsPanel hides its Receive action
    // when this is undefined, keeping the Warehouse Pullout Report read-only.
    onReceiveOperation: initialType === 'PULLOUT_REPORT' ? undefined : onReceiveOperation,
    onReceiveShipment,
    onRequestApproval,
    onReverseConsumableIssue,
    onReverseOperation,
    onUpdateAssetStatus,
    operations,
    products,
    promptDialog,
    pulloutOperations,
    saleOperations,
    selectedBranchId,
    setBranchFilter,
    setExchangeCustomerDevices,
    shipments,
    showToast,
    sseRefreshKey,
    stock,
    userBranchId,
    validateSourceBranchStockAndSerials,
    setActiveTab,
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
      {!isStandalonePage && <StockOperationsTabBar initialType={initialType} />}

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
