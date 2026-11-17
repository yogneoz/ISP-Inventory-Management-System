/**
 * REC-2 follow-up (Round 11 carry-over) — the Receive Payment list must be an
 * open-invoice list, decided in SQL.
 *
 * The Customer Ledger dialog used to fetch one keyset page of *every* invoice
 * for the customer (newest first) and filter for open ones in the browser, so a
 * customer with a page of settled invoices could see an empty list while older
 * invoices were still unpaid. `openOnly` moves the decision into the WHERE
 * clause that the keyset/paged/count queries share, which is what these tests
 * pin — without the option the fragment is absent, with it every list shape
 * carries it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildSalesInvoiceCountQuery,
  buildSalesInvoiceKeysetQuery,
  buildSalesInvoicePagedQuery,
  buildSalesInvoiceWhere,
} from '../server/src/models/sales.repo';

const OPEN_CLAUSE = "status = 'POSTED' AND amount_paid < grand_total - 0.005";

describe('sales-invoice open-only filter', () => {
  test('openOnly adds the posted-with-balance clause and no parameter', () => {
    const { whereSql, params } = buildSalesInvoiceWhere({ openOnly: true });
    assert.match(whereSql, new RegExp(OPEN_CLAUSE.replace(/\./g, '\\.')));
    assert.deepEqual(params, [], 'the clause is fixed text, not an input');
  });

  test('the string forms an HTTP query produces are accepted, and false is not', () => {
    assert.match(buildSalesInvoiceWhere({ openOnly: '1' }).whereSql, /amount_paid < grand_total/);
    assert.match(buildSalesInvoiceWhere({ openOnly: 'true' }).whereSql, /amount_paid < grand_total/);
    assert.doesNotMatch(buildSalesInvoiceWhere({ openOnly: false }).whereSql, /amount_paid </);
    assert.doesNotMatch(buildSalesInvoiceWhere({ openOnly: '0' }).whereSql, /amount_paid </);
    assert.doesNotMatch(buildSalesInvoiceWhere({}).whereSql, /amount_paid </);
  });

  test('the clause composes with the customer/branch filters and keeps numbering', () => {
    const { whereSql, params } = buildSalesInvoiceWhere({
      branchId: 'B1',
      customerId: 'C1',
      openOnly: true,
    });
    assert.deepEqual(params, ['B1', 'C1']);
    assert.match(whereSql, /branch_id = \$1/);
    assert.match(whereSql, /customer_id = \$2/);
    assert.ok(
      whereSql.indexOf("status = 'POSTED'") > whereSql.indexOf('customer_id = $2'),
      'the clause is appended after the caller filters'
    );
  });

  test('every list shape uses the same where fragment', () => {
    const opts = { customerId: 'C1', openOnly: true };
    assert.match(buildSalesInvoiceKeysetQuery(opts, undefined, 20).sql, /amount_paid < grand_total/);
    assert.match(buildSalesInvoicePagedQuery(opts, { page: 1, pageSize: 20 }).sql, /amount_paid < grand_total/);
    assert.match(buildSalesInvoiceCountQuery(opts).sql, /amount_paid < grand_total/);
    const keyset = buildSalesInvoiceKeysetQuery(opts, ['2026-11-01T00:00:00.000Z', 'x'], 20);
    assert.match(keyset.sql, /amount_paid < grand_total/);
    assert.deepEqual(keyset.params, ['C1', '2026-11-01T00:00:00.000Z', 'x']);
  });

  test('the controller and the Receive Payment dialog both ask for it', () => {
    const controller = fs.readFileSync('server/src/controllers/sales.controller.ts', 'utf8');
    assert.match(controller, /dateToAD, openOnly, page/);
    assert.match(controller, /dateToAD \|\| openOnly/);
    assert.match(controller, /dateToAD, openOnly \}/);

    const api = fs.readFileSync('client/src/services/api/sales.ts', 'utf8');
    assert.match(api, /openOnly\?: boolean/);
    assert.match(api, /search\.append\('openOnly', '1'\)/);

    const ledger = fs.readFileSync('client/src/features/finance/CustomerLedger.tsx', 'utf8');
    assert.match(ledger, /openOnly: true/);
  });
});
