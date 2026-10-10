import React, { useMemo, useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  ConsumableIssueItem,
} from '../../../types';
import { FormCard } from '../../../components/common/FormCard';
import { ProductSearchBar } from '../ProductSearchBar';
import { formatNPR } from '../../../utils/nprFormat';
import {
  Plus,
  Trash2,
  X,
  Wrench,
  RotateCcw,
} from 'lucide-react';

/**
 * ConsumableIssuePanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const ConsumableIssuePanel: React.FC = () => {
  const { activeTab, allowedBranches, alertDialog, branches, currentUser, customers, ensureBsDateAvailable, locations, onCreateOperation, products, stock, userBranchId, validateSourceBranchStockAndSerials } = useStockOperationsCtx();

  const consumableProducts = useMemo(
    () => products.filter((p) => (p.productGroup || 'Product Item') === 'Consumable Item'),
    [products]
  );


  const [consumableBranchId, setConsumableBranchId] = useState<string>(userBranchId);
  const [consumableTechnician, setConsumableTechnician] = useState<string>('Field Splicing Technician');
  const [consumableWorkOrder, setConsumableWorkOrder] = useState<string>('WO-2081-SPLIT-01');
  const [consumableReason, setConsumableReason] = useState<string>('Field fiber splicing & customer drop installation material usage');
  const [consumableItems, setConsumableItems] = useState<ConsumableIssueItem[]>([]);
  // Dismissible "Consumables Operational Rule" banner (resets on reload —
  // intentionally not persisted so new sessions see the rule once).
  const [isConsumableRuleBannerVisible, setIsConsumableRuleBannerVisible] = useState(true);

  // Consumable Items Handlers
  const handleResetConsumableForm = () => {
    setConsumableItems([]);
    setConsumableBranchId(userBranchId);
    setConsumableTechnician('Field Splicing Technician');
    setConsumableWorkOrder('WO-2081-SPLIT-01');
    setConsumableReason('Field fiber splicing & customer drop installation material usage');
  };

  const handleAddConsumableItem = (prodId?: string) => {
    // Only 'Consumable Item' group products are issuable on this requisition.
    const selProd = consumableProducts.find((p) => p.id === prodId) || consumableProducts[0];
    if (!selProd) return;

    const existingItem = consumableItems.find((i) => i.productId === selProd.id);
    if (existingItem) {
      handleUpdateConsumableItem(existingItem.id, { quantity: existingItem.quantity + 1 });
      return;
    }

    setConsumableItems([
      ...consumableItems,
      {
        id: `cni-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        productId: selProd.id,
        productName: selProd.name,
        sku: selProd.sku,
        unit: selProd.unit,
        quantity: 5,
        unitCost: selProd.costPrice,
        totalValue: 5 * selProd.costPrice,
        usedAtType: 'FIELD',
      },
    ]);
  };

  const handleUpdateConsumableItem = (id: string, updates: Partial<ConsumableIssueItem>) => {
    setConsumableItems(
      consumableItems.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...updates };
        if (updates.productId) {
          const selProd = products.find((p) => p.id === updates.productId);
          if (selProd) {
            updated.productName = selProd.name;
            updated.sku = selProd.sku;
            updated.unit = selProd.unit;
            updated.unitCost = selProd.costPrice;
          }
        }
        if (updates.quantity !== undefined || updates.unitCost !== undefined) {
          updated.totalValue = updated.quantity * updated.unitCost;
        }
        return updated;
      })
    );
  };

  const handleRemoveConsumableItem = (id: string) => {
    setConsumableItems(consumableItems.filter((i) => i.id !== id));
  };


  // 6. Submit Consumable Issue to Technician / Work Order Field Usage
  const handleSubmitConsumableIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (consumableItems.length === 0) {
      alertDialog('Please add at least one consumable item to issue.');
      return;
    }

    const branchObj = branches.find((b) => b.id === consumableBranchId);

    if (
      !validateSourceBranchStockAndSerials(
        consumableBranchId,
        branchObj?.name || consumableBranchId,
        consumableItems.map((i) => ({
          productId: i.productId,
          productName: i.productName,
          quantity: i.quantity,
        }))
      )
    ) {
      return;
    }

    const grandTotal = consumableItems.reduce((sum, item) => sum + item.totalValue, 0);

    // Compact per-line destination summary embedded in the reason (shown in
    // registers that render only the operation-level reason text).
    const usedAtSummary = consumableItems
      .map((item) => {
        if (item.usedAtType === 'POP' && item.usedAtLocationName) return `${item.productName} @ POP ${item.usedAtLocationName}`;
        if (item.usedAtType === 'CUSTOMER' && item.usedAtCustomerName) return `${item.productName} @ ${item.usedAtCustomerName}`;
        return null;
      })
      .filter(Boolean)
      .join('; ');

    try {
      await onCreateOperation({
        type: 'CONSUMABLE_ISSUE',
        branchId: consumableBranchId,
        branchName: branchObj?.name,
        items: consumableItems,
        totalValue: grandTotal,
        technicianName: consumableTechnician,
        workOrderRef: consumableWorkOrder,
        reason: `Consumable Field Issue: WO ${consumableWorkOrder} (${consumableTechnician}) - ${consumableReason}${usedAtSummary ? ` — Used at: ${usedAtSummary}` : ''}`,
        inspectorName: currentUser?.name || 'Store Supervisor',
        status: 'LOGGED',
      });
    } catch {
      // The rejection itself was already surfaced by the global <ToastHost/>
      // (fetchJson broadcasts a toast intent for every failed mutation), so
      // this catch exists only to stop the SUCCESS path below — otherwise the
      // issue would be reported as logged even though the server rejected the
      // write. The line items stay so they can be corrected and retried.
      return;
    }

    alertDialog(`Successfully issued ${consumableItems.length} consumable material line item(s) to Technician ${consumableTechnician} for Work Order ${consumableWorkOrder}!`);
    setConsumableItems([]);
    setConsumableReason('Field fiber splicing & customer drop installation material usage');
  };

  return (
    <>
      {activeTab === 'CONSUMABLE_ISSUE' && (
        <FormCard className="space-y-4">
          {/* Form header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-serif font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <Wrench className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span>Issue Consumable Product</span>
              </h3>
              <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400">
                Issue field materials (splitters, sleeves, couplers, connectors) to technicians against a work order — stock is deducted from the source store immediately.
              </p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
              Quantity Store Requisition
            </span>
          </div>

          <form onSubmit={handleSubmitConsumableIssue} className="space-y-4 text-xs">
            {/* Dismissible operational-rule banner */}
            {isConsumableRuleBannerVisible && (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-900 dark:text-amber-200 text-[11px] leading-relaxed flex items-start justify-between gap-3">
                <span>
                  <strong>Consumables Operational Rule:</strong> Field materials (Splitters, Protection Sleeves, Couplers, Fast Connectors, Patch Cords, Drop Clamps) do NOT carry individual serial numbers. Issuing deducts store stock directly and logs the assigned field technician and work order ticket.
                </span>
                <button
                  type="button"
                  onClick={() => setIsConsumableRuleBannerVisible(false)}
                  className="shrink-0 p-1 rounded-lg cursor-pointer text-amber-500 hover:text-amber-700 hover:bg-amber-100 dark:text-amber-400 dark:hover:text-amber-200 dark:hover:bg-amber-900/40"
                  title="Dismiss this notice"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-bold mb-1">Source Store Branch *</label>
                <select
                  value={consumableBranchId}
                  onChange={(e) => setConsumableBranchId(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold mb-1">Field Technician Name *</label>
                <input
                  type="text"
                  required
                  value={consumableTechnician}
                  onChange={(e) => setConsumableTechnician(e.target.value)}
                  placeholder="e.g. Ram Bahadur (Splicing Tech)"
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>

              <div>
                <label className="block font-bold mb-1">Work Order / Ticket Ref *</label>
                <input
                  type="text"
                  required
                  value={consumableWorkOrder}
                  onChange={(e) => setConsumableWorkOrder(e.target.value)}
                  placeholder="e.g. WO-2081-SPLIT-04"
                  className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                />
              </div>
            </div>

            {/* Multi-Item Consumables Requisition Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Consumable Material / SKU to Add *</label>
                <ProductSearchBar
                  products={consumableProducts}
                  onAddOrIncrementProduct={(prod) => handleAddConsumableItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Consumable Product / SKU to Issue..."
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Consumable Material Line Items ({consumableItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddConsumableItem()}
                  className="px-3 py-1 rounded-lg bg-amber-600 text-white font-bold text-[11px] hover:bg-amber-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Material Line Item</span>
                </button>
              </div>

              {consumableItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <Wrench className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No consumable materials added to this requisition form yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddConsumableItem()}
                    className={`mt-2 text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add consumable products to issue
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Consumable Material</th>
                        <th className="px-2.5 py-1.5 text-center">Store Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Issue Qty</th>
                        <th className="px-2.5 py-1.5">Used At (POP / Customer)</th>
                        <th className="px-2.5 py-1.5">Remarks</th>
                        <th className="px-2.5 py-1.5 text-right">Unit Cost (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Total Cost (NPR)</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {consumableItems.map((item) => {
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === consumableBranchId);

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5">
                              <select
                                value={item.productId}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { productId: e.target.value })}
                                className={`w-full rounded-lg border p-1.5 font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    [{p.sku}] {p.name} ({p.unit})
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td className="p-2.5 text-center font-mono font-bold text-slate-500">
                              {stk?.quantityOnHand || 0} {item.unit}
                            </td>

                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                required
                                value={item.quantity}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            {/* Per-line Used-At destination: Field / POP Location / Customer */}
                            <td className="p-2.5">
                              <div className="space-y-1 min-w-[180px]">
                                <select
                                  value={item.usedAtType || 'FIELD'}
                                  onChange={(e) => {
                                    const t = e.target.value as ConsumableIssueItem['usedAtType'];
                                    handleUpdateConsumableItem(item.id, {
                                      usedAtType: t,
                                      usedAtLocationId: t === 'POP' ? item.usedAtLocationId : undefined,
                                      usedAtLocationName: t === 'POP' ? item.usedAtLocationName : undefined,
                                      usedAtCustomerId: t === 'CUSTOMER' ? item.usedAtCustomerId : undefined,
                                      usedAtCustomerName: t === 'CUSTOMER' ? item.usedAtCustomerName : undefined,
                                    });
                                  }}
                                  className={`w-full rounded-lg border p-1 text-[10px] font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                >
                                  <option value="FIELD">Field / Work Order</option>
                                  <option value="POP">POP Location</option>
                                  <option value="CUSTOMER">Customer</option>
                                </select>
                                {item.usedAtType === 'POP' && (
                                  <select
                                    value={item.usedAtLocationId || ''}
                                    onChange={(e) => {
                                      const loc = locations.find((l) => l.id === e.target.value);
                                      handleUpdateConsumableItem(item.id, {
                                        usedAtLocationId: loc?.id,
                                        usedAtLocationName: loc?.name,
                                      });
                                    }}
                                    className={`w-full rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                  >
                                    <option value="">Select POP location...</option>
                                    {locations
                                      .filter((l) => l.type === 'POP_SERVER_ROOM' || l.type === 'FIBER_NETWORK_NODE' || !l.type)
                                      .map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name}{l.address ? ` — ${l.address}` : ''}
                                        </option>
                                      ))}
                                  </select>
                                )}
                                {item.usedAtType === 'CUSTOMER' && (
                                  <select
                                    value={item.usedAtCustomerId || ''}
                                    onChange={(e) => {
                                      const cust = customers.find((c) => c.id === e.target.value);
                                      handleUpdateConsumableItem(item.id, {
                                        usedAtCustomerId: cust?.id,
                                        usedAtCustomerName: cust ? `${cust.customerName} (${cust.customerId})` : undefined,
                                      });
                                    }}
                                    className={`w-full rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                                  >
                                    <option value="">Select customer...</option>
                                    {customers.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.customerName} ({c.customerId})
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            </td>

                            {/* Per-line remarks */}
                            <td className="p-2.5">
                              <input
                                type="text"
                                value={item.remarks || ''}
                                onChange={(e) => handleUpdateConsumableItem(item.id, { remarks: e.target.value })}
                                placeholder="Circuit ID, notes..."
                                className={`w-full min-w-[120px] rounded-lg border p-1 text-[10px] bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right font-mono text-slate-500">
                              {formatNPR(item.unitCost)}
                            </td>

                            <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                              {formatNPR(item.totalValue)}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveConsumableItem(item.id)}
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
              <label className="block font-bold mb-1">Field Usage Description / Notes</label>
              <textarea
                rows={2}
                value={consumableReason}
                onChange={(e) => setConsumableReason(e.target.value)}
                placeholder="Reason or site location for material issue..."
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleResetConsumableForm}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="flex-1 py-3 rounded-xl font-bold text-xs text-white bg-amber-600 hover:bg-amber-500 shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <Wrench className="h-4 w-4" />
                <span>Record Multi-Item Consumable Issue & Deduct Stock</span>
              </button>
            </div>
          </form>

          {/* Logged Consumable Field Issues table REMOVED — the Consumables
              Register tab is the single home for issued-consumable history. */}
        </FormCard>
      )}
    </>
  );
};
