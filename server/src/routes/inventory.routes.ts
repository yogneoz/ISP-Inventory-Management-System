/**
 * Inventory routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerInventoryRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_stock, patch_Id, patch_reorderLevel, post_bulkReorderLevels, post_reconcileAudit, post_assets, patch_status, get_stockOperations, post_stockOperations, post_reverse, post_reverseConsumable, post_reversePullout, post_reverseStockOut, post_receive, get_customerDevicesPage, get_customerDevicesOverview, get_customerDevicesWarranty, post_customerDevices, patch_status2, get_lookup, get_exchangeLookup, post_exchangeRefusal, post_dual, post_exchange, get_serialLog } from '../controllers/inventory.controller';
import { get_fixedAssetsPage, get_fixedAssetsOverview, get_fixedAssetsAvailable, get_fixedAssetsLookup } from '../controllers/fixedAssets.controller';
import {
  handleUpdateSerials,
  requirePermission,
  requireRole,
  requireStockOperationPermission,
} from '../app';
import { buildDamageRecordInsert, buildReversalLedgerWithStock, deriveDamageItems, mirrorReversal, quarantineInMemorySerials, quarantineSerialsInDb, restoreInMemorySerials, restoreSerialsInDb, validateReversalAvailability } from '../services/damage.service';
import { applyDualEdit, generateParkTag, validateDualEditPayload } from '../services/serialEditCapture.service';
import type { CustomerDeviceRecord, DamageRecord, SerialLog, TransactionLog } from '../../../client/src/types';

/**
 * CPE lifecycle audience. A direct status flip can close a rental and free its
 * serial without going through the approval/restock workflow, so it is limited
 * to the manager roles that already execute CPE approvals plus the inventory
 * manager who owns stock and the register. Exchange keeps its own
 * field-technician lane; sharing the manager base keeps the two audiences from
 * drifting apart.
 */
const CPE_MANAGER_ROLES = ['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER'] as const;
export const CPE_STATUS_ROLES = [...CPE_MANAGER_ROLES, 'INVENTORY_MANAGER'] as const;
export const CPE_EXCHANGE_ROLES = [...CPE_MANAGER_ROLES, 'FIELD_TECHNICIAN'] as const;

