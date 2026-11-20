/**
 * The app's provider composition, in one place.
 *
 * main.tsx renders `<AppProviders><App /></AppProviders>` and the A6 route-tree
 * harness renders the same component, so a provider added here can never exist
 * in the browser but be missing from the test (the failure mode that made the
 * first A6 attempt crash on `useDialog`).
 *
 * Order matters only where a provider consumes another: Session and Scope are
 * independent of the theme/dialog layer, so the shell-level providers wrap
 * them. StrictMode stays in main.tsx — tests deliberately render without it so
 * effects run once and render counts are deterministic.
 */
import React from 'react';
import { DarkModeProvider } from './DarkModeContext';
import { SessionProvider } from './SessionContext';
import { ScopeProvider } from './ScopeContext';
import { DialogProvider } from '../components/common/DialogProvider';
import { createContext, useContext, useRef, useState } from 'react';

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <DarkModeProvider>
    <SessionProvider>
      <ScopeProvider>
        <BootstrapDataProvider>
          <DialogProvider>{children}</DialogProvider>
        </BootstrapDataProvider>
      </ScopeProvider>
    </SessionProvider>
  </DarkModeProvider>
);

/**
 * The workspace's server-owned state, in one provider.
 *
 * The bootstrap payload (and each targeted slice refresh) fills exactly these
 * values, and the root used to hold every one of them as its own `useState`.
 * They live here instead so the data has one owner above the shell: a screen can
 * read what it renders without a fifteen-prop chain. Nothing here decides
 * freshness — the root's bootstrap and slice gate still call the setters — so
 * behaviour is unchanged.
 */
import type {
  ApprovalRequest,
  Branch,
  Category,
  CompanyProfile,
  DamageRecord,
  FinancialSummary,
  InventoryStock,
  LocationRecord,
  Product,
  PurchaseInvoice,
  PurchaseOrder,
  PurchaseReturn,
  SalesReturn,
  SerialLog,
  StockOperation,
  Supplier,
  User,
  AuditLog,
} from '../types';
import type { BootstrapSliceState } from '../services/bootstrapSlices';

/** Reachability of the application database, as the last bootstrap reported it. */
export interface PostgresStatus {
  isConnected: boolean;
  /** False until a bootstrap attempt has actually established the state. */
  statusKnown: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  engine?: string;
  errorDetails?: string;
}

/** Why the server refused the bootstrap payload (shown verbatim, never inferred). */
export interface BootstrapBlock {
  message: string;
  status?: number;
  /** Machine-readable cause from the server's body (see http.ts). */
  noCurrentFiscalYear?: boolean;
}

const EMPTY_FINANCIAL_SUMMARY: FinancialSummary = {
  totalInventoryAssetValue: 0,
  totalFixedAssetValue: 0,
  totalAccountsPayable: 0,
  totalSalesRevenue: 0,
  totalCostOfGoodsSold: 0,
  totalDamageLossValue: 0,
  totalVatInputTax: 0,
  currentFiscalYear: '2082/83',
};

export interface BootstrapData {
  companyProfile: CompanyProfile | null;
  branches: Branch[];
  suppliers: Supplier[];
  users: User[];
  products: Product[];
  categories: Category[];
  stock: InventoryStock[];
  /**
   * Sellable (IN_STOCK) serials for the Sell to Customer form's serial gate.
   * serial_log is a paged ledger and was deliberately dropped from bootstrap, so
   * this is one narrow status-filtered fetch per refresh instead of the whole
   * register (StockOperations hosts its own mount-once copy).
   */
  inventorySerials: SerialLog[];
  setInventorySerials: React.Dispatch<React.SetStateAction<SerialLog[]>>;
  approvalRequests: ApprovalRequest[];
  purchaseOrders: PurchaseOrder[];
  purchaseInvoices: PurchaseInvoice[];
  purchaseReturns: PurchaseReturn[];
  salesReturns: SalesReturn[];
  stockOperations: StockOperation[];
  auditLogs: AuditLog[];
  damageRecords: DamageRecord[];
  locations: LocationRecord[];
  financialSummary: FinancialSummary;
  postgresStatus: PostgresStatus;
  setPostgresStatus: React.Dispatch<React.SetStateAction<PostgresStatus>>;
  bootstrapBlocked: BootstrapBlock | null;
  setBootstrapBlocked: React.Dispatch<React.SetStateAction<BootstrapBlock | null>>;
  sliceState: BootstrapSliceState;
  setSliceState: React.Dispatch<React.SetStateAction<BootstrapSliceState>>;
  /**
   * Apply the slice keys a bootstrap payload actually carried. Absent keys are
   * left alone (a targeted refresh only proves its own slice), and the root
   * keeps the side effects that are not plain slice replacement: currency,
   * permissions, settings and the cache-only reachability rule.
   */
  apply: (payload: Record<string, any>) => void;
}

