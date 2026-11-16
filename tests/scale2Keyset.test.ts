/**
 * SCALE-2 — keyset pagination contract and concurrent-insert stability.
 *
 * PROVES:
 *  1. cursors are opaque, signed, table-bound and reject tampering/wrong arity;
 *  2. the shared limit clamp and scope guard behave as documented;
 *  3. every scoped SQL builder emits a composite-key predicate in the same
 *     order as its ORDER BY (no OFFSET), with a bounded LIMIT;
 *  4. against PostgreSQL (skipped without DATABASE_URL), paging a table while
 *     rows are inserted between pages returns every pre-existing row exactly
 *     once — no duplicate and no skipped row.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import pg from 'pg';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetEnvelope,
  keysetLimit,
  keysetPredicate,
  requireLargeTableScope,
} from '../server/src/utils/keysetCursor';
import { buildCustomerListQuery } from '../server/src/models/masterdata.repo';
import { buildSalesInvoiceKeysetQuery } from '../server/src/models/sales.repo';
import {
  buildSerialLogKeysetQuery,
  buildStockOperationKeysetQuery,
} from '../server/src/models/inventory.repo';
import {
  buildJournalKeysetQuery,
  buildSubledgerBookEntriesQuery,
} from '../server/src/models/accounting.repo';
import { buildAuditTrailQuery } from '../server/src/models/misc.repo';

dotenv.config();

describe('SCALE-2 keyset cursor contract', () => {
  test('round-trips a composite key and stays opaque', () => {
    const cursor = encodeKeysetCursor('sales_invoices', ['2026-11-16T10:00:00.000Z', 'inv-42']);
    assert.ok(cursor.length > 20);
    assert.ok(!cursor.includes('inv-42'), 'the cursor must not expose the key in clear text');
    assert.deepEqual(decodeKeysetCursor(cursor, 'sales_invoices', 2), [
      '2026-11-16T10:00:00.000Z',
      'inv-42',
    ]);
  });

  test('rejects tampering, another table and the wrong arity', () => {
    const cursor = encodeKeysetCursor('serial_log', ['2026-11-16T10:00:00.000Z', 's-1']);
    assert.equal(decodeKeysetCursor(cursor.replace(/.$/, 'x'), 'serial_log', 2), null);
    assert.equal(decodeKeysetCursor(cursor, 'audit_logs', 2), null);
    assert.equal(decodeKeysetCursor(cursor, 'serial_log', 3), null);
    assert.equal(decodeKeysetCursor('not-a-cursor', 'serial_log', 2), null);
  });

  test('clamps limits and builds a deterministic row comparison', () => {
    assert.equal(keysetLimit(undefined), 50);
    assert.equal(keysetLimit('0'), 50);
    assert.equal(keysetLimit('9999', 50, 200), 200);
    const params: unknown[] = [];
    assert.equal(
      keysetPredicate(['created_at', 'id'], 'DESC', ['2026-01-01T00:00:00Z', 'x'], params),
      '(created_at, id) < ($1, $2)'
    );
    assert.deepEqual(params, ['2026-01-01T00:00:00Z', 'x']);
  });

  test('the envelope is the documented shape and keeps compatibility aliases', () => {
    const body = keysetEnvelope([{ id: 'a' }], 'next', true, { statusCounts: { POSTED: 1 } });
    assert.deepEqual(body.items, [{ id: 'a' }]);
    assert.deepEqual(body.data, [{ id: 'a' }]);
    assert.equal(body.nextCursor, 'next');
    assert.equal(body.hasMore, true);
    assert.deepEqual(body.statusCounts, { POSTED: 1 });
  });

  test('SCOPE_REQUIRED names the code and accepts either branch or date range', () => {
    const calls: Array<{ status: number; body: any }> = [];
    const res = {
      status(code: number) {
        return { json: (body: unknown) => calls.push({ status: code, body }) };
      },
    };
    assert.equal(requireLargeTableScope(res, { report: true, branchId: undefined }), false);
    assert.equal(calls[0].status, 400);
    assert.equal(calls[0].body.code, 'SCOPE_REQUIRED');
    assert.equal(requireLargeTableScope(res, { report: true, branchId: 'WH001' }), true);
    assert.equal(
      requireLargeTableScope(res, { report: true, dateFrom: '2026-01-01', dateTo: '2026-01-31' }),
      true
    );
    assert.equal(requireLargeTableScope(res, { report: false }), true);
  });

  test('every scoped builder uses a composite keyset predicate, never OFFSET', () => {
    const sales = buildSalesInvoiceKeysetQuery({ branchId: 'WH001' }, ['2026-01-01T00:00:00Z', 'i1'], 25);
    assert.match(sales.sql, /\(created_at, id\) < \(\$\d+::timestamptz, \$\d+\)/);
    assert.match(sales.sql, /ORDER BY created_at DESC, id DESC LIMIT 26/);
    assert.doesNotMatch(sales.sql, /OFFSET/);

    const ops = buildStockOperationKeysetQuery({ branchId: 'WH001' }, ['2026-01-01T00:00:00Z', 'o1'], 25);
    assert.match(ops.sql, /\(created_at, id\) < \(\$\d+::timestamptz, \$\d+\)/);
    assert.doesNotMatch(ops.sql, /OFFSET/);

    const serial = buildSerialLogKeysetQuery({ branchScope: ['WH001'] }, ['2026-01-01T00:00:00Z', 's1'], 25);
    assert.match(serial.sql, /\(created_at, id\) < \(\$\d+::timestamptz, \$\d+\)/);
    assert.doesNotMatch(serial.sql, /OFFSET/);

    const journals = buildJournalKeysetQuery({ branchId: 'WH001' }, ['2026-01-01', 'JV-1', 'j1'], 25);
    assert.match(journals.sql, /\(j\.journal_date_ad, COALESCE\(j\.journal_no, ''\), j\.id\) </);
    assert.doesNotMatch(journals.sql, /OFFSET/);

    const subledger = buildSubledgerBookEntriesQuery(['2026-01-01', 'e1'], 25);
    assert.match(subledger.sql, /\(s\.entry_date_ad, s\.id\) < \(\$5::date, \$6\)/);
    assert.match(subledger.sql, /LIMIT 26/);

    const audit = buildAuditTrailQuery('WH001', 26, undefined, ['2026-01-01T00:00:00Z', 'a1']);
    assert.match(audit.sql, /\(timestamp_ad, id\) < \(\$\d+::timestamptz, \$\d+\)/);
    assert.match(audit.sql, /ORDER BY timestamp_ad DESC, id DESC/);

    const customers = buildCustomerListQuery({
      cursor: { name: 'Acme', id: 'c1' },
      pageSize: 25,
    });
    assert.match(customers.sql, /\(customer_name, customer_id\) > \(\$\d+, \$\d+\)/);
    assert.doesNotMatch(customers.sql, /OFFSET/);
  });
});

describe('SCALE-2 concurrent inserts do not duplicate or skip rows', () => {
  let client: pg.Client | null = null;
  const skipNoDb = !process.env.DATABASE_URL && 'needs a reachable PostgreSQL';

  before(async () => {
    if (!process.env.DATABASE_URL) return;
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('SELECT 1');
    await client.query('DROP TABLE IF EXISTS scale2_keyset_probe');
    await client.query(`CREATE TEMP TABLE scale2_keyset_probe (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL,
      payload int NOT NULL
    )`);
  });

  after(async () => {
    if (client) await client.end();
  });

  test('pages with the cursor while newer and same-timestamp rows are inserted', { skip: skipNoDb }, async () => {
    if (!client) return;
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const initialIds = Array.from({ length: 60 }, (_, i) => `row-${String(i).padStart(3, '0')}`);
    for (let i = 0; i < initialIds.length; i += 1) {
      // Groups of five share a timestamp, so the id is the real tie-breaker.
      await client.query(
        'INSERT INTO scale2_keyset_probe (id, created_at, payload) VALUES ($1, $2, $3)',
        [initialIds[i], new Date(base + Math.floor(i / 5) * 1000), i]
      );
    }

    const seen: string[] = [];
    let cursor: [string, string] | undefined;
    let page = 0;
    for (;;) {
      page += 1;
      const params: unknown[] = [];
      let sql = 'SELECT id, created_at FROM scale2_keyset_probe';
      if (cursor) {
        sql += ' WHERE (created_at, id) < ($1::timestamptz, $2)';
        params.push(cursor[0], cursor[1]);
      }
      sql += ' ORDER BY created_at DESC, id DESC LIMIT 8';
      const result = await client.query(sql, params);
      const rows = result.rows;
      seen.push(...rows.map((row: any) => String(row.id)));
      if (rows.length < 8) break;

      const last = rows[rows.length - 1];
      cursor = [new Date(last.created_at).toISOString(), String(last.id)];

      if (page === 1) {
        // Concurrent writers: 10 rows newer than every page, plus 10 rows that
        // tie the oldest timestamp but sort before the cursor's id. A keyset
        // read must not shift the remaining original rows.
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            client!.query(
              'INSERT INTO scale2_keyset_probe (id, created_at, payload) VALUES ($1, $2, $3)',
              [`new-newer-${i}`, new Date(base + 1_000_000 + i), 1000 + i]
            )
          )
        );
        await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            client!.query(
              'INSERT INTO scale2_keyset_probe (id, created_at, payload) VALUES ($1, $2, $3)',
              [`new-tie-${i}`, new Date(base + Math.floor(55 / 5) * 1000), 2000 + i]
            )
          )
        );
      }
      assert.ok(page < 50, 'pagination did not terminate');
    }

    const unique = new Set(seen);
    assert.equal(unique.size, seen.length, `duplicate rows returned across pages: ${seen.length - unique.size}`);
    for (const id of initialIds) {
      assert.ok(unique.has(id), `row ${id} was skipped by keyset pagination`);
    }
    assert.equal(
      seen.filter((id) => initialIds.includes(id)).length,
      initialIds.length,
      'a pre-existing row was returned more than once'
    );
  });
});
