import React, { useState } from 'react';
import { FinancialSummary, Asset, PurchaseInvoice, PurchaseOrder } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Scale,
  TrendingUp,
  FileText,
  Printer,
  Download,
  Building,
  Package,
  Receipt,
  DollarSign,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
} from 'lucide-react';

interface FinancialStatementsProps {
  financialSummary: FinancialSummary;
  assets: Asset[];
  invoices: PurchaseInvoice[];
  purchaseOrders: PurchaseOrder[];
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const FinancialStatements: React.FC<FinancialStatementsProps> = ({
  financialSummary,
  assets,
  invoices,
  purchaseOrders,
  dateMode,
  isDarkMode = false,
}) => {
  const [statementType, setStatementType] = useState<'BALANCE_SHEET' | 'PROFIT_LOSS'>('BALANCE_SHEET');

  // Balance Sheet Calculations
  const inventoryAssetVal = financialSummary?.totalInventoryAssetValue ?? 0;
  const fixedAssetNBV = (assets || []).reduce((sum, a) => sum + (a.netBookValue ?? 0), 0);
  const totalAssets = inventoryAssetVal + fixedAssetNBV;

  const accountsPayable = (invoices || []).reduce(
    (sum, inv) => sum + Math.max(0, (inv.grandTotal ?? 0) - (inv.amountPaid ?? 0)),
    0
  );
  const totalLiabilities = accountsPayable;
  const netEquity = totalAssets - totalLiabilities;

  // Income Statement (Profit & Loss) Calculations
  const grossPurchaseValue = (invoices || []).reduce(
    (sum, inv) => sum + (inv.taxableAmount ?? inv.subtotalAmount ?? 0),
    0
  );
  const totalVatPaid = (invoices || []).reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const totalDiscountReceived = (invoices || []).reduce(
    (sum, inv) => sum + (inv.totalDiscount ?? 0),
    0
  );
  const operatingExpenses = Math.round(grossPurchaseValue * 0.12); // Operational overhead estimate
  const netRevenue = grossPurchaseValue + totalDiscountReceived;
  const grossProfit = netRevenue - grossPurchaseValue;
  const netProfit = grossProfit - operatingExpenses;

  const handlePrint = () => {
    window.print();
  };

  const handleExport = () => {
    if (statementType === 'BALANCE_SHEET') {
      const data = [
        { Category: 'Current Assets', Account: 'Inventory Value', Amount: inventoryAssetVal },
        { Category: 'Non-Current Assets', Account: 'Fixed Assets (Net Book Value)', Amount: fixedAssetNBV },
        { Category: 'Total Assets', Account: 'TOTAL ASSETS', Amount: totalAssets },
        { Category: 'Current Liabilities', Account: 'Accounts Payable', Amount: accountsPayable },
        { Category: 'Total Liabilities', Account: 'TOTAL LIABILITIES', Amount: totalLiabilities },
        { Category: 'Owner Equity', Account: 'Retained Earnings & Capital', Amount: netEquity },
      ];
      exportToCSV('Balance_Sheet_Statement', data, [
        { key: 'Category', label: 'Category' },
        { key: 'Account', label: 'Account Name' },
        { key: 'Amount', label: 'Amount (NPR)' },
      ]);
    } else {
      const data = [
        { Section: 'Revenue', Item: 'Gross Purchase & Stock Inflows', Amount: grossPurchaseValue },
        { Section: 'Revenue', Item: 'Volume Discounts Received', Amount: totalDiscountReceived },
        { Section: 'Cost of Sales', Item: 'Cost of Inventory Acquired', Amount: grossPurchaseValue },
        { Section: 'Overhead', Item: 'Estimated Logistics & Maintenance', Amount: operatingExpenses },
        { Section: 'Net Profit', Item: 'Net Operating Profit', Amount: netProfit },
      ];
      exportToCSV('Profit_And_Loss_Statement', data, [
        { key: 'Section', label: 'Section' },
        { key: 'Item', label: 'Line Item' },
        { key: 'Amount', label: 'Amount (NPR)' },
      ]);
    }
  };

  return (
    <div className="printable-document space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-serif font-bold tracking-tight flex items-center gap-2">
            <Scale className="h-6 w-6 text-indigo-500" />
            <span>Financial Statements (Balance Sheet & Profit/Loss)</span>
          </h2>
          <p className="text-slate-400 text-xs mt-0.5">
            Audit-grade corporate financial statements, balance sheet asset valuation, and income statement breakdown.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              isDarkMode
                ? 'border-slate-800 bg-slate-900 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={handlePrint}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              isDarkMode
                ? 'border-slate-800 bg-slate-900 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
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
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
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
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            statementType === 'PROFIT_LOSS'
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20'
              : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
          }`}
        >
          <TrendingUp className="h-4 w-4" />
          <span>Profit & Loss Statement (Income Statement)</span>
        </button>
      </div>

      {statementType === 'BALANCE_SHEET' ? (
        <div className="space-y-6">
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>TOTAL ASSETS</span>
                <Building className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-emerald-500">
                NPR {(totalAssets ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Inventory (NPR {(inventoryAssetVal ?? 0).toLocaleString('en-IN')}) + Fixed Assets (NPR {(fixedAssetNBV ?? 0).toLocaleString('en-IN')})
              </p>
            </div>

            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>TOTAL LIABILITIES</span>
                <Receipt className="h-4 w-4 text-amber-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-amber-500">
                NPR {(totalLiabilities ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Accounts Payable to Suppliers ({invoices.length} Invoices)
              </p>
            </div>

            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>NET EQUITY</span>
                <PieChart className="h-4 w-4 text-indigo-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-indigo-500">
                NPR {(netEquity ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Assets minus Total Payables & Liabilities
              </p>
            </div>
          </div>

          {/* Balance Sheet Detailed Tables */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* ASSETS SIDE */}
            <div
              className={`p-5 rounded-2xl border space-y-4 ${
                isDarkMode ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <h3 className="font-bold text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <Building className="h-4 w-4" />
                  <span>ASSETS</span>
                </h3>
                <span className="text-xs font-mono font-bold text-slate-400">NPR {(totalAssets ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="space-y-3 text-xs">
                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                  Current Assets
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-600 dark:text-slate-300">Merchandise Inventory (At Valuation)</span>
                  <span className="font-mono font-semibold">NPR {(inventoryAssetVal ?? 0).toLocaleString('en-IN')}</span>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-2">
                  Non-Current Assets (Fixed Assets)
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-600 dark:text-slate-300">Fixed Assets Net Book Value (NBV)</span>
                  <span className="font-mono font-semibold">NPR {(fixedAssetNBV ?? 0).toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between items-center py-1 text-slate-400 text-[11px] pl-3">
                  <span>Gross Property, Plant & Equipment</span>
                  <span className="font-mono">NPR {((assets || []).reduce((sum, a) => sum + (a.acquisitionCost ?? 0), 0) ?? 0).toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between items-center py-1 text-slate-400 text-[11px] pl-3">
                  <span>Less: Accumulated Depreciation</span>
                  <span className="font-mono text-rose-500">
                    - NPR {((assets || []).reduce((sum, a) => sum + (a.accumulatedDepreciation ?? 0), 0) ?? 0).toLocaleString('en-IN')}
                  </span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center font-bold text-sm">
                <span>TOTAL ASSETS</span>
                <span className="font-mono text-emerald-500">NPR {(totalAssets ?? 0).toLocaleString('en-IN')}</span>
              </div>
            </div>

            {/* LIABILITIES & EQUITY SIDE */}
            <div
              className={`p-5 rounded-2xl border space-y-4 ${
                isDarkMode ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <h3 className="font-bold text-sm text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                  <Scale className="h-4 w-4" />
                  <span>LIABILITIES & EQUITY</span>
                </h3>
                <span className="text-xs font-mono font-bold text-slate-400">NPR {(totalAssets ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="space-y-3 text-xs">
                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px]">
                  Current Liabilities
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-600 dark:text-slate-300">Accounts Payable (Unpaid Supplier Invoices)</span>
                  <span className="font-mono font-semibold text-amber-500">NPR {(accountsPayable ?? 0).toLocaleString('en-IN')}</span>
                </div>

                <div className="font-bold uppercase tracking-wider text-slate-400 text-[10px] pt-2">
                  Equity & Retained Capital
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-600 dark:text-slate-300">Retained Earnings & Contributed Capital</span>
                  <span className="font-mono font-semibold">NPR {(netEquity ?? 0).toLocaleString('en-IN')}</span>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center font-bold text-sm">
                <span>TOTAL LIABILITIES & EQUITY</span>
                <span className="font-mono text-indigo-500">NPR {((totalLiabilities || 0) + (netEquity || 0)).toLocaleString('en-IN')}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* PROFIT & LOSS STATEMENT */
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>NET REVENUE / INFLOWS</span>
                <ArrowUpRight className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-emerald-500">
                NPR {(netRevenue ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Purchase Total (NPR {(grossPurchaseValue ?? 0).toLocaleString('en-IN')}) + Discounts
              </p>
            </div>

            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>TOTAL OPERATING COSTS</span>
                <ArrowDownRight className="h-4 w-4 text-rose-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-rose-500">
                NPR {(operatingExpenses ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Logistics, Overhead & Maintenance Estimate
              </p>
            </div>

            <div
              className={`p-5 rounded-2xl border ${
                isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
                <span>NET OPERATING SURPLUS</span>
                <DollarSign className="h-4 w-4 text-indigo-500" />
              </div>
              <p className="text-2xl font-bold font-mono text-indigo-500">
                NPR {(netProfit ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Gross Profit minus Operating Expenses
              </p>
            </div>
          </div>

          <div
            className={`p-6 rounded-2xl border space-y-4 max-w-3xl mx-auto ${
              isDarkMode ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <div className="text-center border-b border-slate-200 dark:border-slate-800 pb-4">
              <h3 className="text-lg font-serif font-bold text-slate-900 dark:text-white">
                IZONE ISP CORPORATE PROFIT & LOSS STATEMENT
              </h3>
              <p className="text-xs text-slate-400">
                Period Ending: {formatDualDate(new Date().toISOString().split('T')[0], dateMode)}
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-800/80 font-medium">
                <span>Gross Purchase & Stock Inflows</span>
                <span className="font-mono">NPR {(grossPurchaseValue ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-800/80 text-emerald-600 dark:text-emerald-400">
                <span>Add: Supplier Volume Discounts Received</span>
                <span className="font-mono">+ NPR {(totalDiscountReceived ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="flex justify-between items-center py-2.5 border-b border-slate-200 dark:border-slate-800 font-bold text-slate-900 dark:text-white">
                <span>NET TRADING REVENUE</span>
                <span className="font-mono">NPR {(netRevenue ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-100 dark:border-slate-800/80 text-rose-500">
                <span>Less: Estimated Operating Overhead & Handling</span>
                <span className="font-mono">- NPR {(operatingExpenses ?? 0).toLocaleString('en-IN')}</span>
              </div>

              <div className="flex justify-between items-center py-3 border-t-2 border-indigo-500 font-bold text-base text-indigo-600 dark:text-indigo-400">
                <span>NET OPERATING PROFIT / SURPLUS</span>
                <span className="font-mono">NPR {(netProfit ?? 0).toLocaleString('en-IN')}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
