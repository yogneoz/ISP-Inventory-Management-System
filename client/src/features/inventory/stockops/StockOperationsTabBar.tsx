import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { isOperationAllowed } from '../../../utils/permissions';
import {
  Lock,
  Truck,
  AlertTriangle,
  Inbox,
  Send,
  Wrench,
  PackageMinus,
  RefreshCw,
  Package,
  ClipboardList,
} from 'lucide-react';

/**
 * StockOperationsTabBar - host chrome (FRONTEND-AUDIT.md §G commit 2): the
 * sub-tab strip, cut VERBATIM out of StockOperations.tsx. Counts, activeTab,
 * the permission check and the dialog helper come from the StockOperations
 * context; `initialType` stays a prop because it is the App-level entry
 * type that groups which buttons show, not panel state. The host gates
 * rendering with its isStandalonePage check (all 11 App render sites pass a
 * non-empty initialType today, so the strip only renders when that changes).
 */
export const StockOperationsTabBar: React.FC<{ initialType?: string }> = ({ initialType }) => {
  const {
    activeTab,
    setActiveTab,
    alertDialog,
    currentUser,
    availableStockAssets,
    consumableOperations,
    damageOperations,
    exchangeCustomerDevices,
    operations,
    pulloutOperations,
    saleOperations,
    shipments,
  } = useStockOperationsCtx();
  return (
      <div className={`flex items-center gap-1 border-b pb-1 overflow-x-auto border-slate-200 dark:border-slate-800`}>
        {initialType !== 'PULLOUT' && initialType !== 'DAMAGE' && initialType !== 'PULLOUT_REPORT' && initialType !== 'DAMAGE_REPORT' && (() => {
          const canPullout = isOperationAllowed('branch-pullout-dispatch', currentUser?.role);
          return (
            <button
              disabled={!canPullout}
              title={!canPullout ? 'Pullout dispatch is disabled for your role permissions' : 'Warehouse pullout dispatch'}
              onClick={() => {
                if (!canPullout) {
                  alertDialog('Pullout dispatch operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('PULLOUT_BINS');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canPullout
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'PULLOUT_BINS'
                  ? 'bg-indigo-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canPullout ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Truck className="h-4 w-4" />}
              <span>Warehouse Pullout ({pulloutOperations.length})</span>
            </button>
          );
        })()}

        {initialType !== 'PULLOUT' && initialType !== 'DAMAGE' && initialType !== 'PULLOUT_REPORT' && initialType !== 'DAMAGE_REPORT' && (() => {
          const canDamage = isOperationAllowed('branch-damage-mark', currentUser?.role);
          return (
            <button
              disabled={!canDamage}
              title={!canDamage ? 'Damaged stock registration is disabled for your role permissions' : 'Damaged stock log'}
              onClick={() => {
                if (!canDamage) {
                  alertDialog('Damaged stock registration operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('DAMAGE_TRACKING');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canDamage
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'DAMAGE_TRACKING'
                  ? 'bg-rose-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canDamage ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <AlertTriangle className="h-4 w-4" />}
              <span>Damaged Stock ({damageOperations.length})</span>
            </button>
          );
        })()}

        {(() => {
          const canReceive = isOperationAllowed('branch-transfer-receive', currentUser?.role);
          return (
            <button
              disabled={!canReceive}
              title={!canReceive ? 'Transfer receiving is disabled for your role permissions' : 'Receive incoming transfer shipments'}
              onClick={() => {
                if (!canReceive) {
                  alertDialog('Transfer receiving operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('RECEIVE_TRANSFER');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canReceive
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'RECEIVE_TRANSFER'
                  ? 'bg-amber-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canReceive ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Inbox className="h-4 w-4" />}
              <span>Receive Transfer ({shipments.length})</span>
            </button>
          );
        })()}

        {(() => {
          const canCreateXfer = isOperationAllowed('branch-transfer-create', currentUser?.role);
          return (
            <button
              disabled={!canCreateXfer}
              title={!canCreateXfer ? 'Inter-branch transfer creation is disabled for your role permissions' : 'Create inter-branch stock transfer'}
              onClick={() => {
                if (!canCreateXfer) {
                  alertDialog('Stock transfer creation operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('CREATE_TRANSFER');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canCreateXfer
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'CREATE_TRANSFER'
                  ? 'bg-sky-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canCreateXfer ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Send className="h-4 w-4" />}
              <span>Create Transfer</span>
            </button>
          );
        })()}

        {(() => {
          const canAssignAsset = isOperationAllowed('branch-asset-assign', currentUser?.role);
          return (
            <button
              disabled={!canAssignAsset}
              title={!canAssignAsset ? 'Fixed asset commissioning is disabled for your role permissions' : 'Assign fixed asset to location/customer'}
              onClick={() => {
                if (!canAssignAsset) {
                  alertDialog('Fixed asset assignment operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('ASSIGN_ASSET');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canAssignAsset
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'ASSIGN_ASSET'
                  ? 'bg-emerald-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canAssignAsset ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Wrench className="h-4 w-4" />}
              <span>Assign Fixed Asset ({availableStockAssets.length} Avail)</span>
            </button>
          );
        })()}

        {(() => {
          return (
            <button
              title="Issue Consumables (Splitters, Protection Sleeves, Couplers, Fast Connectors) to Field Technicians"
              onClick={() => setActiveTab('CONSUMABLE_ISSUE')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${activeTab === 'CONSUMABLE_ISSUE' ? 'bg-amber-600 text-white shadow-sm cursor-pointer' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'}`}
            >
              <Wrench className="h-4 w-4 text-amber-300" />
              <span>Issue Consumables ({consumableOperations.length})</span>
            </button>
          );
        })()}

        {(() => {
          return (
            <button
              title="Consumables Register — log of every consumable issue with per-line POP/customer destinations"
              onClick={() => setActiveTab('CONSUMABLES_REGISTER')}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${activeTab === 'CONSUMABLES_REGISTER' ? 'bg-amber-600 text-white shadow-sm cursor-pointer' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'}`}
            >
              <ClipboardList className="h-4 w-4 text-amber-300" />
              <span>Consumables Register</span>
            </button>
          );
        })()}

        {(() => {
          const canSale = isOperationAllowed('stock-out', currentUser?.role);
          return (
            <button
              disabled={!canSale}
              title={!canSale ? 'Product sales operation is disabled for your role permissions' : 'Direct retail product item sale'}
              onClick={() => {
                if (!canSale) {
                  alertDialog('Product sale operation is disabled for your role permissions.');
                  return;
                }
                setActiveTab('PRODUCT_SALE');
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap ${
                !canSale
                  ? 'opacity-40 cursor-not-allowed text-slate-400 dark:text-slate-500'
                  : activeTab === 'PRODUCT_SALE'
                  ? 'bg-purple-600 text-white shadow-sm cursor-pointer'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 cursor-pointer dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 dark:cursor-pointer'
              }`}
            >
              {!canSale ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <PackageMinus className="h-4 w-4" />}
              <span>Product Sale ({saleOperations.length})</span>
            </button>
          );
        })()}

        <button
          onClick={() => setActiveTab('DEVICE_EXCHANGE')}
          title="Exchange customer ONU/STB device, enter replacement serials, and return old unit to stock"
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${activeTab === 'DEVICE_EXCHANGE' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <RefreshCw className="h-4 w-4 text-indigo-300" />
          <span>Device Exchange ({exchangeCustomerDevices.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('LOGS')}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold rounded-xl transition-all whitespace-nowrap cursor-pointer ${activeTab === 'LOGS' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800'}`}
        >
          <Package className="h-4 w-4" />
          <span>Logs ({operations.length})</span>
        </button>
      </div>
  );
};
