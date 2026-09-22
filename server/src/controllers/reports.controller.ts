/**
 * Reports controller — HTTP orchestration for the reports domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pickCurrentFiscalYear, mutable, fiscalYears, pgPool, inventoryStock, assetRegister, purchaseInvoices, stockOperations, products, computeTradingFromOps } from '../app';
import {
  buildInventoryValueQuery,
  buildFixedAssetValueQuery,
  buildPurchaseInvoiceTotalsQuery,
  buildVendorOpeningBalanceQuery,
  buildVendorPaymentsQuery,
  buildDamageLossQuery,
  buildStockOutOpsQuery,
  PRODUCT_COST_PRICE_SQL,
} from '../models/reports.repo';
/** Forwarded from reports.routes.ts (get_financialSummary). */
export async function get_financialSummary(req: any, res: Response): Promise<any> {
const { branchId, fiscalYearId } = req.query;

  if (getPgConnected()) {
    try {
      const hasBranch = Boolean(branchId && branchId !== 'ALL');

      // Fiscal-year scoping: for any year OTHER than the current fiscal year,
      // inventory is valued from that year's opening-stock ledger
      // (fiscal_year_opening_stock) — the live inventory_stock balance only
      // represents the current fiscal year and must not be reported for
      // past/closed years.
      const currentFy = pickCurrentFiscalYear(mutable(fiscalYears)) || null;
      const requestedFy = fiscalYearId
        ? fiscalYears.find((f) => f.id === fiscalYearId || f.code === fiscalYearId)
        : undefined;
      const useOpeningStock = Boolean(requestedFy && currentFy && requestedFy.id !== currentFy.id);

      // Inventory Asset Value: SUM(quantity * cost_price)
      const { sql: invSql, params: invParams } = buildInventoryValueQuery({
        useOpeningStock,
        fiscalYearId: requestedFy?.id,
        branchId: hasBranch ? branchId : undefined,
      });
      const invRes = await pgPool.query(invSql, invParams);
      const totalInventoryAssetValue = Number(invRes.rows[0]?.total || 0);

      // Fixed Asset Value (net book value is a live snapshot; the system does
      // not track per-fiscal-year NBV history)
      const { sql: assetSql, params: assetParams } = buildFixedAssetValueQuery(hasBranch, branchId);
      const assetRes = await pgPool.query(assetSql, assetParams);
      const totalFixedAssetValue = Number(assetRes.rows[0]?.total || 0);

      // Accounts Payable & VAT Input Tax (scoped to the selected fiscal year)
      // AP = opening balance (from vendor_opening_balances, i.e. the carry-forward
      // from the prior FY close) + current-period unpaid invoices − posted payments.
      const invPayQuery = buildPurchaseInvoiceTotalsQuery({
        fiscalYearId: requestedFy?.id,
        branchId: hasBranch ? branchId : undefined,
      });
      const invPayRes = await pgPool.query(invPayQuery.sql, invPayQuery.params);
      // Opening balance carry-forward (same FY + branch scope)
      const obQuery = buildVendorOpeningBalanceQuery({
        fiscalYearId: requestedFy?.id,
        branchId: hasBranch ? branchId : undefined,
      });
      const obRes = await pgPool.query(obQuery.sql, obQuery.params);
      // Posted vendor payments in the same scope. Note: vendor payments are
      // scoped by payment_date_ad date range (like the bootstrap endpoint),
      // because older payments may have a NULL fiscal_year_id.
      const vpQuery = buildVendorPaymentsQuery({
        startDateAD: requestedFy?.startDateAD,
        endDateAD: requestedFy?.endDateAD,
        branchId: hasBranch ? branchId : undefined,
      });
      const vpPayRes = await pgPool.query(vpQuery.sql, vpQuery.params);
      const vendorOpeningBal = Number(obRes.rows[0]?.total_ob || 0);
      const currentPeriodInvoiced = Number(invPayRes.rows[0]?.total_invoiced || 0);
      const postedPayments = Number(vpPayRes.rows[0]?.total_paid || 0);
      const totalAccountsPayable = vendorOpeningBal + currentPeriodInvoiced - postedPayments;
      const totalVatInputTax = Number(invPayRes.rows[0]?.total_vat || 0);

      // Damage Loss Value (scoped to the selected fiscal year)
      const opQuery = buildDamageLossQuery({
        fiscalYearId: requestedFy?.id,
        branchId: hasBranch ? branchId : undefined,
      });
      const opRes = await pgPool.query(opQuery.sql, opQuery.params);
      const totalDamageLossValue = Number(opRes.rows[0]?.total || 0);

      // Sales Revenue + Cost of Goods Sold: fetch the priced STOCK_OUT sale
      // operations in the same FY/branch scope as inventory, then derive both
      // numbers from the sale lines (identical logic to the bootstrap helper).
      const saleQuery = buildStockOutOpsQuery({
        startDateAD: requestedFy?.startDateAD,
        endDateAD: requestedFy?.endDateAD,
        branchId: hasBranch ? branchId : undefined,
      });
      const saleRes = await pgPool.query(saleQuery.sql, saleQuery.params);
      const saleResRows: any[] = saleRes.rows || [];
      const saleLines = saleResRows.flatMap((r: any) => {
        const lines = Array.isArray(r.items) ? r.items : [];
        return lines.filter(
          (it: any) => it.totalValue !== undefined || it.sellingPrice !== undefined
        );
      });

      // Products are needed to resolve cost for lines that don't carry unitCost.
      const prodResForCogs = await pgPool.query(PRODUCT_COST_PRICE_SQL);
      const productsForCogs = prodResForCogs.rows;
      let totalSalesRevenue = 0;
      let totalCostOfGoodsSold = 0;
      for (const it of saleLines) {
        const qty = Number(it.quantity) || 0;
        const revenue = Number(it.totalValue) || Math.max(
          0,
          qty * (Number(it.sellingPrice) || 0) - (Number(it.discount) || 0)
        );
        if (revenue > 0) totalSalesRevenue += revenue;
        if (qty > 0) {
          const prod = productsForCogs.find((p: any) => p.id === it.productId);
          const unitCost = Number(it.unitCost) || (prod ? Number(prod.costPrice) : 0);
          totalCostOfGoodsSold += qty * unitCost;
        }
      }

      const currentFyCode = currentFy?.code || '2082/83';

      return res.json({
        totalInventoryAssetValue,
        totalFixedAssetValue,
        totalAccountsPayable,
        totalSalesRevenue,
        totalCostOfGoodsSold,
        totalDamageLossValue,
        totalVatInputTax,
        currentFiscalYear: requestedFy ? requestedFy.code : currentFyCode,
        fiscalYearId: requestedFy ? requestedFy.id : null,
      });
    } catch (err) {
      console.error('Error fetching financial summary report from DB:', err);
    }
  }

  let targetStock = inventoryStock;
  let targetAssets = assetRegister;
  let targetInvoices = purchaseInvoices;
  let targetOps = stockOperations;

  if (branchId && branchId !== 'ALL') {
    targetStock = inventoryStock.filter((s) => s.branchId === branchId);
    targetAssets = assetRegister.filter((a) => a.branchId === branchId);
    targetInvoices = purchaseInvoices.filter((inv) => inv.branchId === branchId);
    targetOps = stockOperations.filter((op) => op.branchId === branchId);
  }

  const totalInventoryAssetValue = targetStock.reduce((sum, item) => {
    const prod = products.find((p) => p.id === item.productId);
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

  // In-memory fallback: derive the trading summary from the same STOCK_OUT
  // sale-op lines (identical rules as the Postgres path).
  const inMemTrading = computeTradingFromOps(targetOps, products);

  const currentFy = pickCurrentFiscalYear(mutable(fiscalYears))?.code || '2082/83';

  res.json({
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalSalesRevenue: inMemTrading.totalSalesRevenue,
    totalCostOfGoodsSold: inMemTrading.totalCostOfGoodsSold,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
    fiscalYearId: null,
  });

}

