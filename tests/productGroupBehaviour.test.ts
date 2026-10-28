/**
 * Product-group behaviour lookup — the client rule that replaced every
 * `productGroup === 'Fixed Asset'` literal.
 *
 * A group's name is customer-editable master data; its behaviour is the fixed
 * rule the app implements. These tests pin:
 *   1. The built-in fallback reproduces the three original groups before the
 *      server list lands (first paint / demo mode / tests).
 *   2. A renamed group keeps its behaviour: "Capital Equipment" still
 *      depreciates, still is not sellable.
 *   3. A newly added group is classified by its behaviour, not its name.
 *   4. An unknown or missing group falls back to STOCK_ITEM (today's meaning of
 *      every value except the two special names).
 *   5. An empty/failed payload never blanks the lookup.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PRODUCT_GROUPS,
  PRODUCT_GROUP_BEHAVIOR_LABELS,
  activeProductGroups,
  behaviorOf,
  findProductGroup,
  getProductGroups,
  isConsumableProduct,
  isFixedAssetProduct,
  isSellableProduct,
  productGroupBadgeClass,
  setProductGroups,
} from '../client/src/utils/productGroupBehavior';
import type { ProductGroup } from '../client/src/types';

const vehicles: ProductGroup = {
  id: 'pg-vehicles', code: 'VEHICLES', name: 'Vehicles',
  behavior: 'FIXED_ASSET', sortOrder: 40, active: true, isSystem: false,
};
const network: ProductGroup = {
  id: 'pg-network', code: 'NETWORK_EQUIPMENT', name: 'Network Equipment',
  behavior: 'STOCK_ITEM', sortOrder: 50, active: true, isSystem: false,
};
const capitalEquipment: ProductGroup = {
  id: 'pg-fixed-asset', code: 'FIXED_ASSET', name: 'Capital Equipment',
  behavior: 'FIXED_ASSET', sortOrder: 30, active: true, isSystem: true,
};

beforeEach(() => {
  setProductGroups(BUILT_IN_PRODUCT_GROUPS);
});

describe('built-in fallback', () => {
  test('the three shipped groups behave exactly as the old literals did', () => {
    assert.deepEqual(
      getProductGroups().map((group) => group.name),
      ['Product Item', 'Consumable Item', 'Fixed Asset']
    );
    assert.equal(behaviorOf('Product Item'), 'STOCK_ITEM');
    assert.equal(behaviorOf('Consumable Item'), 'CONSUMABLE');
    assert.equal(behaviorOf('Fixed Asset'), 'FIXED_ASSET');
    assert.equal(isSellableProduct({ productGroup: 'Product Item' }), true);
    assert.equal(isConsumableProduct({ productGroup: 'Consumable Item' }), true);
    assert.equal(isFixedAssetProduct({ productGroup: 'Fixed Asset' }), true);
  });

  test('lookup is case-insensitive and also resolves a code', () => {
    assert.equal(behaviorOf('fixed asset'), 'FIXED_ASSET');
    assert.equal(findProductGroup('FIXED_ASSET')?.name, 'Fixed Asset');
  });
});

describe('customer-defined groups', () => {
  test('a renamed fixed-asset group still depreciates and is still not sellable', () => {
    setProductGroups([capitalEquipment]);
    assert.equal(behaviorOf('Capital Equipment'), 'FIXED_ASSET');
    assert.equal(isFixedAssetProduct({ productGroup: 'Capital Equipment' }), true);
    assert.equal(isSellableProduct({ productGroup: 'Capital Equipment' }), false);
  });

  test('a new stock-item group is sellable', () => {
    setProductGroups([network, vehicles]);
    assert.equal(isSellableProduct({ productGroup: 'Network Equipment' }), true);
    assert.equal(isFixedAssetProduct({ productGroup: 'Network Equipment' }), false);
    assert.equal(isFixedAssetProduct({ productGroup: 'Vehicles' }), true);
  });

  test('an unknown or missing group falls back to STOCK_ITEM', () => {
    setProductGroups([vehicles]);
    assert.equal(behaviorOf('Deleted Group'), 'STOCK_ITEM');
    assert.equal(behaviorOf(undefined), 'STOCK_ITEM');
    assert.equal(behaviorOf(''), 'STOCK_ITEM');
    assert.equal(isSellableProduct({ productGroup: 'Deleted Group' }), true);
    assert.equal(isSellableProduct(null), true);
  });

  test('an empty or invalid payload never blanks the lookup', () => {
    setProductGroups([vehicles]);
    setProductGroups([]);
    setProductGroups(null);
    setProductGroups([{ ...vehicles, name: '', behavior: 'BOGUS' } as any]);
    assert.deepEqual(getProductGroups().map((group) => group.name), ['Vehicles'], 'the last valid list must survive');
  });

  test('only active groups are offered for a new product', () => {
    setProductGroups([network, { ...vehicles, active: false }]);
    assert.deepEqual(activeProductGroups().map((group) => group.name), ['Network Equipment']);
    // A retired group still resolves for the products already in it.
    assert.equal(behaviorOf('Vehicles'), 'FIXED_ASSET');
  });
});

describe('presentation helpers', () => {
  test('every behaviour has a label and a distinct badge colour', () => {
    const classes = new Set<string>();
    for (const behavior of ['STOCK_ITEM', 'CONSUMABLE', 'FIXED_ASSET'] as const) {
      assert.ok(PRODUCT_GROUP_BEHAVIOR_LABELS[behavior].length > 0);
      classes.add(productGroupBadgeClass(behavior));
    }
    assert.equal(classes.size, 3, 'behaviours must not share one badge colour');
  });
});
