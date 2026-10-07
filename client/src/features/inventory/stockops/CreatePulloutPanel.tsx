import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Branch,
  Product,
} from '../../../types';
import { FormCard } from '../../../components/common/FormCard';
import { ProductSearchBar } from '../ProductSearchBar';
import { formatNPR } from '../../../utils/nprFormat';
import {
  Trash2,
  Truck,
  AlertTriangle,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

/**
 * CreatePulloutPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const CreatePulloutPanel: React.FC = () => {
  const { activeTab, binNotes, branches, destWarehouseId, destWarehouseOptions, effectivePulloutSourceBranches, handleAddProductToPullout, handleRemovePulloutItem, handleSubmitPulloutBin, handleUpdatePulloutItem, isPulloutModalOpen, products, pulloutItems, setActiveTab, setBinNotes, setDestWarehouseId, setIsPulloutModalOpen, setPulloutItems, setSourceBranchId, sourceBranchId, stock, updatePulloutDeviceSerial, updatePulloutPonSerial } = useStockOperationsCtx();
  return (
    <>
      {(isPulloutModalOpen || activeTab === 'CREATE_PULLOUT') && (
        <FormCard className="animate-fadeIn">
          <div className="w-full">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-base font-serif font-bold flex items-center gap-2">
                <Truck className={`h-5 w-5 text-indigo-500 dark:text-indigo-400`} />
                <span>Create Overstock / Damaged Stock Pullout Bin</span>
              </h3>
              <button onClick={() => { setIsPulloutModalOpen(false); setActiveTab('PULLOUT_BINS'); }} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitPulloutBin} className="space-y-4 mt-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold mb-1">Source Branch *</label>
                  <select
                    value={sourceBranchId}
                    onChange={(e) => setSourceBranchId(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    {effectivePulloutSourceBranches.map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold mb-1">Destination Central Warehouse *</label>
                  <select
                    value={destWarehouseId}
                    onChange={(e) => setDestWarehouseId(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                  >
                    {destWarehouseOptions.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.code}) {b.isHeadquarters ? '⭐ Central HQ' : '🏬 Warehouse'}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-bold mb-1">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddProductToPullout(prod)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU for Pullout..."
                  inputId="pullout-product-search-input"
                  stock={stock}
                  selectedBranchId={sourceBranchId}
                />
              </div>

              {/* Added Pullout Items List */}
              <div className="space-y-2 max-h-72 overflow-y-auto border rounded-xl p-2">
                {pulloutItems.length === 0 ? (
                  <p className="text-slate-400 text-center py-4 text-xs">No items added to pullout bin yet. Search above to add items.</p>
                ) : (
                  pulloutItems.map((item, idx) => {
                    const prod = products.find((p) => p.id === item.productId);
                    const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;
                    const srcStock = stock.find((s) => s.productId === item.productId && s.branchId === sourceBranchId);
                    const usableQty = srcStock ? (srcStock.quantityOnHand || 0) : 0;
                    const damagedQty = srcStock ? (srcStock.damagedQty || 0) : 0;
                    const availForCondition = item.condition === 'DAMAGED_STOCK' ? damagedQty : usableQty;
                    const isExceeded = item.quantity > availForCondition;
                    const srcBranchName = branches.find((b) => b.id === sourceBranchId)?.name || sourceBranchId;

                    return (
                      <div key={item.id} className={`p-2.5 rounded-xl border space-y-2 ${
                        isExceeded
                          ? 'bg-rose-50/50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800'
                          : `bg-slate-50 border-slate-200 dark:bg-slate-800/60 dark:border-slate-700`
                      }`}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex-1">
                            <span className="font-bold text-slate-900 dark:text-white block">{item.productName}</span>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-mono text-slate-400">SKU: {item.sku}</span>
                              <select
                                value={item.condition}
                                onChange={(e) => handleUpdatePulloutItem(item.id, { condition: e.target.value as any })}
                                className={`text-[10px] font-bold rounded border px-1.5 py-0.5 bg-white text-indigo-600 border-indigo-300 dark:bg-slate-800 dark:text-indigo-400 dark:border-slate-700`}
                              >
                                <option value="OVERSTOCK">OVERSTOCK</option>
                                <option value="DAMAGED_STOCK">DAMAGED_STOCK</option>
                              </select>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            <div>
                              <span className="text-[9px] text-slate-400 block text-right">Pullout Qty</span>
                              <input
                                type="number"
                                min={1}
                                value={item.quantity}
                                onChange={(e) => handleUpdatePulloutItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-16 rounded border p-1 text-center font-mono font-bold text-xs ${isExceeded ? 'bg-rose-100 dark:bg-rose-900 text-rose-800 dark:text-rose-100 border-rose-400' : 'bg-white text-slate-900 border-slate-300 dark:bg-slate-800 dark:text-white dark:border-slate-600'}`}
                              />
                            </div>

                            <div className="text-right">
                              <span className="text-[9px] text-slate-400 block">Total Val</span>
                              <span className={`font-mono font-bold text-xs text-indigo-600 dark:text-indigo-400`}>
                                {formatNPR(item.totalValue)}
                              </span>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleRemovePulloutItem(item.id)}
                              className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        {/* Branch Stock Availability Information & Live Validation Banner */}
                        <div className={`flex items-center justify-between text-[11px] p-2 rounded-lg border gap-2 flex-wrap bg-white/70 border-slate-200/80 dark:bg-slate-900/60 dark:border-slate-800`}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-slate-600 dark:text-slate-300">
                              Stock at {srcBranchName}:
                            </span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${
                              item.condition === 'OVERSTOCK' && isExceeded
                                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                : usableQty > 0
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border border-emerald-300'
                                : 'bg-slate-100 text-slate-500'
                            }`}>
                              Usable: {usableQty} {item.unit || 'pcs'}
                            </span>
                            <span className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] ${
                              item.condition === 'DAMAGED_STOCK' && isExceeded
                                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                                : damagedQty > 0
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border border-amber-300'
                                : 'bg-slate-100 text-slate-500'
                            }`}>
                              Damaged: {damagedQty} {item.unit || 'pcs'}
                            </span>
                          </div>

                          {isExceeded && (
                            <button
                              type="button"
                              onClick={() => handleUpdatePulloutItem(item.id, { quantity: Math.max(1, availForCondition) })}
                              className="text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-100 dark:bg-rose-950/80 hover:bg-rose-200 px-2 py-1 rounded-md border border-rose-300 dark:border-rose-800 transition-all cursor-pointer flex items-center gap-1 shrink-0"
                            >
                              <RefreshCw className={`h-3 w-3 text-rose-600 dark:text-rose-400`} />
                              <span>Set to Available Max ({availForCondition})</span>
                            </button>
                          )}
                        </div>

                        {isExceeded && (
                          <div className="text-[11px] font-bold text-rose-700 dark:text-rose-300 bg-rose-100/90 dark:bg-rose-950/80 p-2 rounded-lg border border-rose-300 dark:border-rose-800 flex items-center gap-2">
                            <AlertTriangle className={`h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400`} />
                            <span>
                              Requested pullout quantity ({item.quantity} {item.unit || 'pcs'}) exceeds available {item.condition === 'DAMAGED_STOCK' ? 'damaged' : 'usable'} stock ({availForCondition} {item.unit || 'pcs'} available at {srcBranchName}).
                            </span>
                          </div>
                        )}

                        {/* Serial Tracking Inputs */}
                        {isSerialized && (
                          <div className="pt-2 border-t border-slate-200 dark:border-slate-700/60 space-y-1.5">
                            <div className={`flex items-center justify-between text-[10px] text-indigo-600 dark:text-indigo-400 font-bold`}>
                              <span>✓ Scan Serials for {item.productName} ({item.quantity} Unit{item.quantity > 1 ? 's' : ''})</span>
                            </div>
                            {Array.from({ length: item.quantity }).map((_, sIdx) => (
                              <div key={sIdx} className={`p-1.5 rounded-lg border flex items-center gap-1.5 text-xs bg-white dark:bg-slate-900/80`}>
                                <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                <input
                                  id={`pullout-serial-device-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="Device Serial #"
                                  value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                  onChange={(e) => updatePulloutDeviceSerial(idx, sIdx, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      const nextEl = document.getElementById(`pullout-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                      if (nextEl) {
                                        nextEl.focus();
                                        if ('select' in nextEl) nextEl.select();
                                      }
                                    }
                                  }}
                                  className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 text-indigo-900 bg-slate-50 border-indigo-200 dark:text-indigo-200 dark:bg-slate-950 dark:border-indigo-800`}
                                />
                                <input
                                  id={`pullout-serial-pon-${idx}-${sIdx}`}
                                  type="text"
                                  placeholder="PON Serial #"
                                  value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                  onChange={(e) => updatePulloutPonSerial(idx, sIdx, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      if (sIdx + 1 < item.quantity) {
                                        const nextDev = document.getElementById(`pullout-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                        if (nextDev) {
                                          nextDev.focus();
                                          if ('select' in nextDev) nextDev.select();
                                        }
                                      } else {
                                        const searchInput = document.getElementById('pullout-product-search-input') as HTMLInputElement;
                                        if (searchInput) {
                                          searchInput.focus();
                                          if ('select' in searchInput) searchInput.select();
                                        }
                                      }
                                    }
                                  }}
                                  className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-sky-500 text-sky-900 bg-slate-50 border-sky-200 dark:text-sky-200 dark:bg-slate-950 dark:border-sky-800`}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div>
                <label className="block font-bold mb-1">Dispatch Reason / Notes</label>
                <textarea
                  rows={2}
                  value={binNotes}
                  onChange={(e) => setBinNotes(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setPulloutItems([]);
                    setBinNotes('Warehouse overstock & damaged inventory pullout return dispatch');
                  }}
                  className="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset Form</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setIsPulloutModalOpen(false); setActiveTab('PULLOUT_BINS'); }}
                    className="px-4 py-2 rounded-xl text-slate-500 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-500 shadow-md cursor-pointer"
                  >
                    Dispatch Pullout Bin
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
