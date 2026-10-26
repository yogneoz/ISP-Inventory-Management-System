import React, { useEffect, useState } from 'react';
import {
  Trash2,
  AlertTriangle,
  Database,
  Package,
  Boxes,
  Building,
  Smartphone,
  Users,
  FileText,
  Receipt,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { User } from '../../types';
import { api } from '../../services/api';
import type { ClearDemoDataResult } from '../../services/api/admin';

interface ClearDemoDataViewProps {
  currentUser?: User | null;
  productCount: number;
  stockCount: number;
  assetCount: number;
  deviceCount: number;
  poCount: number;
  invoiceCount: number;
  /**
   * Whether the app still has no usable fiscal year. When it does not, the
   * success card's primary action is the fiscal-year screen: a cleared install
   * has no fiscal year, and every bootstrap refuses until one is created and
   * active, so "go to the dashboard" would land the operator on a blocked app.
   */
  needsFiscalYear?: boolean;
  onClearDemoData: () => Promise<ClearDemoDataResult | void>;
  onNavigateDashboard: () => void;
  onNavigateFiscalYears?: () => void;
  /** Called when the cleared account was the signed-in demo one (no Super Admin
   *  left): App signs the session out to the first-launch setup. */
  onSignedOut?: () => void;
}

export const ClearDemoDataView: React.FC<ClearDemoDataViewProps> = ({
  currentUser,
  productCount,
  stockCount,
  assetCount,
  deviceCount,
  poCount,
  invoiceCount,
  needsFiscalYear = false,
  onClearDemoData,
  onNavigateDashboard,
  onNavigateFiscalYears,
  onSignedOut,
}) => {
  // VOL-4a: customers left the bootstrap, so this screen reads the directory
  // total from the paged aggregate instead of receiving the whole array. One
  // row, one count — the same read the Customers KPI uses. `null` = not known
  // yet (or the read failed), rendered as "—" rather than a confident zero.
  const [customerCount, setCustomerCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getCustomers({ page: 1, pageSize: 1 })
      .then((envelope) => {
        if (!cancelled) setCustomerCount(Number(envelope.totalItems) || 0);
      })
      .catch(() => {
        if (!cancelled) setCustomerCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [confirmText, setConfirmText] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [clearedSuccess, setClearedSuccess] = useState(false);
  const [clearResult, setClearResult] = useState<ClearDemoDataResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const requiredConfirm = 'CLEAR DEMO DATA';
  const isMatch = confirmText.trim().toUpperCase() === requiredConfirm;

  const handleExecuteClear = async () => {
    if (!isMatch || isClearing) return;
    setIsClearing(true);
    setErrorMessage('');
    try {
      const result = await onClearDemoData();
      if (result) setClearResult(result);
      setClearedSuccess(true);
      // The account this session was signed in as was demo data, and nothing
      // real is left to act as: hand off to the first-launch setup instead of
      // pretending the session still exists (the server deletes the user row;
      // the token alone would keep working for hours).
      if (result && result.superAdminCount === 0) {
        onSignedOut?.();
        return;
      }
      // Only auto-return to the dashboard when there is nothing to fix first;
      // a cleared install has no fiscal year and the dashboard would 409.
      if (!needsFiscalYear) {
        setTimeout(() => {
          onNavigateDashboard();
        }, 2500);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to clear demo data.');
    } finally {
      setIsClearing(false);
    }
  };

  // A pending customer count makes the total a lower bound until it arrives;
  // the figure is a coarse "how much is on file" preview, not an audit number.
  const totalOperationalRecords =
    productCount + stockCount + assetCount + deviceCount + (customerCount ?? 0) + poCount + invoiceCount;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* Header Banner */}
      <div className="bg-gradient-to-r from-red-900 via-red-800 to-amber-900 text-white rounded-2xl p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-500/30 text-red-200 text-xs font-semibold uppercase tracking-wider border border-red-400/30">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>Super Admin Governance Control</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Clear Operational Demo & Dummy Data</h1>
            <p className="text-sm text-red-100 max-w-2xl leading-relaxed">
              Removes the sample dataset seeded by <span className="font-mono text-xs">npm run setup:pg</span> — the rows flagged with
              <span className="font-mono text-xs"> is_demo = TRUE</span>, including the <strong>demo branches</strong>, <strong>demo user accounts</strong>
              (e.g. <span className="font-mono text-xs">superadmin@example.com</span>), and the <strong>demo fiscal years</strong>.
              Your real products, stock balances, assets, device serials,
              orders, branches, users, and transaction logs are never touched. The Nepali BS calendar reference data
              (<span className="font-mono text-xs">bs_calendar_years</span> / <span className="font-mono text-xs">bs_day_records</span>) is always preserved and
              its fiscal-year links are re-pointed automatically. Run <span className="font-mono text-xs">npm run setup:pg</span> any time to re-seed the demo dataset.
            </p>
          </div>
          <div className="p-4 bg-white/10 rounded-2xl backdrop-blur-md border border-white/20 text-center shrink-0">
            <Database className="h-8 w-8 mx-auto text-red-200 mb-1" />
            <span className="text-xs text-red-100 uppercase font-medium">Records on File</span>
            <div className="text-2xl font-black">{totalOperationalRecords}</div>
          </div>
        </div>
      </div>

      {clearedSuccess ? (
        <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-8 text-center space-y-4 animate-fade-in">
          <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/60 rounded-full flex items-center justify-center mx-auto text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-10 w-10" />
          </div>
          <h2 className="text-2xl font-bold text-emerald-900 dark:text-emerald-100">
            Demo Data Successfully Cleared!
          </h2>
          <p className="text-sm text-emerald-700 dark:text-emerald-300 max-w-md mx-auto">
            All demo-flagged records (is_demo = TRUE) have been removed — including the demo branches, demo user accounts, and demo fiscal years.
            Your real business data is untouched and the Nepali BS calendar is preserved.
          </p>

          {/* What the server actually removed, not a summary we composed here. */}
          {clearResult && (
            <p className="text-[11px] font-mono text-emerald-800/90 dark:text-emerald-300/90">
              {clearResult.totalRemoved} row(s) removed · {clearResult.demoFiscalYearsDeleted} demo fiscal year(s) deleted
              {clearResult.demoFiscalYearsSkipped > 0
                ? ` · ${clearResult.demoFiscalYearsSkipped} kept (real opening balances reference them)`
                : ''}
              {' · '}BS calendar preserved ({clearResult.bsDayRecordsRelinked} day link(s) refreshed) · {clearResult.userCount} user(s)
              left ({clearResult.superAdminCount} Super Admin)
            </p>
          )}

          {/* Next steps. A cleared install has no fiscal year, so the app cannot
              load data until one exists and is active — say so here instead of
              bouncing the operator into a blocked dashboard. */}
          {needsFiscalYear ? (
            <div className="max-w-lg mx-auto text-left space-y-3 pt-1">
              <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40">
                <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                  One step left before the app can load data
                </p>
                <p className="text-[11px] text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">
                  The demo fiscal years are gone, so there is no accounting period to scope records to and every
                  screen will keep reporting “No fiscal year is configured”. Create your own year in the Fiscal Year
                  Closing Wizard — it runs Shrawan 1 to Ashadh end, and the BS dates are filled in from the seeded
                  calendar for you. The first year you create becomes the active one.
                </p>
              </div>
              {onNavigateFiscalYears && (
                <button
                  type="button"
                  onClick={onNavigateFiscalYears}
                  className="w-full px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition shadow-md cursor-pointer"
                >
                  Create your first fiscal year
                </button>
              )}
              <button
                type="button"
                onClick={onNavigateDashboard}
                className="w-full px-6 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition cursor-pointer"
              >
                Back to Dashboard (data stays blocked until a fiscal year exists)
              </button>
            </div>
          ) : (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              Returning to the Executive Dashboard — if the app reports that no fiscal year is configured, create one in
              the Fiscal Year Closing Wizard.
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Record Breakdown Card */}
          <div className={`rounded-2xl p-6 border shadow-sm space-y-4 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h2 className={`text-base font-bold flex items-center gap-2 text-slate-900 dark:text-white`}>
                <Boxes className={`h-5 w-5 text-amber-500 dark:text-amber-400`} />
                <span>Operational Records on File</span>
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Only Demo-Flagged Rows (is_demo = TRUE) Will Be Removed
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Package className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                  <span>Products Catalog</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{productCount}</div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Boxes className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
                  <span>Inventory Stock</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{stockCount}</div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Building className={`h-4 w-4 text-blue-500 dark:text-blue-400`} />
                  <span>Fixed Assets</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{assetCount}</div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Smartphone className={`h-4 w-4 text-purple-500 dark:text-purple-400`} />
                  <span>Customer Devices</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{deviceCount}</div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Users className={`h-4 w-4 text-amber-500 dark:text-amber-400`} />
                  <span>Customer Records</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  {customerCount === null ? '—' : customerCount}
                </div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <FileText className="h-4 w-4 text-teal-500" />
                  <span>Purchase Orders</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{poCount}</div>
              </div>

              <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-100 dark:border-slate-800 col-span-2">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <Receipt className={`h-4 w-4 text-rose-500 dark:text-rose-400`} />
                  <span>Invoices, Vendor Payments & Audit Logs</span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">{invoiceCount}</div>
              </div>
            </div>
          </div>

          {/* Safety Notice Card */}
          <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded-2xl p-5 flex items-start gap-4">
            <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-sm text-amber-900 dark:text-amber-200">
              <h3 className="font-bold">Important Data Safety Guarantee</h3>
              <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                Executing this action removes <strong>only rows flagged as demo data</strong> (is_demo = TRUE). This <strong>includes the
                demo branches and demo user accounts</strong> seeded by <span className="font-mono text-xs">npm run setup:pg</span> — they are
                intentionally removed so you can add your real branches and users. Any <strong>real records you have entered</strong> are never
                touched, and the <strong>Nepali BS calendar reference data</strong> (bs_calendar_years, bs_day_records) is always preserved.
                To restore the demo dataset, run <span className="font-mono text-xs">npm run setup:pg</span> at any time.
              </p>
            </div>
          </div>

          {/* Confirmation Form */}
          <div className={`rounded-2xl p-6 border shadow-sm space-y-5 bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Confirm Purge Action
            </h3>

            {errorMessage && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400 font-medium">
                {errorMessage}
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                To confirm deletion, please type <span className="font-bold text-red-600 dark:text-red-400 select-all">{requiredConfirm}</span> below:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type CLEAR DEMO DATA"
                className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-sm font-mono focus:ring-2 focus:ring-red-500 outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onNavigateDashboard}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 transition"
              >
                Cancel & Return
              </button>

              <button
                type="button"
                disabled={!isMatch || isClearing}
                onClick={handleExecuteClear}
                className={`px-6 py-2.5 rounded-xl text-xs font-bold text-white flex items-center gap-2 transition shadow-md ${
                  isMatch && !isClearing
                    ? 'bg-red-600 hover:bg-red-700 shadow-red-500/20 cursor-pointer'
                    : 'bg-slate-300 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                }`}
              >
                {isClearing ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Purging Demo Data...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" />
                    <span>Permanently Clear Demo Data</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
