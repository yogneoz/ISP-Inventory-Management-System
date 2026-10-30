/**
 * One source of truth for the shell's actionable notifications.
 *
 * The header bell, the Notification Center and Clear All used to derive their
 * own counts. The bell summed low stock + approvals + shipments while the
 * drawer also listed purchase orders, and the bell ignored the shared dismissed
 * ids — so the two numbers disagreed (UIX-4). Building the alert list once in
 * AppShell means every surface reads the same objects and the same ids.
 */
import type {
  ApprovalRequest,
  Branch,
  InventoryStock,
  Product,
  PurchaseOrder,
  Shipment,
} from '../types';
import { formatNPR } from './nprFormat';
import { indexStockByProductBranch, stockRowAt } from './stockIndex';
import { BS_SEEDING_MENU_PATH, type BsCalendarCoverageStatus } from './nepaliCalendar';

export type NotificationAlertType = 'CALENDAR' | 'REORDER' | 'APPROVAL' | 'SHIPMENT' | 'PO';
export type NotificationSeverity = 'CRITICAL' | 'WARNING' | 'HIGH' | 'INFO';

export interface NotificationAlert {
  id: string;
  type: NotificationAlertType;
  title: string;
  subtitle: string;
  branchName: string;
  date: string;
  severity: NotificationSeverity;
  actionLabel: string;
  actionTab: string;
}

export interface NotificationAlertInput {
  products: Product[];
  stock: InventoryStock[];
  approvalRequests: ApprovalRequest[];
  /** Scoped open POs loaded for the KPI surfaces — not the whole bootstrap slice. */
  pendingPurchaseOrders: PurchaseOrder[];
  shipments: Shipment[];
  branches: Branch[];
  selectedBranchId: string;
  dismissedIds?: string[];
  /** BS calendar coverage countdown; omitted/null while coverage is healthy. */
  bsCalendarCoverage?: BsCalendarCoverageStatus | null;
  /** Tab that seeds the calendar for this user's role. */
  bsCalendarSeedTab?: string;
}

