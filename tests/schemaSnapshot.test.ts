/**
 * Worklist A6 — storage tuning has a drift guard.
 *
 * `scripts/verify_fresh_install.mjs` compared tables, columns, constraints,
 * indexes, triggers, sequences and views, but not `reloptions`, and
 * `pg_indexes.indexdef` carries no storage parameters. The tuning shipped on
 * 2026-11-17 (`fillfactor = 80` and the autovacuum scale factors on the two hot
 * tables, BRIN's `pages_per_range`) could therefore diverge between a fresh
 * install and a booted install with the guard still green.
 *
 * PROVES:
 *   1. a divergent table `fillfactor` fails the guard's decision function;
 *   2. a divergent BRIN `pages_per_range` on an INDEX fails it too — the case
 *      `indexdef` cannot see;
 *   3. identical snapshots pass, and the comparison is order-independent;
 *   4. the snapshot still asks PostgreSQL for reloptions on indexes and the
 *      guard still compares the category, so the protection cannot be dropped
 *      without failing a test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SNAPSHOT_CATEGORIES,
  STORAGE_QUERY_SQL,
  diffRows,
} from '../scripts/schemaSnapshot.mjs';

const table = (name: string, reloptions: string) => ({ name, kind: 'r', reloptions });
const index = (name: string, reloptions: string) => ({ name, kind: 'i', reloptions });

describe('fresh-install storage-parameter drift (A6)', () => {
  test('a divergent table fillfactor fails the guard', () => {
    const ref = [table('inventory_stock', 'fillfactor=80,autovacuum_vacuum_scale_factor=0.02')];
    const boot = [table('inventory_stock', '')];
    const diff = diffRows(ref, boot);
    assert.equal(diff.onlyRef.length, 1);
    assert.equal(diff.onlyBoot.length, 1);
    assert.match(diff.onlyRef[0], /fillfactor=80/);
  });

  test('a divergent BRIN pages_per_range on an index fails the guard', () => {
    const ref = [index('idx_audit_timestamp_brin', 'pages_per_range=32')];
    const boot = [index('idx_audit_timestamp_brin', '')];
    const diff = diffRows(ref, boot);
    assert.equal(diff.onlyRef.length, 1, 'the index storage parameter is compared');
    assert.match(diff.onlyRef[0], /pages_per_range=32/);
  });

  test('identical snapshots pass, whatever the row order', () => {
    const a = [table('inventory_stock', 'fillfactor=80'), index('idx_x_brin', 'pages_per_range=32')];
    const b = [index('idx_x_brin', 'pages_per_range=32'), table('inventory_stock', 'fillfactor=80')];
    assert.deepEqual(diffRows(a, b), { onlyRef: [], onlyBoot: [] });
  });

  test('the snapshot asks PostgreSQL for reloptions on tables AND indexes', () => {
    assert.match(STORAGE_QUERY_SQL, /reloptions/);
    assert.match(STORAGE_QUERY_SQL, /relkind IN \('r', 'p', 'i', 'm'\)/);
    assert.match(STORAGE_QUERY_SQL, /pg_class/);
  });

  test('the guard compares the storage category', () => {
    assert.ok(SNAPSHOT_CATEGORIES.includes('storage'));
    const guard = fs.readFileSync(path.resolve('scripts/verify_fresh_install.mjs'), 'utf8');
    assert.match(
      guard,
      /diffCategory\('storage', ref\.storage, boot\.storage, diffs\)/,
      'verify_fresh_install.mjs must compare storage parameters'
    );
    assert.match(guard, /snapshotSchema as snapshotSchemaRows/);
  });
});
