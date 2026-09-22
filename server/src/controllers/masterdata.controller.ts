/**
 * Masterdata controller — HTTP orchestration for the masterdata domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, uomList, setUomList, withReplaced, withAppended, logAuditEvent, locationRecords, setLocationRecords, withPrepended, suppliers, setSuppliers, products, setProducts, branches, setInventoryStock, inventoryStock, categories, setCategories, broadcastChange, customerMasterRecords, customerDeviceRecords, setCustomerMasterRecords, withTransaction } from '../app';
import { UnitOfMeasure, LocationRecord, Supplier, Category, CustomerRecord } from '../../../client/src/types';
import {
  UOM_SELECT, UOM_UPSERT_SQL, upsertUomParams, UOM_UPDATE_SQL, updateUomParams, UOM_DELETE_SQL,
  buildLocationSelectSql, LOCATION_UPSERT_SQL, locationParams, LOCATION_UPDATE_SQL, LOCATION_DELETE_SQL,
  SUPPLIER_SELECT, SUPPLIER_UPSERT_SQL, supplierUpsertParams, SUPPLIER_UPDATE_SQL, supplierUpdateParams, SUPPLIER_DELETE_SQL,
  PRODUCT_SELECT, PRODUCT_UPSERT_SQL, productUpsertParams, PRODUCT_UPDATE_SQL, productUpdateParams, PRODUCT_DELETE_SQL, STOCK_INIT_SQL, stockInitParams,
  CATEGORY_SELECT, CATEGORY_UPSERT_SQL, categoryUpsertParams, CATEGORY_UPDATE_SQL, categoryUpdateParams, CATEGORY_DELETE_SQL,
  buildCustomerListQuery, CUSTOMER_UPSERT_SQL, customerUpsertParams,
  CUSTOMER_UPDATE_BY_ID_OR_CODE_SQL, customerUpdateByIdOrCodeParams, CUSTOMER_DELETE_BY_ID_OR_CODE_SQL,
} from '../models/masterdata.repo';
/** Forwarded from masterdata.routes.ts (get_uom). */
export async function get_uom(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(UOM_SELECT);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching UOM from DB:', err);
    }
  }
  res.json(uomList);

}

