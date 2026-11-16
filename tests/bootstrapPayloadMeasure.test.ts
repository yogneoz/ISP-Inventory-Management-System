/**
 * OPS-3 — the bootstrap payload measurement.
 *
 * The CLI is exercised against a running server in the worklist evidence; this
 * unit guard pins the arithmetic that table and the >10% flag rely on, so a
 * writer that reports the wrong share or misses the dominant key fails fast.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePayload } from '../scripts/measure_bootstrap_payload.mjs';

describe('OPS-3 bootstrap payload measurement', () => {
  test('reports raw/gzip totals and sorts keys by gzip contribution', () => {
    const payload = {
      small: { ok: true },
      huge: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'repeated audit detail '.repeat(8) })),
      medium: Array.from({ length: 20 }, (_, i) => ({ id: i, code: `CODE-${i}` })),
    };
    const result = measurePayload(payload);
    assert.ok(result.rawBytes > 0);
    assert.ok(result.gzipBytes > 0);
    assert.deepEqual(result.rows.map((row) => row.key).slice(0, 1), ['huge']);
    const sumOfShares = result.rows.reduce((sum, row) => sum + row.share, 0);
    assert.ok(sumOfShares > 0);
  });

  test('flags only keys above the 10% gzip share, including the dominant key', () => {
    const payload = {
      auditLogs: Array.from({ length: 400 }, (_, i) => ({ id: i, action: 'LOGIN', detail: `${i}-${'x'.repeat(80)}` })),
      small: { ok: true },
    };
    const result = measurePayload(payload);
    assert.deepEqual(result.flagged, ['auditLogs']);
    assert.equal(result.rows.find((row) => row.key === 'auditLogs')?.flagged, true);
    assert.equal(result.rows.find((row) => row.key === 'small')?.flagged, false);
  });

  test('honours a custom threshold and handles an empty payload', () => {
    const result = measurePayload({ only: { value: 1 } }, { threshold: 0.99 });
    assert.deepEqual(result.flagged, []);
    assert.equal(result.rows.length, 1);
    const empty = measurePayload({});
    assert.equal(empty.rawBytes, 2);
    assert.equal(empty.rows.length, 0);
  });
});