const BootstrapDataContext = createContext<BootstrapData | null>(null);

/**
 * `initial` seeds the three slices a rendered test needs to reproduce a signed-in
 * workspace (company profile, users, branches); the app itself never passes it.
 */
export const BootstrapDataProvider: React.FC<{
  children?: React.ReactNode;
  initial?: Partial<BootstrapData>;
}> = ({ children, initial }) => {
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState([]);
  const [users, setUsers] = useState<User[]>([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [stock, setStock] = useState([]);
  const [inventorySerials, setInventorySerials] = useState<SerialLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState([]);
  const [purchaseReturns, setPurchaseReturns] = useState([]);
  const [salesReturns, setSalesReturns] = useState([]);
  const [stockOperations, setStockOperations] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [damageRecords, setDamageRecords] = useState([]);
  const [locations, setLocations] = useState([]);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary>(EMPTY_FINANCIAL_SUMMARY);
  const [postgresStatus, setPostgresStatus] = useState<PostgresStatus>({
    isConnected: false,
    statusKnown: false,
    host: 'localhost',
    port: 5432,
    database: 'inventory_db',
    user: 'inventory_user',
  });
  const [bootstrapBlocked, setBootstrapBlocked] = useState<BootstrapBlock | null>(null);
  const [sliceState, setSliceState] = useState({});

  const setters: Record<string, React.Dispatch<React.SetStateAction<any>>> = {
    companyProfile: setCompanyProfile,
    branches: setBranches,
    suppliers: setSuppliers,
    users: setUsers,
    products: setProducts,
    categories: setCategories,
    stock: setStock,
    inventorySerials: setInventorySerials,
    approvalRequests: setApprovalRequests,
    purchaseOrders: setPurchaseOrders,
    purchaseInvoices: setPurchaseInvoices,
    purchaseReturns: setPurchaseReturns,
    salesReturns: setSalesReturns,
    stockOperations: setStockOperations,
    auditLogs: setAuditLogs,
    damageRecords: setDamageRecords,
    locations: setLocations,
    financialSummary: setFinancialSummary,
  };
  const apply = (payload: Record<string, any>) => {
    for (const key of Object.keys(setters)) {
      const slice = payload[key];
      if (slice) setters[key](slice);
    }
  };

  // `initial` is the test-only snapshot: it lands before the first paint so a
  // rendered screen sees the same slices App would have handed it.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    if (initial) for (const key of Object.keys(setters)) {
      const slice = (initial as Record<string, any>)[key];
      if (slice) setters[key](slice);
    }
  }

  const value: BootstrapData = {
    companyProfile,
    branches,
    suppliers,
    users,
    products,
    categories,
    stock,
    inventorySerials, setInventorySerials,
    approvalRequests,
    purchaseOrders,
    purchaseInvoices,
    purchaseReturns,
    salesReturns,
    stockOperations,
    auditLogs,
    damageRecords,
    locations,
    financialSummary,
    postgresStatus, setPostgresStatus,
    bootstrapBlocked, setBootstrapBlocked,
    sliceState, setSliceState,
    apply,
  };

  return <BootstrapDataContext.Provider value={value}>{children}</BootstrapDataContext.Provider>;
};

/** The bootstrap-owned workspace data; throws outside the provider. */
export function useBootstrapData(): BootstrapData {
  const value = useContext(BootstrapDataContext);
  if (!value) throw new Error('useBootstrapData must be used inside BootstrapDataProvider');
  return value;
}