/** Forwarded from masterdata.routes.ts (post_uom). */
export async function post_uom(req: any, res: Response): Promise<any> {
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
      await pgPool.query(UOM_UPSERT_SQL, upsertUomParams(newUom));
    }
    logAuditEvent(req, 'CREATE_UOM', 'MASTER_DATA', `Created/updated Unit of Measure ${newUom.name} (${newUom.symbol})`);
    res.status(201).json(newUom);
  } catch (err: any) {
    console.error('Error creating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_Id). */
export async function put_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = uomList.findIndex((u) => u.id === id);
    if (idx >= 0) setUomList(withReplaced(uomList, idx, { ...uomList[idx], ...req.body }));
    const uom = uomList[idx] || req.body;

    if (getPgConnected()) {
      await pgPool.query(UOM_UPDATE_SQL, updateUomParams(uom, id));
    }
    logAuditEvent(req, 'UPDATE_UOM', 'MASTER_DATA', `Updated UOM ${uom.name}`);
    res.json(uom);
  } catch (err: any) {
    console.error('Error updating UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_Id). */
export async function delete_Id(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const uom = uomList.find((u) => u.id === id);
    setUomList(uomList.filter((u) => u.id !== id));

    if (getPgConnected()) {
      await pgPool.query(UOM_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_UOM', 'MASTER_DATA', `Deleted UOM ${uom?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting UOM:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (get_locations). */
export async function get_locations(req: any, res: Response): Promise<any> {
const { branchId } = req.query;
  if (getPgConnected()) {
    try {
      const { sql: q, params } = buildLocationSelectSql(branchId);
      const r = await pgPool.query(q, params as any[]);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching locations from DB:', err);
    }
  }
  let list = locationRecords;
  if (branchId && branchId !== 'ALL') list = list.filter((l) => l.branchId === branchId);
  res.json(list);

}

/** Forwarded from masterdata.routes.ts (post_locations). */
export async function post_locations(req: any, res: Response): Promise<any> {
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
      await pgPool.query(LOCATION_UPSERT_SQL, locationParams(newLoc));
    }
    logAuditEvent(req, 'CREATE_LOCATION', 'MASTER_DATA', `Created/updated location ${newLoc.name} (${newLoc.id})`, newLoc.branchId);
    res.status(201).json(newLoc);
  } catch (err: any) {
    console.error('Error creating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_Id2). */
export async function put_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = locationRecords.findIndex((l) => l.id === id);
    if (idx >= 0) setLocationRecords(withReplaced(locationRecords, idx, { ...locationRecords[idx], ...req.body }));
    const loc = locationRecords[idx] || req.body;

    if (getPgConnected() && loc) {
      await pgPool.query(LOCATION_UPDATE_SQL, [
          loc.name,
          loc.type,
          loc.branchId,
          loc.address,
          JSON.stringify(loc.coordinates),
          loc.contactPerson,
          loc.contactPhone,
          loc.notes,
          Number(loc.activeAssetsCount) || 0,
          id,
        ]);
    }
    logAuditEvent(req, 'UPDATE_LOCATION', 'MASTER_DATA', `Updated location details for ${loc.name} (${id})`, loc.branchId);
    res.json(loc);
  } catch (err: any) {
    console.error('Error updating location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_Id2). */
export async function delete_Id2(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const loc = locationRecords.find((l) => l.id === id);
    setLocationRecords(locationRecords.filter((l) => l.id !== id));

    if (getPgConnected()) {
      await pgPool.query(LOCATION_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_LOCATION', 'MASTER_DATA', `Deleted location ${loc?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting location:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (get_suppliers). */
export async function get_suppliers(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(SUPPLIER_SELECT);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error querying suppliers from DB:', err);
    }
  }
  res.json(suppliers);

}

/** Forwarded from masterdata.routes.ts (post_suppliers). */
export async function post_suppliers(req: any, res: Response): Promise<any> {
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
      await pgPool.query(SUPPLIER_UPSERT_SQL, supplierUpsertParams(sup));
    }
    logAuditEvent(req, 'CREATE_SUPPLIER', 'MASTER_DATA', `Created new supplier ${newSupplier.name}`);
    res.status(201).json(newSupplier);
  } catch (err: any) {
    console.error('Error creating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_Id3). */
export async function put_Id3(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = suppliers.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Supplier not found' });
    setSuppliers(withReplaced(suppliers, idx, { ...suppliers[idx], ...req.body }));
    const sup = suppliers[idx] as any;

    if (getPgConnected()) {
      await pgPool.query(SUPPLIER_UPDATE_SQL, supplierUpdateParams(sup, id));
    }
    logAuditEvent(req, 'UPDATE_SUPPLIER', 'MASTER_DATA', `Updated supplier ${sup.name} (${id})`);
    res.json(sup);
  } catch (err: any) {
    console.error('Error updating supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_Id3). */
export async function delete_Id3(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const sup = suppliers.find((s) => s.id === id);
    setSuppliers(suppliers.filter((s) => s.id !== id));

    if (getPgConnected()) {
      await pgPool.query(SUPPLIER_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_SUPPLIER', 'MASTER_DATA', `Deleted supplier ${sup?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting supplier:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (get_products). */
export async function get_products(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(PRODUCT_SELECT);
      res.json(r.rows);
      return;
    } catch (err) {
      console.error('Error fetching products from DB:', err);
    }
  }
  res.json(products);

}

/** Forwarded from masterdata.routes.ts (post_products). */
export async function post_products(req: any, res: Response): Promise<any> {
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

    // PostgreSQL database insertion. Product row + per-branch zero-stock rows
    // commit atomically: a mid-loop failure would otherwise leave stock rows
    // referencing a product that was never inserted (or vice versa).
    if (getPgConnected()) {
      await withTransaction(async (client) => {
        await client.query(PRODUCT_UPSERT_SQL, productUpsertParams(newProd as any));

        for (const stk of newStockItems) {
          await client.query(STOCK_INIT_SQL, stockInitParams(stk));
        }
      });
    }
    logAuditEvent(req, 'CREATE_PRODUCT', 'PRODUCTS', `Created new product SKU ${newProd.sku} (${newProd.name}) - Price: NPR ${newProd.sellingPrice}`);
    res.status(201).json(newProd);
  } catch (err: any) {
    console.error('Error creating product in database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_Id4). */
export async function put_Id4(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Product not found' });

    const oldProd = { ...products[idx] };
    setProducts(withReplaced(products, idx, { ...products[idx], ...req.body }));
    const updated = products[idx];

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_UPDATE_SQL, productUpdateParams(updated, id));
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

}

/** Forwarded from masterdata.routes.ts (delete_Id4). */
export async function delete_Id4(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const prod = products.find((p) => p.id === id);
    setProducts(products.filter((p) => p.id !== id));
    setInventoryStock(inventoryStock.filter((s) => s.productId !== id));

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_PRODUCT', 'PRODUCTS', `Deleted product ${prod?.name || id} (SKU: ${prod?.sku || 'N/A'})`);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting product from database:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (get_categories). */
export async function get_categories(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const { rows } = await pgPool.query(CATEGORY_SELECT);
      res.json(rows);
      return;
    } catch (err: any) {
      console.warn('Database note on GET /api/categories:', err?.message || err);
    }
  }
  res.json(categories);

}

/** Forwarded from masterdata.routes.ts (post_categories). */
export async function post_categories(req: any, res: Response): Promise<any> {
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
      await pgPool.query(CATEGORY_UPSERT_SQL, categoryUpsertParams(newCat));
    }
    logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${newCat.name} (${newCat.code})`);
    broadcastChange({ type: 'CATEGORY_CREATED', entity: 'categories' });
    res.status(201).json(newCat);
  } catch (err: any) {
    console.error('Error creating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_Id5). */
export async function put_Id5(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = categories.findIndex((c) => c.id === id);
    if (idx !== -1) {
      setCategories(withReplaced(categories, idx, { ...categories[idx], ...req.body }));
    }
    const updated = categories[idx] || { id, ...req.body };

    if (getPgConnected()) {
      await pgPool.query(CATEGORY_UPDATE_SQL, categoryUpdateParams(updated, id));
    }
    logAuditEvent(req, 'UPDATE_CATEGORY', 'CATEGORIES', `Updated category ${updated.name}`);
    broadcastChange({ type: 'CATEGORY_UPDATED', entity: 'categories' });
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_Id5). */
export async function delete_Id5(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const cat = categories.find((c) => c.id === id);
    setCategories(categories.filter((c) => c.id !== id));

    if (getPgConnected()) {
      await pgPool.query(CATEGORY_DELETE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_CATEGORY', 'CATEGORIES', `Deleted category ${cat?.name || id}`);
    broadcastChange({ type: 'CATEGORY_DELETED', entity: 'categories' });
    res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting category:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (get_customers). */
export async function get_customers(req: any, res: Response): Promise<any> {
const { branchId, query } = req.query;

  if (getPgConnected()) {
    try {
      const { sql, params } = buildCustomerListQuery(branchId, query);
      const r = await pgPool.query(sql, params as any[]);
      res.json(r.rows);
      return;
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

}

/** Forwarded from masterdata.routes.ts (post_customers). */
export async function post_customers(req: any, res: Response): Promise<any> {
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
      await pgPool.query(CUSTOMER_UPSERT_SQL, customerUpsertParams(newRecord));
    }
    logAuditEvent(req, 'CREATE_CUSTOMER', 'MASTER_DATA', `Created / Registered Customer Profile ${newRecord.customerName} (${newRecord.customerId})`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    console.error('Error creating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (post_bulk). */
export async function post_bulk(req: any, res: Response): Promise<any> {
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

          await client.query(CUSTOMER_UPSERT_SQL, customerUpsertParams(newRecord) as any[]);
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

}

/** Forwarded from masterdata.routes.ts (put_Id6). */
export async function put_Id6(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = customerMasterRecords.findIndex((c) => c.id === id || c.customerId === id);
    if (idx < 0) {
      res.status(404).json({ message: 'Customer record not found' });
      return;
    }

    setCustomerMasterRecords(withReplaced(customerMasterRecords, idx, {
      ...customerMasterRecords[idx],
      ...req.body,
    }));
    const updated = customerMasterRecords[idx];

    if (getPgConnected()) {
      await pgPool.query(
        CUSTOMER_UPDATE_BY_ID_OR_CODE_SQL,
        [...customerUpdateByIdOrCodeParams(updated), id]
      );
    }
    logAuditEvent(req, 'UPDATE_CUSTOMER', 'MASTER_DATA', `Updated Customer Master Details for ${updated.customerName} (${updated.customerId})`, updated.branchId);
    res.json(updated);
  } catch (err: any) {
    console.error('Error updating customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_Id6). */
export async function delete_Id6(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const cust = customerMasterRecords.find((c) => c.id === id || c.customerId === id);
    setCustomerMasterRecords(customerMasterRecords.filter((c) => c.id !== id && c.customerId !== id));

    if (getPgConnected()) {
      await pgPool.query(CUSTOMER_DELETE_BY_ID_OR_CODE_SQL, [id]);
    }
    logAuditEvent(req, 'DELETE_CUSTOMER', 'MASTER_DATA', `Deleted Customer Record ${cust?.customerName || id}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    console.error('Error deleting customer:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

