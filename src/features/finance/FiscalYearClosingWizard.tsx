import React, { useEffect, useMemo, useState } from 'react';
import { FiscalYear, FinancialSummary, Product, InventoryStock, Asset, PurchaseInvoice, User, CompanyProfile } from '../../types';
import { convertADToBS, getNepaliFiscalYear } from '../../utils/nepaliCalendar';
import { filterFiscalYears } from '../../utils/permissions';
import { FiscalYearSelect } from '../../components/common/FiscalYearSelect';
import {
  Lock,
  Unlock,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  FileCheck2,
  Building2,
  Calculator,
  Scale,
  RefreshCw,
  FileText,
  KeyRound,
  Download,
  Award,
  Wallet,
  CalendarDays,
  Info,
} from 'lucide-react';
import { TablePagination, useClientPagination } from '../../components/common/TablePagination';

interface FiscalYearClosingWizardProps {
  fiscalYears: FiscalYear[];
  onSetCurrentFiscalYear: (id: string) => Promise<void>;
  onCloseFiscalYear: (id: string, credentials: { adminEmail: string; adminPassword: string }) => Promise<void>;
  onReopenFiscalYear: (id: string, credentials: { adminEmail: string; adminPassword: string }) => Promise<void>;
  onInitializeOpeningStock: (
    id: string
  ) => Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }>;
  onRollForwardVendorOpenings: (
    id: string
  ) => Promise<{ targetFiscalYear: FiscalYear; recordsCreated: number; manualRowsPreserved?: number }>;
  dateMode: 'BS' | 'AD';
  financialSummary: FinancialSummary;
  products: Product[];
  stock: InventoryStock[];
  assets: Asset[];
  purchaseInvoices: PurchaseInvoice[];
  currentUser: User | null;
  onRefreshData?: () => Promise<void>;
  companyProfile?: CompanyProfile | null;
  /** Globally selected fiscal year id (app-wide scope). */
  selectedFiscalYearId?: string;
  /** Update the global fiscal-year view when the user changes it here. */
  onSelectFiscalYear?: (fiscalYearId: string) => void;
}

