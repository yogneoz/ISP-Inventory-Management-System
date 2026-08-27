/**
 * Route module: admin
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import {
  requireRole,
  requireAuth,
  logAuditEvent,
  sanitizeUser,
  findUserByIdOrEmail,
  migrateUserPasswordIfNeeded,
  getUserFromReq,
} from '../lib/auth';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  destroySession,
  destroyUserSessions,
  extractBearerToken,
  getTodayBsStamp,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
  getSession,
} from '../lib/authUtils';
import {
  broadcastChange,
  dataVersion,
  setDataVersion,
  bumpDataVersion,
  addSseClient,
  removeSseClient,
  forEachSseClient,
} from '../lib/sync';
import { getGenAIClient } from '../lib/ai';
import type {
  User,
  Supplier,
  Branch,
  Product,
  CompanyProfile,
  InventoryStock,
  Asset,
  PurchaseOrder,
  PurchaseInvoice,
  Shipment,
  StockOperation,
  FiscalYear,
  AuditLog,
  TransactionLog,
  CustomerDeviceRecord,
  CustomerRecord,
  ApprovalRequest,
  Category,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.post('/api/admin/clear-demo-data', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    if (isPgConnected) {
      await pgPool.query(`
        TRUNCATE TABLE 
          approval_requests,
          customer_device_records,
          customer_records,
          purchase_invoices,
          purchase_orders,
          shipments,
          stock_operations,
          inventory_stock,
          fixed_assets,
          products,
          categories,
          suppliers,
          audit_logs,
          transaction_logs
        CASCADE;
      `);
    }

    // Operational tables to clear
    store.products.length = 0;
    store.inventoryStock.length = 0;
    store.assetRegister.length = 0;
    store.customerDeviceRecords.length = 0;
    store.customerMasterRecords.length = 0;
    store.purchaseOrders.length = 0;
    store.purchaseInvoices.length = 0;
    store.shipments.length = 0;
    store.stockOperations.length = 0;
    store.auditTrail.length = 0;
    store.transactionLogs.length = 0;
    store.approvalRequests.length = 0;
    store.suppliers.length = 0;
    store.setIsDemoDataCleared(true);

    // Persist operational purge while strictly keeping users, branches, fiscalYears
    store.saveDataStore();

    bumpDataVersion();
    forEachSseClient((client) => {
      try {
        client.write(`data: ${JSON.stringify({ type: 'DEMO_DATA_CLEARED', dataVersion, timestamp: new Date().toISOString() })}\n\n`);
      } catch (_e) {}
    });

    return res.json({
      message: 'All demo and dummy operational data cleared successfully. Master users, branches, and fiscal years are intact.',
      userCount: store.users.length,
      superAdminCount: store.users.filter((u) => u.role === 'SUPER_ADMIN').length,
    });
  } catch (err: any) {
    console.error('Error clearing demo data:', err);
    return res.status(500).json({ message: 'Failed to clear demo data: ' + (err?.message || err) });
  }
});

// Auth Login

export default router;
