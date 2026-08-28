/**
 * Helpers to seed a clean in-memory store for tests without touching the
 * developer's real .data_store.json.
 */
import * as store from '../../server/store';
import { hashPassword } from '../../server/lib/authUtils';
import type { InventoryStock, Product, User } from '../../src/types';

export async function resetStoreForTests(options?: {
  withAdmin?: boolean;
  adminPassword?: string;
}): Promise<{ admin?: User; adminPassword: string }> {
  const adminPassword = options?.adminPassword || 'TestAdmin@123';

  store.replaceCollection('users', []);
  store.replaceCollection('suppliers', []);
  store.replaceCollection('products', []);
  store.replaceCollection('categories', []);
  store.replaceCollection('inventoryStock', []);
  store.replaceCollection('assetRegister', []);
  store.replaceCollection('customerDeviceRecords', []);
  store.replaceCollection('customerMasterRecords', []);
  store.replaceCollection('purchaseOrders', []);
  store.replaceCollection('purchaseInvoices', []);
  store.replaceCollection('shipments', []);
  store.replaceCollection('stockOperations', []);
  store.replaceCollection('auditTrail', []);
  store.replaceCollection('transactionLogs', []);
  store.replaceCollection('approvalRequests', []);
  store.replaceCollection('uomList', [...store.INITIAL_MASTER_UOM]);
  store.replaceCollection('locationRecords', [...store.INITIAL_MASTER_LOCATIONS]);
  store.replaceCollection('branches', [...store.INITIAL_MASTER_BRANCHES]);
  store.replaceCollection('fiscalYears', [...store.INITIAL_MASTER_FISCAL_YEARS]);
  store.setCompanyProfile({ ...store.INITIAL_COMPANY_PROFILE });
  store.setIsDemoDataCleared(true);
  store.setActiveUser(null);

  if (options?.withAdmin === false) {
    return { adminPassword };
  }

  const admin: User = {
    id: 'usr-test-admin',
    email: 'admin@test.local',
    name: 'Test Super Admin',
    role: 'SUPER_ADMIN',
    branchId: 'WH001',
    allowedBranchIds: store.branches.map((b) => b.id),
    canSwitchUser: true,
    password: await hashPassword(adminPassword),
  };
  store.users.push(admin);
  return { admin, adminPassword };
}

export function seedBasicCatalog(): { product: Product; stock: InventoryStock } {
  const product: Product = {
    id: 'prod-test-1',
    sku: 'ONU-TEST-001',
    barcode: 'BC-ONU-001',
    name: 'Test Fiber ONU',
    category: 'ONU',
    productGroup: 'Product Item',
    unit: 'Pcs',
    costPrice: 2500,
    sellingPrice: 3200,
    taxRate: 13,
    minReorderLevel: 5,
    requiresSerialTracking: true,
    trackingType: 'SERIAL_MAC_PON',
    status: 'ACTIVE',
  };
  store.products.push(product);

  const stock: InventoryStock = {
    id: 'stk-test-wh001-prod1',
    productId: product.id,
    branchId: 'WH001',
    quantityOnHand: 20,
    damagedQty: 0,
    reservedQty: 0,
    incomingQty: 0,
    minReorderLevel: 5,
    lastUpdated: new Date().toISOString(),
  };
  store.inventoryStock.push(stock);

  return { product, stock };
}
