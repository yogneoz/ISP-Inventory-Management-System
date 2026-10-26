/**
 * Unit tests for the masterdata repo query builders (node:test).
 * Verifies SQL text and param ordering without a live database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertUomParams,
  updateUomParams,
  buildLocationSelectSql,
  supplierUpsertParams,
  supplierUpdateParams,
  productUpdateParams,
  categoryUpdateParams,
  buildCustomerListQuery,
  buildCustomerListAggregateQuery,
  customerUpsertParams,
  CUSTOMER_SELECT_COLUMNS,
  CUSTOMER_SEARCH_TEXT_SQL,
} from '../server/src/models/masterdata.repo';

describe('uom params', () => {
  test('upsertUomParams preserves column order', () => {
    const u = { id: 'uom-1', name: 'Meter', symbol: 'm', type: 'Length', isBaseUnit: true };
    assert.deepEqual(upsertUomParams(u), ['uom-1', 'Meter', 'm', 'Length', true]);
  });

  test('updateUomParams coerces isBaseUnit and appends the id last', () => {
    const params = updateUomParams({ name: 'Unit', symbol: 'u', type: 'Count', isBaseUnit: '1' as any }, 'uom-9');
    assert.deepEqual(params, ['Unit', 'u', 'Count', true, 'uom-9']);
  });
});

describe('buildLocationSelectSql', () => {
  test('adds a branch filter and one param for a concrete branchId', () => {
    const { sql, params } = buildLocationSelectSql('WH001');
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY name ASC$/);
    assert.deepEqual(params, ['WH001']);
  });

  test('no filter for ALL or missing branchId', () => {
    for (const branchId of ['ALL', undefined]) {
      const { sql, params } = buildLocationSelectSql(branchId);
      assert.match(sql, / ORDER BY name ASC$/);
      assert.ok(!sql.includes(' WHERE '));
      assert.deepEqual(params, []);
    }
  });

  test('selects all aliased columns', () => {
    const { sql } = buildLocationSelectSql();
    for (const alias of ['"branchId"', '"contactPerson"', '"contactPhone"', '"activeAssetsCount"']) {
      assert.ok(sql.includes(alias), `missing ${alias}`);
    }
  });
});

describe('supplier params', () => {
  test('upsert passes all ten columns through', () => {
    const s = { id: 's1', supplierCode: 'SUP-1', name: 'Acme', contactPerson: 'x', phone: 'p', email: 'e', address: 'a', panVatNumber: 'v', rating: 4.5, status: 'ACTIVE' };
    assert.equal(supplierUpsertParams(s).length, 10);
    assert.deepEqual(supplierUpsertParams(s), [s.id, s.supplierCode, s.name, s.contactPerson, s.phone, s.email, s.address, s.panVatNumber, s.rating, s.status]);
  });

  test('update applies the production defaults for empty fields', () => {
    const params = supplierUpdateParams({ supplierCode: null, name: 'Acme', rating: undefined, status: undefined }, 's1');
    assert.deepEqual(params, ['', 'Acme', '', '', '', '', '', 5.0, 'ACTIVE', 's1']);
  });
});

describe('productUpdateParams', () => {
  test('applies numeric and string defaults verbatim from the controller', () => {
    const p = { sku: 'SKU-1', name: 'Router', category: 'CPE' };
    const params = productUpdateParams(p, 'prod-1');
    assert.deepEqual(params, [
      'SKU-1', '', 'Router', 'CPE', 'Product Item', 'Pcs',
      0, 0, 13, 5, false, 'QUANTITY_ONLY', '', 'ACTIVE', 'prod-1',
    ]);
    assert.equal(params.length, 15);
  });

  test('preserves supplied truthy values over defaults', () => {
    const params = productUpdateParams({ sku: 'S', name: 'N', category: 'C', taxRate: 5, minReorderLevel: 2, status: 'INACTIVE' }, 'id1');
    assert.equal(params[8], 5);
    assert.equal(params[9], 2);
    assert.equal(params[13], 'INACTIVE');
  });

  test('preserves an explicit zero taxRate (VAT exempt) instead of resetting it', () => {
    // Was pinned as the "production quirk" `Number(p.taxRate) || 13`: a product
    // saved with taxRate 0 silently became a 13% product again. The repo now
    // treats 0 as a real value and falls back only for missing/invalid input.
    const params = productUpdateParams({ sku: 'S', name: 'N', category: 'C', taxRate: 0 }, 'id1');
    assert.equal(params[8], 0);
  });

  test('falls back to the company-configured default for a missing taxRate', () => {
    const params = productUpdateParams({ sku: 'S', name: 'N', category: 'C' }, 'id1', 15);
    assert.equal(params[8], 15);
    assert.equal(productUpdateParams({ taxRate: 'abc' }, 'id1')[8], 13);
  });
});

describe('categoryUpdateParams', () => {
  test('defaults description and coerces isSpecialTracked', () => {
    const params = categoryUpdateParams({ name: 'Fiber', code: 'FIB', description: undefined, isSpecialTracked: 1 }, 'cat-1');
    assert.deepEqual(params, ['Fiber', 'FIB', '', true, 'cat-1']);
  });
});

describe('buildCustomerListQuery', () => {
  test('base query has no WHERE, orders deterministically and pages by default', () => {
    const { sql, params, page, pageSize } = buildCustomerListQuery();
    assert.ok(sql.startsWith(`SELECT ${CUSTOMER_SELECT_COLUMNS} FROM customer_records`));
    assert.ok(!sql.includes(' WHERE '));
    assert.match(sql, / ORDER BY customer_name ASC, customer_id ASC LIMIT 15 OFFSET 0$/);
    assert.deepEqual(params, []);
    assert.equal(page, 1);
    assert.equal(pageSize, 15);
  });

  test('ALL behaves like no branch filter', () => {
    const { sql, params } = buildCustomerListQuery({ branchId: 'ALL' });
    assert.ok(!sql.includes(' WHERE '));
    assert.deepEqual(params, []);
  });

  test('branch filter uses the first placeholder', () => {
    const { sql, params } = buildCustomerListQuery({ branchId: 'BR1' });
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY/);
    assert.deepEqual(params, ['BR1']);
  });

  test('search wraps the term in lowercase wildcards', () => {
    const { params } = buildCustomerListQuery({ query: '  Sharma ' });
    assert.deepEqual(params, ['%sharma%']);
  });

  test('combines branch + search + status in placeholder order', () => {
    const { sql, params } = buildCustomerListQuery({ branchId: 'BR2', query: 'cus', status: 'active' });
    // VOL-4a: search must run against the single expression the trigram index
    // covers, not per-column LIKEs that force a sequential scan.
    assert.ok(sql.includes(`WHERE branch_id = $1 AND ${CUSTOMER_SEARCH_TEXT_SQL} LIKE $2`));
    assert.match(sql, /AND status = \$3/);
    assert.deepEqual(params, ['BR2', '%cus%', 'ACTIVE']);
  });

  test('search clause covers all six searchable columns', () => {
    for (const col of ['customer_id', 'customer_name', 'username', 'contact_number', 'email', 'address']) {
      assert.ok(CUSTOMER_SEARCH_TEXT_SQL.includes(`COALESCE(${col}, '')`), `missing ${col}`);
    }
  });

  test('branchScope pins the read to the server-resolved branch list', () => {
    const { sql, params } = buildCustomerListQuery({ branchScope: ['BR1', 'BR2'], branchId: 'ALL' });
    assert.match(sql, /WHERE branch_id = ANY\(\$1\)/);
    assert.deepEqual(params, [['BR1', 'BR2']]);
  });

  test('an empty branchScope yields no rows instead of an unfiltered read', () => {
    const { sql, params } = buildCustomerListQuery({ branchScope: [] });
    assert.match(sql, /WHERE FALSE/);
    assert.deepEqual(params, []);
  });

  test('clamps page and pageSize before they reach SQL', () => {
    const low = buildCustomerListQuery({ page: '0', pageSize: '9999' });
    assert.equal(low.page, 1);
    assert.equal(low.pageSize, 100);
    assert.match(low.sql, /LIMIT 100 OFFSET 0$/);

    const later = buildCustomerListQuery({ page: '3', pageSize: '25' });
    assert.equal(later.page, 3);
    assert.equal(later.pageSize, 25);
    assert.match(later.sql, /LIMIT 25 OFFSET 50$/);

    const garbage = buildCustomerListQuery({ page: 'abc', pageSize: '' });
    assert.equal(garbage.page, 1);
    assert.equal(garbage.pageSize, 15);
  });

  test('all=1 omits LIMIT/OFFSET for the CSV export', () => {
    const { sql, page, pageSize } = buildCustomerListQuery({ all: true, page: '4' });
    assert.ok(!sql.includes('LIMIT'));
    assert.ok(!sql.includes('OFFSET'));
    assert.equal(page, 4);
    assert.equal(pageSize, 0, 'the caller replaces 0 with the exported row count');
  });

  test('an unknown status is ignored rather than injected', () => {
    const { sql, params } = buildCustomerListQuery({ status: "ACTIVE' OR 1=1 --" });
    assert.ok(!sql.includes('status ='));
    assert.deepEqual(params, []);
  });
});

describe('buildCustomerListAggregateQuery', () => {
  test('counts all, active-only rows and credit under the same WHERE', () => {
    const { sql, params } = buildCustomerListAggregateQuery({ branchId: 'BR1', query: 'sh', status: 'INACTIVE' });
    assert.match(sql, /SELECT COUNT\(\*\)::int AS count/);
    assert.match(sql, /COUNT\(\*\) FILTER \(WHERE status = 'ACTIVE'\)::int AS active/);
    assert.match(sql, /COALESCE\(SUM\(credit_limit\), 0\)::float AS credit/);
    assert.ok(sql.includes(`WHERE branch_id = $1 AND ${CUSTOMER_SEARCH_TEXT_SQL} LIKE $2`));
    assert.match(sql, /AND status = \$3/);
    assert.deepEqual(params, ['BR1', '%sh%', 'INACTIVE']);
  });

  test('no filters means an unfiltered aggregate', () => {
    const { sql, params } = buildCustomerListAggregateQuery();
    assert.ok(!sql.includes(' WHERE '));
    assert.deepEqual(params, []);
  });
});

describe('customerUpsertParams', () => {
  test('carries all eleven columns in SQL order', () => {
    const c = { id: 'i', customerId: 'CUS-1', customerName: 'N', username: 'u', contactNumber: '9', branchId: 'B', address: 'A', email: 'e', status: 'ACTIVE', creditLimit: 100, assignedDevicesCount: 3 };
    assert.equal(customerUpsertParams(c).length, 11);
    assert.deepEqual(customerUpsertParams(c), ['i', 'CUS-1', 'N', 'u', '9', 'B', 'A', 'e', 'ACTIVE', 100, 3]);
  });
});
