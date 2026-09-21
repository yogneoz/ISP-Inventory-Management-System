/**
 * Masterdata routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerMasterdataRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_uom, post_uom, put_Id, delete_Id, get_locations, post_locations, put_Id2, delete_Id2, get_suppliers, post_suppliers, put_Id3, delete_Id3, get_products, post_products, put_Id4, delete_Id4, get_categories, post_categories, put_Id5, delete_Id5, get_customers, post_customers, post_bulk, put_Id6, delete_Id6 } from '../controllers/masterdata.controller';
import {
  branches,
  broadcastChange,
  categories,
  customerDeviceRecords,
  customerMasterRecords,
  getPgConnected,
  inventoryStock,
  locationRecords,
  logAuditEvent,
  products,
  requirePermission,
  requireRole,
  setCategories,
  setCustomerMasterRecords,
  setInventoryStock,
  setLocationRecords,
  setProducts,
  setSuppliers,
  setUomList,
  suppliers,
  uomList,
  withAppended,
  withPrepended,
  withReplaced,
  withTransaction,
} from '../app';
import { pgPool } from '../app';
import type { Category, CustomerRecord, LocationRecord, Supplier, UnitOfMeasure } from '../../../client/src/types';

export function registerMasterdataRoutes(app: Express) {
app.get('/api/uom', async (req, res, next) => { get_uom(req as any, res as any).catch(next); });

app.post('/api/uom', requirePermission('uom-manage'), async (req, res, next) => { post_uom(req as any, res as any).catch(next); });

app.put('/api/uom/:id', requirePermission('uom-manage'), async (req, res, next) => { put_Id(req as any, res as any).catch(next); });

app.delete('/api/uom/:id', requirePermission('uom-manage'), async (req, res, next) => { delete_Id(req as any, res as any).catch(next); });

app.get('/api/locations', async (req, res, next) => { get_locations(req as any, res as any).catch(next); });

app.post('/api/locations', async (req, res, next) => { post_locations(req as any, res as any).catch(next); });

app.put('/api/locations/:id', async (req, res, next) => { put_Id2(req as any, res as any).catch(next); });

app.delete('/api/locations/:id', async (req, res, next) => { delete_Id2(req as any, res as any).catch(next); });

app.get('/api/suppliers', async (req, res, next) => { get_suppliers(req as any, res as any).catch(next); });

app.post('/api/suppliers', async (req, res, next) => { post_suppliers(req as any, res as any).catch(next); });

app.put('/api/suppliers/:id', async (req, res, next) => { put_Id3(req as any, res as any).catch(next); });

app.delete('/api/suppliers/:id', async (req, res, next) => { delete_Id3(req as any, res as any).catch(next); });

app.get('/api/products', async (req, res, next) => { get_products(req as any, res as any).catch(next); });

app.post('/api/products', requirePermission('prod-edit'), async (req, res, next) => { post_products(req as any, res as any).catch(next); });

app.put('/api/products/:id', requirePermission('prod-edit'), async (req, res, next) => { put_Id4(req as any, res as any).catch(next); });

app.delete('/api/products/:id', requirePermission('prod-edit'), async (req, res, next) => { delete_Id4(req as any, res as any).catch(next); });

app.get('/api/categories', async (req, res, next) => { get_categories(req as any, res as any).catch(next); });

app.post('/api/categories', requirePermission('category-manage'), async (req, res, next) => { post_categories(req as any, res as any).catch(next); });

app.put('/api/categories/:id', requirePermission('category-manage'), async (req, res, next) => { put_Id5(req as any, res as any).catch(next); });

app.delete('/api/categories/:id', requirePermission('category-manage'), async (req, res, next) => { delete_Id5(req as any, res as any).catch(next); });

app.get('/api/customers', async (req, res, next) => { get_customers(req as any, res as any).catch(next); });

app.post('/api/customers', requirePermission('customers-manage'), async (req, res, next) => { post_customers(req as any, res as any).catch(next); });

app.post('/api/customers/bulk', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER'), async (req, res, next) => { post_bulk(req as any, res as any).catch(next); });

app.put('/api/customers/:id', requirePermission('customers-manage'), async (req, res, next) => { put_Id6(req as any, res as any).catch(next); });

app.delete('/api/customers/:id', async (req, res, next) => { delete_Id6(req as any, res as any).catch(next); });

}