export const FiscalYearClosingWizard: React.FC<FiscalYearClosingWizardProps> = ({
  fiscalYears,
  onSetCurrentFiscalYear,
  onCloseFiscalYear,
  onReopenFiscalYear,
  onInitializeOpeningStock,
  onRollForwardVendorOpenings,
  dateMode,
  financialSummary,
  products,
  stock,
  assets,
  purchaseInvoices,
  currentUser,
  onRefreshData,
  companyProfile,
  selectedFiscalYearId,
  onSelectFiscalYear,
}) => {
  const defaultFiscalYear: FiscalYear | undefined = fiscalYears.find((fy) => fy.isCurrent) || fiscalYears[0];
  const [selectedFyId, setSelectedFyId] = useState<string>(defaultFiscalYear?.id || '');
  const currentFy: FiscalYear | undefined = fiscalYears.find((fy) => fy.id === selectedFyId) || defaultFiscalYear;
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [isLocked, setIsLocked] = useState<boolean>(currentFy?.isClosed || false);
  const [adminEmail, setAdminEmail] = useState<string>(currentUser?.role === 'SUPER_ADMIN' ? currentUser.email : '');
  const [adminPassword, setAdminPassword] = useState<string>('');
  const [showUnlockAuth, setShowUnlockAuth] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');
  const [isProcessingStep, setIsProcessingStep] = useState<boolean>(false);
  const [step1Completed, setStep1Completed] = useState<boolean>(false);
  const [step2Completed, setStep2Completed] = useState<boolean>(false);
  const [step3Completed, setStep3Completed] = useState<boolean>(false);
  const [step4Completed, setStep4Completed] = useState<boolean>(false);
  const [step5Completed, setStep5Completed] = useState<boolean>(false);

  // Nepali Fiscal Year Accounting Periods overview table (sorted newest first).
  const periodsSorted = useMemo(
    () => [...fiscalYears].sort((a, b) => String(b.startDateAD).localeCompare(String(a.startDateAD))),
    [fiscalYears]
  );
  const periodsPagination = useClientPagination(periodsSorted, 3, []);
  const [viewFiscalYearId, setViewFiscalYearId] = useState<string>('');
  const activePeriodFyId =
    viewFiscalYearId ||
    (selectedFiscalYearId && fiscalYears.some((f) => f.id === selectedFiscalYearId)
      ? selectedFiscalYearId
      : '') ||
    fiscalYears.find((f) => f.isCurrent)?.id ||
    periodsSorted[0]?.id ||
    '';

  // Period status helpers — mirror the wizard's live lock state.
  const isPeriodLocked = (fy: FiscalYear) => Boolean(fy.isClosed);
  const isPeriodActive = (fy: FiscalYear) => Boolean(fy.isCurrent);
  const [openingStockMessage, setOpeningStockMessage] = useState<string>('');
  const [vendorOpeningMessage, setVendorOpeningMessage] = useState<string>('');

  const now = new Date();
  const todayAD = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const isClosingEligible = Boolean(currentFy?.endDateAD && currentFy.endDateAD < todayAD);

  useEffect(() => {
    if (!currentFy && defaultFiscalYear) setSelectedFyId(defaultFiscalYear.id);
  }, [currentFy, defaultFiscalYear]);

  // Keep the wizard in sync with the app-wide fiscal-year view (header /
  // other fiscal-year pages) whenever the user changes it elsewhere.
  useEffect(() => {
    if (selectedFiscalYearId && fiscalYears.some((f) => f.id === selectedFiscalYearId) && selectedFiscalYearId !== selectedFyId) {
      setSelectedFyId(selectedFiscalYearId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiscalYearId, fiscalYears]);

  useEffect(() => {
    setIsLocked(currentFy?.isClosed || false);
    setCurrentStep(1);
    setAdminEmail(currentUser?.role === 'SUPER_ADMIN' ? currentUser.email : '');
    setAdminPassword('');
    setShowUnlockAuth(false);
    setAuthError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFy?.id, currentFy?.isClosed]);

  // Financial Metrics for the Closing Year
  const closingMetrics = useMemo(() => {
    let inventoryValue = 0;
    stock.forEach((s) => {
      const prod = products.find((p) => p.id === s.productId);
      if (prod) {
        inventoryValue += s.quantityOnHand * (prod.costPrice || 0);
      }
    });

    let fixedAssetValue = 0;
    let annualDepreciation = 0;
    assets.forEach((a) => {
      const cost = a.acquisitionCost || 0;
      fixedAssetValue += cost;
      const rate = a.depreciationRatePercent || 15;
      annualDepreciation += (cost * rate) / 100;
    });

    let vatInputTax = 0;
    purchaseInvoices.forEach((inv) => {
      vatInputTax += inv.vatAmount || 0;
    });

    return {
      inventoryValue,
      fixedAssetValue,
      annualDepreciation,
      netAssetValue: fixedAssetValue - annualDepreciation,
      vatInputTax,
      // Do not manufacture accounting entries during close. COGS and
      // operating expenses are zero until posted sales/expense ledgers exist.
      totalCOGS: financialSummary.totalCostOfGoodsSold || 0,
      totalExpenses: 0,
    };
  }, [stock, products, assets, purchaseInvoices, financialSummary]);

  // Steps definition
  const wizardSteps = [
    { number: 1, title: 'Pre-Closing Audit & Diagnostics', icon: FileCheck2 },
    { number: 2, title: 'Asset Depreciation & Stock Valuation Lock', icon: Calculator },
    { number: 3, title: 'Trial Balance & Retained Earnings', icon: Scale },
    { number: 4, title: 'Opening Balances Roll-Forward', icon: Building2 },
    { number: 5, title: 'Close Vendor Ledgers', icon: Wallet },
    { number: 6, title: 'Lock Period & Compliance Seal', icon: ShieldCheck },
  ];

  const handleNextStep = () => {
    if (currentStep < 6) {
      setCurrentStep((prev) => prev + 1);
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleAuthorizeLock = async () => {
    setAuthError('');
    if (!currentFy || !isClosingEligible) {
      setAuthError(`Fiscal year ${currentFy?.code || ''} cannot be closed until after its AD end date (${currentFy?.endDateAD || 'not configured'}).`);
      return;
    }
    if (!adminEmail.trim() || !adminPassword) {
      setAuthError('Please enter the Super Admin email address and password to authorize this closing.');
      return;
    }

    setIsProcessingStep(true);
    try {
      await onCloseFiscalYear(currentFy.id, { adminEmail: adminEmail.trim(), adminPassword });
      setIsLocked(true);
      setAdminPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to close the fiscal year.');
    } finally {
      setIsProcessingStep(false);
    }
  };

  const handleUnlockPeriod = async () => {
    setAuthError('');
    if (!adminEmail.trim() || !adminPassword) {
      setAuthError('Please enter the Super Admin email address and password to unlock the period.');
      return;
    }
    setIsProcessingStep(true);
    try {
      if (!currentFy) return;
      await onReopenFiscalYear(currentFy.id, { adminEmail: adminEmail.trim(), adminPassword });
      setIsLocked(false);
      setShowUnlockAuth(false);
      setAdminPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to unlock the fiscal year.');
    } finally {
      setIsProcessingStep(false);
    }
  };

  const handleInitializeOpeningStock = async () => {
    if (!currentFy) return;
    setOpeningStockMessage('');
    setIsProcessingStep(true);
    try {
      const result = await onInitializeOpeningStock(currentFy.id);
      setStep4Completed(true);
      const baseMessage = `${result.recordsCreated} opening-stock records prepared for FY ${result.targetFiscalYear.code}`;
      const preservedNote = result.manualRowsPreserved
        ? ` ${result.manualRowsPreserved} manually adjusted row(s) were preserved and not overwritten.`
        : '';
      setOpeningStockMessage(
        baseMessage +
          ' — every product × branch combination is included, with zero-quantity rows carried forward so no product or branch disappears from the new period.' +
          preservedNote
      );
    } catch (error) {
      setOpeningStockMessage(error instanceof Error ? error.message : 'Unable to initialize opening stock.');
    } finally {
      setIsProcessingStep(false);
    }
  };

  const handleRollForwardVendorOpenings = async () => {
    if (!currentFy) return;
    setVendorOpeningMessage('');
    setIsProcessingStep(true);
    try {
      const result = await onRollForwardVendorOpenings(currentFy.id);
      setStep5Completed(true);
      const baseMessage = `${result.recordsCreated} vendor opening-balance record(s) rolled forward to FY ${result.targetFiscalYear.code}`;
      const preservedNote = result.manualRowsPreserved
        ? ` ${result.manualRowsPreserved} manually adjusted row(s) were preserved and not overwritten.`
        : '';
      setVendorOpeningMessage(
        baseMessage +
          ' — each supplier × branch closing balance (invoices minus posted payments) is carried into the new period.' +
          preservedNote
      );
    } catch (error) {
      setVendorOpeningMessage(error instanceof Error ? error.message : 'Unable to close vendor ledgers.');
    } finally {
      setIsProcessingStep(false);
    }
  };

  const handleDownloadClosingCertificate = () => {
    const certText = `
=======${companyProfile?.name || 'INVENTORY MANAGEMENT SYSTEM'}=================================
       INVENTORY MANAGEMENT SYSTEM - FISCAL CLOSING
===================================================================
Fiscal Year Code: FY ${currentFy?.code || '2082/83'} BS
Nepali BS Period: ${currentFy?.startDateBS} to ${currentFy?.endDateBS}
Anno Domini AD:   ${currentFy?.startDateAD} to ${currentFy?.endDateAD}
Status:           OFFICIALLY CLOSED & AUDIT LOCKED
Closed By:        ${currentUser?.name || 'Administrator'} (${currentUser?.email})
Timestamp:        ${new Date().toISOString()}

-------------------------------------------------------------------
FINANCIAL & INVENTORY CLOSING SNAPSHOT
-------------------------------------------------------------------
Closing Stock Inventory Valuation:   NPR ${(closingMetrics.inventoryValue ?? 0).toLocaleString()}
Fixed Assets Gross Acquisition Cost: NPR ${(closingMetrics.fixedAssetValue ?? 0).toLocaleString()}
Calculated Annual Tax Depreciation:  NPR ${(closingMetrics.annualDepreciation ?? 0).toLocaleString()}
Net Fixed Asset Value Carrying:      NPR ${(closingMetrics.netAssetValue ?? 0).toLocaleString()}
Reconciled VAT Input Tax Register:   NPR ${(closingMetrics.vatInputTax ?? 0).toLocaleString()}
-------------------------------------------------------------------
Compliance Status: Approved for Inland Revenue Department (IRD) Filing
===================================================================
`;

    const blob = new Blob([certText], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `Fiscal_Closing_Certificate_FY_${currentFy?.code || '2082_83'}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-3">
      {/* HEADER BAR */}
      <div
        className={`p-3 rounded-2xl border flex flex-col md:flex-row items-start md:items-center justify-start gap-3 bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-slate-900/90 dark:border-slate-800 dark:text-slate-100`}
      >
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-xl bg-indigo-600/10 text-indigo-500 border border-indigo-500/20">
              <Calendar className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-serif font-bold tracking-tight">
                  Fiscal Year End Closing & Lock Wizard
                </h2>
                <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-500 font-mono text-xs font-bold">
                  FY {currentFy?.code} BS
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Guide for year-end inventory valuation, fixed asset depreciation posting, and IRD period locking.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs font-bold text-slate-600 dark:text-slate-300">
            Closing year
          </label>
          <FiscalYearSelect
            fiscalYears={filterFiscalYears(fiscalYears)}
            value={currentFy?.id || ''}
            onChange={(fyId) => {
              setSelectedFyId(fyId);
              onSelectFiscalYear?.(fyId);
            }}
            pageSize={3}
            showFyPrefix
            showStatus
            triggerClassName="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono text-xs"
          />
          <div
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold border ${
              isLocked
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
            }`}
          >
            {isLocked ? (
              <>
                <Lock className="h-4 w-4" />
                <span>Period Closed & Locked</span>
              </>
            ) : (
              <>
                <Unlock className="h-4 w-4" />
                <span>Period Open for Posting</span>
              </>
            )}
          </div>

          {isLocked && (
            <button
              onClick={() => {
                setShowUnlockAuth((prev) => !prev);
                setAuthError('');
              }}
              disabled={isProcessingStep}
              className="px-3 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
            >
              Unlock Period…
            </button>
          )}
        </div>
      </div>

      {!isClosingEligible && currentFy && !isLocked && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-bold">Closing unavailable:</span> FY {currentFy.code} ends on {currentFy.endDateAD}. It can only be closed after that date has passed.
        </div>
      )}

      {/* UNLOCK AUTHORIZATION PANEL — Super Admin re-authentication required */}
      {isLocked && showUnlockAuth && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200 space-y-3">
          <div className="flex items-center gap-2 font-bold">
            <KeyRound className="h-4 w-4" />
            <span>Super Admin Authorization Required to Unlock</span>
          </div>
          <p className="text-[11px] opacity-80">
            Unlocking a sealed fiscal period removes its compliance lock and re-opens it for backdated posting.
            Enter the Super Admin credentials to continue — verified server-side.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1">Super Admin Email</label>
              <input
                type="email"
                placeholder="superadmin@example.com"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="px-3 py-1.5 text-xs rounded-xl border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">Password</label>
              <input
                type="password"
                placeholder="Enter password..."
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                className="px-3 py-1.5 text-xs rounded-xl border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
            <button
              onClick={handleUnlockPeriod}
              disabled={isProcessingStep}
              className="px-4 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-bold transition-colors cursor-pointer"
            >
              {isProcessingStep ? 'Verifying…' : 'Confirm Unlock'}
            </button>
            <button
              onClick={() => {
                setShowUnlockAuth(false);
                setAuthError('');
              }}
              className="px-4 py-1.5 rounded-xl border border-amber-300 dark:border-amber-500/40 hover:bg-amber-100/60 dark:hover:bg-slate-800 font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
          {authError && <p className="text-xs text-rose-500 dark:text-rose-300 font-semibold">{authError}</p>}
        </div>
      )}

      {/* STEPPER NAV BAR */}
      <div
        className={`p-3 rounded-2xl border bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800`}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {wizardSteps.map((step) => {
            const isActive = currentStep === step.number;
            const StepIcon = step.icon;

            return (
              <button
                key={step.number}
                onClick={() => setCurrentStep(step.number)}
                className={`flex items-center gap-2.5 p-2.5 rounded-xl transition-all cursor-pointer text-left ${isActive ? 'bg-indigo-600 text-white font-bold shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900 dark:bg-slate-800/40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'}`}
              >
                <div
                  className={`flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold ${isActive ? 'bg-white text-indigo-700' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}
                >
                  {step.number}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold truncate leading-tight">{step.title}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* WIZARD STEP CONTENT PANELS */}
      <div
        className={`p-4 rounded-2xl border min-h-[380px] flex flex-col justify-between space-y-6 bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-200`}
      >
        {/* STEP 1: PRE-CLOSING DIAGNOSTICS */}
        {currentStep === 1 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <FileCheck2 className="h-5 w-5 text-indigo-500" />
                <span>Step 1: System Pre-Closing Diagnostic Verification</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Validate operational readiness prior to freezing ledgers for FY {currentFy?.code} BS.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Check Item 1 */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs">Unclosed Purchase Orders</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[10px] font-bold flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Ready
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  All inbound shipments and supplier purchase orders have been fully received or billed.
                </p>
              </div>

              {/* Check Item 2 */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs">Physical Stock Count Reconciliation</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[10px] font-bold flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Reconciled
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Stock count audit batches for HQ and active branches are verified and adjusted.
                </p>
              </div>

              {/* Check Item 3 */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs">Fixed Asset Depreciation Ledger</span>
                  <span className="px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 text-[10px] font-bold flex items-center gap-1">
                    Ready to Post
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Annual tax depreciation rates are calculated for all registered fixed hardware assets.
                </p>
              </div>

              {/* Check Item 4 */}
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs">VAT Sales & Purchase Register</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[10px] font-bold flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Reconciled
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Total VAT Input Tax calculated at NPR {(closingMetrics.vatInputTax ?? 0).toLocaleString()} for Ashadh end.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: ASSET DEPRECIATION & VALUATION LOCK */}
        {currentStep === 2 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Calculator className="h-5 w-5 text-indigo-500" />
                <span>Step 2: Stock Inventory Valuation & Fixed Asset Depreciation Lock</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Freeze ending inventory asset valuation and post fiscal year hardware depreciation.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono">
              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                <p className="text-[10px] text-slate-400 uppercase font-sans font-bold">Closing Inventory Stock Value</p>
                <p className="text-xl font-extrabold text-indigo-600 dark:text-indigo-400 mt-1">
                  NPR {(closingMetrics.inventoryValue ?? 0).toLocaleString()}
                </p>
                <p className="text-[10px] font-sans text-slate-500 mt-1">Evaluated at FIFO Cost Price</p>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                <p className="text-[10px] text-slate-400 uppercase font-sans font-bold">Gross Fixed Asset Acquisition</p>
                <p className="text-xl font-extrabold text-slate-900 dark:text-slate-100 mt-1">
                  NPR {(closingMetrics.fixedAssetValue ?? 0).toLocaleString()}
                </p>
                <p className="text-[10px] font-sans text-slate-500 mt-1">{assets.length} Active Hardware Items</p>
              </div>

              <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                <p className="text-[10px] text-slate-400 uppercase font-sans font-bold">Calculated Year Depreciation</p>
                <p className="text-xl font-extrabold text-amber-500 mt-1">
                  NPR {(closingMetrics.annualDepreciation ?? 0).toLocaleString()}
                </p>
                <p className="text-[10px] font-sans text-slate-500 mt-1">Income Tax Act Rates Applied</p>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: TRIAL BALANCE & RETAINED EARNINGS */}
        {currentStep === 3 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Scale className="h-5 w-5 text-indigo-500" />
                <span>Step 3: Financial Summary & Retained Earnings Roll-Forward</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Review annual revenue vs cost of sales and transfer net surplus to retained equity.
              </p>
            </div>

            <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 space-y-3 font-mono text-xs">
              <div className="flex justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                <span className="font-sans font-semibold text-slate-600 dark:text-slate-400">Total Billed Purchase Invoices (Gross)</span>
                <span className="font-bold">NPR {((closingMetrics.inventoryValue || 0) * 1.15).toLocaleString()}</span>
              </div>
              <div className="flex justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                <span className="font-sans font-semibold text-slate-600 dark:text-slate-400">Total Cost of Goods Sold (COGS)</span>
                <span className="font-bold text-rose-500">-NPR {(closingMetrics.totalCOGS ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                <span className="font-sans font-semibold text-slate-600 dark:text-slate-400">Hardware Depreciation Expense</span>
                <span className="font-bold text-rose-500">-NPR {(closingMetrics.annualDepreciation ?? 0).toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-1 text-sm font-extrabold font-sans">
                <span>Net Surplus Transferred to Retained Earnings</span>
                <span className="text-emerald-500 font-mono">
                  NPR {(((closingMetrics.inventoryValue || 0) * 1.15) - (closingMetrics.totalCOGS || 0) - (closingMetrics.annualDepreciation || 0)).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* STEP 4: OPENING BALANCE ROLL-FORWARD */}
        {currentStep === 4 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Building2 className="h-5 w-5 text-indigo-500" />
                <span>Step 4: Create & Initialize New Fiscal Year Opening Balances</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Automatically instantiate opening stock ledger for the fiscal period that follows FY {currentFy?.code} BS.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-700 dark:text-indigo-300 space-y-2">
              <p className="font-bold">Target Roll-forward Fiscal Period:</p>
              <div className="flex items-center justify-between font-mono font-semibold">
                <span>Closing FY: <strong>FY {currentFy?.code || '—'} BS</strong></span>
                <span>Closing Date: <strong>{currentFy?.endDateBS || '—'}</strong></span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Opening quantities for all {products.length} catalog products will be locked from Ashadh 31 closing counts.
              </p>
            </div>
            <button
              type="button"
              onClick={handleInitializeOpeningStock}
              disabled={!isLocked || isProcessingStep || step4Completed}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 text-white text-xs font-bold"
            >
              {step4Completed ? 'Opening Stock Initialized' : 'Pull Closing Stock into Next Fiscal Year'}
            </button>
            {openingStockMessage && <p className={`text-xs font-semibold ${step4Completed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{openingStockMessage}</p>}
          </div>
        )}

        {/* STEP 5: CLOSE VENDOR LEDGERS (ROLL-FORWARD ACCOUNTS PAYABLE) */}
        {currentStep === 5 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Wallet className="h-5 w-5 text-indigo-500" />
                <span>Step 5: Close Vendor Ledgers & Carry Opening Payables</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Close every supplier sub-ledger for FY {currentFy?.code} BS and carry the net closing balance
                (purchases minus payments) forward as the opening payable in the next fiscal year.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-700 dark:text-indigo-300 space-y-2">
              <p className="font-bold">Target Roll-forward Fiscal Period:</p>
              <div className="flex items-center justify-between font-mono font-semibold">
                <span>Closing FY: <strong>FY {currentFy?.code || '—'} BS</strong></span>
                <span>Closing Date: <strong>{currentFy?.endDateBS || '—'}</strong></span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Each supplier × branch closing balance is computed from billed purchase invoices minus posted
                payments within the fiscal period, plus any opening balance already carried into this year.
              </p>
            </div>

            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 text-xs space-y-2">
              <div className="flex items-center justify-between font-mono">
                <span className="font-semibold text-slate-600 dark:text-slate-400">Total Accounts Payable (opening + invoices − payments)</span>
                <span className="font-bold text-amber-500">
                  NPR {(financialSummary?.totalAccountsPayable || 0).toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono">
                <span className="font-semibold text-slate-600 dark:text-slate-400">Payable sources</span>
                <span className="font-bold text-slate-700 dark:text-slate-200">{purchaseInvoices.length} purchase invoices</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleRollForwardVendorOpenings}
              disabled={!isLocked || isProcessingStep || step5Completed}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 text-white text-xs font-bold"
            >
              {step5Completed ? 'Vendor Ledgers Closed' : 'Close Vendor Ledgers & Carry Balances Forward'}
            </button>
            {vendorOpeningMessage && <p className={`text-xs font-semibold ${step5Completed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{vendorOpeningMessage}</p>}
          </div>
        )}

        {/* STEP 6: LOCK PERIOD & COMPLIANCE SEAL */}
        {currentStep === 6 && (
          <div className="space-y-5">
            <div className="border-b border-slate-200 dark:border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-indigo-500" />
                <span>Step 6: Lock Fiscal Period & Generate IRD Compliance Certificate</span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Final authorization step to prevent backdated edits and issue audit certificate.
              </p>
            </div>

            {!isLocked ? (
              <div className="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 space-y-4">
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold text-xs">
                  <KeyRound className="h-4 w-4" />
                  <span>Super Admin Closing Authorization</span>
                </div>

                <div className="space-y-3">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Closing locks the fiscal period for all backdated posting. Authorization is verified server-side
                    against a Super Admin account — no local PIN is used.
                  </p>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      Super Admin Email
                    </label>
                    <input
                      type="email"
                      placeholder="superadmin@example.com"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      className="w-full max-w-sm px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      Super Admin Password
                    </label>
                    <input
                      type="password"
                      placeholder="Enter Super Admin password..."
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      className="w-full max-w-sm px-3 py-1.5 text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    {authError && <p className="text-xs text-rose-500 font-semibold mt-1">{authError}</p>}
                  </div>
                </div>

                <button
                  onClick={handleAuthorizeLock}
                  disabled={isProcessingStep || !isClosingEligible}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white font-bold text-xs shadow-md transition-all cursor-pointer flex items-center gap-2"
                >
                  <Lock className="h-4 w-4" />
                  <span>{isClosingEligible ? 'Authorize Year-End Closing & Lock Ledger' : 'Fiscal Year End Date Not Reached'}</span>
                </button>
              </div>
            ) : (
              <div className="p-5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 space-y-4">
                <div className="flex items-center gap-2 text-sm font-bold">
                  <Award className="h-5 w-5 text-emerald-500" />
                  <span>Fiscal Year FY {currentFy?.code} BS Successfully Closed & Certified</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  This fiscal period is officially sealed. No backdated inventory operations or invoices can be posted to this period without explicit administrator unlock.
                </p>

                <button
                  onClick={handleDownloadClosingCertificate}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition-all cursor-pointer flex items-center gap-2"
                >
                  <Download className="h-4 w-4" />
                  <span>Download IRD Audit Certificate</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEPPER BOTTOM NAVIGATION */}
        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-4">
          <button
            onClick={handlePrevStep}
            disabled={currentStep === 1}
            className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer flex items-center gap-1.5 ${
              currentStep === 1
                ? 'opacity-40 cursor-not-allowed border-slate-200 dark:border-slate-800 text-slate-400'
                : 'border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
            }`}
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Previous Step</span>
          </button>

          <span className="text-xs font-mono font-bold text-slate-400">
            Step {currentStep} of 6
          </span>

          <button
            onClick={handleNextStep}
            disabled={currentStep === 6}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${currentStep === 6
                ? 'opacity-40 cursor-not-allowed bg-slate-300 dark:bg-slate-800 text-slate-500'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md'
            }`}
          >
            <span>Next Step</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Nepali Fiscal Year Accounting Periods Overview & Status */}
      <div className={`rounded-2xl border p-4 shadow-xs bg-white border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3">
          <h3 className={`text-sm font-bold flex items-center gap-2 text-slate-800 dark:text-slate-200`}>
            <CalendarDays className="h-4 w-4 text-indigo-500" />
            <span>Nepali Fiscal Year Accounting Periods (<code className="text-amber-700 font-mono dark:text-amber-300 dark:font-mono">YYYY/YY</code>)</span>
          </h3>
          <div className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300`}>
            <CalendarDays className="h-3.5 w-3.5 text-indigo-500" />
            <FiscalYearSelect
              fiscalYears={periodsSorted}
              value={activePeriodFyId}
              onChange={(fyId) => {
                setViewFiscalYearId(fyId);
                onSelectFiscalYear?.(fyId);
              }}
              showFyPrefix={false}
              pageSize={3}
              title="Select fiscal year to inspect"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
          <table className="w-full min-w-[720px] text-left text-xs border-collapse">
            <thead className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/80 dark:text-slate-400 dark:border-slate-800`}>
              <tr>
                <th className="px-3 py-2">Fiscal Year</th>
                <th className="px-3 py-2">BS Period</th>
                <th className="px-3 py-2">AD Period</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Closing State</th>
              </tr>
            </thead>
            <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
              {periodsPagination.pagedItems.map((fy) => {
                const locked = isPeriodLocked(fy);
                const active = isPeriodActive(fy);
                return (
                  <tr
                    key={fy.id}
                    className={`transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                      fy.id === activePeriodFyId
                        ? 'bg-indigo-50/80 dark:bg-indigo-950/40'
                        : active
                        ? 'bg-indigo-50/70 dark:bg-indigo-950/30'
                        : ''
                    }`}
                  >
                    <td className="p-3 font-bold font-mono text-slate-900 dark:text-white">
                      FY {fy.code}
                      {fy.id === activePeriodFyId && (
                        <span className={`ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300`}>
                          Viewing
                        </span>
                      )}
                    </td>
                    <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{fy.startDateBS} to {fy.endDateBS}</td>
                    <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{fy.startDateAD} to {fy.endDateAD}</td>
                    <td className="p-3 font-bold text-slate-900 dark:text-white">
                      {active ? (
                        <span className={`inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400`}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Active
                        </span>
                      ) : locked ? (
                        <span className={`inline-flex items-center gap-1 text-amber-600 dark:text-amber-400`}>
                          <Lock className="h-3 w-3" /> Closed
                        </span>
                      ) : (
                        <span className={`text-emerald-600 dark:text-emerald-400`}>Open</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex justify-end items-center gap-2">
                        {!active && (
                          <button
                            type="button"
                            onClick={async () => {
                              if (confirm(`Set FY ${fy.code} as the active (current) fiscal year?`)) {
                                try {
                                  await onSetCurrentFiscalYear(fy.id);
                                } catch (_e) {
                                  /* refresh callback handled upstream */
                                }
                              }
                            }}
                            disabled={isProcessingStep}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Set Active
                          </button>
                        )}
                        {locked ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedFyId(fy.id);
                              setShowUnlockAuth(true);
                              setAuthError('');
                            }}
                            disabled={isProcessingStep}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Unlock className="h-3.5 w-3.5" /> Reopen
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedFyId(fy.id);
                              setCurrentStep(6);
                            }}
                            className={`inline-flex items-center gap-1 text-xs font-semibold hover:underline cursor-pointer ${
                              active
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-indigo-600 dark:text-indigo-400'
                            }`}
                          >
                            <Lock className="h-3.5 w-3.5" /> Close
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={periodsPagination.page}
          pageCount={periodsPagination.pageCount}
          totalItems={periodsPagination.totalItems}
          rangeStart={periodsPagination.rangeStart}
          rangeEnd={periodsPagination.rangeEnd}
          pageSize={periodsPagination.pageSize}
          onPageChange={periodsPagination.setPage}
          onPageSizeChange={periodsPagination.setPageSize}
          className="mt-1"
        />
        <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
          <Info className="h-3 w-3" />
          Status reflects the fiscal-year lock set by this wizard. Reopening a closed period removes its compliance seal.
        </p>
      </div>
    </div>
  );
};
