import React, { useState } from 'react';
import { Shipment } from '../../types';
import { AlertCircle, ArrowRight, Barcode, CheckCircle2, PackageCheck, X } from 'lucide-react';

/**
 * Shared receive-verification workflow (de-duplication, 2026-10-09).
 *
 * The Shipment Register (procurement) and the Receive Branch Stock Transfer
 * panel (stockops) used to carry byte-for-byte copies of this handler set +
 * modal (~350 lines each) that had already started to drift. Both now call
 * `useReceiveVerification` for the state/handlers and render
 * `ReceiveVerificationModal` for the UI; only the BS-date gate differs
 * (Register 2 injects StockOperations' `ensureBsDateAvailable`, Register 3
 * has no such gate — same behaviour each always had).
 *
 * The three cancel flows intentionally stay per-register: cancelling a
 * RECEIPT (cancelReceiveShipment) and cancelling an in-transit leg
 * (cancelShipment) are different operations.
 */

export type ReceiveShipmentFn = (
  id: string,
  verificationData?: {
    receivedItems?: {
      itemId: string;
      quantityReceived: number;
      receivedSerials?: { deviceSerial: string; ponSerial?: string }[];
      itemDiscrepancyNotes?: string;
    }[];
    receivedByNotes?: string;
  }
) => Promise<void>;

export interface ReceiveItemState {
  quantityReceived: number;
  verifiedSerials: { deviceSerial: string; ponSerial?: string; isChecked: boolean }[];
  notes: string;
}

export interface ReceiveVerificationController {
  receivingShipmentModal: Shipment | null;
  setReceivingShipmentModal: React.Dispatch<React.SetStateAction<Shipment | null>>;
  receiveItemStates: { [itemId: string]: ReceiveItemState };
  receivingByNotes: string;
  setReceivingByNotes: React.Dispatch<React.SetStateAction<string>>;
  openReceiveModal: (sh: Shipment) => void;
  updateReceiveQty: (itemId: string, qty: number) => void;
  toggleSerialCheck: (itemId: string, sIdx: number) => void;
  updateItemDiscrepancyNotes: (itemId: string, notes: string) => void;
  handleConfirmReceiveVerification: () => Promise<void>;
}

export interface UseReceiveVerificationOptions {
  onReceiveShipment?: ReceiveShipmentFn;
  /** StockOperations' BS-calendar gate — passed by Register 2 only. */
  ensureBsDateAvailable?: () => boolean;
  /** Toast sink for receive failures (the modal stays open so the user can retry). */
  notify?: (msg: string) => void;
}

export function useReceiveVerification({
  onReceiveShipment,
  ensureBsDateAvailable,
  notify,
}: UseReceiveVerificationOptions): ReceiveVerificationController {
  const [receivingShipmentModal, setReceivingShipmentModal] = useState<Shipment | null>(null);
  const [receiveItemStates, setReceiveItemStates] = useState<{ [itemId: string]: ReceiveItemState }>({});
  const [receivingByNotes, setReceivingByNotes] = useState<string>('');

  const openReceiveModal = (sh: Shipment) => {
    setReceivingShipmentModal(sh);
    setReceivingByNotes('');
    const initialStates: { [itemId: string]: ReceiveItemState } = {};
    sh.items?.forEach((item) => {
      initialStates[item.id] = {
        quantityReceived:
          item.quantityReceived !== undefined ? item.quantityReceived : (item.quantitySent || (item as any).quantity || 1),
        verifiedSerials: (item.deviceSerials || []).map((s) => ({
          deviceSerial: s.deviceSerial,
          ponSerial: s.ponSerial || '',
          isChecked: true,
        })),
        notes: item.itemDiscrepancyNotes || '',
      };
    });
    setReceiveItemStates(initialStates);
  };

  const updateReceiveQty = (itemId: string, qty: number) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId] || { quantityReceived: 1, verifiedSerials: [], notes: '' };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          quantityReceived: Math.max(0, qty),
        },
      };
    });
  };

  const toggleSerialCheck = (itemId: string, sIdx: number) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId];
      if (!curr) return prev;
      const updatedSerials = [...curr.verifiedSerials];
      updatedSerials[sIdx] = {
        ...updatedSerials[sIdx],
        isChecked: !updatedSerials[sIdx].isChecked,
      };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          verifiedSerials: updatedSerials,
        },
      };
    });
  };

  const updateItemDiscrepancyNotes = (itemId: string, notes: string) => {
    setReceiveItemStates((prev) => {
      const curr = prev[itemId] || { quantityReceived: 1, verifiedSerials: [], notes: '' };
      return {
        ...prev,
        [itemId]: {
          ...curr,
          notes,
        },
      };
    });
  };

  const handleConfirmReceiveVerification = async () => {
    if (ensureBsDateAvailable && !ensureBsDateAvailable()) return;
    if (!receivingShipmentModal || !onReceiveShipment) return;

    const payloadItems = receivingShipmentModal.items.map((item) => {
      const st = receiveItemStates[item.id];
      const qty = st ? Number(st.quantityReceived) : item.quantitySent || (item as any).quantity || 1;
      const receivedSerials = st
        ? st.verifiedSerials.filter((s) => s.isChecked).map((s) => ({ deviceSerial: s.deviceSerial, ponSerial: s.ponSerial }))
        : item.deviceSerials || [];

      return {
        itemId: item.id,
        quantityReceived: qty,
        receivedSerials,
        itemDiscrepancyNotes: st?.notes || '',
      };
    });

    try {
      await onReceiveShipment(receivingShipmentModal.id, {
        receivedItems: payloadItems,
        receivedByNotes: receivingByNotes,
      });
      setReceivingShipmentModal(null);
    } catch (err: any) {
      notify?.(`Receiving failed: ${err.message || 'Unknown error'}`);
    }
  };

  return {
    receivingShipmentModal,
    setReceivingShipmentModal,
    receiveItemStates,
    receivingByNotes,
    setReceivingByNotes,
    openReceiveModal,
    updateReceiveQty,
    toggleSerialCheck,
    updateItemDiscrepancyNotes,
    handleConfirmReceiveVerification,
  };
}

