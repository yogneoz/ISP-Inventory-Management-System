/**
 * Inventory routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerInventoryRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_stock, patch_Id, patch_reorderLevel, post_bulkReorderLevels, post_reconcileAudit, get_assets, post_assets, patch_status, get_stockOperations, post_stockOperations, post_reverse, post_reverseConsumable, post_receive, get_customerDevices, post_customerDevices, patch_status2, get_lookup, get_lookup2, get_lookup3, post_dual, post_exchange, get_serialLog, post_serialLog } from '../controllers/inventory.controller';
import {
  assetRegister,
  branches,
  broadcastChange,
  customerDeviceRecords,
  damageRecords,
  detectDateTypeMismatch,
  findBsDayRecordForAdDate,
  getDataVersion,
  getFiscalYearCodeForDate,
  getFiscalYearIdForDate,
  getPgConnected,
  getUserFromReq,
  handleUpdateSerials,
  inventoryStock,
  issueNextDocNumber,
  logAuditEvent,
  mutable,
  products,
  purchaseInvoices,
  requirePermission,
  requireRole,
  requireStockOperationPermission,
  runSerialEditCapture,
  serialLogs,
  setAssetRegister,
  setCustomerDeviceRecords,
  setDamageRecords,
  setDataVersion,
  setInventoryStock,
  setSerialLogs,
  setStockOperations,
  setTransactionLogs,
  stockOperations,
  transactionLogs,
  users,
  withAppended,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { pgPool } from '../app';
import { calculateFixedAssetValues } from '../../../client/src/utils/depreciation';
import { buildDamageRecordInsert, buildReversalLedgerWithStock, deriveDamageItems, mirrorReversal, quarantineInMemorySerials, quarantineSerialsInDb, restoreInMemorySerials, restoreSerialsInDb, validateReversalAvailability } from '../services/damage.service';
import { applyDualEdit, generateParkTag, validateDualEditPayload } from '../services/serialEditCapture.service';
import type { CustomerDeviceRecord, DamageRecord, SerialLog, TransactionLog } from '../../../client/src/types';

export function registerInventoryRoutes(app: Express) {
app.get('/api/stock', async (req, res, next) => { get_stock(req as any, res as any).catch(next); });

app.patch('/api/stock/:id', async (req, res, next) => { patch_Id(req as any, res as any).catch(next); });

app.patch('/api/stock/:id/reorder-level', async (req, res, next) => { patch_reorderLevel(req as any, res as any).catch(next); });

app.post('/api/stock/bulk-reorder-levels', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER'), async (req, res, next) => { post_bulkReorderLevels(req as any, res as any).catch(next); });

app.post('/api/stock/reconcile-audit', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR'), async (req, res, next) => { post_reconcileAudit(req as any, res as any).catch(next); });

app.get('/api/assets', async (req, res, next) => { get_assets(req as any, res as any).catch(next); });

app.post('/api/assets', requirePermission('assets-manage'), async (req, res, next) => { post_assets(req as any, res as any).catch(next); });

app.patch('/api/assets/:id/status', async (req, res, next) => { patch_status(req as any, res as any).catch(next); });

app.get('/api/stock-operations', async (req, res, next) => { get_stockOperations(req as any, res as any).catch(next); });

app.post('/api/stock-operations', requireStockOperationPermission, async (req, res, next) => { post_stockOperations(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/reverse', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), requirePermission('branch-damage-mark'), async (req, res, next) => { post_reverse(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/reverse-consumable', requirePermission('consumable-issue-reverse'), async (req, res, next) => { post_reverseConsumable(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/receive', async (req, res, next) => { post_receive(req as any, res as any).catch(next); });

app.get('/api/customer-devices', async (req, res, next) => { get_customerDevices(req as any, res as any).catch(next); });

app.post('/api/customer-devices', requirePermission('customers-manage'), async (req, res, next) => { post_customerDevices(req as any, res as any).catch(next); });

app.patch('/api/customer-devices/:id/status', async (req, res, next) => { patch_status2(req as any, res as any).catch(next); });

app.patch('/api/inventory/serials', requirePermission('edit-device-serials'), handleUpdateSerials);
app.patch('/api/customer-devices/:id/serials', requirePermission('edit-device-serials'), handleUpdateSerials);

// ---------------------------------------------------------------------------
// Serial lookup — resolves a typed value (device serial, PON, or MAC) to the
// device that already holds it, across serial_log, customer_device_records,
// and fixed_assets. Powers the live duplicate detection in the serial edit
// modal so a conflicting device can be loaded into the second edit panel,
// even when it lives outside the user's branch-scoped register.
// ---------------------------------------------------------------------------
app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res, next) => { get_lookup(req as any, res as any).catch(next); });

app.patch('/api/customer-devices/:id/serials', requirePermission('edit-device-serials'), handleUpdateSerials);

// ---------------------------------------------------------------------------
// Serial lookup — resolves a typed value (device serial, PON, or MAC) to the
// device that already holds it, across serial_log, customer_device_records,
// and fixed_assets. Powers the live duplicate detection in the serial edit
// modal so a conflicting device can be loaded into the second edit panel,
// even when it lives outside the user's branch-scoped register.
// ---------------------------------------------------------------------------
app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res, next) => { get_lookup2(req as any, res as any).catch(next); });

app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res, next) => { get_lookup3(req as any, res as any).catch(next); });

app.post('/api/inventory/serials/dual', requirePermission('edit-device-serials'), async (req, res, next) => { post_dual(req as any, res as any).catch(next); });

app.post('/api/customer-devices/exchange', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'FIELD_TECHNICIAN', 'BRANCH_MANAGER'), async (req, res, next) => { post_exchange(req as any, res as any).catch(next); });

app.get('/api/serial-log', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'AUDITOR', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN'), async (req, res, next) => { get_serialLog(req as any, res as any).catch(next); });

app.post('/api/serial-log', requirePermission('edit-device-serials'), async (req, res, next) => { post_serialLog(req as any, res as any).catch(next); });

}
