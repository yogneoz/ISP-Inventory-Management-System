import React from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Asset,
  Branch,
  Product,
  Shipment,
} from '../../../types';
import { FormCard } from '../../../components/common/FormCard';
import { ProductSearchBar } from '../ProductSearchBar';
import {
  Plus,
  Trash2,
  Package,
  Send,
  RotateCcw,
} from 'lucide-react';

/**
 * CreateTransferPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const CreateTransferPanel: React.FC = () => {
  const { activeTab, allowedBranches, branches, canDispatchFromWarehouse, handleAddTransferItem, handleRemoveTransferItem, handleResetTransferForm, handleSubmitCreateTransfer, handleUpdateTransferItem, isWarehouseOrHeadOffice, products, setXferDestBranchId, setXferNotes, setXferSourceBranchId, stock, transferItems, updateTransferDeviceSerial, updateTransferPonSerial, xferDestBranchId, xferNotes, xferSourceBranchId } = useStockOperationsCtx();
  return (
    <>
      {activeTab === 'CREATE_TRANSFER' && (
        <FormCard className="space-y-4">
          {/* Form header — names the form per the form-header pattern (same
              style as the Create Shipment / Assign Fixed Asset forms); the
              status chip stays on the right. */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-serif font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <Send className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <span>Create Inter-Branch Transfer</span>
              </h3>
              <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400">
                Select source and destination branches, scan or search products to add transfer lines, then dispatch the multi-item inter-branch stock transfer.
              </p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-sky-100 dark:bg-sky-950 text-sky-800 dark:text-sky-200 border border-sky-200 dark:border-sky-800">
              Inter-Branch Shipment GRN
            </span>
          </div>

          <form onSubmit={handleSubmitCreateTransfer} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold mb-1">Source Dispatch Branch *</label>
                <select
                  value={xferSourceBranchId}
                  onChange={(e) => setXferSourceBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches
                    .filter((b) => (isWarehouseOrHeadOffice(b) ? canDispatchFromWarehouse : true))
                    .map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Destination Receiving Branch *</label>
                <select
                  value={xferDestBranchId}
                  onChange={(e) => setXferDestBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {branches
                    .filter((b) => {
                      const srcBranch = branches.find((s) => s.id === xferSourceBranchId || s.code === xferSourceBranchId);
                      const warehouseOrigin = isWarehouseOrHeadOffice(srcBranch);
                      return (
                        b.id !== xferSourceBranchId &&
                        !b.isWarehouse &&
                        !b.isHeadquarters &&
                        b.id !== 'WH001' &&
                        !b.code.toUpperCase().startsWith('WH') &&
                        !(b?.name || '').toLowerCase().includes('warehouse') &&
                        !(b?.name || '').toLowerCase().includes('head office') &&
                        !(b?.name || '').toLowerCase().includes('central') &&
                        (!warehouseOrigin || b.allowWarehouseTransfer !== false)
                      );
                    })
                    .map((b) => (
                      <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                    ))}
                </select>
                {(() => {
                  const srcBranch = branches.find((s) => s.id === xferSourceBranchId || s.code === xferSourceBranchId);
                  if (isWarehouseOrHeadOffice(srcBranch)) {
                    return (
                      <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                        Warehouse dispatch: destination limited to branches with warehouse-transfer receiving enabled.
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            {/* Multi-Item Transfer Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={products}
                  onAddOrIncrementProduct={(prod) => handleAddTransferItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU to Add to Transfer..."
                  inputId="transfer-product-search-input"
                  stock={stock}
                  selectedBranchId={xferSourceBranchId}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Transfer Line Items ({transferItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddTransferItem()}
                  className="px-3 py-1 rounded-lg bg-sky-600 text-white font-bold text-[11px] hover:bg-sky-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Line Item</span>
                </button>
              </div>

              {transferItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <Package className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No stock items added to this inter-branch transfer yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddTransferItem()}
                    className={`mt-2 text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add products to transfer
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Product SKU & Name</th>
                        <th className="px-2.5 py-1.5 text-center">Branch Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Transfer Qty</th>
                        <th className="px-2.5 py-1.5 min-w-[280px]">Serials & PON Scanning</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {transferItems.map((item, idx) => {
                        const prod = products.find((p) => p.id === item.productId);
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === xferSourceBranchId);
                        const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5">
                              <div className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                                <Package className="h-4 w-4 text-sky-500 shrink-0" />
                                <span>{item.productName || prod?.name || 'Stock Item'}</span>
                              </div>
                              <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-2">
                                <span>SKU: {item.sku || prod?.sku || 'N/A'}</span>
                                <span className="text-slate-300 dark:text-slate-700">•</span>
                                <span>Unit: {item.unit || prod?.unit || 'Pcs'}</span>
                              </div>
                            </td>

                            <td className="p-2.5 text-center font-mono font-bold text-slate-500">
                              {stk?.quantityOnHand || 0} {item.unit}
                            </td>

                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                required
                                value={item.quantitySent}
                                onChange={(e) => handleUpdateTransferItem(item.id, { quantitySent: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5">
                              {isSerialized ? (
                                <div className="space-y-1.5">
                                  <span className={`text-[10px] text-sky-600 dark:text-sky-400 font-bold block`}>
                                    ✓ Scan Serials for {item.productName} ({item.quantitySent} Unit{item.quantitySent > 1 ? 's' : ''})
                                  </span>
                                  {Array.from({ length: item.quantitySent }).map((_, sIdx) => (
                                    <div key={sIdx} className="bg-sky-50/50 dark:bg-sky-950/40 p-1.5 rounded-lg border border-sky-200 dark:border-sky-800 flex items-center gap-1.5 text-xs">
                                      <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                      <input
                                        id={`transfer-serial-device-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="Device Serial #"
                                        value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                        onChange={(e) => updateTransferDeviceSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const nextEl = document.getElementById(`transfer-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                            if (nextEl) {
                                              nextEl.focus();
                                              if ('select' in nextEl) nextEl.select();
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-sky-500 text-sky-900 bg-white border-sky-300 dark:text-sky-200 dark:bg-slate-800 dark:border-sky-700 `}
                                      />
                                      <input
                                        id={`transfer-serial-pon-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="PON Serial #"
                                        value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                        onChange={(e) => updateTransferPonSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (sIdx + 1 < item.quantitySent) {
                                              const nextDev = document.getElementById(`transfer-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                              if (nextDev) {
                                                nextDev.focus();
                                                if ('select' in nextDev) nextDev.select();
                                              }
                                            } else {
                                              const searchInput = document.getElementById('transfer-product-search-input') as HTMLInputElement;
                                              if (searchInput) {
                                                searchInput.focus();
                                                if ('select' in searchInput) searchInput.select();
                                              }
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-indigo-500 text-indigo-900 bg-white border-indigo-300 dark:text-indigo-200 dark:bg-slate-800 dark:border-indigo-700`}
                                      />
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-slate-400 italic text-[11px]">Non-serialized bulk product</span>
                              )}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveTransferItem(item.id)}
                                className={`text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1`}
                              >
                                <Trash2 className="h-4 w-4" />
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

            <div>
              <label className="block font-bold mb-1">Dispatch Notes / Courier Reference</label>
              <textarea
                rows={2}
                value={xferNotes}
                onChange={(e) => setXferNotes(e.target.value)}
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetTransferForm}
                className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-sky-600 text-white font-bold hover:bg-sky-500 shadow-md flex items-center gap-2 cursor-pointer"
              >
                <Send className="h-4 w-4" />
                <span>Dispatch Multi-Item Transfer Shipment</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}
    </>
  );
};
