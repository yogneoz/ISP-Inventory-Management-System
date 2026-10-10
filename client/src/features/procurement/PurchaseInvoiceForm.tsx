/**
 * PurchaseInvoiceForm — the inline create Vendor Bill (purchase invoice)
 * form (phase 4 extraction from PurchaseInvoices.tsx).
 *
 * Owns the full CREATE_INVOICE body: supplier picker, vendor bill metadata,
 * PO-link flow (searchable PO selection dialog + received-items checklist),
 * product scan/search, serialized order lines, bill-wise discount/tax
 * totals and the create submit. Rendering this component is equivalent to
 * the old in-file "TAB 2: INLINE PURCHASE BILL CREATION FORM" block plus
 * its two PO-link modals.
 *
 * The parent (PurchaseInvoices register) owns the register, the viewer, the
 * payment modal and the post-save navigation (onClose / onSaved).
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Barcode,
  Calculator,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Link,
  RotateCcw,
  Search,
  ShoppingCart,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { formCardClass } from '../../components/common/FormCard';
import { useDialog } from '../../components/common/DialogProvider';
import { DateField } from '../../components/DateField';
import { ProductSearchBar } from '../inventory/ProductSearchBar';
import { ensureBSDayForAD } from '../../utils/nepaliCalendar';
import { formatNPR, formatNPRPrecise } from '../../utils/nprFormat';
import { getAllowedBranches } from '../../utils/permissions';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import type {
  PurchaseInvoice, PurchaseInvoiceItem, PurchaseOrder, Product, Branch, Supplier, DeviceSerialPair, User,
} from '../../types';

interface InvoiceFormLine {
  productId: string;
  productName: string;
  sku: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  deviceSerials: DeviceSerialPair[];
}

interface PurchaseInvoiceFormProps {
  currentUser?: User | null;
  products: Product[];
  branches: Branch[];
  suppliers: Supplier[];
  /** Open (not yet received) purchase orders, for the Link-from-PO flow. */
  purchaseOrders: PurchaseOrder[];
  selectedBranchId: string;
  dateMode: 'BS' | 'AD';
  onCreateInvoice: (
    inv: Omit<PurchaseInvoice, 'id' | 'invoiceNumber'> & { poReferenceId?: string }
  ) => Promise<void>;
  /** Called right after a successful save — parent refreshes the register. */
  onSaved: () => void;
  /** Called after the success message — parent returns to the register tab. */
  onClose: () => void;
}
export const PurchaseInvoiceForm: React.FC<PurchaseInvoiceFormProps> = ({
  currentUser,
  products,
  branches,
  suppliers,
  purchaseOrders,
  selectedBranchId,
  dateMode,
  onCreateInvoice,
  onSaved,
  onClose,
}) => {
  const { alert: alertDialog } = useDialog();
  // Suppliers list strictly sourced from master supplier directory
  const availableSuppliers = suppliers && suppliers.length > 0 ? suppliers : [];

  // Link Purchase Order State
  const [selectedPoId, setSelectedPoId] = useState<string>('');
  const [isPoSelectModalOpen, setIsPoSelectModalOpen] = useState<boolean>(false);
  const [poSearchQuery, setPoSearchQuery] = useState<string>('');
  const [isPoChecklistOpen, setIsPoChecklistOpen] = useState<boolean>(false);

  // Bill-wise Discount State
  const [billDiscountType] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [billDiscountValue, setBillDiscountValue] = useState<number>(0);

  // Form State
  const [supplierName, setSupplierName] = useState(availableSuppliers[0]?.name || '');
  const [supplierId, setSupplierId] = useState<string>(availableSuppliers[0]?.id || '');
  const [isSupplierDropdownOpen, setIsSupplierDropdownOpen] = useState(false);
  const supplierDropdownRef = useRef<HTMLDivElement>(null);

  const [vendorBillNumber, setVendorBillNumber] = useState(
    `BILL-${Math.floor(10000 + Math.random() * 90000)}`
  );
  // Purchase date (AD) — intentionally empty by default; the user must select it (never auto-filled to today)
  const [purchaseDateAD, setPurchaseDateAD] = useState('');
  const [vendorBillDateAD, setVendorBillDateAD] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [branchId, setBranchId] = useState(
    selectedBranchId !== 'ALL' ? selectedBranchId : branches[0]?.id || ''
  );

  // Close supplier dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (supplierDropdownRef.current && !supplierDropdownRef.current.contains(e.target as Node)) {
        setIsSupplierDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Automatically sync branchId when branches load or selectedBranchId changes
  useEffect(() => {
    const allowed = getAllowedBranches(currentUser, branches);
    if (allowed.length > 0) {
      if (selectedBranchId !== 'ALL' && allowed.some((b) => b.id === selectedBranchId)) {
        setBranchId(selectedBranchId);
      } else if (!allowed.some((b) => b.id === branchId)) {
        setBranchId(allowed[0].id);
      }
    }
  }, [selectedBranchId, branches, currentUser]);

  // Automatically sync supplierName when availableSuppliers load
  useEffect(() => {
    if (availableSuppliers.length > 0 && (!supplierName || !availableSuppliers.some((s) => s.name === supplierName))) {
      setSupplierName(availableSuppliers[0].name);
      setSupplierId(availableSuppliers[0].id);
    }
  }, [availableSuppliers]);

  // Filtered suppliers for searchable directory picker
  const filteredSuppliers = availableSuppliers.filter((s) => {
    if (!s) return false;
    const q = (supplierName || '').trim().toLowerCase();
    if (!q) return true;
    return (
      (s?.name || '').toLowerCase().includes(q) ||
      (s?.panVatNumber && s.panVatNumber.toLowerCase().includes(q)) ||
      (s?.contactPerson && s.contactPerson.toLowerCase().includes(q)) ||
      (s?.phone && s.phone.includes(q))
    );
  });
  const [taxationType, setTaxationType] = useState<'TAXABLE_13' | 'TAX_EXEMPTED'>('TAXABLE_13');
  const [notes, setNotes] = useState('');
  const [saveMessage, setSaveMessage] = useState('');

  // Multi-Item Bill Lines (empty by default until scanned/searched)
  const [lines, setLines] = useState<InvoiceFormLine[]>([]);

  // Pending POs list for selection
  const pendingPOs = purchaseOrders.filter(
    (po) => po.status !== 'RECEIVED' && po.status !== 'CANCELLED'
  );
  const activePO = purchaseOrders.find((po) => po.id === selectedPoId || po.poNumber === selectedPoId);

  const poValidation = (() => {
    if (!selectedPoId) return { valid: true, message: '' };
    if (!activePO) return { valid: false, message: 'Select a valid Purchase Order before saving this vendor bill.' };

    const poByProduct = new Map<string, PurchaseOrder['items'][number]>(activePO.items.map((item) => [item.productId, item]));
    const invoiceByProduct = new Map(lines.map((line) => [line.productId, line]));
    const missing = activePO.items.find((item) => !invoiceByProduct.has(item.productId));
    const extra = lines.find((line) => !poByProduct.has(line.productId));
    const exceeding = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      return poItem && line.quantity > poItem.quantity;
    });
    const quantityMismatch = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      return poItem && line.quantity !== poItem.quantity;
    });
    const typeMismatch = lines.find((line) => {
      const poItem = poByProduct.get(line.productId);
      const product = products.find((item) => item.id === line.productId);
      return poItem?.productGroup && product?.productGroup !== poItem.productGroup;
    });
    if (exceeding) return { valid: false, message: `Quantity exceeding PO: ${exceeding.productName} allows only ${poByProduct.get(exceeding.productId)?.quantity}.` };
    if (missing) return { valid: false, message: `PO product missing from bill: ${missing.productName}.` };
    if (extra) return { valid: false, message: `Product not in selected PO: ${extra.productName}.` };
    if (typeMismatch) return { valid: false, message: `Product type does not match the selected PO: ${typeMismatch.productName}.` };
    if (quantityMismatch) return { valid: false, message: `Quantity must match the selected PO for ${quantityMismatch.productName}: ${poByProduct.get(quantityMismatch.productId)?.quantity} required.` };
    if (invoiceByProduct.size !== poByProduct.size) return { valid: false, message: 'PO and vendor bill products must match exactly.' };
    return { valid: true, message: '' };
  })();

  const filteredPendingPOs = pendingPOs.filter(
    (po) =>
      (po?.poNumber || '').toLowerCase().includes((poSearchQuery || '').toLowerCase()) ||
      (po?.supplierName || '').toLowerCase().includes((poSearchQuery || '').toLowerCase())
  );

  const allowedBranches = getAllowedBranches(currentUser, branches).sort((a, b) => {
    const aIsWarehouse = `${a.id} ${a.code} ${a.name}`.toLowerCase().includes('warehouse') || a.id.toLowerCase().startsWith('wh');
    const bIsWarehouse = `${b.id} ${b.code} ${b.name}`.toLowerCase().includes('warehouse') || b.id.toLowerCase().startsWith('wh');
    return Number(bIsWarehouse) - Number(aIsWarehouse);
  });

  const handleResetForm = () => {
    setLines([]);
    setSelectedPoId('');
    setSupplierName(availableSuppliers[0]?.name || '');
    setSupplierId(availableSuppliers[0]?.id || '');
    setIsSupplierDropdownOpen(false);
    setBillDiscountValue(0);
    setTaxationType('TAXABLE_13');
    setNotes('');
    setVendorBillNumber(`BILL-${Math.floor(10000 + Math.random() * 90000)}`);
    setVendorBillDateAD(new Date().toISOString().split('T')[0]);
    setPurchaseDateAD('');
  };


  // Search/Scan Product Add or Duplicate Quantity Increment
  const handleAddOrIncrementProduct = (prod: Product) => {
    const isSerialized = prod.requiresSerialTracking !== false;
    let targetLineIdx = 0;
    let targetSerialIdx = 0;

    setLines((prevLines) => {
      const existingIdx = prevLines.findIndex((l) => l.productId === prod.id);
      if (existingIdx !== -1) {
        // Duplicate product entered -> Increase quantity!
        targetLineIdx = existingIdx;
        const updated = [...prevLines];
        const newQty = updated[existingIdx].quantity + 1;
        const currentSerials = [...(updated[existingIdx].deviceSerials || [])];
        if (isSerialized) {
          targetSerialIdx = currentSerials.length;
          currentSerials.push({
            deviceSerial: '',
            ponSerial: '',
          });
        }
        updated[existingIdx] = {
          ...updated[existingIdx],
          quantity: newQty,
          deviceSerials: isSerialized ? currentSerials : [],
        };
        return updated;
      } else {
        // Add new row with initial serial pair if serialized
        targetLineIdx = prevLines.length;
        targetSerialIdx = 0;
        return [
          ...prevLines,
          {
            productId: prod.id,
            productName: prod.name,
            sku: prod.sku,
            unit: prod.unit,
            quantity: 1,
            unitPrice: prod.costPrice,
            discount: 0,
            deviceSerials: isSerialized
              ? [
                  {
                    deviceSerial: '',
                    ponSerial: '',
                  },
                ]
              : [],
          },
        ];
      }
    });

    if (isSerialized) {
      setTimeout(() => {
        const el = document.getElementById(`serial-device-${targetLineIdx}-${targetSerialIdx}`) as HTMLInputElement;
        if (el) {
          el.focus();
          if ('select' in el) el.select();
        }
      }, 60);
    }
  };

  const removeLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const updateLineQty = (index: number, newQty: number) => {
    const updated = [...lines];
    const qty = Math.max(1, newQty);
    updated[index].quantity = qty;
    const prod = products.find((p) => p.id === updated[index].productId);
    const isSerialized = prod ? prod.requiresSerialTracking !== false : true;

    if (isSerialized) {
      const currentSerials = [...(updated[index].deviceSerials || [])];
      while (currentSerials.length < qty) {
        currentSerials.push({
          deviceSerial: `SN-${updated[index].sku}-${Math.floor(100000 + Math.random() * 900000)}`,
          ponSerial: `HWTC-${Math.floor(10000000 + Math.random() * 90000000).toString(16).toUpperCase()}`,
        });
      }
      updated[index].deviceSerials = currentSerials.slice(0, qty);
    } else {
      updated[index].deviceSerials = [];
    }
    setLines(updated);
  };

  const updateLineDeviceSerial = (lineIdx: number, serialIdx: number, deviceSerial: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], deviceSerial };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLinePonSerial = (lineIdx: number, serialIdx: number, ponSerial: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], ponSerial };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLineMacAddress = (lineIdx: number, serialIdx: number, macAddress: string) => {
    const updated = [...lines];
    const serials = [...(updated[lineIdx].deviceSerials || [])];
    serials[serialIdx] = { ...serials[serialIdx], macAddress };
    updated[lineIdx].deviceSerials = serials;
    setLines(updated);
  };

  const updateLinePrice = (index: number, newPrice: number) => {
    const updated = [...lines];
    updated[index].unitPrice = Math.max(0, newPrice);
    setLines(updated);
  };

  // Bill-wise Calculations
  const calculatedLines = lines.map((l) => {
    const gross = l.quantity * l.unitPrice;
    return {
      ...l,
      gross,
      netSubtotal: gross,
    };
  });

  const grossSubtotal = calculatedLines.reduce((acc, curr) => acc + curr.gross, 0);

  // Bill-wise Discount calculation
  let totalDiscount = 0;
  if (billDiscountType === 'PERCENT') {
    totalDiscount = Math.min(grossSubtotal, (grossSubtotal * (billDiscountValue || 0)) / 100);
  } else {
    totalDiscount = Math.min(grossSubtotal, billDiscountValue || 0);
  }

  const netBillSubtotal = Math.max(0, grossSubtotal - totalDiscount);

  // Bill-wise Tax Rate: the company-configured rate if TAXABLE_13, 0% if TAX_EXEMPTED
  const isBillTaxable = taxationType === 'TAXABLE_13';
  const billVatRate = getDefaultTaxRate();
  const billTaxableAmount = isBillTaxable ? netBillSubtotal : 0;
  const billExemptAmount = isBillTaxable ? 0 : netBillSubtotal;
  const billVatAmount = isBillTaxable ? (netBillSubtotal * billVatRate) / 100 : 0;
  const grandTotalCalculated = netBillSubtotal + billVatAmount;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lines.length === 0) {
      alertDialog('Please search and add at least one product item to the purchase bill.');
      return;
    }
    if (!poValidation.valid) {
      setSaveMessage(poValidation.message);
      return;
    }

    const targetBranch = branches.find((b) => b.id === branchId);
    if (targetBranch && targetBranch.allowProcurement === false) {
      alertDialog(
        `Procurement & Purchasing permission is disabled for branch "${targetBranch.name}". Please enable it in Branch Directory.`
      );
      return;
    }

    // Purchase date is required and the vendor bill date can never be after it
    if (!purchaseDateAD) {
      setSaveMessage('Please select the Purchase Date (AD) before saving this vendor bill.');
      return;
    }
    if (vendorBillDateAD > purchaseDateAD) {
      setSaveMessage(
        `Vendor bill date (${vendorBillDateAD}) cannot be after the purchase date (${purchaseDateAD}). Please correct the dates and try again.`
      );
      return;
    }

    // BS dates are mandatory: auto-resolve both dates from the synced seeded
    // calendar and block the bill when either has no exact record.
    const invBs = ensureBSDayForAD(purchaseDateAD);
    if (!invBs) {
      alertDialog(`BS date is not available for ${purchaseDateAD}. Please contact your system administrator for BS month seeding.`);
      return;
    }
    const vendorBillBs = ensureBSDayForAD(vendorBillDateAD);
    if (!vendorBillBs) {
      alertDialog(`BS date is not available for ${vendorBillDateAD}. Please contact your system administrator for BS month seeding.`);
      return;
    }

    const items: PurchaseInvoiceItem[] = calculatedLines.map((l, idx) => ({
      id: `inv-item-${Date.now()}-${idx}`,
      productId: l.productId,
      productGroup: products.find((product) => product.id === l.productId)?.productGroup,
      productName: l.productName,
      sku: l.sku,
      unit: l.unit,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      discount: Number(l.discount),
      isTaxExempt: !isBillTaxable,
      taxRate: isBillTaxable ? getDefaultTaxRate() : 0,
      subtotal: l.netSubtotal,
      taxAmount: isBillTaxable ? (l.netSubtotal * getDefaultTaxRate()) / 100 : 0,
      total: l.netSubtotal + (isBillTaxable ? (l.netSubtotal * getDefaultTaxRate()) / 100 : 0),
      deviceSerials: l.deviceSerials,
    }));

    // Default to CREDIT mode transaction as requested
    await onCreateInvoice({
      supplierId,
      supplierName,
      vendorBillNumber,
      poReferenceId: selectedPoId || undefined,
      branchId,
      invoiceDateAD: purchaseDateAD,
      invoiceDateBS: invBs,
      dueDateAD: vendorBillDateAD,
      dueDateBS: vendorBillBs,
      paymentMethod: 'CREDIT',
      items,
      subtotalAmount: grossSubtotal,
      totalDiscount,
      taxableAmount: billTaxableAmount,
      vatAmount: billVatAmount,
      nonTaxableAmount: billExemptAmount,
      grandTotal: grandTotalCalculated,
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      notes: `Purchase Date: ${purchaseDateAD} (${invBs}). Vendor Bill Date: ${vendorBillDateAD} (${vendorBillBs}). ${notes}`,
    });

    setSaveMessage('Vendor bill saved successfully and purchase quantities were posted.');
    window.setTimeout(() => setSaveMessage(''), 3000);
    handleResetForm();
    window.setTimeout(() => onClose(), 3000);
    onSaved();
  };


  return (
    <>
        <div
          id="pi-inline-form-container"
          className={`${formCardClass} space-y-6`}
        >
          {/* No secondary form banner by design: the sub-tab indicator already
              communicates context, so the form goes straight to its fields. */}
          <form onSubmit={handleSubmit} className="space-y-6" id="pi-form-element">
            {/* Invoice Details: compact metadata and taxation controls in one card.
                Three aligned rows on lg: Row 1 = Destination Branch + Purchase Date,
                Row 2 = Supplier / Vendor (full width search), Row 3 = Vendor Bill # +
                Vendor Bill Date. Date fields use a compact max-width so the control
                hugs its content (BS value + AD suffix) instead of stretching. */}
            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 p-3 rounded-xl border bg-slate-50 border-slate-200 dark:bg-slate-900/50 dark:border-slate-800`}>
              {/* Destination Branch — first because it determines where stock is received.
                  Same 4/12 width as Vendor Bill # so both rows share one rhythm. */}
              <div className="lg:col-span-4">
                <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Destination Branch *
                </label>
                <select
                  id="pi-branch-select"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>
              </div>

              {/* Purchase Date Field (must be selected by the user; never auto-filled to today) */}
              <div className="lg:col-span-4 lg:max-w-[15rem]">
                <DateField
                  label="Purchase Date"
                  mode={dateMode}
                  value={purchaseDateAD}
                  onChange={setPurchaseDateAD}
                  required
                  id="pi-purchase-date"
                  min={vendorBillDateAD || undefined}
                  compact
                  controlClassName={
                    purchaseDateAD && vendorBillDateAD > purchaseDateAD
                      ? 'border-rose-400 dark:border-rose-700'
                      : ''
                  }
                />
              </div>

              {/* Vendor Searchable Field — its own row (10/12 so it doesn't dominate) */}
              <div className="relative sm:col-span-2 lg:col-span-10" ref={supplierDropdownRef}>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  Supplier / Vendor *
                </label>
                <div className="relative w-full flex items-center">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    required
                    id="pi-supplier-input"
                    value={supplierName}
                    onFocus={() => {
                      setIsSupplierDropdownOpen(true);
                    }}
                    onChange={(e) => {
                      setSupplierName(e.target.value);
                      // If the typed text exactly matches a directory supplier, keep its id for the FK.
                      const exact = availableSuppliers.find((s) => s.name.toLowerCase() === e.target.value.trim().toLowerCase());
                      setSupplierId(exact?.id || '');
                      setIsSupplierDropdownOpen(true);
                    }}
                    placeholder="Search supplier name or PAN..."
                    className={`w-full rounded-xl border pl-9 pr-8 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                  />
                  {supplierName ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSupplierName('');
                        setIsSupplierDropdownOpen(true);
                      }}
                      className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full cursor-pointer text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800`}
                      title="Clear vendor selection"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsSupplierDropdownOpen((prev) => !prev)}
                      className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 cursor-pointer text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200`}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Floating Search Dropdown Overlay */}
                {isSupplierDropdownOpen && (
                  <div className={`absolute z-50 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-xl border shadow-xl divide-y border-slate-200 bg-white divide-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:divide-slate-800`}>
                    {filteredSuppliers.length === 0 ? (
                      <div className="p-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                        <div>No matching supplier in directory.</div>
                        <div className={`mt-1 font-semibold text-blue-600 dark:text-blue-400`}>
                          Press enter or tab to use "{supplierName}".
                        </div>
                      </div>
                    ) : (
                      filteredSuppliers.map((s) => {
                        const isSelected = (s?.name || '').toLowerCase() === (supplierName || '').toLowerCase();
                        return (
                          <button
                            key={s.id || s.name}
                            type="button"
                            onClick={() => {
                              setSupplierName(s.name);
                              setSupplierId(s.id);
                              setIsSupplierDropdownOpen(false);
                            }}
                            className={`w-full text-left p-2.5 hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-between ${
                              isSelected ? 'bg-blue-50/70 dark:bg-blue-950/40' : ''
                            }`}
                          >
                            <div className="min-w-0 pr-2">
                              <div className={`font-semibold text-xs truncate text-slate-900 dark:text-white`}>
                                {s.name}
                              </div>
                              <div className={`flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-500 dark:text-slate-400`}>
                                {s.panVatNumber && <span>PAN: {s.panVatNumber}</span>}
                                {s.phone && <span>• {s.phone}</span>}
                              </div>
                            </div>
                            {isSelected && <Check className={`h-4 w-4 flex-shrink-0 text-blue-600 dark:text-blue-400`} />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <div className="lg:col-span-4">
                <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Vendor Bill / Invoice # *
                </label>
                <input
                  type="text"
                  required
                  id="pi-vendor-bill-number"
                  value={vendorBillNumber}
                  onChange={(e) => setVendorBillNumber(e.target.value)}
                  placeholder="e.g. BILL-99201"
                  className={`w-full rounded-xl border px-2.5 py-1.5 h-9 text-xs font-mono font-bold focus:outline-none focus:ring-2 focus:ring-blue-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                />
              </div>

              <div className="lg:col-span-4 lg:max-w-[15rem]">
                <DateField
                  label="Vendor Bill Date"
                  mode={dateMode}
                  value={vendorBillDateAD}
                  onChange={setVendorBillDateAD}
                  required
                  id="pi-vendor-bill-date"
                  max={purchaseDateAD || undefined}
                  compact
                  controlClassName={
                    purchaseDateAD && vendorBillDateAD > purchaseDateAD
                      ? 'border-rose-400 dark:border-rose-700'
                      : ''
                  }
                />
                {purchaseDateAD && vendorBillDateAD > purchaseDateAD && (
                  <div className={`mt-1 text-[10px] font-bold text-rose-600 dark:text-rose-400`}>
                    Bill date is after the purchase date — bill cannot be saved.
                  </div>
                )}
              </div>

              {/* Whole Bill Taxation Terms Selection */}
              <div className={`sm:col-span-2 lg:col-span-12 border-t pt-2 border-slate-200 dark:border-slate-800`}>
              <span className={`block text-[10px] font-bold uppercase tracking-wider mb-1.5 text-slate-500 dark:text-slate-400`}>
                Whole-Bill Taxation Mode
              </span>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pi-tax-mode"
                    value="TAXABLE_13"
                    checked={taxationType === 'TAXABLE_13'}
                    onChange={() => setTaxationType('TAXABLE_13')}
                    className={`h-4 w-4 text-blue-600 dark:text-blue-400 focus:ring-blue-500`}
                  />
                  <span className={`font-bold text-slate-900 dark:text-white`}>
                    {getDefaultTaxRate()}% Taxable Bill (Standard VAT Applicable)
                  </span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="pi-tax-mode"
                    value="TAX_EXEMPTED"
                    checked={taxationType === 'TAX_EXEMPTED'}
                    onChange={() => setTaxationType('TAX_EXEMPTED')}
                    className={`h-4 w-4 text-blue-600 dark:text-blue-400 focus:ring-blue-500`}
                  />
                  <span className={`font-bold text-slate-900 dark:text-white`}>
                    Tax Exempted Bill (0% Tax / Non-Taxable)
                  </span>
                </label>
              </div>
            </div>

            {/* Purchase Order Linking — kept in the same compact invoice details card */}
            <div className={`sm:col-span-2 lg:col-span-12 border-t pt-2 border-indigo-200 dark:border-indigo-800/60`}>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className={`p-1.5 rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300`}>
                    <ShoppingCart className="h-4 w-4" />
                  </div>
                  <div>
                    <div className={`text-[11px] font-bold text-indigo-950 dark:text-indigo-200`}>
                      Link Existing Purchase Order Reference (Optional)
                    </div>
                    <div className={`text-[10px] text-indigo-800/80 dark:text-indigo-400`}>
                      {activePO ? (
                        <span className="font-semibold">
                          Linked to <strong className="text-indigo-950 dark:text-white">PO #{activePO.poNumber}</strong> ({activePO.supplierName} • {activePO.items.length} item lines)
                        </span>
                      ) : (
                        'Link a PO to verify items against order and track fulfillment in real-time.'
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIsPoSelectModalOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[11px] shadow-xs transition-colors cursor-pointer"
                  >
                    <Link className="h-3.5 w-3.5" />
                    <span>{activePO ? 'Change Linked PO' : 'Link / Import PO'}</span>
                  </button>

                  {activePO && (
                    <>
                      <button
                        type="button"
                        onClick={() => setIsPoChecklistOpen(true)}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/60 hover:bg-indigo-200 text-indigo-800 dark:text-indigo-200 font-bold text-xs border border-indigo-300 dark:border-indigo-700 transition-colors cursor-pointer"
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                        <span>PO Item Checklist</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setSelectedPoId('')}
                        className={`p-1.5 rounded-xl transition-colors cursor-pointer text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:text-slate-400 dark:hover:text-rose-400 dark:hover:bg-rose-950`}
                        title="Unlink PO"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            </div>

            {/* Product Search & Barcode Scan Bar */}
            <div className={`p-4 rounded-xl border space-y-2 bg-blue-50/70 border-blue-200 dark:bg-blue-950/40 dark:border-blue-800/60`}>
              <div className={`flex items-center justify-between text-xs font-bold text-blue-700 dark:text-blue-300`}>
                <span className="flex items-center gap-1.5">
                  <Search className="h-4 w-4" />
                  <span>Scan Barcode or Search & Enter Product Name / SKU:</span>
                </span>
                <span className={`text-[11px] font-normal hidden sm:inline text-slate-500 dark:text-slate-400`}>
                  Scan barcode to add item row and autofocus Device Serial number
                </span>
              </div>
              <ProductSearchBar
                products={products}
                onAddOrIncrementProduct={handleAddOrIncrementProduct}
                placeholder="Scan barcode or type code/item name and press Enter to add..."
                inputId="purchase-product-search-input"
              />
            </div>

            {/* POS Multi-Line Table */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 text-slate-700 dark:text-slate-300`}>
                  <Calculator className="h-4 w-4 text-blue-500" />
                  <span>Bill Items Table ({lines.length} items)</span>
                </h4>
                <span className={`text-[11px] text-slate-500 dark:text-slate-400`}>
                  Transaction Mode: <strong className="text-amber-600 dark:text-amber-400">CREDIT</strong>
                </span>
              </div>

              <div
                className={`border rounded-xl overflow-x-auto border-slate-200 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/30`}
              >
                <table className="w-full text-left text-xs border-collapse">
                  <thead
                    className={`font-bold uppercase text-[10px] tracking-wider border-b bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}
                  >
                    <tr>
                      <th className="px-2.5 py-1.5 w-10 text-center">#</th>
                      <th className="px-2.5 py-1.5 min-w-[220px]">Product Name</th>
                      <th className="px-2.5 py-1.5 w-28">SKU</th>
                      <th className="px-2.5 py-1.5 w-28 text-center">Qty</th>
                      <th className="px-2.5 py-1.5 w-32 text-right">Cost Rate (NPR)</th>
                      <th className="px-2.5 py-1.5 w-36 text-right">Line Subtotal (NPR)</th>
                      <th className="px-2.5 py-1.5 w-14 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className={`p-8 text-center italic text-slate-400 dark:text-slate-500`}>
                          No items added yet. Use the product search & barcode scan bar above to scan or enter items.
                        </td>
                      </tr>
                    ) : (
                      calculatedLines.map((line, idx) => (
                        <React.Fragment key={line.productId}>
                          <tr
                            className={`transition-colors hover:bg-white dark:hover:bg-slate-800/50`}
                          >
                            <td className="p-2.5 text-center font-mono font-bold text-slate-400">
                              {idx + 1}
                            </td>
                            <td className={`p-2.5 font-bold text-slate-900 dark:text-white`}>
                              <div>{line.productName}</div>
                              {activePO && (() => {
                                const poItem = activePO.items.find((p) => p.productId === line.productId);
                                if (poItem) {
                                  const isExact = line.quantity === poItem.quantity;
                                  const isExceed = line.quantity > poItem.quantity;
                                  return (
                                    <div
                                      className={`mt-1 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border ${
                                        isExact
                                          ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/80 dark:text-emerald-300 dark:border-emerald-700'
                                          : isExceed
                                            ? 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/80 dark:text-rose-300 dark:border-rose-700'
                                            : 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700'
                                      }`}
                                    >
                                      <CheckCircle2 className="h-3 w-3" />
                                      <span>In PO #{activePO.poNumber} (Ordered: {poItem.quantity})</span>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <div className={`mt-1 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/80 dark:text-amber-300 dark:border-amber-700`}>
                                      <AlertTriangle className={`h-3 w-3 text-amber-600 dark:text-amber-500`} />
                                      <span>⚠️ Extra / Not in PO #{activePO.poNumber}</span>
                                    </div>
                                  );
                                }
                              })()}
                              {(() => {
                                const prod = products.find((p) => p.id === line.productId);
                                const isSerialized = prod ? prod.requiresSerialTracking !== false : true;
                                return isSerialized ? (
                                  <div className={`text-[10px] font-medium mt-0.5 text-blue-600 dark:text-blue-400`}>
                                    Device & PON Serial Tracking ({line.quantity} Unit{line.quantity > 1 ? 's' : ''})
                                  </div>
                                ) : (
                                  <div className={`text-[10px] font-medium mt-0.5 text-emerald-600 dark:text-emerald-400`}>
                                    Bulk Consumable Item ({line.quantity} {line.unit})
                                  </div>
                                );
                              })()}
                            </td>
                            <td className={`p-2.5 font-mono text-slate-500 dark:text-slate-400`}>
                              {line.sku}
                            </td>
                            <td className="p-2.5 text-center">
                              <input
                                type="number"
                                min={1}
                                value={line.quantity}
                                onChange={(e) => updateLineQty(idx, Number(e.target.value))}
                                className={`w-20 text-center rounded-lg border p-1.5 text-xs font-mono font-bold border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                              />
                            </td>
                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                value={line.unitPrice}
                                onChange={(e) => updateLinePrice(idx, Number(e.target.value))}
                                className={`w-28 text-right rounded-lg border p-1.5 text-xs font-mono font-medium border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                              />
                            </td>
                            <td className={`p-2.5 text-right font-mono font-extrabold text-slate-900 dark:text-white`}>
                              {formatNPRPrecise(line.netSubtotal)}
                            </td>
                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => removeLine(idx)}
                                className="p-1.5 text-slate-400 hover:text-rose-500 cursor-pointer transition-colors"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>

                          {/* Device Serial, PON Serial & MAC Row per Unit or Consumable Notice */}
                          {(() => {
                            const prod = products.find((p) => p.id === line.productId);
                            const isSerialized = prod ? prod.requiresSerialTracking !== false : true;

                            if (!isSerialized) {
                              return (
                                <tr className="bg-slate-100/50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800">
                                  <td colSpan={7} className="px-3 py-2">
                                    <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                      <Tag className="h-3.5 w-3.5 text-slate-400" />
                                      <span>Bulk Consumable Item — Device, PON & MAC serial tracking skipped ({line.quantity} {line.unit})</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            }

                            return (
                              <tr className="bg-blue-50/40 dark:bg-blue-950/30 border-b border-slate-200 dark:border-slate-800">
                                <td colSpan={7} className="px-2.5 py-1.5">
                                  <div className="text-[11px] font-bold text-blue-900 dark:text-blue-300 mb-2 flex items-center gap-1.5">
                                    <Barcode className={`h-3.5 w-3.5 text-blue-600 dark:text-blue-400`} />
                                    <span>Serial Numbers — Device / PON / MAC for {line.productName} ({line.quantity} Units)</span>
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                    {Array.from({ length: line.quantity }).map((_, sIdx) => (
                                      <div
                                        key={sIdx}
                                        className="bg-white dark:bg-slate-900 p-2.5 rounded-xl border border-blue-200 dark:border-blue-800 text-xs shadow-xs"
                                      >
                                        <div className="flex items-center justify-between mb-1.5">
                                          <span className="font-mono text-[10px] font-bold text-slate-400">Unit #{sIdx + 1}</span>
                                          <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                                            MAC
                                          </span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                                          <input
                                            id={`serial-device-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="Device Serial #"
                                            value={line.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                            onChange={(e) => updateLineDeviceSerial(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const nextEl = document.getElementById(
                                                  `serial-pon-${idx}-${sIdx}`
                                                ) as HTMLInputElement;
                                                if (nextEl) {
                                                  nextEl.focus();
                                                  if ('select' in nextEl) nextEl.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-blue-900 dark:text-blue-200 bg-blue-50/50 dark:bg-blue-950/50 rounded-lg border border-blue-200 dark:border-blue-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                          />

                                          <input
                                            id={`serial-pon-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="PON Serial #"
                                            value={line.deviceSerials?.[sIdx]?.ponSerial || ''}
                                            onChange={(e) => updateLinePonSerial(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const nextEl = document.getElementById(
                                                  `serial-mac-${idx}-${sIdx}`
                                                ) as HTMLInputElement;
                                                if (nextEl) {
                                                  nextEl.focus();
                                                  if ('select' in nextEl) nextEl.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-indigo-900 dark:text-indigo-200 bg-indigo-50/50 dark:bg-indigo-950/50 rounded-lg border border-indigo-200 dark:border-indigo-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                          />

                                          <input
                                            id={`serial-mac-${idx}-${sIdx}`}
                                            type="text"
                                            placeholder="MAC Address"
                                            value={line.deviceSerials?.[sIdx]?.macAddress || ''}
                                            onChange={(e) => updateLineMacAddress(idx, sIdx, e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                e.preventDefault();
                                                const searchInput = document.getElementById(
                                                  'purchase-product-search-input'
                                                ) as HTMLInputElement;
                                                if (searchInput) {
                                                  searchInput.focus();
                                                  if ('select' in searchInput) searchInput.select();
                                                }
                                              }
                                            }}
                                            className="w-full px-2.5 py-1 text-[11px] font-mono font-bold text-emerald-900 dark:text-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/50 rounded-lg border border-emerald-200 dark:border-emerald-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                          />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            );
                          })()}
                        </React.Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bill Totals Summary & Remarks */}
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-5 border-t border-slate-200 dark:border-slate-700 pt-5`}>
              <div>
                <label className={`block text-[11px] font-bold uppercase tracking-wider mb-1 text-slate-500 dark:text-slate-400`}>
                  Bill Remarks / Vendor Terms
                </label>
                <textarea
                  rows={4}
                  id="pi-remarks-input"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Enter vendor invoice terms, delivery challan reference, or ledger notes..."
                  className={`w-full rounded-xl border p-3 text-xs focus:ring-2 focus:ring-blue-500 focus:border-blue-500 border-slate-300 bg-white text-slate-900 placeholder-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500`}
                />
              </div>

              <div
                className={`rounded-2xl p-5 border space-y-2.5 text-xs bg-slate-50 border-slate-200 dark:bg-slate-900/60 dark:border-slate-800`}
              >
                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Gross Amount:</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-white">
                    {formatNPRPrecise(grossSubtotal)}
                  </span>
                </div>

                <div className={`flex justify-between items-center text-amber-600 bg-amber-50/70 border-amber-200/60 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-800/40 p-2 rounded-xl border`}>
                  <span className="font-bold">Bill Discount (NPR):</span>
                  <input
                    type="number"
                    min={0}
                    value={billDiscountValue}
                    onChange={(e) => setBillDiscountValue(Math.max(0, Number(e.target.value)))}
                    className={`w-28 text-right rounded-lg border border-amber-300 bg-white text-amber-600 dark:border-amber-700 dark:bg-slate-900 dark:text-amber-400 px-2 py-1 text-xs font-mono font-bold focus:ring-2 focus:ring-amber-500`}
                  />
                </div>

                <div className="flex justify-between text-slate-600 dark:text-slate-400">
                  <span>Taxation Status:</span>
                  <span className={`font-bold text-blue-600 dark:text-blue-400`}>
                    {isBillTaxable ? `${getDefaultTaxRate()}% Taxable Bill` : 'Tax Exempted Bill'}
                  </span>
                </div>

                <div className={`flex justify-between text-blue-600 border-slate-200 dark:text-blue-400 dark:border-slate-800 font-semibold border-t pt-2`}>
                  <span>{getDefaultTaxRate()}% Input VAT:</span>
                  <span className="font-mono font-bold">
                    {formatNPRPrecise(billVatAmount)}
                  </span>
                </div>

                <div className="flex justify-between text-base font-extrabold text-slate-900 dark:text-white pt-2 border-t border-slate-300 dark:border-slate-700">
                  <span>Grand Total (Credit Mode):</span>
                  <span className={`font-mono text-blue-600 dark:text-blue-400 text-lg`}>
                    {formatNPRPrecise(grandTotalCalculated)}
                  </span>
                </div>

                {(poValidation.message || saveMessage) && (
                  <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] font-semibold ${
                    poValidation.message
                      ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                  }`} role="status">
                    {poValidation.message || saveMessage}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleResetForm}
                className="flex items-center gap-1.5 rounded-xl border border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-xs font-bold text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset Form</span>
              </button>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    handleResetForm();
                    onClose();
                  }}
                  className={`rounded-xl border px-5 py-2.5 text-xs font-semibold cursor-pointer transition-colors border-slate-300 text-slate-600 hover:bg-slate-200 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800`}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  id="btn-submit-purchase-invoice"
                  disabled={lines.length === 0 || !poValidation.valid}
                  className="rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-400 disabled:shadow-none disabled:cursor-not-allowed px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-600/30 cursor-pointer transition-all"
                >
                  Save Vendor Bill (Credit Mode)
                </button>
              </div>
            </div>
          </form>
        </div>
      {/* Modal 1: Searchable PO Selection Dialog */}
      {isPoSelectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-xl rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            <div className={`flex items-center justify-between border-b p-4 bg-slate-50 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <ShoppingCart className={`h-5 w-5 text-indigo-600 dark:text-indigo-400`} />
                <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                  Select Purchase Order to Link / Receive
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsPoSelectModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
 <div className="relative w-full md:w-80 lg:w-96 shrink-0">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by PO Number or Vendor Name..."
                  value={poSearchQuery}
                  onChange={(e) => setPoSearchQuery(e.target.value)}
                  className={`w-full rounded-xl border pl-9 pr-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500 bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-200`}
                />
              </div>

              <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                {filteredPendingPOs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400">
                    No pending purchase orders match your search.
                  </div>
                ) : (
                  filteredPendingPOs.map((po) => {
                    const isCurrent = po.id === selectedPoId;
                    return (
                      <div
                        key={po.id}
                        className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${isCurrent ? 'bg-indigo-50/80 dark:bg-indigo-950/60 border-indigo-300 dark:border-indigo-700 shadow-xs' : 'bg-white border-slate-200 hover:bg-slate-200 dark:bg-slate-900/50 dark:border-slate-800 dark:hover:bg-slate-800/80'}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-mono font-extrabold text-xs text-indigo-600 dark:text-indigo-400`}>
                              PO #{po.poNumber}
                            </span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 uppercase">
                              {po.status}
                            </span>
                          </div>
                          <div className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate mt-0.5">
                            {po.supplierName}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-3">
                            <span>📅 {po.orderDateAD}</span>
                            <span>📦 {po.items.length} item line(s)</span>
                            <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                              {formatNPR(po.totalAmount)}
                            </span>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPoId(po.id);
                            if (po.supplierName) setSupplierName(po.supplierName);
                            if (po.supplierId) setSupplierId(po.supplierId);
                            if (po.branchId) setBranchId(po.branchId);
                            setIsPoSelectModalOpen(false);
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer shrink-0 ${
                            isCurrent
                              ? 'bg-indigo-700 text-white shadow-xs'
                              : 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-600 hover:text-white border border-indigo-200 dark:border-indigo-800'
                          }`}
                        >
                          {isCurrent ? 'Linked ✓' : 'Select PO'}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className={`p-3 border-t flex justify-between items-center text-xs bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <button
                type="button"
                onClick={() => {
                  setSelectedPoId('');
                  setIsPoSelectModalOpen(false);
                }}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 font-medium"
              >
                Clear Selection (Direct Purchase)
              </button>
              <button
                type="button"
                onClick={() => setIsPoSelectModalOpen(false)}
                className="px-4 py-1.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold rounded-lg hover:bg-slate-300 dark:hover:bg-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Active PO Item Checklist Dialog */}
      {isPoChecklistOpen && activePO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
          <div
            className={`w-full max-w-2xl rounded-2xl shadow-2xl border overflow-hidden bg-white border-slate-200 text-slate-800 dark:bg-[#0f1218] dark:border-slate-800 dark:text-slate-200`}
          >
            <div className={`flex items-center justify-between border-b p-4 bg-slate-50 border-slate-200 dark:bg-slate-900/80 dark:border-slate-800`}>
              <div className="flex items-center gap-2">
                <CheckSquare className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm">
                    PO Verification Checklist — #{activePO.poNumber}
                  </h3>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Supplier: {activePO.supplierName}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsPoChecklistOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
              <div className="text-xs text-slate-600 dark:text-slate-300 bg-blue-50 dark:bg-blue-950/50 p-3 rounded-xl border border-blue-200 dark:border-blue-800">
                💡 <strong>How receiving works:</strong> As you scan or search product items into the Purchase Invoice form below, this checklist automatically updates received counts.
              </div>

              <div className="space-y-2">
                {activePO.items.map((poItem) => {
                  const matchedLine = lines.find((l) => l.productId === poItem.productId);
                  const scannedQty = matchedLine ? matchedLine.quantity : 0;
                  const isComplete = scannedQty === poItem.quantity;
                  const isOver = scannedQty > poItem.quantity;
                  const isStarted = scannedQty > 0;

                  return (
                    <div
                      key={poItem.id}
                      className={`p-3 rounded-xl border text-xs flex items-center justify-between ${
                        isComplete
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-950 dark:text-emerald-200'
                          : isOver
                          ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-700 text-rose-950 dark:text-rose-200'
                          : isStarted
                          ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-700 text-amber-950 dark:text-amber-200'
                          : 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-slate-900 dark:text-white">{poItem.productName}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          Ordered Quantity: <strong className="text-slate-800 dark:text-slate-200">{poItem.quantity} {poItem.unit}</strong> @ {formatNPR(poItem.unitPrice)}
                        </div>
                      </div>

                      <div className="text-right font-mono">
                        <div
                          className={`font-extrabold text-sm ${
                            isComplete
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : isOver
                              ? 'text-rose-700 dark:text-rose-400'
                              : isStarted
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-slate-400'
                          }`}
                        >
                          {scannedQty} / {poItem.quantity}
                        </div>
                        <div className="text-[10px] font-bold">
                          {isComplete
                            ? '✓ Fully Scanned'
                            : isOver
                            ? '⚠️ Exceeds Order'
                            : isStarted
                            ? '⏳ Partially Scanned'
                            : 'Not Scanned Yet'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={`p-3 border-t text-right bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800`}>
              <button
                type="button"
                onClick={() => setIsPoChecklistOpen(false)}
                className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-lg"
              >
                Done Inspecting
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
