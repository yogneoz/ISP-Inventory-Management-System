import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDamageReason,
  buildDamageRecordInsert,
  buildQuarantineHistoryEntry,
  quarantineSerialsInDb,
  quarantineInMemorySerials,
  restoreSerialsInDb,
  restoreInMemorySerials,
  deriveDamageItems,
  validateReversalAvailability,
  buildReversalLedgerWithStock,
  buildDamagePoolLedgerChange,
  mirrorReversal,
  type DamageItem,
  type DamageOperation,
} from '../server/src/services/damage.service';
import type { SqlClient } from '../server/src/services/serials.service';

// ---------------------------------------------------------------------------
// resolveDamageReason — free-text → known damage_reason mapping
// ---------------------------------------------------------------------------
describe('resolveDamageReason', () => {
  it('maps each known reason by substring match', () => {
    assert.equal(resolveDamageReason('item has PHYSICAL_DAMAGE from drop'), 'PHYSICAL_DAMAGE');
    assert.equal(resolveDamageReason('TRANSIT_DAMAGE in delivery'), 'TRANSIT_DAMAGE');
    assert.equal(resolveDamageReason('STORAGE_DAMAGE due to leak'), 'STORAGE_DAMAGE');
    assert.equal(resolveDamageReason('boxes EXPIRED'), 'EXPIRED');
    assert.equal(resolveDamageReason('RETURN_DAMAGE from customer'), 'RETURN_DAMAGE');
    assert.equal(resolveDamageReason('QUALITY_DEFECT reported'), 'QUALITY_DEFECT');
    assert.equal(resolveDamageReason('misc issue'), 'OTHER');
  });
  it('defaults the free-text reason when none supplied', () => {
    assert.equal(resolveDamageReason(undefined), 'OTHER');
    assert.equal(resolveDamageReason(null), 'OTHER');
    assert.equal(resolveDamageReason(''), 'OTHER');
  });
  it('is case-insensitive', () => {
    assert.equal(resolveDamageReason('transit_damage tag'), 'TRANSIT_DAMAGE');
  });
  it('treats spaced free-text as unknown (verbatim production behavior)', () => {
    assert.equal(resolveDamageReason('transit damage tag'), 'OTHER');
  });
});

// ---------------------------------------------------------------------------
// buildDamageRecordInsert — damage_records row + in-memory mirror
// ---------------------------------------------------------------------------
describe('buildDamageRecordInsert', () => {
  const op: DamageOperation = {
    id: 'op-1',
    referenceNumber: 'DMG-001',
    branchId: 'WH001',
    dateAD: '2026-09-20',
    dateBS: '2083-05-01 BS',
    reason: 'Transit damage during delivery',
    inspectorName: 'Arya',
  };
  const item: DamageItem = { productId: 'p1', productName: 'ONU', quantity: 3, unitCost: 100 };

  it('derives id and damageReference from op + product', () => {
    const rec = buildDamageRecordInsert(op, item, 'fy-4');
    assert.equal(rec.id, 'dmr-op-1-p1');
    assert.equal(rec.damageReference, 'DMG-001-p1');
  });
  it('resolves unit cost from item.unitCost and computes totals', () => {
    const rec = buildDamageRecordInsert(op, item, 'fy-4');
    const p = rec.params as number[];
    assert.equal(p[5], 100); // unit_cost ($6)
    assert.equal(p[6], 300); // total_cost = 3 * 100 ($7)
    assert.equal(rec.mirror.totalCost, 300);
  });
  it('falls back to costPerUnit on the item, then the op, then caller fallback', () => {
    const a = buildDamageRecordInsert(op, { ...item, unitCost: undefined, costPerUnit: 55 }, 'fy-4');
    assert.equal(a.params[5], 55);
    const b = buildDamageRecordInsert(op, { ...item, unitCost: undefined, costPerUnit: undefined }, 'fy-4');
    assert.equal(b.params[5], 0); // op.costPerUnit unset, no fallback
    const c = buildDamageRecordInsert(
      { ...op, costPerUnit: undefined },
      { ...item, unitCost: undefined, costPerUnit: undefined },
      'fy-4',
      77
    );
    assert.equal(c.params[5], 77);
    const d = buildDamageRecordInsert({ ...op, costPerUnit: 99 }, { ...item, unitCost: undefined, costPerUnit: undefined }, 'fy-4', 77);
    assert.equal(d.params[5], 99); // op-level cost wins over caller fallback
  });
  it('maps the free-text reason into the DB enum value', () => {
    // Reason mapping is substring-based on the underscored enum values
    // (verbatim production behavior), so the fixture uses an underscored form.
    const rec = buildDamageRecordInsert({ ...op, reason: 'TRANSIT_DAMAGE during delivery' }, item, 'fy-4');
    assert.equal(rec.params[9], 'TRANSIT_DAMAGE');
    assert.equal(rec.mirror.damageReason, 'TRANSIT_DAMAGE');
  });
  it('preserves the production quirk: spaced free-text reasons map to OTHER', () => {
    const rec = buildDamageRecordInsert(op, item, 'fy-4'); // 'Transit damage during delivery'
    assert.equal(rec.params[9], 'OTHER');
  });
  it('carries the fiscal year id into SQL params and the mirror', () => {
    const rec = buildDamageRecordInsert(op, item, 'fy-4');
    assert.equal(rec.params[12], 'fy-4');
    assert.equal(rec.mirror.fiscalYearId, 'fy-4');
    const noFy = buildDamageRecordInsert(op, item, null);
    assert.equal(noFy.params[12], null);
    assert.equal(noFy.mirror.fiscalYearId, undefined);
  });
  it('SQL targets damage_records with ON CONFLICT DO NOTHING', () => {
    const rec = buildDamageRecordInsert(op, item, 'fy-4');
    assert.match(rec.sql, /INSERT INTO damage_records/);
    assert.match(rec.sql, /ON CONFLICT \(id\) DO NOTHING/);
  });
});

