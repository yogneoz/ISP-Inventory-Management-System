/**
 * Masterdata routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerMasterdataRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
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
app.get('/api/uom', async (req, res) => {
  if (getPgConnected()) {
    try {
      const r = await pgPool.query('SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC');
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching UOM from DB:', err);
    }
  }
  res.json(uomList);
});

app.post('/api/uom', requirePermission('uom-manage'), async (req, res) => {
  try {
    const newUom: UnitOfMeasure = {
      id: req.body.id || `uom-${Date.now()}`,
      name: req.body.name || 'Unit',
      symbol: req.body.symbol || 'Unit',
      type: req.body.type || 'Count',
      isBaseUnit: Boolean(req.body.isBaseUnit),
    };
    const idx = uomList.findIndex((u) => u.id === newUom.id || u.name === newUom.name);
    setUomList(idx >= 0 ? withReplaced(uomList, idx, newUom) : withAppended(uomList, newUom));

    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO uom (id, name, symbol, type, is_base_unit)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           symbol = EXCLUDED.symbol,
           type = EXCLUDED.type,
           is_base_unit = EXCLUDED.is_base_unit;`,
        [newUom.id, newUom.name, newUom.symbol, newUom.type, newUom.isBaseUnit]
      );
    }
    logAuditEvent(req, 'CREATE_UOM', 'MASTER_DATA', `Created/updated Unit of Measure ${newUom.name} (${newUom.symbol})`);
    res.status(201).json(newUom);
  } catch (err: any) {
    console.error('Error creating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/uom/:id', requirePermission('uom-manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const idx = uomList.findIndex((u) => u.id === id);
    if (idx >= 0) setUomList(withReplaced(uomList, idx, { ...uomList[idx], ...req.body }));
    const uom = uomList[idx] || req.body;

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE uom SET name = $1, symbol = $2, type = $3, is_base_unit = $4 WHERE id = $5;`,
        [uom.name, uom.symbol, uom.type, Boolean(uom.isBaseUnit), id]
      );
    }
    logAuditEvent(req, 'UPDATE_UOM', 'MASTER_DATA', `Updated UOM ${uom.name}`);
    res.json(uom);
  } catch (err: any) {
    console.error('Error updating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/uom/:id', requirePermission('uom-manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const uom = uomList.find((u) => u.id === id);
    setUomList(uomList.filter((u) => u.id !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM uom WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_UOM', 'MASTER_DATA', `Deleted UOM ${uom?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/locations', async (req, res) => {
  const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const q = 'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations' +
                (branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '') + ' ORDER BY name ASC';
      const params = branchId && branchId !== 'ALL' ? [branchId] : [];
      const r = await pgPool.query(q, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching locations from DB:', err);
    }
  }
  let list = locationRecords;
  if (branchId && branchId !== 'ALL') list = list.filter((l) => l.branchId === branchId);
  res.json(list);
});

app.post('/api/locations', async (req, res) => {
  try {
    const newLoc: LocationRecord = {
      id: req.body.id || `LOC-${Math.floor(1000 + Math.random() * 9000)}`,
      name: req.body.name || 'New Location',
      type: req.body.type || 'POP_SERVER_ROOM',
      branchId: req.body.branchId || 'WH001',
      address: req.body.address || '',
      coordinates: req.body.coordinates || { latitude: 0, longitude: 0 },
      contactPerson: req.body.contactPerson || '',
      contactPhone: req.body.contactPhone || '',
      notes: req.body.notes || '',
      activeAssetsCount: req.body.activeAssetsCount || 0,
    };
    const idx = locationRecords.findIndex((l) => l.id === newLoc.id);
    setLocationRecords(idx >= 0 ? withReplaced(locationRecords, idx, newLoc) : withPrepended(locationRecords, newLoc));

    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO locations (id, name, type, branch_id, address, coordinates, contact_person, contact_phone, notes, active_assets_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           branch_id = EXCLUDED.branch_id,
           address = EXCLUDED.address,
           coordinates = EXCLUDED.coordinates,
           contact_person = EXCLUDED.contact_person,
           contact_phone = EXCLUDED.contact_phone,
           notes = EXCLUDED.notes,
           active_assets_count = EXCLUDED.active_assets_count;`,
        [
          newLoc.id,
          newLoc.name,
          newLoc.type,
          newLoc.branchId,
          newLoc.address,
          JSON.stringify(newLoc.coordinates),
          newLoc.contactPerson,
          newLoc.contactPhone,
          newLoc.notes,
          newLoc.activeAssetsCount,
        ]
      );
    }
    logAuditEvent(req, 'CREATE_LOCATION', 'MASTER_DATA', `Created/updated location ${newLoc.name} (${newLoc.id})`, newLoc.branchId);
    res.status(201).json(newLoc);
  } catch (err: any) {
    console.error('Error creating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = locationRecords.findIndex((l) => l.id === id);
    if (idx >= 0) setLocationRecords(withReplaced(locationRecords, idx, { ...locationRecords[idx], ...req.body }));
    const loc = locationRecords[idx] || req.body;

    if (getPgConnected() && loc) {
      await pgPool.query(
        `UPDATE locations SET
           name = $1, type = $2, branch_id = $3, address = $4, coordinates = $5, contact_person = $6, contact_phone = $7, notes = $8, active_assets_count = $9
         WHERE id = $10;`,
        [
          loc.name,
          loc.type,
          loc.branchId,
          loc.address,
          JSON.stringify(loc.coordinates),
          loc.contactPerson,
          loc.contactPhone,
          loc.notes,
          loc.activeAssetsCount,
          id,
        ]
      );
    }
    logAuditEvent(req, 'UPDATE_LOCATION', 'MASTER_DATA', `Updated location details for ${loc.name} (${id})`, loc.branchId);
    res.json(loc);
  } catch (err: any) {
    console.error('Error updating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const loc = locationRecords.find((l) => l.id === id);
    setLocationRecords(locationRecords.filter((l) => l.id !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM locations WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_LOCATION', 'MASTER_DATA', `Deleted location ${loc?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/suppliers', async (req, res) => {
  if (getPgConnected()) {
    try {
      const r = await pgPool.query('SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC');
      return res.json(r.rows);
    } catch (err) {
      console.error('Error querying suppliers from DB:', err);
    }
  }
  res.json(suppliers);
});

app.post('/api/suppliers', async (req, res) => {
  try {
    const newSupplier: Supplier = {
      id: req.body.id || `sup-${Date.now()}`,
      supplierCode: req.body.supplierCode || `SUP-${Math.floor(1000 + Math.random() * 9000)}`,
      name: req.body.name || 'New Supplier',
      contactPerson: req.body.contactPerson || '',
      phone: req.body.phone || '',
      email: req.body.email || '',
      address: req.body.address || '',
      panVatNumber: req.body.panVatNumber || '',
      rating: Number(req.body.rating) || 5.0,
      status: req.body.status || 'ACTIVE',
    } as any;
    setSuppliers(withAppended(suppliers, newSupplier));

    if (getPgConnected()) {
      const sup = newSupplier as any;
      await pgPool.query(
        `INSERT INTO suppliers (id, supplier_code, name, contact_person, phone, email, address, pan_vat_number, rating, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           supplier_code = EXCLUDED.supplier_code,
           name = EXCLUDED.name,
           contact_person = EXCLUDED.contact_person,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           address = EXCLUDED.address,
           pan_vat_number = EXCLUDED.pan_vat_number,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status;`,
        [sup.id, sup.supplierCode, sup.name, sup.contactPerson, sup.phone, sup.email, sup.address, sup.panVatNumber, sup.rating, sup.status]
      );
    }
    logAuditEvent(req, 'CREATE_SUPPLIER', 'MASTER_DATA', `Created new supplier ${newSupplier.name}`);
    res.status(201).json(newSupplier);
  } catch (err: any) {
    console.error('Error creating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const idx = suppliers.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Supplier not found' });
    setSuppliers(withReplaced(suppliers, idx, { ...suppliers[idx], ...req.body }));
    const sup = suppliers[idx] as any;

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE suppliers SET
           supplier_code = $1, name = $2, contact_person = $3, phone = $4, email = $5, address = $6, pan_vat_number = $7, rating = $8, status = $9
         WHERE id = $10;`,
        [sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', Number(sup.rating) || 5.0, sup.status || 'ACTIVE', id]
      );
    }
    logAuditEvent(req, 'UPDATE_SUPPLIER', 'MASTER_DATA', `Updated supplier ${sup.name} (${id})`);
    res.json(sup);
  } catch (err: any) {
    console.error('Error updating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/suppliers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sup = suppliers.find((s) => s.id === id);
    setSuppliers(suppliers.filter((s) => s.id !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM suppliers WHERE id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_SUPPLIER', 'MASTER_DATA', `Deleted supplier ${sup?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/products', async (req, res) => {
  if (getPgConnected()) {
    try {
      const r = await pgPool.query(
        'SELECT id, sku, barcode, name, category, product_group AS "productGroup", unit, cost_price AS "costPrice", selling_price AS "sellingPrice", tax_rate AS "taxRate", min_reorder_level AS "minReorderLevel", requires_serial_tracking AS "requiresSerialTracking", tracking_type AS "trackingType", description, status FROM products ORDER BY created_at DESC'
      );
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching products from DB:', err);
    }
  }
  res.json(products);
});

app.post('/api/products', requirePermission('prod-edit'), async (req, res) => {
  try {
    const newProd = {
      id: `prod-${Date.now()}`,
      sku: req.body.sku || `SKU-${Date.now()}`,
      barcode: req.body.barcode || '',
      name: req.body.name || 'Untitled Product',
      category: req.body.category || 'General',
      productGroup: req.body.productGroup || 'Product Item',
      unit: req.body.unit || 'Pcs',
      costPrice: Number(req.body.costPrice) || 0,
      sellingPrice: Number(req.body.sellingPrice) || 0,
      taxRate: Number(req.body.taxRate) || 13,
      minReorderLevel: Number(req.body.minReorderLevel) || 5,
      requiresSerialTracking: Boolean(req.body.requiresSerialTracking),
      trackingType: req.body.trackingType || 'QUANTITY_ONLY',
      description: req.body.description || '',
      status: req.body.status || 'ACTIVE',
    };
    setProducts(withAppended(products, newProd));

    // Initialize 0 stock across all branches
    const newStockItems: any[] = [];
    branches.forEach((b) => {
      const stkItem = {
        id: `stk-${Date.now()}-${b.id}`,
        productId: newProd.id,
        branchId: b.id,
        quantityOnHand: 0,
        damagedQty: 0,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: newProd.minReorderLevel,
        lastUpdated: new Date().toISOString(),
      };
      setInventoryStock(withAppended(inventoryStock, stkItem));
      newStockItems.push(stkItem);
    });

    // PostgreSQL database insertion
    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO products (id, sku, barcode, name, category, product_group, unit, cost_price, selling_price, tax_rate, min_reorder_level, requires_serial_tracking, tracking_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           sku = EXCLUDED.sku,
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           selling_price = EXCLUDED.selling_price;`,
        [
          newProd.id,
          newProd.sku,
          newProd.barcode,
          newProd.name,
          newProd.category,
          newProd.productGroup,
          newProd.unit,
          newProd.costPrice,
          newProd.sellingPrice,
          newProd.taxRate,
          newProd.minReorderLevel,
          newProd.requiresSerialTracking,
          newProd.trackingType,
          newProd.description,
          newProd.status,
        ]
      );

      for (const stk of newStockItems) {
        await pgPool.query(
          `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, damaged_qty, reserved_qty, incoming_qty, min_reorder_level)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING;`,
          [stk.id, stk.productId, stk.branchId, stk.quantityOnHand, stk.damagedQty, stk.reservedQty, stk.incomingQty, stk.minReorderLevel]
        );
      }
    }
    logAuditEvent(req, 'CREATE_PRODUCT', 'PRODUCTS', `Created new product SKU ${newProd.sku} (${newProd.name}) - Price: NPR ${newProd.sellingPrice}`);
    res.status(201).json(newProd);
  } catch (err: any) {
    console.error('Error creating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/products/:id', requirePermission('prod-edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });

    const oldProd = { ...products[idx] };
    setProducts(withReplaced(products, idx, { ...products[idx], ...req.body }));
    const updated = products[idx];

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE products SET
           sku = $1,
           barcode = $2,
           name = $3,
           category = $4,
           product_group = $5,
           unit = $6,
           cost_price = $7,
           selling_price = $8,
           tax_rate = $9,
           min_reorder_level = $10,
           requires_serial_tracking = $11,
           tracking_type = $12,
           description = $13,
           status = $14
         WHERE id = $15;`,
        [
          updated.sku,
          updated.barcode || '',
          updated.name,
          updated.category,
          updated.productGroup || 'Product Item',
          updated.unit || 'Pcs',
          Number(updated.costPrice) || 0,
          Number(updated.sellingPrice) || 0,
          Number(updated.taxRate) || 13,
          Number(updated.minReorderLevel) || 5,
          Boolean(updated.requiresSerialTracking),
          updated.trackingType || 'QUANTITY_ONLY',
          updated.description || '',
          updated.status || 'ACTIVE',
          id,
        ]
      );
    }
    const changeMsg = oldProd.sku !== updated.sku
      ? `SKU updated from ${oldProd.sku} to ${updated.sku}`
      : `Updated product details for ${updated.name} (${updated.sku})`;

    logAuditEvent(req, 'UPDATE_PRODUCT_SKU', 'PRODUCTS', changeMsg);
    res.json(products[idx]);
  } catch (err: any) {
    console.error('Error updating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/products/:id', requirePermission('prod-edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const prod = products.find((p) => p.id === id);
    setProducts(products.filter((p) => p.id !== id));
    setInventoryStock(inventoryStock.filter((s) => s.productId !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM products WHERE id = $1;', [id]);
    }
    logAuditEvent(req, 'DELETE_PRODUCT', 'PRODUCTS', `Deleted product ${prod?.name || id} (SKU: ${prod?.sku || 'N/A'})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting product from database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/categories', async (req, res) => {
  if (getPgConnected()) {
    try {
      const { rows } = await pgPool.query(
        'SELECT id, name, code, description, is_special_tracked AS "isSpecialTracked" FROM categories ORDER BY name ASC'
      );
      return res.json(rows);
    } catch (err: any) {
      console.warn('Database note on GET /api/categories:', err?.message || err);
    }
  }
  res.json(categories);
});

app.post('/api/categories', requirePermission('category-manage'), async (req, res) => {
  try {
    const newCat: Category = {
      id: req.body.id || `cat-${Date.now()}`,
      name: req.body.name || 'New Category',
      code: req.body.code || `CAT-${Date.now().toString().slice(-4)}`,
      description: req.body.description || '',
      isSpecialTracked: Boolean(req.body.isSpecialTracked),
    };
    const existingIdx = categories.findIndex((c) => c.id === newCat.id || c.name.toLowerCase() === newCat.name.toLowerCase());
    if (existingIdx !== -1) {
      setCategories(withReplaced(categories, existingIdx, newCat));
    } else {
      setCategories(withAppended(categories, newCat));
    }

    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO categories (id, name, code, description, is_special_tracked)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           code = EXCLUDED.code,
           description = EXCLUDED.description,
           is_special_tracked = EXCLUDED.is_special_tracked;`,
        [newCat.id, newCat.name, newCat.code, newCat.description, newCat.isSpecialTracked]
      );
    }
    logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${newCat.name} (${newCat.code})`);
    broadcastChange({ type: 'CATEGORY_CREATED', entity: 'categories' });
    res.status(201).json(newCat);
  } catch (err: any) {
    console.error('Error creating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/categories/:id', requirePermission('category-manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const idx = categories.findIndex((c) => c.id === id);
    if (idx !== -1) {
      setCategories(withReplaced(categories, idx, { ...categories[idx], ...req.body }));
    }
    const updated = categories[idx] || { id, ...req.body };

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE categories
         SET name = $1,
             code = $2,
             description = $3,
             is_special_tracked = $4
         WHERE id = $5;`,
        [updated.name, updated.code, updated.description || '', Boolean(updated.isSpecialTracked), id]
      );
    }
    logAuditEvent(req, 'UPDATE_CATEGORY', 'CATEGORIES', `Updated category ${updated.name}`);
    broadcastChange({ type: 'CATEGORY_UPDATED', entity: 'categories' });
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/categories/:id', requirePermission('category-manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const cat = categories.find((c) => c.id === id);
    setCategories(categories.filter((c) => c.id !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM categories WHERE id = $1;', [id]);
    }
    logAuditEvent(req, 'DELETE_CATEGORY', 'CATEGORIES', `Deleted category ${cat?.name || id}`);
    broadcastChange({ type: 'CATEGORY_DELETED', entity: 'categories' });
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.get('/api/customers', async (req, res) => {
  const { branchId, query } = req.query;

  if (getPgConnected()) {
    try {
      let sql = `SELECT id, customer_id AS "customerId", customer_name AS "customerName", username, contact_number AS "contactNumber", branch_id AS "branchId", address, email, status, credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount" FROM customer_records`;
      const params: any[] = [];
      const conditions: string[] = [];

      if (branchId && branchId !== 'ALL') {
        params.push(branchId);
        conditions.push(`branch_id = $${params.length}`);
      }

      if (query && typeof query === 'string' && query.trim()) {
        params.push(`%${query.trim().toLowerCase()}%`);
        conditions.push(`(LOWER(customer_id) LIKE $${params.length} OR LOWER(customer_name) LIKE $${params.length} OR LOWER(username) LIKE $${params.length} OR LOWER(contact_number) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(address) LIKE $${params.length})`);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      sql += ' ORDER BY customer_name ASC';

      const r = await pgPool.query(sql, params);
      return res.json(r.rows);
    } catch (err) {
      console.error('Error fetching customers from DB:', err);
    }
  }

  // Dynamically calculate assignedDevicesCount from customerDeviceRecords
  customerMasterRecords.forEach((c) => {
    c.assignedDevicesCount = customerDeviceRecords.filter(
      (d) => d.customerCode === c.customerId || d.customerId === c.id || d.customerName.toLowerCase() === c.customerName.toLowerCase()
    ).length;
  });

  let list = customerMasterRecords;

  if (branchId && branchId !== 'ALL') {
    list = list.filter((c) => c.branchId === branchId);
  }

  if (query && typeof query === 'string' && query.trim()) {
    const q = query.toLowerCase().trim();
    list = list.filter(
      (c) =>
        c.customerId?.toLowerCase().includes(q) ||
        c.customerName?.toLowerCase().includes(q) ||
        c.username?.toLowerCase().includes(q) ||
        c.contactNumber?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.address?.toLowerCase().includes(q)
    );
  }

  res.json(list);
});

app.post('/api/customers', requirePermission('customers-manage'), async (req, res) => {
  try {
    const body = req.body;
    const newRecord: CustomerRecord = {
      id: body.id || body.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerId: body.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
      customerName: body.customerName || 'New Customer',
      username: body.username || (body.customerId ? body.customerId.toLowerCase() : 'user'),
      contactNumber: body.contactNumber || '9800000000',
      branchId: body.branchId || 'WH001',
      address: body.address || 'Nepal',
      email: body.email || '',
      status: body.status || 'ACTIVE',
      creditLimit: Number(body.creditLimit) || 0,
      assignedDevicesCount: 0,
    };

    const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
    if (idx >= 0) {
      setCustomerMasterRecords(withReplaced(customerMasterRecords, idx, newRecord));
    } else {
      setCustomerMasterRecords(withPrepended(customerMasterRecords, newRecord));
    }

    if (getPgConnected()) {
      await pgPool.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           customer_id = EXCLUDED.customer_id,
           customer_name = EXCLUDED.customer_name,
           username = EXCLUDED.username,
           contact_number = EXCLUDED.contact_number,
           branch_id = EXCLUDED.branch_id,
           address = EXCLUDED.address,
           email = EXCLUDED.email,
           status = EXCLUDED.status,
           credit_limit = EXCLUDED.credit_limit;`,
        [
          newRecord.id,
          newRecord.customerId,
          newRecord.customerName,
          newRecord.username,
          newRecord.contactNumber,
          newRecord.branchId,
          newRecord.address,
          newRecord.email,
          newRecord.status,
          newRecord.creditLimit,
          newRecord.assignedDevicesCount,
        ]
      );
    }
    logAuditEvent(req, 'CREATE_CUSTOMER', 'MASTER_DATA', `Created / Registered Customer Profile ${newRecord.customerName} (${newRecord.customerId})`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error creating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.post('/api/customers/bulk', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER'), async (req, res) => {
  try {
    const items: CustomerRecord[] = req.body.customers || [];
    let count = 0;

    if (getPgConnected()) {
      await withTransaction(async (client) => {
        for (const cust of items) {
          const newRecord: CustomerRecord = {
            id: cust.id || cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerId: cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
            customerName: cust.customerName || 'Imported Customer',
            username: cust.username || (cust.customerId ? cust.customerId.toLowerCase() : 'user'),
            contactNumber: cust.contactNumber || '9800000000',
            branchId: cust.branchId || 'WH001',
            address: cust.address || 'Nepal',
            email: cust.email || '',
            status: cust.status || 'ACTIVE',
            creditLimit: Number(cust.creditLimit) || 0,
            assignedDevicesCount: 0,
          };

          const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
          if (idx >= 0) {
            setCustomerMasterRecords(withReplaced(customerMasterRecords, idx, newRecord));
          } else {
            setCustomerMasterRecords(withPrepended(customerMasterRecords, newRecord));
          }

          await client.query(
            `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, email, status, credit_limit, assigned_devices_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               customer_id = EXCLUDED.customer_id,
               customer_name = EXCLUDED.customer_name,
               username = EXCLUDED.username,
               contact_number = EXCLUDED.contact_number,
               branch_id = EXCLUDED.branch_id,
               address = EXCLUDED.address,
               email = EXCLUDED.email,
               status = EXCLUDED.status,
               credit_limit = EXCLUDED.credit_limit;`,
            [
              newRecord.id,
              newRecord.customerId,
              newRecord.customerName,
              newRecord.username,
              newRecord.contactNumber,
              newRecord.branchId,
              newRecord.address,
              newRecord.email,
              newRecord.status,
              newRecord.creditLimit,
              newRecord.assignedDevicesCount,
            ]
          );
          count++;
        }
      });
    } else {
      for (const cust of items) {
        const newRecord: CustomerRecord = {
          id: cust.id || cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          customerId: cust.customerId || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          customerName: cust.customerName || 'Imported Customer',
          username: cust.username || (cust.customerId ? cust.customerId.toLowerCase() : 'user'),
          contactNumber: cust.contactNumber || '9800000000',
          branchId: cust.branchId || 'WH001',
          address: cust.address || 'Nepal',
          email: cust.email || '',
          status: cust.status || 'ACTIVE',
          creditLimit: Number(cust.creditLimit) || 0,
          assignedDevicesCount: 0,
        };

        const idx = customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
        if (idx >= 0) {
          setCustomerMasterRecords(withReplaced(customerMasterRecords, idx, newRecord));
        } else {
          setCustomerMasterRecords(withPrepended(customerMasterRecords, newRecord));
        }
        count++;
      }
    }
    logAuditEvent(req, 'BULK_IMPORT_CUSTOMERS', 'MASTER_DATA', `Bulk imported ${count} Customer Records into Master Directory`);
    res.status(201).json({ success: true, count, total: customerMasterRecords.length });
  } catch (err: any) {
    console.error('Error bulk importing customers:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.put('/api/customers/:id', requirePermission('customers-manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const idx = customerMasterRecords.findIndex((c) => c.id === id || c.customerId === id);
    if (idx < 0) {
      return res.status(404).json({ message: 'Customer record not found' });
    }

    setCustomerMasterRecords(withReplaced(customerMasterRecords, idx, {
      ...customerMasterRecords[idx],
      ...req.body,
    }));
    const updated = customerMasterRecords[idx];

    if (getPgConnected()) {
      await pgPool.query(
        `UPDATE customer_records SET
           customer_id = $1, customer_name = $2, username = $3, contact_number = $4, branch_id = $5, address = $6, email = $7, status = $8, credit_limit = $9
         WHERE id = $10 OR customer_id = $10;`,
        [updated.customerId, updated.customerName, updated.username, updated.contactNumber, updated.branchId, updated.address, updated.email, updated.status, Number(updated.creditLimit) || 0, id]
      );
    }
    logAuditEvent(req, 'UPDATE_CUSTOMER', 'MASTER_DATA', `Updated Customer Master Details for ${updated.customerName} (${updated.customerId})`, updated.branchId);
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cust = customerMasterRecords.find((c) => c.id === id || c.customerId === id);
    setCustomerMasterRecords(customerMasterRecords.filter((c) => c.id !== id && c.customerId !== id));

    if (getPgConnected()) {
      await pgPool.query('DELETE FROM customer_records WHERE id = $1 OR customer_id = $1', [id]);
    }
    logAuditEvent(req, 'DELETE_CUSTOMER', 'MASTER_DATA', `Deleted Customer Record ${cust?.customerName || id}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }
});

}
