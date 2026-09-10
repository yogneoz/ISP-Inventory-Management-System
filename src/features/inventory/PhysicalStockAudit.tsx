import React, { useState, useMemo, useEffect } from 'react';
import {
  User,
  Product,
  Branch,
  InventoryStock,
  ApprovalRequest,
} from '../../types';
import {
  ClipboardCheck,
  Search,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Minus,
  Download,
  Package,
  Layers,
  ArrowRight,
  ShieldAlert,
  Building,
  Save,
  Check,
  X,
  FileSpreadsheet,
  Send,
  Clock,
  Lock,
  RefreshCw,
  TableProperties,
  ShieldCheck,
  XCircle,
  HelpCircle,
  TrendingDown,
  TrendingUp,
  Sliders,
  Edit3,
} from 'lucide-react';
import { convertADToBS, formatDualDate, formatBSDate } from '../../utils/nepaliCalendar';
import { getAllowedBranches, canUserSeeAllBranches, isOperationAllowed } from '../../utils/permissions';
import { exportToCSV } from '../../utils/exportUtils';
import { useDarkMode } from '../../contexts/DarkModeContext';

interface PhysicalStockAuditProps {
  currentUser: User | null;
  products: Product[];
  branches: Branch[];
  stock: InventoryStock[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  approvalRequests?: ApprovalRequest[];
  onUpdateStockLevel?: (
    stockId: string,
    newQty: number,
    reason: string,
    damagedQty?: number,
    changeType?: string
  ) => Promise<void>;
  onReconcileStockAudit?: (payload: {
    branchId: string;
    auditRefNumber: string;
    varianceItems: any[];
    auditorName?: string;
    userEmail?: string;
    notes?: string;
  }) => Promise<any>;
  onRequestApproval?: (
    request: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'>
  ) => Promise<any>;
  onCancelApproval?: (id: string, reason?: string) => Promise<any>;
  onProcessApproval?: (id: string, status: 'APPROVED' | 'REJECTED', reason?: string) => Promise<any>;
  onNavigateTab?: (tab: any) => void;
}

export interface AuditRow {
  productId: string;
  sku: string;
  barcode: string;
  productName: string;
  category: string;
  unit: string;
  unitCost: number;
  bookQty: number;
  countedQty: number | '';
  isCounted: boolean;
  varianceReason: string;
  customReason?: string;
  requiresSerialTracking?: boolean;
}

export const PhysicalStockAudit: React.FC<PhysicalStockAuditProps> = ({
  currentUser,
  products = [],
  branches = [],
  stock = [],
  selectedBranchId,
  dateMode,
  approvalRequests = [],
  onUpdateStockLevel,
  onReconcileStockAudit,
  onRequestApproval,
  onCancelApproval,
  onProcessApproval,
  onNavigateTab,
}) => {
  const { isDarkMode } = useDarkMode();
  // 1. Branch Permission & Access Verification
  const canSeeAll = canUserSeeAllBranches(currentUser);
  const allowedBranches = useMemo(() => getAllowedBranches(currentUser, branches), [currentUser, branches]);

  const isManagerOrAdmin = useMemo(() => {
    return (
      currentUser?.role === 'SUPER_ADMIN' ||
      currentUser?.role === 'INVENTORY_MANAGER' ||
      isOperationAllowed('workflow-approval', currentUser?.role)
    );
  }, [currentUser]);

  // Determine initial branch strictly based on user login context
  const getInitialBranchId = (): string => {
    if (!canSeeAll && currentUser?.branchId && currentUser.branchId !== 'ALL') {
      return currentUser.branchId;
    }
    if (selectedBranchId && selectedBranchId !== 'ALL' && allowedBranches.some((b) => b.id === selectedBranchId)) {
      return selectedBranchId;
    }
    return allowedBranches[0]?.id || branches[0]?.id || 'WH001';
  };

  const [activeBranchId, setActiveBranchId] = useState<string>(getInitialBranchId);

  // Sync if currentUser or selectedBranchId changes
  useEffect(() => {
    if (!canSeeAll && currentUser?.branchId && currentUser.branchId !== 'ALL') {
      setActiveBranchId(currentUser.branchId);
    } else if (selectedBranchId && selectedBranchId !== 'ALL' && allowedBranches.some((b) => b.id === selectedBranchId)) {
      setActiveBranchId(selectedBranchId);
    }
  }, [currentUser, selectedBranchId, canSeeAll, allowedBranches]);

  const isBranchLockedForUser = !canSeeAll && Boolean(currentUser?.branchId && currentUser.branchId !== 'ALL');

  const [auditorName, setAuditorName] = useState<string>(
    currentUser?.name || 'Authorized Auditor'
  );

  const [auditRefNumber, setAuditRefNumber] = useState<string>(
    () => `AUD-2083-${Math.floor(100 + Math.random() * 900)}`
  );

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [filterVariance, setFilterVariance] = useState<
    'ALL' | 'DISCREPANCY' | 'MATCHED' | 'SHORTAGE' | 'EXCESS' | 'UNCOUNTED'
  >('ALL');

  // View Tab: 'SINGLE_BRANCH' (Floor Count Session) | 'CONSOLIDATED_MATRIX' (Multi-Branch Approver View)
  const [activeAuditTab, setActiveAuditTab] = useState<'SINGLE_BRANCH' | 'CONSOLIDATED_MATRIX'>('SINGLE_BRANCH');

  // Blind Stock Audit Mode States
  const [isBlindAuditMode, setIsBlindAuditMode] = useState<boolean>(false);
  const [isBlindRevealed, setIsBlindRevealed] = useState<boolean>(false);

  // Permission Checks: Only SUPER_ADMIN and INVENTORY_MANAGER (Stock Manager) can toggle Blind Count or see all company branches
  const isExecutiveUser = useMemo(() => {
    return (
      currentUser?.role === 'SUPER_ADMIN' ||
      currentUser?.role === 'INVENTORY_MANAGER'
    );
  }, [currentUser]);

  const canToggleBlindCount = isExecutiveUser;

  // Company-Wide Blind Stock Audit Mode (Persisted in localStorage)
  const [isCompanyWideBlindCount, setIsCompanyWideBlindCount] = useState<boolean>(() => {
    try {
      return localStorage.getItem('izone_company_wide_blind_count') === 'true';
    } catch (_e) {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('izone_company_wide_blind_count', String(isCompanyWideBlindCount));
    } catch (_e) {
      // ignore
    }
  }, [isCompanyWideBlindCount]);

  // Effective Blind Audit Mode for active counting session
  const isEffectiveBlindAudit = isCompanyWideBlindCount || isBlindAuditMode;

  // Modals & Submission States
  const [showApprovalModal, setShowApprovalModal] = useState<boolean>(false);
  const [showApproveReconcileModal, setShowApproveReconcileModal] = useState<boolean>(false);
  const [showRejectModal, setShowRejectModal] = useState<boolean>(false);
  const [showDirectReconcileModal, setShowDirectReconcileModal] = useState<boolean>(false);
  const [showConsolidatedModal, setShowConsolidatedModal] = useState<boolean>(false);
  const [approvalNotes, setApprovalNotes] = useState<string>('');
  const [rejectReason, setRejectReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isLocallySubmitted, setIsLocallySubmitted] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // All pending stock audit approval requests across all 19 branches
  const allPendingAuditRequests = useMemo(() => {
    return approvalRequests.filter(
      (r) => r.type === 'STOCK_AUDIT_RECONCILIATION' && r.status === 'PENDING'
    );
  }, [approvalRequests]);

  // Branch visibility in Consolidated Matrix & Approver View: Branch user type specific
  const visibleBranches = useMemo(() => {
    if (!isExecutiveUser && currentUser?.branchId && currentUser.branchId !== 'ALL') {
      return branches.filter((b) => b.id === currentUser.branchId);
    }
    return branches;
  }, [branches, currentUser, isExecutiveUser]);

  // Pending audit requests filtered by branch for branch staff users
  const visiblePendingAuditRequests = useMemo(() => {
    if (!isExecutiveUser && currentUser?.branchId && currentUser.branchId !== 'ALL') {
      return allPendingAuditRequests.filter((r) => r.branchId === currentUser.branchId);
    }
    return allPendingAuditRequests;
  }, [allPendingAuditRequests, currentUser, isExecutiveUser]);

  // Reset local submission state when branch changes
  useEffect(() => {
    setIsLocallySubmitted(false);
  }, [activeBranchId]);

  // Check if there is an existing pending approval request for this branch
  const pendingAuditRequest = useMemo(() => {
    return approvalRequests.find(
      (r) =>
        r.type === 'STOCK_AUDIT_RECONCILIATION' &&
        r.branchId === activeBranchId &&
        r.status === 'PENDING'
    );
  }, [approvalRequests, activeBranchId]);

  const recentApprovedAuditRequest = useMemo(() => {
    return approvalRequests.find(
      (r) =>
        r.type === 'STOCK_AUDIT_RECONCILIATION' &&
        r.branchId === activeBranchId &&
        r.status === 'APPROVED'
    );
  }, [approvalRequests, activeBranchId]);

  // Is Table Locked for general editing?
  // When an audit is PENDING approval or submitted:
  // - Table is strictly blocked/locked from editing for all users until processed.
  // - Super Admin / Stock Manager in Review Mode can inspect before clicking "Approve & Reconcile".
  const isTableLocked = isLocallySubmitted || Boolean(pendingAuditRequest);
  const isReviewMode = Boolean(pendingAuditRequest) && isManagerOrAdmin;

  // Initialize count state per branch
  const initialAuditRows = useMemo(() => {
    return products.map((prod) => {
      const stockItem = stock.find(
        (s) => s.productId === prod.id && s.branchId === activeBranchId
      );
      const bookQty = stockItem ? stockItem.quantityOnHand : 0;

      // If pending audit exists and has variance data for this product, prefill the submitted counted qty
      let countedQty: number | '' = bookQty;
      let varianceReason = 'Verified Matched';
      let customReason = '';

      if (pendingAuditRequest?.auditData?.varianceItems) {
        const submittedItem = pendingAuditRequest.auditData.varianceItems.find(
          (v) => v.productId === prod.id
        );
        if (submittedItem) {
          countedQty = submittedItem.countedQty;
          varianceReason = submittedItem.varianceReason || 'Shrinkage / Missing Stock';
        }
      }

      return {
        productId: prod.id,
        sku: prod.sku,
        barcode: prod.barcode,
        productName: prod.name,
        category: prod.category || 'General',
        unit: prod.unit || 'Pcs',
        unitCost: prod.costPrice || 0,
        bookQty,
        countedQty,
        isCounted: true,
        varianceReason,
        customReason,
        requiresSerialTracking: prod.requiresSerialTracking,
      } as AuditRow;
    });
  }, [products, stock, activeBranchId, pendingAuditRequest]);

  const [auditRows, setAuditRows] = useState<AuditRow[]>(initialAuditRows);

  // Update rows if initial state changes
  useEffect(() => {
    setAuditRows(initialAuditRows);
  }, [initialAuditRows]);

  const handleCountChange = (productId: string, val: string) => {
    if (isTableLocked) return;
    setAuditRows((prev) =>
      prev.map((row) => {
        if (row.productId === productId) {
          if (val === '') {
            return { ...row, countedQty: '', isCounted: false };
          }
          const num = parseInt(val, 10);
          const safeNum = isNaN(num) ? 0 : Math.max(0, num);
          const variance = safeNum - row.bookQty;
          let defaultReason = row.varianceReason;
          if (variance === 0) defaultReason = 'Verified Matched';
          else if (variance < 0 && defaultReason === 'Verified Matched')
            defaultReason = 'Shrinkage / Missing Stock';
          else if (variance > 0 && defaultReason === 'Verified Matched')
            defaultReason = 'Unrecorded Return / Surplus';

          return {
            ...row,
            countedQty: safeNum,
            isCounted: true,
            varianceReason: defaultReason,
          };
        }
        return row;
      })
    );
  };

  const handleQuickAdjust = (productId: string, delta: number) => {
    if (isTableLocked) return;
    setAuditRows((prev) =>
      prev.map((row) => {
        if (row.productId === productId) {
          const current = typeof row.countedQty === 'number' ? row.countedQty : 0;
          const next = Math.max(0, current + delta);
          const variance = next - row.bookQty;
          let defaultReason = row.varianceReason;
          if (variance === 0) defaultReason = 'Verified Matched';
          else if (variance < 0 && defaultReason === 'Verified Matched')
            defaultReason = 'Shrinkage / Missing Stock';
          else if (variance > 0 && defaultReason === 'Verified Matched')
            defaultReason = 'Unrecorded Return / Surplus';

          return {
            ...row,
            countedQty: next,
            isCounted: true,
            varianceReason: defaultReason,
          };
        }
        return row;
      })
    );
  };

  const handleReasonChange = (productId: string, val: string) => {
    if (isTableLocked) return;
    setAuditRows((prev) =>
      prev.map((r) =>
        r.productId === productId ? { ...r, varianceReason: val } : r
      )
    );
  };

  const handleCustomReasonChange = (productId: string, text: string) => {
    if (isTableLocked) return;
    setAuditRows((prev) =>
      prev.map((r) =>
        r.productId === productId ? { ...r, customReason: text } : r
      )
    );
  };

  const handleSetZeroAll = () => {
    if (isTableLocked) return;
    setAuditRows((prev) =>
      prev.map((row) => ({
        ...row,
        countedQty: 0,
        isCounted: true,
        varianceReason: 'Shrinkage / Missing Stock',
        customReason: '',
      }))
    );
    setToastMessage('All physical counts reset to zero.');
    setTimeout(() => setToastMessage(null), 3000);
  };

  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set);
  }, [products]);

  // Filtered rows for current branch
  const filteredRows = useMemo(() => {
    return auditRows.filter((row) => {
      if (selectedCategory !== 'ALL' && row.category !== selectedCategory) return false;

      const counted = typeof row.countedQty === 'number' ? row.countedQty : 0;
      const variance = counted - row.bookQty;

      if (filterVariance === 'MATCHED' && variance !== 0) return false;
      if (filterVariance === 'SHORTAGE' && variance >= 0) return false;
      if (filterVariance === 'EXCESS' && variance <= 0) return false;
      if (filterVariance === 'DISCREPANCY' && variance === 0) return false;
      if (filterVariance === 'UNCOUNTED' && row.isCounted) return false;

      if (searchQuery.trim()) {
        const q = (searchQuery || '').toLowerCase();
        return (
          (row?.productName || '').toLowerCase().includes(q) ||
          (row?.sku || '').toLowerCase().includes(q) ||
          (row.barcode && (row?.barcode || '').toLowerCase().includes(q))
        );
      }

      return true;
    });
  }, [auditRows, selectedCategory, filterVariance, searchQuery]);

  // Statistics Calculation
  const stats = useMemo(() => {
    let totalItems = auditRows.length;
    let countedItems = 0;
    let totalBookQty = 0;
    let totalCountedQty = 0;
    let shortageQty = 0;
    let excessQty = 0;
    let shortageValue = 0;
    let excessValue = 0;

    auditRows.forEach((row) => {
      if (row.isCounted) countedItems++;
      totalBookQty += row.bookQty;
      const counted = typeof row.countedQty === 'number' ? row.countedQty : 0;
      totalCountedQty += counted;

      const diff = counted - row.bookQty;
      if (diff < 0) {
        shortageQty += Math.abs(diff);
        shortageValue += Math.abs(diff) * row.unitCost;
      } else if (diff > 0) {
        excessQty += diff;
        excessValue += diff * row.unitCost;
      }
    });

    const netValueVariance = excessValue - shortageValue;

    const discrepancyRows = auditRows.filter((r) => {
      const c = typeof r.countedQty === 'number' ? r.countedQty : 0;
      return c !== r.bookQty;
    });

    return {
      totalItems,
      countedItems,
      totalBookQty,
      totalCountedQty,
      shortageQty,
      excessQty,
      shortageValue,
      excessValue,
      netValueVariance,
      discrepancyCount: discrepancyRows.length,
      discrepancyRows,
    };
  }, [auditRows]);

  const activeBranch = branches.find((b) => b.id === activeBranchId) || branches[0];

  // 1. Submit Stock Audit for Approval (Workflow: Count Stock > Send Request for approval > Lock table)
  const handleSubmitForApproval = async () => {
    if (!onRequestApproval) return;
    setIsSubmitting(true);
    try {
      const varianceItems = stats.discrepancyRows.map((r) => {
        const counted = typeof r.countedQty === 'number' ? r.countedQty : 0;
        const variance = counted - r.bookQty;
        const finalReason = r.varianceReason === 'Other / Custom Note...' && r.customReason?.trim()
          ? `Custom: ${r.customReason.trim()}`
          : r.varianceReason;

        return {
          productId: r.productId,
          sku: r.sku,
          productName: r.productName,
          category: r.category,
          unit: r.unit,
          unitCost: r.unitCost,
          bookQty: r.bookQty,
          countedQty: counted,
          varianceQty: variance,
          varianceValue: variance * r.unitCost,
          varianceReason: finalReason,
        };
      });

      const auditPayload: Omit<ApprovalRequest, 'id' | 'requestNumber' | 'status' | 'requestedAtAD' | 'requestedAtBS'> = {
        type: 'STOCK_AUDIT_RECONCILIATION',
        targetId: auditRefNumber,
        customerName: `Physical Stock Audit - ${activeBranch?.name || activeBranchId}`,
        customerCode: activeBranch?.code || activeBranchId,
        deviceSerial: auditRefNumber,
        productName: `Stock Discrepancies (${stats.discrepancyCount} items)`,
        currentStatus: 'UNRECONCILED_AUDIT',
        requestedStatus: 'RECONCILED_ADJUSTED',
        requestedByRole: currentUser?.role || 'BRANCH_MANAGER',
        requestedByEmail: currentUser?.email || 'user@system.com.np',
        requestedByName: currentUser?.name || auditorName,
        branchId: activeBranchId,
        branchName: activeBranch?.name,
        reason:
          approvalNotes.trim() ||
          `Physical inventory stock count audit completed for ${activeBranch?.name}. Found ${stats.discrepancyCount} discrepancies (Shortage: -${stats.shortageQty}, Excess: +${stats.excessQty}, Net Impact: NPR ${(stats.netValueVariance ?? 0).toLocaleString()}). Requesting authorization to adjust physical inventory book balances.`,
        auditData: {
          auditRefNumber,
          branchId: activeBranchId,
          branchName: activeBranch?.name || activeBranchId,
          totalItems: stats.totalItems,
          discrepancyCount: stats.discrepancyCount,
          shortageQty: stats.shortageQty,
          excessQty: stats.excessQty,
          shortageValue: stats.shortageValue,
          excessValue: stats.excessValue,
          netValueVariance: stats.netValueVariance,
          varianceItems,
        },
      };

      await onRequestApproval(auditPayload);
      setIsLocallySubmitted(true);
      setShowApprovalModal(false);
      setApprovalNotes('');
      setToastMessage(`Stock Audit #${auditRefNumber} submitted for Authorization. Table is now LOCKED for ${activeBranch?.name} until approved!`);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to submit audit approval request:', err);
      setToastMessage(`Submission failed: ${err.message}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 2. Super Admin / Stock Manager: DEDICATED APPROVE AND RECONCILE STOCK
  const handleApproveAndReconcile = async () => {
    if (!pendingAuditRequest || !onProcessApproval) return;
    setIsSubmitting(true);
    try {
      // Process authorization in Workflow Approval Engine (which executes backend stock reconciliation)
      await onProcessApproval(pendingAuditRequest.id, 'APPROVED');

      setIsLocallySubmitted(false);
      setShowApproveReconcileModal(false);
      setToastMessage(
        `Stock Audit #${pendingAuditRequest.auditData?.auditRefNumber || auditRefNumber} Authorized & Reconciled! Branch stock updated to physical counts.`
      );
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to approve and reconcile audit:', err);
      setToastMessage(`Reconciliation failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Bulk Approve All Pending Branch Audits
  const handleApproveAllPendingAudits = async () => {
    if (!onProcessApproval || visiblePendingAuditRequests.length === 0) return;
    setIsSubmitting(true);
    try {
      for (const req of visiblePendingAuditRequests) {
        await onProcessApproval(req.id, 'APPROVED', 'Bulk Reconciliation Authorized by Executive Approver');
      }
      setToastMessage(`Successfully authorized and reconciled all ${visiblePendingAuditRequests.length} pending branch stock audits!`);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to bulk approve audits:', err);
      setToastMessage(`Bulk approval failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Single Branch Approval from Matrix
  const handleApproveSinglePendingBranch = async (requestId: string, branchName: string) => {
    if (!onProcessApproval) return;
    setIsSubmitting(true);
    try {
      await onProcessApproval(requestId, 'APPROVED', `Physical Stock Audit Authorized for ${branchName}`);
      setToastMessage(`Stock Audit for ${branchName} Authorized & Reconciled!`);
      setTimeout(() => setToastMessage(null), 4000);
    } catch (err: any) {
      console.error('Failed to approve branch audit:', err);
      setToastMessage(`Branch approval failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 3. Super Admin / Stock Manager: REJECT AUDIT REQUEST (Unlocks table for branch recount)
  const handleRejectAudit = async () => {
    if (!pendingAuditRequest || !onProcessApproval) return;
    setIsSubmitting(true);
    try {
      await onProcessApproval(
        pendingAuditRequest.id,
        'REJECTED',
        rejectReason.trim() || 'Physical audit count rejected by Stock Manager. Recount required.'
      );
      setShowRejectModal(false);
      setRejectReason('');
      setToastMessage(`Audit request rejected. Table unlocked for ${activeBranch?.name} recount.`);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to reject audit:', err);
      setToastMessage(`Rejection failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 4. Super Admin / Stock Manager: Direct Stock Reconcile
  const handleDirectReconcile = async () => {
    setIsSubmitting(true);
    try {
      const varianceItems = stats.discrepancyRows.map((r) => {
        const c = typeof r.countedQty === 'number' ? r.countedQty : 0;
        const delta = c - r.bookQty;
        const reasonText =
          r.varianceReason === 'Other / Custom Note...' && r.customReason?.trim()
            ? r.customReason.trim()
            : r.varianceReason;

        return {
          productId: r.productId,
          sku: r.sku,
          productName: r.productName,
          unitCost: r.unitCost,
          bookQty: r.bookQty,
          countedQty: c,
          varianceQty: delta,
          varianceValue: delta * r.unitCost,
          varianceReason: reasonText,
        };
      });

      if (onReconcileStockAudit) {
        await onReconcileStockAudit({
          branchId: activeBranchId,
          auditRefNumber,
          varianceItems,
          auditorName: currentUser?.name || auditorName,
          userEmail: currentUser?.email,
          notes: `Direct Physical Stock Audit Reconciliation for ${activeBranch?.name}`,
        });
      } else if (onUpdateStockLevel) {
        for (const row of stats.discrepancyRows) {
          const c = typeof row.countedQty === 'number' ? row.countedQty : 0;
          const delta = c - row.bookQty;
          const stockItem = stock.find((s) => s.productId === row.productId && s.branchId === activeBranchId);
          if (stockItem) {
            await onUpdateStockLevel(
              stockItem.id,
              c,
              `Direct Physical Audit Ref: ${auditRefNumber} - ${row.varianceReason}`,
              undefined,
              delta > 0 ? 'PHYSICAL_AUDIT_EXCESS' : 'PHYSICAL_AUDIT_SHORTAGE'
            );
          }
        }
      }

      setShowDirectReconcileModal(false);
      setShowApproveReconcileModal(false);
      setIsLocallySubmitted(false);
      setToastMessage(`Stock Audit #${auditRefNumber} reconciled successfully! Branch on-hand balances updated.`);
      setTimeout(() => setToastMessage(null), 5000);
    } catch (err: any) {
      console.error('Failed to post direct audit reconciliation:', err);
      setToastMessage(`Reconciliation failed: ${err.message || 'Unknown error'}`);
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 5. Export Branch-wise Audit CSV
  const handleExportBranchCSV = () => {
    const columns = [
      { key: 'branchCode', label: 'Branch Code', formatter: () => activeBranch?.code || activeBranchId },
      { key: 'branchName', label: 'Branch Name', formatter: () => activeBranch?.name || activeBranchId },
      { key: 'auditRef', label: 'Audit Ref Number', formatter: () => auditRefNumber },
      { key: 'auditor', label: 'Auditor Name', formatter: () => auditorName },
      { key: 'sku', label: 'SKU' },
      { key: 'barcode', label: 'Barcode', formatter: (val: string) => val || '' },
      { key: 'productName', label: 'Product Name' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit' },
      { key: 'unitCost', label: 'Unit Cost (NPR)' },
      { key: 'bookQty', label: 'Book System Qty' },
      {
        key: 'countedQty',
        label: 'Physical Counted Qty',
        formatter: (val: any) => (typeof val === 'number' ? val : 0),
      },
      {
        key: 'varianceQty',
        label: 'Variance Qty',
        formatter: (_: any, r: AuditRow) => {
          const counted = typeof r.countedQty === 'number' ? r.countedQty : 0;
          return counted - r.bookQty;
        },
      },
      {
        key: 'varianceValue',
        label: 'Variance Value (NPR)',
        formatter: (_: any, r: AuditRow) => {
          const counted = typeof r.countedQty === 'number' ? r.countedQty : 0;
          return (counted - r.bookQty) * r.unitCost;
        },
      },
      { key: 'varianceReason', label: 'Discrepancy Reason' },
      { key: 'customReason', label: 'Custom Notes', formatter: (val: string) => val || '' },
    ];

    exportToCSV({
      filename: `Stock_Audit_${activeBranch?.code || 'BRANCH'}_${auditRefNumber}`,
      reportTitle: `Physical Stock Count & Variance Audit Report (#${auditRefNumber})`,
      branchName: activeBranch?.name || `Branch ${activeBranchId}`,
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || auditorName,
      data: auditRows,
      columns,
    });
  };

  // 6. Consolidated Multi-Branch Matrix Data & Export
  const consolidatedMatrix = useMemo(() => {
    return products.map((prod) => {
      let companyTotalBookQty = 0;
      let companyTotalCountedQty = 0;
      let companyTotalVarianceQty = 0;

      const branchBreakdowns = visibleBranches.map((b) => {
        const stk = stock.find((s) => s.productId === prod.id && s.branchId === b.id);
        const bBookQty = stk ? stk.quantityOnHand : 0;
        const bCountedQty = b.id === activeBranchId
          ? (typeof auditRows.find((r) => r.productId === prod.id)?.countedQty === 'number'
              ? (auditRows.find((r) => r.productId === prod.id)?.countedQty as number)
              : bBookQty)
          : bBookQty;
        const bVariance = bCountedQty - bBookQty;

        companyTotalBookQty += bBookQty;
        companyTotalCountedQty += bCountedQty;
        companyTotalVarianceQty += bVariance;

        return {
          branchId: b.id,
          branchCode: b.code,
          branchName: b.name,
          bookQty: bBookQty,
          countedQty: bCountedQty,
          variance: bVariance,
          varianceVal: bVariance * (prod.costPrice || 0),
        };
      });

      const totalVarianceVal = companyTotalVarianceQty * (prod.costPrice || 0);

      return {
        productId: prod.id,
        sku: prod.sku,
        barcode: prod.barcode,
        productName: prod.name,
        category: prod.category || 'General',
        unit: prod.unit || 'Pcs',
        unitCost: prod.costPrice || 0,
        branches: branchBreakdowns,
        companyTotalBookQty,
        companyTotalCountedQty,
        companyTotalVarianceQty,
        totalVarianceVal,
      };
    });
  }, [products, visibleBranches, stock, activeBranchId, auditRows]);

  const consolidatedSummary = useMemo(() => {
    let totalBook = 0;
    let totalCounted = 0;
    let totalShortage = 0;
    let totalExcess = 0;
    let totalShortageVal = 0;
    let totalExcessVal = 0;
    let totalDiscrepancies = 0;

    consolidatedMatrix.forEach((m) => {
      totalBook += m.companyTotalBookQty;
      totalCounted += m.companyTotalCountedQty;
      if (m.companyTotalVarianceQty < 0) {
        totalShortage += Math.abs(m.companyTotalVarianceQty);
        totalShortageVal += Math.abs(m.companyTotalVarianceQty) * m.unitCost;
        totalDiscrepancies++;
      } else if (m.companyTotalVarianceQty > 0) {
        totalExcess += m.companyTotalVarianceQty;
        totalExcessVal += m.companyTotalVarianceQty * m.unitCost;
        totalDiscrepancies++;
      }
    });

    return {
      totalBook,
      totalCounted,
      totalShortage,
      totalExcess,
      totalShortageVal,
      totalExcessVal,
      totalDiscrepancies,
    };
  }, [consolidatedMatrix]);

  const handleExportConsolidatedCSV = () => {
    const branchCols = branches.flatMap((b) => [
      {
        key: `branch_${b.id}_book`,
        label: `${b.name} (${b.code}) Book`,
        formatter: (_: any, m: (typeof consolidatedMatrix)[0]) => m.branches.find((x) => x.branchId === b.id)?.bookQty || 0,
      },
      {
        key: `branch_${b.id}_count`,
        label: `${b.name} (${b.code}) Count`,
        formatter: (_: any, m: (typeof consolidatedMatrix)[0]) => m.branches.find((x) => x.branchId === b.id)?.countedQty || 0,
      },
      {
        key: `branch_${b.id}_diff`,
        label: `${b.name} (${b.code}) Diff`,
        formatter: (_: any, m: (typeof consolidatedMatrix)[0]) => m.branches.find((x) => x.branchId === b.id)?.variance || 0,
      },
    ]);

    const columns = [
      { key: 'sku', label: 'SKU' },
      { key: 'barcode', label: 'Barcode', formatter: (val: string) => val || '' },
      { key: 'productName', label: 'Product Name' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit' },
      { key: 'unitCost', label: 'Cost (NPR)' },
      ...branchCols,
      { key: 'companyTotalBookQty', label: 'Company Total Book' },
      { key: 'companyTotalCountedQty', label: 'Company Total Count' },
      { key: 'companyTotalVarianceQty', label: 'Net Variance Qty' },
      { key: 'totalVarianceVal', label: 'Net Variance Value (NPR)' },
    ];

    exportToCSV({
      filename: `Consolidated_Stock_Audit_All_Branches_${auditRefNumber}`,
      reportTitle: `Consolidated Multi-Branch Stock Audit & Discrepancy Matrix (#${auditRefNumber})`,
      branchName: 'All Branches (Consolidated Matrix)',
      generatedBy: currentUser?.name ? `${currentUser.name} (${currentUser.role})` : currentUser?.email || auditorName,
      data: consolidatedMatrix,
      columns,
    });
  };

  const todayAD = new Date().toISOString().split('T')[0];
  const todayBS = convertADToBS(todayAD).formattedBS;

  return (
    <div className="space-y-3">
      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="p-3.5 rounded-2xl bg-indigo-600 text-white font-bold text-xs flex items-center justify-between shadow-lg animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{toastMessage}</span>
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="p-1 rounded-lg hover:bg-white/20 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 1. SUPER ADMIN / STOCK MANAGER RECONCILIATION REVIEW PANEL */}
      {isReviewMode && pendingAuditRequest && (
        <div className={`p-5 rounded-3xl border-2 shadow-xl space-y-3.5 border-purple-400 from-purple-50 via-indigo-50/50 to-purple-50 text-purple-950 dark:border-purple-600 dark:from-purple-950/60 dark:via-slate-900 dark:to-purple-950/60 dark:text-purple-100 bg-gradient-to-r`}>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-2xl bg-purple-600 text-white shadow-md">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-extrabold text-base text-purple-900 dark:text-purple-200`}>
                    Administrative Review & Reconciliation Mode
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-purple-600 text-white text-[10px] font-mono font-bold uppercase tracking-wider">
                    REQUEST #{pendingAuditRequest.requestNumber}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-200 text-purple-800 dark:bg-purple-900 dark:text-purple-200`}>
                    {activeBranch?.name} ({activeBranch?.code})
                  </span>
                </div>
                <p className={`text-xs leading-relaxed max-w-3xl text-purple-800 dark:text-purple-300`}>
                  Submitted by <strong>{pendingAuditRequest.requestedByName}</strong> ({pendingAuditRequest.requestedByRole}) for Batch{' '}
                  <strong className="font-mono">{pendingAuditRequest.auditData?.auditRefNumber || pendingAuditRequest.deviceSerial}</strong>.
                  Inspect the physical counts and discrepancy reasons below. You may perform fine-tuned adjustments to quantities before executing reconciliation.
                </p>
              </div>
            </div>

            {/* DEDICATED ACTION BUTTONS FOR SUPER ADMIN / STOCK MANAGER */}
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setShowRejectModal(true)}
                disabled={isSubmitting}
                className={`px-4 py-2.5 rounded-xl border font-bold text-xs shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 dark:border-rose-700 dark:bg-rose-950/60 dark:hover:bg-rose-900/60 dark:text-rose-300`}
                title="Reject audit and unlock table for branch recount"
              >
                <XCircle className={`h-4 w-4 text-rose-600 dark:text-rose-400`} />
                <span>Reject Audit</span>
              </button>

              <button
                type="button"
                onClick={() => setShowApproveReconcileModal(true)}
                disabled={isSubmitting}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-xs shadow-lg shadow-emerald-600/30 flex items-center gap-2 cursor-pointer disabled:opacity-50 transition-all"
                title="Authorize and Adjust Branch Inventory Stock to Physical Counts"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>Approve & Reconcile Stock</span>
              </button>
            </div>
          </div>

          {/* Quick Discrepancy Snapshot Pill */}
          <div className={`grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2 border-t text-xs border-purple-200 dark:border-purple-800`}>
            <div className={`p-2 rounded-xl border bg-white/70 border-purple-100 dark:bg-slate-900/80 dark:border-purple-900`}>
              <span className={`text-[10px] font-bold block text-purple-600 dark:text-purple-400`}>Discrepancy Items</span>
              <span className={`font-extrabold font-mono text-purple-900 dark:text-purple-100`}>{stats.discrepancyCount} SKUs</span>
            </div>
            <div className={`p-2 rounded-xl border bg-white/70 border-rose-200 dark:bg-slate-900/80 dark:border-rose-900/40`}>
              <span className={`text-[10px] font-bold block text-rose-600 dark:text-rose-400`}>Total Shortage</span>
              <span className={`font-extrabold font-mono text-rose-600 dark:text-rose-400`}>-{stats.shortageQty} Units (-NPR {(stats.shortageValue ?? 0).toLocaleString()})</span>
            </div>
            <div className={`p-2 rounded-xl border bg-white/70 border-emerald-200 dark:bg-slate-900/80 dark:border-emerald-900/40`}>
              <span className={`text-[10px] font-bold block text-emerald-600 dark:text-emerald-400`}>Total Excess</span>
              <span className={`font-extrabold font-mono text-emerald-600 dark:text-emerald-400`}>+{stats.excessQty} Units (+NPR {(stats.excessValue ?? 0).toLocaleString()})</span>
            </div>
            <div className={`p-2 rounded-xl border bg-white/70 border-purple-200 dark:bg-slate-900/80 dark:border-purple-800`}>
              <span className={`text-[10px] font-bold block text-purple-600 dark:text-purple-400`}>Net Valuation Impact</span>
              <span className={`font-extrabold font-mono ${stats.netValueVariance >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {stats.netValueVariance >= 0 ? '+' : ''}NPR {(stats.netValueVariance ?? 0).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 2. TABLE LOCKED BANNER (When Audit is Submitted or Pending) */}
      {isTableLocked && (
        <div className={`p-3 rounded-2xl border-2 flex flex-col md:flex-row md:items-center justify-start gap-3 shadow-xs border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200`}>
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-xl bg-amber-500 text-white shadow-xs shrink-0 mt-0.5">
              <Lock className="h-5 w-5" />
            </div>
            <div className="text-xs space-y-1">
              <div className="font-extrabold text-sm flex items-center gap-2">
                <span>
                  Stock Count Table Locked — Audit Pending Authorization{' '}
                  {pendingAuditRequest ? `(#${pendingAuditRequest.requestNumber})` : `(#${auditRefNumber})`}
                </span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-mono font-bold bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100`}>
                  LOCKED
                </span>
              </div>
              <p className={`leading-relaxed text-amber-800 dark:text-amber-300`}>
                Physical stock count for <strong>{activeBranch?.name}</strong> was submitted by{' '}
                <strong>{pendingAuditRequest?.requestedByName || currentUser?.name || auditorName}</strong>{' '}
                {pendingAuditRequest?.requestedAtAD ? `on ${formatDualDate(pendingAuditRequest.requestedAtAD, dateMode)}` : ''}.
                The table is locked from editing until reviewed and authorized by the Super Admin or Stock Manager.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isManagerOrAdmin && pendingAuditRequest && (
              <>
                <button
                  type="button"
                  onClick={() => setShowApproveReconcileModal(true)}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Approve & Reconcile Stock</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowRejectModal(true)}
                  className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <XCircle className="h-4 w-4" />
                  <span>Reject</span>
                </button>
              </>
            )}
            {onNavigateTab && (
              <button
                type="button"
                onClick={() => onNavigateTab('approvals')}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <span>View Approval Status</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* RECENTLY APPROVED NOTIFICATION */}
      {recentApprovedAuditRequest && !pendingAuditRequest && (
        <div className={`p-3.5 rounded-2xl border bg-emerald-50 flex items-center justify-between gap-3 text-xs border-emerald-300 text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200`}>
          <div className="flex items-center gap-2">
            <CheckCircle2 className={`h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400`} />
            <span>
              Audit Batch <strong>{recentApprovedAuditRequest.auditData?.auditRefNumber}</strong> was authorized & reconciled by <strong>{recentApprovedAuditRequest.processedByName}</strong> on {recentApprovedAuditRequest.processedAtBS || '2083 BS'}. Physical and system stock balances are synchronized.
            </span>
          </div>
        </div>
      )}

      {/* AUDIT WORKFLOW TAB SWITCHER */}
      <div className={`flex flex-wrap items-center justify-between gap-3 p-2 rounded-2xl border bg-slate-100 border-slate-200 dark:bg-slate-800/80 dark:border-slate-700`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveAuditTab('SINGLE_BRANCH')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${activeAuditTab === 'SINGLE_BRANCH' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
          >
            <Building className="h-4 w-4" />
            <span>Branch Floor Audit Session ({activeBranch?.name})</span>
            {isEffectiveBlindAudit && (
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-black bg-amber-400 text-slate-950 dark:bg-amber-600 dark:text-amber-100`}>
                BLIND
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveAuditTab('CONSOLIDATED_MATRIX')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-extrabold transition-all cursor-pointer ${activeAuditTab === 'CONSOLIDATED_MATRIX' ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
          >
            <TableProperties className="h-4 w-4" />
            <span>Multi-Branch Audit Matrix & Approver View</span>
            {visiblePendingAuditRequests.length > 0 && (
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-black animate-pulse bg-amber-500 text-slate-950 dark:bg-amber-600 dark:text-amber-100`}>
                {visiblePendingAuditRequests.length} PENDING
              </span>
            )}
          </button>
        </div>

        {visiblePendingAuditRequests.length > 0 && isManagerOrAdmin && (
          <button
            type="button"
            onClick={handleApproveAllPendingAudits}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold shadow-sm transition-all cursor-pointer disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>Approve All ({visiblePendingAuditRequests.length}) Pending Branch Audits</span>
          </button>
        )}
      </div>

      {/* VIEW MODE 1: SINGLE BRANCH FLOOR AUDIT SESSION */}
      {activeAuditTab === 'SINGLE_BRANCH' && (
        <>
          {/* HEADER SECTION */}
          <div
            className={`p-5 rounded-3xl border flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-white border-slate-200 text-slate-800 shadow-xs dark:bg-slate-900/90 dark:border-slate-800 dark:text-slate-100`}
          >
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-2xl bg-indigo-600/10 text-indigo-500 border border-indigo-500/20">
                  <ClipboardCheck className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2">
                    <span>Physical Stock Count & Reconciliation Audit</span>
                    {isTableLocked && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono flex items-center gap-1 font-bold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300`}>
                        <Lock className="h-3 w-3" />
                        <span>LOCKED</span>
                      </span>
                    )}
                    {isReviewMode && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono flex items-center gap-1 font-bold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300`}>
                        <ShieldCheck className="h-3 w-3" />
                        <span>MANAGER REVIEW</span>
                      </span>
                    )}
                  </h2>
                  <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                    Count branch inventory, record discrepancy justifications, and submit for management authorization to reconcile physical stock.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
              {/* Branch Selector with Permission Locking */}
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200`}>
                <Building className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
                <span className="text-slate-500 dark:text-slate-400">Location:</span>
                {isBranchLockedForUser ? (
                  <span className={`font-bold flex items-center gap-1 text-slate-800 dark:text-slate-100`}>
                    <span>{activeBranch?.name}</span>
                    <span className={`text-[10px] text-indigo-600 dark:text-indigo-400`}>({activeBranch?.code})</span>
                  </span>
                ) : (
                  <select
                    value={activeBranchId}
                    onChange={(e) => setActiveBranchId(e.target.value)}
                    className={`bg-transparent font-bold focus:outline-none cursor-pointer text-slate-800 dark:text-slate-100`}
                  >
                    {allowedBranches.map((b) => (
                      <option key={b.id} value={b.id} className="bg-white dark:bg-slate-900">
                        {b.name} ({b.code})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Dedicated Company-Wide Blind Stock Audit Button (Super Admin & Stock Manager) */}
              {canToggleBlindCount && (
                <button
                  type="button"
                  onClick={() => {
                    const next = !isCompanyWideBlindCount;
                    setIsCompanyWideBlindCount(next);
                    if (next) setIsBlindRevealed(false);
                    setToastMessage(
                      next
                        ? 'Company-Wide Blind Count ACTIVATED for all 19 branches!'
                        : 'Company-Wide Blind Count Mode Deactivated.'
                    );
                    setTimeout(() => setToastMessage(null), 4000);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black transition-all cursor-pointer border ${isCompanyWideBlindCount ? 'bg-purple-600 text-white border-purple-500 shadow-md ring-2 ring-purple-400/40' : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700'}`}
                  title="Enable Blind Count Mode across all company branches simultaneously"
                >
                  <Lock className={`h-4 w-4 ${isCompanyWideBlindCount ? 'text-purple-200' : 'text-purple-500'}`} />
                  <span>Company Blind Count: {isCompanyWideBlindCount ? 'ON (All Branches)' : 'OFF'}</span>
                </button>
              )}

              {/* Branch Blind Stock Audit Toggle (Restricted to Super Admin & Stock Manager) */}
              <button
                type="button"
                disabled={!canToggleBlindCount || isCompanyWideBlindCount}
                onClick={() => {
                  if (!canToggleBlindCount) {
                    setToastMessage('Access Denied: Only Super Admin and Stock Manager can toggle Blind Count mode.');
                    setTimeout(() => setToastMessage(null), 4000);
                    return;
                  }
                  if (isBlindAuditMode) {
                    setIsBlindAuditMode(false);
                    setIsBlindRevealed(false);
                    setToastMessage('Switched to Standard Audit Mode (Visible Book Balances).');
                  } else {
                    setIsBlindAuditMode(true);
                    setIsBlindRevealed(false);
                    setToastMessage('Blind Stock Audit Mode Activated — Book balances hidden for unbiased stock count!');
                  }
                  setTimeout(() => setToastMessage(null), 4000);
                }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all border ${
                  !canToggleBlindCount || isCompanyWideBlindCount
                    ? isDarkMode ? 'opacity-70 cursor-not-allowed bg-slate-800/60 text-slate-400 border-slate-800' : 'opacity-70 cursor-not-allowed bg-slate-100 text-slate-500 border-slate-200'
                    : isBlindAuditMode
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md font-extrabold cursor-pointer'
                    : isDarkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                }`}
                title={
                  !canToggleBlindCount
                    ? 'Restricted: Only Super Admin & Stock Manager can toggle Blind Count'
                    : isCompanyWideBlindCount
                    ? 'Enforced company-wide by Executive Admin'
                    : 'Blind Stock Audit: Hide book quantities from floor count staff to prevent bias'
                }
              >
                <Lock className={`h-4 w-4 ${isEffectiveBlindAudit ? 'text-slate-950 dark:text-amber-400' : 'text-amber-500'}`} />
                <span>
                  Branch Blind Count: {isCompanyWideBlindCount ? 'ON (Enforced)' : isBlindAuditMode ? 'ON (Hidden)' : 'OFF'}
                </span>
                {!canToggleBlindCount && (
                  <span className={`text-[9px] uppercase px-1 py-0.5 rounded font-extrabold bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300`}>
                    Locked
                  </span>
                )}
              </button>

              {/* Consolidated Report Modal Button */}
              <button
                type="button"
                onClick={() => setShowConsolidatedModal(true)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors cursor-pointer border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 dark:text-indigo-300`}
                title="Open Consolidated Multi-Branch Stock Audit Report"
              >
                <TableProperties className={`h-4 w-4 text-indigo-600 dark:text-indigo-400`} />
                <span>Consolidated Matrix</span>
              </button>

              {/* Export Branch CSV */}
              <button
                type="button"
                onClick={handleExportBranchCSV}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 text-slate-700 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-slate-300`}
                title="Download Branch Audit CSV Report"
              >
                <FileSpreadsheet className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
                <span>Export Branch CSV</span>
              </button>

              {/* PRIMARY WORKFLOW BUTTON: SUBMIT FOR APPROVAL REPORT */}
              {!pendingAuditRequest && !isLocallySubmitted && (
                <button
                  type="button"
                  id="btn-submit-stock-audit-approval"
                  onClick={() => setShowApprovalModal(true)}
                  disabled={stats.discrepancyCount === 0 || isTableLocked}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-extrabold text-white shadow-md transition-all cursor-pointer stats.discrepancyCount > ${0 && !isTableLocked ? 'bg-gradient-to-r from-indigo-600 via-indigo-700 to-indigo-800 hover:from-indigo-500 hover:to-indigo-600 ring-2 ring-indigo-500/20 active:scale-95' : 'bg-slate-400 text-slate-200 cursor-not-allowed opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:cursor-not-allowed dark:opacity-60'}`}
                  title={
                    stats.discrepancyCount === 0
                      ? 'No stock count discrepancies to submit'
                      : 'Submit Physical Stock Count Audit Report for Authorization & Lock Table'
                  }
                >
                  <Send className="h-4 w-4 shrink-0" />
                  <span>Submit for Approval Report {stats.discrepancyCount > 0 ? `(${stats.discrepancyCount})` : ''}</span>
                </button>
              )}

              {/* Super Admin / Stock Manager: DEDICATED APPROVE & RECONCILE ACTION */}
              {isManagerOrAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    if (pendingAuditRequest) {
                      setShowApproveReconcileModal(true);
                    } else {
                      setShowApproveReconcileModal(true);
                    }
                  }}
                  disabled={stats.discrepancyCount === 0 && !pendingAuditRequest}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-white font-extrabold text-xs shadow-md cursor-pointer transition-all stats.discrepancyCount > ${0 || pendingAuditRequest ? 'bg-emerald-600 hover:bg-emerald-700 ring-2 ring-emerald-500/20 active:scale-95' : 'bg-slate-400 text-slate-200 cursor-not-allowed opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:cursor-not-allowed dark:opacity-60'}`}
                  title="Super Admin / Stock Manager: Authorize & Reconcile Physical Counts with Ledger"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Approve & Reconcile Stock</span>
                </button>
              )}
            </div>
          </div>

      {/* METRICS SUMMARY CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {/* Card 1: Total SKUs */}
        <div
          className={`p-4 rounded-2xl border bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800`}
        >
          <p className={`text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400`}>
            Total Audit SKUs
          </p>
          <p className={`text-xl font-extrabold font-mono mt-1 text-slate-900 dark:text-slate-100`}>
            {stats.totalItems}
          </p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Counted: {stats.countedItems} / {stats.totalItems}
          </p>
        </div>

        {/* Card 2: Book System Qty */}
        <div
          className={`p-4 rounded-2xl border bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800`}
        >
          <p className={`text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400`}>
            Book System Qty
          </p>
          <p className={`text-xl font-extrabold font-mono mt-1 text-slate-700 dark:text-slate-300`}>
            {(stats.totalBookQty ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Physical: {(stats.totalCountedQty ?? 0).toLocaleString()}
          </p>
        </div>

        {/* Card 3: Shortage (-) */}
        <div
          className={`p-4 rounded-2xl border ${stats.shortageQty > 0 ? 'bg-rose-50/70 border-rose-200 text-rose-950 dark:bg-rose-950/40 dark:border-rose-900/50 dark:text-rose-100' : 'bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800'}`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-rose-500 flex items-center gap-1">
            <TrendingDown className="h-3 w-3" />
            <span>Shortage (-)</span>
          </p>
          <p className={`text-xl font-extrabold font-mono mt-1 text-rose-600 dark:text-rose-400`}>
            -{(stats.shortageQty ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-rose-500/80 font-mono mt-0.5">
            -NPR {(stats.shortageValue ?? 0).toLocaleString()}
          </p>
        </div>

        {/* Card 4: Excess (+) */}
        <div
          className={`p-4 rounded-2xl border ${stats.excessQty > 0 ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950 dark:bg-emerald-950/40 dark:border-emerald-900/50 dark:text-emerald-100' : 'bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800'}`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-600 flex items-center gap-1">
            <TrendingUp className="h-3 w-3" />
            <span>Excess / Surplus (+)</span>
          </p>
          <p className={`text-xl font-extrabold font-mono mt-1 text-emerald-600 dark:text-emerald-400`}>
            +{(stats.excessQty ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-emerald-600/80 font-mono mt-0.5">
            +NPR {(stats.excessValue ?? 0).toLocaleString()}
          </p>
        </div>

        {/* Card 5: Net Value Impact */}
        <div
          className={`p-4 rounded-2xl border ${
            stats.netValueVariance !== 0
              ? stats.netValueVariance < 0
                ? isDarkMode ? 'bg-rose-500/10 border-rose-500/30 text-rose-100' : 'bg-rose-500/10 border-rose-500/30 text-rose-900'
                : isDarkMode ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900'
              : 'bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800'
          }`}
        >
          <p className={`text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400`}>
            Net Value Impact
          </p>
          <p
            className={`text-xl font-extrabold font-mono mt-1 ${
              stats.netValueVariance < 0
                ? 'text-rose-600'
                : stats.netValueVariance > 0
                ? 'text-emerald-600'
                : 'text-slate-500'
            }`}
          >
            {stats.netValueVariance >= 0 ? '+' : ''}NPR {(stats.netValueVariance ?? 0).toLocaleString()}
          </p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Discrepancies: {stats.discrepancyCount} items
          </p>
        </div>
      </div>

      {/* BLIND AUDIT ACTIVE BANNER & UNSEAL ACTION */}
      {isEffectiveBlindAudit && (
        <div className={`p-3 rounded-2xl border-2 bg-gradient-to-r from-indigo-900 via-slate-900 to-indigo-950 text-white flex flex-col sm:flex-row sm:items-center justify-start gap-3 shadow-lg border-indigo-400 dark:border-indigo-600`}>
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-xl bg-indigo-500 text-white shadow-md shrink-0">
              <Lock className="h-5 w-5" />
            </div>
            <div className="space-y-0.5 text-xs">
              <div className="font-extrabold text-sm flex items-center gap-2 text-indigo-200">
                <span>
                  {isCompanyWideBlindCount
                    ? `Company-Wide Blind Stock Audit Active (${activeBranch?.name})`
                    : `Blind Stock Audit Active for ${activeBranch?.name}`}
                </span>
                {isBlindRevealed ? (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-extrabold">
                    UNSEALED
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 text-[10px] font-extrabold">
                    COUNTING IN PROGRESS
                  </span>
                )}
              </div>
              <p className="text-slate-300 leading-relaxed max-w-2xl">
                {isBlindRevealed
                  ? 'System balances and variances are unsealed and calculated. Review discrepancies below before submitting for management reconciliation.'
                  : 'Book quantities are hidden from floor stock auditors to guarantee unbiased physical counts. When physical counting is completed, click "Unseal & Reveal System Balances".'}
              </p>
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {!isBlindRevealed ? (
              <button
                type="button"
                onClick={() => {
                  setIsBlindRevealed(true);
                  setToastMessage('System Balances Unsealed! Variances calculated successfully.');
                  setTimeout(() => setToastMessage(null), 4000);
                }}
                className="px-4 py-2.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-xs shadow-md flex items-center gap-2 cursor-pointer active:scale-95 transition-all"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>Unseal & Reveal System Balances</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIsBlindRevealed(false);
                  setToastMessage('Re-sealed system balances for blind count.');
                  setTimeout(() => setToastMessage(null), 3000);
                }}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 cursor-pointer"
              >
                Re-seal Balances
              </button>
            )}
          </div>
        </div>
      )}

      {/* FILTER & SEARCH TOOLBAR */}
      <div
        className={`p-4 rounded-2xl border bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Search Input */}
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by SKU, Barcode, Product Name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className={`w-full pl-9 pr-4 py-2 rounded-xl text-xs border focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Category Filter */}
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className={`px-3 py-2 rounded-xl border text-xs font-semibold focus:outline-none cursor-pointer bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200`}
            >
              <option value="ALL">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            {/* Variance Filter */}
            <select
              value={filterVariance}
              onChange={(e) => setFilterVariance(e.target.value as any)}
              className={`px-3 py-2 rounded-xl border text-xs font-semibold focus:outline-none cursor-pointer bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200`}
            >
              <option value="ALL">All Stock Rows ({auditRows.length})</option>
              <option value="DISCREPANCY">Discrepancies Only ({stats.discrepancyCount})</option>
              <option value="MATCHED">Matched Only ({auditRows.length - stats.discrepancyCount})</option>
              <option value="SHORTAGE">Shortages (-) ({stats.discrepancyRows.filter((r) => ((r.countedQty as number) - r.bookQty) < 0).length})</option>
              <option value="EXCESS">Excess (+) ({stats.discrepancyRows.filter((r) => ((r.countedQty as number) - r.bookQty) > 0).length})</option>
            </select>

            <div className={`h-5 w-[1px] mx-1 hidden sm:block bg-slate-200 dark:bg-slate-800`} />

            {/* Bulk Quick Fill buttons */}
            <button
              type="button"
              onClick={handleSetZeroAll}
              disabled={isTableLocked}
              className={`px-3 py-2 rounded-xl border text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed border-slate-200 hover:bg-slate-200 text-rose-600 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-rose-400`}
              title="Zero out all physical counts for fresh manual stock count"
            >
              Zero All Counts
            </button>
          </div>
        </div>
      </div>

      {/* REDESIGNED AUDIT DATA TABLE */}
      <div
        className={`rounded-3xl border overflow-hidden bg-white border-slate-200 shadow-sm dark:bg-slate-900/60 dark:border-slate-800`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead
              className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-800/80 dark:border-slate-700 dark:text-slate-300`}
            >
              <tr>
                <th className="px-2.5 py-1.5">SKU / Barcode</th>
                <th className="px-2.5 py-1.5">Product Name & Category</th>
                <th className="px-2.5 py-1.5 text-right">Unit Cost</th>
                <th className="px-2.5 py-1.5 text-center">Book System Qty</th>
                <th className="px-2.5 py-1.5 text-center w-40">Physical Stock Count</th>
                <th className="px-2.5 py-1.5 text-center">Variance</th>
                <th className="px-2.5 py-1.5 text-right">Variance Value</th>
                <th className="px-2.5 py-1.5 min-w-[220px]">Reason for Discrepancy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-12 text-center text-slate-400">
                    No stock audit records match the current filter or search criteria.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const counted = typeof row.countedQty === 'number' ? row.countedQty : 0;
                  const variance = counted - row.bookQty;
                  const varianceVal = variance * row.unitCost;
                  const isCustomReason = row.varianceReason === 'Other / Custom Note...';

                  return (
                    <tr
                      key={row.productId}
                      className={`hover:bg-slate-100/60 dark:hover:bg-slate-800/40 transition-colors ${
                        variance !== 0
                          ? variance < 0
                            ? isDarkMode ? 'bg-rose-950/20' : 'bg-rose-500/5'
                            : isDarkMode ? 'bg-emerald-950/20' : 'bg-emerald-500/5'
                          : ''
                      }`}
                    >
                      {/* SKU & Barcode */}
                      <td className="p-2.5 font-mono font-medium">
                        <div className={`font-bold text-slate-900 dark:text-slate-100`}>{row.sku}</div>
                        <div className="text-[10px] text-slate-400">{row.barcode || '—'}</div>
                      </td>

                      {/* Product Name & Category */}
                      <td className="p-2.5">
                        <div className={`font-semibold flex items-center gap-1.5 text-slate-800 dark:text-slate-200`}>
                          <span>{row.productName}</span>
                          {row.requiresSerialTracking && (
                            <span className="px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-500 text-[9px] font-bold border border-indigo-500/20">
                              Serial/MAC
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400">{row.category}</div>
                      </td>

                      {/* Unit Cost */}
                      <td className={`p-2.5 text-right font-mono text-slate-600 dark:text-slate-400`}>
                        NPR {(row.unitCost ?? 0).toLocaleString()}
                      </td>

                      {/* Book System Qty */}
                      <td className={`p-2.5 text-center font-mono font-bold text-slate-700 dark:text-slate-300`}>
                        {isEffectiveBlindAudit && !isBlindRevealed ? (
                          <span className={`px-2 py-1 rounded text-[10px] font-bold border flex items-center justify-center gap-1 bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-800`}>
                            <Lock className={`h-3 w-3 text-amber-600 dark:text-amber-400`} />
                            <span>Hidden (Blind)</span>
                          </span>
                        ) : (
                          <>
                            <span className="text-sm">{row.bookQty}</span>{' '}
                            <span className="text-[10px] text-slate-400 font-normal">{row.unit}</span>
                          </>
                        )}
                      </td>

                      {/* Physical Stock Count Input */}
                      <td className="p-2.5 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleQuickAdjust(row.productId, -1)}
                            disabled={isTableLocked}
                            className={`p-1 rounded-lg border cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed border-slate-300 hover:bg-slate-200 text-slate-600 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-slate-300`}
                            title="Decrease Count (-1)"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <input
                            type="number"
                            min="0"
                            disabled={isTableLocked}
                            value={row.countedQty}
                            onChange={(e) => handleCountChange(row.productId, e.target.value)}
                            className={`w-18 text-center font-mono font-bold py-1.5 px-2 text-xs rounded-xl border focus:outline-none focus:ring-2 disabled:opacity-75 disabled:cursor-not-allowed ${
                              !isEffectiveBlindAudit || isBlindRevealed
                                ? variance < 0
                                  ? isDarkMode ? 'border-rose-400 bg-rose-950/50 text-rose-300 focus:ring-rose-400' : 'border-rose-400 bg-rose-50 text-rose-700 focus:ring-rose-400'
                                  : variance > 0
                                  ? isDarkMode ? 'border-emerald-400 bg-emerald-950/50 text-emerald-300 focus:ring-emerald-400' : 'border-emerald-400 bg-emerald-50 text-emerald-700 focus:ring-emerald-400'
                                  : isDarkMode ? 'border-slate-700 bg-slate-900 text-slate-100 focus:ring-indigo-500' : 'border-slate-300 bg-slate-50 text-slate-900 focus:ring-indigo-500'
                                : isDarkMode ? 'border-indigo-400 bg-indigo-950/40 text-indigo-100 focus:ring-indigo-500' : 'border-indigo-400 bg-indigo-50/60 text-indigo-950 focus:ring-indigo-500'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => handleQuickAdjust(row.productId, 1)}
                            disabled={isTableLocked}
                            className={`p-1 rounded-lg border cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed border-slate-300 hover:bg-slate-200 text-slate-600 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-slate-300`}
                            title="Increase Count (+1)"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>

                      {/* Variance Qty */}
                      <td className="p-2.5 text-center font-mono font-extrabold">
                        {isEffectiveBlindAudit && !isBlindRevealed ? (
                          <span className="text-[10px] text-slate-400 font-semibold italic">Unsealed on submit</span>
                        ) : variance === 0 ? (
                          <span className="inline-flex items-center gap-1 text-slate-400 font-medium">
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span>0</span>
                          </span>
                        ) : variance < 0 ? (
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-800`}>
                            <span>{variance}</span>
                          </span>
                        ) : (
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/80 dark:text-emerald-300 dark:border-emerald-800`}>
                            <span>+{variance}</span>
                          </span>
                        )}
                      </td>

                      {/* Variance Value */}
                      <td
                        className={`p-3.5 text-right font-mono font-bold ${
                          isEffectiveBlindAudit && !isBlindRevealed
                            ? 'text-slate-400 font-normal italic'
                            : variance < 0
                            ? `text-rose-600 dark:text-rose-400`
                            : variance > 0
                            ? `text-emerald-600 dark:text-emerald-400`
                            : 'text-slate-400 font-normal'
                        }`}
                      >
                        {isEffectiveBlindAudit && !isBlindRevealed
                          ? '🔒 Hidden'
                          : varianceVal === 0
                          ? 'NPR 0'
                          : `${varianceVal > 0 ? '+' : ''}NPR ${(varianceVal ?? 0).toLocaleString()}`}
                      </td>

                      {/* Discrepancy Reason Input & Selection */}
                      <td className="p-2.5 space-y-1">
                        <select
                          value={row.varianceReason}
                          onChange={(e) => handleReasonChange(row.productId, e.target.value)}
                          disabled={variance === 0 || isTableLocked}
                          className={`w-full py-1.5 px-2.5 text-xs rounded-xl border focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed ${
                            variance === 0
                              ? `border-transparent text-slate-400 opacity-60 cursor-not-allowed bg-slate-50 dark:bg-slate-800`
                              : 'bg-slate-50 border-slate-300 text-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200'
                          }`}
                        >
                          <option value="Verified Matched">Verified Matched</option>
                          <option value="Shrinkage / Missing Stock">Shrinkage / Missing Stock</option>
                          <option value="Damaged Stock Discarded">Damaged Stock Discarded</option>
                          <option value="Unrecorded Return / Surplus">Unrecorded Return / Surplus</option>
                          <option value="Customer Device Return Unbooked">Customer Device Return Unbooked</option>
                          <option value="Data Entry Miscount">Data Entry Miscount</option>
                          <option value="Misplaced Location">Misplaced Location</option>
                          <option value="Other / Custom Note...">Other / Custom Note...</option>
                        </select>

                        {/* Custom Reason Field if Other / Custom Note is selected */}
                        {isCustomReason && variance !== 0 && (
                          <input
                            type="text"
                            placeholder="Enter specific discrepancy reason..."
                            disabled={isTableLocked}
                            value={row.customReason || ''}
                            onChange={(e) => handleCustomReasonChange(row.productId, e.target.value)}
                            className={`w-full py-1 px-2 text-[11px] rounded-lg border bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 border-indigo-300 text-slate-800 dark:border-indigo-700 dark:bg-slate-800 dark:text-slate-200`}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {/* VIEW MODE 2: MULTI-BRANCH CONSOLIDATED AUDIT MATRIX & APPROVER VIEW */}
      {activeAuditTab === 'CONSOLIDATED_MATRIX' && (
        <div className="space-y-3">
          {/* Executive Approver Summary Banner */}
          {visiblePendingAuditRequests.length > 0 ? (
            <div className={`p-5 rounded-3xl border-2 bg-amber-500/10 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-lg border-amber-400 text-amber-950 dark:border-amber-600 dark:text-amber-100`}>
              <div className="flex items-start gap-3">
                <div className="p-3 rounded-2xl bg-amber-500 text-slate-950 font-bold shrink-0">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base flex items-center gap-2">
                    <span>{visiblePendingAuditRequests.length} Branch Stock Audit Submissions Awaiting Authorization</span>
                    <span className="px-2 py-0.5 rounded-full bg-amber-400 text-slate-950 text-[10px] font-mono font-black">
                      ACTION REQUIRED
                    </span>
                  </h3>
                  <p className={`text-xs mt-1 text-amber-900/80 dark:text-amber-200/90`}>
                    Branch floor staff have completed stock counts and submitted audit reports. As an authorized approver, you can unseal system book balances, review variances, and approve stock reconciliation.
                  </p>

                  {/* List of Pending Branch Submissions */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {visiblePendingAuditRequests.map((req) => (
                      <div
                        key={req.id}
                        className={`px-3 py-1.5 rounded-xl border text-xs flex items-center gap-2 shadow-xs bg-white border-amber-300 dark:bg-slate-900 dark:border-amber-800`}
                      >
                        <Building className={`h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400`} />
                        <span className={`font-bold text-slate-800 dark:text-slate-200`}>
                          {req.branchName}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">
                          #{req.auditData?.auditRefNumber || 'AUD-REQ'}
                        </span>
                        {isManagerOrAdmin && (
                          <button
                            type="button"
                            onClick={() =>
                              handleApproveSinglePendingBranch(
                                req.id,
                                req.branchName || branches.find((b) => b.id === req.branchId)?.name || 'Head Office'
                              )
                            }
                            className="px-2 py-0.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold cursor-pointer transition-colors"
                          >
                            Approve
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {isManagerOrAdmin && (
                <button
                  type="button"
                  onClick={handleApproveAllPendingAudits}
                  disabled={isSubmitting}
                  className="px-5 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs shadow-lg shrink-0 flex items-center gap-2 cursor-pointer active:scale-95 transition-all disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Authorize & Reconcile All ({visiblePendingAuditRequests.length}) Audits</span>
                </button>
              )}
            </div>
          ) : (
            <div className={`p-4 rounded-2xl border bg-emerald-50/70 flex items-center justify-between gap-3 text-xs border-emerald-300 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200`}>
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className={`h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400`} />
                <span>
                  <strong>Branch Stock Audits Up to Date:</strong> No pending stock reconciliation requests. Stock records are currently synchronized with physical ledger counts.
                </span>
              </div>
            </div>
          )}

          {/* Consolidated Matrix Toolbar */}
          <div className={`p-3 rounded-2xl border flex flex-col md:flex-row items-center justify-start gap-3 bg-white border-slate-200 shadow-xs dark:bg-slate-900/60 dark:border-slate-800`}>
            <div className="relative w-full md:w-80 lg:w-96 shrink-0 ">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search matrix by SKU, Product Name, or Category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={`w-full pl-9 pr-4 py-2 rounded-xl text-xs border focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-200`}
              />
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className={`px-3 py-2 rounded-xl border text-xs font-semibold focus:outline-none cursor-pointer bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200`}
              >
                <option value="ALL">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleExportBranchCSV}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 text-slate-700 dark:border-slate-700 dark:hover:bg-slate-800 dark:text-slate-300`}
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-500" />
                <span>Export Full Company Matrix CSV</span>
              </button>
            </div>
          </div>

          {/* Consolidated Matrix Table */}
          <div className={`rounded-3xl border overflow-hidden bg-white border-slate-200 shadow-sm dark:bg-slate-900/60 dark:border-slate-800`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className={`font-bold text-[10px] tracking-wider border-b bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-800/90 dark:border-slate-700 dark:text-slate-300`}>
                  <tr>
                    <th className={`px-2.5 py-1.5 sticky left-0 z-20 min-w-[180px] bg-slate-100 dark:bg-slate-800`}>Product / SKU</th>
                    <th className="px-2.5 py-1.5 text-right">Cost Price (NPR)</th>
                    {visibleBranches.map((b) => {
                      const hasPending = approvalRequests.some(
                        (r) => r.type === 'STOCK_AUDIT_RECONCILIATION' && r.branchId === b.id && r.status === 'PENDING'
                      );
                      return (
                        <th key={b.id} className={`px-2.5 py-1.5 text-center min-w-[110px] border-l border-slate-200 dark:border-slate-700`}>
                          <div className="flex items-center justify-center gap-1 font-bold">
                            <span>{b.code}</span>
                            {hasPending && (
                              <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" title="Pending Approval" />
                            )}
                          </div>
                          <div className={`text-[9px] font-normal truncate max-w-[90px] text-slate-500 dark:text-slate-400`}>{b.name}</div>
                        </th>
                      );
                    })}
                    <th className={`px-2.5 py-1.5 text-center border-l-2 font-extrabold border-indigo-200 bg-indigo-50/60 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300`}>
                      Co. Total Book
                    </th>
                    <th className={`px-2.5 py-1.5 text-center font-extrabold bg-indigo-50/60 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300`}>
                      Co. Total Counted
                    </th>
                    <th className={`px-2.5 py-1.5 text-center font-extrabold bg-indigo-50/60 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300`}>
                      Net Variance
                    </th>
                    <th className={`px-2.5 py-1.5 text-right font-extrabold bg-indigo-50/60 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300`}>
                      Net NPR Impact
                    </th>
                  </tr>
                </thead>
                <tbody className={`divide-y font-mono divide-slate-200 dark:divide-slate-700`}>
                  {consolidatedMatrix
                    .filter((row) => {
                      const q = searchQuery.toLowerCase().trim();
                      const matchSearch = !q || row.productName.toLowerCase().includes(q) || row.sku.toLowerCase().includes(q);
                      const matchCat = selectedCategory === 'ALL' || row.category === selectedCategory;
                      return matchSearch && matchCat;
                    })
                    .map((row) => (
                      <tr key={row.productId} className={`transition-colors hover:bg-slate-100/60 dark:hover:bg-slate-800/40`}>
                        <td className={`p-2.5 font-sans sticky left-0 z-10 border-r bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-700`}>
                          <div className={`font-bold text-xs text-slate-900 dark:text-slate-100`}>{row.productName}</div>
                          <div className={`text-[10px] font-mono text-slate-400 dark:text-slate-400`}>{row.sku}</div>
                        </td>
                        <td className={`p-2.5 text-right text-slate-600 dark:text-slate-400`}>
                          NPR {(row.unitCost || 0).toLocaleString()}
                          NPR {(row.unitCost || 0).toLocaleString()}
                        </td>
                        {row.branches.map((b) => (
                          <td key={b.branchId} className={`p-2.5 text-center border-l border-slate-200 dark:border-slate-700`}>
                            <div className={`font-bold text-slate-800 dark:text-slate-200`}>{b.countedQty}</div>
                            <div className={`text-[10px] font-normal text-slate-400 dark:text-slate-500`}>Bk: {b.bookQty}</div>
                            {b.variance !== 0 && (
                              <div className={`text-[10px] font-black ${b.variance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {b.variance > 0 ? `+${b.variance}` : b.variance}
                              </div>
                            )}
                          </td>
                        ))}
                        <td className={`p-2.5 text-center font-bold border-l-2 border-indigo-200 bg-indigo-50/20 text-slate-800 dark:border-indigo-800 dark:bg-indigo-950/20 dark:text-indigo-200`}>
                          {row.companyTotalBookQty}
                        </td>
                        <td className={`p-2.5 text-center font-bold bg-indigo-50/20 text-slate-900 dark:bg-indigo-950/20 dark:text-indigo-100`}>
                          {row.companyTotalCountedQty}
                        </td>
                        <td className={`p-2.5 text-center font-extrabold bg-indigo-50/20 dark:bg-indigo-950/20 ${
                          row.companyTotalVarianceQty < 0 ? 'text-rose-600 dark:text-rose-400' : row.companyTotalVarianceQty > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
                        }`}>
                          {row.companyTotalVarianceQty > 0 ? `+${row.companyTotalVarianceQty}` : row.companyTotalVarianceQty}
                        </td>
                        <td className={`p-2.5 text-right font-extrabold bg-indigo-50/20 dark:bg-indigo-950/20 ${
                          row.totalVarianceVal < 0 ? 'text-rose-600 dark:text-rose-400' : row.totalVarianceVal > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
                        }`}>
                          {row.totalVarianceVal === 0 ? 'NPR 0' : `${row.totalVarianceVal > 0 ? '+' : ''}NPR ${row.totalVarianceVal.toLocaleString()}`}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 1: SUBMIT STOCK AUDIT FOR APPROVAL (Workflow: Count Stock > Send Request for approval) */}
      {showApprovalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
          <div
            className={`w-full max-w-2xl rounded-3xl p-6 border shadow-2xl space-y-5 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}
          >
            <div className={`flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3`}>
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-indigo-600 text-white">
                  <Send className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base">Submit Physical Stock Audit for Authorization</h3>
                  <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                    Location: <strong>{activeBranch?.name}</strong> • Batch <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-400`}>#{auditRefNumber}</span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowApprovalModal(false)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className={`p-3 rounded-2xl border text-xs flex items-start gap-2.5 bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-300`}>
              <Lock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>Important:</strong> Submitting this stock audit will create an official request in the <strong>Workflow Approval Center</strong> and <strong>LOCK</strong> this branch's stock count table until authorized by the Super Admin or Stock Manager.
              </span>
            </div>

            {/* Audit Summary Grid */}
            <div className="grid grid-cols-3 gap-3">
              <div className={`p-3 rounded-2xl border text-xs bg-slate-50 dark:bg-slate-800/60`}>
                <span className="text-[10px] uppercase font-bold text-slate-400 block">Total Audited</span>
                <span className={`font-extrabold text-base text-slate-800 dark:text-slate-200`}>{stats.totalItems} SKUs</span>
                <span className="text-[10px] text-slate-400 block">Discrepancies: {stats.discrepancyCount}</span>
              </div>
              <div className={`p-3 rounded-2xl border text-xs bg-rose-50 border-rose-200 dark:bg-rose-950/30 dark:border-rose-900/40`}>
                <span className={`text-[10px] uppercase font-bold block text-rose-500 dark:text-rose-400`}>Shortages (-)</span>
                <span className={`font-extrabold text-base font-mono text-rose-600 dark:text-rose-400`}>-{(stats.shortageQty ?? 0)} Units</span>
                <span className={`text-[10px] block font-mono text-rose-500 dark:text-rose-500`}>-NPR {(stats.shortageValue ?? 0).toLocaleString()}</span>
              </div>
              <div className={`p-3 rounded-2xl border text-xs bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/40`}>
                <span className={`text-[10px] uppercase font-bold block text-emerald-500 dark:text-emerald-400`}>Excess (+)</span>
                <span className={`font-extrabold text-base font-mono text-emerald-600 dark:text-emerald-400`}>+{(stats.excessQty ?? 0)} Units</span>
                <span className={`text-[10px] block font-mono text-emerald-500 dark:text-emerald-500`}>+NPR {(stats.excessValue ?? 0).toLocaleString()}</span>
              </div>
            </div>

            {/* Discrepancy Breakdown Table */}
            <div className={`rounded-2xl overflow-hidden max-h-48 overflow-y-auto border-slate-200 dark:border-slate-800`}>
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] font-bold bg-slate-100 text-slate-600 dark:bg-slate-800/80 dark:text-slate-400`}>
                  <tr>
                    <th className="px-2.5 py-1.5">SKU / Item</th>
                    <th className="px-2.5 py-1.5 text-center">Book</th>
                    <th className="px-2.5 py-1.5 text-center">Count</th>
                    <th className="px-2.5 py-1.5 text-center">Variance</th>
                    <th className="px-2.5 py-1.5 text-right">Value (NPR)</th>
                    <th className="px-2.5 py-1.5">Reason for Discrepancy</th>
                  </tr>
                </thead>
                <tbody className={`divide-y font-mono divide-slate-200 dark:divide-slate-800`}>
                  {stats.discrepancyRows.map((r) => {
                    const c = typeof r.countedQty === 'number' ? r.countedQty : 0;
                    const delta = c - r.bookQty;
                    const val = delta * r.unitCost;
                    const reason = r.varianceReason === 'Other / Custom Note...' && r.customReason
                      ? r.customReason
                      : r.varianceReason;

                    return (
                      <tr key={r.productId}>
                        <td className="p-2.5 font-sans">
                          <div className={`font-bold font-mono text-slate-900 dark:text-slate-100`}>{r.sku}</div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[140px]">{r.productName}</div>
                        </td>
                        <td className={`p-2.5 text-center text-slate-600 dark:text-slate-400`}>{r.bookQty}</td>
                        <td className={`p-2.5 text-center font-bold text-slate-900 dark:text-slate-100`}>{c}</td>
                        <td
                          className={`p-2.5 text-center font-extrabold ${
                            (delta < 0 ? 'text-emerald-400 dark:text-rose-400' : 'text-emerald-500 dark:text-rose-500')
                          }`}
                        >
                          {delta > 0 ? `+${delta}` : delta}
                        </td>
                        <td
                          className={`p-2.5 text-right font-bold ${
                            (val < 0 ? 'text-emerald-400 dark:text-rose-400' : 'text-emerald-500 dark:text-rose-500')
                          }`}
                        >
                          {(val ?? 0).toLocaleString()}
                        </td>
                        <td className={`p-2.5 text-[11px] font-sans truncate max-w-[150px] text-slate-600 dark:text-slate-300`}>
                          {reason}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Notes / Reason for Approver */}
            <div className="space-y-1.5">
              <label className={`text-xs font-bold block text-slate-700 dark:text-slate-300`}>
                Auditor Statement & Notes for Super Admin / Stock Manager:
              </label>
              <textarea
                rows={2}
                value={approvalNotes}
                onChange={(e) => setApprovalNotes(e.target.value)}
                placeholder="e.g. Completed periodic physical stock verification. Minor shrinkage in patch cables; router CPE models matched ledger perfectly."
                className={`w-full text-xs rounded-xl border p-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
              />
            </div>

            <div className={`flex items-center justify-between p-3 rounded-2xl border text-xs font-semibold bg-indigo-50 border-indigo-200 text-indigo-900 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-200`}>
              <span>Net Financial Impact:</span>
              <span className="font-extrabold font-mono text-sm">
                {stats.netValueVariance >= 0 ? '+' : ''}NPR {(stats.netValueVariance ?? 0).toLocaleString()}
              </span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowApprovalModal(false)}
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmitForApproval}
                disabled={isSubmitting}
                className="px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Submitting & Locking Table...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    <span>Submit & Lock Stock Count</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: DEDICATED APPROVE AND RECONCILE CONFIRMATION (For Super Admin / Stock Manager) */}
      {showApproveReconcileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
          <div
            className={`w-full max-w-2xl rounded-3xl p-6 border shadow-2xl space-y-5 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}
          >
            <div className={`flex items-center justify-between pb-3 border-b border-slate-200 dark:border-b dark:border-slate-800`}>
              <div className="flex items-center gap-2.5">
                <div className="p-2.5 rounded-2xl bg-emerald-600 text-white shadow-md">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div>
                  <h3 className={`font-extrabold text-base text-slate-900 dark:text-slate-100`}>
                    Approve & Reconcile Physical Stock
                  </h3>
                  <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                    Audit Batch <span className={`font-mono font-bold text-purple-600 dark:text-purple-400`}>#{pendingAuditRequest?.auditData?.auditRefNumber || auditRefNumber}</span> for <strong>{activeBranch?.name}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowApproveReconcileModal(false)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className={`p-3.5 rounded-2xl border text-xs space-y-1 bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-200`}>
              <p className="font-bold flex items-center gap-1.5">
                <ShieldCheck className={`h-4 w-4 text-emerald-600 dark:text-emerald-400`} />
                <span>Executive Stock Adjustment Authorization</span>
              </p>
              <p className="leading-relaxed">
                Confirming authorization will {pendingAuditRequest ? `approve Approval Request #${pendingAuditRequest.requestNumber} and ` : ''}adjust branch inventory on-hand balances for all <strong>{stats.discrepancyCount} discrepancy SKUs</strong> to the physical counts, unlock the audit table, and write official transaction records to the permanent audit trail.
              </p>
            </div>

            {/* List of items to be adjusted */}
            <div className={`rounded-2xl overflow-hidden max-h-52 overflow-y-auto border-slate-200 dark:border-slate-800`}>
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] font-bold bg-slate-100 text-slate-600 dark:bg-slate-800/80 dark:text-slate-400`}>
                  <tr>
                    <th className="px-2.5 py-1.5">SKU / Item</th>
                    <th className="px-2.5 py-1.5 text-center">System Book</th>
                    <th className="px-2.5 py-1.5 text-center">Audited Count</th>
                    <th className="px-2.5 py-1.5 text-center">Stock Adjustment</th>
                    <th className="px-2.5 py-1.5 text-right">Net Impact (NPR)</th>
                  </tr>
                </thead>
                <tbody className={`divide-y font-mono divide-slate-200 dark:divide-slate-800`}>
                  {stats.discrepancyRows.map((r) => {
                    const c = typeof r.countedQty === 'number' ? r.countedQty : 0;
                    const delta = c - r.bookQty;
                    const val = delta * r.unitCost;

                    return (
                      <tr key={r.productId}>
                        <td className="p-2.5 font-sans">
                          <div className={`font-bold font-mono text-slate-900 dark:text-slate-100`}>{r.sku}</div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[150px]">{r.productName}</div>
                        </td>
                        <td className={`p-2.5 text-center text-slate-600 dark:text-slate-400`}>{r.bookQty}</td>
                        <td className={`p-2.5 text-center font-bold text-slate-900 dark:text-slate-100`}>{c}</td>
                        <td
                          className={`p-2.5 text-center font-extrabold ${
                            (delta < 0 ? 'text-emerald-400 dark:text-rose-400' : 'text-emerald-500 dark:text-rose-500')
                          }`}
                        >
                          {delta > 0 ? `+${delta} (EXCESS)` : `${delta} (SHORTAGE)`}
                        </td>
                        <td
                          className={`p-2.5 text-right font-bold ${
                            (val < 0 ? 'text-emerald-400 dark:text-rose-400' : 'text-emerald-500 dark:text-rose-500')
                          }`}
                        >
                          {(val ?? 0).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className={`flex items-center justify-between p-3 rounded-2xl text-xs font-semibold bg-slate-100 dark:bg-slate-800`}>
              <span>Total Financial Adjustment:</span>
              <span className={`font-extrabold font-mono text-sm text-slate-900 dark:text-slate-100`}>
                {stats.netValueVariance >= 0 ? '+' : ''}NPR {(stats.netValueVariance ?? 0).toLocaleString()}
              </span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowApproveReconcileModal(false)}
                disabled={isSubmitting}
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={pendingAuditRequest ? handleApproveAndReconcile : handleDirectReconcile}
                disabled={isSubmitting}
                className="px-5 py-2.5 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-600/30 transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Executing Reconciliation...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Confirm Approve & Reconcile</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: REJECT AUDIT REQUEST MODAL */}
      {showRejectModal && pendingAuditRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
          <div
            className={`w-full max-w-md rounded-3xl p-6 border shadow-2xl space-y-4 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}
          >
            <div className="flex items-center gap-2.5 text-rose-600 font-extrabold text-base">
              <XCircle className="h-5 w-5" />
              <span>Reject Stock Audit Request</span>
            </div>

            <p className={`text-xs leading-relaxed text-slate-600 dark:text-slate-300`}>
              Rejecting this request will unlock the stock count table for <strong>{activeBranch?.name}</strong> so that branch staff can perform a recount.
            </p>

            <div className="space-y-1.5">
              <label className={`text-xs font-bold block text-slate-700 dark:text-slate-300`}>
                Reason for Rejection / Recount Instructions:
              </label>
              <textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Discrepancies exceed threshold; please recount warehouse bay 2 and verify unboxed returns before re-submitting."
                className={`w-full text-xs rounded-xl border p-2.5 focus:outline-none focus:ring-2 focus:ring-rose-500 border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200`}
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setShowRejectModal(false)}
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRejectAudit}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 shadow-md cursor-pointer disabled:opacity-50"
              >
                {isSubmitting ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: DIRECT RECONCILE (ADMIN DIRECT OVERRIDE) */}
      {showDirectReconcileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
          <div
            className={`w-full max-w-xl rounded-3xl p-6 border shadow-2xl space-y-5 bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}
          >
            <div className={`flex items-center justify-between pb-3 border-b border-slate-200 dark:border-b dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-500" />
                <h3 className="font-bold text-base">Direct Stock Reconcile (Admin Direct Override)</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowDirectReconcileModal(false)}
                className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className={`text-xs text-slate-500 dark:text-slate-400`}>
              As an Administrator, you can directly post stock adjustments for batch <strong className="text-indigo-500 font-mono">{auditRefNumber}</strong> at <strong>{activeBranch?.name}</strong>.
              This will update on-hand stock quantities immediately.
            </p>

            <div className={`flex items-center justify-between p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-300`}>
              <span>Total Discrepancies: <strong>{stats.discrepancyCount} items</strong></span>
              <span>Net Financial Impact: <strong>NPR {(stats.netValueVariance ?? 0).toLocaleString()}</strong></span>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowDirectReconcileModal(false)}
                className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDirectReconcile}
                disabled={isSubmitting}
                className="px-5 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md transition-all cursor-pointer flex items-center gap-1.5"
              >
                {isSubmitting ? (
                  <span>Posting Stock Adjustments...</span>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    <span>Authorize & Update Balances</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: CONSOLIDATED MULTI-BRANCH STOCK AUDIT REPORT MATRIX */}
      {showConsolidatedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
          <div
            className={`w-full max-w-6xl max-h-[90vh] flex flex-col rounded-3xl border shadow-2xl overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100`}
          >
            {/* Modal Header */}
            <div className={`p-5 flex items-center justify-between gap-4 shrink-0 border-b border-slate-200 dark:border-b dark:border-slate-800`}>
              <div className="flex items-center gap-2.5">
                <div className={`p-2.5 rounded-2xl border bg-indigo-600/10 text-indigo-600 border-indigo-500/20 dark:bg-indigo-600/20 dark:text-indigo-400 dark:border-indigo-500/30`}>
                  <TableProperties className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base flex items-center gap-2">
                    <span>Consolidated Multi-Branch Stock Audit Report</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300`}>
                      ALL BRANCHES MATRIX
                    </span>
                  </h3>
                  <p className={`text-xs text-slate-500 dark:text-slate-400`}>
                    Comprehensive cross-location physical stock count vs. system ledger comparison across all branches.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportConsolidatedCSV}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  <span>Export Consolidated CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowConsolidatedModal(false)}
                  className="p-2 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Consolidated High-level Metrics */}
            <div className={`p-4 border-b grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0 bg-slate-50 border-slate-200 dark:bg-slate-800/40 dark:border-slate-800`}>
              <div className={`p-3 rounded-2xl border text-xs bg-white dark:bg-slate-900`}>
                <span className="text-[10px] font-bold text-slate-400 uppercase block">Company Book Stock</span>
                <span className={`text-lg font-extrabold font-mono text-slate-900 dark:text-slate-100`}>
                  {(consolidatedSummary.totalBook ?? 0).toLocaleString()} Units
                </span>
              </div>
              <div className={`p-3 rounded-2xl border text-xs bg-white dark:bg-slate-900`}>
                <span className="text-[10px] font-bold text-slate-400 uppercase block">Physical Counted Stock</span>
                <span className={`text-lg font-extrabold font-mono text-indigo-600 dark:text-indigo-400`}>
                  {(consolidatedSummary.totalCounted ?? 0).toLocaleString()} Units
                </span>
              </div>
              <div className={`p-3 rounded-2xl border text-xs bg-rose-50 border-rose-200 dark:bg-rose-950/30 dark:border-rose-900/50`}>
                <span className={`text-[10px] font-bold uppercase block text-rose-500 dark:text-rose-400`}>Consolidated Shortage</span>
                <span className={`text-lg font-extrabold font-mono text-rose-600 dark:text-rose-400`}>
                  -{(consolidatedSummary.totalShortage ?? 0).toLocaleString()} Units
                </span>
                <span className={`text-[10px] font-mono block text-rose-500 dark:text-rose-500`}>-NPR {(consolidatedSummary.totalShortageVal ?? 0).toLocaleString()}</span>
              </div>
              <div className={`p-3 rounded-2xl border text-xs bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/50`}>
                <span className={`text-[10px] font-bold uppercase block text-emerald-500 dark:text-emerald-400`}>Consolidated Excess</span>
                <span className={`text-lg font-extrabold font-mono text-emerald-600 dark:text-emerald-400`}>
                  +{(consolidatedSummary.totalExcess ?? 0).toLocaleString()} Units
                </span>
                <span className={`text-[10px] font-mono block text-emerald-500 dark:text-emerald-500`}>+NPR {(consolidatedSummary.totalExcessVal ?? 0).toLocaleString()}</span>
              </div>
            </div>

            {/* Consolidated Matrix Table */}
            <div className="flex-1 overflow-auto p-4">
              <table className="w-full text-left text-xs border-collapse">
                <thead className={`sticky top-0 text-[10px] font-bold border-b z-10 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300`}>
                  <tr>
                    <th className={`px-2.5 py-1.5 border-r border-slate-200 dark:border-slate-700`}>SKU / Item</th>
                    <th className={`px-2.5 py-1.5 text-right border-r border-slate-200 dark:border-slate-700`}>Cost</th>
                    {branches.map((b) => (
                      <th
                        key={b.id}
                        colSpan={3}
                        className={`p-2 text-center border-r font-extrabold border-slate-200 bg-indigo-50/50 dark:border-slate-700 dark:bg-indigo-950/30`}
                      >
                        {b.name} ({b.code})
                      </th>
                    ))}
                    <th className="px-2.5 py-1.5 text-center font-extrabold">Company Book</th>
                    <th className="px-2.5 py-1.5 text-center font-extrabold">Company Physical</th>
                    <th className="px-2.5 py-1.5 text-center font-extrabold">Net Variance</th>
                    <th className="px-2.5 py-1.5 text-right font-extrabold">Net Value (NPR)</th>
                  </tr>
                  <tr className={`text-[9px] bg-slate-200/70 text-slate-500 dark:bg-slate-800/90 dark:text-slate-400`}>
                    <th className={`p-1 border-r border-slate-200 dark:border-slate-700`} />
                    <th className={`p-1 border-r border-slate-200 dark:border-slate-700`} />
                    {branches.map((b) => (
                      <React.Fragment key={`sub-${b.id}`}>
                        <th className="p-1 text-center font-normal">Book</th>
                        <th className="p-1 text-center font-normal">Count</th>
                        <th className={`p-1 text-center font-normal border-r border-slate-200 dark:border-slate-700`}>Diff</th>
                      </React.Fragment>
                    ))}
                    <th className="p-1 text-center" />
                    <th className="p-1 text-center" />
                    <th className="p-1 text-center" />
                    <th className="p-1 text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono">
                  {consolidatedMatrix.map((item) => {
                    return (
                      <tr
                        key={item.productId}
                        className={`hover:bg-slate-100/60 dark:hover:bg-slate-800/40 ${
                          item.companyTotalVarianceQty !== 0
                            ? item.companyTotalVarianceQty < 0
                              ? 'bg-rose-500/5'
                              : 'bg-emerald-500/5'
                            : ''
                        }`}
                      >
                        {/* SKU & Name */}
                        <td className={`p-2.5 border-r font-sans border-slate-200 dark:border-slate-700`}>
                          <div className={`font-bold font-mono text-slate-900 dark:text-slate-100`}>{item.sku}</div>
                          <div className="text-[11px] text-slate-500 truncate max-w-[160px]">{item.productName}</div>
                        </td>

                        {/* Unit Cost */}
                        <td className={`p-2.5 text-right border-r border-slate-200 dark:border-slate-700`}>
                          {(item.unitCost ?? 0).toLocaleString()}
                        </td>

                        {/* Branch by Branch Columns */}
                        {item.branches.map((b) => (
                          <React.Fragment key={`cell-${b.branchId}`}>
                            <td className={`p-1 text-center text-slate-600 dark:text-slate-400`}>{b.bookQty}</td>
                            <td className={`p-1 text-center font-bold text-slate-900 dark:text-slate-100`}>{b.countedQty}</td>
                            <td
                              className={`p-1 text-center font-extrabold border-r border-slate-200 dark:border-slate-700 'b.variance === 0
                                  ? isDarkMode ? 'text-slate-600' : 'text-slate-300'
                                  : b.variance < 0 ? text-rose-500 dark:text-rose-400 : text-emerald-500 dark:text-emerald-400'`}
                            >
                              {b.variance > 0 ? `+${b.variance}` : b.variance}
                            </td>
                          </React.Fragment>
                        ))}

                        {/* Company Total Book */}
                        <td className={`p-2.5 text-center font-bold text-slate-700 dark:text-slate-300`}>
                          {item.companyTotalBookQty}
                        </td>

                        {/* Company Total Physical Counted */}
                        <td className={`p-2.5 text-center font-bold text-indigo-600 dark:text-indigo-400`}>
                          {item.companyTotalCountedQty}
                        </td>

                        {/* Net Variance Qty */}
                        <td
                          className={`p-2.5 text-center font-extrabold 'item.companyTotalVarianceQty === 0
                              ? isDarkMode ? 'text-slate-500' : 'text-slate-300'
                              : item.companyTotalVarianceQty < 0 ? text-rose-500 dark:text-rose-400 : text-emerald-500 dark:text-emerald-400'`}
                        >
                          {item.companyTotalVarianceQty > 0 ? `+${item.companyTotalVarianceQty}` : item.companyTotalVarianceQty}
                        </td>

                        {/* Net Variance Value */}
                        <td
                          className={`p-2.5 text-right font-bold 'item.totalVarianceVal === 0
                              ? isDarkMode ? 'text-slate-500' : 'text-slate-400'
                              : item.totalVarianceVal < 0 ? text-rose-500 dark:text-rose-400 : text-emerald-500 dark:text-emerald-400'`}
                        >
                          {(item.totalVarianceVal ?? 0).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Modal Footer */}
            <div className={`p-4 border-t flex items-center justify-between shrink-0 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-700`}>
              <div className="text-xs text-slate-500">
                <span>Total Catalog Items: <strong>{products.length}</strong></span> • <span>Locations: <strong>{branches.length} Branches</strong></span>
              </div>
              <button
                type="button"
                onClick={() => setShowConsolidatedModal(false)}
                className={`px-5 py-2 rounded-xl text-xs font-bold cursor-pointer bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900`}
              >
                Close Matrix View
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
