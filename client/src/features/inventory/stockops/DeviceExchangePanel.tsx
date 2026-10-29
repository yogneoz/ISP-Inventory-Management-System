import React, { useEffect, useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import { DeviceSerialInput, findRegisterRow } from '../../../components/common/DeviceSerialInput';
import {
  describeReplacementRefusal,
  isSerialLookupNotFound,
  SERIAL_LOOKUP_FAILED_MESSAGE,
} from '../../../utils/serialRefusal';
import {
  CustomerDeviceRecord,
} from '../../../types';
import { api } from '../../../services/api';
import { FormCard } from '../../../components/common/FormCard';
import { warrantyCoveredDefault, warrantyEndFieldError, warrantyEndFor } from '../../../utils/warrantyCapture';
import { LoadStateNotice } from '../../../components/common/LoadStateNotice';
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
 * (StockOperations decomposition: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const DeviceExchangePanel: React.FC = () => {
  const {
    activeTab,
    alertDialog,
    branches,
    ensureBsDateAvailable,
    exchangeCustomerDevices,
    exchangeDevicesError,
    exchangeDevicesTotal,
    exchangeSearchTerm,
    setExchangeSearchTerm,
    isLoadingExchangeDevices,
    onRefreshData,
    products,
    retryExchangeDevices,
    serialRegister,
    selectedBranchId,
  } = useStockOperationsCtx();

  const [selectedDeviceForExchange, setSelectedDeviceForExchange] = useState<CustomerDeviceRecord | null>(null);
  const [exchangeReason, setExchangeReason] = useState<string>('Defective / Hardware Fault (No Power / Optical Loss)');
  const [oldDeviceAction, setOldDeviceAction] = useState<'DAMAGE' | 'RESTOCK' | 'DISPOSED'>('RESTOCK');
  const [exchangeProductName, setExchangeProductName] = useState<string>('');
  const [exchangeNewSerial, setExchangeNewSerial] = useState<string>('');
  const [exchangeNewPon, setExchangeNewPon] = useState<string>('');
  const [exchangeNewMac, setExchangeNewMac] = useState<string>('');
  const [exchangeNotes, setExchangeNotes] = useState<string>('');
  // WTY-5: the replacement restarts the customer promise.
  const [exchangeSellerWarrantyEnd, setExchangeSellerWarrantyEnd] = useState<string>('');
  const [exchangeSellerWarrantyCovered, setExchangeSellerWarrantyCovered] = useState<boolean>(true);
  const [exchangeSellerWarrantyTouched, setExchangeSellerWarrantyTouched] = useState<boolean>(false);

  const [isSubmittingExchange, setIsSubmittingExchange] = useState<boolean>(false);

  // Prefill from the product's seller term until the operator edits it.
  useEffect(() => {
    if (!selectedDeviceForExchange || exchangeSellerWarrantyTouched) return;
    const productName = exchangeProductName || selectedDeviceForExchange.productName;
    const prod = products.find((p) => p.name.trim().toLowerCase() === String(productName).trim().toLowerCase());
    setExchangeSellerWarrantyEnd(warrantyEndFor(new Date().toISOString().split('T')[0], prod?.sellerWarrantyMonths));
    setExchangeSellerWarrantyCovered(warrantyCoveredDefault(prod?.sellerWarrantyMonths));
  }, [selectedDeviceForExchange?.id, exchangeProductName, exchangeSellerWarrantyTouched, products]);

  const handlePerformExchange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (!selectedDeviceForExchange) {
      alertDialog('Please select a customer device to exchange.');
      return;
    }
    if (!exchangeNewSerial.trim()) {
      alertDialog('Scan or type the replacement device serial number (SN).');
      return;
    }
    const exchangeBranchId = selectedBranchId === 'ALL' ? selectedDeviceForExchange.branchId : selectedBranchId;
    const exchangeBranchName =
      branches.find((b) => b.id === exchangeBranchId)?.name || exchangeBranchId || 'the selected branch';
    const replacementProductName = exchangeProductName || selectedDeviceForExchange.productName;
    // The DEVICE SERIAL is the only key (one-field UX). The register row must be
    // an IN_STOCK unit of this branch for the same product; its PON/MAC are the
    // replacement's real identity, not operator-typed values. The register copy
    // this screen loaded at mount can be stale, so a serial it does not know is
    // looked up on the server before refusing — that is what turns "must match an
    // IN_STOCK unit" into "CUSTOMER ASSIGNED to Walk Customer".
    const exchangeSerial = exchangeNewSerial.trim();
    let registerRow: any = findRegisterRow(serialRegister, exchangeSerial) || null;
    // VOL-4b: no customer-device fallback — serial_log is the register, and a
    // serial it does not know is resolved by the server lookup below.
    if (!registerRow) {
      try {
        registerRow = await api.lookupExchangeSerial(exchangeSerial, exchangeBranchId);
      } catch (err) {
        // Only a 404 says the register has no such unit. Anything else means we
        // could not consult it, so refusing with "not in the register" would be
        // a guess — stop and let the operator retry (DF-15).
        if (!isSerialLookupNotFound(err)) {
          alertDialog(SERIAL_LOOKUP_FAILED_MESSAGE);
          return;
        }
        registerRow = null;
      }
    }
    const replacementOk =
      Boolean(registerRow) &&
      String(registerRow.status || '').toUpperCase() === 'IN_STOCK' &&
      (!registerRow.branchId || String(registerRow.branchId) === String(exchangeBranchId)) &&
      (!registerRow.productName ||
        registerRow.productName.trim().toLowerCase() === replacementProductName.trim().toLowerCase());
    if (!replacementOk) {
      const refusal = describeReplacementRefusal({
        serial: exchangeSerial,
        row: registerRow,
        branchId: exchangeBranchId,
        branchName: exchangeBranchName,
        productName: replacementProductName,
      });
      // This refusal never reaches the server, so report it: a unit claimed
      // again and again has to show up in the audit trail, not only on screen.
      void api.reportExchangeRefusal({ serial: exchangeSerial, reason: refusal, branchId: exchangeBranchId }).catch(() => {});
      alertDialog(refusal);
      return;
    }
    // Identity from the register, not from whatever the form still holds.
    const resolvedPon = String(registerRow.ponSerial ?? exchangeNewPon ?? '').trim();
    const resolvedMac = String(registerRow.macAddress ?? exchangeNewMac ?? '').trim();

    const exchangeWarrantyError = warrantyEndFieldError(
      new Date().toISOString().split('T')[0],
      exchangeSellerWarrantyEnd,
      'Seller warranty expiry',
      exchangeSellerWarrantyCovered
    );
    if (exchangeWarrantyError) {
      alertDialog(exchangeWarrantyError);
      return;
    }

    setIsSubmittingExchange(true);
    try {
      await api.exchangeCustomerDevice({
        oldDeviceId: selectedDeviceForExchange.id,
        exchangeReason,
        oldDeviceAction,
        newProductName: exchangeProductName || selectedDeviceForExchange.productName,
        newDeviceSerial: exchangeSerial,
        newPonSerial: resolvedPon,
        newMacAddress: resolvedMac || undefined,
        notes: exchangeNotes.trim() || undefined,
        branchId: exchangeBranchId,
        sellerWarrantyEndDateAD:
          exchangeSellerWarrantyCovered ? exchangeSellerWarrantyEnd || undefined : undefined,
        sellerWarrantyCovered: exchangeSellerWarrantyCovered,
      }, { silentErrorToast: true });

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

      // Refresh the shared list in place, then App's normal refresh so stock,
      // operations and other tabs see the swap without a full page reload.
      retryExchangeDevices();
      await onRefreshData?.();
    } catch (err: any) {
      alertDialog(err?.message || 'Failed to exchange device.');
    } finally {
      setIsSubmittingExchange(false);
    }
  };

  // EXCH-1: the server already searched the whole branch for the term and
  // returned only RENTAL/ACTIVE units, so this is the result page itself — no
  // client-side filter over a bounded array. `exchangeDevicesTotal` is how many
  // units match beyond this page.
  const filteredExchangeDevices = exchangeCustomerDevices;

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
              {(exchangeDevicesTotal || exchangeCustomerDevices.length).toLocaleString('en-IN')} Active Deployed Units
            </span>
          </div>

          <form onSubmit={handlePerformExchange} className="space-y-5 text-xs">
            {/* A failed or not-yet-loaded branch read must never present the
                previous branch's units as current (DF-16). Kept outside the
                selection branch so a background refresh failure is visible
                even after a device has been picked. */}
            <LoadStateNotice
              subject="exchange devices"
              loading={isLoadingExchangeDevices}
              error={exchangeDevicesError}
              onRetry={retryExchangeDevices}
              hasCachedRows={exchangeCustomerDevices.length > 0}
            />
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
                      value={exchangeSearchTerm}
                      onChange={(e) => setExchangeSearchTerm(e.target.value)}
                      className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs font-semibold border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white`}
                    />
                  </div>

                  <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                    {isLoadingExchangeDevices && filteredExchangeDevices.length > 0 && (
                      <div className="px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 flex items-center gap-1.5">
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        Searching… showing the previous results.
                      </div>
                    )}
                    {exchangeDevicesError ? (
                      <div className="p-4 text-center text-slate-400 text-xs">
                        The deployed-device list is unavailable until the read above succeeds.
                      </div>
                    ) : isLoadingExchangeDevices && filteredExchangeDevices.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 text-xs">Loading customer devices...</div>
                    ) : filteredExchangeDevices.length === 0 ? (
                      <div className="p-4 text-center text-slate-400 text-xs">
                        {exchangeSearchTerm.trim()
                          ? `No active RENTAL customer device in this branch matches "${exchangeSearchTerm.trim()}". (Sold products are excluded from device exchange).`
                          : 'No active RENTAL customer devices exist in this branch yet. (Sold products are excluded from device exchange).'}
                      </div>
                    ) : (
                      filteredExchangeDevices.map((dev) => (
                        <div
                          key={dev.id}
                          onClick={() => {
                            setSelectedDeviceForExchange(dev);
                            setExchangeProductName(dev.productName);
                            // Start EMPTY: the replacement must be picked from the
                            // branch register, never generated.
                            setExchangeNewSerial('');
                            setExchangeNewPon('');
                            setExchangeNewMac('');
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
                    {!exchangeDevicesError &&
                      !isLoadingExchangeDevices &&
                      exchangeDevicesTotal > filteredExchangeDevices.length &&
                      filteredExchangeDevices.length > 0 && (
                        <div className="p-2.5 text-center text-[11px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800">
                          Showing the first {filteredExchangeDevices.length.toLocaleString('en-IN')} of{' '}
                          {exchangeDevicesTotal.toLocaleString('en-IN')} matching units — type a serial or customer name to narrow it.
                        </div>
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

                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-400 mb-1">
                    New Device Serial Number (SN) * — PON &amp; MAC fill from the register
                  </label>
                  <DeviceSerialInput
                    value={{ deviceSerial: exchangeNewSerial, ponSerial: exchangeNewPon, macAddress: exchangeNewMac }}
                    onChange={(next) => {
                      setExchangeNewSerial(next.deviceSerial);
                      setExchangeNewPon(next.ponSerial || '');
                      setExchangeNewMac(next.macAddress || '');
                      const row = findRegisterRow(serialRegister, next.deviceSerial);
                      if (row?.productName) setExchangeProductName(String(row.productName));
                    }}
                    register={serialRegister}
                    branchId={selectedBranchId === 'ALL' ? selectedDeviceForExchange?.branchId : selectedBranchId}
                    productName={exchangeProductName || selectedDeviceForExchange?.productName}
                    // A rejection must reach the field so it can show the
                    // retryable failure state instead of "not in the register".
                    lookup={(serial) =>
                      api.lookupExchangeSerial(
                        serial,
                        selectedBranchId === 'ALL' ? selectedDeviceForExchange?.branchId : selectedBranchId
                      )
                    }
                  />
                </div>
              </div>
            </div>

            {/* WTY-5: what we promise on the replacement unit. */}
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900 dark:bg-indigo-950/30">
              <label className="flex items-center gap-2 text-xs font-bold text-indigo-800 dark:text-indigo-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exchangeSellerWarrantyCovered}
                  onChange={(e) => {
                    const covered = e.target.checked;
                    setExchangeSellerWarrantyCovered(covered);
                    setExchangeSellerWarrantyTouched(true);
                    if (!covered) setExchangeSellerWarrantyEnd('');
                  }}
                  className="h-3.5 w-3.5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                />
                Sellers warranty covered on the replacement
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {exchangeSellerWarrantyCovered ? (
                  <input
                    type="date"
                    value={exchangeSellerWarrantyEnd}
                    onChange={(e) => {
                      setExchangeSellerWarrantyEnd(e.target.value);
                      setExchangeSellerWarrantyTouched(true);
                    }}
                    aria-label="Seller warranty expiry for the replacement device"
                    className="rounded-lg border px-2.5 py-1.5 text-xs font-mono border-indigo-200 bg-white text-indigo-900 dark:border-indigo-800 dark:bg-slate-900 dark:text-indigo-200"
                  />
                ) : (
                  <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    No warranty given
                  </span>
                )}
                <span className="text-[10px] text-slate-500 dark:text-slate-400">
                  {exchangeSellerWarrantyCovered
                    ? "Prefilled from the replacement product's seller term; an edited date is kept."
                    : 'The customer-device register will show “No warranty” for the replacement.'}
                </span>
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
