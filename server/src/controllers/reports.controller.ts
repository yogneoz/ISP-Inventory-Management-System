/**
 * Reports controller — HTTP orchestration for the reports domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Request, Response } from 'express';
import { getPgConnected, pickCurrentFiscalYear, mutable, fiscalYears, pgPool, inventoryStock, assetRegister, purchaseInvoices, stockOperations, products, computeTradingFromOps } from '../app';
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
      const invParams: any[] = [];
      let invSql: string;
      if (useOpeningStock) {
        invSql = `SELECT SUM(os.quantity_on_hand * p.cost_price) AS total
                  FROM fiscal_year_opening_stock os
                  JOIN products p ON os.product_id = p.id
                  WHERE os.fiscal_year_id = $1`;
        invParams.push(requestedFy!.id);
        if (hasBranch) {
          invParams.push(branchId);
          invSql += ` AND os.branch_id = $${invParams.length}`;
        }
      } else {
        invSql = `SELECT SUM(s.quantity_on_hand * p.cost_price) AS total
                  FROM inventory_stock s
                  JOIN products p ON s.product_id = p.id`;
        const conds: string[] = [];
        if (hasBranch) {
          invParams.push(branchId);
          conds.push(`s.branch_id = $${invParams.length}`);
        }
        if (conds.length) invSql += ` WHERE ${conds.join(' AND ')}`;
      }
      const invRes = await pgPool.query(invSql, invParams);
      const totalInventoryAssetValue = Number(invRes.rows[0]?.total || 0);

      // Fixed Asset Value (net book value is a live snapshot; the system does
      // not track per-fiscal-year NBV history)
      const assetRes = await pgPool.query(
        `SELECT SUM(net_book_value) AS total FROM fixed_assets` + (hasBranch ? ' WHERE branch_id = $1' : ''),
        hasBranch ? [branchId] : []
      );
      const totalFixedAssetValue = Number(assetRes.rows[0]?.total || 0);

      // Accounts Payable & VAT Input Tax (scoped to the selected fiscal year)
      // AP = opening balance (from vendor_opening_balances, i.e. the carry-forward
      // from the prior FY close) + current-period unpaid invoices − posted payments.
      const piConds: string[] = [];
      const piParams: any[] = [];
      if (requestedFy) {
        piParams.push(requestedFy.id);
        piConds.push(`fiscal_year_id = $${piParams.length}`);
      }
      if (hasBranch) {
        piParams.push(branchId);
        piConds.push(`branch_id = $${piParams.length}`);
      }
      const invPayRes = await pgPool.query(
        `SELECT SUM(grand_total) AS total_invoiced, SUM(vat_amount) AS total_vat FROM purchase_invoices` +
          (piConds.length ? ` WHERE ${piConds.join(' AND ')}` : ''),
        piParams
      );
      // Opening balance carry-forward (same FY + branch scope)
      const obParams: any[] = [];
      const obConds: string[] = [];
      if (requestedFy) {
        obParams.push(requestedFy.id);
        obConds.push(`fiscal_year_id = $${obParams.length}`);
      }
      if (hasBranch) {
        obParams.push(branchId);
        obConds.push(`branch_id = $${obParams.length}`);
      }
      const obRes = await pgPool.query(
        `SELECT COALESCE(SUM(opening_balance), 0)::float AS total_ob FROM vendor_opening_balances` +
          (obConds.length ? ` WHERE ${obConds.join(' AND ')}` : ''),
        obParams
      );
      // Posted vendor payments in the same scope. Note: vendor payments are
      // scoped by payment_date_ad date range (like the bootstrap endpoint),
      // because older payments may have a NULL fiscal_year_id.
      const vpConds: string[] = [];
      const vpParams: any[] = [];
      if (requestedFy) {
        vpParams.push(requestedFy.startDateAD, requestedFy.endDateAD);
        vpConds.push(`payment_date_ad >= $${vpParams.length - 1}`);
        vpConds.push(`payment_date_ad <= $${vpParams.length}`);
      }
      if (hasBranch) {
        vpParams.push(branchId);
        vpConds.push(`branch_id = $${vpParams.length}`);
      }
      vpConds.push(`status = 'POSTED'`);
      const vpPayRes = await pgPool.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total_paid FROM vendor_payments` +
          (vpConds.length ? ` WHERE ${vpConds.join(' AND ')}` : ''),
        vpParams
      );
      const vendorOpeningBal = Number(obRes.rows[0]?.total_ob || 0);
      const currentPeriodInvoiced = Number(invPayRes.rows[0]?.total_invoiced || 0);
      const postedPayments = Number(vpPayRes.rows[0]?.total_paid || 0);
      const totalAccountsPayable = vendorOpeningBal + currentPeriodInvoiced - postedPayments;
      const totalVatInputTax = Number(invPayRes.rows[0]?.total_vat || 0);

      // Damage Loss Value (scoped to the selected fiscal year)
      const opConds: string[] = [];
      const opParams: any[] = [];
      if (requestedFy) {
        opParams.push(requestedFy.id);
        opConds.push(`fiscal_year_id = $${opParams.length}`);
      }
      if (hasBranch) {
        opParams.push(branchId);
        opConds.push(`branch_id = $${opParams.length}`);
      }
      const opRes = await pgPool.query(
        `SELECT SUM(total_value) AS total FROM stock_operations` +
          (opConds.length ? ` WHERE ${opConds.join(' AND ')}` : ''),
        opParams
      );
      const totalDamageLossValue = Number(opRes.rows[0]?.total || 0);

      // Sales Revenue + Cost of Goods Sold: fetch the priced STOCK_OUT sale
      // operations in the same FY/branch scope as inventory, then derive both
      // numbers from the sale lines (identical logic to the bootstrap helper).
      const saleConds: string[] = [`type = 'STOCK_OUT'`];
      const saleParams: any[] = [];
      if (requestedFy) {
        saleParams.push(requestedFy.startDateAD, requestedFy.endDateAD);
        saleConds.push(`date_ad >= $${saleParams.length - 1}`);
        saleConds.push(`date_ad <= $${saleParams.length}`);
      }
      if (hasBranch) {
        saleParams.push(branchId);
        saleConds.push(`branch_id = $${saleParams.length}`);
      }
      const saleRes = await pgPool.query(
        `SELECT items FROM stock_operations` +
          (saleConds.length ? ` WHERE ${saleConds.join(' AND ')}` : ''),
        saleParams
      );
      const saleResRows: any[] = saleRes.rows || [];
      const saleLines = saleResRows.flatMap((r: any) => {
        const lines = Array.isArray(r.items) ? r.items : [];
        return lines.filter(
          (it: any) => it.totalValue !== undefined || it.sellingPrice !== undefined
        );
      });

      // Products are needed to resolve cost for lines that don't carry unitCost.
      const prodResForCogs = await pgPool.query(
        'SELECT id, cost_price AS "costPrice" FROM products'
      );
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

