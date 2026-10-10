import React, { useState } from 'react';
import {
  Shipment,
  ShipmentItem,
  Product,
  Branch,
  InventoryStock,
  User,
  CustomerDeviceRecord,
} from '../../types';
import { ensureBSDayForAD } from '../../utils/nepaliCalendar';
import { getAllowedBranches } from '../../utils/permissions';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import { Plus, Send, Barcode, Boxes, Trash2 } from 'lucide-react';
import { FormCard } from '../../components/common/FormCard';
import { useDialog } from '../../components/common/DialogProvider';
import { useDarkMode } from '../../contexts/DarkModeContext';

export interface ShipmentFormLine {
  productId: string;
  quantitySent: number;
  deviceSerials: { deviceSerial: string; ponSerial?: string }[];
}

/**
 * Create-shipment sub-component (Shipments decomposition, 2026-10-09).
 *
 * The strict inter-branch transfer form: branch pair, barcode fast entry,
 * multi-line bin with per-unit serials, validation and waybill dispatch.
 * The draft BIN (lines) is owned by the host Shipments component so the
 * CREATE tab badge keeps counting it while this form is hidden; everything
 * else (branch pair, notes) lives here and survives sub-tab switches via
 * the host's KeepMounted wrapper.
 */
interface CreateShipmentFormProps {
  currentUser?: User | null;
  branches: Branch[];
  products: Product[];
  stock: InventoryStock[];
  customerDevices?: CustomerDeviceRecord[];
  /** Draft transfer bin — host-owned so the tab badge can count it. */
  lines: ShipmentFormLine[];
  setLines: React.Dispatch<React.SetStateAction<ShipmentFormLine[]>>;
  onCreateShipment: (shipment: Omit<Shipment, 'id' | 'trackingCode'>) => Promise<void>;
  /** Floating toast sink (the host renders the toast). */
  onShowToast: (msg: string) => void;
  /** Flip the host back to the REGISTER sub-tab (Cancel / after submit). */
  onDone: () => void;
}

