/**
 * Reports controller — HTTP orchestration for the reports domain.
 * Routes forward here; every handler returns a promise whose rejection is
 * forwarded to the central error middleware by the route forwarder.
 * Response bodies and status codes are preserved verbatim from the
 * original route handlers.
 */
import type { Response } from 'express';
import { getPgConnected, pickCurrentFiscalYear, mutable, fiscalYears, pgPool, inventoryStock, assetRegister, purchaseInvoices, stockOperations, products, computeTradingFromOps } from '../app';
import {
  fetchFinancialSummaryFromDb,
  type FinancialSummary,
  type FinancialSummaryScope,
} from '../services/financialSummary.service';
/** Resolves the branch/fiscal-year scope of one summary read. */
function resolveSummaryScope(branchId?: string, fiscalYearId?: string): FinancialSummaryScope {
  const currentFy = pickCurrentFiscalYear(mutable(fiscalYears)) || null;
  // Fiscal-year scoping: for any year OTHER than the current fiscal year,
  // inventory is valued from that year's opening-stock ledger
  // (fiscal_year_opening_stock) — the live inventory_stock balance only
  // represents the current fiscal year and must not be reported for
  // past/closed years.
  const requestedFy = fiscalYearId
    ? fiscalYears.find((f) => f.id === fiscalYearId || f.code === fiscalYearId)
    : undefined;
  const fy = requestedFy || currentFy;
  return {
    branchId: branchId && branchId !== 'ALL' ? branchId : undefined,
    fiscalYearId: fy?.id || '',
    fiscalYearStartAD: fy?.startDateAD,
    fiscalYearEndAD: fy?.endDateAD,
    currentFiscalYear: currentFy?.code || '2082/83',
    useOpeningStock: Boolean(requestedFy && currentFy && requestedFy.id !== currentFy.id),
  };
}

/**
 * In-memory fallback (no PostgreSQL): the same numbers from the operational
 * cache. Payments/returns ledgers are not held in memory, so AP here is the
 * open amount on each invoice — the behaviour this path always had.
 */
function summaryFromCache(branchId?: string): FinancialSummary {
  const targetStock = branchId ? inventoryStock.filter((s) => s.branchId === branchId) : inventoryStock;
  const targetAssets = branchId ? assetRegister.filter((a) => a.branchId === branchId) : assetRegister;
  const targetInvoices = branchId ? purchaseInvoices.filter((inv) => inv.branchId === branchId) : purchaseInvoices;
  const targetOps = branchId ? stockOperations.filter((op) => op.branchId === branchId) : stockOperations;

  const totalInventoryAssetValue = targetStock.reduce((sum, item) => {
    const prod = products.find((pr) => pr.id === item.productId);
    return sum + (prod ? prod.costPrice * item.quantityOnHand : 0);
  }, 0);
  const totalFixedAssetValue = targetAssets.reduce((sum, a) => sum + (a.netBookValue ?? 0), 0);
  const totalAccountsPayable = targetInvoices.reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );
  const totalDamageLossValue = targetOps.reduce((sum, op) => sum + (op.totalValue ?? 0), 0);
  const totalVatInputTax = targetInvoices.reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const inMemTrading = computeTradingFromOps(targetOps, products);
  const currentFy = pickCurrentFiscalYear(mutable(fiscalYears))?.code || '2082/83';

  return {
    totalInventoryAssetValue,
    totalFixedAssetValue,
    totalAccountsPayable,
    totalSalesRevenue: inMemTrading.totalSalesRevenue,
    totalCostOfGoodsSold: inMemTrading.totalCostOfGoodsSold,
    totalDamageLossValue,
    totalVatInputTax,
    currentFiscalYear: currentFy,
  };
}

/**
 * Reads one summary — the shared aggregate producer when PostgreSQL is up, so
 * this endpoint and the bootstrap slice can never disagree (the old inline
 * copy here omitted the posted purchase-return term, overstating AP), and the
 * in-memory fallback otherwise.
 */
async function readSummary(scope: FinancialSummaryScope): Promise<FinancialSummary> {
  if (getPgConnected()) {
    try {
      return await fetchFinancialSummaryFromDb(pgPool, scope);
    } catch (err) {
      console.error('Error fetching financial summary report from DB:', err);
    }
  }
  return summaryFromCache(scope.branchId);
}

/**
 * Response shape of a summary read: the numbers plus the year the caller
 * asked about (the client type carries it as `fiscalYearId`). Both endpoints
 * apply it, so a batch entry is byte-identical to its single read.
 */
function withRequestedFiscalYear(summary: FinancialSummary, fiscalYearId?: string): FinancialSummary {
  const requestedFy = fiscalYearId
    ? fiscalYears.find((f) => f.id === fiscalYearId || f.code === fiscalYearId)
    : undefined;
  return {
    ...summary,
    currentFiscalYear: requestedFy ? requestedFy.code : summary.currentFiscalYear,
    fiscalYearId: requestedFy ? requestedFy.id : null,
  } as FinancialSummary;
}

/** GET /api/reports/financial-summary — one branch × fiscal year. */
export async function get_financialSummary(req: any, res: Response): Promise<any> {
  const { branchId, fiscalYearId } = req.query;
  const summary = await readSummary(resolveSummaryScope(branchId, fiscalYearId));
  return res.json(withRequestedFiscalYear(summary, fiscalYearId));
}

/**
 * GET /api/reports/financial-summaries — the batch form of the read above.
 *
 * The statements screen asked once per branch × fiscal year (branch count
 * times two on every activation). This returns every pair in ONE request,
 * keyed exactly as the caller asked (`branchId|fiscalYearId`, or `ALL|` when
 * omitted), and runs the same shared producer per pair — so its failure is
 * one visible error line, not a partial matrix.
 */
export async function get_financialSummaries(req: any, res: Response): Promise<any> {
  const list = (value: unknown): string[] =>
    typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
  const branchIds = list(req.query.branchIds);
  const fiscalYearIds = list(req.query.fiscalYearIds);
  const branches = branchIds.length ? branchIds : [undefined];
  const years = fiscalYearIds.length ? fiscalYearIds : [undefined];
  const summaries: Record<string, FinancialSummary> = {};
  for (const branchId of branches) {
    for (const fiscalYearId of years) {
      summaries[`${branchId ?? 'ALL'}|${fiscalYearId ?? ''}`] = withRequestedFiscalYear(
        await readSummary(resolveSummaryScope(branchId, fiscalYearId)),
        fiscalYearId
      );
    }
  }
  return res.json({ summaries });
}
