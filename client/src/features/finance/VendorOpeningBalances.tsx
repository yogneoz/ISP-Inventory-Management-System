import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActivationKey } from '../../components/common/KeepMounted';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Download,
  Layers,
  Lock,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import { api } from '../../services/api';
import { createLatestOnly } from '../../utils/latestOnly';
import { exportToCSV, CSVColumn } from '../../utils/exportUtils';
import { filterFiscalYears, getScopedBranches, isOperationAllowed } from '../../utils/permissions';
import { FiscalYearSelect } from '../../components/common/FiscalYearSelect';
import { FilterCard } from '../../components/common/FilterCard';
import { CustomerPicker } from '../../components/common/CustomerPicker';
import { formatNPR } from '../../utils/nprFormat';
import {
  Branch,
  CustomerRecord,
  FiscalYear,
  FiscalYearOpeningStockResponse,
  FiscalYearOpeningStockRow,
  Product,
  Supplier,
  User,
  VendorOpeningBalanceResponse,
  VendorOpeningBalanceRow,
} from '../../types';
import type {
  AccountingAccount,
  AccountingJournalLineInput,
  PostingDefaultsResponse,
} from '../../services/api/accounting';
import { useBootstrapData } from '../../contexts/AppProviders';

interface VendorOpeningBalancesProps {
  currentUser?: User | null;
  fiscalYears: FiscalYear[];
  onRefreshData?: () => void;
  /** Globally selected fiscal year id (app-wide scope). */
  selectedFiscalYearId?: string;
  /** Update the global fiscal-year view when the user changes it here. */
  onSelectFiscalYear?: (fiscalYearId: string) => void;
}

type OpeningBalanceTab = 'VENDORS' | 'CUSTOMERS' | 'STOCK' | 'GL';

interface GlLineDraft {
  id: string;
  accountId: string;
  debit: string;
  credit: string;
}

interface CustomerOpeningDraft {
  id: string;
  customer: CustomerRecord;
  amount: string;
}

let glDraftSeq = 0;
function newGlLine(): GlLineDraft {
  glDraftSeq += 1;
  return { id: `gl-line-${glDraftSeq}`, accountId: '', debit: '', credit: '' };
}

/**
 * Vendor Opening Balances (Accounts Payable) — standalone register tab.
 *
 * Supplier × branch opening payables rolled forward from the Vendor Ledger
 * close step in the Fiscal Year Closing Wizard. Editable while the fiscal
 * year is open; corrections are stamped MANUAL_ADJUSTMENT and audited.
 */
