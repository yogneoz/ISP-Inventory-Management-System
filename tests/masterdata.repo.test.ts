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
  customerUpsertParams,
  CUSTOMER_SELECT_COLUMNS,
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

  test('preserves the production quirk: zero taxRate falls back to the default 13 (falsy ||)', () => {
    const params = productUpdateParams({ sku: 'S', name: 'N', category: 'C', taxRate: 0 }, 'id1');
    assert.equal(params[8], 13);
  });
});

describe('categoryUpdateParams', () => {
  test('defaults description and coerces isSpecialTracked', () => {
    const params = categoryUpdateParams({ name: 'Fiber', code: 'FIB', description: undefined, isSpecialTracked: 1 }, 'cat-1');
    assert.deepEqual(params, ['Fiber', 'FIB', '', true, 'cat-1']);
  });
});

describe('buildCustomerListQuery', () => {
  test('base query has no WHERE and orders by customer_name', () => {
    const { sql, params } = buildCustomerListQuery();
    assert.ok(sql.startsWith(`SELECT ${CUSTOMER_SELECT_COLUMNS} FROM customer_records`));
    assert.ok(!sql.includes(' WHERE '));
    assert.match(sql, / ORDER BY customer_name ASC$/);
    assert.deepEqual(params, []);
  });

  test('ALL behaves like no branch filter', () => {
    const { sql, params } = buildCustomerListQuery('ALL');
    assert.ok(!sql.includes(' WHERE '));
    assert.deepEqual(params, []);
  });

  test('branch filter uses the first placeholder', () => {
    const { sql, params } = buildCustomerListQuery('BR1');
    assert.match(sql, / WHERE branch_id = \$1 ORDER BY/);
    assert.deepEqual(params, ['BR1']);
  });

  test('search wraps the term in lowercase wildcards', () => {
    const { params } = buildCustomerListQuery(undefined, '  Sharma ');
    assert.deepEqual(params, ['%sharma%']);
  });

  test('combines branch + search with AND and correct placeholder order', () => {
    const { sql, params } = buildCustomerListQuery('BR2', 'cus');
    assert.match(sql, /WHERE branch_id = \$1 AND \(LOWER\(customer_id\) LIKE \$2/);
    assert.deepEqual(params, ['BR2', '%cus%']);
  });

  test('search clause covers all six searchable columns', () => {
    const { sql } = buildCustomerListQuery(undefined, 'x');
    for (const col of ['customer_id', 'customer_name', 'username', 'contact_number', 'email', 'address']) {
      assert.ok(sql.includes(`LOWER(${col}) LIKE`), `missing ${col}`);
    }
  });
});

describe('customerUpsertParams', () => {
  test('carries all eleven columns in SQL order', () => {
    const c = { id: 'i', customerId: 'CUS-1', customerName: 'N', username: 'u', contactNumber: '9', branchId: 'B', address: 'A', email: 'e', status: 'ACTIVE', creditLimit: 100, assignedDevicesCount: 3 };
    assert.equal(customerUpsertParams(c).length, 11);
    assert.deepEqual(customerUpsertParams(c), ['i', 'CUS-1', 'N', 'u', '9', 'B', 'A', 'e', 'ACTIVE', 100, 3]);
  });
});
