/**
 * Masterdata controller — HTTP orchestration for the masterdata domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pgPool, uomList, setUomList, withReplaced, withAppended, logAuditEvent, locationRecords, setLocationRecords, withPrepended, suppliers, setSuppliers, products, setProducts, branches, setInventoryStock, inventoryStock, categories, setCategories, productGroups, setProductGroups, broadcastChange, customerMasterRecords, customerDeviceRecords, setCustomerMasterRecords, withTransaction, companyProfile } from '../app';
import { defaultVatRateFor } from '../utils/money';
import { warrantyTermError } from '../../../shared/warrantyTerm';

/**
 * VAT rate for a product being created: the submitted value wins — including
 * 0, which means "VAT exempt" — and only a missing/non-numeric value falls
 * back to the company-configured default (company_profile.default_tax_rate,
 * 13% statutory VAT when unset).
 */
function taxRateOrDefault(submitted: unknown): number {
  const rate = Number(submitted);
  return Number.isFinite(rate) && rate >= 0 ? rate : defaultVatRateFor(companyProfile);
}

// ---------------------------------------------------------------------------
// Product group resolution (product_groups master data)
// ---------------------------------------------------------------------------

const PRODUCT_GROUP_BEHAVIORS: readonly ProductGroupBehavior[] = ['STOCK_ITEM', 'CONSUMABLE', 'FIXED_ASSET'];

