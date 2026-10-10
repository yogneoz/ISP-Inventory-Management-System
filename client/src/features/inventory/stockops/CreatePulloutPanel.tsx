import React, { useEffect, useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Product,
  PulloutItem,
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
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const CreatePulloutPanel: React.FC = () => {
  const { activeTab, alertDialog, allowedBranches, branches, currentUser, ensureBsDateAvailable, focusInput, initialPulloutModalOpen, onCreateOperation, products, setActiveTab, stock, userBranchId, validateSourceBranchStockAndSerials } = useStockOperationsCtx();

  const [isPulloutModalOpen, setIsPulloutModalOpen] = useState(initialPulloutModalOpen);

  // Filter Central Warehouse & Warehouse locations for pullouts (exclude standard retail branches)
  const warehouseLocations = branches.filter(
    (b) =>
      b.isHeadquarters ||
      b.isWarehouse ||
      b.code.toUpperCase().startsWith('WH') ||
      (b?.name || '').toLowerCase().includes('warehouse') ||
      (b?.name || '').toLowerCase().includes('head office') ||
      (b?.name || '').toLowerCase().includes('central')
  );
  const destWarehouseOptions = warehouseLocations.length > 0 ? warehouseLocations : branches.filter((b) => b.isHeadquarters);

  // Filter source branches for pullouts: ONLY retail / store branches (exclude Head Office / WH001 / warehouses)
  const pulloutSourceBranches = allowedBranches.filter(
    (b) =>
      !b.isHeadquarters &&
      !b.isWarehouse &&
      b.id !== 'WH001' &&
      !b.code.toUpperCase().startsWith('WH') &&
      !(b?.name || '').toLowerCase().includes('head office') &&
      !(b?.name || '').toLowerCase().includes('central warehouse')
  );
  const effectivePulloutSourceBranches =
    pulloutSourceBranches.length > 0
      ? pulloutSourceBranches
      : allowedBranches.filter((b) => b.id !== 'WH001');

  const initialPulloutSourceBranchId =
    effectivePulloutSourceBranches.find((b) => b.id === userBranchId)?.id ||
    effectivePulloutSourceBranches[0]?.id ||
    allowedBranches.find((b) => b.id !== 'WH001')?.id ||
    'BRH01';

  const [sourceBranchId, setSourceBranchId] = useState<string>(initialPulloutSourceBranchId);
  const [destWarehouseId, setDestWarehouseId] = useState<string>(
    destWarehouseOptions[0]?.id || branches.find((b) => b.isHeadquarters)?.id || 'WH001'
  );

  useEffect(() => {
    if (effectivePulloutSourceBranches.length > 0) {
      if (!effectivePulloutSourceBranches.some((b) => b.id === sourceBranchId)) {
        setSourceBranchId(effectivePulloutSourceBranches[0].id);
      }
    }
  }, [effectivePulloutSourceBranches, sourceBranchId]);

  const [binInspector] = useState<string>(currentUser?.name || 'Logistics Officer');
  const [binNotes, setBinNotes] = useState<string>('Overstock / Damaged stock return dispatch to central warehouse');
  const [pulloutItems, setPulloutItems] = useState<PulloutItem[]>([]);
  const [, setProdSearchInput] = useState<string>('');
  const [, setIsSearchOpen] = useState<boolean>(false);

  // Pullout Item Handlers
  const handleAddProductToPullout = (prod: Product) => {
    const isSerialized = prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY';
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    const existingIdx = pulloutItems.findIndex((i) => i.productId === prod.id);
    if (existingIdx !== -1) {
      targetLineIdx = existingIdx;
      setPulloutItems((prev) =>
        prev.map((i, idx) => {
          if (idx !== existingIdx) return i;
          const newQty = i.quantity + 1;
          const currentSerials = [...(i.deviceSerials || [])];
          targetSerialIdx = currentSerials.length;
          if (isSerialized) {
            currentSerials.push({ deviceSerial: '', ponSerial: '' });
          }
          return {
            ...i,
            quantity: newQty,
            totalValue: newQty * i.unitCost,
            deviceSerials: isSerialized ? currentSerials : undefined,
          };
        })
      );
    } else {
      targetLineIdx = pulloutItems.length;
      targetSerialIdx = 0;
      const srcStock = stock.find((s) => s.productId === prod.id && s.branchId === sourceBranchId);
      const availDamaged = srcStock?.damagedQty || 0;
      const defaultCond = availDamaged > 0 ? 'DAMAGED_STOCK' : 'OVERSTOCK';

      setPulloutItems((prev) => [
        ...prev,
        {
          id: `pli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          productId: prod.id,
          productName: prod.name,
          sku: prod.sku,
          unit: prod.unit,
          quantity: 1,
          condition: defaultCond,
          unitCost: prod.costPrice,
          totalValue: prod.costPrice,
          reason: defaultCond === 'DAMAGED_STOCK' ? 'Damaged inventory return' : 'Surplus overstock return to warehouse',
          deviceSerials: isSerialized ? [{ deviceSerial: '', ponSerial: '' }] : undefined,
        },
      ]);
    }
    setProdSearchInput('');
    setIsSearchOpen(false);

    if (isSerialized) {
      focusInput(`pullout-serial-device-${targetLineIdx}-${targetSerialIdx}`);
    }
  };

  const updatePulloutDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    setPulloutItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const updatePulloutPonSerial = (lineIdx: number, sIdx: number, val: string) => {
    setPulloutItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== lineIdx) return item;
        const serials = [...(item.deviceSerials || [])];
        serials[sIdx] = { ...serials[sIdx], ponSerial: val };
        return { ...item, deviceSerials: serials };
      })
    );
  };

  const handleUpdatePulloutItem = (id: string, updates: Partial<PulloutItem>) => {
    setPulloutItems(
      pulloutItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.quantity !== undefined || updates.unitCost !== undefined) {
          updated.totalValue = updated.quantity * updated.unitCost;
          // Sync serials count if quantity changed and serials exist
          const prod = products.find((p) => p.id === updated.productId);
          if (prod && prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY') {
            const curSerials = [...(updated.deviceSerials || [])];
            while (curSerials.length < updated.quantity) {
              curSerials.push({ deviceSerial: '', ponSerial: '' });
            }
            updated.deviceSerials = curSerials.slice(0, updated.quantity);
          }
        }
        return updated;
      })
    );
  };

  const handleRemovePulloutItem = (id: string) => {
    setPulloutItems(pulloutItems.filter((i) => i.id !== id));
  };


  // 1. Submit Pullout Dispatch
  const handleSubmitPulloutBin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (pulloutItems.length === 0) {
      alertDialog('Please add at least one stock item to the pullout bin.');
      return;
    }

    const srcBranch = branches.find((b) => b.id === sourceBranchId);
    const destWh = branches.find((b) => b.id === destWarehouseId);

    // Strict validation for Branch Stock Quantity and Serial Register
    if (
      !validateSourceBranchStockAndSerials(
        sourceBranchId,
        srcBranch?.name || sourceBranchId,
        pulloutItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
          condition: i.condition,
          deviceSerials: i.deviceSerials,
        }))
      )
    ) {
      return;
    }

    const grandTotal = pulloutItems.reduce((sum, item) => sum + item.totalValue, 0);

    try {
      await onCreateOperation({
        type: 'PULLOUT',
        branchId: sourceBranchId,
        branchName: srcBranch?.name,
        destinationWarehouseId: destWarehouseId,
        destinationWarehouseName: destWh?.name,
        items: pulloutItems,
        totalValue: grandTotal,
        reason: binNotes,
        inspectorName: binInspector,
        status: 'DISPATCHED',
      });
    } catch {
      // The rejection itself was already surfaced by the global <ToastHost/>
      // (fetchJson broadcasts a toast intent for every failed mutation), so
      // this catch exists only to stop the SUCCESS path below: the bin
      // contents stay in the form so they can be corrected and retried.
      return;
    }

    alertDialog(`✓ Pullout Bin successfully created and dispatched from ${srcBranch?.name || sourceBranchId} to ${destWh?.name || 'Central Warehouse'}!\n\nThe Warehouse Manager can now inspect and receive this pullout under:\nWarehouse Logistics ➔ Receive Inbound Stock & Pullouts`);

    setIsPulloutModalOpen(false);
    setActiveTab('PULLOUT_BINS');
    setPulloutItems([]);
  };

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
