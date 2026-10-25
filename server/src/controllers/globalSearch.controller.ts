/**
 * TRIM-1 — global quick search (bounded, scoped, index-backed).
 *
 * Replaces the client-side filtering of whole PO/PI/shipment/asset/device
 * slices. Two things matter at nationwide scale:
 *
 *  1. **Branch scope is a server decision.** A branch role cannot widen the
 *     search by omitting `branchId` (the old client passed `ALL` when the
 *     header was consolidated). Non-global roles are pinned to their own
 *     branch here, whatever the request says.
 *  2. **Nothing unbounded leaves the server.** Each group is LIMIT-capped and
 *     backed by a trigram index; the response carries only the fields the modal
 *     renders, never whole documents or items JSONB.
 *
 * PostgreSQL is the authority. Demo mode (no database) falls back to the same
 * bounded shape over the in-memory arrays so the modal keeps working.
 */
import type { Response } from 'express';
import {
  assetRegister,
  customerDeviceRecords,
  getPgConnected,
  getUserFromReq,
  inventoryStock,
  pgPool,
  products,
  purchaseInvoices,
  purchaseOrders,
  shipments,
} from '../app';
import {
  globalSearchPattern,
  searchGlobalInDb,
} from '../models/globalSearch.repo';
import type {
  GlobalSearchAsset,
  GlobalSearchDevice,
  GlobalSearchInvoice,
  GlobalSearchOrder,
  GlobalSearchProduct,
  GlobalSearchResults,
  GlobalSearchShipment,
} from '../../../client/src/types';

/** Per-group cap. Mirrors the counts the modal renders (4–5 rows a group). */
const GROUP_LIMIT = 5;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 80;
/** Roles that may read across branches; matches enforceBranchAccess. */
const GLOBAL_READ_ROLES = new Set(['SUPER_ADMIN', 'HEAD_OFFICE_ADMIN']);

function emptyResults(): GlobalSearchResults {
  return { products: [], purchaseOrders: [], invoices: [], shipments: [], assets: [], customerDevices: [] };
}

function countAll(results: GlobalSearchResults): number {
  return (
    results.products.length +
    results.purchaseOrders.length +
    results.invoices.length +
    results.shipments.length +
    results.assets.length +
    results.customerDevices.length
  );
}

/** Case-insensitive substring match for the demo-mode fallback. */
function matches(value: unknown, needle: string): boolean {
  return String(value ?? '').toLowerCase().includes(needle);
}

/**
 * Resolves the branch scope from the authenticated user, never from the query
 * alone. Returns `undefined` when the request must be refused.
 */
function resolveBranchScope(req: any, rawBranch: string): string | null | undefined {
  const user = req.user || getUserFromReq(req);
  if (!user || !user.email) return undefined;

  if (GLOBAL_READ_ROLES.has(String(user.role))) {
    return !rawBranch || rawBranch === 'ALL' ? null : rawBranch;
  }

  const allowed = new Set<string>([user.branchId || '', ...((user.allowedBranchIds as string[]) || [])]);
  const requested = !rawBranch || rawBranch === 'ALL' ? user.branchId || '' : rawBranch;
  if (!requested || !allowed.has(requested)) return undefined;
  return requested;
}

