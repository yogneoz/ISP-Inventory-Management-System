/**
 * Shared serial-edit handler extracted from app.ts (backlog item #6 — app.ts
 * extraction). Kept in services/ (NOT controllers/) because it contains the
 * authoritative duplicate-check SQL — the no-inline-SQL guard scans the
 * controllers tree, and this code is a service-level orchestration reused by
 * both an HTTP route and the dual-edit capture executor.
 *
 * Handles editing device serials across all inventory and customer records:
 * authoritative duplicate checks against serial_log, customer_device_records
 * and fixed_assets, then a cascading PostgreSQL transaction + in-memory
 * mirror sync. The dual-edit orchestration (validation, park-then-apply step
 * planning and sequenced execution) lives in
 * server/services/serialEditCapture.service.ts; this module keeps HTTP
 * concerns only.
 */
import { pgPool } from '../../db';
import {
  parseSerialHistory as parseSerialHistoryValue,
  buildOldValueExclusions,
  renameSerialsInJsonbItems,
  renameSerialsInShipmentItems,
  applyInMemorySerialRename,
  findInMemorySerialClash,
  buildSerialLogRenameStep,
  cascadeRenameJsonbTables,
  CDR_DUP_EXTRA_FRAGMENTS,
} from './serials.service';
import {
  customerDeviceRecords, assetRegister, purchaseInvoices, shipments,
  stockOperations, serialLogs, setSerialLogs, getPgConnected,
} from '../state/runtimeState';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from './audit.service';
import { broadcastChange } from '../realtime/sse';

