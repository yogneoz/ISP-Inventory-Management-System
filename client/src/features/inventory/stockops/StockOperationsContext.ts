/**
 * StockOperations panel context - decomposition (FRONTEND-AUDIT.md Section G).
 *
 * Commit 1 ("pure move") extracted the 12 tab panels' JSX; commit 2
 * relocated each panel's state, effects and handlers into the panel itself.
 * What crosses this context is now only what is genuinely shared: host
 * chrome state (active tab, BS-date gate, toast, the shared branch filter),
 * the tab-bar data lists, the props/callbacks App feeds the host, and the
 * few helpers more than one panel validates through (stock/serial
 * validation, focus helper, auto-open modal flags). Each panel's destructure
 * makes its true dependencies explicit.
 *
 * Member types: exact where the shape is clear, pragmatic (any-typed
 * signatures) for host-internal helpers whose exact types live in the host.
 */
import { createContext, useContext } from 'react';
import type {
  StockOperation,
  ApprovalRequest,
  Product,
  Branch,
  InventoryStock,
  Shipment,
  Asset,
  LocationRecord,
  CustomerRecord,
  CustomerDeviceRecord,
  User,
  ShipmentItem,
} from '../../../types';

// Form-line types shared by the host and the panels (moved verbatim from
// StockOperations.tsx).
export interface DamageSerialEntry {
  deviceSerial: string;
  ponSerial: string;
}

// Local transfer form line: ShipmentItem plus form-only mirror fields (unit label, quantity)
export interface TransferFormLine extends ShipmentItem {
  unit?: string;
  quantity?: number;
}

// Asset deployment bin line: one assignable row inside the multi-item
// Assign Fixed Asset form (Product Sale pattern).
export interface AssignBinLine {
  id: string;
  kind: 'PRODUCT' | 'ASSET';
  productId?: string;      // PRODUCT: catalog source
  assetId?: string;        // ASSET: existing ledger entity
  productName: string;
  sku: string;
  unit: string;
  quantity: number;        // always 1 for ASSET / serialized PRODUCT lines
  isSerialized: boolean;
  deviceSerial: string;
  ponSerial: string;
  macAddress: string;
  usedAtType: 'FIELD' | 'POP' | 'CUSTOMER';
  usedAtLocationId?: string;
  usedAtLocationName?: string;
  usedAtCustomerId?: string;
  usedAtCustomerName?: string;
  remarks: string;
}

export interface StockOperationsCtx {
  activeTab: string;
  allowedBranches: Branch[];
  allCombinedOps: StockOperation[];
  alertDialog: any;
  approvalRequests: ApprovalRequest[];
  assets: Asset[];
  availableStockAssets: Asset[];
  branchFilter: any;
  branches: Branch[];
  canDispatchFromWarehouse: boolean;
  canSeeAll: boolean;
  confirmDialog: any;
  consumableOperations: StockOperation[];
  damageOperations: StockOperation[];
  currentUser: User | null;
  customers: CustomerRecord[];
  customerDevices: CustomerDeviceRecord[];
  dateMode: 'BS' | 'AD';
  ensureBsDateAvailable: any;
  exchangeCustomerDevices: CustomerDeviceRecord[];
  filteredOperations: StockOperation[];
  focusInput: any;
  initialDamageModalOpen: boolean;
  initialPulloutModalOpen: boolean;
  isLoadingExchangeDevices: boolean;
  isSuperOrInventory: boolean;
  isWarehouseOrHeadOffice: (b?: Branch | null) => boolean;
  locations: LocationRecord[];
  onCancelApproval: any;
  onCancelReceiveShipment: any;
  onCreateOperation: any;
  onCreateShipment: any;
  onReceiveOperation: any;
  onReceiveShipment: any;
  onRequestApproval: any;
  onReverseConsumableIssue: any;
  onReverseOperation: any;
  onUpdateAssetStatus: any;
  operations: StockOperation[];
  products: Product[];
  promptDialog: any;
  pulloutOperations: StockOperation[];
  saleOperations: StockOperation[];
  selectedBranchId: any;
  setBranchFilter: (v: any) => void;
  setExchangeCustomerDevices: (v: any) => void;
  shipments: Shipment[];
  showToast: (msg: string) => void;
  sseRefreshKey: number | undefined;
  stock: InventoryStock[];
  userBranchId: string;
  validateSourceBranchStockAndSerials: any;
  setActiveTab: (v: any) => void;
}

const Ctx = createContext<StockOperationsCtx | null>(null);

export const StockOperationsProvider = Ctx.Provider;

export function useStockOperationsCtx(): StockOperationsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStockOperationsCtx must be used inside <StockOperationsProvider>');
  return v;
}