/** Case-insensitive lookup by name or code among the managed groups. */
function findProductGroup(value: unknown): ProductGroup | undefined {
  const clean = String(value ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  return productGroups.find((g) => g.name.toLowerCase() === clean || g.code.toLowerCase() === clean);
}

function defaultProductGroup(): ProductGroup | undefined {
  return productGroups.find((g) => g.active && g.behavior === 'STOCK_ITEM') || productGroups.find((g) => g.active);
}

/**
 * Resolves the group a product write may use. A product already in a retired
 * group stays editable (it can be renamed or reclassified), but a NEW
 * assignment to a retired or unknown group is refused — the caller returns 400
 * instead of letting the foreign key surface as a 500.
 */
function resolveProductGroupForWrite(
  submitted: unknown,
  currentName?: string
): { group?: ProductGroup; error?: string } {
  const clean = String(submitted ?? '').trim();
  const candidate = clean
    ? findProductGroup(clean)
    : currentName
      ? findProductGroup(currentName)
      : defaultProductGroup();
  if (!candidate) {
    return {
      error: clean
        ? `Unknown product group '${clean}'. Add it in Product Group Management first.`
        : 'No product group is configured. Add one in Product Group Management first.',
    };
  }
  const isCurrent = currentName
    ? candidate.name.toLowerCase() === String(currentName).trim().toLowerCase()
    : false;
  if (!candidate.active && !isCurrent) {
    return { error: `Product group '${candidate.name}' is retired. Pick an active group.` };
  }
  return { group: candidate };
}

/**
 * Resolves a product's unit to a row in the `uom` table, creating it first when
 * the value only arrives through a CSV import (the UI offers the table's own
 * symbols). Additive and audited: an unused unit row is harmless, while a
 * rejected import row loses the operator's data.
 */
const UNIT_TYPE_BY_SYMBOL: Record<string, UnitOfMeasure['type']> = {
  MTR: 'Length', METER: 'Length', KM: 'Length', CM: 'Length', FT: 'Length',
  KG: 'Weight', GM: 'Weight', LTR: 'Volume', ML: 'Volume',
  BOX: 'Package', ROLL: 'Package', BAG: 'Package', BUNDLE: 'Package', CARTON: 'Package',
  SET: 'Count', PCS: 'Count', PAIR: 'Count', UNIT: 'Count',
};

async function ensureCategoryName(req: any, submitted: unknown): Promise<string> {
  const clean = String(submitted ?? '').trim();
  if (!clean) return '';
  const existing = categories.find((c) => (c.name || '').toLowerCase() === clean.toLowerCase());
  if (existing) return existing.name;

  const slug = clean.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'CAT';
  let code = `CAT-${slug}`;
  let suffix = 2;
  while (categories.some((c) => (c.code || '').toUpperCase() === code)) code = `CAT-${slug}-${suffix++}`;

  const created: Category = {
    id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    code,
    description: 'Created automatically from a product save.',
    isSpecialTracked: false,
  };
  setCategories(withAppended(categories, created));
  if (getPgConnected()) await pgPool.query(CATEGORY_UPSERT_SQL, categoryUpsertParams(created));
  logAuditEvent(req, 'CREATE_CATEGORY', 'CATEGORIES', `Created category ${created.name} (${created.code}) from a product save`);
  broadcastChange({ type: 'CATEGORY_CREATED', entity: 'CATEGORIES' });
  return created.name;
}

async function ensureUnitSymbol(req: any, submitted: unknown): Promise<string> {
  const clean = String(submitted ?? '').trim();
  if (!clean) return '';
  const existing = uomList.find(
    (u) => (u.symbol || '').toLowerCase() === clean.toLowerCase() || (u.name || '').toLowerCase() === clean.toLowerCase()
  );
  if (existing) return existing.symbol;

  const created: UnitOfMeasure = {
    id: `uom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    symbol: clean,
    type: UNIT_TYPE_BY_SYMBOL[clean.toUpperCase()] || 'Count',
    isBaseUnit: false,
  };
  setUomList(withAppended(uomList, created));
  if (getPgConnected()) await pgPool.query(UOM_UPSERT_SQL, upsertUomParams(created));
  logAuditEvent(req, 'CREATE_UOM', 'MASTER_DATA', `Created unit of measure ${created.name} (${created.symbol}) from a product save`);
  broadcastChange({ type: 'MASTER_DATA_UPDATED', entity: 'MASTER_DATA' });
  return created.symbol;
}
import { UnitOfMeasure, LocationRecord, Supplier, Category, CustomerRecord, ProductGroup, ProductGroupBehavior } from '../../../client/src/types';
import {
  UOM_SELECT, UOM_UPSERT_SQL, upsertUomParams, UOM_UPDATE_SQL, updateUomParams, UOM_DELETE_SQL,
  buildLocationSelectSql, LOCATION_UPSERT_SQL, locationParams, LOCATION_DELETE_SQL,
  SUPPLIER_SELECT, SUPPLIER_UPSERT_SQL, supplierUpsertParams, SUPPLIER_UPDATE_SQL, supplierUpdateParams, SUPPLIER_DELETE_SQL,
  PRODUCT_SELECT, PRODUCT_UPSERT_SQL, productUpsertParams, PRODUCT_UPDATE_SQL, productUpdateParams, PRODUCT_DELETE_SQL, STOCK_INIT_SQL, stockInitParams,
  CATEGORY_SELECT, CATEGORY_UPSERT_SQL, categoryUpsertParams, CATEGORY_UPDATE_SQL, categoryUpdateParams, CATEGORY_DELETE_SQL,
  PRODUCT_GROUP_SELECT, PRODUCT_GROUP_UPSERT_SQL, productGroupUpsertParams, PRODUCT_GROUP_UPDATE_SQL, productGroupUpdateParams, PRODUCT_GROUP_DELETE_SQL,
  buildCustomerListQuery, buildCustomerListAggregateQuery, normalizeCustomerPaging, CUSTOMER_UPSERT_SQL, customerUpsertParams,
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

/**
 * WTY-3: warranty defaults are whole months, 0..120. 0 means "no warranty"
 * and suppresses coverage creation; anything non-integral is a 400, not a
 * silently clamped value. The rule itself is shared with the product form.
 */
function warrantyMonthsOrError(value: unknown): { months?: number; error?: string } {
  if (value === undefined || value === null || value === '') return { months: 12 };
  const error = warrantyTermError(value);
  if (error) return { error };
  return { months: Number(value) };
}

/** Forwarded from masterdata.routes.ts (post_products). */
export async function post_products(req: any, res: Response): Promise<any> {
try {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ message: 'Product name is required.' });
    const vendorTerm = warrantyMonthsOrError(req.body.vendorWarrantyMonths);
    if (vendorTerm.error) return res.status(400).json({ message: vendorTerm.error });
    const sellerTerm = warrantyMonthsOrError(req.body.sellerWarrantyMonths);
    if (sellerTerm.error) return res.status(400).json({ message: sellerTerm.error });

    // Product group is curated master data: an unknown or retired name is a 400
    // here, never a foreign-key 500 from PostgreSQL.
    const resolvedGroup = resolveProductGroupForWrite(req.body.productGroup);
    if (!resolvedGroup.group) return res.status(400).json({ message: resolvedGroup.error });

    // Category and unit are resolved against their tables. A value only a CSV
    // import can introduce is created (and audited) rather than stored as free
    // text, so products never point at a master row that does not exist.
    const category = await ensureCategoryName(req, req.body.category);
    if (!category) return res.status(400).json({ message: 'Category is required.' });
    const unit = (await ensureUnitSymbol(req, req.body.unit)) || uomList[0]?.symbol || 'Pcs';

    const newProd = {
      id: `prod-${Date.now()}`,
      sku: req.body.sku || `SKU-${Date.now()}`,
      barcode: req.body.barcode || '',
      name,
      category,
      productGroup: resolvedGroup.group.name,
      unit,
      costPrice: Number(req.body.costPrice) || 0,
      sellingPrice: Number(req.body.sellingPrice) || 0,
      taxRate: taxRateOrDefault(req.body.taxRate),
      minReorderLevel: Number(req.body.minReorderLevel) || 5,
      requiresSerialTracking: Boolean(req.body.requiresSerialTracking),
      trackingType: req.body.trackingType || 'QUANTITY_ONLY',
      description: req.body.description || '',
      vendorWarrantyMonths: vendorTerm.months,
      sellerWarrantyMonths: sellerTerm.months,
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

    const previous = products[idx];
    const oldProd = { ...previous };
    // A term is optional on edit: omitting it (or sending null/"") keeps the
    // stored value. Only an explicit, invalid value is a 400 — and it is
    // rejected BEFORE the cache or the database is touched.
    for (const field of ['vendorWarrantyMonths', 'sellerWarrantyMonths'] as const) {
      if (!(field in req.body)) continue;
      if (req.body[field] === null || req.body[field] === '') {
        delete req.body[field];
        continue;
      }
      const term = warrantyMonthsOrError(req.body[field]);
      if (term.error) return res.status(400).json({ message: term.error });
      req.body[field] = term.months;
    }
    const next: any = { ...previous, ...req.body };
    // Identity is the URL's, never the body's.
    next.id = previous.id;

    const resolvedGroup = resolveProductGroupForWrite(req.body.productGroup, previous.productGroup);
    if (!resolvedGroup.group) return res.status(400).json({ message: resolvedGroup.error });
    next.productGroup = resolvedGroup.group.name;

    if (req.body.category !== undefined) {
      const category = await ensureCategoryName(req, req.body.category);
      if (!category) return res.status(400).json({ message: 'Category is required.' });
      next.category = category;
    }
    if (req.body.unit !== undefined) {
      next.unit = (await ensureUnitSymbol(req, req.body.unit)) || previous.unit;
    }

    setProducts(withReplaced(products, idx, next));
    const updated = products[idx];

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_UPDATE_SQL, productUpdateParams(updated, id, defaultVatRateFor(companyProfile)));
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

/**
 * Forwarded from masterdata.routes.ts (get_customers).
 *
 * Paged envelope: `{ data, page, pageSize, totalItems, activeItems,
 * totalCreditLimit }`. The directory screen reads this shape (it has since
 * 2026-10-05); before this change the handler returned a bare array, so
 * `envelope.data` was undefined and the screen rendered zero rows. Page and
 * pageSize are clamped here and echoed back, and the aggregate is computed
 * with the SAME WHERE as the page so the KPI cards always describe the rows.
 * `all=1` returns every filtered row for the CSV export.
 *
 * VOL-4a: this is the app's only customer read (the bootstrap stopped shipping
 * `customer_records`), so the branch scope is resolved from the session here and
 * applied in SQL rather than trusted from the query string.
 */
/** Unique, readable code for a new/renamed group (codes never carry business meaning). */
function uniqueProductGroupCode(base: string, excludeId?: string): string {
  const clean = String(base || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'GROUP';
  let code = clean;
  let suffix = 2;
  while (productGroups.some((g) => g.id !== excludeId && (g.code || '').toUpperCase() === code)) {
    code = `${clean}_${suffix++}`;
  }
  return code;
}

/** Forwarded from masterdata.routes.ts (get_product_groups). */
export async function get_product_groups(req: any, res: Response): Promise<any> {
if (getPgConnected()) {
    try {
      const r = await pgPool.query(PRODUCT_GROUP_SELECT);
      setProductGroups(r.rows as any);
      res.json(r.rows);
      return;
    } catch (err: any) {
      console.warn('Database note on GET /api/product-groups:', err?.message || err);
    }
  }
  res.json(
    productGroups.map((g) => ({
      ...g,
      productCount: products.filter((p) => (p.productGroup || '') === g.name).length,
    }))
  );

}

/** Forwarded from masterdata.routes.ts (post_product_groups). */
export async function post_product_groups(req: any, res: Response): Promise<any> {
try {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ message: 'Group name is required.' });
    if (name.length > 100) return res.status(400).json({ message: 'Group name must be 100 characters or fewer.' });

    const behavior = String(req.body.behavior ?? '').trim().toUpperCase() as ProductGroupBehavior;
    if (!PRODUCT_GROUP_BEHAVIORS.includes(behavior)) {
      return res.status(400).json({
        message: `Invalid behaviour '${req.body.behavior}'. Use STOCK_ITEM, CONSUMABLE or FIXED_ASSET.`,
      });
    }
    if (productGroups.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ message: `A product group named '${name}' already exists.` });
    }

    const group: ProductGroup = {
      id: `pg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      code: uniqueProductGroupCode(req.body.code || name),
      name,
      behavior,
      sortOrder: Number(req.body.sortOrder) || 100,
      active: req.body.active === undefined ? true : Boolean(req.body.active),
      isSystem: false,
    };
    setProductGroups(withAppended(productGroups, group));

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_GROUP_UPSERT_SQL, productGroupUpsertParams(group as any));
    }
    logAuditEvent(req, 'CREATE_PRODUCT_GROUP', 'MASTER_DATA', `Created product group ${group.name} (${group.behavior})`);
    broadcastChange({ type: 'MASTER_DATA_UPDATED', entity: 'MASTER_DATA' });
    res.status(201).json(group);
  } catch (err: any) {
    console.error('Error creating product group:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (put_product_groups). */
export async function put_product_groups(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const idx = productGroups.findIndex((g) => g.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Product group not found.' });

    const current = productGroups[idx];
    const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
    if (!name) return res.status(400).json({ message: 'Group name is required.' });
    if (name.length > 100) return res.status(400).json({ message: 'Group name must be 100 characters or fewer.' });
    if (productGroups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ message: `A product group named '${name}' already exists.` });
    }

    const behavior = req.body.behavior === undefined
      ? current.behavior
      : (String(req.body.behavior).trim().toUpperCase() as ProductGroupBehavior);
    if (!PRODUCT_GROUP_BEHAVIORS.includes(behavior)) {
      return res.status(400).json({
        message: `Invalid behaviour '${req.body.behavior}'. Use STOCK_ITEM, CONSUMABLE or FIXED_ASSET.`,
      });
    }

    const code = req.body.code === undefined
      ? current.code
      : uniqueProductGroupCode(req.body.code, id);

    const next: ProductGroup = {
      ...current,
      code,
      name,
      behavior,
      sortOrder: req.body.sortOrder === undefined ? current.sortOrder : Number(req.body.sortOrder) || 100,
      active: req.body.active === undefined ? current.active : Boolean(req.body.active),
    };
    const renamed = current.name !== next.name;
    const behaviorChanged = current.behavior !== next.behavior;

    setProductGroups(withReplaced(productGroups, idx, next));
    if (renamed) {
      // PostgreSQL performs the same rename through the foreign key's ON UPDATE
      // CASCADE; this keeps the in-memory catalog consistent until the cache
      // refresh re-reads both tables.
      setProducts(products.map((p) => ((p.productGroup || '') === current.name ? { ...p, productGroup: next.name } : p)));
    }

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_GROUP_UPDATE_SQL, productGroupUpdateParams(next as any, id));
    }

    const change = renamed ? `renamed '${current.name}' to '${next.name}'` : `updated '${next.name}'`;
    logAuditEvent(
      req,
      behaviorChanged ? 'PRODUCT_GROUP_BEHAVIOR_CHANGED' : 'UPDATE_PRODUCT_GROUP',
      'MASTER_DATA',
      `Product group ${change}${behaviorChanged ? ` (behaviour ${current.behavior} -> ${next.behavior})` : ''}`
    );
    broadcastChange({ type: 'MASTER_DATA_UPDATED', entity: 'MASTER_DATA' });
    res.json(next);
  } catch (err: any) {
    console.error('Error updating product group:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

/** Forwarded from masterdata.routes.ts (delete_product_groups). */
export async function delete_product_groups(req: any, res: Response): Promise<any> {
try {
    const { id } = req.params;
    const group = productGroups.find((g) => g.id === id);
    if (!group) return res.status(404).json({ message: 'Product group not found.' });
    if (group.isSystem) {
      return res.status(409).json({
        message: `'${group.name}' is a built-in group. Retire it (active off) instead of deleting it.`,
      });
    }

    const inUse = products.filter((p) => (p.productGroup || '') === group.name).length;
    if (inUse > 0) {
      return res.status(409).json({
        message: `'${group.name}' is assigned to ${inUse} product${inUse === 1 ? '' : 's'}. Move them to another group first, or retire this group.`,
      });
    }

    if (getPgConnected()) {
      await pgPool.query(PRODUCT_GROUP_DELETE_SQL, [id]);
    }
    setProductGroups(productGroups.filter((g) => g.id !== id));
    logAuditEvent(req, 'DELETE_PRODUCT_GROUP', 'MASTER_DATA', `Deleted product group ${group.name}`);
    broadcastChange({ type: 'MASTER_DATA_UPDATED', entity: 'MASTER_DATA' });
    res.json({ success: true });
  } catch (err: any) {
    // 23503 = foreign key violation: a product was assigned after the check.
    if (err?.code === '23503') {
      return res.status(409).json({
        message: 'This group is still assigned to products. Move them first, or retire the group.',
      });
    }
    console.error('Error deleting product group:', err);
    res.status(500).json({ message: `Database error: ${err.message}` });
  }

}

export async function get_customers(req: any, res: Response): Promise<any> {
const { branchId, query, status, page, pageSize, all } = req.query;
  const exportAll = all === '1' || all === 'true';

  // VOL-4a: the customer directory is national data, so branch scope is a
  // server decision. This endpoint is now the ONLY customer read in the app
  // (the bootstrap no longer ships the table), which makes it the place a
  // branch account could otherwise read every ward of the country: previously
  // an omitted `branchId` or `ALL` returned the whole national directory.
  // Mirrors /api/transaction-logs and /api/shipments/page — naming a branch
  // outside the account is a 403, omitting it means "all my branches".
  const user = req.user;
  let branchScope: string[] | undefined;
  let scopedBranchId: unknown = branchId;
  if (user && user.role !== 'SUPER_ADMIN' && user.role !== 'HEAD_OFFICE_ADMIN') {
    const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
    const requested =
      typeof branchId === 'string' && branchId !== 'ALL' && branchId.trim() !== '' ? branchId : undefined;
    if (requested && !allowed.has(requested)) {
      res.status(403).json({ message: 'Forbidden: this account is not authorized for the requested branch.' });
      return;
    }
    if (allowed.size === 0) {
      return res.json({ data: [], page: 1, pageSize: 0, totalItems: 0, activeItems: 0, totalCreditLimit: 0 });
    }
    branchScope = requested ? [requested] : [...allowed];
    scopedBranchId = undefined;
  }

  const options = { branchId: scopedBranchId, branchScope, query, status, page, pageSize, all: exportAll };

  if (getPgConnected()) {
    try {
      const list = buildCustomerListQuery(options);
      const aggregate = buildCustomerListAggregateQuery(options);
      const [rows, totals] = await Promise.all([
        pgPool.query(list.sql, list.params as any[]),
        pgPool.query(aggregate.sql, aggregate.params as any[]),
      ]);
      res.json({
        data: rows.rows,
        page: list.page,
        pageSize: exportAll ? rows.rows.length : list.pageSize,
        totalItems: Number(totals.rows[0]?.count) || 0,
        activeItems: Number(totals.rows[0]?.active) || 0,
        totalCreditLimit: Number(totals.rows[0]?.credit) || 0,
      });
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

  // Same scope rules as the SQL path above.
  if (Array.isArray(branchScope)) {
    const scope = new Set(branchScope);
    list = list.filter((c) => scope.has(String(c.branchId || '')));
  } else if (branchId && branchId !== 'ALL') {
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

  const statusValue = typeof status === 'string' ? status.trim().toUpperCase() : '';
  const statusFilter = statusValue === 'ACTIVE' || statusValue === 'INACTIVE' ? statusValue : undefined;
  if (statusFilter) {
    list = list.filter((c) => String(c.status || '').toUpperCase() === statusFilter);
  }

  // Same ordering as the SQL list (name, then code) so paging is stable.
  const sorted = [...list].sort((a, b) =>
    String(a.customerName || '').localeCompare(String(b.customerName || '')) ||
    String(a.customerId || '').localeCompare(String(b.customerId || ''))
  );
  const paging = normalizeCustomerPaging(page, pageSize);
  const data = exportAll
    ? sorted
    : sorted.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize);

  res.json({
    data,
    page: paging.page,
    pageSize: exportAll ? data.length : paging.pageSize,
    totalItems: sorted.length,
    activeItems: sorted.filter((c) => String(c.status || '').toUpperCase() === 'ACTIVE').length,
    totalCreditLimit: sorted.reduce((sum, c) => sum + (Number(c.creditLimit) || 0), 0),
  });

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

