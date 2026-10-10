import React, { useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import type { DamageSerialEntry } from './StockOperationsContext';
import {
  Product,
  PulloutItem,
} from '../../../types';
import { FormCard } from '../../../components/common/FormCard';
import { ProductSearchBar } from '../ProductSearchBar';
import {
  Trash2,
  AlertTriangle,
  ShieldAlert,
  RotateCcw,
} from 'lucide-react';

/**
 * LabelDamagePanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const LabelDamagePanel: React.FC = () => {
  const { activeTab, allowedBranches, alertDialog, branches, currentUser, ensureBsDateAvailable, initialDamageModalOpen, onCreateOperation, isSuperOrInventory, products, setActiveTab, stock, userBranchId, validateSourceBranchStockAndSerials } = useStockOperationsCtx();

  const [isDamageModalOpen, setIsDamageModalOpen] = useState(initialDamageModalOpen);

  const defaultDamageBranch = userBranchId;
  const [damageBranchId, setDamageBranchId] = useState<string>(defaultDamageBranch);
  const [damageItems, setDamageItems] = useState<PulloutItem[]>([]);
  const [damageReason, setDamageReason] = useState<string>('Overstock transit damage / defective hardware unit');
  const [damageInspector, setDamageInspector] = useState<string>(currentUser?.name || 'Branch Quality Inspector');

  // 2. Submit Local Damage Tagging
  const handleSubmitDamageTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    const targetBranch = !isSuperOrInventory && currentUser?.branchId ? currentUser.branchId : damageBranchId;
    if (damageItems.length === 0) {
      alertDialog('Add at least one product to the damaged stock list.');
      return;
    }

    if (
      !validateSourceBranchStockAndSerials(
        targetBranch,
        branches.find((b) => b.id === targetBranch)?.name || targetBranch,
        damageItems.map(({ condition: _condition, ...item }) => item)
      )
    ) {
      return;
    }

    try {
      await onCreateOperation({
        type: 'DAMAGE',
        branchId: targetBranch,
        productId: damageItems.length === 1 ? damageItems[0].productId : undefined,
        productName: damageItems.length === 1 ? damageItems[0].productName : undefined,
        quantityChanged: damageItems.reduce((sum, item) => sum + item.quantity, 0),
        costPerUnit: damageItems.length === 1 ? damageItems[0].unitCost : 0,
        totalValue: damageItems.reduce((sum, item) => sum + item.totalValue, 0),
        reason: damageReason,
        inspectorName: damageInspector,
        status: 'LOGGED',
        items: damageItems,
      });
    } catch {
      // The rejection itself was already surfaced by the global <ToastHost/>
      // (fetchJson broadcasts a toast intent for every failed mutation), so
      // this catch exists only to stop the SUCCESS path below: the form must
      // keep its items and reason so the input can be corrected and retried.
      return;
    }

    setIsDamageModalOpen(false);
    setActiveTab('DAMAGE_TRACKING');
    setDamageItems([]);
  };


  const handleAddDamageItem = (product: Product) => {
    const isSerialized = product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY';
    setDamageItems((previous) => {
      const existing = previous.find((item) => item.productId === product.id);
      if (existing) {
        return previous.map((item) => item.productId === product.id ? {
          ...item,
          quantity: item.quantity + 1,
          totalValue: (item.quantity + 1) * item.unitCost,
          deviceSerials: isSerialized ? [...(item.deviceSerials || []), { deviceSerial: '', ponSerial: '' }] : undefined,
        } : item);
      }
      return [...previous, {
        id: `damage-${Date.now()}-${product.id}`,
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        unit: product.unit,
        quantity: 1,
        condition: 'DAMAGED_STOCK',
        unitCost: product.costPrice,
        totalValue: product.costPrice,
        deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
      }];
    });
  };

  const updateDamageItem = (id: string, updates: Partial<PulloutItem>) => {
    setDamageItems((previous) => previous.map((item) => {
      if (item.id !== id) return item;
      const updated = { ...item, ...updates };
      if (updates.quantity !== undefined) {
        const product = products.find((entry) => entry.id === item.productId);
        const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : false;
        updated.totalValue = updated.quantity * updated.unitCost;
        updated.deviceSerials = isSerialized ? Array.from({ length: updated.quantity }, (_, index) => item.deviceSerials?.[index] || { deviceSerial: '', ponSerial: '' }) : undefined;
      }
      return updated;
    }));
  };

  const updateDamageItemSerial = (itemId: string, index: number, field: keyof DamageSerialEntry, value: string) => {
    setDamageItems((previous) => previous.map((item) => item.id === itemId ? {
      ...item,
      deviceSerials: (item.deviceSerials || []).map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry),
    } : item));
  };

  return (
    <>
      {(isDamageModalOpen || activeTab === 'LABEL_DAMAGE') && (
        <FormCard className="animate-fadeIn">
          <div className="w-full">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <AlertTriangle className={`h-5 w-5 text-rose-500 dark:text-rose-400`} />
                <span>Label Local Damaged Stock</span>
              </h3>
              <button onClick={() => { setIsDamageModalOpen(false); setActiveTab('DAMAGE_TRACKING'); }} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitDamageTag} className="space-y-4 mt-4 text-xs">
              {!isSuperOrInventory && (
                <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[11px] font-bold flex items-center gap-1.5">
                  <ShieldAlert className={`h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400`} />
                  <span>Branch User Rule: Locked to your assigned branch ({currentUser?.branchId})</span>
                </div>
              )}

              <div>
                <label className="block font-bold mb-1">Target Branch *</label>
                <select
                  value={damageBranchId}
                  onChange={(e) => setDamageBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Scan Barcode or Search & Select Damaged Product *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={handleAddDamageItem}
                  placeholder="Scan Barcode or Search & Select Damaged Product..."
                  stock={stock}
                  selectedBranchId={damageBranchId}
                />
              </div>

              <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="flex items-center justify-between">
                  <label className="font-bold">Damaged Items ({damageItems.length}) *</label>
                  <span className="text-[10px] text-slate-500">Add products above</span>
                </div>
                {damageItems.length === 0 ? (
                  <p className="py-5 text-center text-xs text-slate-400">No damaged products added yet.</p>
                ) : damageItems.map((item) => {
                  const product = products.find((entry) => entry.id === item.productId);
                  const isSerialized = product ? product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY' : false;
                  return (
                    <div key={item.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="flex-1"><strong>{item.productName}</strong><div className="text-[10px] font-mono text-slate-500">SKU: {item.sku}</div></div>
                        <input type="number" min={1} value={item.quantity} onChange={(e) => updateDamageItem(item.id, { quantity: Math.max(1, Number(e.target.value) || 1) })} className="w-20 rounded-lg border p-2 text-center font-mono" />
                        <button type="button" onClick={() => setDamageItems((previous) => previous.filter((entry) => entry.id !== item.id))} className="text-rose-500 dark:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                      </div>
                      {isSerialized && <div className="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-2">
                        {item.deviceSerials?.map((entry, index) => <div key={index} className="grid grid-cols-[2rem_1fr_1fr] gap-2 items-center">
                          <span className="text-[10px] font-mono">#{index + 1}</span>
                          <input required value={entry.deviceSerial} onChange={(e) => updateDamageItemSerial(item.id, index, 'deviceSerial', e.target.value)} placeholder="Device Serial #" className="rounded-lg border p-2 font-mono" />
                          <input required value={entry.ponSerial} onChange={(e) => updateDamageItemSerial(item.id, index, 'ponSerial', e.target.value)} placeholder="PON Serial #" className="rounded-lg border p-2 font-mono" />
                        </div>)}
                      </div>}
                    </div>
                  );
                })}
              </div>

              <div>
                <label className="block font-bold mb-1">Reason for Damage</label>
                <textarea
                  rows={2}
                  required
                  value={damageReason}
                  onChange={(e) => setDamageReason(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div>
                <label className="block font-bold mb-1">Inspector / Officer Name</label>
                <input
                  type="text"
                  required
                  value={damageInspector}
                  onChange={(e) => setDamageInspector(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setDamageItems([]);
                    setDamageReason('');
                    setDamageInspector('Stores Quality Inspector');
                  }}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset Form</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsDamageModalOpen(false); setActiveTab('DAMAGE_TRACKING'); }}
                    className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl bg-rose-600 text-white font-bold hover:bg-rose-500 shadow-md cursor-pointer"
                  >
                    Save Damaged Stock Tag
                  </button>
                </div>
              </div>
            </form>
          </div>
        </FormCard>
      )}
    </>
  );
};
