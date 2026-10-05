/**
 * Paged WHERE builders for the three revived register GETs — pure unit tests
 * (no database).
 *
 * Regression guard for the bug the dead-API audit surfaced while wiring the
 * paged endpoints: the shell pipeline that wrote these builders stripped the
 * `$` from every `${params.length}` placeholder and the `\d` from the AD
 * date-shape regex, so every filter produced `LIKE 1` (SQL error: operator
 * does not exist: text ~~ integer) and a broken `d{4}` regex (dates never
 * matched). The paged controller branch swallowed that error and fell back
 * to the legacy array — silently defeating paging. These assertions pin the
 * placeholder/param bijection, the date gates and the LIMIT/OFFSET clamps so
 * the class of bug cannot ship again, at the source.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSalesInvoiceWhere,
  buildSalesInvoiceCountQuery,
  buildSalesInvoicePagedQuery,
  buildSalesReturnWhere,
  buildSalesReturnPagedQuery,
} from '../server/src/models/sales.repo';
import {
  buildPurchaseReturnWhere,
  buildPurchaseReturnPagedQuery,
  buildPurchaseReturnCountQuery,
} from '../server/src/models/procurement.repo';

/** Every distinct `$N` bind in a WHERE clause, as a sorted number list. */
const binds = (whereSql: string) =>
  [...new Set([...whereSql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

describe('returns/invoices paged WHERE builders — parameter binding', () => {
  test('every filter contributes exactly one $N bind matching its param (no stripped $)', () => {
    const full = {
      branchId: 'WH001',
      status: 'POSTED',
      query: 'dn',
      dateFromAD: '2026-01-01',
      dateToAD: '2026-12-31',
    };
    for (const build of [buildSalesInvoiceWhere, buildSalesReturnWhere, buildPurchaseReturnWhere]) {
      const { whereSql, params } = build(full);
      assert.equal(params.length, 5, 'one param per filter');
      assert.deepEqual(binds(whereSql), [1, 2, 3, 4, 5], 'binds must be $1..$5 — a bare `LIKE 1` means the $ was stripped: ' + whereSql);
      assert.ok(binds(whereSql).length <= 5);
      assert.ok(!/LIKE \d/.test(whereSql), 'a numeric LIKE operand is the shell-stripping bug: ' + whereSql);
      assert.ok(!/=\s+\d+\s*(OR|AND|::)/.test(whereSql.replace('1=1', '')), 'a bare numeric comparison operand: ' + whereSql);
    }
  });

  test('the query filter binds one LIKE param reused across every searched column', () => {
    const { whereSql, params } = buildSalesReturnWhere({ query: 'CN-WH' });
    assert.deepEqual(params, ['%cn-wh%']);
    assert.deepEqual(binds(whereSql), [1], 'one bind serves every OR branch');
    assert.ok(whereSql.includes('LOWER(return_number) LIKE $1'));
    assert.ok(whereSql.includes('LOWER(original_invoice_number) LIKE $1'));
    assert.ok(whereSql.includes('LOWER(customer_name) LIKE $1'));
  });

  test('status maps to payment_status on sales invoices and to status on returns', () => {
    assert.ok(buildSalesInvoiceWhere({ status: 'UNPAID' }).whereSql.includes('payment_status = $1'));
    assert.ok(buildSalesReturnWhere({ status: 'POSTED' }).whereSql.includes('status = $1'));
    assert.ok(buildPurchaseReturnWhere({ status: 'DRAFT' }).whereSql.includes('status = $1'));
    // ALL is the no-op sentinel — nothing is filtered, nothing is bound.
    assert.deepEqual(buildSalesInvoiceWhere({ status: 'ALL' }).params, []);
    assert.deepEqual(buildSalesInvoiceWhere({ branchId: 'ALL' }).params, []);
  });

  test('the AD date filters only bind real YYYY-MM-DD values (the \\d regex gate)', () => {
    const ok = buildSalesInvoiceWhere({ dateFromAD: '2026-01-01', dateToAD: '2026-12-31' });
    assert.deepEqual(ok.params, ['2026-01-01', '2026-12-31']);
    assert.ok(ok.whereSql.includes('invoice_date_ad >= $1::date'));
    assert.ok(ok.whereSql.includes('invoice_date_ad <= $2::date'));

    // Shape violations only: the gate is a YYYY-MM-DD regex (same as the
    // pre-existing PO/PI builders) — e.g. '2026-13-99' has a valid SHAPE and
    // is bound, then rejected by PostgreSQL's ::date cast upstream.
    for (const bad of ['garbage', '26-01-01', '2026-01-011', '2026/01/01', '']) {
      const res = buildSalesInvoiceWhere({ dateFromAD: bad });
      assert.deepEqual(res.params, [], 'malformed date must not bind: ' + bad);
      assert.equal(res.whereSql, ' WHERE 1=1');
    }
    // The same gate guards the returns tables.
    assert.deepEqual(buildPurchaseReturnWhere({ dateFromAD: '2026-06-01' }).params, ['2026-06-01']);
    assert.deepEqual(buildSalesReturnWhere({ dateFromAD: 'nonsense' }).params, []);
  });

  test('count and paged list share the identical WHERE + params', () => {
    const opts = { branchId: 'BRH01', query: 'inv' };
    const count = buildSalesInvoiceCountQuery(opts);
    const list = buildSalesInvoicePagedQuery(opts, { page: 1, pageSize: 10 });
    const whereFromCount = count.sql.slice(count.sql.indexOf(' WHERE '));
    assert.ok(list.sql.includes(whereFromCount), 'the list must filter exactly like the count');
    assert.deepEqual(list.params, count.params);
    const pCount = buildPurchaseReturnCountQuery({ status: 'POSTED' });
    const pList = buildPurchaseReturnPagedQuery({ status: 'POSTED' }, { page: 1, pageSize: 10 });
    assert.ok(pList.sql.includes(pCount.sql.slice(pCount.sql.indexOf(' WHERE '))));
    assert.deepEqual(pList.params, pCount.params);
  });
});

describe('returns/invoices paged list — LIMIT/OFFSET clamps', () => {
  test('page 3 × size 10 slices at LIMIT 10 OFFSET 20', () => {
    const { sql } = buildSalesInvoicePagedQuery({}, { page: 3, pageSize: 10 });
    assert.ok(sql.includes('LIMIT 10 OFFSET 20'), sql.slice(-80));
  });

  test('page and pageSize are clamped into valid ranges', () => {
    assert.ok(buildSalesReturnPagedQuery({}, { page: -3, pageSize: 0 }).sql.includes('LIMIT 1 OFFSET 0'));
    assert.ok(buildSalesReturnPagedQuery({}, { page: 0, pageSize: 9999 }).sql.includes('LIMIT 500 OFFSET 0'));
  });

  test('without paging the query is unbounded (legacy filtered-array mode)', () => {
    const { sql } = buildPurchaseReturnPagedQuery({ query: 'dn' });
    assert.ok(!sql.includes('LIMIT'), 'no page window means the full filtered set: ' + sql.slice(-80));
    assert.ok(!sql.includes('OFFSET'));
  });
});
