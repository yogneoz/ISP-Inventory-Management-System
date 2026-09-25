/**
 * Trading summary helpers extracted from app.ts (backlog item #6 — app.ts
 * extraction). Pure function; consumers (bootstrap/reports controllers) pass
 * the stock operations and product lists they read.
 */

// ==========================================
// TRADING SUMMARY HELPERS (Sales Revenue + Cost of Goods Sold)
// ==========================================
// A "customer sale" is a stock_operations row of type STOCK_OUT that carries
// priced line items in its items JSONB (created by the Product Sale form in
// Branch Operations). Asset-issue stock-outs (items JSONB = []) reclassify
// inventory into Fixed Assets — they are NOT sales and are excluded here.
//
// Revenue and COGS are both derived from the same underlying sale lines so
// the two figures always share one source and reconcile with the balance
// sheet's "Merchandise Inventory (At Valuation)" (cost × quantity-on-hand).
export function computeTradingFromOps(ops: readonly any[], productsList: readonly any[]) {
  let totalSalesRevenue = 0;
  let totalCostOfGoodsSold = 0;
  for (const op of ops || []) {
    if (op.type !== 'STOCK_OUT') continue;
    const lines = Array.isArray(op.items) ? op.items : [];
    for (const it of lines) {
      // Asset-issue stock-outs carry no priced lines; skip them.
      if (it.totalValue === undefined && it.sellingPrice === undefined) continue;
      const qty = Number(it.quantity) || 0;
      const revenue = Number(it.totalValue) || Math.max(
        0,
        qty * (Number(it.sellingPrice) || 0) - (Number(it.discount) || 0)
      );
      if (revenue > 0) totalSalesRevenue += revenue;
      if (qty > 0) {
        const prod = (productsList || []).find((p: any) => p.id === it.productId);
        // Prefer the cost captured on the sale line; fall back to the current
        // product cost so COGS matches the merchandise valuation basis.
        const unitCost = Number(it.unitCost) || (prod ? Number(prod.costPrice) : 0);
        totalCostOfGoodsSold += qty * unitCost;
      }
    }
  }
  return { totalSalesRevenue, totalCostOfGoodsSold };
}
