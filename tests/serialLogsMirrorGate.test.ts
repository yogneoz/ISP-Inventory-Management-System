/**
 * Mirror retirement step 4 — the serial_log in-memory mirror no longer
 * decides anything when PostgreSQL is connected.
 *
 * Before this change, five narrow call sites read or mutated `serialLogs`
 * directly on every request: the asset-deploy IN_STOCK flip, the
 * unassign-restore, the damage quarantine, the damage-reverse restore, and
 * the serial-edit clash pre-check + mirror rename. All of them ran even when
 * PG was connected, where the authoritative write/compare already happened
 * inside the same request's transaction:
 *
 *   - SERIAL_LOG_ASSIGN_ON_DEPLOY_SQL / SERIAL_LOG_RESTORE_ON_UNASSIGN_SQL
 *   - quarantineSerialsInDb / restoreSerialsInDb (withTransaction)
 *   - serial-edit duplicate checks + cascading-update transaction
 *
 * That was redundant work and, worse, a correctness hazard: the serial-edit
 * clash pre-check ran AFTER the PG rename transaction had already committed,
 * so a stale mirror row could reject a rename that PostgreSQL accepted.
 *
 * The fix: each site is now gated on `!getPgConnected()` — the mirror serves
 * PG-down demo mode only. When PG is connected, cacheRefreshHook
 * (runtimeState.CACHE_LOADS includes serial_log) re-derives serialLogs from
 * PG truth before the response is sent, so the UI never depends on the
 * in-request mirror writes.
 *
 * PROVES (source pins, no DB needed):
 *   1. All five mirror serialLogs decision/mutation sites are PG-down gated.
 *   2. serial_log stays in CACHE_LOADS — the reconciliation path that makes
 *      the gate safe (if someone removed it, PG-connected responses would
 *      serve a stale mirror).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

/** Assert that `anchor` exists and sits inside an `!getPgConnected()` scope. */
const assertGated = (source: string, anchor: string, lookBehind: number): void => {
  const idx = source.indexOf(anchor);
  assert.ok(idx !== -1, `expected mirror use not found: ${anchor}`);
  const window = source.slice(Math.max(0, idx - lookBehind), idx);
  assert.ok(
    window.includes('!getPgConnected()'),
    `mirror use must be gated to PG-down demo mode (!getPgConnected()): ${anchor}`
  );
};

describe('mirror retirement step 4 — serialLogs mirror is demo-mode only', () => {
  test('inventory controller gates all four serialLogs mirror sites', () => {
    const src = read('server/src/controllers/inventory.controller.ts');
    // 1. post_assets deploy flip (IN_STOCK → CUSTOMER/POP_ASSIGNED)
    assertGated(
      src,
      "const sl = serialLogs.find((e) => String(e.deviceSerial || '')",
      400
    );
    // 2. patch_status unassign restore
    assertGated(src, 'restoreInMemorySerial(serialLogs, asset);', 300);
    // 3. damage create quarantine
    assertGated(
      src,
      'quarantineInMemorySerials(serialLogs, [item] as any, newOp as any);',
      400
    );
    // 4. damage reverse restore
    assertGated(src, 'restoreInMemorySerials(\n        mutable(serialLogs),', 400);
  });

  test('serialEdit gates the mirror clash pre-check and rename sync', () => {
    const src = read('server/src/services/serialEdit.handler.ts');
    // 5a. clash pre-check (ran after the PG rename transaction committed)
    assertGated(src, 'const clash = findInMemorySerialClash(', 400);
    // 5b. mirror rename
    assertGated(src, 'setSerialLogs(applyInMemorySerialRename(', 700);
  });

  test('serial_log reconciliation stays in runtime cache loads', () => {
    const src = read('server/src/state/runtimeState.ts');
    const entryIdx = src.indexOf("name: 'serial_log'");
    assert.ok(entryIdx !== -1, "serial_log must be a CACHE_LOADS entry");
    const entry = src.slice(entryIdx, entryIdx + 500);
    assert.ok(
      entry.includes('serialLogs = rows.map('),
      'the serial_log cache load must reassign serialLogs from PG rows (unconditional, no rows.length guard) so PG-connected responses never depend on the in-request mirror writes'
    );
  });
});
