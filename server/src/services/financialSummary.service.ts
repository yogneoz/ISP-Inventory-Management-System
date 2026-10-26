/**
 * financialSummary — one computation, two read paths (DF-05).
 *
 * The summary used to exist only inside GET /api/bootstrap: it was derived
 * from the full operational-data fan-out and then disappeared from the
 * client's view until the next full bootstrap. A sale, payment or purchase
 * made by another client therefore left this tab's closing-wizard totals and
 * financial-statement fallback stale.
 *
 * The summary now has TWO producers that agree:
 *
 *  - `fetchFinancialSummaryFromDb` is the live producer for BOTH the full
 *    bootstrap and GET /api/bootstrap/local?key=financialSummary (BOOT-1,
 *    2026-10-26). It issues eight indexed aggregates; no item JSON leaves
 *    PostgreSQL. Before BOOT-1 the full bootstrap loaded every purchase
 *    invoice and stock operation just to feed the pure rule, then dropped
 *    those arrays from the payload — the dominant cost of a login at national
 *    volume.
 *  - `computeFinancialSummary` is the pure rule, kept as the parity oracle:
 *    tests/financialSummary.test.ts rebuilds its source from the same SQL rows
 *    and proves the aggregate producer matches it field for field.
 *
 * Both take the same branch/fiscal-year scope and apply the same formulas —
 * AP includes the posted purchase-return term. The pure rule computes trading
 * revenue/COGS with `computeTradingFromOps`; the SQL producer aggregates the
 * same rule (`buildTradingTotalsQuery`), and tests/tradingTotals.test.ts pins
 * the two together.
 */
import type { QueryExecutor } from '../models/bootstrap.repo';
import {
  buildInventoryValueQuery,
  buildFixedAssetValueQuery,
  buildPurchaseInvoiceTotalsQuery,
  buildVendorOpeningBalanceQuery,
  buildVendorPaymentsQuery,
  buildPurchaseReturnsTotalQuery,
  buildDamageLossQuery,
  buildTradingTotalsQuery,
} from '../models/reports.repo';
import { computeTradingFromOps } from '../utils/trading';

export interface FinancialSummary {
  totalInventoryAssetValue: number;
  totalFixedAssetValue: number;
  totalAccountsPayable: number;
  totalSalesRevenue: number;
  totalCostOfGoodsSold: number;
  totalDamageLossValue: number;
  totalVatInputTax: number;
  currentFiscalYear: string;
}

/** Everything the pure rule needs, in the shape the bootstrap already has. */
export interface FinancialSummarySource {
  stock: readonly any[];
  products: readonly any[];
  assets: readonly any[];
  purchaseInvoices: readonly any[];
  vendorPayments: readonly any[];
  purchaseReturns: readonly any[];
  stockOperations: readonly any[];
  vendorOpeningBalanceTotal: number;
  currentFiscalYear: string;
}

/** The scope both producers resolve before reading. */
export interface FinancialSummaryScope {
  branchId?: string;
  fiscalYearId: string;
  fiscalYearStartAD?: string;
  fiscalYearEndAD?: string;
  /** The year flagged current — reported even when the view is a past year. */
  currentFiscalYear: string;
  /** Past/closed years are valued from that year's opening-stock ledger. */
  useOpeningStock: boolean;
}

/**
 * The one rule. Keeping it pure means the bootstrap path and the SQL path
 * cannot drift into two different definitions of "accounts payable".
 */
export function computeFinancialSummary(source: FinancialSummarySource): FinancialSummary {
  const totalInventoryAssetValue = source.stock.reduce((sum: number, item: any) => {
    const product = source.products.find((p: any) => p.id === item.productId);
    return sum + (product ? Number(product.costPrice) * Number(item.quantityOnHand) : 0);
  }, 0);

  const totalFixedAssetValue = source.assets.reduce(
    (sum: number, a: any) => sum + Number(a.netBookValue || 0),
    0
  );

  // Accounts payable = opening carry-forward + current-period invoices −
  // posted vendor payments − posted purchase returns. Purchases are summed by
  // grand total (not grandTotal − amountPaid): payments are subtracted once
  // below, so using the net amount here would count them twice.
  const currentPeriodInvoiceTotal = source.purchaseInvoices.reduce(
    (sum: number, inv: any) => sum + Number(inv.grandTotal || 0),
    0
  );
  const postedPayments = source.vendorPayments
    .filter((p: any) => p.status === 'POSTED')
    .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
  const postedPurchaseReturns = source.purchaseReturns
    .filter((r: any) => r.status === 'POSTED')
    .reduce((sum: number, r: any) => sum + Number(r.grandTotal || 0), 0);
  const totalAccountsPayable =
    Number(source.vendorOpeningBalanceTotal || 0) +
    currentPeriodInvoiceTotal -
    postedPayments -
    postedPurchaseReturns;

  const totalDamageLossValue = source.stockOperations.reduce(
    (sum: number, op: any) => sum + Number(op.totalValue || 0),
    0
  );
  const totalVatInputTax = source.purchaseInvoices.reduce(
    (sum: number, inv: any) => sum + Number(inv.vatAmount || 0),
    0
  );

  const trading = computeTradingFromOps(source.stockOperations, source.products);

  return {
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalSalesRevenue: trading.totalSalesRevenue,
    totalCostOfGoodsSold: trading.totalCostOfGoodsSold,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: source.currentFiscalYear,
  };
}

