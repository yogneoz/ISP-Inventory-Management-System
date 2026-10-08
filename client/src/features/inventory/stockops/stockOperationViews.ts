/**
 * Shared StockOperations view derivations (FRONTEND-AUDIT.md §G commit 2).
 *
 * Cut VERBATIM out of the StockOperations host when its state relocated
 * into the tab panels: the synthesized damage log, the per-type tab-bar
 * counts, the branch/permission-filtered register list and the assignable
 * asset list — everything the host chrome still needs to render. Pure
 * function, deliberately not memoized: the host calls it on every render
 * exactly like the inline code this was cut from (same cost, same output).
 */
import type { StockOperation, Product, InventoryStock, Asset } from '../../../types';
import { tryConvertADToBS, getNepaliFiscalYear } from '../../../utils/nepaliCalendar';

export interface StockOperationViewsArgs {
  operations: StockOperation[];
  stock: InventoryStock[];
  products: Product[];
  assets: Asset[];
  canSeeAll: boolean;
  allowedBranchIds: string[];
  branchFilter: string;
  activeTab: string;
}

export function computeStockOperationViews({
  operations,
  stock,
  products,
  assets,
  canSeeAll,
  allowedBranchIds,
  branchFilter,
  activeTab,
}: StockOperationViewsArgs) {
  // Helper to check if an operation belongs to user's allowed branches
  const isOpInAllowedBranch = (op: StockOperation) => {
    if (canSeeAll) return true;
    return (
      (op.branchId && allowedBranchIds.includes(op.branchId)) ||
      (op.destinationWarehouseId && allowedBranchIds.includes(op.destinationWarehouseId))
    );
  };

  // Synthesize missing stock operation entries for inventory stock items that have damagedQty > 0
  const existingDamageOps = operations.filter((op) => op.type === 'DAMAGE' && isOpInAllowedBranch(op));
  const synthesizedDamageOps: StockOperation[] = [];
  stock.forEach((stk) => {
    if (stk.damagedQty && stk.damagedQty > 0) {
      if (isOpInAllowedBranch({ branchId: stk.branchId } as any)) {
        const hasMatchingOp = existingDamageOps.some(
          (op) => op.productId === stk.productId && op.branchId === stk.branchId
        );
        if (!hasMatchingOp) {
          const prod = products.find((p) => p.id === stk.productId);
          // Date integrity: derive BS + fiscal year from the AD date (no hardcoded values).
          const synDateAD = stk.lastUpdated ? stk.lastUpdated.split('T')[0] : new Date().toISOString().split('T')[0];
          const synDateBS = tryConvertADToBS(synDateAD);
          synthesizedDamageOps.push({
            id: `syn-dmg-${stk.id}`,
            referenceNumber: `DMG-${stk.branchId}-${stk.productId.replace('prod-', '').toUpperCase().slice(0, 8)}`,
            type: 'DAMAGE',
            branchId: stk.branchId,
            productId: stk.productId,
            productName: prod?.name || 'Damaged Stock Item',
            quantityChanged: -stk.damagedQty,
            costPerUnit: prod?.costPrice || 0,
            totalValue: stk.damagedQty * (prod?.costPrice || 0),
            reason: 'Physical branch inventory inspection & transit damage tag',
            inspectorName: 'Branch Quality Inspector',
            dateAD: synDateAD,
            dateBS: synDateBS?.formattedBSShort || '',
            fiscalYear: getNepaliFiscalYear(synDateAD),
          });
        }
      }
    }
  });

  const damageOperations = [...existingDamageOps, ...synthesizedDamageOps];
  const pulloutOperations = operations.filter((op) => op.type === 'PULLOUT' && isOpInAllowedBranch(op));
  const consumableOperations = operations.filter((op) => op.type === 'CONSUMABLE_ISSUE' && isOpInAllowedBranch(op));
  const saleOperations = operations.filter((op) => op.type === 'STOCK_OUT' && isOpInAllowedBranch(op));

  const allCombinedOps = [...operations, ...synthesizedDamageOps];

  // Filters for Stock Operations Logs
  const filteredOperations = allCombinedOps.filter((op) => {
    if (!isOpInAllowedBranch(op)) return false;

    const matchesBranch =
      branchFilter === 'ALL'
        ? true
        : op.branchId === branchFilter || op.destinationWarehouseId === branchFilter;

    if (!matchesBranch) return false;

    if (activeTab === 'PULLOUT_BINS') return op.type === 'PULLOUT';
    if (activeTab === 'DAMAGE_TRACKING') return op.type === 'DAMAGE' || op.type === 'DISPOSAL';
    if (activeTab === 'CONSUMABLE_ISSUE') return op.type === 'CONSUMABLE_ISSUE';
    if (activeTab === 'PRODUCT_SALE') return op.type === 'STOCK_OUT';
    return true;
  });

  // Available vs Assigned Fixed Assets
  const availableStockAssets = assets.filter(
    (a) => a.status === 'ACTIVE' && !a.assignedType
  );

  return {
    damageOperations,
    pulloutOperations,
    consumableOperations,
    saleOperations,
    allCombinedOps,
    filteredOperations,
    availableStockAssets,
  };
}
