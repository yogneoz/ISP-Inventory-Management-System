/**
 * AUD-1 — the Physical Stock Audit grid keeps operator-entered counts when the
 * live stock slice refreshes mid-audit (docs/bug-loop-audit-2026-10-27.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mergeCountRows,
  sameCountRows,
  type MergeableCountRow,
} from '../client/src/utils/auditRowMerge';

type TestRow = MergeableCountRow & { productName?: string };

const row = (over: Partial<TestRow> = {}): TestRow => ({
  productId: 'p1',
  bookQty: 10,
  countedQty: 10,
  isCounted: true,
  varianceReason: 'Verified Matched',
  customReason: '',
  ...over,
});

test('untouched rows follow the fresh book quantity', () => {
  const previous = [row()];
  const seed = [row({ bookQty: 9, countedQty: 9 })];
  const merged = mergeCountRows(previous, seed, () => false);
  assert.equal(merged[0].bookQty, 9);
  assert.equal(merged[0].countedQty, 9);
  assert.equal(merged[0].varianceReason, 'Verified Matched');
});

test('touched rows keep their count, flag and reasons while book catches up', () => {
  const previous = [
    row({
      countedQty: 7,
      varianceReason: 'Shrinkage / Missing Stock',
      customReason: 'two units with field team',
    }),
  ];
  const seed = [row({ bookQty: 9, countedQty: 9, varianceReason: 'Verified Matched' })];
  const merged = mergeCountRows(previous, seed, (id) => id === 'p1');
  assert.equal(merged[0].bookQty, 9);
  assert.equal(merged[0].countedQty, 7);
  assert.equal(merged[0].isCounted, true);
  assert.equal(merged[0].varianceReason, 'Shrinkage / Missing Stock');
  assert.equal(merged[0].customReason, 'two units with field team');
});

test('a cleared count survives a refresh', () => {
  const previous = [row({ countedQty: '', isCounted: false })];
  const seed = [row({ bookQty: 8, countedQty: 8 })];
  const merged = mergeCountRows(previous, seed, () => true);
  assert.equal(merged[0].countedQty, '');
  assert.equal(merged[0].isCounted, false);
  assert.equal(merged[0].bookQty, 8);
});

test('new products appear and removed products drop out', () => {
  const previous = [row(), row({ productId: 'gone' })];
  const seed = [row(), row({ productId: 'p2', bookQty: 3, countedQty: 3 })];
  const merged = mergeCountRows(previous, seed, () => true);
  assert.deepEqual(
    merged.map((r) => r.productId),
    ['p1', 'p2']
  );
});

test('an unchanged merge returns the previous array (no pointless state write)', () => {
  const previous = [row(), row({ productId: 'p2', bookQty: 3, countedQty: 3 })];
  const seed = [row(), row({ productId: 'p2', bookQty: 3, countedQty: 3 })];
  const merged = mergeCountRows(previous, seed, () => true);
  assert.equal(merged, previous);
  assert.equal(sameCountRows(previous, [...previous]), true);
  assert.equal(sameCountRows(previous, [row({ bookQty: 11 })]), false);
});

test('touched rows still adopt the seed metadata for a changed product', () => {
  const previous = [row({ productName: 'Old name' })];
  const seed = [row({ productName: 'New name', bookQty: 12, countedQty: 12 })];
  const merged = mergeCountRows(previous, seed, () => true);
  assert.equal(merged[0].productName, 'New name');
  assert.equal(merged[0].bookQty, 12);
  assert.equal(merged[0].countedQty, 10);
});

test('the audit screen merges live seeds and marks every operator edit (AUD-1)', () => {
  const source = fs.readFileSync(
    path.join('client/src/features/inventory/PhysicalStockAudit.tsx'),
    'utf8'
  );
  assert.match(source, /mergeCountRows(?:<[^>]+>)?\(/);
  assert.match(source, /auditSeedSessionRef/);
  assert.match(source, /touchedAuditProductsRef/);
  // The old unconditional reseed is gone.
  assert.doesNotMatch(
    source,
    /useEffect\(\(\) => \{\s*setAuditRows\(initialAuditRows\);\s*\}, \[initialAuditRows\]\)/
  );
  // Every operator mutation marks the row it edits: count, quick adjust,
  // reason, custom reason, and the zero-all bulk action.
  const marks = (source.match(/markAuditTouched\(/g) || []).length;
  assert.ok(marks >= 5, `expected the five operator handlers to mark rows, found ${marks}`);
});