export const ReceiveVerificationModal: React.FC<{ receive: ReceiveVerificationController }> = ({ receive }) => {
  const {
    receivingShipmentModal,
    receiveItemStates,
    receivingByNotes,
    setReceivingByNotes,
    updateReceiveQty,
    toggleSerialCheck,
    updateItemDiscrepancyNotes,
    setReceivingShipmentModal,
    handleConfirmReceiveVerification,
  } = receive;
  if (!receivingShipmentModal) return null;
  return (
    <>
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 overflow-y-auto">
                <div className={`w-full max-w-4xl rounded-2xl shadow-2xl border overflow-hidden my-6 bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}>
                  <div className={`p-4 border-b flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60`}>
                    <div className="flex items-center gap-2">
                      <PackageCheck className={`h-5 w-5 text-emerald-500 dark:text-emerald-400`} />
                      <div>
                        <h3 className="font-bold text-sm">
                          Inbound Stock Physical Verification — {receivingShipmentModal.trackingCode}
                        </h3>
                        <p className="text-[11px] text-slate-400">
                          Verify physical incoming quantities & device serial/MAC numbers before updating destination branch inventory.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReceivingShipmentModal(null)}
                      className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
      
                  <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
                    {/* Route Summary Card */}
                    <div className={`flex justify-between items-center p-3.5 rounded-xl border text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Dispatched From</span>
                        <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.sourceBranchName || 'Central Warehouse'}</span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="font-mono text-[10px] text-indigo-500 font-bold">{receivingShipmentModal.dispatchDateAD}</span>
                        <ArrowRight className="h-4 w-4 text-indigo-500 my-0.5" />
                        <span className={`text-[10px] text-emerald-600 dark:text-emerald-400 font-bold uppercase`}>Receiving Inspection</span>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Destination Branch</span>
                        <span className="font-bold text-slate-900 dark:text-white text-sm">{receivingShipmentModal.destinationBranchName}</span>
                      </div>
                    </div>
      
                    {/* Security Advisory */}
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                      <AlertCircle className={`h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5`} />
                      <div>
                        <span className="font-bold block">Security Audit Requirement:</span>
                        <span>
                          Receiver branch must count non-serial quantities and physically scan/verify each Device Serial & PON/MAC address unpacked from shipments. Any shortage or unverified unit will be logged as an <strong>In-Transit Discrepancy</strong> for management audit.
                        </span>
                      </div>
                    </div>
      
                    {/* Item Lines Verification Table */}
                    <div className="space-y-3">
                      {receivingShipmentModal.items.map((item, idx) => {
                        const st = receiveItemStates[item.id] || {
                          quantityReceived: item.quantitySent || (item as any).quantity || 1,
                          verifiedSerials: [],
                          notes: '',
                        };
                        const sentQty = item.quantitySent || (item as any).quantity || 1;
                        const diff = st.quantityReceived - sentQty;
                        const hasSerials = item.deviceSerials && item.deviceSerials.length > 0;
      
                        return (
                          <div
                            key={item.id || idx}
                            className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-3 text-xs"
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
                              <div>
                                <div className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
                                  <span>{idx + 1}. {item.productName}</span>
                                  <span className="font-mono text-xs font-semibold text-slate-500">[{item.sku}]</span>
                                </div>
                                <span className="text-[11px] text-slate-500">
                                  Dispatched Quantity: <strong className="text-slate-700 dark:text-slate-300 font-mono">{sentQty} Units</strong>
                                </span>
                              </div>
      
                              {/* Received Qty Entry */}
                              <div className="flex items-center gap-3">
                                <label className="font-bold text-slate-700 dark:text-slate-300">
                                  Actual Received Qty:
                                </label>
                                <input
                                  type="number"
                                  min={0}
                                  max={sentQty * 2}
                                  value={st.quantityReceived}
                                  onChange={(e) => updateReceiveQty(item.id, Number(e.target.value))}
                                  className={`w-20 text-center font-mono font-bold text-sm rounded-lg border p-1.5 focus:ring-2 focus:ring-indigo-500 border-indigo-300 bg-white text-slate-800 dark:border-indigo-700 dark:bg-slate-800 dark:text-slate-100`}
                                />
      
                                {diff === 0 ? (
                                  <span className={`px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold text-[10px] border border-emerald-500/20`}>
                                    ✓ Full Match
                                  </span>
                                ) : diff < 0 ? (
                                  <span className={`px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold text-[10px] border border-amber-500/20`}>
                                    ⚠ Shortage ({diff} Units)
                                  </span>
                                ) : (
                                  <span className={`px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-bold text-[10px] border border-blue-500/20`}>
                                    ℹ Surplus (+{diff} Units)
                                  </span>
                                )}
                              </div>
                            </div>
      
                            {/* Serial Check-Off List for Hardware */}
                            {hasSerials && (
                              <div className="p-3 rounded-lg bg-indigo-50/50 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/40 space-y-2">
                                <div className="flex items-center justify-between">
                                  <span className="font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-1.5 text-[11px]">
                                    <Barcode className={`h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400`} />
                                    <span>Device Serial & MAC/PON Check-Off Checklist ({st.verifiedSerials.filter(s => s.isChecked).length} / {item.deviceSerials?.length} Checked):</span>
                                  </span>
                                </div>
      
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {st.verifiedSerials.map((s, sIdx) => (
                                    <label
                                      key={sIdx}
                                      className={`p-2 rounded-lg border flex items-center gap-2 cursor-pointer transition-colors ${s.isChecked ? 'bg-white border-emerald-300 dark:bg-slate-800 dark:border-emerald-800' : 'bg-rose-50/60 border-rose-200 text-rose-700 dark:bg-rose-950/30 dark:border-rose-900 dark:text-rose-300'}`}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={s.isChecked}
                                        onChange={() => toggleSerialCheck(item.id, sIdx)}
                                        className={`rounded text-indigo-600 dark:text-indigo-400 focus:ring-indigo-500 h-4 w-4`}
                                      />
                                      <div className="flex-1 font-mono text-[11px] min-w-0">
                                        <div className="font-bold text-slate-900 dark:text-slate-100 truncate">
                                          {s.deviceSerial}
                                        </div>
                                        {s.ponSerial && (
                                          <div className={`text-[10px] text-blue-600 dark:text-blue-400 truncate`}>
                                            PON: {s.ponSerial}
                                          </div>
                                        )}
                                      </div>
                                      <span className={`text-[10px] font-bold uppercase ${s.isChecked ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                                        {s.isChecked ? 'Verified' : 'Missing'}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}
      
                            {/* Item Discrepancy Remarks */}
                            <div>
                              <input
                                type="text"
                                placeholder="Discrepancy / Damage notes for this item (if any)..."
                                value={st.notes}
                                onChange={(e) => updateItemDiscrepancyNotes(item.id, e.target.value)}
                                className={`w-full text-xs rounded-lg border px-3 py-1.5 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
      
                    {/* General Receiving Officer Notes */}
                    <div>
                      <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                        Receiving Inspection Officer Notes & Waybill Remarks
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Received by [name] at [branch]. Seal was intact, counted & checked."
                        value={receivingByNotes}
                        onChange={(e) => setReceivingByNotes(e.target.value)}
                        className={`w-full text-xs rounded-xl border px-3 py-1.5 focus:outline-none border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                      />
                    </div>
                  </div>
      
                  {/* Modal Actions Footer */}
                  <div className={`p-4 border-t flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60`}>
                    <button
                      type="button"
                      onClick={() => setReceivingShipmentModal(null)}
                      className="px-4 py-2 rounded-xl text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Cancel
                    </button>
      
                    <button
                      type="button"
                      onClick={handleConfirmReceiveVerification}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-600/30 transition-all cursor-pointer"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>Confirm Physical Receiving & Add to Branch Stock</span>
                    </button>
                  </div>
                </div>
              </div>
    </>
  );
};
