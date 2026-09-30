/**
 * Unit tests for the unassign-restock service (extracted from
 * inventory.controller patch_status). Covers the three invariants that protect
 * branch stock integrity:
 *  1. The restock fires ONLY when a STOCK_OUT ledger row proves the deploy
 *     deducted branch stock — non-stock ledger assets and plain status changes
 *     must never restore inventory.
 *  2. The restock is idempotent — a repeat unassign call (restock row already
 *     present) must not double-restore.
 *  3. The in-memory serial mirror flips the deployed serial back to IN_STOCK.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRestockOnUnassign,
  buildRestockTransaction,
  restoreInMemorySerial,
  cpeFindPatterns,
  buildCpeReversalClose,
} from '../server/src/services/unassignRestock.service';

const ASSET = {
  id: 'ast-1',
  tagNumber: 'FA-CAR004-1234',
  name: 'OLT CARD GPON 16-PORT Chassis Module',
  productId: 'prod-car004',
  branchId: 'WH001',
  acquisitionCost: 125000,
  deviceSerial: 'SN-CAR004-0002',
};

const deployLedger = (tag: string, productId: string) => ({
  referenceDocId: tag,
  productId,
  changeType: 'STOCK_OUT',
});
const restockLedger = (tag: string, productId: string) => ({
  referenceDocId: tag,
  productId,
  changeType: 'MANUAL_ADJUSTMENT',
});

describe('shouldRestockOnUnassign', () => {
  const base = { newStatus: 'ACTIVE', prevStatus: 'ASSIGNED_TO_LOCATION', asset: ASSET };

  it('fires when an unassigned deploy-from-stock asset has a STOCK_OUT ledger row', () => {
    assert.equal(
      shouldRestockOnUnassign({ ...base, transactionLogs: [deployLedger(ASSET.tagNumber, ASSET.productId)] }),
      true
    );
  });

  it('fires for customer-assigned assets too', () => {
    assert.equal(
      shouldRestockOnUnassign({
        ...base,
        prevStatus: 'ASSIGNED_TO_CUSTOMER',
        transactionLogs: [deployLedger(ASSET.tagNumber, ASSET.productId)],
      }),
      true
    );
  });

  it('does NOT fire when no STOCK_OUT ledger row exists (non-stock ledger asset)', () => {
    assert.equal(shouldRestockOnUnassign({ ...base, transactionLogs: [] }), false);
  });

  it('does NOT fire when the deploy row is for a different product', () => {
    assert.equal(
      shouldRestockOnUnassign({ ...base, transactionLogs: [deployLedger(ASSET.tagNumber, 'prod-other')] }),
      false
    );
  });

  it('does NOT fire when the deploy row is for a different asset tag', () => {
    assert.equal(
      shouldRestockOnUnassign({ ...base, transactionLogs: [deployLedger('FA-OTHER-9999', ASSET.productId)] }),
      false
    );
  });

  it('does NOT double-restock when a restock row already exists (repeat unassign)', () => {
    assert.equal(
      shouldRestockOnUnassign({
        ...base,
        transactionLogs: [
          deployLedger(ASSET.tagNumber, ASSET.productId),
          restockLedger(ASSET.tagNumber, ASSET.productId),
        ],
      }),
      false
    );
  });

  it('does NOT fire when the asset has no productId (manually registered asset)', () => {
    assert.equal(
      shouldRestockOnUnassign({
        ...base,
        asset: { ...ASSET, productId: null },
        transactionLogs: [deployLedger(ASSET.tagNumber, ASSET.productId)],
      }),
      false
    );
  });

  it('does NOT fire when the asset is undefined', () => {
    assert.equal(
      shouldRestockOnUnassign({ newStatus: 'ACTIVE', prevStatus: 'ASSIGNED_TO_LOCATION', asset: undefined, transactionLogs: [] }),
      false
    );
  });

  it('does NOT fire when the new status is not ACTIVE (e.g. re-assign or dispose)', () => {
    for (const status of ['ASSIGNED_TO_CUSTOMER', 'DISPOSED', 'MAINTENANCE', undefined]) {
      assert.equal(
        shouldRestockOnUnassign({
          newStatus: status,
          prevStatus: 'ASSIGNED_TO_LOCATION',
          asset: ASSET,
          transactionLogs: [deployLedger(ASSET.tagNumber, ASSET.productId)],
        }),
        false,
        `status=${status}`
      );
    }
  });

  it('does NOT fire when the previous status was not a deployment (plain ACTIVE asset)', () => {
    for (const prevStatus of ['ACTIVE', 'MAINTENANCE', 'DISPOSED', '']) {
      assert.equal(
        shouldRestockOnUnassign({
          ...base,
          prevStatus,
          transactionLogs: [deployLedger(ASSET.tagNumber, ASSET.productId)],
        }),
        false,
        `prevStatus=${prevStatus}`
      );
    }
  });
});

describe('buildRestockTransaction', () => {
  const products = [
    { id: 'prod-car004', sku: 'CAR004', name: 'OLT CARD GPON 16-PORT Chassis Module', costPrice: 124500 },
  ];

  it('builds a +1 MANUAL_ADJUSTMENT row balanced around the current stock level', () => {
    const txn = buildRestockTransaction({
      asset: ASSET,
      branchId: 'WH001',
      quantityBefore: 2,
      todayAD: '2026-09-30',
      products,
    });
    assert.equal(txn.changeType, 'MANUAL_ADJUSTMENT');
    assert.equal(txn.quantityChanged, 1);
    assert.equal(txn.quantityBefore, 2);
    assert.equal(txn.quantityAfter, 3);
    assert.equal(txn.branchId, 'WH001');
    assert.equal(txn.productId, 'prod-car004');
    assert.equal(txn.referenceDocId, 'FA-CAR004-1234');
    assert.equal(txn.transactionNumber, 'FA-CAR004-1234-RESTOCK');
    assert.equal(txn.timestampAD, '2026-09-30');
  });

  it('falls back to product costPrice when the asset has no acquisition cost', () => {
    const txn = buildRestockTransaction({
      asset: { ...ASSET, acquisitionCost: null },
      branchId: 'WH001',
      quantityBefore: 0,
      todayAD: '2026-09-30',
      products,
    });
    assert.equal(txn.unitCost, 124500);
  });

  it('falls back to the asset name when the product is unknown', () => {
    const txn = buildRestockTransaction({
      asset: ASSET,
      branchId: 'WH001',
      quantityBefore: 5,
      todayAD: '2026-09-30',
      products: [],
    });
    assert.equal(txn.productSku, '');
    assert.equal(txn.productName, ASSET.name);
    assert.equal(txn.quantityAfter, 6);
  });
});

describe('rental CPE record close', () => {
  it('builds both notes-LIKE patterns that can match the deployment\'s CPE record', () => {
    const patterns = cpeFindPatterns('FA-CAR004-5555');
    assert.deepEqual(patterns, [
      '%[FIXED ASSET CPE - Tag: FA-CAR004-5555]%',
      '%[RENTAL CPE ASSET - Tag: FA-CAR004-5555]%',
    ]);
  });

  it('closes the CPE with ROUTER_COLLECTED — the status the live CHECK constraint allows', () => {
    // customer_device_records_status_check allows ACTIVE, SUSPENDED,
    // DISCONNECTED, RETURNED, REFUND, EXCHANGED, RENTAL, ROUTER_COLLECTED,
    // IN_STOCK. 'COLLECTED' is NOT among them and would violate the
    // constraint, rolling back the whole restock transaction.
    const close = buildCpeReversalClose({
      prevNotes: '[RENTAL CPE ASSET - Tag: FA-CAR004-5555] E2E reverse test',
      tag: 'FA-CAR004-5555',
      todayAD: '2026-09-30',
    });
    assert.equal(close.status, 'ROUTER_COLLECTED');
    assert.match(close.notes, /\[REVERSED 2026-09-30\] Deployment of FA-CAR004-5555 reversed\.$/);
  });

  it('preserves the original CPE notes and appends the reversal audit line', () => {
    const prevNotes = '[FIXED ASSET CPE - Tag: FA-XYZ-1] rack 2 install';
    const close = buildCpeReversalClose({ prevNotes, tag: 'FA-XYZ-1', todayAD: '2026-01-15' });
    assert.ok(close.notes.startsWith(prevNotes), 'original notes must be preserved verbatim');
    assert.ok(close.notes.includes('[REVERSED 2026-01-15] Deployment of FA-XYZ-1 reversed.'));
  });

  it('never produces a status outside the customer_device_records_status_check whitelist', () => {
    // Guard against regression: this exact test would have caught the
    // COLLECTED constraint violation before it reached the database.
    const allowed = ['ACTIVE', 'SUSPENDED', 'DISCONNECTED', 'RETURNED', 'REFUND', 'EXCHANGED', 'RENTAL', 'ROUTER_COLLECTED', 'IN_STOCK'];
    const close = buildCpeReversalClose({ prevNotes: 'x', tag: 'FA-1', todayAD: '2026-09-30' });
    assert.ok(allowed.includes(close.status), `${close.status} is not an allowed customer_device_records status`);
  });
});

describe('restoreInMemorySerial', () => {
  // Base register, with optional per-serial overrides merged onto matching rows.
  const makeRegister = (overrides: Partial<{ deviceSerial: string; status: string }>[] = []) => {
    const base: { deviceSerial: string; status: string; updatedAt?: string }[] = [
      { deviceSerial: 'SN-CAR004-0002', status: 'POP_LOCATION_ASSIGNED', updatedAt: undefined },
      { deviceSerial: 'SN-ONU001-0001', status: 'IN_STOCK' },
    ];
    for (const o of overrides) {
      const row = base.find((r) => r.deviceSerial === o.deviceSerial);
      if (row) Object.assign(row, o);
      else base.push({ deviceSerial: o.deviceSerial || 'SN-EXTRA', status: o.status || 'IN_STOCK' });
    }
    return base;
  };

  it('flips the deployed serial back to IN_STOCK (case/trim-insensitive match)', () => {
    const register = makeRegister();
    const ok = restoreInMemorySerial(register, { ...ASSET, deviceSerial: '  sn-car004-0002 ' });
    assert.equal(ok, true);
    assert.equal(register[0].status, 'IN_STOCK');
    assert.ok(register[0].updatedAt);
  });

  it('leaves already-IN_STOCK rows untouched and reports no restore', () => {
    const register = makeRegister([{ deviceSerial: 'SN-CAR004-0002', status: 'IN_STOCK' }]);
    const ok = restoreInMemorySerial(register, ASSET);
    assert.equal(ok, false);
    assert.equal(register[0].status, 'IN_STOCK');
  });

  it('does nothing when the asset has no device serial', () => {
    const register = makeRegister();
    const ok = restoreInMemorySerial(register, { ...ASSET, deviceSerial: null });
    assert.equal(ok, false);
    assert.equal(register[0].status, 'POP_LOCATION_ASSIGNED');
  });

  it('does nothing when the serial is absent from the register', () => {
    const register = makeRegister();
    const ok = restoreInMemorySerial(register, { ...ASSET, deviceSerial: 'SN-UNKNOWN-9999' });
    assert.equal(ok, false);
    assert.equal(register[0].status, 'POP_LOCATION_ASSIGNED');
  });
});
