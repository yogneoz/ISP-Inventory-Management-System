/**
 * StockOperations panel context - decomposition (FRONTEND-AUDIT.md Section G).
 *
 * "Pure move" step: the StockOperations host keeps ALL state and handlers
 * exactly where they were; each extracted tab panel (stockops/*Panel.tsx)
 * destructures what it renders from this context, so the JSX that moved is
 * byte-for-byte the JSX the inline conditional blocks used to render. The
 * context value is assembled by the host on every render - same data flow
 * as before, no behavior change.
 *
 * Member types: exact where the shape is clear, pragmatic (any-typed
 * signatures) for host-internal helpers whose exact types live in the host.
 * Each panel's destructure makes its true dependencies explicit.
 */
import { createContext, useContext } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type {
  StockOperation,
  ApprovalRequest,
  Product,
  Branch,
  InventoryStock,
  PulloutItem,
  Shipment,
  Asset,
  LocationRecord,
  CustomerRecord,
  CustomerDeviceRecord,
  User,
  ConsumableIssueItem,
  SaleItem,
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
  approvalRequests: ApprovalRequest[];
  assetIsSerializedProduct: (p: Product) => boolean;
  assignBranchId: any;
  assignItems: AssignBinLine[];
  assignProductDropdownRef: RefObject<HTMLDivElement | null>;
  assignProductSearch: any;
  availableStockAssets: Asset[];
  binNotes: any;
  branchFilter: any;
  branches: Branch[];
  canDispatchFromWarehouse: boolean;
  canReverseDamage: boolean;
  canSeeAll: boolean;
  confirmDialog: any;
  currentUser: User | null;
  customers: CustomerRecord[];
  consumableBranchId: any;
  consumableItems: ConsumableIssueItem[];
  consumableProducts: Product[];
  consumableReason: any;
  consumableRegisterBranch: any;
  consumableRegisterCount: number;
  consumableRegisterDateFrom: any;
  consumableRegisterDateTo: any;
  consumableRegisterError: string;
  consumableRegisterExpandedId: string | null;
  consumableRegisterLoading: boolean;
  consumableRegisterOps: StockOperation[];
  consumableRegisterPage: any;
  consumableRegisterPageSize: any;
  consumableRegisterQuery: any;
  consumableRegisterStatus: any;
  consumableTechnician: any;
  consumableWorkOrder: any;
  damageBranchId: any;
  damageInspector: any;
  damageItems: PulloutItem[];
  damageLogOps: StockOperation[];
  damageLogPageCount: number;
  damageLogPageSize: number;
  damageReason: any;
  dateMode: 'BS' | 'AD';
  destWarehouseId: any;
  destWarehouseOptions: Branch[];
  effectivePulloutSourceBranches: Branch[];
  exchangeCustomerDevices: CustomerDeviceRecord[];
  exchangeNewMac: any;
  exchangeNewPon: any;
  exchangeNewSerial: any;
  exchangeNotes: any;
  exchangeProductName: any;
  exchangeReason: any;
  exchangeSearchQuery: any;
  expandedShipmentId: string | null;
  filteredAssignProducts: Product[];
  filteredExchangeDevices: CustomerDeviceRecord[];
  filteredOperations: StockOperation[];
  filteredSellCustomers: CustomerRecord[];
  handleAddAssignAssetToBin: (...args: any[]) => any;
  handleAddAssignProductToBin: (...args: any[]) => any;
  handleAddConsumableItem: (...args: any[]) => any;
  handleAddDamageItem: (...args: any[]) => any;
  handleAddProductToPullout: (...args: any[]) => any;
  handleAddSellItem: (...args: any[]) => any;
  handleAddTransferItem: (...args: any[]) => any;
  handlePerformExchange: (...args: any[]) => any;
  handleRemoveAssignItem: (...args: any[]) => any;
  handleRemoveConsumableItem: (...args: any[]) => any;
  handleRemovePulloutItem: (...args: any[]) => any;
  handleRemoveSellItem: (...args: any[]) => any;
  handleRemoveTransferItem: (...args: any[]) => any;
  handleResetAssignForm: (...args: any[]) => any;
  handleResetConsumableForm: (...args: any[]) => any;
  handleResetSellForm: (...args: any[]) => any;
  handleResetTransferForm: (...args: any[]) => any;
  handleReverseConsumableIssue: (...args: any[]) => any;
  handleReverseDamageRecord: (...args: any[]) => any;
  handleSubmitAssignAsset: (...args: any[]) => any;
  handleSubmitConsumableIssue: (...args: any[]) => any;
  handleSubmitCreateTransfer: (...args: any[]) => any;
  handleSubmitDamageTag: (...args: any[]) => any;
  handleSubmitPulloutBin: (...args: any[]) => any;
  handleSubmitSellProductSale: (...args: any[]) => any;
  handleUpdateAssignItem: (...args: any[]) => any;
  handleUpdateConsumableItem: (...args: any[]) => any;
  handleUpdatePulloutItem: (...args: any[]) => any;
  handleUpdateSellItem: (...args: any[]) => any;
  handleUpdateTransferItem: (...args: any[]) => any;
  isAssignProductDropdownOpen: any;
  isConsumableRuleBannerVisible: any;
  isDamageModalOpen: boolean;
  isLoadingExchangeDevices: any;
  isPulloutModalOpen: boolean;
  isReversibleDamageOp: (op: StockOperation) => boolean;
  isSellCustomerDropdownOpen: any;
  isSubmittingExchange: any;
  isSuperOrInventory: boolean;
  isWarehouseOrHeadOffice: (b?: Branch | null) => boolean;
  locations: LocationRecord[];
  oldDeviceAction: string;
  onReceiveOperation: any;
  onReceiveShipment: any;
  openReceiveModal: (...args: any[]) => any;
  operations: StockOperation[];
  pagedDamageLogOps: StockOperation[];
  products: Product[];
  pulloutItems: PulloutItem[];
  safeDamageLogPage: number;
  saleEligibleProducts: Product[];
  selectedBranchId: any;
  selectedDeviceForExchange: CustomerDeviceRecord | null;
  sellBranchId: any;
  sellCustomerDisplay: (c: CustomerRecord) => string;
  sellCustomerDropdownRef: RefObject<HTMLDivElement | null>;
  sellCustomerId: any;
  sellCustomerQuery: any;
  sellItems: SaleItem[];
  sellNotes: any;
  sellPaymentMethod: any;
  sourceBranchId: any;
  shipments: Shipment[];
  stock: InventoryStock[];
  transferItems: TransferFormLine[];
  transferStatusFilter: any;
  updateDamageItem: (...args: any[]) => any;
  updateDamageItemSerial: (...args: any[]) => any;
  updatePulloutDeviceSerial: (...args: any[]) => any;
  updatePulloutPonSerial: (...args: any[]) => any;
  updateSellDeviceSerial: (...args: any[]) => any;
  updateSellPonSerial: (...args: any[]) => any;
  updateTransferDeviceSerial: (...args: any[]) => any;
  updateTransferPonSerial: (...args: any[]) => any;
  userBranchId: string;
  xferDestBranchId: any;
  xferNotes: any;
  xferSourceBranchId: any;

  setActiveTab: (v: any) => void;
  setAssignBranchId: (v: any) => void;
  setAssignProductSearch: (v: any) => void;
  setBinNotes: (v: any) => void;
  setBranchFilter: (v: any) => void;
  setCancelPendingRequestModal: (v: any) => void;
  setConsumableBranchId: (v: any) => void;
  setConsumableReason: (v: any) => void;
  setConsumableRegisterBranch: (v: any) => void;
  setConsumableRegisterDateFrom: (v: any) => void;
  setConsumableRegisterDateTo: (v: any) => void;
  setConsumableRegisterExpandedId: (v: any) => void;
  setConsumableRegisterPage: (v: any) => void;
  setConsumableRegisterPageSize: (v: any) => void;
  setConsumableRegisterQuery: (v: any) => void;
  setConsumableRegisterStatus: (v: any) => void;
  setConsumableTechnician: (v: any) => void;
  setConsumableWorkOrder: (v: any) => void;
  setDamageBranchId: (v: any) => void;
  setDamageInspector: (v: any) => void;
  setDamageItems: Dispatch<SetStateAction<PulloutItem[]>>;
  setDamageLogPage: (v: any) => void;
  setDamageLogPageSize: (v: any) => void;
  setDamageReason: (v: any) => void;
  setDestWarehouseId: (v: any) => void;
  setDirectCancelModalShipment: (v: any) => void;
  setDirectCancelReason: (v: any) => void;
  setExchangeNewMac: (v: any) => void;
  setExchangeNewPon: (v: any) => void;
  setExchangeNewSerial: (v: any) => void;
  setExchangeNotes: (v: any) => void;
  setExchangeProductName: (v: any) => void;
  setExchangeReason: (v: any) => void;
  setExchangeSearchQuery: (v: any) => void;
  setExpandedShipmentId: (v: any) => void;
  setIsAssignProductDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setIsBarcodeScannerOpen: (v: any) => void;
  setIsConsumableRuleBannerVisible: (v: any) => void;
  setIsDamageModalOpen: (v: any) => void;
  setIsPulloutModalOpen: (v: any) => void;
  setIsSellCustomerDropdownOpen: Dispatch<SetStateAction<boolean>>;
  setOldDeviceAction: (v: any) => void;
  setPulloutItems: (v: any) => void;
  setRequestCancelModalShipment: (v: any) => void;
  setRequestCancelReason: (v: any) => void;
  setSelectedDeviceForExchange: (v: any) => void;
  setSellBranchId: (v: any) => void;
  setSellCustomerId: (v: any) => void;
  setSellCustomerQuery: (v: any) => void;
  setSellNotes: (v: any) => void;
  setSellPaymentMethod: (v: any) => void;
  setSourceBranchId: (v: any) => void;
  setTransferStatusFilter: (v: any) => void;
  setXferDestBranchId: (v: any) => void;
  setXferNotes: (v: any) => void;
  setXferSourceBranchId: (v: any) => void;
}

const Ctx = createContext<StockOperationsCtx | null>(null);

export const StockOperationsProvider = Ctx.Provider;

export function useStockOperationsCtx(): StockOperationsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStockOperationsCtx must be used inside <StockOperationsProvider>');
  return v;
}
