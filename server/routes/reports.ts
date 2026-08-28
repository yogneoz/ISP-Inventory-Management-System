/**
 * Route module: reports
 */
import { Router } from 'express';
import * as store from '../store';
import { pgPool, isPgConnected } from '../lib/db';
import { readPgOrStore, num } from '../lib/pgReads';

import type { Asset } from '../../src/types';

const router = Router();

router.get('/api/reports/financial-summary', async (req, res) => {
  const { branchId } = req.query;

  if (isPgConnected) {
    try {
      const bParam = branchId && branchId !== 'ALL' ? [branchId] : [];
      const whereBranch = branchId && branchId !== 'ALL' ? ' WHERE branch_id = $1' : '';

      // Inventory Asset Value: SUM(quantity_on_hand * cost_price)
      const invRes = await pgPool.query(
        `SELECT SUM(s.quantity_on_hand * p.cost_price) AS total FROM inventory_stock s JOIN products p ON s.product_id = p.id` +
          (branchId && branchId !== 'ALL' ? ' WHERE s.branch_id = $1' : ''),
        bParam
      );
      const totalInventoryAssetValue = Number(invRes.rows[0]?.total || 0);

      // Fixed Asset Value
      const assetRes = await pgPool.query(
        `SELECT SUM(net_book_value) AS total FROM fixed_assets` + whereBranch,
        bParam
      );
      const totalFixedAssetValue = Number(assetRes.rows[0]?.total || 0);

      // Accounts Payable & VAT Input Tax
      const invPayRes = await pgPool.query(
        `SELECT SUM(GREATEST(0, grand_total - amount_paid)) AS total_ap, SUM(vat_amount) AS total_vat FROM purchase_invoices` + whereBranch,
        bParam
      );
      const totalAccountsPayable = Number(invPayRes.rows[0]?.total_ap || 0);
      const totalVatInputTax = Number(invPayRes.rows[0]?.total_vat || 0);

      // Damage Loss Value
      const opRes = await pgPool.query(
        `SELECT SUM(total_value) AS total FROM stock_operations` + whereBranch,
        bParam
      );
      const totalDamageLossValue = Number(opRes.rows[0]?.total || 0);

      const currentFy = store.fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

      return res.json({
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalCostOfGoodsSold: store.stockOperations.filter((op) => op.type === 'STOCK_OUT' || op.type === 'CONSUMABLE_ISSUE').reduce((sum, op) => sum + Number(op.totalValue || 0), 0),
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: currentFy,
      });
    } catch (err) {
      console.error('Error fetching financial summary report from DB:', err);
    }
  }

  let targetStock = store.inventoryStock;
  let targetAssets = store.assetRegister;
  let targetInvoices = store.purchaseInvoices;
  let targetOps = store.stockOperations;

  if (branchId && branchId !== 'ALL') {
    targetStock = store.inventoryStock.filter((s) => s.branchId === branchId);
    targetAssets = store.assetRegister.filter((a) => a.branchId === branchId);
    targetInvoices = store.purchaseInvoices.filter((inv) => inv.branchId === branchId);
    targetOps = store.stockOperations.filter((op) => op.branchId === branchId);
  }

  const totalInventoryAssetValue = targetStock.reduce((sum, item) => {
    const prod = store.products.find((p) => p.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
  }, 0);

  const totalFixedAssetValue = targetAssets.reduce(
    (sum, a) => sum + (a.netBookValue ?? 0),
    0
  );

  const totalAccountsPayable = targetInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );

  const totalDamageLossValue = targetOps.reduce(
    (sum, op) => sum + (op.totalValue ?? 0),
    0
  );

  const totalVatInputTax = targetInvoices.reduce(
    (sum, inv) => sum + (inv.vatAmount ?? 0),
    0
  );

  const currentFy = store.fiscalYears.find((f) => f.isCurrent)?.code || '2082/83';

  res.json({
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalCostOfGoodsSold: store.stockOperations.filter((op) => op.type === 'STOCK_OUT' || op.type === 'CONSUMABLE_ISSUE').reduce((sum, op) => sum + Number(op.totalValue || 0), 0),
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
  });
});

// Company Profile REST Endpoints

export default router;