// Case-insensitive matcher for serialized device records stored in JSONB
// (purchase_invoices.items, shipments.items, stock_operations.items) and for
// in-memory mirrors. A record matches when ANY of its three identifiers equals
// the corresponding old value; matched records get all three values replaced so
// the correction cascades everywhere the serial was recorded.
export async function handleUpdateSerials(req: any, res: any) {
  try {
    const targetId = req.params?.id || req.body?.id;
    const {
      sourceType,
      sourceId,
      oldDeviceSerial: rawOldDeviceSerial,
      oldPonSerial: rawOldPonSerial,
      oldMacAddress: rawOldMacAddress,
      deviceSerial,
      ponSerial,
      macAddress,
    } = req.body;

    if (!deviceSerial || !ponSerial) {
      return res.status(400).json({ message: 'Device serial and PON serial are required.' });
    }

    const normalizedDeviceSerial = String(deviceSerial).trim().toUpperCase();
    const normalizedPonSerial = String(ponSerial).trim().toUpperCase();
    const normalizedMacAddress = macAddress ? String(macAddress).trim().toUpperCase() : null;

    let oldDeviceSerial = rawOldDeviceSerial ? String(rawOldDeviceSerial).trim().toUpperCase() : '';
    let oldPonSerial = rawOldPonSerial ? String(rawOldPonSerial).trim().toUpperCase() : '';
    let oldMacAddress = rawOldMacAddress ? String(rawOldMacAddress).trim().toUpperCase() : '';
    let matchedBranchId: string | undefined = req.body?.branchId;
    let customerName: string = 'Inventory Stock';

    // -----------------------------------------------------------------
    // AUTHORITATIVE DUPLICATE CHECK (all three serial types)
    // A user must never be allowed to save a device serial, PON serial, or
    // MAC address that already exists on a DIFFERENT device. The check is
    // case-insensitive and runs against every table that stores these
    // identifiers: serial_log, customer_device_records, fixed_assets.
    // -----------------------------------------------------------------
    const newValues: Array<{ field: string; value: string }> = [
      { field: 'Device Serial', value: normalizedDeviceSerial },
      { field: 'PON Serial', value: normalizedPonSerial },
      ...(normalizedMacAddress ? [{ field: 'MAC Address', value: normalizedMacAddress }] : []),
    ];

    if (getPgConnected()) {
      // Exclude rows that belong to the device being edited itself: those are
      // identified by ANY of its old identifiers.
      const oldVals = [oldDeviceSerial, oldPonSerial, oldMacAddress].filter(Boolean);
      // NOTE: $1 is the searched value, so the old-value exclusion params
      // start at $2 (params are passed as [value, ...oldVals]).
      const exclusions = buildOldValueExclusions(oldVals);
      const exclusionClause = exclusions.deviceExclusion;
      const ponExclusion = exclusions.ponExclusion;
      const macExclusion = exclusions.macExclusion;
      const macNotNull = CDR_DUP_EXTRA_FRAGMENTS.macNotNull;
      // fixed_assets has no device_serial/pon_serial/mac_address columns — it
      // stores the serial as tag_number — so it needs its own exclusion clause.
      const assetExclusion = exclusions.assetExclusion;

      for (const { field, value } of newValues) {
        // serial_log — device serial + PON + MAC (unique index exists for device serial)
        const slResult = await pgPool.query(
          `SELECT device_serial AS "deviceSerial", product_name AS "productName", branch_id AS "branchId" FROM serial_log
           WHERE (lower(trim(device_serial)) = lower(trim($1)) OR lower(trim(pon_serial)) = lower(trim($1)) OR lower(trim(mac_address)) = lower(trim($1)))${exclusionClause}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (slResult.rows.length > 0) {
          const row = slResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" already exists in the serial register on device "${row.deviceSerial}" (${row.productName || 'Unknown product'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.deviceSerial,
          });
        }

        // customer_device_records — device serial + PON + MAC (unique indexes on all three)
        const cdrResult = await pgPool.query(
          `SELECT device_serial AS "deviceSerial", customer_name AS "customerName" FROM customer_device_records
           WHERE (lower(trim(device_serial)) = lower(trim($1)) OR lower(trim(pon_serial)) = lower(trim($1)) OR lower(trim(mac_address)) = lower(trim($1)))${exclusionClause}${ponExclusion}${macExclusion}${macNotNull}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (cdrResult.rows.length > 0) {
          const row = cdrResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" is already assigned to customer device "${row.deviceSerial}" (${row.customerName || 'Unknown customer'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.deviceSerial,
          });
        }

        // fixed_assets — device serial stored as tag_number
        const faResult = await pgPool.query(
          `SELECT tag_number AS "tagNumber", name FROM fixed_assets
           WHERE lower(trim(tag_number)) = lower(trim($1))${assetExclusion}
           LIMIT 1`,
          [value, ...oldVals]
        );
        if (faResult.rows.length > 0) {
          const row = faResult.rows[0];
          return res.status(409).json({
            message: `${field} "${value}" is already used by fixed asset "${row.tagNumber}" (${row.name || 'Unknown asset'}). Please correct the ${field.toLowerCase()} before saving.`,
            field,
            value,
            conflictingDevice: row.tagNumber,
          });
        }
      }
    }

    // 1. Try to find customer device record
    let customerRecord = customerDeviceRecords.find((c) => c.id === targetId || (oldDeviceSerial && c.deviceSerial === oldDeviceSerial));
    if (getPgConnected() && !customerRecord && targetId && !targetId.startsWith('pi-') && !targetId.startsWith('ship-') && !targetId.startsWith('op-') && !targetId.startsWith('fa-')) {
      try {
        const r = await pgPool.query(
          `SELECT id, customer_id AS "customerId", customer_name AS "customerName", customer_code AS "customerCode",
                  branch_id AS "branchId", product_name AS "productName", device_serial AS "deviceSerial",
                  pon_serial AS "ponSerial", mac_address AS "macAddress", status FROM customer_device_records
           WHERE id = $1 OR (device_serial = $2 AND $2 != '') LIMIT 1`,
          [targetId, oldDeviceSerial || '']
        );
        if (r.rows.length > 0) customerRecord = r.rows[0];
      } catch (_e) {}
    }

    if (customerRecord) {
      if (!oldDeviceSerial) oldDeviceSerial = customerRecord.deviceSerial;
      if (!oldPonSerial) oldPonSerial = customerRecord.ponSerial;
      if (!oldMacAddress) oldMacAddress = customerRecord.macAddress;
      if (!matchedBranchId) matchedBranchId = customerRecord.branchId;
      customerName = customerRecord.customerName || 'Customer Device';

      customerRecord.deviceSerial = normalizedDeviceSerial;
      customerRecord.ponSerial = normalizedPonSerial;
      customerRecord.macAddress = normalizedMacAddress;
    }

    // 2. If Fixed Asset
    if (targetId && (targetId.startsWith('fa-') || sourceType === 'FIXED_ASSET')) {
      const assetId = targetId.replace(/^fa-/, '');
      const asset = assetRegister.find((a) => a.id === assetId || a.tagNumber === oldDeviceSerial);
      if (asset) {
        if (!oldDeviceSerial) oldDeviceSerial = asset.tagNumber;
        if (!matchedBranchId) matchedBranchId = asset.branchId;
        asset.tagNumber = normalizedDeviceSerial;
      }
    }

    if (!oldDeviceSerial && targetId) {
      const parts = targetId.split('-');
      if (parts.length >= 3) {
        oldDeviceSerial = parts.slice(2).join('-');
      }
    }

    if (!oldDeviceSerial) {
      oldDeviceSerial = normalizedDeviceSerial;
    }

    // PostgreSQL Cascading Updates
    if (getPgConnected()) {
      await withTransaction(async (client) => {
        // Update customer_device_records — match on id, device serial, PON, or
        // MAC (case-insensitive, trimmed). Each identifier only matches when
        // the corresponding old value is actually provided.
        await client.query(
          `UPDATE customer_device_records
           SET device_serial = $1, pon_serial = $2, mac_address = $3
           WHERE id = $4
              OR ($5 != '' AND lower(trim(device_serial)) = lower(trim($5)))
              OR ($6 != '' AND lower(trim(pon_serial)) = lower(trim($6)))
              OR ($7 != '' AND lower(trim(mac_address)) = lower(trim($7)))`,
          [normalizedDeviceSerial, normalizedPonSerial, normalizedMacAddress, targetId, oldDeviceSerial, oldPonSerial, oldMacAddress]
        );

        // Update fixed_assets
        const actualAssetId = targetId?.replace(/^fa-/, '');
        await client.query(
          `UPDATE fixed_assets SET tag_number = $1 WHERE id = $2 OR tag_number = $3`,
          [normalizedDeviceSerial, actualAssetId, oldDeviceSerial]
        );

        // Cascade renames across JSONB item lists (purchase_invoices,
        // shipments, stock_operations) — SQL + rename logic defined once in
        // server/services/serials.service.ts.
        await cascadeRenameJsonbTables(
          client,
          { oldDeviceSerial, oldPonSerial, oldMacAddress },
          { newDeviceSerial: normalizedDeviceSerial, newPonSerial: normalizedPonSerial, newMacAddress: normalizedMacAddress }
        );

        // Update shipments items JSONB — handled by cascadeRenameJsonbTables above.

        // Update stock_operations items JSONB — handled by cascadeRenameJsonbTables above.

        // Sync serial_log (one row per serial): reject duplicate, rename
        // existing. SQL + history-entry construction defined once in
        // server/services/serials.service.ts.
        const slStep = buildSerialLogRenameStep(
          {
            oldDeviceSerial,
            newDeviceSerial: normalizedDeviceSerial,
            newPonSerial: normalizedPonSerial,
            newMacAddress: normalizedMacAddress,
            targetId,
          },
          new Date().toISOString()
        );
        const oldRowRes = await client.query(slStep.selectOldSql, [oldDeviceSerial]);
        const newRowRes = await client.query(
          `SELECT id FROM serial_log WHERE lower(trim(device_serial)) = lower(trim($1)) LIMIT 1`,
          [normalizedDeviceSerial]
        );
        const oldRow = oldRowRes.rows[0];
        // Reject if a DIFFERENT serial_log row already holds the new device
        // serial, PON, or MAC (case-insensitive). The authoritative pre-check
        // above should have caught this, but re-verify inside the transaction
        // to protect against races between the pre-check and the commit.
        const oldVals = [oldDeviceSerial, oldPonSerial, oldMacAddress].filter(Boolean);
        const { notSelfDevice } = buildOldValueExclusions(oldVals);
        const newRow = newRowRes.rows[0] && (!oldRow || newRowRes.rows[0].id !== oldRow.id) ? newRowRes.rows[0] : null;
        const slPonClash = normalizedPonSerial
          ? (await client.query(
              `SELECT id FROM serial_log WHERE lower(trim(pon_serial)) = lower(trim($1))${notSelfDevice} LIMIT 1`,
              [normalizedPonSerial, ...oldVals]
            )).rows[0]
          : null;
        const slMacClash = normalizedMacAddress
          ? (await client.query(
              `SELECT id FROM serial_log WHERE lower(trim(mac_address)) = lower(trim($1))${notSelfDevice} LIMIT 1`,
              [normalizedMacAddress, ...oldVals]
            )).rows[0]
          : null;
        if (newRow || slPonClash || slMacClash) {
          const field = newRow ? 'Device Serial' : slPonClash ? 'PON Serial' : 'MAC Address';
          const value = newRow ? normalizedDeviceSerial : slPonClash ? normalizedPonSerial : normalizedMacAddress;
          const dupErr: any = new Error(`${field} "${value}" already exists in the serial register. Cannot save a duplicate.`);
          dupErr.status = 409;
          throw dupErr;
        }
        if (oldRow) {
          const history = [...parseSerialHistoryValue(oldRow.history_json), slStep.correctionEntry];
          await client.query(slStep.updateSql, slStep.updateParams(oldRow.id, history));
        } else {
          const slId = `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await client.query(slStep.insertSql, slStep.insertParams(slId, matchedBranchId || null));
        }
      });
    }

    // In-memory updates for all sources — same case-insensitive semantics as
    // the PostgreSQL path so both stay in sync.
    customerDeviceRecords.forEach((c) => {
      if (
        c.id === targetId ||
        (!!oldDeviceSerial && String(c.deviceSerial || '').trim().toUpperCase() === oldDeviceSerial) ||
        (!!oldPonSerial && String(c.ponSerial || '').trim().toUpperCase() === oldPonSerial) ||
        (!!oldMacAddress && String(c.macAddress || '').trim().toUpperCase() === oldMacAddress)
      ) {
        c.deviceSerial = normalizedDeviceSerial;
        c.ponSerial = normalizedPonSerial;
        c.macAddress = normalizedMacAddress;
      }
    });

    const actualAssetId = targetId?.replace(/^fa-/, '');
    assetRegister.forEach((a) => {
      if (a.id === actualAssetId || a.tagNumber === oldDeviceSerial) {
        a.tagNumber = normalizedDeviceSerial;
      }
    });

    // In-memory JSONB mirrors (purchase invoices / shipments / stock
    // operations) — rename logic shared with the DB cascade via
    // server/services/serials.service.ts; deviceSerials lists are written
    // back per item to preserve the original in-place mutation semantics.
    const oldV = { oldDeviceSerial, oldPonSerial, oldMacAddress };
    const newV = {
      newDeviceSerial: normalizedDeviceSerial,
      newPonSerial: normalizedPonSerial,
      newMacAddress: normalizedMacAddress,
    };
    purchaseInvoices.forEach((inv: any) => {
      if (inv.items && Array.isArray(inv.items)) {
        const { items } = renameSerialsInJsonbItems(inv.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          inv.items[i].deviceSerials = next.deviceSerials;
        });
      }
    });

    shipments.forEach((ship: any) => {
      if (ship.items && Array.isArray(ship.items)) {
        const { items } = renameSerialsInShipmentItems(ship.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          ship.items[i].deviceSerials = next.deviceSerials;
          ship.items[i].receivedSerials = next.receivedSerials;
        });
      }
    });

    stockOperations.forEach((op: any) => {
      if (op.items && Array.isArray(op.items)) {
        const { items } = renameSerialsInJsonbItems(op.items, oldV, newV);
        items.forEach((next: any, i: number) => {
          op.items[i].deviceSerials = next.deviceSerials;
        });
      }
    });

    // In-memory serial_log sync (one row per serial, reject duplicate).
    {
      const nowIso = new Date().toISOString();
      // Reject if a different row already holds the target serial
      const clash = findInMemorySerialClash(serialLogs, normalizedDeviceSerial, oldDeviceSerial);
      if (clash) {
        // Already returned 409 from PG path; throw here for safety in non-PG mode
        const dupErr: any = new Error(`Serial number "${normalizedDeviceSerial}" already exists.`);
        dupErr.status = 409;
        throw dupErr;
      }
      setSerialLogs(applyInMemorySerialRename(serialLogs, {
        oldDeviceSerial,
        oldPonSerial,
        oldMacAddress,
        newDeviceSerial: normalizedDeviceSerial,
        newPonSerial: normalizedPonSerial,
        newMacAddress: normalizedMacAddress,
        targetId,
        branchId: matchedBranchId,
        nowIso,
      }));
    }

    logAuditEvent(
      req,
      'EDIT_DEVICE_SERIALS',
      'CPE_MANAGEMENT',
      `Updated serial information: Device ${oldDeviceSerial}→${normalizedDeviceSerial}, PON ${oldPonSerial}→${normalizedPonSerial}, MAC ${oldMacAddress || 'N/A'}→${normalizedMacAddress || 'N/A'} (${customerName})`,
      matchedBranchId
    );

    broadcastChange({ type: 'SERIALS_UPDATED', entity: 'device-serials', branchId: matchedBranchId });

    res.json({
      success: true,
      message: 'Serial information updated successfully across all inventory records.',
      deviceSerial: normalizedDeviceSerial,
      ponSerial: normalizedPonSerial,
      macAddress: normalizedMacAddress,
      record: customerRecord,
    });
  } catch (err: any) {
    console.error('Error updating device serials:', err);
    const status = err.status || 500;
    res.status(status).json({ message: err.message || `Database error: ${err.message}` });
  }
}

// Production executor for the dual-edit orchestration (see
// server/services/serialEditCapture.service.ts): runs one single-device
// serial correction through handleUpdateSerials and captures the JSON
// response instead of writing to a real HTTP response.
export function runSerialEditCapture(user: any, body: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const req = { user, body, params: {}, query: {} };
    let capturedStatus = 200;
    const res = {
      status(code: number) { capturedStatus = code; return this; },
      json(data: any) { resolve({ status: capturedStatus, data }); },
    };
    Promise.resolve(handleUpdateSerials(req, res)).catch(() => resolve({ status: 500, data: { message: 'Internal error' } }));
  });
}