function fallbackSearch(
  query: string,
  branchId: string | null,
  fiscalYearId: string | null
): GlobalSearchResults {
  const needle = query.toLowerCase();
  const inBranch = (value?: string | null) => branchId === null || value === branchId;
  const inFiscalYear = (value?: string | null) =>
    fiscalYearId === null || value === fiscalYearId || value === null || value === undefined;
  const take = <T>(rows: T[]) => rows.slice(0, GROUP_LIMIT);

  const stockByProduct = new Map<string, number>();
  for (const row of inventoryStock as any[]) {
    if (branchId !== null && row.branchId !== branchId) continue;
    stockByProduct.set(row.productId, (stockByProduct.get(row.productId) || 0) + Number(row.quantityOnHand || 0));
  }

  const matchedProducts: GlobalSearchProduct[] = take(
    (products as any[])
      .filter(
        (p) =>
          matches(p.name, needle) ||
          matches(p.sku, needle) ||
          matches(p.barcode, needle) ||
          matches(p.category, needle)
      )
      .map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode ?? null,
        category: p.category,
        unit: p.unit ?? null,
        sellingPrice: Number(p.sellingPrice || 0),
        minReorderLevel: p.minReorderLevel ?? null,
        stockQty: stockByProduct.get(p.id) || 0,
      }))
  );

  const matchedOrders: GlobalSearchOrder[] = take(
    (purchaseOrders as any[])
      .filter(
        (po) =>
          inBranch(po.branchId) &&
          inFiscalYear(po.fiscalYearId) &&
          (matches(po.poNumber, needle) || matches(po.supplierName, needle) || matches(po.status, needle))
      )
      .map((po) => ({
        id: po.id,
        poNumber: po.poNumber,
        supplierName: po.supplierName,
        status: po.status,
        totalAmount: Number(po.totalAmount || 0),
        orderDateBS: po.orderDateBS ?? null,
      }))
  );

  const matchedInvoices: GlobalSearchInvoice[] = take(
    (purchaseInvoices as any[])
      .filter(
        (inv) =>
          inBranch(inv.branchId) &&
          inFiscalYear(inv.fiscalYearId) &&
          (matches(inv.invoiceNumber, needle) ||
            matches(inv.vendorBillNumber, needle) ||
            matches(inv.supplierName, needle))
      )
      .map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        vendorBillNumber: inv.vendorBillNumber ?? null,
        supplierName: inv.supplierName,
        grandTotal: Number(inv.grandTotal || 0),
        paymentStatus: inv.paymentStatus,
      }))
  );

  const matchedShipments: GlobalSearchShipment[] = take(
    (shipments as any[])
      .filter(
        (sh) =>
          (branchId === null || sh.sourceBranchId === branchId || sh.destinationBranchId === branchId) &&
          inFiscalYear(sh.fiscalYearId) &&
          (matches(sh.trackingCode, needle) ||
            matches(sh.sourceBranchName, needle) ||
            matches(sh.destinationBranchName, needle) ||
            matches(sh.status, needle))
      )
      .map((sh) => ({
        id: sh.id,
        trackingCode: sh.trackingCode,
        sourceBranchName: sh.sourceBranchName ?? null,
        destinationBranchName: sh.destinationBranchName,
        status: sh.status,
        itemCount: Array.isArray(sh.items) ? sh.items.length : 0,
      }))
  );

  const matchedAssets: GlobalSearchAsset[] = take(
    (assetRegister as any[])
      .filter(
        (asset) =>
          inBranch(asset.branchId) &&
          inFiscalYear(asset.fiscalYearId) &&
          (matches(asset.tagNumber, needle) ||
            matches(asset.name, needle) ||
            matches(asset.category, needle))
      )
      .map((asset) => ({
        id: asset.id,
        tagNumber: asset.tagNumber,
        name: asset.name,
        category: asset.category,
        acquisitionCost: Number(asset.acquisitionCost || 0),
        status: asset.status,
      }))
  );

  const matchedDevices: GlobalSearchDevice[] = take(
    (customerDeviceRecords as any[])
      .filter(
        (device) =>
          inBranch(device.branchId) &&
          inFiscalYear(device.fiscalYearId) &&
          (matches(device.customerCode, needle) ||
            matches(device.customerName, needle) ||
            matches(device.productName, needle) ||
            matches(device.deviceSerial, needle) ||
            matches(device.ponSerial, needle) ||
            matches(device.macAddress, needle) ||
            matches(device.contactPhone, needle))
      )
      .map((device) => ({
        id: device.id,
        customerCode: device.customerCode,
        customerName: device.customerName,
        productName: device.productName,
        deviceSerial: device.deviceSerial,
        status: device.status,
      }))
  );

  return {
    products: matchedProducts,
    purchaseOrders: matchedOrders,
    invoices: matchedInvoices,
    shipments: matchedShipments,
    assets: matchedAssets,
    customerDevices: matchedDevices,
  };
}

export async function get_globalSearch(req: any, res: Response): Promise<any> {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (rawQuery.length < MIN_QUERY_LENGTH) {
    return res.status(400).json({
      message: `Enter at least ${MIN_QUERY_LENGTH} characters to search the registers.`,
    });
  }
  if (rawQuery.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({
      message: `Search text is limited to ${MAX_QUERY_LENGTH} characters.`,
    });
  }

  const rawBranch = typeof req.query.branchId === 'string' ? req.query.branchId : '';
  const branchId = resolveBranchScope(req, rawBranch);
  if (branchId === undefined) {
    return res.status(403).json({
      message: 'Forbidden: this account is not authorized to search that branch.',
    });
  }

  const headerFy = typeof req.headers['x-fiscal-year-id'] === 'string' ? req.headers['x-fiscal-year-id'] : '';
  const queryFy = typeof req.query.fiscalYearId === 'string' ? req.query.fiscalYearId : '';
  const fiscalYearId = headerFy || queryFy || null;

  res.set('Cache-Control', 'no-store');

  if (!getPgConnected()) {
    const results = fallbackSearch(rawQuery, branchId, fiscalYearId);
    return res.json({ query: rawQuery, results, total: countAll(results), limit: GROUP_LIMIT });
  }

  try {
    const results = await searchGlobalInDb(pgPool as any, {
      pattern: globalSearchPattern(rawQuery),
      branchId,
      fiscalYearId,
      limit: GROUP_LIMIT,
    });
    return res.json({ query: rawQuery, results, total: countAll(results), limit: GROUP_LIMIT });
  } catch (error: any) {
    console.error('Global search failed:', error);
    return res.status(500).json({ message: `Unable to search right now: ${error.message}` });
  }
}
