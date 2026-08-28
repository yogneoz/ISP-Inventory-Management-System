/**
 * Bootstrap + live sync data loading for the inventory app shell.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  User,
  Branch,
  Product,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  FinancialSummary,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  Supplier,
  CompanyProfile,
  BootstrapState,
} from '../types';
import { api, subscribeToSyncStream } from '../services/api';
import {
  saveRecentBootstrapCache,
  loadRecentBootstrapCache,
} from '../utils/sessionCache';

export interface InventoryDataState {
  companyProfile: CompanyProfile | null;
  branches: Branch[];
  suppliers: Supplier[];
  users: User[];
  products: Product[];
  categories: Category[];
  stock: InventoryStock[];
  assets: Asset[];
  customerDevices: CustomerDeviceRecord[];
  customers: CustomerRecord[];
  approvalRequests: ApprovalRequest[];
  purchaseOrders: PurchaseOrder[];
  purchaseInvoices: PurchaseInvoice[];
  shipments: Shipment[];
  stockOperations: StockOperation[];
  fiscalYears: FiscalYear[];
  auditLogs: AuditLog[];
  transactionLogs: TransactionLog[];
  financialSummary: FinancialSummary | null;
  loading: boolean;
  refreshAllData: () => Promise<void>;
  applyBootstrap: (data: BootstrapState) => void;
}

const emptySummary: FinancialSummary = {
  totalInventoryAssetValue: 0,
  totalFixedAssetValue: 0,
  totalAccountsPayable: 0,
  totalCostOfGoodsSold: 0,
  totalDamageLossValue: 0,
  totalVatInputTax: 0,
  currentFiscalYear: '',
};

export function useInventoryData(enabled: boolean): InventoryDataState {
  const [loading, setLoading] = useState(true);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stock, setStock] = useState<InventoryStock[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [customerDevices, setCustomerDevices] = useState<CustomerDeviceRecord[]>([]);
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<PurchaseInvoice[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [stockOperations, setStockOperations] = useState<StockOperation[]>([]);
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [transactionLogs, setTransactionLogs] = useState<TransactionLog[]>([]);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);

  const applyBootstrap = useCallback((data: BootstrapState) => {
    if ((data as any).companyProfile) setCompanyProfile((data as any).companyProfile);
    if (data.branches) setBranches(data.branches);
    if (data.suppliers) setSuppliers(data.suppliers);
    if (data.users) setUsers(data.users as User[]);
    if (data.products) setProducts(data.products);
    if (data.categories) setCategories(data.categories);
    if (data.stock) setStock(data.stock);
    if (data.assets) setAssets(data.assets);
    if (data.customerDevices) setCustomerDevices(data.customerDevices);
    if (data.customers) setCustomers(data.customers);
    if (data.approvalRequests) setApprovalRequests(data.approvalRequests);
    if (data.purchaseOrders) setPurchaseOrders(data.purchaseOrders);
    if (data.purchaseInvoices) setPurchaseInvoices(data.purchaseInvoices);
    if (data.shipments) setShipments(data.shipments);
    if (data.stockOperations) setStockOperations(data.stockOperations);
    if (data.fiscalYears) setFiscalYears(data.fiscalYears);
    if (data.auditLogs) setAuditLogs(data.auditLogs);
    if (data.transactionLogs) setTransactionLogs(data.transactionLogs);
    if (data.financialSummary) setFinancialSummary(data.financialSummary);
    else setFinancialSummary(emptySummary);
    saveRecentBootstrapCache(data);
  }, []);

  const refreshAllData = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const cached = loadRecentBootstrapCache();
      if (cached) applyBootstrap(cached);
      const data = await api.getBootstrapState();
      applyBootstrap(data);
    } catch (err) {
      console.error('Bootstrap refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, [enabled, applyBootstrap]);

  useEffect(() => {
    refreshAllData();
  }, [refreshAllData]);

  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeToSyncStream(() => {
      refreshAllData();
    });
    return unsub;
  }, [enabled, refreshAllData]);

  return {
    companyProfile,
    branches,
    suppliers,
    users,
    products,
    categories,
    stock,
    assets,
    customerDevices,
    customers,
    approvalRequests,
    purchaseOrders,
    purchaseInvoices,
    shipments,
    stockOperations,
    fiscalYears,
    auditLogs,
    transactionLogs,
    financialSummary,
    loading,
    refreshAllData,
    applyBootstrap,
  };
}
