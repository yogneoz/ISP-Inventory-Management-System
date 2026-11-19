/**
 * inventory mutations, lifted out of App.tsx.
 *
 * Each wrapper is the same call the root made inline: hit the API, then
 * refresh the shell. They live in a hook so the render code only wires
 * the returned handlers to screens.
 */
import { api } from '../services/api';
import type { Asset, Product } from '../types';
import type { ActionDeps } from './actionDeps';

export function useInventoryActions({ refreshAllData, currentUser, financialSummary }: ActionDeps) {
  const handleCreateProduct = async (prod: Omit<Product, 'id'>) => {
    await api.createProduct(prod);
    refreshAllData();
  };

  const handleUpdateProduct = async (id: string, prod: Partial<Product>) => {
    await api.updateProduct(id, prod);
    refreshAllData();
  };

  const handleDeleteProduct = async (id: string) => {
    await api.deleteProduct(id);
    refreshAllData();
  };

  const handleUpdateStockLevel = async (
    stockId: string,
    newQty: number,
    reason: string,
    damagedQty?: number,
    changeType?: string
  ) => {
    await api.updateStockLevel(stockId, newQty, reason, damagedQty, changeType);
    refreshAllData();
  };

  const handleUpdateStockReorderLevel = async (
    stockId: string,
    minReorderLevel: number
  ) => {
    await api.updateStockReorderLevel(stockId, minReorderLevel);
    refreshAllData();
  };

  const handleBulkUpdateStockReorderLevels = async (
    updates: { stockId: string; minReorderLevel: number }[]
  ) => {
    await api.bulkUpdateStockReorderLevels(updates);
    refreshAllData();
  };

  const handleCreateAsset = async (
    asset: Omit<Asset, 'id' | 'netBookValue' | 'accumulatedDepreciation'> & {
      /** WTY-4: exact supplier warranty expiry captured with the asset. */
      supplierWarrantyEndDateAD?: string;
      /** WTY-5: false declares "no supplier warranty" for this asset. */
      supplierWarrantyCovered?: boolean;
    }
  ) => {
    await api.createAsset(asset);

    // Stock-Out Integration: If asset has a productId associated, decrement branch inventory stock
    if (asset.productId) {
      await api.createStockOperation({
        type: 'STOCK_OUT',
        branchId: asset.branchId,
        productId: asset.productId,
        productName: asset.name,
        quantityChanged: -1,
        costPerUnit: asset.acquisitionCost,
        totalValue: asset.acquisitionCost,
        reason: `Fixed Asset Issued / Assigned: Tag ${asset.tagNumber} (${asset.name})`,
        inspectorName: currentUser?.name || 'Asset Manager',
        dateAD: asset.acquisitionDateAD,
        dateBS: asset.acquisitionDateBS,
        fiscalYear: financialSummary?.currentFiscalYear || '2081/82',
        status: 'LOGGED',
      });
    }

    refreshAllData();
  };

  const handleUpdateAssetStatus = async (id: string, updates: Asset['status'] | Partial<Asset>) => {
    await api.updateAssetStatus(id, updates);
    refreshAllData();
  };


  return {
    handleCreateProduct,
    handleUpdateProduct,
    handleDeleteProduct,
    handleUpdateStockLevel,
    handleUpdateStockReorderLevel,
    handleBulkUpdateStockReorderLevels,
    handleCreateAsset,
    handleUpdateAssetStatus,
  };
}