// ---------------------------------------------------------------------------
// buildQuarantineHistoryEntry — history row shape
// ---------------------------------------------------------------------------
describe('buildQuarantineHistoryEntry', () => {
  it('records the DAMAGE op attribution', () => {
    const op = { id: 'op-1', referenceNumber: 'DMG-001', dateAD: '2026-09-20' } as DamageOperation;
    assert.deepEqual(buildQuarantineHistoryEntry(op), {
      status: 'DAMAGED',
      sourceType: 'DAMAGE',
      sourceId: 'op-1',
      dateAD: '2026-09-20',
      notes: 'Marked damaged via DMG-001',
    });
  });
});

// ---------------------------------------------------------------------------
// quarantineSerialsInDb — DB-side serial quarantine
// ---------------------------------------------------------------------------
describe('quarantineSerialsInDb', () => {
  const op: DamageOperation = { id: 'op-1', referenceNumber: 'DMG-001', dateAD: '2026-09-20' } as DamageOperation;

  function mockClient(histories: Record<string, any> = {}) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      async query(sql: string, params: unknown[] = []) {
        executed.push({ sql, params });
        if (sql.includes('SELECT history_json')) {
          const sn = (params[0] as string).toLowerCase();
          return { rows: histories[sn] !== undefined ? [{ history_json: histories[sn] }] : [], rowCount: histories[sn] !== undefined ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return { client, executed };
  }

  it('marks IN_STOCK serials DAMAGED with appended history and op attribution', async () => {
    const { client, executed } = mockClient({ 'sn-1': JSON.stringify([{ status: 'IN_STOCK' }]) });
    await quarantineSerialsInDb(client, [{ productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: 'SN-1' }] }], op, '2026-09-20T00:00:00Z');
    const update = executed.find((e) => e.sql.startsWith('UPDATE serial_log'))!;
    assert.ok(update, 'UPDATE serial_log executed');
    assert.equal(update.params[0], 'op-1');
    assert.equal(update.params[3], 'SN-1');
    const hist = JSON.parse(update.params[1] as string);
    assert.equal(hist.length, 2);
    assert.equal(hist[1].status, 'DAMAGED');
    assert.equal(hist[1].sourceId, 'op-1');
    assert.match(update.sql, /status = 'IN_STOCK'/);
  });

  it('parses string and object history_json shapes', async () => {
    const { client, executed } = mockClient({ 'sn-2': [{ status: 'IN_STOCK' }] });
    await quarantineSerialsInDb(client, [{ productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: 'SN-2' }] }], op, 'T');
    const update = executed.find((e) => e.sql.startsWith('UPDATE serial_log'))!;
    const hist = JSON.parse(update.params[1] as string);
    assert.equal(hist.length, 2);
  });

  it('skips serials not found IN_STOCK (no UPDATE issued)', async () => {
    const { client, executed } = mockClient({});
    await quarantineSerialsInDb(client, [{ productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: 'SN-MISSING' }] }], op, 'T');
    assert.equal(executed.filter((e) => e.sql.startsWith('UPDATE serial_log')).length, 0);
  });

  it('skips entries with empty serial numbers', async () => {
    const { client, executed } = mockClient({});
    await quarantineSerialsInDb(client, [{ productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: '' }, {}] }], op, 'T');
    assert.equal(executed.length, 0);
  });

  it('handles items without deviceSerials', async () => {
    const { client, executed } = mockClient({});
    await quarantineSerialsInDb(client, [{ productId: 'p1', quantity: 2 }], op, 'T');
    assert.equal(executed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// quarantineInMemorySerials — in-memory register quarantine
// ---------------------------------------------------------------------------
describe('quarantineInMemorySerials', () => {
  const op: DamageOperation = { id: 'op-1', referenceNumber: 'DMG-001', dateAD: '2026-09-20' } as DamageOperation;

  it('flips matching IN_STOCK rows to DAMAGED in place and returns affected keys', () => {
    const logs: any[] = [{ id: 'sl-1', deviceSerial: 'SN-1', status: 'IN_STOCK', history: [] }];
    const affected = quarantineInMemorySerials(logs, [{ productId: 'p1', quantity: 1, deviceSerials: [{ deviceSerial: 'sn-1' }] }], op);
    assert.deepEqual(affected, ['sn-1']);
    assert.equal(logs[0].status, 'DAMAGED');
    assert.equal(logs[0].sourceType, 'DAMAGE');
    assert.equal(logs[0].sourceId, 'op-1');
    assert.equal(logs[0].history[0].status, 'DAMAGED');
  });
  it('leaves rows already DAMAGED (or quarantined elsewhere) untouched', () => {
    const logs: any[] = [
      { id: 'sl-1', deviceSerial: 'SN-1', status: 'DAMAGED', sourceId: 'other-op', history: [] },
      { id: 'sl-2', deviceSerial: 'SN-2', status: 'ASSIGNED', history: [] },
    ];
    const affected = quarantineInMemorySerials(
      logs,
      [{ productId: 'p1', quantity: 2, deviceSerials: [{ deviceSerial: 'SN-1' }, { deviceSerial: 'SN-2' }] }],
      op
    );
    assert.deepEqual(affected, []);
    assert.equal(logs[0].sourceId, 'other-op');
    assert.equal(logs[1].status, 'ASSIGNED');
  });
});

// ---------------------------------------------------------------------------
// restoreSerialsInDb — DB-side restoration on reversal
// ---------------------------------------------------------------------------
describe('restoreSerialsInDb', () => {
  const op = { id: 'op-1', referenceNumber: 'DMG-001' };

  function mockClient() {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const client: SqlClient = {
      async query(sql: string, params: unknown[] = []) {
        executed.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    return { client, executed };
  }

  it('uses the ANY($1::text[]) branch when payload serials exist', async () => {
    const { client, executed } = mockClient();
    await restoreSerialsInDb(client, [{ deviceSerial: 'SN-1' }, { deviceSerial: 'SN-2' }], op, 'Restored — test', '2026-09-20T00:00:00Z');
    const update = executed[0];
    assert.match(update.sql, /ANY\(\$1::text\[\]\)/);
    assert.match(update.sql, /status = 'DAMAGED' AND source_id = \$2/);
    assert.deepEqual(update.params[0], ['sn-1', 'sn-2']);
    assert.equal(update.params[1], 'op-1');
    const hist = JSON.parse(update.params[2] as string);
    assert.equal(hist[0].sourceType, 'DAMAGE_REVERSED');
  });

  it('falls back to source_id attribution for legacy ops without payload serials', async () => {
    const { client, executed } = mockClient();
    await restoreSerialsInDb(client, [], op, 'Restored — test', '2026-09-20T00:00:00Z');
    const update = executed[0];
    assert.match(update.sql, /WHERE status = 'DAMAGED' AND source_id = \$1/);
    assert.equal(update.params[0], 'op-1');
  });

  it('restore history carries the reversal message and op id', async () => {
    const { client, executed } = mockClient();
    await restoreSerialsInDb(client, [{ deviceSerial: 'SN-1' }], op, 'Restored — damage DMG-001 reversed by Admin: fix typo', '2026-09-20T01:00:00Z');
    const hist = JSON.parse(executed[0].params[2] as string);
    assert.equal(hist[0].notes, 'Restored — damage DMG-001 reversed by Admin: fix typo');
    assert.equal(hist[0].sourceId, 'op-1');
    assert.equal(hist[0].dateAD, '2026-09-20');
  });
});

// ---------------------------------------------------------------------------
// restoreInMemorySerials — in-memory restoration on reversal
// ---------------------------------------------------------------------------
describe('restoreInMemorySerials', () => {
  const op = { id: 'op-1', referenceNumber: 'DMG-001' };

  it('restores payload-attributed DAMAGED rows to IN_STOCK', () => {
    const logs: any[] = [{ id: 'sl-1', deviceSerial: 'SN-1', status: 'DAMAGED', sourceId: 'op-1', history: [] }];
    const restored = restoreInMemorySerials(logs, [{ deviceSerial: 'sn-1' }], op, 'Restored — test', '2026-09-20');
    assert.deepEqual(restored, ['sn-1']);
    assert.equal(logs[0].status, 'IN_STOCK');
    assert.equal(logs[0].sourceType, 'STOCK_OP');
    assert.equal(logs[0].sourceId, undefined);
    assert.equal(logs[0].history[0].sourceType, 'DAMAGE_REVERSED');
  });
  it('legacy ops restore all rows attributed by source_id', () => {
    const logs: any[] = [
      { id: 'sl-1', deviceSerial: 'SN-1', status: 'DAMAGED', sourceId: 'op-1', history: [] },
      { id: 'sl-2', deviceSerial: 'SN-2', status: 'DAMAGED', sourceId: 'op-1', history: [] },
      { id: 'sl-3', deviceSerial: 'SN-3', status: 'DAMAGED', sourceId: 'op-2', history: [] },
    ];
    const restored = restoreInMemorySerials(logs, [], op, 'Restored — test', '2026-09-20');
    assert.deepEqual(restored, ['sn-1', 'sn-2']);
    assert.equal(logs[2].status, 'DAMAGED');
  });
  it('never touches rows quarantined by a different op', () => {
    const logs: any[] = [{ id: 'sl-1', deviceSerial: 'SN-1', status: 'DAMAGED', sourceId: 'op-2', history: [] }];
    const restored = restoreInMemorySerials(logs, [{ deviceSerial: 'sn-1' }], op, 'R', '2026-09-20');
    assert.deepEqual(restored, []);
    assert.equal(logs[0].status, 'DAMAGED');
  });
});

// ---------------------------------------------------------------------------
// deriveDamageItems — items JSONB vs legacy single-product shape
// ---------------------------------------------------------------------------
describe('deriveDamageItems', () => {
  it('prefers the items JSONB when present', () => {
    const op = { items: [{ productId: 'p1', quantity: 2 }], productId: 'legacy', quantityChanged: -5 };
    assert.deepEqual(deriveDamageItems(op), [{ productId: 'p1', quantity: 2 }]);
  });
  it('falls back to the legacy single-product shape (abs quantity)', () => {
    const op = { productId: 'p9', productName: 'UPS', quantityChanged: -3, costPerUnit: 42 };
    assert.deepEqual(deriveDamageItems(op), [{ productId: 'p9', productName: 'UPS', quantity: 3, unitCost: 42 }]);
  });
  it('returns [] when neither shape is available', () => {
    assert.deepEqual(deriveDamageItems({}), []);
  });
});

// ---------------------------------------------------------------------------
// validateReversalAvailability — pre-flight safeguard
// ---------------------------------------------------------------------------
describe('validateReversalAvailability', () => {
  const op = { id: 'op-1', branchId: 'WH001' };

  it('returns null when every item fits within the damaged qty', () => {
    const err = validateReversalAvailability(
      op,
      [{ productId: 'p1', quantity: 2, productName: 'ONU' }],
      [{ productId: 'p1', branchId: 'WH001', damagedQty: 5 }]
    );
    assert.equal(err, null);
  });
  it('returns the exact 400 message when damaged stock has changed', () => {
    const err = validateReversalAvailability(
      op,
      [{ productId: 'p1', quantity: 3, productName: 'ONU' }],
      [{ productId: 'p1', branchId: 'WH001', damagedQty: 2 }]
    );
    assert.equal(
      err,
      'Cannot reverse ONU: only 2 damaged unit(s) remain at branch WH001. The current damaged stock has changed since this record was created.'
    );
  });
  it('treats a missing stock row as zero available', () => {
    const err = validateReversalAvailability(op, [{ productId: 'pX', quantity: 1, productName: 'X' }], []);
    assert.match(err!, /only 0 damaged unit/);
  });
  it('skips items with non-positive quantities', () => {
    const err = validateReversalAvailability(op, [{ productId: 'p1', quantity: 0 }], []);
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// buildReversalLedgerWithStock — DAMAGE_REVERSED ledger entries
// ---------------------------------------------------------------------------
describe('buildReversalLedgerWithStock', () => {
  it('builds one DAMAGE_REVERSED entry per item with resolved quantities and costs', () => {
    const op = { id: 'op-1', referenceNumber: 'DMG-001', branchId: 'WH001', costPerUnit: 0 };
    const ledger = buildReversalLedgerWithStock(
      op,
      [{ productId: 'p1', quantity: 2, unitCost: 50, sku: 'SKU-1' }],
      {
        reversalDateAD: '2026-09-20',
        reversalDateBS: '2083-06-01 BS',
        products: [{ id: 'p1', sku: 'SKU-X', name: 'ONU', costPrice: 999 }],
        stockRows: [{ productId: 'p1', branchId: 'WH001', quantityOnHand: 7 }],
      }
    );
    assert.equal(ledger.length, 1);
    const t = ledger[0];
    assert.equal(t.changeType, 'DAMAGE_REVERSED');
    assert.equal(t.quantityBefore, 7);
    assert.equal(t.quantityChanged, 2);
    assert.equal(t.quantityAfter, 9);
    assert.equal(t.unitCost, 50); // item unit cost wins
    assert.equal(t.productSku, 'SKU-1'); // item sku wins
    assert.equal(t.productName, 'ONU');
    assert.equal(t.referenceDocId, 'DMG-001');
    assert.equal(t.timestampAD, '2026-09-20T00:00:00.000Z');
    assert.equal(t.timestampBS, '2083-06-01 BS');
  });
  it('falls back to product costPrice when the item carries no cost', () => {
    const ledger = buildReversalLedgerWithStock(
      { id: 'op-1', referenceNumber: 'DMG-001', branchId: 'WH001' },
      [{ productId: 'p1', quantity: 1 }],
      {
        reversalDateAD: '2026-09-20',
        reversalDateBS: 'BS',
        products: [{ id: 'p1', costPrice: 250 }],
        stockRows: [],
      }
    );
    assert.equal(ledger[0].unitCost, 250);
  });
  it('skips items with non-positive quantities', () => {
    const ledger = buildReversalLedgerWithStock(
      { id: 'op-1', referenceNumber: 'DMG-001', branchId: 'B' },
      [{ productId: 'p1', quantity: 0 }],
      { reversalDateAD: 'D', reversalDateBS: 'BS', products: [], stockRows: [] }
    );
    assert.equal(ledger.length, 0);
  });
});

// ---------------------------------------------------------------------------
// mirrorReversal — in-memory stock / damage-record mirrors
// ---------------------------------------------------------------------------
describe('mirrorReversal', () => {
  const op = { id: 'op-1', referenceNumber: 'DMG-001', branchId: 'WH001', type: 'DAMAGE', dateBS: 'BS' };

  it('restores stock quantities, cancels matching damage records, flips op to CANCELLED', () => {
    const stockRows: any[] = [{ productId: 'p1', branchId: 'WH001', quantityOnHand: 5, damagedQty: 3, lastUpdated: '' }];
    const damageRecords: any[] = [{ id: 'dmr-op-1-p1', damageReference: 'DMG-001-p1', status: 'IDENTIFIED', notes: 'note' }];
    const result = mirrorReversal(
      op,
      [{ productId: 'p1', quantity: 3 }],
      { reason: 'wrong product', reversedBy: 'Admin', reversalDateAD: '2026-09-20', reversalDateBS: 'BS' },
      { stockRows: stockRows as any, damageRecords: damageRecords as any }
    );
    assert.equal(result.stockRows[0].quantityOnHand, 8);
    assert.equal(result.stockRows[0].damagedQty, 0);
    assert.equal(result.damageRecords[0].status, 'CANCELLED');
    assert.match(result.damageRecords[0].notes, /REVERSED \(wrong product\) by Admin/);
    assert.deepEqual(stockRows, [{ productId: 'p1', branchId: 'WH001', quantityOnHand: 5, damagedQty: 3, lastUpdated: '' }], 'input stock rows must not be mutated');
    assert.equal(result.updatedOp.status, 'CANCELLED');
    assert.equal(result.updatedOp.reversalReason, 'wrong product');
    assert.equal(result.updatedOp.reversedBy, 'Admin');
    assert.equal(result.updatedOp.reversedAtAD, '2026-09-20');
  });
  it('matches damage records by reference OR synthetic id', () => {
    const damageRecords: any[] = [{ id: 'other-id', damageReference: 'DMG-001-p2', status: 'IDENTIFIED', notes: '' }];
    const { damageRecords: cancelled } = mirrorReversal(
      op,
      [{ productId: 'p2', quantity: 1 }],
      { reason: 'r', reversedBy: 'A', reversalDateAD: 'D', reversalDateBS: 'BS' },
      { stockRows: [], damageRecords: damageRecords as any }
    );
    assert.equal(cancelled[0].status, 'CANCELLED');
  });
  it('leaves stock untouched when no matching row exists', () => {
    const stockRows: any[] = [{ productId: 'p9', branchId: 'WH001', quantityOnHand: 1, damagedQty: 0, lastUpdated: '' }];
    const { stockRows: out } = mirrorReversal(op, [{ productId: 'p1', quantity: 2 }], { reason: 'r', reversedBy: 'A', reversalDateAD: 'D', reversalDateBS: 'BS' }, { stockRows: stockRows as any, damageRecords: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].quantityOnHand, 1);
  });
});

describe('buildDamagePoolLedgerChange', () => {
  it('records an increase in the damaged pool as a negative change', () => {
    // 5 usable units moved to damaged: pool 2 → 5
    assert.equal(buildDamagePoolLedgerChange(2, 5).quantityChanged, 3);
  });

  it('records a decrease in the damaged pool as a positive change', () => {
    // repair / write-off: pool 5 → 3
    assert.equal(buildDamagePoolLedgerChange(5, 3).quantityChanged, -2);
  });

  it('preserves before + changed = after for both directions', () => {
    for (const [before, after] of [[0, 4], [4, 0], [3, 3], [7, 2], [2, 9]] as const) {
      const { quantityChanged } = buildDamagePoolLedgerChange(before, after);
      assert.equal(before + quantityChanged, after);
    }
  });

  it('records a no-op as zero instead of inventing a quantity', () => {
    assert.equal(buildDamagePoolLedgerChange(4, 4).quantityChanged, 0);
  });

  it('treats missing pool values as zero', () => {
    assert.equal(buildDamagePoolLedgerChange(undefined as any, 3).quantityChanged, 3);
    assert.equal(buildDamagePoolLedgerChange(3, undefined as any).quantityChanged, -3);
  });
});