export function registerInventoryRoutes(app: Express) {
app.get('/api/stock', async (req, res, next) => { get_stock(req as any, res as any).catch(next); });

// Direct quantity/damage rewrites are a stock-level adjustment, not a read:
// gate them on the stock-level write operation (AUTHZ-6). Ordinary movements
// still go through POST /api/stock-operations, which has its own type-aware
// permission.
app.patch('/api/stock/:id', requirePermission('opening-stock-edit'), async (req, res, next) => { patch_Id(req as any, res as any).catch(next); });

app.patch('/api/stock/:id/reorder-level', requirePermission('prod-edit'), async (req, res, next) => { patch_reorderLevel(req as any, res as any).catch(next); });

app.post('/api/stock/bulk-reorder-levels', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER'), async (req, res, next) => { post_bulkReorderLevels(req as any, res as any).catch(next); });

app.post('/api/stock/reconcile-audit', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'AUDITOR'), async (req, res, next) => { post_reconcileAudit(req as any, res as any).catch(next); });

app.post('/api/assets', requirePermission('assets-manage'), async (req, res, next) => { post_assets(req as any, res as any).catch(next); });

app.patch('/api/assets/:id/status', async (req, res, next) => { patch_status(req as any, res as any).catch(next); });

// ASSET-1: fixed assets left the login payload. The registers page through
// /page, the dashboard/statements/FY-closing aggregates read /overview, the
// deployment pickers read /available, and a panel resolves one row with
// /lookup. Branch scope is resolved from the session and applied in SQL, like
// the paged shipment/customer/device reads.
app.get('/api/fixed-assets/page', async (req, res, next) => { get_fixedAssetsPage(req as any, res as any).catch(next); });

app.get('/api/fixed-assets/overview', async (req, res, next) => { get_fixedAssetsOverview(req as any, res as any).catch(next); });

app.get('/api/fixed-assets/available', async (req, res, next) => { get_fixedAssetsAvailable(req as any, res as any).catch(next); });

app.get('/api/fixed-assets/lookup', async (req, res, next) => { get_fixedAssetsLookup(req as any, res as any).catch(next); });

app.get('/api/stock-operations', async (req, res, next) => { get_stockOperations(req as any, res as any).catch(next); });

app.post('/api/stock-operations', requireStockOperationPermission, async (req, res, next) => { post_stockOperations(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/reverse', requireRole('SUPER_ADMIN', 'INVENTORY_MANAGER'), requirePermission('branch-damage-mark'), async (req, res, next) => { post_reverse(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/reverse-consumable', requirePermission('consumable-issue-reverse'), async (req, res, next) => { post_reverseConsumable(req as any, res as any).catch(next); });

// SER-1/D2: the symmetric reversal for a pullout dispatch and a product sale.
// Each uses the same permission as the operation it undoes.
app.post('/api/stock-operations/:id/reverse-pullout', requirePermission('branch-pullout-dispatch'), async (req, res, next) => { post_reversePullout(req as any, res as any).catch(next); });

app.post('/api/stock-operations/:id/reverse-stock-out', requirePermission('stock-out'), async (req, res, next) => { post_reverseStockOut(req as any, res as any).catch(next); });

// Receive-lane gate: the client only offers this action when the role holds
// 'wh-receive-pullouts' (PulloutBinsPanel), but the route had no server-side
// check — any authenticated role could credit warehouse stock by calling it
// directly. The matrix op is now enforced here, exactly as the UI implies.
app.post('/api/stock-operations/:id/receive', requirePermission('wh-receive-pullouts'), async (req, res, next) => { post_receive(req as any, res as any).catch(next); });

// VOL-4b: the device register pages, the KPI counts are exact per-status, and
// the warranty directory unions CPE + fixed assets with a computed state. All
// three apply the session's branch scope in SQL, not only in the route guard.
app.get('/api/customer-devices/page', async (req, res, next) => { get_customerDevicesPage(req as any, res as any).catch(next); });

app.get('/api/customer-devices/overview', async (req, res, next) => { get_customerDevicesOverview(req as any, res as any).catch(next); });

app.get('/api/customer-devices/warranty', async (req, res, next) => { get_customerDevicesWarranty(req as any, res as any).catch(next); });

app.post('/api/customer-devices', requirePermission('customers-manage'), async (req, res, next) => { post_customerDevices(req as any, res as any).catch(next); });

app.patch('/api/customer-devices/:id/status', requireRole(...CPE_STATUS_ROLES), async (req, res, next) => { patch_status2(req as any, res as any).catch(next); });

app.patch('/api/inventory/serials', requirePermission('edit-device-serials'), handleUpdateSerials);

// ---------------------------------------------------------------------------
// Serial lookup — resolves a typed value (device serial, PON, or MAC) to the
// device that already holds it, across serial_log, customer_device_records,
// and fixed_assets. Powers the live duplicate detection in the serial edit
// modal so a conflicting device can be loaded into the second edit panel,
// even when it lives outside the user's branch-scoped register.
// ---------------------------------------------------------------------------
app.get('/api/inventory/serials/lookup', requirePermission('edit-device-serials'), async (req, res, next) => { get_lookup(req as any, res as any).catch(next); });

// Exchange dialogs resolve a replacement serial BEFORE submitting, so their
// refusal can name the unit's real state. They cannot use the edit lookup above:
// exchanging is open to FIELD_TECHNICIAN / BRANCH_MANAGER, who hold no
// 'edit-device-serials' permission, and a 403 would send them back to the
// misleading "not in the register" wording. Same read-only handler, same
// audience as the exchange endpoint itself — this route never writes.
app.get('/api/customer-devices/exchange/lookup', requireRole(...CPE_EXCHANGE_ROLES), async (req, res, next) => { get_exchangeLookup(req as any, res as any).catch(next); });

app.post('/api/inventory/serials/dual', requirePermission('edit-device-serials'), async (req, res, next) => { post_dual(req as any, res as any).catch(next); });

app.post('/api/customer-devices/exchange', requireRole(...CPE_EXCHANGE_ROLES), async (req, res, next) => { post_exchange(req as any, res as any).catch(next); });

// The dialogs refuse a known-bad replacement before submitting (fast, specific
// wording), so those attempts never reach post_exchange. They report them here
// so repeated claims on one unit still land in the audit trail. Audit only: the
// handler re-resolves the unit from the register and writes nothing else.
app.post('/api/customer-devices/exchange/refusal', requireRole(...CPE_EXCHANGE_ROLES), async (req, res, next) => { post_exchangeRefusal(req as any, res as any).catch(next); });

app.get('/api/serial-log', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'INVENTORY_MANAGER', 'BRANCH_MANAGER', 'FRONT_DESK', 'AUDITOR', 'PROCUREMENT_OFFICER', 'FIELD_TECHNICIAN'), async (req, res, next) => { get_serialLog(req as any, res as any).catch(next); });

}
