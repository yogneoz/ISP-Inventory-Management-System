import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Branch,
  Product,
  User,
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
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const LabelDamagePanel: React.FC = () => {
  const { activeTab, allowedBranches, currentUser, damageBranchId, damageInspector, damageItems, damageReason, handleAddDamageItem, handleSubmitDamageTag, isDamageModalOpen, isSuperOrInventory, products, setActiveTab, setDamageBranchId, setDamageInspector, setDamageItems, setDamageReason, setIsDamageModalOpen, stock, updateDamageItem, updateDamageItemSerial } = useStockOperationsCtx();
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
