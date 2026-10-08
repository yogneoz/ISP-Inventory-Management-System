import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStockOperationsCtx } from './StockOperationsContext';
import {
  Asset,
  Product,
  SerialLog,
} from '../../../types';
import type { AssignBinLine } from './StockOperationsContext';
import { api } from '../../../services/api';
import { tryConvertADToBS } from '../../../utils/nepaliCalendar';
import { FormCard } from '../../../components/common/FormCard';
import { formatNPR } from '../../../utils/nprFormat';
import {
  Trash2,
  X,
  Search,
  Barcode,
  ChevronDown,
  Wrench,
  RotateCcw,
} from 'lucide-react';

/**
 * AssignAssetPanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (FRONTEND-AUDIT.md Section G: commit 1 moved the JSX verbatim; commit 2
 * relocated this panel's state, effects and handlers here as well). The
 * panel renders the exact conditional block the host used to render inline;
 * everything it does not own comes from the StockOperations context.
 */
export const AssignAssetPanel: React.FC = () => {
  const { activeTab, allowedBranches, alertDialog, assets, availableStockAssets, customerDevices, customers, ensureBsDateAvailable, locations, onUpdateAssetStatus, products, stock, userBranchId } = useStockOperationsCtx();

  const [, setIsBarcodeScannerOpen] = useState(false);

  const [assignBranchId, setAssignBranchId] = useState<string>(userBranchId);
  const [assignItems, setAssignItems] = useState<AssignBinLine[]>([]);
  const [assignProductSearch, setAssignProductSearch] = useState<string>('');
  const [isAssignProductDropdownOpen, setIsAssignProductDropdownOpen] = useState<boolean>(false);
  const assignProductDropdownRef = useRef<HTMLDivElement | null>(null);
  // Serial-log cache for IN_STOCK serial-pair validation. The bootstrap
  // payload excludes serialLogs, so this mount-once fetch IS the register
  // this form validates against.
  const [assignSerialLogCache, setAssignSerialLogCache] = useState<SerialLog[]>([]);
  const assignSerialLogLoaded = useRef(false);
  useEffect(() => {
    if (assignSerialLogLoaded.current) return;
    assignSerialLogLoaded.current = true;
    api.getSerialLogs({ all: true })
      .then((res) => {
        const rows = Array.isArray(res) ? res : res.data;
        setAssignSerialLogCache(rows || []);
      })
      .catch(() => setAssignSerialLogCache([]));
  }, []);

  // Catalog candidates: productGroup 'Fixed Asset' plus ONU/Router/STB hardware.
  const assignableCatalogProducts = useMemo(
    () =>
      products.filter(
        (p) =>
          p.productGroup === 'Fixed Asset' ||
          (p?.category || '').toLowerCase().includes('router') ||
          (p?.category || '').toLowerCase().includes('onu') ||
          (p?.category || '').toLowerCase().includes('stb') ||
          (p?.category || '').toLowerCase().includes('equipment') ||
          (p?.name || '').toLowerCase().includes('onu') ||
          (p?.name || '').toLowerCase().includes('router')
      ),
    [products]
  );

  const assetIsSerializedProduct = (p: Product): boolean =>
    p.requiresSerialTracking !== false && p.trackingType !== 'QUANTITY_ONLY';

  const filteredAssignProducts = useMemo(() => {
    const q = assignProductSearch.trim().toLowerCase();
    if (!q) return assignableCatalogProducts;
    return assignableCatalogProducts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
    );
  }, [assignableCatalogProducts, assignProductSearch]);

  // Close the product dropdown on outside click.
  useEffect(() => {
    if (!isAssignProductDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (assignProductDropdownRef.current && !assignProductDropdownRef.current.contains(e.target as Node)) {
        setIsAssignProductDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isAssignProductDropdownOpen]);

  // 4. Submit Assign Fixed Asset
  // --- Asset deployment bin handlers (Product Sale pattern) ---
  const handleAddAssignAssetToBin = (asset: Asset) => {
    setAssignItems((prev) => [
      ...prev,
      {
        id: `asg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        kind: 'ASSET' as const,
        assetId: asset.id,
        productName: asset.name,
        sku: asset.tagNumber,
        unit: 'Pcs',
        quantity: 1,
        isSerialized: false,
        deviceSerial: '',
        ponSerial: '',
        macAddress: '',
        usedAtType: 'FIELD' as const,
        remarks: '',
      },
    ]);
    setAssignProductSearch('');
    setIsAssignProductDropdownOpen(false);
  };

  const handleAddAssignProductToBin = (prod: Product) => {
    const serialized = assetIsSerializedProduct(prod);
    setAssignItems((prev) => [
      ...prev,
      {
        id: `asg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        kind: 'PRODUCT' as const,
        productId: prod.id,
        productName: prod.name,
        sku: prod.sku,
        unit: prod.unit,
        quantity: 1,
        isSerialized: serialized,
        deviceSerial: serialized ? `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}` : '',
        ponSerial: serialized ? `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}` : '',
        macAddress: serialized ? '00:1A:2B:3C:4D:5E' : '',
        usedAtType: 'FIELD' as const,
        remarks: '',
      },
    ]);
    setAssignProductSearch('');
    setIsAssignProductDropdownOpen(false);
  };

  const handleUpdateAssignItem = (id: string, updates: Partial<AssignBinLine>) => {
    setAssignItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  };

  const handleRemoveAssignItem = (id: string) => {
    setAssignItems((prev) => prev.filter((i) => i.id !== id));
  };

  const handleResetAssignForm = () => {
    setAssignItems([]);
    setAssignProductSearch('');
    setAssignBranchId(userBranchId);
  };

  // 4. Submit Assign Fixed Asset (multi-bin deployment)
  const handleSubmitAssignAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ensureBsDateAvailable()) return;
    if (assignItems.length === 0) {
      alertDialog('Add at least one asset/product line to the deployment bin.');
      return;
    }
    const todayAD = new Date().toISOString().split('T')[0];
    const todayBS = tryConvertADToBS(todayAD)?.formattedBSShort || '';

    // Per-line validation: destination + stock + serial pairs.
    for (const item of assignItems) {
      if (item.usedAtType === 'POP' && !item.usedAtLocationId) {
        alertDialog(`Line "${item.productName}": select a POP / Network Location.`);
        return;
      }
      if (item.usedAtType === 'CUSTOMER' && !item.usedAtCustomerId) {
        alertDialog(`Line "${item.productName}": select a Customer.`);
        return;
      }
      if (item.kind === 'PRODUCT') {
        const availableAssetStock = stock.find((entry) => entry.productId === item.productId && entry.branchId === assignBranchId);
        if (!availableAssetStock || availableAssetStock.quantityOnHand < item.quantity) {
          alertDialog(`Cannot assign "${item.productName}": requested ${item.quantity} unit(s) but only ${availableAssetStock?.quantityOnHand || 0} available at the selected branch.`);
          return;
        }
        if (item.isSerialized) {
          // IN_STOCK serial identity lives in the serial_log register (branch
          // stock intake), so validate against it. customer_device_records only
          // holds devices already issued to customers — kept as a fallback for
          // legacy flows that seed that table directly.
          const pair = (sn?: string, pon?: string) => ({
            sn: (sn || '').trim().toUpperCase(),
            pon: (pon || '').trim().toUpperCase(),
          });
          const want = pair(item.deviceSerial, item.ponSerial);
          const inStockInSerialLog = assignSerialLogCache.some((log) => {
            const got = pair(log.deviceSerial, log.ponSerial);
            return (
              got.sn === want.sn &&
              got.pon === want.pon &&
              log.branchId === assignBranchId &&
              log.status === 'IN_STOCK' &&
              (log.productName || '').trim().toLowerCase() === (item.productName || '').trim().toLowerCase()
            );
          });
          const matchingAssetDevice = inStockInSerialLog
            ? true
            : customerDevices.find(
                (device) =>
                  device.deviceSerial?.trim().toUpperCase() === item.deviceSerial.trim().toUpperCase() &&
                  device.ponSerial?.trim().toUpperCase() === item.ponSerial.trim().toUpperCase() &&
                  device.branchId === assignBranchId &&
                  device.status === 'IN_STOCK' &&
                  device.productName?.trim().toLowerCase() === item.productName.trim().toLowerCase()
              );
          if (!matchingAssetDevice) {
            alertDialog(`Line "${item.productName}": the Device Serial/PON pair must match an IN_STOCK unit at the selected branch.`);
            return;
          }
        }
      }
    }

    const createdTags: string[] = [];

    for (const item of assignItems) {
      if (item.kind === 'PRODUCT') {
        const prodMeta = products.find((p) => p.id === item.productId);
        for (let unitIdx = 0; unitIdx < item.quantity; unitIdx++) {
          const unitTag = `FA-${item.sku.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)}-${Math.floor(1000 + Math.random() * 9000)}`;
          await api.createAsset({
            tagNumber: unitTag,
            name: item.productName,
            category: prodMeta?.category || 'IT Equipment',
            branchId: assignBranchId,
            acquisitionDateAD: todayAD,
            acquisitionDateBS: todayBS,
            acquisitionCost: prodMeta?.costPrice || 0,
            depreciationMethod: 'STRAIGHT_LINE',
            depreciationRatePercent: prodMeta?.depreciationRate || 15,
            productId: item.productId,
            status: item.usedAtType === 'CUSTOMER' ? 'ASSIGNED_TO_CUSTOMER' : 'ASSIGNED_TO_LOCATION',
            assignedType: item.usedAtType === 'CUSTOMER' ? 'CUSTOMER' : 'LOCATION',
            assignedCustomerId: item.usedAtType === 'CUSTOMER' ? item.usedAtCustomerId : undefined,
            assignedCustomerName: item.usedAtType === 'CUSTOMER' ? item.usedAtCustomerName : undefined,
            assignedLocationId: item.usedAtType !== 'CUSTOMER' ? item.usedAtLocationId : undefined,
            assignedLocationName: item.usedAtType !== 'CUSTOMER' ? item.usedAtLocationName : undefined,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
            deployFromStock: true,
            deviceSerial: item.deviceSerial || undefined,
          });
          createdTags.push(unitTag);

          if (item.usedAtType === 'CUSTOMER' && item.usedAtCustomerId) {
            const custObj = customers.find((c) => c.id === item.usedAtCustomerId);
            if (custObj) {
              await api.createCustomerDevice({
                customerId: custObj.id,
                customerName: custObj.customerName,
                customerCode: custObj.customerId,
                contactPhone: custObj.contactNumber || '9800000000',
                installationAddress: custObj.address || 'Nepal',
                branchId: assignBranchId,
                productName: item.productName,
                deviceSerial: unitIdx === 0
                  ? (item.deviceSerial || `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`)
                  : `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
                ponSerial: unitIdx === 0
                  ? (item.ponSerial || `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`)
                  : `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
                macAddress: unitIdx === 0 ? (item.macAddress || undefined) : undefined,
                status: 'RENTAL',
                issuedDateAD: todayAD,
                issuedDateBS: todayBS,
                notes: `[RENTAL CPE ASSET - Tag: ${unitTag}] ${item.remarks}`,
              });
            }
          }
        }
      } else if (item.kind === 'ASSET' && item.assetId && onUpdateAssetStatus) {
        const ledgerAsset = assets.find((x) => x.id === item.assetId);
        if (item.usedAtType === 'CUSTOMER') {
          const custObj = customers.find((c) => c.id === item.usedAtCustomerId);
          await onUpdateAssetStatus(item.assetId, {
            status: 'ASSIGNED_TO_CUSTOMER',
            assignedType: 'CUSTOMER',
            assignedCustomerId: item.usedAtCustomerId,
            assignedCustomerName: item.usedAtCustomerName,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
          });
          if (custObj) {
            await api.createCustomerDevice({
              customerId: custObj.id,
              customerName: custObj.customerName,
              customerCode: custObj.customerId,
              contactPhone: custObj.contactNumber || '9800000000',
              installationAddress: custObj.address || 'Nepal',
              branchId: ledgerAsset?.branchId || assignBranchId,
              productName: ledgerAsset?.name || item.productName,
              deviceSerial: `SN-ONU24G-${Math.floor(100000 + Math.random() * 900000)}`,
              ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
              status: 'RENTAL',
              issuedDateAD: todayAD,
              issuedDateBS: todayBS,
              notes: `[FIXED ASSET CPE - Tag: ${ledgerAsset?.tagNumber}] ${item.remarks}`,
            });
          }
        } else {
          await onUpdateAssetStatus(item.assetId, {
            status: 'ASSIGNED_TO_LOCATION',
            assignedType: 'LOCATION',
            assignedLocationId: item.usedAtLocationId,
            assignedLocationName: item.usedAtLocationName,
            assignmentDateAD: todayAD,
            assignmentDateBS: todayBS,
            assignmentNotes: item.remarks,
          });
        }
        createdTags.push(ledgerAsset?.tagNumber || item.sku);
      }
    }

    alertDialog(`Deployment complete — ${assignItems.length} bin line(s) processed. Tags: ${createdTags.join(', ')}`);
    handleResetAssignForm();
    if (typeof window !== 'undefined') window.location.reload();
  };

  return (
    <>
      {activeTab === 'ASSIGN_ASSET' && (
        <FormCard className="space-y-4">
          {/* Form header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-serif font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <Wrench className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <span>Assign Fixed Asset</span>
              </h3>
              <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400">
                Search a fixed-asset product or ledger asset, set its destination (POP / Customer) per line, add it to the bin — repeat for multi-item deployments, then record all at once.
              </p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-indigo-100 dark:bg-indigo-950 text-indigo-800 dark:text-indigo-200 border border-indigo-200 dark:border-indigo-800">
              Asset Deployment
            </span>
          </div>

          <form onSubmit={handleSubmitAssignAsset} className="space-y-4 text-xs">
            {/* Row 1: stock source + search-to-bin (Product Sale pattern) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
              <div className="lg:col-span-4">
                <label className="block font-bold mb-1">Fulfilling Branch (stock source) *</label>
                <select
                  value={assignBranchId}
                  onChange={(e) => setAssignBranchId(e.target.value)}
                  className="w-full rounded-xl border px-3 py-1.5 h-9 bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div className="relative sm:col-span-2 lg:col-span-8" ref={assignProductDropdownRef}>
                <label className="block font-bold mb-1">Scan Barcode or Search Asset / Product to Add to Bin *</label>
                <div className="relative w-full flex items-center">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    id="assign-product-search-input"
                    value={assignProductSearch}
                    onFocus={() => setIsAssignProductDropdownOpen(true)}
                    onChange={(e) => {
                      setAssignProductSearch(e.target.value);
                      setIsAssignProductDropdownOpen(true);
                    }}
                    placeholder="Search fixed asset product or asset tag, then press Enter / pick from list..."
                    className="w-full rounded-xl border pl-9 pr-8 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  {assignProductSearch ? (
                    <button
                      type="button"
                      onClick={() => {
                        setAssignProductSearch('');
                        setIsAssignProductDropdownOpen(true);
                      }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full cursor-pointer text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800"
                      title="Clear search"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsAssignProductDropdownOpen((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 cursor-pointer text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Floating dropdown: picking a row ADDS it to the bin */}
                {isAssignProductDropdownOpen && (
                  <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto rounded-xl border shadow-xl divide-y border-slate-200 bg-white divide-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:divide-slate-800">
                    <div className="px-2.5 py-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Existing Assets in Ledger (assigns that unit, tag stays)</div>
                      {availableStockAssets.length === 0 ? (
                        <div className="p-2 text-[11px] text-slate-400 text-center">No unassigned ledger assets.</div>
                      ) : (
                        <div className="max-h-32 overflow-y-auto space-y-0.5">
                          {availableStockAssets
                            .filter((a) => !assignProductSearch || a.name.toLowerCase().includes(assignProductSearch.toLowerCase()) || a.tagNumber.toLowerCase().includes(assignProductSearch.toLowerCase()))
                            .slice(0, 20)
                            .map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => handleAddAssignAssetToBin(a)}
                                className="w-full text-left p-2 rounded-lg hover:bg-indigo-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-between"
                              >
                                <div className="min-w-0 pr-2">
                                  <div className="font-semibold text-xs truncate text-slate-900 dark:text-white">
                                    {a.name} <span className="font-mono text-[10px] text-slate-500">Tag: {a.tagNumber}</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500">{a.category} | {formatNPR(a.acquisitionCost)}</div>
                                </div>
                                <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 shrink-0">+ Add to bin</span>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>

                    <div className="px-2.5 py-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Catalog Products (new asset(s) created from branch stock)</div>
                      {filteredAssignProducts.length === 0 ? (
                        <div className="p-2 text-[11px] text-slate-400 text-center">No matching catalog product.</div>
                      ) : (
                        <div className="max-h-32 overflow-y-auto space-y-0.5">
                          {filteredAssignProducts.slice(0, 20).map((p) => {
                            const onHand = stock.filter((st) => st.productId === p.id && st.branchId === assignBranchId).reduce((acc, st) => acc + st.quantityOnHand, 0);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => handleAddAssignProductToBin(p)}
                                className="w-full text-left p-2 rounded-lg hover:bg-indigo-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-between"
                              >
                                <div className="min-w-0 pr-2">
                                  <div className="font-semibold text-xs truncate text-slate-900 dark:text-white">
                                    {p.name} <span className="font-mono text-[10px] text-slate-500">[{p.sku}]</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500">{p.productGroup || 'Product'} | {p.category}{assetIsSerializedProduct(p) ? ' | serialized' : ''}</div>
                                </div>
                                <span className={`text-[10px] font-bold font-mono shrink-0 ${onHand > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                                  {onHand} in stock
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Deployment Bin: multi-line, per-line destination/serials/remarks */}
            <div className="space-y-3">
              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Deployment Bin Lines ({assignItems.length}) *</label>
                <span className="text-[10px] text-slate-400">Each line keeps its own destination, serial identity & remarks</span>
              </div>

              {assignItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <Wrench className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No assets in the deployment bin yet.</p>
                  <p className="text-[11px] mt-1">Search above and pick a ledger asset or catalog product to add a line.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {assignItems.map((item, idx) => {
                    const onHand = item.kind === 'PRODUCT'
                      ? stock.filter((st) => st.productId === item.productId && st.branchId === assignBranchId).reduce((acc, st) => acc + st.quantityOnHand, 0)
                      : null;
                    return (
                      <div key={item.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-2.5">
                        {/* Line header: identity + remove */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-bold text-slate-900 dark:text-white text-xs flex items-center gap-2 min-w-0">
                            <span className="text-slate-400">{idx + 1}.</span>
                            <span className="truncate">{item.productName}</span>
                            <span className="font-mono text-[10px] font-semibold text-slate-500">[{item.sku}]</span>
                            <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-md shrink-0 ${item.kind === 'PRODUCT' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'}`}>
                              {item.kind === 'PRODUCT' ? 'NEW FROM STOCK' : 'LEDGER ASSET'}
                            </span>
                            {item.kind === 'PRODUCT' && onHand !== null && (
                              <span className={`text-[10px] font-mono shrink-0 ${onHand >= item.quantity ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                                {onHand} in stock
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveAssignItem(item.id)}
                            className="text-rose-500 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300 cursor-pointer p-1 shrink-0"
                            title="Remove this bin line"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        {/* Line fields: Qty (serialized locked) + destination + per-line remarks */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2">
                          <div className="lg:col-span-2">
                            <label className="block font-bold text-[10px] text-slate-500 mb-1">
                              Qty *
                              {item.isSerialized && <span className="ml-1 font-normal normal-case text-slate-400">(serialized)</span>}
                            </label>
                            <input
                              type="number"
                              min={1}
                              max={999}
                              value={item.quantity}
                              disabled={item.isSerialized}
                              onChange={(e) => handleUpdateAssignItem(item.id, { quantity: Math.max(1, Math.min(999, Number(e.target.value) || 1)) })}
                              className="w-full rounded-xl border px-2.5 py-1.5 h-9 font-mono font-bold text-center bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                          </div>

                          <div className="lg:col-span-3">
                            <label className="block font-bold text-[10px] text-slate-500 mb-1">Deploy To *</label>
                            <select
                              value={item.usedAtType === 'CUSTOMER' ? 'CUSTOMER' : item.usedAtType === 'POP' ? 'POP' : 'FIELD'}
                              onChange={(e) => {
                                const t = e.target.value as AssignBinLine['usedAtType'];
                                handleUpdateAssignItem(item.id, {
                                  usedAtType: t,
                                  usedAtLocationId: t === 'POP' ? item.usedAtLocationId : undefined,
                                  usedAtLocationName: t === 'POP' ? item.usedAtLocationName : undefined,
                                  usedAtCustomerId: t === 'CUSTOMER' ? item.usedAtCustomerId : undefined,
                                  usedAtCustomerName: t === 'CUSTOMER' ? item.usedAtCustomerName : undefined,
                                });
                              }}
                              className="w-full rounded-xl border px-2.5 py-1.5 h-9 text-[11px] font-bold bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                              <option value="FIELD">Field / General Asset</option>
                              <option value="POP">POP / Network Site</option>
                              <option value="CUSTOMER">Customer / Rental CPE</option>
                            </select>
                          </div>

                          {item.usedAtType === 'POP' && (
                            <div className="lg:col-span-4">
                              <label className="block font-bold text-[10px] text-slate-500 mb-1">POP / Network Location *</label>
                              <select
                                value={item.usedAtLocationId || ''}
                                onChange={(e) => {
                                  const loc = locations.find((l) => l.id === e.target.value);
                                  handleUpdateAssignItem(item.id, { usedAtLocationId: loc?.id, usedAtLocationName: loc?.name });
                                }}
                                className="w-full rounded-xl border px-2.5 py-1.5 h-9 text-[11px] bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              >
                                <option value="">Select POP location...</option>
                                {locations
                                  .filter((l) => l.type === 'POP_SERVER_ROOM' || l.type === 'FIBER_NETWORK_NODE' || !l.type)
                                  .map((l) => (
                                    <option key={l.id} value={l.id}>{l.name} ({l.type.replace(/_/g, ' ')})</option>
                                  ))}
                              </select>
                            </div>
                          )}

                          {item.usedAtType === 'CUSTOMER' && (
                            <div className="lg:col-span-4">
                              <label className="block font-bold text-[10px] text-slate-500 mb-1">Customer *</label>
                              <select
                                value={item.usedAtCustomerId || ''}
                                onChange={(e) => {
                                  const cust = customers.find((c) => c.id === e.target.value);
                                  handleUpdateAssignItem(item.id, { usedAtCustomerId: cust?.id, usedAtCustomerName: cust ? `${cust.customerName} (${cust.customerId})` : undefined });
                                }}
                                className="w-full rounded-xl border px-2.5 py-1.5 h-9 text-[11px] bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              >
                                <option value="">Select customer...</option>
                                {customers.map((c) => (
                                  <option key={c.id} value={c.id}>{c.customerName} ({c.customerId})</option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div className={`${item.usedAtType === 'FIELD' ? 'lg:col-span-7' : 'lg:col-span-3'}`}>
                            <label className="block font-bold text-[10px] text-slate-500 mb-1">Remarks</label>
                            <input
                              type="text"
                              value={item.remarks}
                              onChange={(e) => handleUpdateAssignItem(item.id, { remarks: e.target.value })}
                              placeholder="e.g. Installed at POP rack 2 / rented to customer..."
                              className="w-full rounded-xl border px-2.5 py-1.5 h-9 text-[11px] bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        </div>

                        {/* Serial identity verification (serialized PRODUCT lines only) */}
                        {item.kind === 'PRODUCT' && item.isSerialized && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-0.5">
                            <div>
                              <label className="block font-bold text-[10px] text-slate-500 mb-1">Device Serial (SN) *</label>
                              <input type="text" required value={item.deviceSerial} onChange={(e) => handleUpdateAssignItem(item.id, { deviceSerial: e.target.value })} className="w-full rounded-xl border px-2.5 py-1.5 h-9 font-mono font-bold bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </div>
                            <div>
                              <label className="block font-bold text-[10px] text-slate-500 mb-1">PON Serial *</label>
                              <input type="text" required value={item.ponSerial} onChange={(e) => handleUpdateAssignItem(item.id, { ponSerial: e.target.value })} className="w-full rounded-xl border px-2.5 py-1.5 h-9 font-mono font-bold bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </div>
                            <div>
                              <label className="block font-bold text-[10px] text-slate-500 mb-1">MAC Address</label>
                              <input type="text" value={item.macAddress} onChange={(e) => handleUpdateAssignItem(item.id, { macAddress: e.target.value })} className="w-full rounded-xl border px-2.5 py-1.5 h-9 font-mono bg-white border-slate-300 text-slate-800 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                            </div>
                            <div className="flex items-end">
                              <button type="button" onClick={() => setIsBarcodeScannerOpen(true)} className="w-full px-3 py-1.5 h-9 rounded-xl border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 cursor-pointer flex items-center justify-center gap-1.5">
                                <Barcode className="h-3.5 w-3.5" />
                                <span>Scan Serial</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleResetAssignForm}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="flex-1 py-3 rounded-xl font-bold text-xs text-white bg-indigo-600 hover:bg-indigo-500 shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <Wrench className="h-4 w-4" />
                <span>Record {assignItems.length > 1 ? `${assignItems.length}-Item ` : ''}Asset Deployment & Register Asset(s)</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}
    </>
  );
};
