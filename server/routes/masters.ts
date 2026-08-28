/**
 * Route module: masters
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected } from '../lib/db';
import { readPgOrStore, num } from '../lib/pgReads';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  sendWriteFailure,
  commitLocalMirror,
} from '../lib/writeGuard';
import { requireRole, logAuditEvent, sanitizeUser } from '../lib/auth';
import {
  hashPassword,
  validatePasswordStrength,
  destroyUserSessions,
  normalizeRole,
  MIN_PASSWORD_LENGTH,
} from '../lib/authUtils';
import { bumpDataVersion } from '../lib/sync';
import type {
  User,
  Supplier,
  Branch,
  UnitOfMeasure,
  LocationRecord,
} from '../../src/types';

const router = Router();

router.get('/api/uom', async (req, res) => {
  const rows = await readPgOrStore<any>({
    label: 'uom.list',
    sql: 'SELECT id, name, symbol, type, is_base_unit AS "isBaseUnit" FROM uom ORDER BY name ASC',
    fallback: () => store.uomList,
    onRows: (rows) => { if (isPgConnected) store.replaceCollection('uomList', rows as any); },
  });
  res.json(rows);
});

router.post('/api/uom', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const newUom: UnitOfMeasure = {
      id: req.body.id || `uom-${Date.now()}`,
      name: req.body.name || 'Unit',
      symbol: req.body.symbol || 'Unit',
      type: req.body.type || 'Count',
      isBaseUnit: Boolean(req.body.isBaseUnit),
    };
    const idx = store.uomList.findIndex((u) => u.id === newUom.id || u.name === newUom.name);
    if (idx >= 0) store.uomList[idx] = newUom;
    else store.uomList.push(newUom);

    await writeThroughPg('CREATE_UOM', async () => {
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
    });
    commitLocalMirror();
    logAuditEvent(req, 'CREATE_UOM', 'MASTER_DATA', `Created/updated Unit of Measure ${newUom.name} (${newUom.symbol})`);
    res.status(201).json(newUom);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating UOM:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/uom/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const idx = store.uomList.findIndex((u) => u.id === id);
    if (idx >= 0) store.uomList[idx] = { ...store.uomList[idx], ...req.body };
    const uom = store.uomList[idx] || req.body;

    await writeThroughPg('UPDATE_UOM', async () => {
      await pgPool.query(
        `UPDATE uom SET name = $1, symbol = $2, type = $3, is_base_unit = $4 WHERE id = $5;`,
        [uom.name, uom.symbol, uom.type, Boolean(uom.isBaseUnit), id]
      );
    });
    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_UOM', 'MASTER_DATA', `Updated UOM ${uom.name}`);
    res.json(uom);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating UOM:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/uom/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const uom = store.uomList.find((u) => u.id === id);
    { const __filtered = store.uomList.filter((u) => u.id !== id); store.uomList.length = 0; store.uomList.push(...__filtered); }

    await writeThroughPg('DELETE_UOM', async () => {
      await pgPool.query('DELETE FROM uom WHERE id = $1', [id]);
    });
    commitLocalMirror();
    logAuditEvent(req, 'DELETE_UOM', 'MASTER_DATA', `Deleted UOM ${uom?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting UOM:', err);
    return sendWriteFailure(res, err);
  }
});

// Locations
router.get('/api/locations', async (req, res) => {
  const { branchId } = req.query;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const rows = await readPgOrStore<any>({
    label: 'locations.list',
    sql:
      'SELECT id, name, type, branch_id AS "branchId", address, coordinates, contact_person AS "contactPerson", contact_phone AS "contactPhone", notes, active_assets_count AS "activeAssetsCount" FROM locations' +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY name ASC',
    params: bf ? [bf] : [],
    fallback: () => (bf ? store.locationRecords.filter((l) => l.branchId === bf) : store.locationRecords),
    map: (r) => ({
      ...r,
      coordinates: typeof r.coordinates === 'string' ? JSON.parse(r.coordinates || 'null') : r.coordinates,
      activeAssetsCount: num(r.activeAssetsCount, 0),
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('locationRecords', rows as any);
      else {
        const others = store.locationRecords.filter((l) => l.branchId !== bf);
        store.replaceCollection('locationRecords', [...others, ...(rows as any)]);
      }
    },
  });
  res.json(rows);
});

router.post('/api/locations', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const newLoc: LocationRecord = {
      id: req.body.id || `LOC-${Math.floor(1000 + Math.random() * 9000)}`,
      name: req.body.name || 'New Location',
      type: req.body.type || 'POP_SERVER_ROOM',
      branchId: req.body.branchId || 'BR-KTM',
      address: req.body.address || '',
      coordinates: req.body.coordinates || { latitude: 27.7172, longitude: 85.324 },
      contactPerson: req.body.contactPerson || '',
      contactPhone: req.body.contactPhone || '',
      notes: req.body.notes || '',
      activeAssetsCount: req.body.activeAssetsCount || 0,
    };
    const idx = store.locationRecords.findIndex((l) => l.id === newLoc.id);
    if (idx >= 0) store.locationRecords[idx] = newLoc;
    else store.locationRecords.unshift(newLoc);

    await writeThroughPg('CREATE_LOCATION', async () => {
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
    });
    commitLocalMirror();
    logAuditEvent(req, 'CREATE_LOCATION', 'MASTER_DATA', `Created/updated location ${newLoc.name} (${newLoc.id})`, newLoc.branchId);
    res.status(201).json(newLoc);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating location:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/locations/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const idx = store.locationRecords.findIndex((l) => l.id === id);
    if (idx >= 0) store.locationRecords[idx] = { ...store.locationRecords[idx], ...req.body };
    const loc = store.locationRecords[idx] || req.body;

    if (isPgConnected && loc) {
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
    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_LOCATION', 'MASTER_DATA', `Updated location details for ${loc.name} (${id})`, loc.branchId);
    res.json(loc);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating location:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/locations/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const loc = store.locationRecords.find((l) => l.id === id);
    { const __filtered = store.locationRecords.filter((l) => l.id !== id); store.locationRecords.length = 0; store.locationRecords.push(...__filtered); }

    await writeThroughPg('DELETE_LOCATION', async () => {
      await pgPool.query('DELETE FROM locations WHERE id = $1', [id]);
    });
    commitLocalMirror();
    logAuditEvent(req, 'DELETE_LOCATION', 'MASTER_DATA', `Deleted location ${loc?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting location:', err);
    return sendWriteFailure(res, err);
  }
});

// Company Profile API
router.get('/api/company-profile', async (req, res) => {
  const rows = await readPgOrStore<any>({
    label: 'company.profile.masters',
    sql: `SELECT id, name, legal_name AS "legalName", tagline, address, city, country, phone, email, website,
                 pan_vat_number AS "panVatNumber", registration_number AS "registrationNumber",
                 logo_url AS "logoUrl", logo_preset AS "logoPreset", currency_symbol AS "currencySymbol",
                 default_tax_rate AS "defaultTaxRate", notes FROM company_profile LIMIT 1`,
    fallback: () => [store.companyProfile],
    map: (r) => ({ ...r, defaultTaxRate: num(r.defaultTaxRate, 13) }),
    onRows: (rows) => { if (isPgConnected && rows[0]) store.setCompanyProfile(rows[0]); },
  });
  res.json(rows[0] || store.companyProfile);
});

router.put('/api/company-profile', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    store.setCompanyProfile({ ...store.companyProfile, ...req.body });
    if (!store.companyProfile.id) store.companyProfile.id = 'COMP-001';

    await writeThroughPg('UPDATE_COMPANY_PROFILE', async () => {
      await pgPool.query(
        `INSERT INTO company_profile (id, name, legal_name, tagline, address, city, country, phone, email, website, pan_vat_number, registration_number, logo_url, logo_preset, currency_symbol, default_tax_rate, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           legal_name = EXCLUDED.legal_name,
           tagline = EXCLUDED.tagline,
           address = EXCLUDED.address,
           city = EXCLUDED.city,
           country = EXCLUDED.country,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website,
           pan_vat_number = EXCLUDED.pan_vat_number,
           registration_number = EXCLUDED.registration_number,
           logo_url = EXCLUDED.logo_url,
           logo_preset = EXCLUDED.logo_preset,
           currency_symbol = EXCLUDED.currency_symbol,
           default_tax_rate = EXCLUDED.default_tax_rate,
           notes = EXCLUDED.notes,
           updated_at = CURRENT_TIMESTAMP;`,
        [
          store.companyProfile.id,
          store.companyProfile.name,
          store.companyProfile.legalName || '',
          store.companyProfile.tagline || '',
          store.companyProfile.address,
          store.companyProfile.city || '',
          store.companyProfile.country || '',
          store.companyProfile.phone || '',
          store.companyProfile.email || '',
          store.companyProfile.website || '',
          store.companyProfile.panVatNumber || '',
          store.companyProfile.registrationNumber || '',
          store.companyProfile.logoUrl || '',
          store.companyProfile.logoPreset || 'telecom',
          store.companyProfile.currencySymbol || 'Rs.',
          store.companyProfile.defaultTaxRate ?? 13,
          store.companyProfile.notes || '',
        ]
      );
    });
    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_COMPANY_PROFILE', 'MASTER_DATA', `Updated Company Master Details: ${store.companyProfile.name}`);
    bumpDataVersion();
    res.json(store.companyProfile);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating company profile:', err);
    return sendWriteFailure(res, err);
  }
});

// Branches
router.get('/api/branches', async (req, res) => {
  const rows = await readPgOrStore<any>({
    label: 'branches.list',
    sql: 'SELECT id, code, name, location, phone, is_headquarters AS "isHeadquarters", active, allow_procurement AS "allowProcurement" FROM branches ORDER BY name ASC',
    fallback: () => store.branches,
    onRows: (rows) => { if (isPgConnected) store.replaceCollection('branches', rows as any); },
  });
  res.json(rows);
});

router.post('/api/branches', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const newBranch: Branch = {
      id: req.body.id || `br-${Date.now()}`,
      code: req.body.code || `BR-${Math.floor(100 + Math.random() * 900)}`,
      name: req.body.name || 'New Branch',
      location: req.body.location || 'Nepal',
      phone: req.body.phone || '',
      isHeadquarters: Boolean(req.body.isHeadquarters),
      active: req.body.active !== false,
      allowProcurement: req.body.allowProcurement !== false,
    };
    const idx = store.branches.findIndex((b) => b.id === newBranch.id);
    if (idx >= 0) store.branches[idx] = newBranch;
    else store.branches.push(newBranch);

    await writeThroughPg('CREATE_BRANCH', async () => {
      await pgPool.query(
        `INSERT INTO branches (id, code, name, location, phone, is_headquarters, active, allow_procurement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           location = EXCLUDED.location,
           phone = EXCLUDED.phone,
           is_headquarters = EXCLUDED.is_headquarters,
           active = EXCLUDED.active,
           allow_procurement = EXCLUDED.allow_procurement;`,
        [newBranch.id, newBranch.code, newBranch.name, newBranch.location, newBranch.phone, newBranch.isHeadquarters, newBranch.active, newBranch.allowProcurement]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_BRANCH', 'MASTER_DATA', `Created new branch ${newBranch.name} (${newBranch.code || newBranch.id})`);
    res.status(201).json(newBranch);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating branch:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/branches/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const idx = store.branches.findIndex((b) => b.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Branch not found' });
    store.branches[idx] = { ...store.branches[idx], ...req.body };
    const b = store.branches[idx];

    await writeThroughPg('UPDATE_BRANCH', async () => {
      await pgPool.query(
        `UPDATE branches SET
           code = $1, name = $2, location = $3, phone = $4, is_headquarters = $5, active = $6, allow_procurement = $7
         WHERE id = $8;`,
        [b.code, b.name, b.location, b.phone || '', Boolean(b.isHeadquarters), b.active !== false, b.allowProcurement !== false, id]
      );
    });
    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_BRANCH', 'MASTER_DATA', `Updated branch details for ${b.name} (${b.id})`);
    res.json(b);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating branch:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/branches/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const br = store.branches.find((b) => b.id === id);
    { const __filtered = store.branches.filter((b) => b.id !== id); store.branches.length = 0; store.branches.push(...__filtered); }

    await writeThroughPg('DELETE_BRANCH', async () => {
      await pgPool.query('DELETE FROM branches WHERE id = $1', [id]);
    });
    commitLocalMirror();
    logAuditEvent(req, 'DELETE_BRANCH', 'MASTER_DATA', `Deleted branch ${br?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting branch:', err);
    return sendWriteFailure(res, err);
  }
});

// Suppliers
router.get('/api/suppliers', async (req, res) => {
  const rows = await readPgOrStore<any>({
    label: 'suppliers.list',
    sql: 'SELECT id, supplier_code AS "supplierCode", name, contact_person AS "contactPerson", phone, email, address, pan_vat_number AS "panVatNumber", rating, status FROM suppliers ORDER BY name ASC',
    fallback: () => store.suppliers,
    map: (r) => ({ ...r, rating: num(r.rating, 5) }),
    onRows: (rows) => { if (isPgConnected) store.replaceCollection('suppliers', rows as any); },
  });
  res.json(rows);
});

router.post('/api/suppliers', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
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
    store.suppliers.push(newSupplier);

    await writeThroughPg('CREATE_SUPPLIER', async () => {
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
    });
    commitLocalMirror();
    logAuditEvent(req, 'CREATE_SUPPLIER', 'MASTER_DATA', `Created new supplier ${newSupplier.name}`);
    res.status(201).json(newSupplier);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating supplier:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/suppliers/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const idx = store.suppliers.findIndex((s) => s.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Supplier not found' });
    store.suppliers[idx] = { ...store.suppliers[idx], ...req.body };
    const sup = store.suppliers[idx] as any;

    await writeThroughPg('UPDATE_SUPPLIER', async () => {
      await pgPool.query(
        `UPDATE suppliers SET
           supplier_code = $1, name = $2, contact_person = $3, phone = $4, email = $5, address = $6, pan_vat_number = $7, rating = $8, status = $9
         WHERE id = $10;`,
        [sup.supplierCode || '', sup.name, sup.contactPerson || '', sup.phone || '', sup.email || '', sup.address || '', sup.panVatNumber || '', Number(sup.rating) || 5.0, sup.status || 'ACTIVE', id]
      );
    });
    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_SUPPLIER', 'MASTER_DATA', `Updated supplier ${sup.name} (${id})`);
    res.json(sup);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating supplier:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/suppliers/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const sup = store.suppliers.find((s) => s.id === id);
    { const __filtered = store.suppliers.filter((s) => s.id !== id); store.suppliers.length = 0; store.suppliers.push(...__filtered); }

    await writeThroughPg('DELETE_SUPPLIER', async () => {
      await pgPool.query('DELETE FROM suppliers WHERE id = $1', [id]);
    });
    commitLocalMirror();
    logAuditEvent(req, 'DELETE_SUPPLIER', 'MASTER_DATA', `Deleted supplier ${sup?.name || id}`);
    res.json({ success: true });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting supplier:', err);
    return sendWriteFailure(res, err);
  }
});

// Users
router.get('/api/users', async (req, res) => {
  const rows = await readPgOrStore<any>({
    label: 'users.list',
    sql: 'SELECT id, email, name, role, branch_id AS "branchId", allowed_branch_ids AS "allowedBranchIds", can_switch_user AS "canSwitchUser" FROM users ORDER BY created_at ASC',
    fallback: () => store.users.map(({ password: _p, ...u }) => u),
  });
  res.json(rows.map(({ password: _p, ...u }) => u));
});

router.post('/api/users', requireRole('SUPER_ADMIN'), async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const plainPassword = (req.body.password && String(req.body.password).trim()) || '';
    const strength = validatePasswordStrength(plainPassword || 'x');
    // Allow auto-generated default only if client omitted password; still enforce min length on provided ones
    let passwordToStore: string;
    if (!plainPassword) {
      passwordToStore = await hashPassword('ChangeMe@12345');
    } else {
      if (!validatePasswordStrength(plainPassword).ok) {
        return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` });
      }
      passwordToStore = await hashPassword(plainPassword);
    }

    const role = normalizeRole(req.body.role || 'FRONT_DESK');
    const newUser: User = {
      id: req.body.id || `usr-${Date.now()}`,
      email: (req.body.email || '').trim().toLowerCase(),
      name: req.body.name || 'New User',
      role: role as User['role'],
      branchId: req.body.branchId,
      allowedBranchIds: req.body.allowedBranchIds,
      canSwitchUser: !!req.body.canSwitchUser,
      password: passwordToStore,
    };

    if (!newUser.email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    const idx = store.users.findIndex((u) => u.id === newUser.id || u.email === newUser.email);
    if (idx >= 0) store.users[idx] = { ...store.users[idx], ...newUser };
    else store.users.push(newUser);

    await writeThroughPg('CREATE_USER', async () => {
      await pgPool.query(
        `INSERT INTO users (id, email, password, name, role, branch_id, allowed_branch_ids, can_switch_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           role = EXCLUDED.role,
           branch_id = EXCLUDED.branch_id,
           allowed_branch_ids = EXCLUDED.allowed_branch_ids,
           can_switch_user = EXCLUDED.can_switch_user,
           password = EXCLUDED.password;`,
        [
          newUser.id,
          newUser.email,
          newUser.password,
          newUser.name,
          newUser.role,
          newUser.branchId || null,
          newUser.allowedBranchIds || null,
          !!newUser.canSwitchUser,
        ]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_USER', 'AUTH', `Created new user account ${newUser.name} (${newUser.email}) - Role: ${newUser.role}`);
    res.status(201).json(sanitizeUser(newUser));
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating user:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/users/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    let idx = store.users.findIndex((u) => u.id === id);

    if (idx === -1 && isPgConnected) {
      const r = await pgPool.query('SELECT * FROM users WHERE id = $1', [id]);
      if (r.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    }

    const { password: _ignorePassword, ...safeBody } = req.body || {};
    const updatedUser = {
      ...(store.users[idx] || {}),
      ...safeBody,
      id,
      role: normalizeRole(safeBody.role || (store.users[idx] || {}).role || 'FRONT_DESK') as User['role'],
      // Never overwrite password via generic update — use reset-password endpoint
      password: (store.users[idx] || {}).password,
    };
    if (idx !== -1) store.users[idx] = updatedUser;

    await writeThroughPg('UPDATE_USER', async () => {
      await pgPool.query(
        `UPDATE users SET
           email = $1,
           name = $2,
           role = $3,
           branch_id = $4,
           allowed_branch_ids = $5,
           can_switch_user = $6
         WHERE id = $7`,
        [
          updatedUser.email,
          updatedUser.name,
          updatedUser.role,
          updatedUser.branchId || null,
          updatedUser.allowedBranchIds || null,
          !!updatedUser.canSwitchUser,
          id,
        ]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_USER', 'AUTH', `Updated user account ${updatedUser.name} (${updatedUser.email})`);
    const { password: _, ...userWithoutPass } = updatedUser;
    res.json(userWithoutPass);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating user:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/users/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const idx = store.users.findIndex((u) => u.id === id);
    let deletedEmail = '';
    let deletedName = '';

    if (idx !== -1) {
      deletedEmail = store.users[idx].email;
      deletedName = store.users[idx].name;
      store.users.splice(idx, 1);
    }

    await writeThroughPg('DELETE_USER', async () => {
      const r = await pgPool.query('DELETE FROM users WHERE id = $1 RETURNING email, name', [id]);
      if (r.rows.length > 0) {
        deletedEmail = r.rows[0].email;
        deletedName = r.rows[0].name;
      }
    });

    commitLocalMirror();
    logAuditEvent(req, 'DELETE_USER', 'AUTH', `Deleted user account ${deletedName || id} (${deletedEmail || id})`);
    res.json({ success: true });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting user:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/users/:id/reset-password', requireRole('SUPER_ADMIN'), async (req, res) => {
  const __writeSnap = snapshotStore(['uomList', 'locationRecords', 'branches', 'suppliers', 'users']);
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    const userIdx = store.users.findIndex((u) => u.id === id);

    const strength = validatePasswordStrength(newPassword || '');
    if (!strength.ok) {
      return res.status(400).json({ message: strength.message || `New password must be at least ${MIN_PASSWORD_LENGTH} characters long.` });
    }

    const hashed = await hashPassword(newPassword.trim());

    if (userIdx !== -1) {
      store.users[userIdx].password = hashed;
    }

    let targetEmail = store.users[userIdx]?.email || id;
    let targetName = store.users[userIdx]?.name || id;

    await writeThroughPg('RESET_USER_PASSWORD', async () => {
      const r = await pgPool.query('UPDATE users SET password = $1 WHERE id = $2 RETURNING email, name', [hashed, id]);
      if (r.rows.length > 0) {
        targetEmail = r.rows[0].email;
        targetName = r.rows[0].name;
      }
    });

    await destroyUserSessions(id);
    commitLocalMirror();
    logAuditEvent(req, 'RESET_USER_PASSWORD', 'AUTH', `Password reset for user account ${targetName} (${targetEmail})`);

    const userWithoutPass = userIdx !== -1 ? sanitizeUser(store.users[userIdx]) : { id, email: targetEmail, name: targetName };
    res.json({
      success: true,
      message: `Password for ${targetName} (${targetEmail}) has been successfully updated.`,
      user: userWithoutPass,
    });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error resetting user password:', err);
    return sendWriteFailure(res, err);
  }
});

// Products

export default router;
