import React, { useState } from 'react';
import { Product, InventoryStock, ApprovalRequest, PurchaseOrder, Shipment, Branch } from '../../types';
import {
  Bell,
  AlertTriangle,
  ShieldAlert,
  Truck,
  ShoppingCart,
  CheckCircle2,
  X,
  ExternalLink,
  Filter,
  Check,
  RefreshCw,
  Package,
} from 'lucide-react';

interface NotificationCenterProps {
  isOpen: boolean;
  onClose: () => void;
  products: Product[];
  stock: InventoryStock[];
  approvalRequests: ApprovalRequest[];
  purchaseOrders: PurchaseOrder[];
  shipments: Shipment[];
  branches: Branch[];
  selectedBranchId: string;  onSelectTab: (tabId: string) => void;
  /** Dismissed notification ids (lifted to App so badges stay in sync). */
  dismissedIds?: string[];
  onDismiss?: (id: string) => void;
  onClearAll?: () => void;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  isOpen,
  onClose,
  products = [],
  stock = [],
  approvalRequests = [],
  purchaseOrders = [],
  shipments = [],
  branches = [],
  selectedBranchId,  onSelectTab,
  dismissedIds = [],
  onDismiss,
  onClearAll,
}) => {
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'REORDER' | 'APPROVAL' | 'SHIPMENT' | 'PO'>('ALL');

  if (!isOpen) return null;

  // 1. Generate Low Stock / Reorder Alerts (matching Header badge & Consolidated Total logic accurately)
  const lowStockAlerts: {
    id: string;
    type: 'REORDER';
    title: string;
    subtitle: string;
    branchName: string;
    date: string;
    severity: 'CRITICAL' | 'WARNING';
    actionLabel: string;
    actionTab: string;
  }[] = [];

  const activeBr =
    selectedBranchId === 'ALL'
      ? branches
      : branches.filter((b) => b.id === selectedBranchId);

  products.forEach((prod) => {
    let totalOnHand = 0;
    let totalConsolidatedReorder = 0;
    let totalDeficit = 0;
    const lowBranchNames: string[] = [];

    activeBr.forEach((b) => {
      const item = stock.find((st) => st.productId === prod.id && st.branchId === b.id);
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

  // 2. Generate Pending Approval Requests
  const approvalAlerts = approvalRequests
    .filter(
      (req) =>
        req.status === 'PENDING' &&
        (selectedBranchId === 'ALL' || req.branchId === selectedBranchId)
    )
    .map((req) => ({
      id: `appr-${req.id}`,
      type: 'APPROVAL' as const,
      title: `Approval Request #${req.requestNumber}`,
      subtitle: `${req.customerName} (${req.deviceSerial}) → Change status to "${req.requestedStatus}"`,
      branchName: req.branchName || 'Branch',
      date: req.requestedAtAD,
      severity: 'HIGH' as const,
      actionLabel: 'Review Request',
      actionTab: 'workflow-approval',
    }));

  // 3. Generate In-Transit Shipment Alerts
  const shipmentAlerts = shipments
    .filter(
      (sh) =>
        (sh.status === 'IN_TRANSIT' || sh.status === 'DISPATCHED') &&
        (selectedBranchId === 'ALL' ||
          sh.destinationBranchId === selectedBranchId ||
          sh.sourceBranchId === selectedBranchId)
    )
    .map((sh) => ({
      id: `ship-${sh.id}`,
      type: 'SHIPMENT' as const,
      title: `Shipment ${sh.status}: ${sh.trackingCode}`,
      subtitle: `${sh.sourceBranchName || 'Source'} → ${sh.destinationBranchName} (${sh.items?.length || 0} items)`,
      branchName: sh.destinationBranchName,
      date: sh.dispatchDateAD,
      severity: 'INFO' as const,
      actionLabel: 'Track Shipment',
      actionTab: 'shipment-list',
    }));

  // 4. Generate Pending Purchase Orders
  const poAlerts = purchaseOrders
    .filter(
      (po) =>
        (po.status === 'SENT' || po.status === 'APPROVED' || po.status === 'DRAFT') &&
        (selectedBranchId === 'ALL' || po.branchId === selectedBranchId)
    )
    .map((po) => ({
      id: `po-${po.id}`,
      type: 'PO' as const,
      title: `Purchase Order #${po.poNumber} (${po.status})`,
      subtitle: `Supplier: ${po.supplierName} • Total: Rs. ${(po.totalAmount ?? 0).toLocaleString('en-IN')}`,
      branchName: branches.find((b) => b.id === po.branchId)?.name || 'Branch',
      date: po.orderDateAD,
      severity: 'INFO' as const,
      actionLabel: 'View Order',
      actionTab: 'po-list',
    }));

  // Combine all active alerts
  const allNotifications = [...lowStockAlerts, ...approvalAlerts, ...shipmentAlerts, ...poAlerts].filter(
    (n) => !dismissedIds.includes(n.id)
  );

  const filteredNotifications = allNotifications.filter((n) => {
    if (activeFilter === 'ALL') return true;
    return n.type === activeFilter;
  });

  const handleDismiss = (id: string) => {
    if (onDismiss) onDismiss(id);
  };

  const handleClearAll = () => {
    if (onClearAll) onClearAll();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div
        className={`w-full max-w-md h-full flex flex-col border-l shadow-2xl transition-all duration-200 z-[10000] bg-white border-slate-200 text-slate-900 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-100`}
      >
        {/* Header Bar */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500">
              <Bell className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-sm tracking-wide">Notification Center</h3>
                {allNotifications.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white font-extrabold text-[10px]">
                    {allNotifications.length} Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Stock Reorders, Approvals, Shipments & Orders
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {allNotifications.length > 0 && (
              <button
                onClick={handleClearAll}
                title="Dismiss all notifications"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 text-xs font-semibold cursor-pointer"
              >
                Clear All
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filter Navigation Tabs */}
        <div className="p-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex items-center gap-1 overflow-x-auto text-xs shrink-0">
          <button
            onClick={() => setActiveFilter('ALL')}
            className={`px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
              activeFilter === 'ALL'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            <span>All</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">
              {allNotifications.length}
            </span>
          </button>
          <button
            onClick={() => setActiveFilter('REORDER')}
            className={`px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
              activeFilter === 'REORDER'
                ? 'bg-rose-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Reorder</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">
              {lowStockAlerts.length}
            </span>
          </button>
          <button
            onClick={() => setActiveFilter('APPROVAL')}
            className={`px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
              activeFilter === 'APPROVAL'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>Approvals</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">
              {approvalAlerts.length}
            </span>
          </button>
          <button
            onClick={() => setActiveFilter('SHIPMENT')}
            className={`px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
              activeFilter === 'SHIPMENT'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            <Truck className="h-3.5 w-3.5" />
            <span>Shipments</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">
              {shipmentAlerts.length}
            </span>
          </button>
          <button
            onClick={() => setActiveFilter('PO')}
            className={`px-2.5 py-1.5 rounded-lg font-bold transition-all cursor-pointer flex items-center gap-1 shrink-0 ${
              activeFilter === 'PO'
                ? 'bg-purple-600 text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            <ShoppingCart className="h-3.5 w-3.5" />
            <span>Orders</span>
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">
              {poAlerts.length}
            </span>
          </button>
        </div>

        {/* Notifications List Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {filteredNotifications.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-slate-400">
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-2 opacity-80" />
              <p className="font-bold text-sm text-slate-700 dark:text-slate-300">All caught up!</p>
              <p className="text-xs mt-1">No active notifications or alerts in this view.</p>
            </div>
          ) : (
            filteredNotifications.map((item) => (
              <div
                key={item.id}
                className={`p-3.5 rounded-2xl border transition-all relative group ${
                  item.type === 'REORDER'
                    ? 'border-rose-200/80 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20'
                    : item.type === 'APPROVAL'
                    ? 'border-amber-200/80 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20'
                    : item.type === 'SHIPMENT'
                    ? 'border-blue-200/80 dark:border-blue-900/60 bg-blue-50/40 dark:bg-blue-950/20'
                    : 'border-purple-200/80 dark:border-purple-900/60 bg-purple-50/40 dark:bg-purple-950/20'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    {item.type === 'REORDER' && (
                      <div className="p-2 rounded-xl bg-rose-500 text-white shrink-0 mt-0.5">
                        <AlertTriangle className="h-4 w-4" />
                      </div>
                    )}
                    {item.type === 'APPROVAL' && (
                      <div className="p-2 rounded-xl bg-amber-500 text-white shrink-0 mt-0.5">
                        <ShieldAlert className="h-4 w-4" />
                      </div>
                    )}
                    {item.type === 'SHIPMENT' && (
                      <div className="p-2 rounded-xl bg-blue-500 text-white shrink-0 mt-0.5">
                        <Truck className="h-4 w-4" />
                      </div>
                    )}
                    {item.type === 'PO' && (
                      <div className="p-2 rounded-xl bg-purple-500 text-white shrink-0 mt-0.5">
                        <ShoppingCart className="h-4 w-4" />
                      </div>
                    )}
                    <div className="space-y-1">
                      <h4 className="font-bold text-xs leading-snug text-slate-900 dark:text-slate-100">
                        {item.title}
                      </h4>
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-normal">
                        {item.subtitle}
                      </p>
                      <div className="flex items-center gap-2 pt-1 text-[10px] text-slate-500 dark:text-slate-400 font-medium">
                        <span className="px-2 py-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          📍 {item.branchName}
                        </span>
                        <span>• {item.date}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDismiss(item.id)}
                    title="Dismiss"
                    className="opacity-60 hover:opacity-100 p-1 rounded-md hover:bg-slate-200/80 dark:hover:bg-slate-800 cursor-pointer text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mt-3 pt-2 border-t border-slate-200/60 dark:border-slate-800/60 flex items-center justify-end">
                  <button
                    onClick={() => {
                      onSelectTab(item.actionTab);
                      onClose();
                    }}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold text-white shadow-xs flex items-center gap-1.5 cursor-pointer transition-transform active:scale-95 ${
                      item.type === 'REORDER'
                        ? 'bg-rose-600 hover:bg-rose-700'
                        : item.type === 'APPROVAL'
                        ? 'bg-amber-600 hover:bg-amber-700'
                        : item.type === 'SHIPMENT'
                        ? 'bg-blue-600 hover:bg-blue-700'
                        : 'bg-purple-600 hover:bg-purple-700'
                    }`}
                  >
                    <span>{item.actionLabel}</span>
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer info */}
        <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-[11px] text-slate-500 text-center shrink-0">
          <span>Updates automatically with real-time stock levels and activity.</span>
        </div>
      </div>
    </div>
  );
};
