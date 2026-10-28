/**
 * Product-group behaviour lookup (client twin of the server's
 * product_groups.behavior column).
 *
 * A group's NAME is customer-editable master data; its BEHAVIOUR is the fixed
 * business rule the app implements. Every screen that used to compare
 * `productGroup === 'Fixed Asset'` now asks this module instead, so an operator
 * who renames "Fixed Asset" to "Capital Equipment", or adds "Vehicles", gets the
 * same sales / issuing / depreciation rules without a code change.
 *
 * The list is seeded from the bootstrap payload in App.tsx (the same place the
 * company VAT rate is applied) and refreshed by the two screens that own the
 * data. Until it lands, BUILT_IN_PRODUCT_GROUPS reproduces the three groups the
 * app shipped with — the exact behaviour the hard-coded literals had — so a
 * first paint, a demo run and a unit test never guess differently.
 */
import type { Product, ProductGroup, ProductGroupBehavior } from '../types';

export const PRODUCT_GROUP_BEHAVIORS: readonly ProductGroupBehavior[] = [
  'STOCK_ITEM',
  'CONSUMABLE',
  'FIXED_ASSET',
];

/** The three groups the app shipped with, used before the server list arrives. */
export const BUILT_IN_PRODUCT_GROUPS: readonly ProductGroup[] = [
  { id: 'pg-product-item', code: 'PRODUCT_ITEM', name: 'Product Item', behavior: 'STOCK_ITEM', sortOrder: 10, active: true, isSystem: true },
  { id: 'pg-consumable-item', code: 'CONSUMABLE_ITEM', name: 'Consumable Item', behavior: 'CONSUMABLE', sortOrder: 20, active: true, isSystem: true },
  { id: 'pg-fixed-asset', code: 'FIXED_ASSET', name: 'Fixed Asset', behavior: 'FIXED_ASSET', sortOrder: 30, active: true, isSystem: true },
];

let currentGroups: readonly ProductGroup[] = BUILT_IN_PRODUCT_GROUPS;

/**
 * Replaces the known groups. Ignores an empty/invalid payload so a failed or
 * not-yet-arrived fetch cannot blank the lookup (a blank lookup would silently
 * turn every group into a stock item).
 */
export function setProductGroups(value?: readonly ProductGroup[] | null): void {
  if (!Array.isArray(value)) return;
  const valid = value.filter(
    (group): group is ProductGroup =>
      Boolean(group?.name) && PRODUCT_GROUP_BEHAVIORS.includes(group.behavior)
  );
  if (valid.length > 0) currentGroups = valid;
}

/** Every known group, in server sort order (active and retired). */
export function getProductGroups(): readonly ProductGroup[] {
  return currentGroups;
}

/** Groups a NEW product may be assigned to. */
export function activeProductGroups(): ProductGroup[] {
  return currentGroups.filter((group) => group.active);
}

/** Case-insensitive lookup by display name (the value stored on products). */
export function findProductGroup(name?: string | null): ProductGroup | undefined {
  const clean = String(name ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  return currentGroups.find(
    (group) => group.name.toLowerCase() === clean || group.code.toLowerCase() === clean
  );
}

/**
 * Behaviour for a stored group name. An unknown name (a legacy row whose group
 * was deleted, or a payload that has not loaded yet) is treated as a stock
 * item: that is what every value except the two special names meant before
 * groups became master data, so nothing silently stops being sellable.
 */
export function behaviorOf(name?: string | null): ProductGroupBehavior {
  return findProductGroup(name)?.behavior ?? 'STOCK_ITEM';
}

/** Sellable catalog items (sales invoice lines, product-sale panel). */
export function isSellableProduct(product?: Pick<Product, 'productGroup'> | null): boolean {
  return behaviorOf(product?.productGroup) === 'STOCK_ITEM';
}

/** Quantity-only material issued to jobs/technicians. */
export function isConsumableProduct(product?: Pick<Product, 'productGroup'> | null): boolean {
  return behaviorOf(product?.productGroup) === 'CONSUMABLE';
}

/** Capitalised equipment: depreciation block, asset register, deployments. */
export function isFixedAssetProduct(product?: Pick<Product, 'productGroup'> | null): boolean {
  return behaviorOf(product?.productGroup) === 'FIXED_ASSET';
}

/** Short human explanation of each behaviour, used by the management screen. */
export const PRODUCT_GROUP_BEHAVIOR_LABELS: Record<ProductGroupBehavior, string> = {
  STOCK_ITEM: 'Stock item — sellable on invoices, optionally serial-tracked',
  CONSUMABLE: 'Consumable — issued to jobs/technicians, tracked by quantity only',
  FIXED_ASSET: 'Fixed asset — capitalised, tagged and depreciated over its life',
};

/** Badge colour per behaviour, so a custom group keeps the right visual cue. */
export function productGroupBadgeClass(behavior: ProductGroupBehavior): string {
  if (behavior === 'FIXED_ASSET') {
    return 'bg-purple-50 dark:bg-purple-950/80 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800';
  }
  if (behavior === 'CONSUMABLE') {
    return 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800';
  }
  return 'bg-sky-50 dark:bg-sky-950/80 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800';
}

/** Emoji prefix kept from the original three-group badges. */
export function productGroupBadgeIcon(behavior: ProductGroupBehavior): string {
  if (behavior === 'FIXED_ASSET') return '🏢';
  if (behavior === 'CONSUMABLE') return '🛠️';
  return '📦';
}
