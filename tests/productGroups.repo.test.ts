/**
 * Product groups — schema contract + repo query builders (no database needed).
 *
 * Pins the three things that make the table safe:
 *   1. scripts/schema.sql seeds EXACTLY the groups seedData.ts declares, so a
 *      PG-less demo run and a PostgreSQL install start from the same list.
 *   2. products.product_group carries a FOREIGN KEY to product_groups(name)
 *      (ON UPDATE CASCADE / ON DELETE RESTRICT) and no longer the inline CHECK
 *      that pinned the column to three names.
 *   3. Every repo statement keeps its column/param order.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_GROUP_SELECT,
  PRODUCT_GROUP_UPSERT_SQL,
  productGroupUpsertParams,
  PRODUCT_GROUP_UPDATE_SQL,
  productGroupUpdateParams,
  PRODUCT_GROUP_DELETE_SQL,
  PRODUCT_GROUP_BY_NAME_SQL,
  productUpdateParams,
} from '../server/src/models/masterdata.repo';
import { INITIAL_PRODUCT_GROUPS } from '../server/src/config/seedData';

const ROOT = path.resolve('.');
const schemaSql = fs.readFileSync(path.join(ROOT, 'scripts/schema.sql'), 'utf8');

describe('product_groups schema', () => {
  test('schema.sql seeds exactly the groups seedData.ts declares', () => {
    const start = schemaSql.indexOf('INSERT INTO product_groups');
    assert.ok(start >= 0, 'schema.sql must seed the three built-in product groups');
    const seedSql = schemaSql.slice(start, schemaSql.indexOf(';', start));

    const seeded = [...seedSql.matchAll(
      /\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(TRUE|FALSE),\s*(TRUE|FALSE)\)/g
    )].map((match) => ({
      id: match[1],
      code: match[2],
      name: match[3],
      behavior: match[4],
      sortOrder: Number(match[5]),
      active: match[6] === 'TRUE',
      isSystem: match[7] === 'TRUE',
    }));

    assert.deepEqual(
      seeded,
      INITIAL_PRODUCT_GROUPS.map(({ id, code, name, behavior, sortOrder, active, isSystem }) => ({
        id, code, name, behavior, sortOrder, active, isSystem,
      })),
      'the PostgreSQL seed and the demo-mode seed drifted apart — a fresh install and a demo run would offer different groups'
    );
  });

  test('the seed is idempotent and never resurrects a renamed group', () => {
    const start = schemaSql.indexOf('INSERT INTO product_groups');
    const seedSql = schemaSql.slice(start, schemaSql.indexOf(';', start));
    assert.match(
      seedSql,
      /ON CONFLICT DO NOTHING/,
      'the seed must use an untargeted ON CONFLICT: a renamed group still owns its code, so a targeted conflict target could resurrect the old name'
    );
  });

  test('products.product_group references the group table instead of a hard-coded CHECK', () => {
    assert.doesNotMatch(
      schemaSql,
      /product_group VARCHAR\(50\) NOT NULL CHECK \(product_group IN/,
      'the inline three-name CHECK is back — new groups could never be stored'
    );
    assert.match(
      schemaSql,
      /product_group VARCHAR\(50\) NOT NULL REFERENCES product_groups\(name\) ON UPDATE CASCADE ON DELETE RESTRICT/,
      'product_group must reference product_groups(name) so a rename cascades and an in-use group cannot be deleted'
    );
  });

  test('an upgraded database drops the old CHECK and gains the FK', () => {
    assert.match(schemaSql, /ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_group_check/);
    assert.match(schemaSql, /FOREIGN KEY \(product_group\) REFERENCES product_groups\(name\)/);
    assert.match(schemaSql, /ON UPDATE CASCADE ON DELETE RESTRICT/);
  });

  test('behavior is constrained to the three behaviours the app implements', () => {
    assert.match(
      schemaSql,
      /behavior VARCHAR\(30\) NOT NULL CHECK \(behavior IN \('STOCK_ITEM', 'CONSUMABLE', 'FIXED_ASSET'\)\)/
    );
  });
});

describe('product group query builders', () => {
  test('select carries every field the list screens render', () => {
    for (const fragment of [
      'id', 'code', 'name', 'behavior',
      'sort_order AS "sortOrder"', 'active', 'is_system AS "isSystem"',
      'AS "productCount"',
    ]) {
      assert.ok(PRODUCT_GROUP_SELECT.includes(fragment), `PRODUCT_GROUP_SELECT is missing ${fragment}`);
    }
    assert.match(PRODUCT_GROUP_SELECT, /FROM product_groups g/);
    assert.match(PRODUCT_GROUP_SELECT, /ORDER BY g\.sort_order ASC, g\.name ASC/);
  });

  test('upsert params follow the INSERT column order', () => {
    const group = {
      id: 'pg-x', code: 'X', name: 'Vehicles', behavior: 'FIXED_ASSET',
      sortOrder: 40, active: true, isSystem: false,
    };
    assert.deepEqual(
      productGroupUpsertParams(group),
      ['pg-x', 'X', 'Vehicles', 'FIXED_ASSET', 40, true, false]
    );
    assert.match(PRODUCT_GROUP_UPSERT_SQL, /ON CONFLICT \(id\) DO UPDATE SET/);
    // A rename through the upsert still cascades through the foreign key.
    assert.match(PRODUCT_GROUP_UPSERT_SQL, /name = EXCLUDED\.name/);
  });

  test('update params follow the UPDATE order and the id comes last', () => {
    const group = { code: 'V', name: 'Vehicles', behavior: 'FIXED_ASSET', sortOrder: 5, active: false };
    assert.deepEqual(productGroupUpdateParams(group, 'pg-x'), ['V', 'Vehicles', 'FIXED_ASSET', 5, false, 'pg-x']);
    assert.match(PRODUCT_GROUP_UPDATE_SQL, /updated_at = CURRENT_TIMESTAMP/);
  });

  test('delete and lookup statements are parameterised', () => {
    assert.equal(PRODUCT_GROUP_DELETE_SQL.trim(), 'DELETE FROM product_groups WHERE id = $1;');
    assert.match(PRODUCT_GROUP_BY_NAME_SQL, /WHERE name = \$1/);
  });

  test('the product update builder no longer invents a group name', () => {
    // The controller resolves the group against the managed table first. A
    // fallback literal here would silently revive a name the operator renamed
    // or retired, so a missing value must stay missing (and fail loudly).
    const params = productUpdateParams({ sku: 'S', name: 'N', category: 'C' }, 'id1');
    assert.equal(params[4], undefined, 'productUpdateParams must not default product_group');
  });
});
