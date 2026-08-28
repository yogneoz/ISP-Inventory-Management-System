/**
 * Shared types for Stock Operations modules.
 */
import type {
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

export type StockOpsTab =
  | 'PULLOUT_BINS'
  | 'DAMAGE_TRACKING'
  | 'RECEIVE_TRANSFER'
  | 'CREATE_TRANSFER'
  | 'ASSIGN_ASSET'
  | 'CONSUMABLE_ISSUE'
  | 'PRODUCT_SALE'
  | 'DEVICE_EXCHANGE'
  | 'LOGS';

export interface StockOperationsProps {
  operations: StockOperation[];
  products: Product[];
  branches: Branch[];
  stock?: InventoryStock[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  initialType?: string;
  autoOpenModal?: boolean;
  isDarkMode?: boolean;
  currentUser?: User | null;
  shipments?: Shipment[];
  assets?: Asset[];
  locations?: LocationRecord[];
  customers?: CustomerRecord[];
  customerDevices?: CustomerDeviceRecord[];
  approvalRequests?: ApprovalRequest[];
  onCreateOperation?: (...args: any[]) => any;
  onReceiveOperation?: (...args: any[]) => any;
  onCreateShipment?: (...args: any[]) => any;
  onReceiveShipment?: (...args: any[]) => any;
  onCancelReceiveShipment?: (...args: any[]) => any;
  onRequestApproval?: (...args: any[]) => any;
  onCancelApproval?: (...args: any[]) => any;
  onUpdateAssetStatus?: (...args: any[]) => any;
}

export function resolveStockOpsTab(initialType?: string): StockOpsTab {
  if (initialType === 'DEVICE_EXCHANGE') return 'DEVICE_EXCHANGE';
  if (initialType === 'CONSUMABLE_ISSUE') return 'CONSUMABLE_ISSUE';
  if (initialType === 'DAMAGE') return 'DAMAGE_TRACKING';
  if (initialType === 'RECEIVE_TRANSFER' || initialType === 'RECEIVE') return 'RECEIVE_TRANSFER';
  if (initialType === 'CREATE_TRANSFER' || initialType === 'TRANSFER') return 'CREATE_TRANSFER';
  if (initialType === 'ASSIGN_ASSET' || initialType === 'ASSIGN') return 'ASSIGN_ASSET';
  if (initialType === 'STOCK_OUT' || initialType === 'PRODUCT_SALE') return 'PRODUCT_SALE';
  if (initialType === 'LOGS') return 'LOGS';
  return 'PULLOUT_BINS';
}