export const CreateShipmentForm: React.FC<CreateShipmentFormProps> = ({
  currentUser,
  branches,
  products,
  stock,
  customerDevices = [],
  lines,
  setLines,
  onCreateShipment,
  onShowToast: showToast,
  onDone,
}) => {
  const { isDarkMode } = useDarkMode();
  const { alert: alertDialog } = useDialog();

  // Form State - Strict Inter-Branch Stock Transfer
  const [sourceBranchId, setSourceBranchId] = useState(branches[0]?.id || 'WH001');
  const [destinationBranchId, setDestinationBranchId] = useState(branches[1]?.id || 'WH002');
  const [notes, setNotes] = useState('');

  // Helper to generate serial pairs for a product
  const generateSerialsForProduct = (prod?: Product, qty: number = 1) => {
    const serials = [];
    const sku = prod?.sku || 'SKU';
    for (let i = 0; i < qty; i++) {
      serials.push({
        deviceSerial: `SN-${sku}-${Math.floor(100000 + Math.random() * 900000)}`,
        ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
      });
    }
    return serials;
  };

  const getSourceStock = (pId: string, bId: string) => {
    const item = stock.find((s) => s.productId === pId && s.branchId === bId);
    return item ? item.quantityOnHand : 0;
  };

  const addLine = () => {
    const existingIds = new Set(lines.map((l) => l.productId));
    const nextProd = products.find((p) => !existingIds.has(p.id)) || products[0];
    setLines([
      ...lines,
      {
        productId: nextProd?.id || '',
        quantitySent: 1,
        deviceSerials: generateSerialsForProduct(nextProd, 1),
      },
    ]);
  };

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const updateLineProduct = (index: number, newProductId: string) => {
    const updated = [...lines];
    const prod = products.find((p) => p.id === newProductId);
    const qty = updated[index].quantitySent || 1;
    updated[index] = {
      productId: newProductId,
      quantitySent: qty,
      deviceSerials: generateSerialsForProduct(prod, qty),
    };
    setLines(updated);
  };

  const updateLineQuantity = (index: number, newQty: number) => {
    const qty = Math.max(1, newQty);
    const updated = [...lines];
    const line = updated[index];
    const prod = products.find((p) => p.id === line.productId);
    const currentSerials = [...(line.deviceSerials || [])];

    while (currentSerials.length < qty) {
      currentSerials.push({
        deviceSerial: `SN-${prod?.sku || 'SKU'}-${Math.floor(100000 + Math.random() * 900000)}`,
        ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
      });
    }
    if (currentSerials.length > qty) {
      currentSerials.length = qty;
    }

    updated[index] = {
      ...line,
      quantitySent: qty,
      deviceSerials: currentSerials,
    };
    setLines(updated);
  };

  const updateLineDeviceSerial = (lineIdx: number, sIdx: number, val: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[sIdx] = { ...serials[sIdx], deviceSerial: val };
    updated[lineIdx] = { ...updated[lineIdx], deviceSerials: serials };
    setLines(updated);
  };

  const updateLinePonSerial = (lineIdx: number, sIdx: number, val: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[sIdx] = { ...serials[sIdx], ponSerial: val };
    updated[lineIdx] = { ...updated[lineIdx], deviceSerials: serials };
    setLines(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) return;

    const todayAD = new Date().toISOString().split('T')[0];
    // BS dates are mandatory: auto-resolve from the synced seeded calendar
    // and block the dispatch when it has no exact record for today.
    const dispatchDateBS = ensureBSDayForAD(todayAD);
    if (!dispatchDateBS) {
      alertDialog(`BS date is not available for ${todayAD}. Please contact your system administrator for BS month seeding.`);
      return;
    }
    const srcBranch = branches.find((b) => b.id === sourceBranchId);
    const destBranch = branches.find((b) => b.id === destinationBranchId);

    // Validate Branch Stock Quantity & Serial Register for Source Branch
    const seenSerials = new Set<string>();
    for (const l of lines) {
      const prod = products.find((p) => p.id === l.productId);
      const prodName = prod?.name || 'Item';
      const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;
      const srcStock = stock.find((s) => s.productId === l.productId && s.branchId === sourceBranchId);
      const availStock = srcStock ? srcStock.quantityOnHand : 0;

      if (availStock < l.quantitySent) {
        alertDialog(`Branch Stock Error: "${srcBranch?.name || sourceBranchId}" only has ${availStock} unit(s) of "${prodName}" on hand, but ${l.quantitySent} unit(s) are requested for transfer shipment.`);
        return;
      }

      if (isSerialized) {
        if (!l.deviceSerials || l.deviceSerials.length < l.quantitySent) {
          alertDialog(`Validation Error: Please enter serial numbers for all ${l.quantitySent} unit(s) of "${prodName}".`);
          return;
        }
        for (let sIdx = 0; sIdx < l.quantitySent; sIdx++) {
          const s = l.deviceSerials[sIdx];
          if (!s || !s.deviceSerial?.trim()) {
            alertDialog(`Validation Error: Device Serial # is required for "${prodName}" (Unit #${sIdx + 1}).`);
            return;
          }
          const cleanSerial = s.deviceSerial.trim().toUpperCase();
          const cleanPon = s.ponSerial?.trim().toUpperCase();

          if (seenSerials.has(cleanSerial)) {
            alertDialog(`Validation Error: Duplicate Device Serial #${cleanSerial} detected in shipment lines.`);
            return;
          }
          seenSerials.add(cleanSerial);

          if (customerDevices.length > 0) {
            const match = customerDevices.find(
              (cd) =>
                cd.deviceSerial.trim().toUpperCase() === cleanSerial ||
                (cleanPon && cd.ponSerial && cd.ponSerial.trim().toUpperCase() === cleanPon)
            );

            if (match) {
              if (match.branchId !== sourceBranchId) {
                const regBranch = branches.find((b) => b.id === match.branchId);
                alertDialog(`Serial Register Error: Serial #${cleanSerial} is registered to branch "${regBranch?.name || match.branchId}", not "${srcBranch?.name || sourceBranchId}".`);
                return;
              }
              if (match.status && match.status !== 'IN_STOCK') {
                alertDialog(`Serial Register Error: Serial #${cleanSerial} in branch "${srcBranch?.name || sourceBranchId}" has status "${match.status}" (must be "IN_STOCK").`);
                return;
              }
            } else {
              const branchInStockSerials = customerDevices.filter(
                (cd) => cd.branchId === sourceBranchId && cd.status === 'IN_STOCK'
              );
              if (branchInStockSerials.length > 0) {
                alertDialog(`Serial Register Error: Serial #${cleanSerial} for "${prodName}" is not found in the branch serial register for "${srcBranch?.name || sourceBranchId}".`);
                return;
              }
            }
          }
        }
      }
    }

    const items: ShipmentItem[] = lines.map((l, idx) => {
      const prod = products.find((p) => p.id === l.productId);
      return {
        id: `sh-item-${Date.now()}-${idx}`,
        productId: l.productId,
        productName: prod?.name || 'Item',
        sku: prod?.sku || 'SKU',
        quantitySent: Number(l.quantitySent),
        deviceSerials: l.deviceSerials,
      };
    });

    await onCreateShipment({
      type: 'INTER_BRANCH',
      sourceBranchId,
      sourceBranchName: srcBranch?.name || 'Source Branch',
      destinationBranchId,
      destinationBranchName: destBranch?.name || 'Destination Branch',
      dispatchDateAD: todayAD,
      dispatchDateBS,
      estimatedArrivalAD: new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
      status: 'IN_TRANSIT',
      items,
      notes,
    });

    showToast(`Warehouse stock transfer & dispatch created successfully for ${destBranch?.name || 'destination branch'}!`);
    setNotes('');
    setLines([]);
    onDone();
  };

  return (
    <FormCard className="p-0 space-y-0 overflow-hidden">
      {/* Form header — names the form per the StockOperations form-header
          pattern; the slim "Switch to Register" action stays on the right. */}
      <div className={`flex items-start justify-between gap-3 p-4 border-b ${
        isDarkMode ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'
      }`}>
        <div>
          <h3 className="font-serif font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white">
            <Send className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <span>Create Shipment</span>
          </h3>
          <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400">
            Select source and destination, scan or search products to add dispatch lines, then generate the waybill.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDone()}
          className={`shrink-0 px-3 py-1.5 rounded-xl border text-xs font-semibold cursor-pointer ${
            isDarkMode
              ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
              : 'border-slate-200 text-slate-600 hover:bg-slate-100'
          }`}
        >
          Switch to Register List
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        {/* 12-col alignment pattern (matches PO / Purchase Bill forms):
            Row 1 = From + To, each 6/12 on lg. Fixed h-9 keeps baselines level. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-4 bg-slate-50 dark:bg-slate-900/40 p-4 rounded-xl border border-slate-200 dark:border-slate-800/80">
          <div className="lg:col-span-6">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              From (Source Branch / Warehouse)
            </label>
            <select
              value={sourceBranchId}
              onChange={(e) => setSourceBranchId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 h-9 text-xs font-semibold text-slate-900 dark:text-slate-100"
            >
              {getAllowedBranches(currentUser, branches).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-6">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              To (Destination Branch / Customer Location)
            </label>
            <select
              value={destinationBranchId}
              onChange={(e) => setDestinationBranchId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 h-9 text-xs font-semibold text-slate-900 dark:text-slate-100"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Barcode & SKU Fast Entry Search Bar */}
        <div className="bg-indigo-50/60 dark:bg-indigo-950/30 p-4 rounded-xl border border-indigo-200 dark:border-indigo-800/60 space-y-2">
          <label className="block text-xs font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5">
            <Barcode className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
            <span>Scan Barcode or Search Product to Add Transfer Line:</span>
          </label>
          <ProductSearchBar
            products={products}
            placeholder="🔍 Scan barcode or type item SKU / name to add transfer line..."
            onAddOrIncrementProduct={(product) => {
              setLines((prev) => {
                const existingIdx = prev.findIndex((l) => l.productId === product.id);
                if (existingIdx >= 0) {
                  const updated = [...prev];
                  const existing = updated[existingIdx];
                  const newQty = existing.quantitySent + 1;
                  const currentSerials = [...(existing.deviceSerials || [])];
                  currentSerials.push({
                    deviceSerial: `SN-${product.sku}-${Math.floor(100000 + Math.random() * 900000)}`,
                    ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
                  });
                  updated[existingIdx] = {
                    ...existing,
                    quantitySent: newQty,
                    deviceSerials: currentSerials,
                  };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    productId: product.id,
                    quantitySent: 1,
                    deviceSerials: generateSerialsForProduct(product, 1),
                  },
                ];
              });
            }}
          />
        </div>

        {/* Items List */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <Boxes className={`h-4 w-4 ${isDarkMode ? 'text-indigo-400' : 'text-indigo-500'}`} />
              <span>Transfer Line Items ({lines.length})</span>
            </h4>
            <button
              type="button"
              onClick={addLine}
              className="flex items-center gap-1 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer bg-indigo-50 dark:bg-indigo-950/50 px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800/50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Item Line</span>
            </button>
          </div>

          {lines.length === 0 ? (
            <div className="p-8 text-center rounded-2xl border-2 border-dashed border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/30 dark:bg-indigo-950/20 space-y-2">
              <Boxes className="h-8 w-8 text-indigo-400 mx-auto" />
              <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
                Transfer Bin is Empty
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                Scan barcodes or search item names above to add products into this transfer dispatch, or click <strong className="text-indigo-600 dark:text-indigo-400">+ Add Item Line</strong> to choose manually.
              </p>
            </div>
          ) : (
            <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1.5">
              {lines.map((line, idx) => {
                const availableStock = getSourceStock(line.productId, sourceBranchId);
                const prod = products.find((p) => p.id === line.productId);
                return (
                  <div
                    key={idx}
                    className="bg-slate-50 dark:bg-slate-900/60 p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3 text-xs"
                  >
                    <div className="grid grid-cols-12 gap-3 items-center">
                      <div className="col-span-6">
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Product Item</label>
                        <select
                          value={line.productId}
                          onChange={(e) => updateLineProduct(idx, e.target.value)}
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs text-slate-900 dark:text-slate-100 font-medium"
                        >
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              [{p.sku}] {p.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="col-span-3 text-center">
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Available Stock</label>
                        <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                          {availableStock} Units
                        </span>
                      </div>

                      <div className="col-span-2">
                        <label className="block text-[10px] font-semibold text-slate-400 mb-0.5">Transfer Qty</label>
                        <input
                          type="number"
                          min={1}
                          required
                          value={line.quantitySent}
                          onChange={(e) => updateLineQuantity(idx, Number(e.target.value))}
                          className="w-full text-center font-mono font-bold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs text-slate-900 dark:text-white"
                        />
                      </div>

                      <div className="col-span-1 text-center pt-3">
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className={`p-1 ${isDarkMode ? 'text-slate-400 hover:text-rose-400' : 'text-slate-400 hover:text-rose-500'} cursor-pointer`}
                          title="Remove item line"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* Expandable Device Serial & PON Serial Fields per Unit */}
                    <div className="bg-indigo-50/50 dark:bg-indigo-950/40 p-3 rounded-lg border border-indigo-100 dark:border-indigo-900/50 space-y-2">
                      <div className="text-[11px] font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5">
                        <Barcode className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
                        <span>Serial Numbers for {prod?.name || 'Item'} (Qty: {line.quantitySent})</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {Array.from({ length: line.quantitySent }).map((_, sIdx) => (
                          <div key={sIdx} className="bg-white dark:bg-slate-900 p-2 rounded-lg border border-indigo-200 dark:border-indigo-800 flex items-center gap-2">
                            <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                            <div className="flex-1 min-w-0">
                              <input
                                type="text"
                                placeholder="Device Serial #"
                                value={line.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                onChange={(e) => updateLineDeviceSerial(idx, sIdx, e.target.value)}
                                className="w-full px-2 py-1 text-[11px] font-mono font-bold text-indigo-900 dark:text-indigo-200 bg-indigo-50/50 dark:bg-indigo-950/50 rounded border border-indigo-200 dark:border-indigo-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <input
                                type="text"
                                placeholder="PON Serial #"
                                value={line.deviceSerials?.[sIdx]?.ponSerial || ''}
                                onChange={(e) => updateLinePonSerial(idx, sIdx, e.target.value)}
                                className="w-full px-2 py-1 text-[11px] font-mono font-bold text-blue-900 dark:text-blue-200 bg-blue-50/50 dark:bg-blue-950/50 rounded border border-blue-200 dark:border-blue-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {lines.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50/80 dark:bg-indigo-950/60 rounded-xl border border-indigo-200 dark:border-indigo-900 text-xs text-indigo-900 dark:text-indigo-200">
              <span className="font-semibold">Transfer Bin Summary:</span>
              <span className="font-bold font-mono">
                {lines.length} Product SKU{lines.length > 1 ? 's' : ''} | {lines.reduce((sum, l) => sum + (l.quantitySent || 0), 0)} Total Units
              </span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            Vehicle / Waybill / Transport Notes
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Driver name (License no. Ba 2 Kha 9021)"
            className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
          />
        </div>

        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setLines([])}
            className="px-4 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl cursor-pointer"
          >
            Clear Bin Lines
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onDone()}
              className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 cursor-pointer flex items-center gap-2"
            >
              <Send className="h-4 w-4" />
              <span>Dispatch Stock Transfer & Generate Waybill</span>
            </button>
          </div>
        </div>
      </form>
    </FormCard>
  );
};
