import React, { useState } from 'react';
import { FinancialSummary, Asset, PurchaseInvoice, CompanyProfile } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { calculateFixedAssetValues } from '../../utils/depreciation';
import { formatNPR, formatNPRPrecise, formatNPRInteger } from '../../utils/nprFormat';
import {
  Scale,
  TrendingUp,
  Printer,
  Download,
  Building,
  Receipt,
  PieChart,
  Info,
  Wallet,
  Package,
} from 'lucide-react';

interface FinancialStatementsProps {
  financialSummary: FinancialSummary;
  assets: Asset[];
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  /** As-of date used for live NBV; matches the Fixed Asset Register / Depreciation Register view. */
  asOfDateAD?: string;
  /** Company master record — used for the official statement letterhead / header. */
  companyProfile?: CompanyProfile | null;
}

// PostgreSQL NUMERIC columns arrive as strings over the API. Coerce every
// value to a real number before arithmetic so we never fall into JS string
// concatenation (e.g. 0 + "3000.00" -> "03000.00").
const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export const FinancialStatements: React.FC<FinancialStatementsProps> = ({
  financialSummary,
  assets,
  invoices,
  dateMode,
  asOfDateAD,
  companyProfile,
}) => {
  const [statementType, setStatementType] = useState<'BALANCE_SHEET' | 'PROFIT_LOSS'>('BALANCE_SHEET');

  // ----- Balance Sheet Calculations -----------------------------------------
  const inventoryAssetVal = toNumber(financialSummary?.totalInventoryAssetValue);

  // Fixed assets: recompute NBV live from the asset register (same util as the
  // Fixed Asset Register & Depreciation Register) so this report always
  // reconciles with those tabs and honors the as-of date.
  const grossFixedAssets = (assets || []).reduce(
    (sum, a) => sum + toNumber(a.acquisitionCost),
    0
  );
  const accumulatedDepreciation = (assets || []).reduce(
    (sum, a) =>
      sum +
      toNumber(
        calculateFixedAssetValues({
          ...a,
          acquisitionDateAD: a.placedInServiceDateAD || a.acquisitionDateAD,
          asOfDateAD,
        }).accumulatedDepreciation
      ),
    0
  );
  const fixedAssetNBV = grossFixedAssets - accumulatedDepreciation;
  const totalAssets = inventoryAssetVal + fixedAssetNBV;

  // Accounts Payable comes from the server (financialSummary), which computes
  //  AP = vendor opening balances + current-period unpaid invoices − posted
  //  payments. That formula reconciles with the Vendor Ledger / Vendor Opening
  //  Balances registers — a client-side recompute would silently diverge.
  const accountsPayable = Math.max(0, toNumber(financialSummary?.totalAccountsPayable));
  const totalLiabilities = accountsPayable;
  const netEquity = totalAssets - totalLiabilities;

  // Income Statement — Trading summary. Sales revenue and COGS are computed
  // server-side from the posted customer product sales (STOCK_OUT operations
  // with priced line items) so Revenue − COGS = Gross Surplus is always real
  // and reconciles with the Balance Sheet's inventory-at-cost valuation.
  const trackedSalesRevenue = toNumber(financialSummary?.totalSalesRevenue);
  const trackedCOGS = toNumber(financialSummary?.totalCostOfGoodsSold);
  const grossSurplus = trackedSalesRevenue - trackedCOGS;
  const grossMargin =
    trackedSalesRevenue > 0
      ? ((grossSurplus / trackedSalesRevenue) * 100).toFixed(1)
      : '—';

  const handlePrint = () => {
    window.print();
  };

  const handleExport = () => {
    if (statementType === 'BALANCE_SHEET') {
      const data = [
        { Category: 'Equity & Liabilities', Account: 'Capital & Retained Surplus (Balancing Figure)', Amount: netEquity },
        { Category: 'Equity & Liabilities', Account: 'Trade Payables — Accounts Payable (Opening + Invoices − Payments)', Amount: accountsPayable },
        { Category: 'Equity & Liabilities', Account: 'TOTAL EQUITY & LIABILITIES', Amount: totalLiabilities + netEquity },
        { Category: 'Non-Current Assets', Account: 'Fixed Assets — Gross Cost', Amount: grossFixedAssets },
        { Category: 'Non-Current Assets', Account: 'Less: Accumulated Depreciation', Amount: -accumulatedDepreciation },
        { Category: 'Non-Current Assets', Account: 'Net Block — Fixed Assets (NBV)', Amount: fixedAssetNBV },
        { Category: 'Current Assets', Account: 'Merchandise Inventory (At Valuation)', Amount: inventoryAssetVal },
        { Category: 'Total Assets', Account: 'TOTAL ASSETS', Amount: totalAssets },
      ];
      exportToCSV('Balance_Sheet_Statement', data, [
        { key: 'Category', label: 'Category' },
        { key: 'Account', label: 'Account Name' },
        { key: 'Amount', label: 'Amount (NPR)' },
      ]);
    } else {
      const data = [
        { Section: 'Revenue', Item: 'Posted Sales Revenue', Amount: trackedSalesRevenue, Status: 'From customer product sales (STOCK_OUT)' },
        { Section: 'Cost of Sales', Item: 'Cost of Goods Sold', Amount: trackedCOGS, Status: 'From sold quantity × product cost price' },
        { Section: 'Gross Profit', Item: 'Gross Surplus', Amount: grossSurplus, Status: 'Revenue − COGS' },
        { Section: 'Operating Expenses', Item: 'Posted Operating Expenses', Amount: 0, Status: 'Not yet posted — no expense journal' },
      ];
      exportToCSV('Profit_And_Loss_Statement', data, [
        { key: 'Section', label: 'Section' },
        { key: 'Item', label: 'Line Item' },
        { key: 'Amount', label: 'Amount (NPR)' },
        { key: 'Status', label: 'Source / Status' },
      ]);
    }
  };

  return (
    <div className="printable-document space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2">
            <Scale className="h-5 w-5 text-indigo-500" />
            <span>Financial Statements (Balance Sheet &amp; Profit/Loss)</span>
          </h2>
          <p className="truncate text-slate-400 text-xs mt-0.5">
            Management balance sheet: inventory at valuation, fixed assets at net book value, and supplier payables from the vendor registers.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handleExport}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={handlePrint}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Statement</span>
          </button>
        </div>
      </div>

      {/* Statement Type Toggle Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
        <button
          onClick={() => setStatementType('BALANCE_SHEET')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            statementType === 'BALANCE_SHEET'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
              : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <Scale className="h-4 w-4" />
          <span>Balance Sheet Statement</span>
        </button>

        <button
          onClick={() => setStatementType('PROFIT_LOSS')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            statementType === 'PROFIT_LOSS'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
              : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <TrendingUp className="h-4 w-4" />
          <span>Profit &amp; Loss Statement (Income Statement)</span>
        </button>
      </div>

      {statementType === 'BALANCE_SHEET' ? (
        <div className="space-y-3">
          {/* Official Company Letterhead + Statement Title */}
          <div className="text-center border-b-2 border-slate-300 dark:border-slate-700 pb-4">
            <h2 className="text-xl font-serif font-extrabold text-slate-900 dark:text-white tracking-tight">
              {companyProfile?.legalName || companyProfile?.name || 'Inventory Management System'}
            </h2>
            {(companyProfile?.address || companyProfile?.city || companyProfile?.phone || companyProfile?.email) && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {[companyProfile?.address, companyProfile?.city, companyProfile?.country]
                  .filter(Boolean)
                  .join(', ')}
                {companyProfile?.phone ? ` | Tel: ${companyProfile.phone}` : ''}
                {companyProfile?.email ? ` | ${companyProfile.email}` : ''}
              </p>
            )}
            {companyProfile?.panVatNumber && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                PAN / VAT No: {companyProfile.panVatNumber}
              </p>
            )}
            <h3 className="text-lg font-serif font-bold text-slate-800 dark:text-slate-200 mt-2 tracking-wide">
              BALANCE SHEET
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              As at {asOfDateAD ? formatDualDate(asOfDateAD, dateMode) : formatDualDate(new Date().toISOString().split('T')[0], dateMode)}
            </p>
          </div>

          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div
              className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>TOTAL ASSETS</span>
                <Building className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="text-xl font-bold font-mono text-emerald-500">
                {formatNPR(totalAssets)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Inventory ({formatNPR(inventoryAssetVal)}) + Fixed Assets NBV ({formatNPR(fixedAssetNBV)})
              </p>
            </div>

            <div
              className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>TOTAL LIABILITIES</span>
                <Receipt className="h-4 w-4 text-amber-500" />
              </div>
              <p className="text-xl font-bold font-mono text-amber-500">
                {formatNPR(totalLiabilities)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Accounts Payable — vendor opening balances + invoices − payments ({invoices.length} Invoices this period)
              </p>
            </div>

            <div
              className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>NET EQUITY</span>
                <PieChart className="h-4 w-4 text-indigo-500" />
              </div>
              <p className="text-xl font-bold font-mono text-indigo-500">
                {formatNPR(netEquity)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Capital &amp; Retained Surplus (balancing figure: assets − liabilities)
              </p>
            </div>
          </div>

          {/* Standard Vertical Balance Sheet */}
          <div className="max-w-3xl mx-auto">
            <div
              className={`p-5 rounded-2xl border space-y-5 bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
            >
              {/* EQUITY & LIABILITIES */}
              <div className="space-y-2">
                <div className="flex items-center justify-between border-b-2 border-slate-300 dark:border-slate-700 pb-2">
                  <h3 className={`font-bold text-sm text-indigo-600 dark:text-indigo-400 tracking-wide`}>
                    EQUITY AND LIABILITIES
                  </h3>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-1">
                  1. Shareholders' Funds
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60 pl-3">
                  <span className="text-slate-600 dark:text-slate-300">Capital &amp; Retained Surplus (Balancing Figure)</span>
                  <span className="font-mono font-semibold">{formatNPR(netEquity)}</span>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-2">
                  2. Current Liabilities
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60 pl-3">
                  <span className="text-slate-600 dark:text-slate-300">Trade Payables — Accounts Payable (Opening + Invoices − Payments)</span>
                  <span className="font-mono font-semibold text-amber-500">{formatNPR(accountsPayable)}</span>
                </div>

                <div className="pt-2 flex justify-between items-center font-bold text-sm">
                  <span>TOTAL EQUITY &amp; LIABILITIES</span>
                  <span className="font-mono text-indigo-500">{formatNPR(totalLiabilities + netEquity)}</span>
                </div>
              </div>

              {/* ASSETS */}
              <div className="space-y-2 pt-3 border-t-2 border-slate-300 dark:border-slate-700">
                <div className="flex items-center justify-between border-b-2 border-slate-300 dark:border-slate-700 pb-2">
                  <h3 className={`font-bold text-sm text-emerald-600 dark:text-emerald-400 tracking-wide`}>
                    ASSETS
                  </h3>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-1">
                  1. Non-Current Assets — Fixed Assets
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60 pl-3">
                  <span className="text-slate-600 dark:text-slate-300">Fixed Assets at Gross Cost</span>
                  <span className="font-mono font-semibold">{formatNPR(grossFixedAssets)}</span>
                </div>
                <div className="flex justify-between items-center py-1 text-slate-400 text-[11px] pl-6">
                  <span>Less: Accumulated Depreciation</span>
                  <span className="font-mono text-rose-500">- {formatNPR(accumulatedDepreciation)}</span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60 pl-3 text-emerald-600 dark:text-emerald-400 font-semibold">
                  <span>Net Block — Fixed Assets (NBV)</span>
                  <span className="font-mono">{formatNPR(fixedAssetNBV)}</span>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-2">
                  2. Current Assets — Inventories
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60 pl-3">
                  <span className="text-slate-600 dark:text-slate-300">Merchandise Inventory (At Valuation)</span>
                  <span className="font-mono font-semibold">{formatNPR(inventoryAssetVal)}</span>
                </div>

                <div className="pt-2 flex justify-between items-center font-bold text-sm">
                  <span>TOTAL ASSETS</span>
                  <span className="font-mono text-emerald-500">{formatNPR(totalAssets)}</span>
                </div>
              </div>

              {/* Sign-off line */}
              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-2 gap-4 text-[10px] text-slate-400">
                <div className="text-left">
                  <p className="font-bold uppercase tracking-wider">Prepared By</p>
                  <p className="mt-8 border-t border-slate-300 dark:border-slate-700 pt-1">Authorized Signatory</p>
                </div>
                <div className="text-right">
                  <p className="font-bold uppercase tracking-wider">Reviewed By</p>
                  <p className="mt-8 border-t border-slate-300 dark:border-slate-700 pt-1">Management / Accountant</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* PROFIT & LOSS — Trading / Gross Surplus statement computed from the
           customer product sales that ARE posted in this installation.  We
           publish Sales Revenue, COGS and Gross Surplus honestly; operating
           expenses and net profit stay unpublished until an expense journal. */
        <div className="space-y-3">
          {/* Header with real totals */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>SALES REVENUE</span>
                <Wallet className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="text-xl font-bold font-mono text-emerald-500">{formatNPR(trackedSalesRevenue)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Net value of customer product sales (Branch Operations → Sell Product)
              </p>
            </div>

            <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>COST OF GOODS SOLD</span>
                <Package className="h-4 w-4 text-amber-500" />
              </div>
              <p className="text-xl font-bold font-mono text-amber-500">{formatNPR(trackedCOGS)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Sold quantity × product cost price — matches the inventory-at-cost valuation basis
              </p>
            </div>

            <div className={`p-4 rounded-2xl border bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-1">
                <span>GROSS SURPLUS (MARGIN)</span>
                <TrendingUp className="h-4 w-4 text-indigo-500" />
              </div>
              <p className="text-xl font-bold font-mono text-indigo-500">{formatNPR(grossSurplus)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Margin: {grossMargin}% — Revenue − COGS</p>
            </div>
          </div>

          {/* Honest "not published below the gross line" note */}
          <div
            className={`p-4 rounded-2xl border bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/60 flex items-start gap-3`}
          >
            <Info className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <p className="font-bold">Operating expenses &amp; net profit are not published</p>
              <p>
                This installation posts product sales, so revenue, cost of goods sold and gross
                surplus above are real figures. There is no expense journal and no general-ledger
                posting yet, so net operating profit below the gross line remains unpublished.
              </p>
            </div>
          </div>

          <div
            className={`p-4 rounded-2xl border space-y-4 max-w-3xl mx-auto bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
          >
            <div className="text-center border-b border-slate-200 dark:border-slate-800 pb-4">
              <h3 className="text-lg font-serif font-bold text-slate-900 dark:text-white">
                {companyProfile?.name || 'Inventory Management System'}
              </h3>
              <h4 className="text-base font-serif font-bold text-slate-800 dark:text-slate-200 mt-1">
                PROFIT &amp; LOSS STATEMENT
              </h4>
              <p className="text-xs text-slate-400">
                Trading Period Ending: {formatDualDate(new Date().toISOString().split('T')[0], dateMode)}
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-800/80">
                <span className="text-slate-600 dark:text-slate-300">Posted Sales Revenue</span>
                <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{formatNPR(trackedSalesRevenue)}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-100 text-rose-600 dark:border-slate-800/80 dark:text-rose-400">
                <span>Less: Cost of Goods Sold</span>
                <span className="font-mono">
                  - {formatNPR(trackedCOGS)}
                  {trackedCOGS <= 0 && trackedSalesRevenue <= 0 ? ' — no product sales posted' : ''}
                </span>
              </div>

              <div
                className={`flex justify-between items-center py-2.5 px-3 rounded-xl font-bold ${
                  grossSurplus >= 0
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
                }`}
              >
                <span>GROSS SURPLUS (SALES − COGS)</span>
                <span className="font-mono">{formatNPR(grossSurplus)}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-800/80 text-slate-400">
                <span>Less: Posted Operating Expenses</span>
                <span className="font-mono">- {formatNPR(0)} — no expense journal</span>
              </div>

              <div className={`flex justify-between items-center py-3 border-t-2 border-slate-300 dark:border-slate-700 font-bold text-base text-slate-400`}>
                <span>NET OPERATING PROFIT / SURPLUS</span>
                <span className="font-mono">Not Published — requires expense journal</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