export function buildNotificationAlerts({
  products,
  stock,
  approvalRequests,
  pendingPurchaseOrders,
  shipments,
  branches,
  selectedBranchId,
  dismissedIds = [],
  bsCalendarCoverage = null,
  bsCalendarSeedTab = 'bs-calendar',
}: NotificationAlertInput): NotificationAlert[] {
  // STOCK-1: one index per stock array; the alert derivation below is
  // products × branches, so scanning the array per pair would be quadratic.
  const stockIndex = indexStockByProductBranch(stock);

  const lowStockAlerts: NotificationAlert[] = [];
  const activeBr =
    selectedBranchId === 'ALL' ? branches : branches.filter((b) => b.id === selectedBranchId);

  products.forEach((prod) => {
    let totalOnHand = 0;
    let totalConsolidatedReorder = 0;
    let totalDeficit = 0;
    const lowBranchNames: string[] = [];

    activeBr.forEach((b) => {
      const item = stockRowAt(stockIndex, prod.id, b.id);
      const onHand = item ? item.quantityOnHand : 0;
      totalOnHand += onHand;

      const threshold =
        item?.minReorderLevel !== undefined && item?.minReorderLevel !== null
          ? item.minReorderLevel
          : prod.minReorderLevel;
      totalConsolidatedReorder += threshold;

      if (threshold > 0 && onHand <= threshold) {
        lowBranchNames.push(b.name);
        totalDeficit += Math.max(1, threshold - onHand);
      } else if (threshold === 0 && onHand < 0) {
        lowBranchNames.push(b.name);
        totalDeficit += Math.abs(onHand);
      }
    });

    const isLow =
      lowBranchNames.length > 0 ||
      (totalConsolidatedReorder > 0 && totalOnHand <= totalConsolidatedReorder);

    if (isLow) {
      if (
        totalDeficit === 0 &&
        totalConsolidatedReorder > 0 &&
        totalOnHand <= totalConsolidatedReorder
      ) {
        totalDeficit = Math.max(1, totalConsolidatedReorder - totalOnHand);
      }

      const branchDisplay =
        lowBranchNames.length > 0
          ? lowBranchNames.join(', ')
          : selectedBranchId === 'ALL'
          ? 'Consolidated - All Branches'
          : branches.find((b) => b.id === selectedBranchId)?.name || 'Branch';

      lowStockAlerts.push({
        id: `lowstock-${prod.id}`,
        type: 'REORDER',
        title: `Low Stock: ${prod.name}`,
        subtitle: `Consolidated Stock: ${totalOnHand} ${prod.unit} | Deficit: ${totalDeficit} ${prod.unit} (Min Threshold: ${totalConsolidatedReorder || prod.minReorderLevel})`,
        branchName: branchDisplay,
        date: 'Action Required',
        severity: totalOnHand === 0 ? 'CRITICAL' : 'WARNING',
        actionLabel: 'Reorder / PO',
        actionTab: 'reorder-stock',
      });
    }
  });

  const approvalAlerts: NotificationAlert[] = approvalRequests
    .filter(
      (req) =>
        req.status === 'PENDING' &&
        (selectedBranchId === 'ALL' || req.branchId === selectedBranchId)
    )
    .map((req) => ({
      id: `appr-${req.id}`,
      type: 'APPROVAL',
      title: `Approval Request #${req.requestNumber}`,
      subtitle: `${req.customerName} (${req.deviceSerial}) → Change status to "${req.requestedStatus}"`,
      branchName: req.branchName || 'Branch',
      date: req.requestedAtAD,
      severity: 'HIGH',
      actionLabel: 'Review Request',
      actionTab: 'workflow-approval',
    }));

  const shipmentAlerts: NotificationAlert[] = shipments
    .filter(
      (sh) =>
        (sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED') &&
        (selectedBranchId === 'ALL' ||
          sh.destinationBranchId === selectedBranchId ||
          sh.sourceBranchId === selectedBranchId)
    )
    .map((sh) => ({
      id: `ship-${sh.id}`,
      type: 'SHIPMENT',
      title: `Shipment ${sh.status}: ${sh.trackingCode}`,
      subtitle: `${sh.sourceBranchName || 'Source'} → ${sh.destinationBranchName} (${sh.items?.length || 0} items)`,
      branchName: sh.destinationBranchName,
      date: sh.dispatchDateAD,
      severity: 'INFO',
      actionLabel: 'Track Shipment',
      actionTab: 'shipment-list',
    }));

  const poAlerts: NotificationAlert[] = pendingPurchaseOrders
    .filter(
      (po) =>
        (po.status === 'SENT' || po.status === 'APPROVED' || po.status === 'DRAFT') &&
        (selectedBranchId === 'ALL' || po.branchId === selectedBranchId)
    )
    .map((po) => ({
      id: `po-${po.id}`,
      type: 'PO',
      title: `Purchase Order #${po.poNumber} (${po.status})`,
      subtitle: `Supplier: ${po.supplierName} • Total: ${formatNPR(po.totalAmount ?? 0)}`,
      branchName: branches.find((b) => b.id === po.branchId)?.name || 'Branch',
      date: po.orderDateAD,
      severity: 'INFO',
      actionLabel: 'View Order',
      actionTab: 'po-list',
    }));

  // BS calendar coverage countdown. Ranked first among the alerts because,
  // unlike a reorder or a pending approval, expiry blocks EVERY dated
  // operation at once (invoices, receipts, payments, stock ops) until an
  // admin seeds the next BS year.
  const calendarAlerts: NotificationAlert[] = [];
  if (bsCalendarCoverage && bsCalendarCoverage.status !== 'OK') {
    const { status, daysRemaining, minBS, maxBS, minAD, maxAD, mappedYearsCount } =
      bsCalendarCoverage;
    const expired = status === 'EXPIRED';
    calendarAlerts.push({
      id: 'bs-calendar-coverage',
      type: 'CALENDAR',
      title: expired
        ? 'BS calendar coverage has ended — dated operations are blocked'
        : status === 'UNSEEDED'
        ? 'No BS calendar days are seeded'
        : `BS calendar coverage ends in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`,
      subtitle: expired
        ? `The calendar ends at BS ${maxBS} (AD ${maxAD}). Every dated operation refuses until the next BS year is seeded.`
        : `Seeded range: BS ${minBS} to ${maxBS} (AD ${minAD} to ${maxAD}, ${mappedYearsCount} years). Seed the next BS year from ${BS_SEEDING_MENU_PATH} before the last mapped day passes.`,
      branchName: 'All Branches',
      date: expired || status === 'CRITICAL' ? 'Action Required' : 'Before coverage ends',
      severity: expired || status === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      actionLabel: 'Seed BS Calendar',
      actionTab: bsCalendarSeedTab,
    });
  }

  const dismissed = new Set(dismissedIds);
  return [
    ...calendarAlerts,
    ...lowStockAlerts,
    ...approvalAlerts,
    ...shipmentAlerts,
    ...poAlerts,
  ].filter((notification) => !dismissed.has(notification.id));
}
