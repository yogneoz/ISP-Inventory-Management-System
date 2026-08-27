/**
 * Route module: bootstrap
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

router.get('/api/bootstrap', async (req, res) => {
  const { branchId } = req.query;
  const bId = typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;

  if (isPgConnected) {
    try {
      const [
        bRes, pRes, sRes, aRes, dRes, cRes, poRes, piRes, shRes, opRes, fyRes, auditRes, txnRes, supRes, uRes, appRes, catRes, uomRes, locRes, compDbRes
      ] = await Promise.all([
        pgPool.query('SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches'),
        pgPool.query('SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products'),
        pgPool.query('SELECT id, product_id AS "productId", branch_id AS "branchId", quantity_on_hand AS "quantityOnHand", damaged_qty AS "damagedQty", reserved_qty AS "reservedQty", incoming_qty AS "incomingQty", min_reorder_level AS "minReorderLevel" FROM inventory_stock' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tag_number AS "tagNumber", name, category, branch_id AS "branchId", acquisition_date_ad AS "acquisitionDateAd", acquisition_date_bs AS "acquisitionDateBs", acquisition_cost AS "acquisitionCost", depreciation_method AS "depreciationMethod", depreciation_rate_percent AS "depreciationRatePercent", accumulated_depreciation AS "accumulatedDepreciation", net_book_value AS "netBookValue", status, supplier_name AS "supplierName", invoice_no AS "invoiceNo" FROM fixed_assets' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", contact_phone AS "contactPhone", installation_address AS "installationAddress", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", pon_serial AS "ponSerial", mac_address AS "macAddress", status, issued_date_ad AS "issuedDateAd", issued_date_bs AS "issuedDateBs", purchase_bill_ref AS "purchaseBillRef", notes FROM customer_device_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, po_number AS "poNumber", supplier_name AS "supplierName", branch_id AS "branchId", order_date_ad AS "orderDateAd", order_date_bs AS "orderDateBs", expected_delivery_date_ad AS "expectedDeliveryDateAd", status, subtotal_amount AS "subtotalAmount", tax_amount AS "taxAmount", total_amount AS "totalAmount", notes, items FROM purchase_orders' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, invoice_number AS "invoiceNumber", po_reference_id AS "poReferenceId", supplier_name AS "supplierName", branch_id AS "branchId", invoice_date_ad AS "invoiceDateAd", invoice_date_bs AS "invoiceDateBs", taxable_amount AS "taxableAmount", vat_amount AS "vatAmount", non_taxable_amount AS "nonTaxableAmount", grand_total AS "grandTotal", payment_status AS "paymentStatus", amount_paid AS "amountPaid", items FROM purchase_invoices' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, tracking_code AS "trackingCode", type, source_branch_id AS "sourceBranchId", source_branch_name AS "sourceBranchName", destination_branch_id AS "destinationBranchId", destination_branch_name AS "destinationBranchName", dispatch_date_ad AS "dispatchDateAd", dispatch_date_bs AS "dispatchDateBs", estimated_arrival_ad AS "estimatedArrivalAd", status, notes, items, received_by_notes AS "receivedByNotes", received_date_ad AS "receivedDateAd", received_date_bs AS "receivedDateBs", has_discrepancy AS "hasDiscrepancy" FROM shipments' + (bId ? ' WHERE source_branch_id = $1 OR destination_branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, reference_number AS "referenceNumber", type, technician_name AS "technicianName", work_order_ref AS "workOrderRef", branch_id AS "branchId", branch_name AS "branchName", destination_warehouse_id AS "destinationWarehouseId", destination_warehouse_name AS "destinationWarehouseName", product_id AS "productId", quantity_changed AS "quantityChanged", cost_per_unit AS "costPerUnit", total_value AS "totalValue", reason, inspector_name AS "inspectorName", date_ad AS "dateAd", date_bs AS "dateBs", fiscal_year AS "fiscalYear", status, items FROM stock_operations' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, code, start_date_ad AS "startDateAd", end_date_ad AS "endDateAd", start_date_bs AS "startDateBs", end_date_bs AS "endDateBs", is_current AS "isCurrent", is_closed AS "isClosed" FROM fiscal_years'),
        pgPool.query('SELECT id, user_email AS "userEmail", user_name AS "userName", action, module, details, timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS", branch_id AS "branchId" FROM audit_logs ORDER BY timestamp_ad DESC LIMIT 200'),
        pgPool.query('SELECT id, transaction_number AS "transactionNumber", product_id AS "productId", product_sku AS "productSku", product_name AS "productName", branch_id AS "branchId", change_type AS "changeType", quantity_before AS "quantityBefore", quantity_changed AS "quantityChanged", quantity_after AS "quantityAfter", unit_cost AS "unitCost", reference_doc_id AS "referenceDocId", timestamp_ad AS "timestampAD", timestamp_bs AS "timestampBS" FROM transaction_logs ORDER BY timestamp_ad DESC LIMIT 300'),
        pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers'),
        pgPool.query('SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users'),
        pgPool.query('SELECT id, request_number AS "requestNumber", type, target_id AS "targetId", customer_name AS "customerName", customer_code AS "customerCode", device_serial AS "deviceSerial", pon_serial AS "ponSerial", product_name AS "productName", current_status AS "currentStatus", requested_status AS "requestedStatus", requested_by_role AS "requestedByRole", requested_by_email AS "requestedByEmail", requested_by_name AS "requestedByName", branch_id AS "branchId", branch_name AS "branchName", reason, restock_qty_on_approval AS "restockQtyOnApproval", status, requested_at_ad AS "requestedAtAd", requested_at_bs AS "requestedAtBs" FROM approval_requests' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, name, code, description FROM categories ORDER BY name ASC'),
        pgPool.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC'),
        pgPool.query('SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations' + (bId ? ' WHERE branch_id = $1' : ''), bId ? [bId] : []),
        pgPool.query('SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website, pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber", logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol", default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1'),
      ]);

      const pgStock = sRes.rows;
      const pgProducts = pRes.rows;
      const pgAssets = aRes.rows;
      const pgInvoices = piRes.rows;
      const pgOps = opRes.rows;
      const pgFiscalYears = fyRes.rows;

      const totalInventoryAssetValue = pgStock.reduce((sum: number, item: any) => {
        const prod = pgProducts.find((p: any) => p.id === item.productId);
        return sum + (prod ? Number(prod.costPrice) * Number(item.quantityOnHand) : 0);
      }, 0);

      const totalFixedAssetValue = pgAssets.reduce((sum: number, a: any) => sum + Number(a.netBookValue || 0), 0);
      const totalAccountsPayable = pgInvoices.reduce(
        (sum: number, inv: any) => sum + Math.max(0, Number(inv.grandTotal || 0) - Number(inv.amountPaid || 0)),
        0
      );
      const totalDamageLossValue = pgOps.reduce((sum: number, op: any) => sum + Number(op.totalValue || 0), 0);
      const totalVatInputTax = pgInvoices.reduce((sum: number, inv: any) => sum + Number(inv.vatAmount || 0), 0);
      const currentFy = pgFiscalYears.find((f: any) => f.isCurrent)?.code || '2082/83';

      const financialSummary = {
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalCostOfGoodsSold: pgOps.filter((op: any) => op.type === 'STOCK_OUT' || op.type === 'CONSUMABLE_ISSUE').reduce((sum: number, op: any) => sum + Number(op.totalValue || 0), 0),
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: currentFy,
      };

      res.setHeader('Cache-Control', 'private, no-cache');
      return res.json({
        branches: bRes.rows,
        products: pgProducts,
        stock: pgStock,
        assets: pgAssets,
        customerDevices: dRes.rows,
        customers: cRes.rows,
        purchaseOrders: poRes.rows,
        purchaseInvoices: pgInvoices,
        shipments: shRes.rows,
        stockOperations: pgOps,
        fiscalYears: pgFiscalYears,
        auditLogs: auditRes.rows,
        transactionLogs: txnRes.rows,
        financialSummary,
        suppliers: supRes.rows,
        users: uRes.rows,
        approvalRequests: appRes.rows,
        categories: catRes.rows,
        uom: uomRes.rows,
        locations: locRes.rows,
        companyProfile: compDbRes.rows[0] || store.companyProfile,
        serverTime: new Date().toISOString(),
        dataVersion,
      });
    } catch (pgErr) {
      console.error('PostgreSQL query note in /api/bootstrap, using in-memory store:', pgErr);
    }
  }

  let targetStock = store.inventoryStock;
  let targetAssets = store.assetRegister;
  let targetDevices = store.customerDeviceRecords;
  let targetCustomers = store.customerMasterRecords;
  let targetPOs = store.purchaseOrders;
  let targetInvoices = store.purchaseInvoices;
  let targetShipments = store.shipments;
  let targetOps = store.stockOperations;
  let targetApprovals = store.approvalRequests;

  if (bId) {
    targetAssets = store.assetRegister.filter((a) => a.branchId === bId);
    targetDevices = store.customerDeviceRecords.filter((d) => d.branchId === bId);
    targetCustomers = store.customerMasterRecords.filter((c) => c.branchId === bId);
    targetPOs = store.purchaseOrders.filter((p) => p.branchId === bId);
    targetInvoices = store.purchaseInvoices.filter((i) => i.branchId === bId);
    targetShipments = store.shipments.filter((s) => s.sourceBranchId === bId || s.destinationBranchId === bId);
    targetOps = store.stockOperations.filter((o) => o.branchId === bId);
    targetApprovals = store.approvalRequests.filter((a) => a.branchId === bId);
  }

  const finTargetStock = bId ? store.inventoryStock.filter((s) => s.branchId === bId) : store.inventoryStock;
  const finTargetAssets = targetAssets;
  const finTargetInvoices = targetInvoices;
  const finTargetOps = targetOps;

  const totalInventoryAssetValue = finTargetStock.reduce((sum, item) => {
    const prod = store.products.find((p) => p.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
  }, 0);

  const totalFixedAssetValue = finTargetAssets.reduce((sum, a) => sum + (a.netBookValue ?? 0), 0);
  const totalAccountsPayable = finTargetInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );
  const totalDamageLossValue = finTargetOps.reduce((sum, op) => sum + (op.totalValue ?? 0), 0);
  const totalVatInputTax = finTargetInvoices.reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const currentFy = store.fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

  const financialSummary = {
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalCostOfGoodsSold: store.stockOperations.filter((op) => op.type === 'STOCK_OUT' || op.type === 'CONSUMABLE_ISSUE').reduce((sum, op) => sum + Number(op.totalValue || 0), 0),
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
  };

  const safeUsers = store.users.map(({ password: _, ...u }) => u);

  res.setHeader('Cache-Control', 'private, no-cache');
  res.json({
    branches: store.branches,
    products: store.products,
    stock: targetStock,
    assets: targetAssets,
    customerDevices: targetDevices,
    customers: targetCustomers,
    purchaseOrders: targetPOs,
    purchaseInvoices: targetInvoices,
    shipments: targetShipments,
    stockOperations: targetOps,
    fiscalYears: store.fiscalYears,
    auditLogs: store.auditTrail.slice(0, 200),
    transactionLogs: store.transactionLogs.slice(0, 300),
    financialSummary,
    suppliers: store.suppliers,
    users: safeUsers,
    approvalRequests: targetApprovals,
    categories: store.categories,
    companyProfile: store.companyProfile,
    serverTime: new Date().toISOString(),
    dataVersion,
  });
});


export default router;
