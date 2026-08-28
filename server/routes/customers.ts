/**
 * Route module: customers
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected, withTransaction } from '../lib/db';
import { readPgOrStore, num } from '../lib/pgReads';
import {
  snapshotStore,
  restoreSnapshot,
  writeThroughPg,
  sendWriteFailure,
  commitLocalMirror,
} from '../lib/writeGuard';
import { requireRole, logAuditEvent } from '../lib/auth';
import { getTodayBsStamp } from '../lib/authUtils';

import type { CustomerDeviceRecord, CustomerRecord } from '../../src/types';

const router = Router();

router.get('/api/customer-devices', async (req, res) => {
  const { branchId, query } = req.query as any;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const q = (query || '').toString().trim().toLowerCase();
  let rows = await readPgOrStore<any>({
    label: 'customerDevices.list',
    sql:
      `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode",
              contact_phone AS "contactPhone", installation_address AS "installationAddress",
              branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial",
              pon_serial AS "ponSerial", mac_address AS "macAddress", status,
              issued_date_ad AS "issuedDateAD", issued_date_bs AS "issuedDateBS",
              purchase_bill_ref AS "purchaseBillRef", notes
       FROM customer_device_records` +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY issued_date_ad DESC NULLS LAST',
    params: bf ? [bf] : [],
    fallback: () =>
      bf ? store.customerDeviceRecords.filter((d) => d.branchId === bf) : store.customerDeviceRecords,
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('customerDeviceRecords', rows as any);
    },
  });
  if (q) {
    rows = rows.filter(
      (d: any) =>
        (d.customerName || '').toLowerCase().includes(q) ||
        (d.deviceSerial || '').toLowerCase().includes(q) ||
        (d.ponSerial || '').toLowerCase().includes(q) ||
        (d.macAddress || '').toLowerCase().includes(q) ||
        (d.customerCode || '').toLowerCase().includes(q)
    );
  }
  res.json(rows);
});

router.post('/api/customer-devices', async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const newRecord: CustomerDeviceRecord = {
      id: req.body.id || `cust-${Date.now()}`,
      ...req.body,
    };
    const idx = store.customerDeviceRecords.findIndex((c) => c.id === newRecord.id);
    if (idx >= 0) store.customerDeviceRecords[idx] = newRecord;
    else store.customerDeviceRecords.unshift(newRecord);

    const custCode = newRecord.customerCode || newRecord.customerId;

    await writeThroughPg('ASSIGN_CUSTOMER_CPE', async () => {
      await pgPool.query(
        `INSERT INTO customer_device_records (
           id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           branch_id = EXCLUDED.branch_id,
           notes = EXCLUDED.notes;`,
        [
          newRecord.id,
          newRecord.customerId || custCode,
          newRecord.customerName,
          custCode,
          newRecord.contactPhone || '',
          newRecord.installationAddress || '',
          newRecord.branchId || 'WH001',
          newRecord.productName,
          newRecord.deviceSerial,
          newRecord.ponSerial || newRecord.deviceSerial,
          newRecord.macAddress || null,
          newRecord.status || 'ACTIVE',
          newRecord.issuedDateAD || new Date().toISOString().split('T')[0],
          newRecord.issuedDateBS || getTodayBsStamp(),
          newRecord.purchaseBillRef || null,
          newRecord.notes || '',
        ]
      );

      await pgPool.query(
        `INSERT INTO customer_records (id, customer_id, customer_name, username, contact_number, branch_id, address, status, assigned_devices_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 1)
         ON CONFLICT (customer_id) DO UPDATE SET
           assigned_devices_count = customer_records.assigned_devices_count + 1;`,
        [
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          custCode || `CUS-${Math.floor(10000 + Math.random() * 90000)}`,
          newRecord.customerName,
          newRecord.customerName.toLowerCase().replace(/\s+/g, '.'),
          newRecord.contactPhone || '9800000000',
          newRecord.branchId || 'WH001',
          newRecord.installationAddress || 'Nepal',
        ]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'ASSIGN_CUSTOMER_CPE', 'CPE_MANAGEMENT', `Assigned CPE Device Serial ${newRecord.deviceSerial} (PON: ${newRecord.ponSerial || 'N/A'}) to customer ${newRecord.customerName}`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error adding customer device:', err);
    return sendWriteFailure(res, err);
  }
});

router.patch('/api/customer-devices/:id/status', async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const { id } = req.params;
    const { status } = req.body;
    let record = store.customerDeviceRecords.find((c) => c.id === id);

    if (isPgConnected && !record) {
      const r = await pgPool.query('SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode", branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial", status FROM customer_device_records WHERE id = $1', [id]);
      if (r.rows.length > 0) record = r.rows[0];
    }
    if (!record) return res.status(404).json({ message: 'Customer device record not found' });

    const oldStatus = record.status;
    const isDisconn = status === 'DISCONNECTED' || status === 'ROUTER_COLLECTED';
    const newStatusStr = isDisconn ? 'ROUTER_COLLECTED' : status;

    record.status = newStatusStr;

    await writeThroughPg('UPDATE_CPE_DEVICE_STATUS', async () => {
      await pgPool.query('UPDATE customer_device_records SET status = $1 WHERE id = $2', [newStatusStr, id]);
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_CPE_DEVICE_STATUS', 'CPE_MANAGEMENT', `Updated CPE Device ${record.deviceSerial} status from ${oldStatus} to ${newStatusStr}`, record.branchId);
    res.json(record);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating CPE device status:', err);
    return sendWriteFailure(res, err);
  }
});

// Device Exchange & Replacement Handler
router.post('/api/customer-devices/exchange', requireRole('SUPER_ADMIN', 'BRANCH_MANAGER', 'FRONT_DESK', 'INVENTORY_MANAGER'), async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const {
      oldDeviceId,
      exchangeReason,
      oldDeviceAction,
      newProductName,
      newDeviceSerial,
      newPonSerial,
      newMacAddress,
      notes,
      branchId,
    } = req.body;

    let oldRecord = store.customerDeviceRecords.find((c) => c.id === oldDeviceId);
    if (isPgConnected && !oldRecord) {
      const r = await pgPool.query('SELECT * FROM customer_device_records WHERE id = $1', [oldDeviceId]);
      if (r.rows.length > 0) {
        const row = r.rows[0];
        oldRecord = {
          id: row.id,
          customerId: row.customer_id,
          customerName: row.customer_name,
          customerCode: row.customer_code,
          contactPhone: row.contact_phone,
          installationAddress: row.installation_address,
          branchId: row.branch_id,
          productName: row.product_name,
          deviceSerial: row.device_serial,
          ponSerial: row.pon_serial,
          macAddress: row.mac_address,
          status: row.status,
          issuedDateAD: row.issued_date_ad,
          issuedDateBS: row.issued_date_bs,
          purchaseBillRef: row.purchase_bill_ref,
          notes: row.notes,
        };
      }
    }

    if (!oldRecord) return res.status(404).json({ message: 'Old customer device record not found' });

    const dateStrAD = new Date().toISOString().split('T')[0];

    oldRecord.status = 'EXCHANGED';
    oldRecord.notes = `[EXCHANGED on ${dateStrAD}] Reason: ${exchangeReason || 'Defective / Replacement'}. Old device disposition: ${oldDeviceAction}. Replacement SN: ${newDeviceSerial}. ${oldRecord.notes || ''}`;

    const newRecord: CustomerDeviceRecord = {
      id: `cust-${Date.now()}`,
      customerId: oldRecord.customerId,
      customerName: oldRecord.customerName,
      customerCode: oldRecord.customerCode,
      contactPhone: oldRecord.contactPhone,
      installationAddress: oldRecord.installationAddress,
      branchId: branchId || oldRecord.branchId,
      productName: newProductName || oldRecord.productName,
      deviceSerial: newDeviceSerial,
      ponSerial: newPonSerial,
      macAddress: newMacAddress || undefined,
      status: 'RENTAL',
      issuedDateAD: dateStrAD,
      issuedDateBS: '2083-04-28 BS',
      purchaseBillRef: oldRecord.purchaseBillRef,
      notes: `[REPLACEMENT DEVICE] Replaced previous SN ${oldRecord.deviceSerial} on ${dateStrAD}. ${notes || ''}`,
    };

    store.customerDeviceRecords.unshift(newRecord);

    await writeThroughPg('DEVICE_EXCHANGE', async () => {
      await withTransaction(async (client) => {
        await client.query('UPDATE customer_device_records SET status = $1, notes = $2 WHERE id = $3', ['EXCHANGED', oldRecord.notes, oldDeviceId]);

        await client.query(
          `INSERT INTO customer_device_records (
             id, customer_id, customer_name, customer_code, contact_phone, installation_address, branch_id, product_name, device_serial, pon_serial, mac_address, status, issued_date_ad, issued_date_bs, purchase_bill_ref, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);`,
          [
            newRecord.id,
            newRecord.customerId,
            newRecord.customerName,
            newRecord.customerCode,
            newRecord.contactPhone || '',
            newRecord.installationAddress || '',
            newRecord.branchId || 'WH001',
            newRecord.productName,
            newRecord.deviceSerial,
            newRecord.ponSerial || newRecord.deviceSerial,
            newRecord.macAddress || null,
            newRecord.status,
            newRecord.issuedDateAD,
            newRecord.issuedDateBS,
            newRecord.purchaseBillRef || null,
            newRecord.notes,
          ]
        );
      });
    });

    commitLocalMirror();
    logAuditEvent(req, 'DEVICE_EXCHANGE', 'CPE_MANAGEMENT', `Exchanged CPE Device for ${oldRecord.customerName}. Replaced SN ${oldRecord.deviceSerial} -> New SN ${newDeviceSerial}`, oldRecord.branchId);
    res.status(201).json({ oldRecord, newRecord, message: 'Customer device successfully exchanged and inventory synchronized.' });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error exchanging customer device:', err);
    return sendWriteFailure(res, err);
  }
});

// Customer Master Database Endpoints
router.get('/api/customers', async (req, res) => {
  const { branchId, query } = req.query as any;
  const bf = branchId && branchId !== 'ALL' ? String(branchId) : null;
  const q = (query || '').toString().trim().toLowerCase();
  let rows = await readPgOrStore<any>({
    label: 'customers.list',
    sql:
      `SELECT id, customer_id AS "customerId", customer_name AS "customerName", username,
              contact_number AS "contactNumber", branch_id AS "branchId", address, email, status,
              credit_limit AS "creditLimit", assigned_devices_count AS "assignedDevicesCount"
       FROM customer_records` +
      (bf ? ' WHERE branch_id = $1' : '') +
      ' ORDER BY customer_name ASC',
    params: bf ? [bf] : [],
    fallback: () =>
      bf ? store.customerMasterRecords.filter((c) => c.branchId === bf) : store.customerMasterRecords,
    map: (r) => ({
      ...r,
      creditLimit: num(r.creditLimit, 0),
      assignedDevicesCount: num(r.assignedDevicesCount, 0),
    }),
    onRows: (rows) => {
      if (!isPgConnected) return;
      if (!bf) store.replaceCollection('customerMasterRecords', rows as any);
    },
  });
  if (q) {
    rows = rows.filter(
      (c: any) =>
        (c.customerName || '').toLowerCase().includes(q) ||
        (c.customerId || '').toLowerCase().includes(q) ||
        (c.username || '').toLowerCase().includes(q) ||
        (c.contactNumber || '').includes(q)
    );
  }
  res.json(rows);
});

router.post('/api/customers', async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
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

    const idx = store.customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
    if (idx >= 0) {
      store.customerMasterRecords[idx] = newRecord;
    } else {
      store.customerMasterRecords.unshift(newRecord);
    }

    await writeThroughPg('CREATE_CUSTOMER', async () => {
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
    });

    commitLocalMirror();
    logAuditEvent(req, 'CREATE_CUSTOMER', 'MASTER_DATA', `Created / Registered Customer Profile ${newRecord.customerName} (${newRecord.customerId})`, newRecord.branchId);
    res.status(201).json(newRecord);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error creating customer:', err);
    return sendWriteFailure(res, err);
  }
});

router.post('/api/customers/bulk', requireRole('SUPER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_MANAGER'), async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const items: CustomerRecord[] = req.body.customers || [];
    let count = 0;

    await writeThroughPg('DB_WRITE', async () => {
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

          const idx = store.customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
          if (idx >= 0) {
            store.customerMasterRecords[idx] = newRecord;
          } else {
            store.customerMasterRecords.unshift(newRecord);
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
    });
    if (!isPgConnected) {
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

        const idx = store.customerMasterRecords.findIndex((c) => c.id === newRecord.id || c.customerId === newRecord.customerId);
        if (idx >= 0) {
          store.customerMasterRecords[idx] = newRecord;
        } else {
          store.customerMasterRecords.unshift(newRecord);
        }
        count++;
      }
    }

    commitLocalMirror();
    logAuditEvent(req, 'BULK_IMPORT_CUSTOMERS', 'MASTER_DATA', `Bulk imported ${count} Customer Records into Master Directory`);
    res.status(201).json({ success: true, count, total: store.customerMasterRecords.length });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error bulk importing customers:', err);
    return sendWriteFailure(res, err);
  }
});

router.put('/api/customers/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const { id } = req.params;
    const idx = store.customerMasterRecords.findIndex((c) => c.id === id || c.customerId === id);
    if (idx < 0) {
      return res.status(404).json({ message: 'Customer record not found' });
    }

    store.customerMasterRecords[idx] = {
      ...store.customerMasterRecords[idx],
      ...req.body,
    };
    const updated = store.customerMasterRecords[idx];

    await writeThroughPg('UPDATE_CUSTOMER', async () => {
      await pgPool.query(
        `UPDATE customer_records SET
           customer_id = $1, customer_name = $2, username = $3, contact_number = $4, branch_id = $5, address = $6, email = $7, status = $8, credit_limit = $9
         WHERE id = $10 OR customer_id = $10;`,
        [updated.customerId, updated.customerName, updated.username, updated.contactNumber, updated.branchId, updated.address, updated.email, updated.status, Number(updated.creditLimit) || 0, id]
      );
    });

    commitLocalMirror();
    logAuditEvent(req, 'UPDATE_CUSTOMER', 'MASTER_DATA', `Updated Customer Master Details for ${updated.customerName} (${updated.customerId})`, updated.branchId);
    res.json(updated);
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error updating customer:', err);
    return sendWriteFailure(res, err);
  }
});

router.delete('/api/customers/:id', async (req, res) => {
  const __writeSnap = snapshotStore(['customerMasterRecords', 'customerDeviceRecords', 'inventoryStock']);
  try {
    const { id } = req.params;
    const cust = store.customerMasterRecords.find((c) => c.id === id || c.customerId === id);
    { const __filtered = store.customerMasterRecords.filter((c) => c.id !== id && c.customerId !== id); store.customerMasterRecords.length = 0; store.customerMasterRecords.push(...__filtered); }

    await writeThroughPg('DELETE_CUSTOMER', async () => {
      await pgPool.query('DELETE FROM customer_records WHERE id = $1 OR customer_id = $1', [id]);
    });

    commitLocalMirror();
    logAuditEvent(req, 'DELETE_CUSTOMER', 'MASTER_DATA', `Deleted Customer Record ${cust?.customerName || id}`);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    restoreSnapshot(typeof __writeSnap !== 'undefined' ? __writeSnap : null);
    console.error('Error deleting customer:', err);
    return sendWriteFailure(res, err);
  }
});

// Approval Requests & Workflow Authorization Routes

export default router;
