import React, { useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  CustomerDeviceRecord,
} from '../../../types';
import { api } from '../../../services/api';
import { FormCard } from '../../../components/common/FormCard';
import {
  Plus,
  Search,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  XCircle,
} from 'lucide-react';

/**
 * DeviceExchangePanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const DeviceExchangePanel: React.FC = () => {
  const { activeTab, alertDialog, customerDevices, ensureBsDateAvailable, exchangeCustomerDevices, isLoadingExchangeDevices, products, selectedBranchId, setExchangeCustomerDevices } = useStockOperationsCtx();

  const [selectedDeviceForExchange, setSelectedDeviceForExchange] = useState<CustomerDeviceRecord | null>(null);
  const [exchangeSearchQuery, setExchangeSearchQuery] = useState<string>('');
  const [exchangeReason, setExchangeReason] = useState<string>('Defective / Hardware Fault (No Power / Optical Loss)');
  const [oldDeviceAction, setOldDeviceAction] = useState<'DAMAGE' | 'RESTOCK' | 'DISPOSED'>('RESTOCK');
  const [exchangeProductName, setExchangeProductName] = useState<string>('');
  const [exchangeNewSerial, setExchangeNewSerial] = useState<string>('');
  const [exchangeNewPon, setExchangeNewPon] = useState<string>('');
  const [exchangeNewMac, setExchangeNewMac] = useState<string>('');
  const [exchangeNotes, setExchangeNotes] = useState<string>('');

  const [isSubmittingExchange, setIsSubmittingExchange] = useState<boolean>(false);

  const handlePerformExchange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!selectedDeviceForExchange) {
      alertDialog('Please select a customer device to exchange.');
      return;
    }
    if (!exchangeNewSerial.trim() || !exchangeNewPon.trim()) {
      alertDialog('Please enter new device serial number (SN) and PON serial number.');
      return;
    }
    const exchangeBranchId = selectedBranchId === 'ALL' ? selectedDeviceForExchange.branchId : selectedBranchId;
    const replacementDevice = customerDevices.find(
      (device) =>
        device.deviceSerial?.trim().toUpperCase() === exchangeNewSerial.trim().toUpperCase() &&
        device.ponSerial?.trim().toUpperCase() === exchangeNewPon.trim().toUpperCase() &&
        device.branchId === exchangeBranchId &&
        device.status === 'IN_STOCK' &&
        device.productName?.trim().toLowerCase() === (exchangeProductName || selectedDeviceForExchange.productName).trim().toLowerCase()
    );
    if (!replacementDevice) {
      alertDialog('The replacement Device Serial/PON pair must match an IN_STOCK device at the selected branch.');
      return;
    }

    setIsSubmittingExchange(true);
    try {
      await api.exchangeCustomerDevice({
        oldDeviceId: selectedDeviceForExchange.id,
        exchangeReason,
        oldDeviceAction,
        newProductName: exchangeProductName || selectedDeviceForExchange.productName,
        newDeviceSerial: exchangeNewSerial.trim(),
        newPonSerial: exchangeNewPon.trim(),
        newMacAddress: exchangeNewMac.trim() || undefined,
        notes: exchangeNotes.trim() || undefined,
        branchId: exchangeBranchId,
      });

      const actionText =
        oldDeviceAction === 'RESTOCK'
          ? 'Old device serial restored to branch available inventory stock (+1)'
          : oldDeviceAction === 'DAMAGE'
          ? 'Old device serial moved to defective stock bin'
          : 'Old device serial marked as scrapped/disposed';

      alertDialog(`Device Exchange Successful!\nCustomer: ${selectedDeviceForExchange.customerName}\nNew Serial: ${exchangeNewSerial.trim()}\n${actionText}`);

      setSelectedDeviceForExchange(null);
      setExchangeNewSerial('');
      setExchangeNewPon('');
      setExchangeNewMac('');
      setExchangeNotes('');

      // Refresh list
      const updatedDevs = await api.getCustomerDevices(selectedBranchId === 'ALL' ? undefined : selectedBranchId);
      setExchangeCustomerDevices(updatedDevs);
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (err: any) {
      alertDialog(err?.message || 'Failed to exchange device.');
    } finally {
      setIsSubmittingExchange(false);
    }
  };

  const filteredExchangeDevices = exchangeCustomerDevices.filter((d) => {
    // Only RENTAL (or legacy ACTIVE) CPE products are eligible for hardware exchange
    if (d.status !== 'RENTAL' && d.status !== 'ACTIVE') return false;
    if (!exchangeSearchQuery.trim()) return true;
    const q = (exchangeSearchQuery || '').toLowerCase();
    return (
      (d?.customerName || '').toLowerCase().includes(q) ||
      (d?.customerCode || '').toLowerCase().includes(q) ||
      (d?.deviceSerial || '').toLowerCase().includes(q) ||
      (d?.ponSerial || '').toLowerCase().includes(q) ||
      (d?.productName || '').toLowerCase().includes(q) ||
      (d.contactPhone && d.contactPhone.includes(q))
    );
  });

  return (
    <>
      {activeTab === 'DEVICE_EXCHANGE' && (
        <FormCard className="space-y-4">
          <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-2xl bg-indigo-600 text-white">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-base font-bold flex items-center gap-2">
                  <span>Customer Hardware Replacement & Exchange</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Swap customer routers/ONUs/STBs, assign new replacement serials, and return old serial units back to branch inventory stock.
                </p>
              </div>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800">
              {exchangeCustomerDevices.length} Active Deployed Units
            </span>
          </div>

          <form onSubmit={handlePerformExchange} className="space-y-5 text-xs">
            {/* Step 1: Select Installed Customer Device */}
            <div className={`p-4 rounded-2xl border space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <div className="flex items-center justify-between">
                <h4 className={`font-bold text-xs flex items-center gap-2 text-slate-800 dark:text-slate-200`}>
                  <Search className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                  <span>Step 1: Select Installed Customer Device (Search Master Directory / Installed Stock) *</span>
                </h4>
                {selectedDeviceForExchange && (
                  <button
                    type="button"
                    onClick={() => setSelectedDeviceForExchange(null)}
                    className={`text-[11px] text-rose-500 dark:text-rose-400 hover:underline font-bold cursor-pointer`}
                  >
                    Clear Selection
                  </button>
                )}
              </div>

              {!selectedDeviceForExchange ? (
                <div className="space-y-3">
                  <div className="p-2.5 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-indigo-900 dark:text-indigo-200 text-xs font-medium flex items-center justify-between">
                    <span>🔄 <strong>Rental CPE Warranty Exchange Filter</strong>: Only customers with active <strong>RENTAL</strong> devices are eligible for exchange. Sold devices are customer-owned.</span>
                  </div>

 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search customer name, customer ID code, rental serial number (SN), or PON serial..."
                      value={exchangeSearchQuery}
                      onChange={(e) => setExchangeSearchQuery(e.target.value)}
                      className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs font-semibold border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white`}
                    />
                  </div>

                  <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    {isLoadingExchangeDevices ? (
                      <div className="p-4 text-center text-slate-400 text-xs">Loading customer devices...</div>
                    ) : filteredExchangeDevices.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 text-xs">No active RENTAL customer devices match your search query. (Sold products are excluded from device exchange).</div>
                    ) : (
                      filteredExchangeDevices.map((dev) => (
                        <div
                          key={dev.id}
                          onClick={() => {
                            setSelectedDeviceForExchange(dev);
                            setExchangeProductName(dev.productName);
                            setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`);
                            setExchangeNewPon(`HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`);
                            setExchangeNewMac('00:1A:2B:3C:4D:5E');
                          }}
                          className="p-3 text-left hover:bg-indigo-50 dark:hover:bg-indigo-950/60 cursor-pointer transition-all flex items-center justify-between"
                        >
                          <div>
                            <div className="font-bold text-xs text-slate-900 dark:text-white flex items-center gap-2">
                              <span>{dev.customerName}</span>
                              <span className={`font-mono text-indigo-600 dark:text-indigo-400 text-[11px]`}>({dev.customerCode})</span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              Model: <strong>{dev.productName}</strong> | SN: <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{dev.deviceSerial}</span> | PON: <span className="font-mono text-slate-600 dark:text-slate-400">{dev.ponSerial}</span>
                            </div>
                            {dev.installationAddress && (
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                📍 {dev.installationAddress}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className="px-3 py-1 rounded-lg bg-indigo-600 text-white font-bold text-[11px] shrink-0"
                          >
                            Select Device
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-xs">
                  <div className="flex items-center justify-between font-bold text-indigo-950 dark:text-indigo-200">
                    <span>Target Customer: {selectedDeviceForExchange.customerName} ({selectedDeviceForExchange.customerCode})</span>
                    <span>Contact: {selectedDeviceForExchange.contactPhone || 'N/A'}</span>
                  </div>
                  <div className="mt-2 text-slate-700 dark:text-slate-300 text-[11px] grid grid-cols-2 gap-2">
                    <div>
                      <strong>Installed Product:</strong> {selectedDeviceForExchange.productName}
                    </div>
                    <div>
                      <strong>Address:</strong> {selectedDeviceForExchange.installationAddress || 'N/A'}
                    </div>
                    <div>
                      <strong>Old Device Serial (SN):</strong> <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-300`}>{selectedDeviceForExchange.deviceSerial}</span>
                    </div>
                    <div>
                      <strong>Old PON Serial:</strong> <span className={`font-mono font-bold text-indigo-600 dark:text-indigo-300`}>{selectedDeviceForExchange.ponSerial}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Step 2: Old Serial Disposition */}
            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                Step 2: Old Device Disposition (Return Serial Unit Handling) *
              </label>
              <div className="grid grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => setOldDeviceAction('RESTOCK')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'RESTOCK'
                      ? 'bg-emerald-50 dark:bg-emerald-950/80 border-emerald-500 text-emerald-900 dark:text-emerald-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <CheckCircle2 className={`h-4 w-4 text-emerald-500 dark:text-emerald-400`} />
                    <span>Put Back to Available Inventory (+1 Stock)</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Return tested working device back to branch store stock for re-issue
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setOldDeviceAction('DAMAGE')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'DAMAGE'
                      ? 'bg-rose-50 dark:bg-rose-950/80 border-rose-500 text-rose-900 dark:text-rose-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <AlertTriangle className={`h-4 w-4 text-rose-500 dark:text-rose-400`} />
                    <span>Move to Defective Stock Bin</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Move hardware unit to branch damaged bin for RMA repair
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setOldDeviceAction('DISPOSED')}
                  className={`p-3.5 rounded-2xl border text-left cursor-pointer transition-all ${
                    oldDeviceAction === 'DISPOSED'
                      ? 'bg-amber-50 dark:bg-amber-950/80 border-amber-500 text-amber-900 dark:text-amber-200 font-bold shadow-xs'
                      : `bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400`
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5 text-xs">
                    <XCircle className={`h-4 w-4 text-amber-500 dark:text-amber-400`} />
                    <span>Scrap & Dispose Unit</span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Scrap irreparable unit from company inventory
                  </p>
                </button>
              </div>
            </div>

            {/* Step 3: Replacement Device Details */}
            <div className={`p-4 rounded-2xl border space-y-3 bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <h4 className={`font-bold text-xs flex items-center gap-2 text-slate-800 dark:text-slate-200`}>
                <Plus className={`h-4 w-4 text-indigo-500 dark:text-indigo-400`} />
                <span>Step 3: New Replacement Device Details *</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New Product Model *
                  </label>
                  <select
                    value={exchangeProductName}
                    onChange={(e) => setExchangeProductName(e.target.value)}
                    className={`w-full rounded-xl border p-2.5 text-xs font-semibold border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name} ({p.category})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New Device Serial Number (SN) *
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      required
                      value={exchangeNewSerial}
                      onChange={(e) => setExchangeNewSerial(e.target.value)}
                      placeholder="e.g. SN-ONU24G-991203"
                      className={`w-full rounded-xl border p-2.5 pr-20 text-xs font-mono font-bold border-slate-300 bg-white text-indigo-600 dark:border-slate-700 dark:bg-slate-800 dark:text-indigo-400`}
                    />
                    <button
                      type="button"
                      onClick={() => setExchangeNewSerial(`SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`)}
                      className="absolute right-1 top-1 bottom-1 px-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold hover:bg-indigo-200 cursor-pointer"
                    >
                      Auto-Gen
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New PON Serial Number *
                  </label>
                  <input
                    type="text"
                    required
                    value={exchangeNewPon}
                    onChange={(e) => setExchangeNewPon(e.target.value)}
                    placeholder="e.g. HWTC-99182A3"
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono font-bold border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New MAC Address (Optional)
                  </label>
                  <input
                    type="text"
                    value={exchangeNewMac}
                    onChange={(e) => setExchangeNewMac(e.target.value)}
                    placeholder="e.g. 00:1A:2B:3C:4D:5E"
                    className={`w-full rounded-xl border p-2.5 text-xs font-mono border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100`}
                  />
                </div>
              </div>
            </div>

            {/* Exchange Reason & Notes */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Reason for Device Exchange / Swap *
                </label>
                <select
                  value={exchangeReason}
                  onChange={(e) => setExchangeReason(e.target.value)}
                  className={`w-full rounded-xl border p-2.5 text-xs border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                >
                  <option value="Defective / Hardware Fault (No Power / Optical Loss)">🛠️ Defective / Hardware Fault (No Power / Optical Loss)</option>
                  <option value="Model Upgrade (Single-Band to Dual-Band 5G ONU)">🚀 Model Upgrade (Single-Band to Dual-Band 5G ONU)</option>
                  <option value="Port Damage / Electrical Surge (Lightning Loss)">⚡ Port Damage / Electrical Surge (Lightning Loss)</option>
                  <option value="Routine Field Maintenance & Firmware Swap">🔧 Routine Field Maintenance & Firmware Swap</option>
                  <option value="Physical Fiber Drop Port Damage">📡 Physical Fiber Drop Port Damage</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Technician / Exchange Field Notes
                </label>
                <input
                  type="text"
                  value={exchangeNotes}
                  onChange={(e) => setExchangeNotes(e.target.value)}
                  placeholder="e.g. Replaced by Technician Suresh. Optical power -18.5dBm, signal online..."
                  className={`w-full rounded-xl border p-2.5 text-xs border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button
                type="submit"
                disabled={isSubmittingExchange || !selectedDeviceForExchange}
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                <span>{isSubmittingExchange ? 'Processing Exchange & Restocking...' : 'Confirm Hardware Exchange & Sync Inventory'}</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}
    </>
  );
};