/**
 * Aggregate-only summary for the full bootstrap and the targeted-refresh
 * slice. Eight indexed reads; no item JSON leaves PostgreSQL — the trading
 * totals are summed in SQL.
 */
export async function fetchFinancialSummaryFromDb(
  pool: QueryExecutor,
  scope: FinancialSummaryScope
): Promise<FinancialSummary> {
  const invoiceScope = {
    fiscalYearId: scope.fiscalYearId,
    branchId: scope.branchId,
    startDateAD: scope.fiscalYearStartAD,
    endDateAD: scope.fiscalYearEndAD,
  };
  const dateScope = {
    startDateAD: scope.fiscalYearStartAD,
    endDateAD: scope.fiscalYearEndAD,
    branchId: scope.branchId,
  };

  const invQuery = buildInventoryValueQuery({
    useOpeningStock: scope.useOpeningStock,
    fiscalYearId: scope.fiscalYearId,
    branchId: scope.branchId,
  });
  const assetQuery = buildFixedAssetValueQuery(Boolean(scope.branchId), scope.branchId);
  const invoiceQuery = buildPurchaseInvoiceTotalsQuery(invoiceScope);
  const openingQuery = buildVendorOpeningBalanceQuery({
    fiscalYearId: scope.fiscalYearId,
    branchId: scope.branchId,
  });
  const paymentQuery = buildVendorPaymentsQuery(dateScope);
  const returnQuery = buildPurchaseReturnsTotalQuery(invoiceScope);
  const damageQuery = buildDamageLossQuery({
    fiscalYearId: scope.fiscalYearId,
    branchId: scope.branchId,
    startDateAD: scope.fiscalYearStartAD,
    endDateAD: scope.fiscalYearEndAD,
  });
  const tradingQuery = buildTradingTotalsQuery(dateScope);

  const [
    invRes,
    assetRes,
    invoiceRes,
    openingRes,
    paymentRes,
    returnRes,
    damageRes,
    tradingRes,
  ] = await Promise.all([
    pool.query(invQuery.sql, invQuery.params),
    pool.query(assetQuery.sql, assetQuery.params),
    pool.query(invoiceQuery.sql, invoiceQuery.params),
    pool.query(openingQuery.sql, openingQuery.params),
    pool.query(paymentQuery.sql, paymentQuery.params),
    pool.query(returnQuery.sql, returnQuery.params),
    pool.query(damageQuery.sql, damageQuery.params),
    pool.query(tradingQuery.sql, tradingQuery.params),
  ]);

  const trading = (tradingRes.rows || [])[0] || {};

  const vendorOpeningBal = Number(openingRes.rows[0]?.total_ob || 0);
  const currentPeriodInvoiced = Number(invoiceRes.rows[0]?.total_invoiced || 0);
  const postedPayments = Number(paymentRes.rows[0]?.total_paid || 0);
  const postedReturns = Number(returnRes.rows[0]?.total_returns || 0);

  return {
    totalInventoryAssetValue: Number(invRes.rows[0]?.total || 0),
    totalFixedAssetValue: Number(assetRes.rows[0]?.total || 0),
    totalAccountsPayable:
      vendorOpeningBal + currentPeriodInvoiced - postedPayments - postedReturns,
    totalSalesRevenue: Number(trading.total_revenue || 0),
    totalCostOfGoodsSold: Number(trading.total_cogs || 0),
    totalDamageLossValue: Number(damageRes.rows[0]?.total || 0),
    totalVatInputTax: Number(invoiceRes.rows[0]?.total_vat || 0),
    currentFiscalYear: scope.currentFiscalYear,
  };
}
