/**
 * GET /api/serial-log answers in two shapes.
 *
 * The legacy full read returns a bare array; the paged and keyset routes return
 * an envelope (`{ items, data, nextCursor, hasMore, statusCounts }`). The client
 * decided between them on `page`/`all` only, so the register's cursor read took
 * the array branch and called `.map` on the envelope object — the
 * "(rows || []).map is not a function" error on the Serial Log Register, which
 * also left its search looking broken because every fetch threw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSerialLogs } from '../client/src/services/api/inventory';

test('a cursor read is an envelope, with parsed history on both row aliases', async () => {
  const realFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: any) => {
    requested = String(input);
    return new Response(
      JSON.stringify({
        items: [{ id: 'sl-1', deviceSerial: 'ABC123', history: '[{"status":"IN_STOCK"}]' }],
        data: [{ id: 'sl-1', deviceSerial: 'ABC123', history: '[{"status":"IN_STOCK"}]' }],
        nextCursor: 'next-page',
        hasMore: true,
        statusCounts: { IN_STOCK: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as any;

  try {
    // Exactly what the register sends for its first cursor page.
    const page = (await getSerialLogs({ cursor: null, limit: 20 })) as any;
    assert.ok(!Array.isArray(page), 'a cursor page is an envelope, not a bare array');
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, 'next-page');
    assert.deepEqual(
      page.items[0].history,
      [{ status: 'IN_STOCK' }],
      'the rows the table renders carry parsed history, not a JSON string'
    );
    assert.deepEqual(page.data, page.items, 'both aliases carry the parsed rows');
    assert.match(requested, /\/api\/serial-log\?/);
    assert.match(requested, /limit=20/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a plain full read keeps the legacy bare-array shape', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ id: 'sl-2', deviceSerial: 'LEGACY', history: [] }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;

  try {
    const rows = (await getSerialLogs({ branchId: 'WH001' })) as any;
    assert.ok(Array.isArray(rows), 'without page/all/cursor the endpoint still answers with an array');
    assert.equal(rows[0].deviceSerial, 'LEGACY');
  } finally {
    globalThis.fetch = realFetch;
  }
});