export const VendorOpeningBalances: React.FC<VendorOpeningBalancesProps> = ({
  currentUser,
  fiscalYears,
  onRefreshData,
  selectedFiscalYearId,
  onSelectFiscalYear,
}) => {
  // Workspace data: owned by BootstrapDataProvider (step 6 of the App split).
  const { branches, products, suppliers } = useBootstrapData();
  const role = currentUser?.role;
  const canView = isOperationAllowed('opening-stock-view', role);
  const canEditRole = isOperationAllowed('opening-stock-edit', role);
  const canPostGl = isOperationAllowed('gl-opening-post', role);

  // Same branch contract as the opening-stock register: only the account's own
  // branches are offered, displayed or submitted (the server refuses the rest).
  const scopedBranches = useMemo(() => getScopedBranches(currentUser, branches), [currentUser, branches]);
  const scopedBranchIds = useMemo(() => new Set(scopedBranches.map((b) => b.id)), [scopedBranches]);

  const defaultFyId = useMemo(() => {
    // Prioritize current fiscal year, then first open, then first available
    const current = fiscalYears.find((f) => f.isCurrent);
    if (current) return current.id;
    const open = fiscalYears.find((f) => !f.isClosed);
    if (open) return open.id;
    return fiscalYears[0]?.id || '';
  }, [fiscalYears]);

  // Filter fiscal years using shared utility: show closed, current, and within-date-range years only
  const availableFiscalYears = useMemo(() => filterFiscalYears(fiscalYears), [fiscalYears]);

  const [selectedFyId, setSelectedFyId] = useState<string>(defaultFyId);
  const [vendorData, setVendorData] = useState<VendorOpeningBalanceResponse | null>(null);
  const [vendorLoading, setVendorLoading] = useState<boolean>(false);
  const [vendorLoadError, setVendorLoadError] = useState<string>('');
  const [vendorDrafts, setVendorDrafts] = useState<Record<string, { openingBalance: string }>>({});
  const [vendorSaving, setVendorSaving] = useState<boolean>(false);
  const [vendorSaveMessage, setVendorSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [vendorGenerating, setVendorGenerating] = useState<boolean>(false);
  const [vendorGenMessage, setVendorGenMessage] = useState<string>('');
  const [vendorSearch, setVendorSearch] = useState<string>('');
  // FilterCard owns the keystroke draft; an export clicked before the debounce
  // applies must use the text the operator can see, not the previous search.
  const searchDraftRef = useRef<string | null>(null);
  const [vendorBranchFilter, setVendorBranchFilter] = useState<string>('ALL');
  const [vendorNonZeroOnly, setVendorNonZeroOnly] = useState<boolean>(false);
  const [vendorChangedOnly, setVendorChangedOnly] = useState<boolean>(false);
  const [vendorNewRows, setVendorNewRows] = useState<VendorOpeningBalanceRow[]>([]);
  const [vendorRemoved, setVendorRemoved] = useState<Array<{ supplierId: string; branchId: string }>>([]);
  const [vendorAddSupplierId, setVendorAddSupplierId] = useState<string>('');
  const [vendorAddBranchId, setVendorAddBranchId] = useState<string>('');
  const [vendorAddAmount, setVendorAddAmount] = useState<string>('');
  const [vendorOffsetAccountId, setVendorOffsetAccountId] = useState<string>('');
  const vendorNewRowSeq = useRef(0);

  // Opening Balances hub: Vendors is the existing register; General Ledger is
  // the screen for the previously API-only `POST /api/accounting/opening-balances`.
  const [activeTab, setActiveTab] = useState<OpeningBalanceTab>('VENDORS');
  const [glBranchId, setGlBranchId] = useState<string>('');
  const [glAccounts, setGlAccounts] = useState<AccountingAccount[]>([]);
  const [glAccountsLoading, setGlAccountsLoading] = useState<boolean>(false);
  const [glAccountsError, setGlAccountsError] = useState<string>('');
  const [glLines, setGlLines] = useState<GlLineDraft[]>(() => [newGlLine(), newGlLine()]);
  const [glPosting, setGlPosting] = useState<boolean>(false);
  const [glMessage, setGlMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [postingDefaults, setPostingDefaults] = useState<PostingDefaultsResponse | null>(null);
  const [postingDefaultsError, setPostingDefaultsError] = useState<string>('');
  const [customerDrafts, setCustomerDrafts] = useState<CustomerOpeningDraft[]>([]);
  const [pendingCustomer, setPendingCustomer] = useState<CustomerRecord | null>(null);
  const [pendingCustomerAmount, setPendingCustomerAmount] = useState<string>('');
  const [customerOffsetAccountId, setCustomerOffsetAccountId] = useState<string>('');
  const [customerPosting, setCustomerPosting] = useState<boolean>(false);
  const [customerMessage, setCustomerMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Stock tab: the opening-stock register plus the journal it posts. The
  // quantity rows and the balanced Dr Inventory / Cr opening-equity journal
  // are saved in one server transaction; a re-save replaces the prior journal.
  const [stockData, setStockData] = useState<FiscalYearOpeningStockResponse | null>(null);
  const [stockLoading, setStockLoading] = useState<boolean>(false);
  const [stockLoadError, setStockLoadError] = useState<string>('');
  const [stockDrafts, setStockDrafts] = useState<
    Record<string, { quantityOnHand: string; damagedQty: string; unitCost: string }>
  >({});
  const [stockSaving, setStockSaving] = useState<boolean>(false);
  const [stockMessage, setStockMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [stockBranchId, setStockBranchId] = useState<string>('');
  const [stockOffsetAccountId, setStockOffsetAccountId] = useState<string>('');
  const [stockAddProductId, setStockAddProductId] = useState<string>('');
  const [stockAddQty, setStockAddQty] = useState<string>('0');
  const [stockAddDamaged, setStockAddDamaged] = useState<string>('0');
  const [stockAddCost, setStockAddCost] = useState<string>('0');

  // A profile switch must not leave the filter pointing at a branch the
  // account no longer holds.
  useEffect(() => {
    if (vendorBranchFilter !== 'ALL' && !scopedBranchIds.has(vendorBranchFilter)) setVendorBranchFilter('ALL');
  }, [vendorBranchFilter, scopedBranchIds]);

  // Real branches only: `ALL` is a consolidated view, never a posting target.
  const glBranchOptions = useMemo(() => scopedBranches.filter((b) => b.id !== 'ALL'), [scopedBranches]);
  useEffect(() => {
    if (!glBranchOptions.some((b) => b.id === glBranchId)) {
      setGlBranchId(glBranchOptions[0]?.id || '');
    }
  }, [glBranchOptions, glBranchId]);
  useEffect(() => {
    if (!glBranchOptions.some((b) => b.id === stockBranchId)) {
      setStockBranchId(glBranchOptions[0]?.id || '');
    }
  }, [glBranchOptions, stockBranchId]);
  useEffect(() => {
    if (!glBranchOptions.some((b) => b.id === vendorAddBranchId)) {
      setVendorAddBranchId(glBranchOptions[0]?.id || '');
    }
  }, [glBranchOptions, vendorAddBranchId]);

  // Customer rows belong to the selected branch; changing branch must not
  // leave rows from the previous one in a payload for the new one.
  useEffect(() => {
    setCustomerDrafts([]);
    setPendingCustomer(null);
    setPendingCustomerAmount('');
    setCustomerMessage(null);
  }, [glBranchId]);

  useEffect(() => {
    if (!fiscalYears.some((f) => f.id === selectedFyId)) {
      setSelectedFyId(defaultFyId);
    }
  }, [fiscalYears, selectedFyId, defaultFyId]);

  // Keep the register in sync with the app-wide fiscal-year view (header /
  // fiscal year closing wizard) whenever the user changes it elsewhere.
  useEffect(() => {
    if (selectedFiscalYearId && fiscalYears.some((f) => f.id === selectedFiscalYearId) && selectedFiscalYearId !== selectedFyId) {
      setSelectedFyId(selectedFiscalYearId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiscalYearId, fiscalYears]);

  // Sequence guard (DF-08): switching fiscal year while a request is in flight
  // must not let the slower previous response paint over the newer one.
  const fetchSeq = useRef(createLatestOnly()).current;

  const fetchVendorRegister = useCallback(async (fyId: string) => {
    if (!fyId) return;
    const ticket = fetchSeq.begin();
    setVendorLoading(true);
    setVendorLoadError('');
    setVendorSaveMessage(null);
    setVendorDrafts({});
    try {
      const res = await api.getVendorOpeningBalances(fyId);
      if (!fetchSeq.isCurrent(ticket)) return;
      setVendorData(res);
    } catch (error) {
      if (!fetchSeq.isCurrent(ticket)) return;
      setVendorData(null);
      setVendorLoadError(error instanceof Error ? error.message : 'Unable to load the vendor opening-balance register.');
    } finally {
      if (fetchSeq.isCurrent(ticket)) setVendorLoading(false);
    }
  }, [fetchSeq]);

  // Refetch the register on every tab re-activation (keep-mounted: no remount refetch anymore).
  const activationKey = useActivationKey('vendor-opening-balances');

  useEffect(() => {
    setVendorNewRows([]);
    setVendorRemoved([]);
    setVendorAddSupplierId('');
    setVendorAddAmount('');
  }, [selectedFyId]);

  useEffect(() => {
    fetchVendorRegister(selectedFyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFyId, fetchVendorRegister, activationKey]);

  const stockFetchSeq = useRef(createLatestOnly()).current;
  const fetchStockRegister = useCallback(
    async (fyId: string) => {
      if (!fyId) return;
      const ticket = stockFetchSeq.begin();
      setStockLoading(true);
      setStockLoadError('');
      setStockMessage(null);
      setStockDrafts({});
      try {
        const res = await api.getFiscalYearOpeningStock(fyId);
        if (!stockFetchSeq.isCurrent(ticket)) return;
        setStockData(res);
      } catch (error) {
        if (!stockFetchSeq.isCurrent(ticket)) return;
        setStockData(null);
        setStockLoadError(error instanceof Error ? error.message : 'Unable to load the opening-stock register.');
      } finally {
        if (stockFetchSeq.isCurrent(ticket)) setStockLoading(false);
      }
    },
    [stockFetchSeq]
  );

  useEffect(() => {
    if (activeTab !== 'STOCK') return;
    fetchStockRegister(selectedFyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedFyId, activationKey, fetchStockRegister]);

  useEffect(() => {
    setStockDrafts({});
    setStockMessage(null);
    setStockAddProductId('');
    setStockAddQty('0');
    setStockAddDamaged('0');
    setStockAddCost('0');
  }, [stockBranchId, selectedFyId]);

  const fy = vendorData?.fiscalYear;
  const periodLocked = Boolean(fy?.isClosed);
  const canEdit = canEditRole && !periodLocked;

  const previousFy = useMemo(() => {
    const sorted = [...fiscalYears].sort((a, b) => a.startDateAD.localeCompare(b.startDateAD));
    const idx = sorted.findIndex((f) => f.id === selectedFyId);
    return idx > 0 ? sorted[idx - 1] : null;
  }, [fiscalYears, selectedFyId]);

  const getVendorDraft = (row: VendorOpeningBalanceRow): { openingBalance: string } =>
    vendorDrafts[row.id] || { openingBalance: String(row.openingBalance) };
  const updateVendorDraft = (rowId: string, value: string) => {
    setVendorDrafts((prev) => ({
      ...prev,
      [rowId]: { openingBalance: value },
    }));
  };
  const isVendorNewRow = (row: VendorOpeningBalanceRow): boolean => row.id.startsWith('vnew-');
  const vendorRemovedKeys = useMemo(
    () => new Set(vendorRemoved.map((row) => `${row.supplierId}:${row.branchId}`)),
    [vendorRemoved]
  );
  const vendorRows = useMemo(
    () =>
      [...(vendorData?.rows || []), ...vendorNewRows].filter(
        (row) => scopedBranchIds.has(row.branchId) && !vendorRemovedKeys.has(`${row.supplierId}:${row.branchId}`)
      ),
    [vendorData, vendorNewRows, scopedBranchIds, vendorRemovedKeys]
  );
  const isVendorRowChanged = (row: VendorOpeningBalanceRow): boolean => {
    if (isVendorNewRow(row)) return true;
    if (!vendorDrafts[row.id]) return false;
    return Number(vendorDrafts[row.id].openingBalance) !== Number(row.openingBalance);
  };
  const changedVendorRows = useMemo(
    () => vendorRows.filter((row) => isVendorRowChanged(row)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendorRows, vendorDrafts]
  );
  const filterVendorRows = (searchTerm: string) => {
    const q = searchTerm.trim().toLowerCase();
    return vendorRows.filter((row) => {
      if (vendorBranchFilter !== 'ALL' && row.branchId !== vendorBranchFilter) return false;
      if (vendorNonZeroOnly && Number(getVendorDraft(row).openingBalance) === 0) return false;
      if (vendorChangedOnly && !isVendorRowChanged(row)) return false;
      if (
        q &&
        !row.supplierName.toLowerCase().includes(q) &&
        !row.supplierCode.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  };
  const filteredVendorRows = useMemo(
    () => filterVendorRows(vendorSearch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendorRows, vendorSearch, vendorBranchFilter, vendorNonZeroOnly, vendorChangedOnly, vendorDrafts]
  );
  const vendorLiveStats = useMemo(() => {
    const values = vendorRows.map((row) => Number(getVendorDraft(row).openingBalance) || 0);
    return {
      totalRows: values.length,
      manualAdjustments: vendorRows.filter(
        (row) => isVendorNewRow(row) || row.sourceType === 'MANUAL_ADJUSTMENT'
      ).length,
      totalDebitOpening: values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
      totalCreditOpening: values
        .filter((value) => value < 0)
        .reduce((sum, value) => sum + Math.abs(value), 0),
      netOpening: values.reduce((sum, value) => sum + value, 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorRows, vendorDrafts]);

  const validateVendorDraftRow = (row: VendorOpeningBalanceRow): string | null => {
    const d = getVendorDraft(row);
    const balance = Number(d.openingBalance);
    if (d.openingBalance === '' || !Number.isFinite(balance)) {
      return `Opening balance must be a number for ${row.supplierName} @ ${row.branchName}.`;
    }
    if (isVendorNewRow(row) && balance === 0) {
      return `Opening balance must be non-zero for ${row.supplierName} @ ${row.branchName}.`;
    }
    return null;
  };

  const handleAddVendorRow = () => {
    const supplier = suppliers.find((entry) => entry.id === vendorAddSupplierId);
    if (!supplier) {
      setVendorSaveMessage({ type: 'error', text: 'Select a supplier to add to opening balances.' });
      return;
    }
    if (!vendorAddBranchId || !scopedBranchIds.has(vendorAddBranchId)) {
      setVendorSaveMessage({ type: 'error', text: 'Select a branch within your access.' });
      return;
    }
    const amount = Number(vendorAddAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      setVendorSaveMessage({ type: 'error', text: 'Opening balance must be a non-zero number.' });
      return;
    }
    const key = `${supplier.id}:${vendorAddBranchId}`;
    if (vendorRemovedKeys.has(key)) {
      setVendorRemoved((prev) => prev.filter((row) => `${row.supplierId}:${row.branchId}` !== key));
      setVendorAddSupplierId('');
      setVendorAddAmount('');
      setVendorSaveMessage(null);
      return;
    }
    if (vendorRows.some((row) => `${row.supplierId}:${row.branchId}` === key)) {
      setVendorSaveMessage({ type: 'error', text: 'That supplier already has a row for the selected branch.' });
      return;
    }
    const branch = glBranchOptions.find((entry) => entry.id === vendorAddBranchId);
    vendorNewRowSeq.current += 1;
    const row: VendorOpeningBalanceRow = {
      id: `vnew-${vendorNewRowSeq.current}`,
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierCode: supplier.supplierCode || supplier.id,
      branchId: vendorAddBranchId,
      branchName: branch?.name || vendorAddBranchId,
      openingBalance: amount,
      ledgerBalance: 0,
      sourceType: 'MANUAL_ADJUSTMENT',
      sourceReference: null,
      postedAt: null,
      postedBy: null,
    };
    setVendorNewRows((prev) => [...prev, row]);
    setVendorDrafts((prev) => ({ ...prev, [row.id]: { openingBalance: String(amount) } }));
    setVendorAddSupplierId('');
    setVendorAddAmount('');
    setVendorSaveMessage(null);
  };

  const removeVendorRow = (row: VendorOpeningBalanceRow) => {
    if (isVendorNewRow(row)) {
      setVendorNewRows((prev) => prev.filter((entry) => entry.id !== row.id));
      setVendorDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } else {
      setVendorRemoved((prev) => [
        ...prev.filter((entry) => `${entry.supplierId}:${entry.branchId}` !== `${row.supplierId}:${row.branchId}`),
        { supplierId: row.supplierId, branchId: row.branchId },
      ]);
    }
    setVendorSaveMessage(null);
  };

  const handleSaveVendorAdjustments = async () => {
    if (!vendorData || !canEdit) return;
    if (!apControl) {
      setVendorSaveMessage({
        type: 'error',
        text: 'The chart has no active AP_CONTROL supplier account. Configure posting defaults first.',
      });
      return;
    }
    if (!vendorOffsetAccountId || !customerOffsetAccounts.some((account) => account.id === vendorOffsetAccountId)) {
      setVendorSaveMessage({ type: 'error', text: 'Select an equity account for the opening-balance offset.' });
      return;
    }
    if (changedVendorRows.length === 0 && vendorRemoved.length === 0) return;
    for (const row of changedVendorRows) {
      const issue = validateVendorDraftRow(row);
      if (issue) {
        setVendorSaveMessage({ type: 'error', text: issue });
        return;
      }
    }
    setVendorSaving(true);
    setVendorSaveMessage(null);
    try {
      const payload = changedVendorRows.map((row) => ({
        supplierId: row.supplierId,
        branchId: row.branchId,
        openingBalance: Number(getVendorDraft(row).openingBalance),
      }));
      const res = await api.adjustVendorOpeningBalances(
        selectedFyId,
        payload,
        vendorOffsetAccountId,
        vendorRemoved
      );
      await fetchVendorRegister(selectedFyId);
      setVendorNewRows([]);
      setVendorRemoved([]);
      const posted = (res.journals || [])
        .map(
          (entry) =>
            `${entry.journalNo} in ${entry.periodKey} (${formatNPR(entry.totalValue)})`
        )
        .join('; ');
      setVendorSaveMessage({
        type: 'success',
        text: `${res.message}${posted ? ` Posted opening journal ${posted}.` : ' No non-zero balances remain, so no opening journal was posted.'}`,
      });
      onRefreshData?.();
    } catch (error) {
      setVendorSaveMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save vendor opening-balance adjustments.',
      });
    } finally {
      setVendorSaving(false);
    }
  };

  const handleGenerateVendorOpenings = async () => {
    if (!previousFy) {
      setVendorGenMessage(
        'No previous fiscal year exists. Vendor opening balances are rolled forward from the closing of a prior fiscal year — create and close one first (Fiscal Year Closing Wizard).'
      );
      return;
    }
    if (!previousFy.isClosed) {
      setVendorGenMessage(
        `The previous fiscal year (${previousFy.code}) must be closed first via the Fiscal Year Closing Wizard before vendor opening balances can be rolled forward for ${fy?.code || 'this year'}.`
      );
      return;
    }
    setVendorGenerating(true);
    setVendorGenMessage('');
    try {
      const res = await api.rollForwardVendorOpenings(previousFy.id);
      setVendorGenMessage(
        `${res.recordsCreated} vendor opening-balance record(s) rolled forward to FY ${res.targetFiscalYear.code} from closing balances of ${previousFy.code}.` +
          (res.manualRowsPreserved ? ` ${res.manualRowsPreserved} manual adjustment row(s) were preserved.` : '')
      );
      await fetchVendorRegister(selectedFyId);
      setVendorNewRows([]);
      setVendorRemoved([]);
      onRefreshData?.();
    } catch (error) {
      setVendorGenMessage(error instanceof Error ? error.message : 'Unable to roll forward vendor opening balances.');
    } finally {
      setVendorGenerating(false);
    }
  };

  const handleExportVendor = () => {
    if (!vendorData || filteredVendorRows.length === 0) return;
    const columns: CSVColumn<VendorOpeningBalanceRow>[] = [
      { key: 'supplierCode', label: 'Supplier Code' },
      { key: 'supplierName', label: 'Supplier' },
      { key: 'branchName', label: 'Branch' },
      { key: 'openingBalance', label: 'Opening Balance (NPR)' },
      { key: 'sourceType', label: 'Source' },
      { key: 'postedBy', label: 'Posted By' },
      { key: 'postedAt', label: 'Posted At' },
    ];
    exportToCSV({
      filename: `Fiscal_Opening_Vendors_${fy?.code || selectedFyId}`.replace(/\//g, '-'),
      data: filterVendorRows(searchDraftRef.current ?? vendorSearch),
      columns,
      reportTitle: `Fiscal Year Opening Register — Vendor Opening Balances — FY ${fy?.code || ''}`,
      generatedBy: currentUser?.name,
    });
  };

  // The GL tab loads the active, non-control chart once. Control accounts
  // need a party on every line and this trial-balance form has no party
  // picker; showing them would create a submission the ledger must reject.
  useEffect(() => {
    if (
      (activeTab !== 'GL' && activeTab !== 'CUSTOMERS' && activeTab !== 'STOCK' && activeTab !== 'VENDORS') ||
      glAccounts.length > 0
    )
      return;
    let cancelled = false;
    setGlAccountsLoading(true);
    setGlAccountsError('');
    api
      .getAccountingAccounts(false)
      .then((rows) => {
        if (cancelled) return;
        setGlAccounts(rows.filter((row) => row.isActive && !row.isControl));
      })
      .catch((error) => {
        if (cancelled) return;
        setGlAccountsError(error instanceof Error ? error.message : 'Unable to load the chart of accounts.');
      })
      .finally(() => {
        if (!cancelled) setGlAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, glAccounts.length]);

  useEffect(() => {
    if (
      (activeTab !== 'CUSTOMERS' && activeTab !== 'STOCK' && activeTab !== 'VENDORS') ||
      postingDefaults ||
      postingDefaultsError
    )
      return;
    let cancelled = false;
    api
      .getPostingDefaults()
      .then((response) => {
        if (!cancelled) setPostingDefaults(response);
      })
      .catch((error) => {
        if (!cancelled) {
          setPostingDefaultsError(
            error instanceof Error ? error.message : 'Unable to load the Accounts Receivable control account.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, postingDefaults, postingDefaultsError]);

  const arControl = postingDefaults?.defaults?.AR_CONTROL || null;
  const apControl = postingDefaults?.defaults?.AP_CONTROL || null;
  const inventoryControl = postingDefaults?.defaults?.INVENTORY || null;
  const customerOffsetAccounts = useMemo(
    () => glAccounts.filter((account) => account.accountType === 'EQUITY' && !account.isControl),
    [glAccounts]
  );

  useEffect(() => {
    if (customerOffsetAccountId && customerOffsetAccounts.some((account) => account.id === customerOffsetAccountId)) {
      return;
    }
    const retained = customerOffsetAccounts.find((account) => account.postingRole === 'RETAINED_EARNINGS');
    setCustomerOffsetAccountId(retained?.id || customerOffsetAccounts[0]?.id || '');
  }, [customerOffsetAccounts, customerOffsetAccountId]);

  useEffect(() => {
    if (stockOffsetAccountId && customerOffsetAccounts.some((account) => account.id === stockOffsetAccountId)) {
      return;
    }
    const retained = customerOffsetAccounts.find((account) => account.postingRole === 'RETAINED_EARNINGS');
    setStockOffsetAccountId(retained?.id || customerOffsetAccounts[0]?.id || '');
  }, [customerOffsetAccounts, stockOffsetAccountId]);

  useEffect(() => {
    if (vendorOffsetAccountId && customerOffsetAccounts.some((account) => account.id === vendorOffsetAccountId)) {
      return;
    }
    const retained = customerOffsetAccounts.find((account) => account.postingRole === 'RETAINED_EARNINGS');
    setVendorOffsetAccountId(retained?.id || customerOffsetAccounts[0]?.id || '');
  }, [customerOffsetAccounts, vendorOffsetAccountId]);

  const searchOpeningCustomers = useCallback(
    async (query: string) => {
      if (!glBranchId) return [];
      return api.searchCustomers(query, 20, glBranchId);
    },
    [glBranchId]
  );

  const glDraftLines = useMemo(
    () =>
      glLines.filter(
        (line) => line.accountId || line.debit.trim() !== '' || line.credit.trim() !== ''
      ),
    [glLines]
  );
  const glTotalDebit = useMemo(
    () => glDraftLines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0),
    [glDraftLines]
  );
  const glTotalCredit = useMemo(
    () => glDraftLines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0),
    [glDraftLines]
  );
  const glDifference = Math.round((glTotalDebit - glTotalCredit) * 100) / 100;
  const glBalanced = glTotalDebit > 0 && glDifference === 0;

  const updateGlLine = (lineId: string, patch: Partial<GlLineDraft>) => {
    setGlLines((prev) => prev.map((line) => (line.id === lineId ? { ...line, ...patch } : line)));
    setGlMessage(null);
  };
  const addGlLine = () => setGlLines((prev) => [...prev, newGlLine()]);
  const removeGlLine = (lineId: string) => {
    setGlLines((prev) => (prev.length <= 2 ? prev : prev.filter((line) => line.id !== lineId)));
    setGlMessage(null);
  };

  const handlePostGlOpening = async () => {
    if (!canPostGl || glPosting) return;
    if (!glBranchId || !glBranchOptions.some((branch) => branch.id === glBranchId)) {
      setGlMessage({ type: 'error', text: 'Select a branch within your access before posting opening balances.' });
      return;
    }
    if (glDraftLines.length < 2) {
      setGlMessage({ type: 'error', text: 'At least two opening-balance lines are required.' });
      return;
    }
    const lines: AccountingJournalLineInput[] = [];
    for (const line of glDraftLines) {
      if (!line.accountId) {
        setGlMessage({ type: 'error', text: 'Every line needs an account.' });
        return;
      }
      const debit = line.debit.trim() === '' ? 0 : Number(line.debit);
      const credit = line.credit.trim() === '' ? 0 : Number(line.credit);
      if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) {
        setGlMessage({ type: 'error', text: 'Debit and credit must be non-negative numbers.' });
        return;
      }
      if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
        setGlMessage({ type: 'error', text: 'Put an amount on exactly one side of each line.' });
        return;
      }
      lines.push({ accountId: line.accountId, debit, credit });
    }
    if (glDifference !== 0) {
      setGlMessage({
        type: 'error',
        text: `Opening balances must balance. Debit ${formatNPR(glTotalDebit)} vs credit ${formatNPR(glTotalCredit)} differs by ${formatNPR(Math.abs(glDifference))}.`,
      });
      return;
    }
    setGlPosting(true);
    setGlMessage(null);
    try {
      const journal = await api.postOpeningBalances({ branchId: glBranchId, lines, register: 'GL' });
      setGlMessage({
        type: 'success',
        text: `Opening balances posted as journal ${journal.journalNo} in period ${journal.periodKey}.`,
      });
      setGlLines([newGlLine(), newGlLine()]);
      onRefreshData?.();
    } catch (error) {
      setGlMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to post opening balances.',
      });
    } finally {
      setGlPosting(false);
    }
  };

  const customerOpeningTotal = useMemo(
    () => customerDrafts.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
    [customerDrafts]
  );

  const handleAddCustomerOpening = () => {
    if (!pendingCustomer) {
      setCustomerMessage({ type: 'error', text: 'Select a customer before adding an opening balance.' });
      return;
    }
    if (!glBranchId || pendingCustomer.branchId !== glBranchId) {
      setCustomerMessage({
        type: 'error',
        text: 'That customer does not belong to the selected branch. Search again within this branch.',
      });
      return;
    }
    if (customerDrafts.some((row) => row.customer.customerId === pendingCustomer.customerId)) {
      setCustomerMessage({ type: 'error', text: 'That customer already has a row in this opening balance.' });
      return;
    }
    const amount = Number(pendingCustomerAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setCustomerMessage({ type: 'error', text: 'Customer opening balance must be a positive amount.' });
      return;
    }
    if (amount > 999_999_999_999.99) {
      setCustomerMessage({ type: 'error', text: 'Customer opening balance exceeds the ledger amount limit.' });
      return;
    }
    setCustomerDrafts((prev) => [
      ...prev,
      { id: `cust-opening-${pendingCustomer.customerId}-${Date.now()}`, customer: pendingCustomer, amount: String(amount) },
    ]);
    setPendingCustomer(null);
    setPendingCustomerAmount('');
    setCustomerMessage(null);
  };

  const removeCustomerOpening = (rowId: string) => {
    setCustomerDrafts((prev) => prev.filter((row) => row.id !== rowId));
    setCustomerMessage(null);
  };

  const handlePostCustomerOpenings = async () => {
    if (!canPostGl || customerPosting) return;
    if (!glBranchId || !glBranchOptions.some((branch) => branch.id === glBranchId)) {
      setCustomerMessage({ type: 'error', text: 'Select a branch within your access before posting opening balances.' });
      return;
    }
    if (!arControl) {
      setCustomerMessage({
        type: 'error',
        text: 'The chart has no active Accounts Receivable control account. Configure posting defaults first.',
      });
      return;
    }
    if (!customerOffsetAccountId || !customerOffsetAccounts.some((account) => account.id === customerOffsetAccountId)) {
      setCustomerMessage({ type: 'error', text: 'Select an equity account for the opening-balance offset.' });
      return;
    }
    if (customerDrafts.length === 0) {
      setCustomerMessage({ type: 'error', text: 'Add at least one customer opening balance before posting.' });
      return;
    }
    for (const row of customerDrafts) {
      if (row.customer.branchId !== glBranchId) {
        setCustomerMessage({
          type: 'error',
          text: `${row.customer.customerName} is outside the selected branch. Remove that row before posting.`,
        });
        return;
      }
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setCustomerMessage({ type: 'error', text: `Opening balance for ${row.customer.customerName} must be positive.` });
        return;
      }
    }
    const total = Math.round(customerOpeningTotal * 100) / 100;
    if (total <= 0) {
      setCustomerMessage({ type: 'error', text: 'Customer opening balances must total more than zero.' });
      return;
    }
    const lines: AccountingJournalLineInput[] = customerDrafts.map((row) => ({
      accountId: arControl.accountId,
      debit: Number(row.amount),
      credit: 0,
      memo: `Opening receivable — ${row.customer.customerName} (${row.customer.customerId})`,
      subledgerType: 'CUSTOMER',
      partyId: row.customer.customerId,
      partyName: row.customer.customerName,
    }));
    lines.push({
      accountId: customerOffsetAccountId,
      debit: 0,
      credit: total,
      memo: 'Opening balance equity offset',
    });

    setCustomerPosting(true);
    setCustomerMessage(null);
    try {
      const journal = await api.postOpeningBalances({ branchId: glBranchId, lines, register: 'CUSTOMER' });
      setCustomerMessage({
        type: 'success',
        text: `Customer opening balances posted as journal ${journal.journalNo} in period ${journal.periodKey}.`,
      });
      setCustomerDrafts([]);
      setPendingCustomer(null);
      setPendingCustomerAmount('');
      onRefreshData?.();
    } catch (error) {
      setCustomerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to post customer opening balances.',
      });
    } finally {
      setCustomerPosting(false);
    }
  };

  const stockFy = stockData?.fiscalYear;
  const stockPeriodLocked = Boolean(stockFy?.isClosed);
  const canEditStock = canEditRole && !stockPeriodLocked;
  const stockRows = useMemo(
    () =>
      (stockData?.rows || []).filter(
        (row) => scopedBranchIds.has(row.branchId) && row.branchId === stockBranchId
      ),
    [stockData, scopedBranchIds, stockBranchId]
  );
  const getStockDraft = (row: FiscalYearOpeningStockRow) =>
    stockDrafts[row.id] || {
      quantityOnHand: String(row.quantityOnHand),
      damagedQty: String(row.damagedQty),
      unitCost: String(row.unitCost),
    };
  const updateStockDraft = (
    row: FiscalYearOpeningStockRow,
    patch: Partial<{ quantityOnHand: string; damagedQty: string; unitCost: string }>
  ) => {
    setStockDrafts((prev) => ({
      ...prev,
      [row.id]: { ...getStockDraft(row), ...prev[row.id], ...patch },
    }));
    setStockMessage(null);
  };
  const stockChangedRows = useMemo(
    () =>
      stockRows.filter((row) => {
        const draft = getStockDraft(row);
        return (
          Number(draft.quantityOnHand) !== Number(row.quantityOnHand) ||
          Number(draft.damagedQty) !== Number(row.damagedQty) ||
          Number(draft.unitCost) !== Number(row.unitCost)
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockRows, stockDrafts]
  );
  const stockValuation = useMemo(
    () =>
      Math.round(
        stockRows.reduce((sum, row) => {
          const draft = getStockDraft(row);
          return sum + (Number(draft.quantityOnHand) || 0) * (Number(draft.unitCost) || 0);
        }, 0) * 100
      ) / 100,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockRows, stockDrafts]
  );
  const stockUnits = useMemo(
    () => stockRows.reduce((sum, row) => sum + (Number(getStockDraft(row).quantityOnHand) || 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockRows, stockDrafts]
  );
  const stockDamaged = useMemo(
    () => stockRows.reduce((sum, row) => sum + (Number(getStockDraft(row).damagedQty) || 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stockRows, stockDrafts]
  );
  const stockProductOptions = useMemo(() => {
    const existing = new Set(stockRows.map((row) => row.productId));
    return products.filter(
      (product) =>
        !existing.has(product.id) && product.status !== 'INACTIVE' && product.status !== 'DISCONTINUED'
    );
  }, [products, stockRows]);

  const validateStockRow = (
    row: FiscalYearOpeningStockRow,
    draft: { quantityOnHand: string; damagedQty: string; unitCost: string }
  ): string | null => {
    const qty = Number(draft.quantityOnHand);
    const damaged = Number(draft.damagedQty);
    const cost = Number(draft.unitCost);
    const label = `${row.productName} @ ${row.branchName}`;
    if (!Number.isInteger(qty) || qty < 0) return `Quantity must be a whole number >= 0 for ${label}.`;
    if (!Number.isInteger(damaged) || damaged < 0) return `Damaged quantity must be a whole number >= 0 for ${label}.`;
    if (damaged > qty) return `Damaged quantity cannot exceed quantity on hand for ${label}.`;
    if (!Number.isFinite(cost) || cost < 0) return `Unit cost must be a number >= 0 for ${label}.`;
    return null;
  };

  const saveStockRows = async (
    rows: Array<{
      productId: string;
      branchId: string;
      quantityOnHand: number;
      damagedQty: number;
      unitCost: number;
    }>
  ) => {
    setStockSaving(true);
    setStockMessage(null);
    try {
      const res = await api.adjustFiscalYearOpeningStock(
        selectedFyId,
        rows,
        stockOffsetAccountId || undefined
      );
      const journal = res.journals?.find((entry) => entry.branchId === stockBranchId);
      await fetchStockRegister(selectedFyId);
      // Refetch clears the stale save banner, so publish the success message
      // after it (the journal result is still this save's own response).
      setStockMessage({
        type: 'success',
        text:
          `${res.message}` +
          (journal
            ? ` Posted journal ${journal.journalNo} in ${journal.periodKey}: Dr Inventory / Cr opening equity ${formatNPR(
                journal.totalValue
              )}.`
            : ' The register has no positive valuation, so no opening journal was posted.'),
      });
      onRefreshData?.();
    } catch (error) {
      setStockMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save opening stock.',
      });
    } finally {
      setStockSaving(false);
    }
  };

  const handleSaveStock = async () => {
    if (!canEditStock || stockSaving || stockChangedRows.length === 0) return;
    for (const row of stockChangedRows) {
      const issue = validateStockRow(row, getStockDraft(row));
      if (issue) {
        setStockMessage({ type: 'error', text: issue });
        return;
      }
    }
    await saveStockRows(
      stockChangedRows.map((row) => {
        const draft = getStockDraft(row);
        return {
          productId: row.productId,
          branchId: row.branchId,
          quantityOnHand: Number(draft.quantityOnHand),
          damagedQty: Number(draft.damagedQty),
          unitCost: Number(draft.unitCost),
        };
      })
    );
  };

  const handleAddStockRow = async () => {
    if (!canEditStock || stockSaving) return;
    if (stockChangedRows.length > 0) {
      setStockMessage({ type: 'error', text: 'Save the changed rows before adding another product.' });
      return;
    }
    const product = products.find((entry) => entry.id === stockAddProductId);
    if (!product) {
      setStockMessage({ type: 'error', text: 'Select a product to add to opening stock.' });
      return;
    }
    if (!stockBranchId || !scopedBranchIds.has(stockBranchId)) {
      setStockMessage({ type: 'error', text: 'Select a branch within your access.' });
      return;
    }
    const qty = Number(stockAddQty);
    const damaged = Number(stockAddDamaged);
    const cost = Number(stockAddCost);
    if (!Number.isInteger(qty) || qty < 0) {
      setStockMessage({ type: 'error', text: 'Quantity must be a whole number >= 0.' });
      return;
    }
    if (!Number.isInteger(damaged) || damaged < 0 || damaged > qty) {
      setStockMessage({ type: 'error', text: 'Damaged quantity must be a whole number between 0 and the quantity on hand.' });
      return;
    }
    if (!Number.isFinite(cost) || cost < 0) {
      setStockMessage({ type: 'error', text: 'Unit cost must be a number >= 0.' });
      return;
    }
    await saveStockRows([
      {
        productId: product.id,
        branchId: stockBranchId,
        quantityOnHand: qty,
        damagedQty: damaged,
        unitCost: cost,
      },
    ]);
    setStockAddProductId('');
    setStockAddQty('0');
    setStockAddDamaged('0');
    setStockAddCost('0');
  };

  if (!canView) {
    return (
      <div
        className={`flex flex-col items-center justify-center h-full min-h-[420px] text-center text-slate-500 dark:text-slate-400`}
      >
        <Lock className="h-10 w-10 mb-3 opacity-60" />
        <h2 className="text-lg font-bold">Permission Denied</h2>
        <p className="text-sm mt-1 max-w-md">
          The Vendor Opening Balances register is restricted to Super Admin, Inventory Manager, and Accountant roles.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      {/* ===== Header ===== */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 shadow-sm shrink-0 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-2.5 rounded-xl shrink-0 bg-emerald-50 dark:bg-emerald-500/10`}>
            <Wallet className={`h-6 w-6 text-emerald-600 dark:text-emerald-400`} />
          </div>
          <div className="min-w-0">
            <h2 className={`text-base font-bold break-words text-slate-900 dark:text-white`}>
              Opening Balances
            </h2>
            <p className={`text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400`}>
              Bring one branch's books into the system. Vendor balances roll forward from the prior close; Customer and
              General Ledger tabs post a balanced opening journal once per branch.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FiscalYearSelect
            fiscalYears={availableFiscalYears}
            value={selectedFyId}
            onChange={(fyId) => {
              setSelectedFyId(fyId);
              onSelectFiscalYear?.(fyId);
            }}
            pageSize={3}
            showFyPrefix
            triggerClassName="px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200"
          />
          {periodLocked ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-rose-500/10 text-rose-500">
              <Lock className="h-3.5 w-3.5" /> Period Locked
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500/10 text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Period Open
            </span>
          )}
        </div>
      </div>

      {/* ===== Opening-balances tabs ===== */}
      <div
        role="tablist"
        aria-label="Opening balance registers"
        className="flex flex-wrap items-center gap-2 shrink-0"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'VENDORS'}
          onClick={() => setActiveTab('VENDORS')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors ${
            activeTab === 'VENDORS'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800'
          }`}
        >
          <Wallet className="h-3.5 w-3.5" /> Vendors
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'CUSTOMERS'}
          onClick={() => setActiveTab('CUSTOMERS')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors ${
            activeTab === 'CUSTOMERS'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800'
          }`}
        >
          <Users className="h-3.5 w-3.5" /> Customers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'STOCK'}
          onClick={() => setActiveTab('STOCK')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors ${
            activeTab === 'STOCK'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800'
          }`}
        >
          <Package className="h-3.5 w-3.5" /> Stock
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'GL'}
          onClick={() => setActiveTab('GL')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors ${
            activeTab === 'GL'
              ? 'bg-emerald-600 text-white border-emerald-600'
              : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-800'
          }`}
        >
          <BookOpen className="h-3.5 w-3.5" /> General Ledger
        </button>
      </div>

      {activeTab === 'VENDORS' && (
        <>
      {/* ===== Period-lock / access banners ===== */}
      {periodLocked ? (
        <div
          className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300`}
        >
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Period locked — fiscal year {fy?.code} is closed, so vendor opening balances are read-only. A Super Admin
            must reopen the fiscal year (Fiscal Year Closing Wizard) before adjustments are allowed again.
          </span>
        </div>
      ) : (
        !canEditRole && vendorData && vendorData.rows.length > 0 && (
          <div
            className={`flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold shrink-0 bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300`}
          >
            <Pencil className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Read-only for your role. Vendor opening-balance adjustments require Super Admin or Inventory Manager.
            </span>
          </div>
        )
      )}

      {/* ===== Vendor Opening Balances card ===== */}
      <div
        className={`rounded-xl border p-4 shadow-sm shrink-0 bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`p-2.5 rounded-xl shrink-0 bg-emerald-50 dark:bg-emerald-500/10`}>
              <Wallet className={`h-6 w-6 text-emerald-600 dark:text-emerald-400`} />
            </div>
            <div className="min-w-0">
              <h3 className={`text-base font-bold break-words text-slate-900 dark:text-white`}>
                Vendor Opening Balances (Accounts Payable)
              </h3>
              <p className={`text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400`}>
                Supplier × branch opening payables rolled forward from the Vendor Ledger close step in the
                Fiscal Year Closing Wizard. Editable while the fiscal year is open.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (changedVendorRows.length > 0 || vendorRemoved.length > 0) && (
              <button
                type="button"
                onClick={handleSaveVendorAdjustments}
                disabled={vendorSaving || !apControl || !vendorOffsetAccountId}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="h-3.5 w-3.5" /> Save & Post {changedVendorRows.length + vendorRemoved.length} Change
                {changedVendorRows.length + vendorRemoved.length > 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>

        {/* Vendor summary stats — live over drafts, additions and removals. */}
        {vendorData && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
            {[
              { label: 'Registered Rows', value: String(vendorLiveStats.totalRows), icon: Layers },
              { label: 'Manual / New Rows', value: String(vendorLiveStats.manualAdjustments), icon: Pencil },
              { label: 'Opening Payables (Cr)', value: formatNPR(vendorLiveStats.totalDebitOpening), icon: Wallet },
              { label: 'Opening Advances (Dr)', value: formatNPR(vendorLiveStats.totalCreditOpening), icon: Wallet },
            ].map((card) => (
              <div
                key={card.label}
                className={`rounded-xl border p-3 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
              >
                <div className="flex items-center gap-2">
                  <card.icon className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
                  <span className={`text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500`}>
                    {card.label}
                  </span>
                </div>
                <div className={`text-lg font-extrabold mt-1 text-slate-900 dark:text-white`}>{card.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Posting-role accounts and add-row form. */}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-800">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              AP control account (credit payables)
            </div>
            <div className="text-xs font-bold mt-1 text-slate-800 dark:text-slate-100">
              {apControl ? `${apControl.accountCode} · ${apControl.accountName}` : 'Loading AP_CONTROL posting default…'}
            </div>
            <div className="text-[10px] mt-1 text-slate-400 dark:text-slate-500">
              Resolved from the active AP_CONTROL role; each supplier line writes a SUPPLIER subledger entry.
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Opening equity offset
            </label>
            <select
              aria-label="Vendor opening offset account"
              value={vendorOffsetAccountId}
              onChange={(event) => setVendorOffsetAccountId(event.target.value)}
              disabled={!canEdit || vendorSaving || glAccountsLoading}
              className="w-full px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
            >
              {customerOffsetAccounts.length === 0 && <option value="">No equity account</option>}
              {customerOffsetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {postingDefaultsError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{postingDefaultsError}</span>
          </div>
        )}

        <div className="mt-3 grid gap-2 rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-800 lg:grid-cols-[minmax(220px,2fr)_minmax(170px,1fr)_minmax(120px,1fr)_auto]">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Supplier
            </label>
            <select
              aria-label="Vendor opening supplier"
              value={vendorAddSupplierId}
              onChange={(event) => setVendorAddSupplierId(event.target.value)}
              disabled={!canEdit || vendorSaving}
              className="w-full h-9 px-3 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
            >
              <option value="">{suppliers.length ? 'Select supplier' : 'No suppliers available'}</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.supplierCode ? `${supplier.supplierCode} · ` : ''}{supplier.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Branch
            </label>
            <select
              aria-label="Vendor opening add branch"
              value={vendorAddBranchId}
              onChange={(event) => setVendorAddBranchId(event.target.value)}
              disabled={!canEdit || vendorSaving}
              className="w-full h-9 px-3 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
            >
              {glBranchOptions.length === 0 && <option value="">No branch in scope</option>}
              {glBranchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Opening balance (NPR)
            </label>
            <input
              aria-label="Vendor opening new amount"
              type="number"
              step="0.01"
              value={vendorAddAmount}
              onChange={(event) => setVendorAddAmount(event.target.value)}
              disabled={!canEdit || vendorSaving}
              className="w-full h-9 px-3 rounded-lg border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={handleAddVendorRow}
              disabled={!canEdit || vendorSaving || !vendorAddSupplierId || !vendorAddAmount}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> Add supplier
            </button>
          </div>
        </div>
        {vendorRemoved.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-semibold bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300">
            <span>{vendorRemoved.length} row(s) will be removed when you save.</span>
            <button
              type="button"
              onClick={() => setVendorRemoved([])}
              className="font-bold underline underline-offset-2"
            >
              Undo removals
            </button>
          </div>
        )}

        {/* Vendor filters & actions — shared FilterCard for register consistency. */}
        <div className="mt-3">
          <FilterCard
            searchPlaceholder="Search supplier…"
            searchValue={vendorSearch}
            onSearchApply={setVendorSearch}
            onSearchDraftChange={(draft) => { searchDraftRef.current = draft; }}
            hasActiveFilters={
              Boolean(vendorSearch) || vendorBranchFilter !== 'ALL' || vendorNonZeroOnly || vendorChangedOnly
            }
            onClearAll={() => {
              setVendorSearch('');
              setVendorBranchFilter('ALL');
              setVendorNonZeroOnly(false);
              setVendorChangedOnly(false);
            }}
            filterChildren={
              <>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">Branch</label>
                  <select
                    value={vendorBranchFilter}
                    onChange={(e) => setVendorBranchFilter(e.target.value)}
                    className="h-8 px-3 rounded-xl border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    <option value="ALL">All Branches</option>
                    {scopedBranches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <label className="flex h-8 items-center gap-1.5 px-2 text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={vendorNonZeroOnly} onChange={(e) => setVendorNonZeroOnly(e.target.checked)} className="rounded" />
                  Non-zero only
                </label>
                <label className="flex h-8 items-center gap-1.5 px-2 text-xs font-semibold cursor-pointer text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={vendorChangedOnly} onChange={(e) => setVendorChangedOnly(e.target.checked)} className="rounded" />
                  Changed only
                </label>
              </>
            }
            rightChildren={
              <>
                <button
                  type="button"
                  onClick={handleExportVendor}
                  disabled={vendorLoading || filteredVendorRows.length === 0}
                  className="inline-flex h-8 items-center gap-1.5 px-3 rounded-lg border text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" /> Export CSV
                </button>
                {canEditRole && (
                  <button
                    type="button"
                    onClick={handleGenerateVendorOpenings}
                    disabled={vendorGenerating}
                    className="inline-flex h-8 items-center gap-1.5 px-3 rounded-lg border text-xs font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${vendorGenerating ? 'animate-spin' : ''}`} />
                    {vendorGenerating ? 'Rolling Forward…' : 'Roll Forward from Previous Close'}
                  </button>
                )}
              </>
            }
          />
        </div>

        {/* Vendor save / generate feedback */}
        {(vendorSaveMessage || vendorGenMessage) && (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold mt-3 ${
              vendorSaveMessage?.type === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/30 dark:text-emerald-300'
            }`}
          >
            {vendorSaveMessage?.type === 'error' ? (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <span>{vendorSaveMessage ? vendorSaveMessage.text : vendorGenMessage}</span>
          </div>
        )}

        {/* Vendor register table / empty state */}
        <div
          className={`mt-3 min-h-0 flex flex-col rounded-xl border overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          {vendorLoading ? (
            <div className={`flex items-center justify-center text-sm font-semibold text-slate-500 dark:text-slate-400 py-10`}>
              Loading vendor opening balances…
            </div>
          ) : vendorLoadError ? (
            <div className={`flex flex-col items-center justify-center text-center p-8 gap-2 text-slate-500 dark:text-slate-400`}>
              <AlertTriangle className="h-8 w-8 text-rose-500" />
              <p className="text-sm font-semibold max-w-lg">{vendorLoadError}</p>
              <button
                type="button"
                onClick={() => fetchVendorRegister(selectedFyId)}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          ) : !vendorData || vendorRows.length === 0 ? (
            <div className={`flex flex-col items-center justify-center text-center p-8 gap-3 text-slate-500 dark:text-slate-400`}>
              <Wallet className="h-10 w-10 opacity-50" />
              <div>
                <p className="text-sm font-bold">No vendor opening balances posted for FY {fy?.code || '—'} yet.</p>
                <p className="text-xs mt-1 max-w-lg">
                  Roll the balances forward from the previous fiscal year's Vendor Ledger close, or add a supplier
                  opening manually while the fiscal year is open.
                </p>
              </div>
              {canEditRole && (
                <button
                  type="button"
                  onClick={handleGenerateVendorOpenings}
                  disabled={vendorGenerating}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${vendorGenerating ? 'animate-spin' : ''}`} />
                  {vendorGenerating ? 'Rolling Forward…' : 'Roll Forward from Previous Close'}
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    {['Supplier', 'Branch', 'Opening Balance (NPR)', 'Operational AP (Cr)', 'Source', 'Posted', ''].map((h) => (
                      <th
                        key={h}
                        className={`px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b border-slate-200 dark:border-slate-800`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredVendorRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className={`px-3 py-8 text-center text-xs font-semibold text-slate-400 dark:text-slate-500`}>
                        No rows match the current filters.
                      </td>
                    </tr>
                  )}
                  {filteredVendorRows.map((row) => {
                    const changed = isVendorRowChanged(row);
                    const draft = getVendorDraft(row);
                    const effBalance = changed ? Number(draft.openingBalance) || 0 : row.openingBalance;
                    const inputBase = `px-2 py-1 rounded-md border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 ${changed ? 'border-amber-400' : ''}`;
                    return (
                      <tr
                        key={row.id}
                        className={`border-b transition-colors border-slate-100 dark:border-slate-800/70 ${changed ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                      >
                        <td className="px-3 py-2">
                          <div className={`text-xs font-bold text-slate-800 dark:text-slate-200`}>
                            {row.supplierName}
                          </div>
                          <div className={`text-[10px] text-slate-400 dark:text-slate-500`}>
                            {row.supplierCode}
                          </div>
                        </td>
                        <td className={`px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 dark:text-slate-300`}>
                          {row.branchName}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              step={0.01}
                              disabled={!canEdit}
                              value={changed ? draft.openingBalance : String(row.openingBalance)}
                              onChange={(e) => updateVendorDraft(row.id, e.target.value)}
                              className={`${inputBase} w-32 font-bold text-right`}
                            />
                            {changed && (
                              <span className="text-[10px] font-bold text-amber-500 whitespace-nowrap">
                                {row.openingBalance} → {effBalance}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs font-semibold text-right whitespace-nowrap text-slate-600 dark:text-slate-300">
                          {formatNPR(Number(row.ledgerBalance) || 0)}
                        </td>
                        <td className="px-3 py-2">
                          {isVendorNewRow(row) ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 whitespace-nowrap">
                              <Plus className="h-3 w-3" /> New
                            </span>
                          ) : row.sourceType === 'MANUAL_ADJUSTMENT' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 whitespace-nowrap">
                              <Pencil className="h-3 w-3" /> Manual
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-500 whitespace-nowrap">
                              <CheckCircle2 className="h-3 w-3" /> Fiscal Close
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className={`text-[10px] leading-tight text-slate-400 dark:text-slate-500`}>
                            <div className="font-semibold truncate max-w-[130px]">{row.postedBy || '—'}</div>
                            <div>{row.postedAt ? row.postedAt.replace('T', ' ').slice(0, 16) : '—'}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            aria-label={`Remove vendor opening ${row.supplierName}`}
                            onClick={() => removeVendorRow(row)}
                            disabled={!canEdit || vendorSaving}
                            className="p-1.5 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-30"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
        </>
      )}

      {activeTab === 'CUSTOMERS' && (
        <div
          className={`rounded-xl border p-4 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 rounded-xl shrink-0 bg-sky-50 dark:bg-sky-500/10">
                <Users className="h-6 w-6 text-sky-600 dark:text-sky-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold break-words text-slate-900 dark:text-white">
                  Customer Opening Balances
                </h3>
                <p className="text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400">
                  Post each customer's opening receivable through the Accounts Receivable control account, with an
                  opening-equity offset. The journal lands in the earliest open period and locks the branch against a
                  second opening posting.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Branch
              </label>
              <select
                aria-label="Customer opening branch"
                value={glBranchId}
                onChange={(event) => {
                  setGlBranchId(event.target.value);
                  setCustomerMessage(null);
                }}
                disabled={!canPostGl || customerPosting}
                className="px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                {glBranchOptions.length === 0 && <option value="">No branch in scope</option>}
                {glBranchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!canPostGl && (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300">
              <Lock className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Read-only for your role. Posting opening balances requires the Post Opening Balances permission.
              </span>
            </div>
          )}

          {postingDefaultsError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{postingDefaultsError}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-800">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Control account
            </span>
            <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
              {arControl ? `${arControl.accountCode} · ${arControl.accountName}` : 'Loading Accounts Receivable…'}
            </span>
            {arControl && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <CheckCircle2 className="h-3 w-3" /> Party-backed customer control
              </span>
            )}
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(260px,2fr)_minmax(140px,1fr)_auto]">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Customer
              </label>
              <CustomerPicker
                value={
                  pendingCustomer
                    ? {
                        id: pendingCustomer.id,
                        label: `${pendingCustomer.customerName} (${pendingCustomer.customerId})`,
                      }
                    : null
                }
                onSelect={(customer) => {
                  setPendingCustomer(customer);
                  setCustomerMessage(null);
                }}
                search={searchOpeningCustomers}
                disabled={!canPostGl || customerPosting || !glBranchId}
                placeholder="Search this branch's customers…"
                inputClassName="h-9 text-xs font-semibold"
                ariaLabel="Customer opening customer"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Opening balance (NPR)
              </label>
              <input
                aria-label="Customer opening amount"
                type="number"
                min="0"
                step="0.01"
                value={pendingCustomerAmount}
                disabled={!canPostGl || customerPosting}
                onChange={(event) => {
                  setPendingCustomerAmount(event.target.value);
                  setCustomerMessage(null);
                }}
                className="w-full h-9 px-3 rounded-lg border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleAddCustomerOpening}
                disabled={!canPostGl || customerPosting || !pendingCustomer || !pendingCustomerAmount}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add customer
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-xl border overflow-hidden border-slate-200 dark:border-slate-800">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  {['Customer', 'Code', 'Opening balance (NPR)', ''].map((heading) => (
                    <th
                      key={heading || 'actions'}
                      className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b border-slate-200 dark:border-slate-800"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customerDrafts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-xs font-semibold text-slate-400 dark:text-slate-500">
                      No customer opening balances added yet.
                    </td>
                  </tr>
                ) : (
                  customerDrafts.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/70">
                      <td className="px-3 py-2 text-xs font-bold text-slate-800 dark:text-slate-200">
                        {row.customer.customerName}
                      </td>
                      <td className="px-3 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                        {row.customer.customerId}
                      </td>
                      <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">
                        {formatNPR(Number(row.amount))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          aria-label={`Remove ${row.customer.customerName}`}
                          onClick={() => removeCustomerOpening(row.id)}
                          disabled={!canPostGl || customerPosting}
                          className="p-1.5 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 dark:bg-slate-900/70">
                  <td className="px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300" colSpan={2}>
                    Total opening receivables
                  </td>
                  <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">
                    {formatNPR(customerOpeningTotal)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {customerMessage && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold ${
                customerMessage.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/30 dark:text-emerald-300'
              }`}
            >
              {customerMessage.type === 'error' ? (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <span>{customerMessage.text}</span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[240px]">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Opening equity offset
              </label>
              <select
                aria-label="Customer opening offset account"
                value={customerOffsetAccountId}
                onChange={(event) => setCustomerOffsetAccountId(event.target.value)}
                disabled={!canPostGl || customerPosting || glAccountsLoading}
                className="w-full px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                {customerOffsetAccounts.length === 0 && <option value="">No equity account</option>}
                {customerOffsetAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handlePostCustomerOpenings}
              disabled={
                !canPostGl ||
                customerPosting ||
                customerDrafts.length === 0 ||
                !arControl ||
                !customerOffsetAccountId ||
                customerOpeningTotal <= 0
              }
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" /> {customerPosting ? 'Posting…' : 'Post Customer Openings'}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'STOCK' && (
        <div
          className={`rounded-xl border p-4 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 rounded-xl shrink-0 bg-amber-50 dark:bg-amber-500/10">
                <Package className="h-6 w-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold break-words text-slate-900 dark:text-white">
                  Stock Opening Balances
                </h3>
                <p className="text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400">
                  Save the branch's product × quantity × unit-cost register and post the balanced opening journal in
                  one transaction: Dr Inventory, Cr the same opening-equity offset used by Customer openings.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Branch
              </label>
              <select
                aria-label="Stock opening branch"
                value={stockBranchId}
                onChange={(event) => setStockBranchId(event.target.value)}
                disabled={stockSaving}
                className="px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                {glBranchOptions.length === 0 && <option value="">No branch in scope</option>}
                {glBranchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
              {stockPeriodLocked ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-rose-500/10 text-rose-500">
                  <Lock className="h-3.5 w-3.5" /> Period Locked
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500/10 text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Period Open
                </span>
              )}
            </div>
          </div>

          {(!canEditRole || stockPeriodLocked) && (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300">
              <Lock className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                {stockPeriodLocked
                  ? `Fiscal year ${stockFy?.code || fy?.code || ''} is closed, so stock opening balances are read-only.`
                  : 'Read-only for your role. Saving opening stock requires the opening-stock edit permission.'}
              </span>
            </div>
          )}

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-800">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Inventory debit account
              </div>
              <div className="text-xs font-bold mt-1 text-slate-800 dark:text-slate-100">
                {inventoryControl
                  ? `${inventoryControl.accountCode} · ${inventoryControl.accountName}`
                  : 'Loading INVENTORY posting default…'}
              </div>
              <div className="text-[10px] mt-1 text-slate-400 dark:text-slate-500">
                Resolved from the active chart role INVENTORY; the server refuses a missing or control account.
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Opening equity offset (credit)
              </label>
              <select
                aria-label="Stock opening offset account"
                value={stockOffsetAccountId}
                onChange={(event) => setStockOffsetAccountId(event.target.value)}
                disabled={!canEditStock || stockSaving || glAccountsLoading}
                className="w-full px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                {customerOffsetAccounts.length === 0 && <option value="">No equity account</option>}
                {customerOffsetAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {postingDefaultsError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{postingDefaultsError}</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-3 mt-3">
            {[
              { label: 'Opening units', value: String(stockUnits) },
              { label: 'Damaged units', value: String(stockDamaged) },
              { label: 'Stock valuation', value: formatNPR(stockValuation) },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-xl border p-3 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {card.label}
                </div>
                <div className="text-base font-extrabold mt-1 text-slate-900 dark:text-white">{card.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 rounded-xl border p-3 bg-slate-50 border-slate-200 dark:bg-slate-900/40 dark:border-slate-800 lg:grid-cols-[minmax(220px,2fr)_repeat(3,minmax(90px,1fr))_auto]">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Product
              </label>
              <select
                aria-label="Stock opening product"
                value={stockAddProductId}
                onChange={(event) => {
                  const productId = event.target.value;
                  setStockAddProductId(productId);
                  const product = products.find((entry) => entry.id === productId);
                  if (product) setStockAddCost(String(product.costPrice ?? 0));
                }}
                disabled={!canEditStock || stockSaving || stockChangedRows.length > 0}
                className="w-full h-9 px-3 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                <option value="">{stockProductOptions.length ? 'Select product' : 'No products available'}</option>
                {stockProductOptions.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} · {product.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Qty
              </label>
              <input
                aria-label="Stock opening quantity"
                type="number"
                min="0"
                step="1"
                value={stockAddQty}
                onChange={(event) => setStockAddQty(event.target.value)}
                disabled={!canEditStock || stockSaving || stockChangedRows.length > 0}
                className="w-full h-9 px-3 rounded-lg border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Damaged
              </label>
              <input
                aria-label="Stock opening damaged quantity"
                type="number"
                min="0"
                step="1"
                value={stockAddDamaged}
                onChange={(event) => setStockAddDamaged(event.target.value)}
                disabled={!canEditStock || stockSaving || stockChangedRows.length > 0}
                className="w-full h-9 px-3 rounded-lg border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Unit cost (NPR)
              </label>
              <input
                aria-label="Stock opening unit cost"
                type="number"
                min="0"
                step="0.01"
                value={stockAddCost}
                onChange={(event) => setStockAddCost(event.target.value)}
                disabled={!canEditStock || stockSaving || stockChangedRows.length > 0}
                className="w-full h-9 px-3 rounded-lg border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleAddStockRow}
                disabled={
                  !canEditStock ||
                  stockSaving ||
                  !stockAddProductId ||
                  stockChangedRows.length > 0
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add product
              </button>
            </div>
          </div>

          <div className="mt-3 rounded-xl border overflow-hidden border-slate-200 dark:border-slate-800">
            {stockLoading ? (
              <div className="py-10 text-center text-sm font-semibold text-slate-500 dark:text-slate-400">
                Loading opening stock…
              </div>
            ) : stockLoadError ? (
              <div className="flex flex-col items-center justify-center text-center p-8 gap-2 text-slate-500 dark:text-slate-400">
                <AlertTriangle className="h-8 w-8 text-rose-500" />
                <p className="text-sm font-semibold max-w-lg">{stockLoadError}</p>
                <button
                  type="button"
                  onClick={() => fetchStockRegister(selectedFyId)}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </button>
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                      {['Product', 'Branch', 'Live qty (damaged)', 'Quantity', 'Damaged', 'Unit cost (NPR)', 'Valuation (NPR)', 'Source'].map(
                        (heading) => (
                          <th
                            key={heading}
                            className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b border-slate-200 dark:border-slate-800"
                          >
                            {heading}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {stockRows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-xs font-semibold text-slate-400 dark:text-slate-500">
                          No opening-stock rows for this branch yet. Add a product above, or roll the register forward
                          from the previous close.
                        </td>
                      </tr>
                    )}
                    {stockRows.map((row) => {
                      const draft = getStockDraft(row);
                      const changed = stockChangedRows.some((entry) => entry.id === row.id);
                      const valuation =
                        (Number(draft.quantityOnHand) || 0) * (Number(draft.unitCost) || 0);
                      const inputBase = `px-2 py-1 rounded-md border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:cursor-not-allowed bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 ${changed ? 'border-amber-400' : ''}`;
                      return (
                        <tr
                          key={row.id}
                          className={`border-b transition-colors border-slate-100 dark:border-slate-800/70 ${changed ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                        >
                          <td className="px-3 py-2 min-w-[180px]">
                            <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                              {row.productName}
                            </div>
                            <div className="text-[10px] text-slate-400 dark:text-slate-500">{row.productSku}</div>
                          </td>
                          <td className="px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-600 dark:text-slate-300">
                            {row.branchName}
                          </td>
                          <td className="px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-500 dark:text-slate-400">
                            {row.liveQty} ({row.liveDamagedQty})
                          </td>
                          <td className="px-3 py-2">
                            <input
                              aria-label={`Stock opening quantity for ${row.productName}`}
                              type="number"
                              min="0"
                              step="1"
                              disabled={!canEditStock || stockSaving}
                              value={draft.quantityOnHand}
                              onChange={(event) => updateStockDraft(row, { quantityOnHand: event.target.value })}
                              className={`${inputBase} w-20 text-right`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              aria-label={`Stock opening damaged quantity for ${row.productName}`}
                              type="number"
                              min="0"
                              step="1"
                              disabled={!canEditStock || stockSaving}
                              value={draft.damagedQty}
                              onChange={(event) => updateStockDraft(row, { damagedQty: event.target.value })}
                              className={`${inputBase} w-20 text-right`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              aria-label={`Stock opening unit cost for ${row.productName}`}
                              type="number"
                              min="0"
                              step="0.01"
                              disabled={!canEditStock || stockSaving}
                              value={draft.unitCost}
                              onChange={(event) => updateStockDraft(row, { unitCost: event.target.value })}
                              className={`${inputBase} w-24 text-right`}
                            />
                          </td>
                          <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100 whitespace-nowrap">
                            {formatNPR(valuation)}
                          </td>
                          <td className="px-3 py-2">
                            {row.sourceType === 'MANUAL_ADJUSTMENT' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-500 whitespace-nowrap">
                                <Pencil className="h-3 w-3" /> Manual
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-500 whitespace-nowrap">
                                <CheckCircle2 className="h-3 w-3" /> Fiscal Close
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 dark:bg-slate-900/70">
                      <td className="px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300" colSpan={3}>
                        Total for {glBranchOptions.find((b) => b.id === stockBranchId)?.name || 'this branch'}
                      </td>
                      <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">
                        {stockUnits}
                      </td>
                      <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">
                        {stockDamaged}
                      </td>
                      <td />
                      <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">
                        {formatNPR(stockValuation)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <p className="mt-2 text-[10px] leading-snug text-slate-400 dark:text-slate-500">
            Damaged units stay inside quantity on hand and are valued on the same line (they are informational, not a
            second deduction). The journal debit and credit both equal the register valuation above. Re-saving posts a
            linked reversal of the prior stock opening before the new journal, so no amount is counted twice.
          </p>

          {stockMessage && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold ${
                stockMessage.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/30 dark:text-emerald-300'
              }`}
            >
              {stockMessage.type === 'error' ? (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <span>{stockMessage.text}</span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              {stockChangedRows.length > 0
                ? `${stockChangedRows.length} row${stockChangedRows.length > 1 ? 's' : ''} changed.`
                : 'Edit a row, or add a product, then save to post the journal.'}
            </div>
            <button
              type="button"
              onClick={handleSaveStock}
              disabled={
                !canEditStock ||
                stockSaving ||
                stockChangedRows.length === 0 ||
                !stockOffsetAccountId ||
                stockValuation <= 0
              }
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" />{' '}
              {stockSaving ? 'Saving & posting…' : `Save & Post ${stockChangedRows.length || ''}`.trim()}
            </button>
          </div>
        </div>
      )}

      {activeTab === 'GL' && (
        <div
          className={`rounded-xl border p-4 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2.5 rounded-xl shrink-0 bg-indigo-50 dark:bg-indigo-500/10">
                <BookOpen className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold break-words text-slate-900 dark:text-white">
                  General Ledger Opening Trial Balance
                </h3>
                <p className="text-xs mt-0.5 leading-snug break-words text-slate-500 dark:text-slate-400">
                  Posts balanced opening lines through the ledger into the earliest open accounting period. A branch can
                  take one opening posting; the server refuses a second one and checks permission and branch scope.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Branch
              </label>
              <select
                aria-label="Opening balance branch"
                value={glBranchId}
                onChange={(event) => {
                  setGlBranchId(event.target.value);
                  setGlMessage(null);
                }}
                disabled={!canPostGl || glPosting}
                className="px-3 py-2 rounded-lg border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200 disabled:opacity-50"
              >
                {glBranchOptions.length === 0 && <option value="">No branch in scope</option>}
                {glBranchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!canPostGl && (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border p-3 text-xs font-semibold bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-500/5 dark:border-amber-500/30 dark:text-amber-300">
              <Lock className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Read-only for your role. Posting opening balances requires the Post Opening Balances permission.
              </span>
            </div>
          )}

          <div className="mt-4 rounded-xl border overflow-hidden border-slate-200 dark:border-slate-800">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  {['Account', 'Debit (NPR)', 'Credit (NPR)', ''].map((heading) => (
                    <th
                      key={heading || 'actions'}
                      className="px-3 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap border-b border-slate-200 dark:border-slate-800"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {glLines.map((line) => (
                  <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/70">
                    <td className="px-3 py-2 min-w-[240px]">
                      <select
                        aria-label="Opening balance account"
                        value={line.accountId}
                        disabled={!canPostGl || glPosting || glAccountsLoading}
                        onChange={(event) => updateGlLine(line.id, { accountId: event.target.value })}
                        className="w-full px-2 py-1.5 rounded-md border text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
                      >
                        <option value="">{glAccountsLoading ? 'Loading accounts…' : 'Select account'}</option>
                        {glAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} · {account.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label="Opening balance debit"
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.debit}
                        disabled={!canPostGl || glPosting}
                        onChange={(event) => updateGlLine(line.id, { debit: event.target.value, credit: event.target.value === '' ? line.credit : '' })}
                        className="w-28 px-2 py-1 rounded-md border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        aria-label="Opening balance credit"
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.credit}
                        disabled={!canPostGl || glPosting}
                        onChange={(event) => updateGlLine(line.id, { credit: event.target.value, debit: event.target.value === '' ? line.debit : '' })}
                        className="w-28 px-2 py-1 rounded-md border text-xs font-bold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white border-slate-300 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-300 disabled:opacity-50"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        aria-label="Remove opening balance line"
                        onClick={() => removeGlLine(line.id)}
                        disabled={!canPostGl || glPosting || glLines.length <= 2}
                        className="p-1.5 rounded-md text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 dark:bg-slate-900/70">
                  <td className="px-3 py-2 text-xs font-bold text-slate-600 dark:text-slate-300">Totals</td>
                  <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">{formatNPR(glTotalDebit)}</td>
                  <td className="px-3 py-2 text-xs font-extrabold text-right text-slate-800 dark:text-slate-100">{formatNPR(glTotalCredit)}</td>
                  <td className="px-3 py-2 text-right">
                    <span className={`text-[10px] font-bold ${glBalanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                      {glBalanced ? 'Balanced' : `Out by ${formatNPR(Math.abs(glDifference))}`}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {glAccountsError && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{glAccountsError}</span>
            </div>
          )}

          {glMessage && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold ${
                glMessage.type === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-500/5 dark:border-rose-500/30 dark:text-rose-300'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-500/5 dark:border-emerald-500/30 dark:text-emerald-300'
              }`}
            >
              {glMessage.type === 'error' ? (
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              )}
              <span>{glMessage.text}</span>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={addGlLine}
              disabled={!canPostGl || glPosting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> Add line
            </button>
            <button
              type="button"
              onClick={handlePostGlOpening}
              disabled={!canPostGl || glPosting || !glBalanced || glDraftLines.length < 2}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save className="h-3.5 w-3.5" /> {glPosting ? 'Posting…' : 'Post Opening Balances'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorOpeningBalances;