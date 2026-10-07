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
  Plus,
  Trash2,
  X,
  Search,
  CheckCircle2,
  ChevronDown,
  PackageMinus,
  RotateCcw,
} from 'lucide-react';

/**
 * ProductSalePanel - tab panel extracted VERBATIM from StockOperations.tsx
 * (decomposition audit, FRONTEND-AUDIT.md Section G, "pure move" step).
 * The host owns ALL state and handlers; this panel destructures them from
 * the StockOperations context and renders the exact conditional block the
 * host used to render inline. No logic changes.
 */
export const ProductSalePanel: React.FC = () => {
  const { activeTab, allowedBranches, customers, filteredSellCustomers, handleAddSellItem, handleRemoveSellItem, handleResetSellForm, handleSubmitSellProductSale, handleUpdateSellItem, isSellCustomerDropdownOpen, products, saleEligibleProducts, sellBranchId, sellCustomerDisplay, sellCustomerDropdownRef, sellCustomerId, sellCustomerQuery, sellItems, sellNotes, sellPaymentMethod, setIsSellCustomerDropdownOpen, setSellBranchId, setSellCustomerId, setSellCustomerQuery, setSellNotes, setSellPaymentMethod, stock, updateSellDeviceSerial, updateSellPonSerial } = useStockOperationsCtx();
  return (
    <>
      {activeTab === 'PRODUCT_SALE' && (
        <FormCard className="space-y-4">
          {/* Form header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-serif font-bold text-base flex items-center gap-2 text-slate-900 dark:text-white">
                <PackageMinus className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                <span>Product Sales</span>
              </h3>
              <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400">
                Create a retail sales invoice — pick the customer, fulfill from a branch, and scan or add each product line; devices are auto-registered as SOLD (Customer Owned).
              </p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-200 border border-purple-200 dark:border-purple-800">
              Retail Sales Invoice
            </span>
          </div>

          <div className="mb-4 p-2.5 rounded-xl bg-purple-50/80 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-purple-900 dark:text-purple-200 text-xs flex items-center justify-between font-medium">
            <span>🛍️ Devices sold via this form will be automatically registered and tagged as <strong>SOLD (Customer Owned)</strong> in the Customer Device Serials Directory.</span>
          </div>

          <form onSubmit={handleSubmitSellProductSale} className="space-y-4 text-xs">
            {/* 12-col alignment pattern (matches procurement forms):
                Row 1 = Customer search (full width), Row 2 = Branch + Payment Method. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
              {/* Row 1: Customer SEARCH field (searches the customer directory; not a native dropdown) */}
              <div className="relative sm:col-span-2 lg:col-span-12" ref={sellCustomerDropdownRef}>
                <label className="block font-bold mb-1">Select Customer *</label>
                <div className="relative w-full flex items-center">
                  <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    required
                    id="sale-customer-search-input"
                    value={sellCustomerQuery}
                    onFocus={() => setIsSellCustomerDropdownOpen(true)}
                    onChange={(e) => {
                      setSellCustomerQuery(e.target.value);
                      // Only clear the FK when the text no longer matches the selected customer.
                      const exact = customers.find((c) => sellCustomerDisplay(c).toLowerCase() === e.target.value.trim().toLowerCase());
                      setSellCustomerId(exact?.id || '');
                      setIsSellCustomerDropdownOpen(true);
                    }}
                    placeholder="Search customer name, code, phone, or address..."
                    className={`w-full rounded-xl border pl-9 pr-8 h-9 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
                  />
                  {sellCustomerQuery ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSellCustomerQuery('');
                        setSellCustomerId('');
                        setIsSellCustomerDropdownOpen(true);
                      }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full cursor-pointer text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800"
                      title="Clear customer selection"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsSellCustomerDropdownOpen((prev) => !prev)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 cursor-pointer text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Floating Search Dropdown Overlay */}
                {isSellCustomerDropdownOpen && (
                  <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-56 overflow-y-auto rounded-xl border shadow-xl divide-y border-slate-200 bg-white divide-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:divide-slate-800">
                    {filteredSellCustomers.length === 0 ? (
                      <div className="p-3 text-xs text-slate-500 dark:text-slate-400 text-center">
                        <div>No matching customer in the directory.</div>
                      </div>
                    ) : (
                      filteredSellCustomers.slice(0, 50).map((c) => {
                        const isSelected = c.id === sellCustomerId;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setSellCustomerId(c.id);
                              setSellCustomerQuery(sellCustomerDisplay(c));
                              setIsSellCustomerDropdownOpen(false);
                            }}
                            className={`w-full text-left p-2.5 hover:bg-purple-50 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-between ${
                              isSelected ? 'bg-purple-50/70 dark:bg-purple-950/40' : ''
                            }`}
                          >
                            <div className="min-w-0 pr-2">
                              <div className="font-semibold text-xs truncate text-slate-900 dark:text-white">
                                {c.customerName} <span className="font-mono text-[10px] text-slate-500">({c.customerId})</span>
                              </div>
                              <div className="flex items-center gap-2 text-[10px] font-mono mt-0.5 text-slate-500 dark:text-slate-400">
                                {c.contactNumber && <span>{c.contactNumber}</span>}
                                {c.address && <span>• {c.address}</span>}
                              </div>
                            </div>
                            {isSelected && <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-purple-600 dark:text-purple-400" />}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {/* Row 2: Branch + Payment Method */}
              <div className="lg:col-span-6">
                <label className="block font-bold mb-1">Fulfilling Branch *</label>
                <select
                  value={sellBranchId}
                  onChange={(e) => setSellBranchId(e.target.value)}
                  className="w-full rounded-xl border px-3 py-1.5 h-9 bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  {allowedBranches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.code})</option>
                  ))}
                </select>
              </div>

              <div className="lg:col-span-6">
                <label className="block font-bold mb-1">Payment Method</label>
                <select
                  value={sellPaymentMethod}
                  onChange={(e) => setSellPaymentMethod(e.target.value)}
                  className="w-full rounded-xl border px-3 py-1.5 h-9 bg-white border-slate-300 text-slate-900 dark:bg-slate-900 dark:border-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="Cash / Direct Payment">Cash / Direct Payment</option>
                  <option value="eSewa / Khalti Digital Mobile Wallet">eSewa / Khalti Digital Mobile Wallet</option>
                  <option value="Bank Transfer / Fonepay QR">Bank Transfer / Fonepay QR</option>
                  <option value="Customer Account Credit">Customer Account Credit</option>
                </select>
              </div>
            </div>

            {/* Multi-Item Sales Table */}
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block font-bold">Scan Barcode or Search & Enter Product Name / SKU to Add *</label>
                <ProductSearchBar
                  products={saleEligibleProducts}
                  onAddOrIncrementProduct={(prod) => handleAddSellItem(prod.id)}
                  placeholder="Scan Barcode or Search & Enter Product Name / SKU to Add to Sales Invoice..."
                  inputId="sale-product-search-input"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="block font-bold">Sales Invoice Line Items ({sellItems.length}) *</label>
                <button
                  type="button"
                  onClick={() => handleAddSellItem()}
                  className="px-3 py-1 rounded-lg bg-purple-600 text-white font-bold text-[11px] hover:bg-purple-500 shadow-xs flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Product to Invoice</span>
                </button>
              </div>

              {sellItems.length === 0 ? (
                <div className="p-8 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 text-center text-slate-400">
                  <PackageMinus className="h-8 w-8 mx-auto mb-2 text-slate-300 dark:text-slate-700" />
                  <p>No product items added to this sales invoice yet.</p>
                  <button
                    type="button"
                    onClick={() => handleAddSellItem()}
                    className={`mt-2 text-purple-500 hover:text-purple-600 dark:text-purple-400 dark:hover:text-purple-300 font-bold text-xs cursor-pointer`}
                  >
                    + Click here to add products to sale invoice
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className={`font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:border-slate-800`}>
                      <tr>
                        <th className="px-2.5 py-1.5">Product Name</th>
                        <th className="px-2.5 py-1.5 text-center">Branch Stock</th>
                        <th className="px-2.5 py-1.5 text-center">Sale Qty</th>
                        <th className="px-2.5 py-1.5 text-right">Unit Price (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Discount (NPR)</th>
                        <th className="px-2.5 py-1.5 text-right">Subtotal (NPR)</th>
                        <th className="px-2.5 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                      {sellItems.map((item, idx) => {
                        const prod = products.find((p) => p.id === item.productId);
                        const stk = stock.find((s) => s.productId === item.productId && s.branchId === sellBranchId);
                        const isSerialized = prod ? prod.requiresSerialTracking !== false && prod.trackingType !== 'QUANTITY_ONLY' : true;

                        return (
                          <tr key={item.id} className="hover:bg-slate-200 dark:hover:bg-slate-800/40">
                            <td className="p-2.5 min-w-[240px]">
                              <select
                                value={item.productId}
                                onChange={(e) => handleUpdateSellItem(item.id, { productId: e.target.value })}
                                className={`w-full rounded-lg border p-1.5 font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              >
                                {products.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    [{p.sku}] {p.name} ({p.unit})
                                  </option>
                                ))}
                              </select>

                              {isSerialized && (
                                <div className="mt-2 space-y-1 bg-purple-50/50 dark:bg-purple-950/40 p-2 rounded-lg border border-purple-200 dark:border-purple-800/60">
                                  <span className="text-[10px] text-purple-700 dark:text-purple-300 font-bold block">
                                    ✓ Scan Serials for {item.productName} ({item.quantity} Unit{item.quantity > 1 ? 's' : ''})
                                  </span>
                                  {Array.from({ length: item.quantity }).map((_, sIdx) => (
                                    <div key={sIdx} className="flex items-center gap-1.5 mt-1 text-xs">
                                      <span className="font-mono text-[10px] font-bold text-slate-400">#{sIdx + 1}</span>
                                      <input
                                        id={`sale-serial-device-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="Device Serial #"
                                        value={item.deviceSerials?.[sIdx]?.deviceSerial || ''}
                                        onChange={(e) => updateSellDeviceSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const nextEl = document.getElementById(`sale-serial-pon-${idx}-${sIdx}`) as HTMLInputElement;
                                            if (nextEl) {
                                              nextEl.focus();
                                              if ('select' in nextEl) nextEl.select();
                                            }
                                          }
                                        }}
                                        className={`w-1/2 px-2 py-1 text-[11px] font-mono font-bold rounded border focus:outline-none focus:ring-2 focus:ring-purple-500 text-purple-900 bg-white border-purple-300 dark:text-purple-200 dark:bg-slate-800 dark:border-purple-700`}
                                      />
                                      <input
                                        id={`sale-serial-pon-${idx}-${sIdx}`}
                                        type="text"
                                        placeholder="PON Serial #"
                                        value={item.deviceSerials?.[sIdx]?.ponSerial || ''}
                                        onChange={(e) => updateSellPonSerial(idx, sIdx, e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (sIdx + 1 < item.quantity) {
                                              const nextDev = document.getElementById(`sale-serial-device-${idx}-${sIdx + 1}`) as HTMLInputElement;
                                              if (nextDev) {
                                                nextDev.focus();
                                                if ('select' in nextDev) nextDev.select();
                                              }
                                            } else {
                                              const searchInput = document.getElementById('sale-product-search-input') as HTMLInputElement;
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
                              )}
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
                                onChange={(e) => handleUpdateSellItem(item.id, { quantity: Number(e.target.value) })}
                                className={`w-16 rounded-lg border p-1 text-center font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                required
                                value={item.sellingPrice}
                                onChange={(e) => handleUpdateSellItem(item.id, { sellingPrice: Number(e.target.value) })}
                                className={`w-24 rounded-lg border p-1 text-right font-mono font-bold bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right">
                              <input
                                type="number"
                                min={0}
                                value={item.discount}
                                onChange={(e) => handleUpdateSellItem(item.id, { discount: Number(e.target.value) })}
                                className={`w-20 rounded-lg border p-1 text-right font-mono text-amber-600 dark:text-amber-400 bg-white border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
                              />
                            </td>

                            <td className="p-2.5 text-right font-mono font-bold text-slate-900 dark:text-white">
                              {formatNPR(item.totalValue)}
                            </td>

                            <td className="p-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveSellItem(item.id)}
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

            {/* Billing Summary Banner */}
            {sellItems.length > 0 && (
              <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl border bg-purple-50/50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800/60 text-xs">
                <div>
                  <span className="text-slate-400 block text-[10px]">Gross Product Bill</span>
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {formatNPR(sellItems.reduce((s, i) => s + ((i.quantity || 0) * (i.sellingPrice || 0)), 0))}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Total Discounts Applied</span>
                  <span className={`font-mono font-bold text-amber-600 dark:text-amber-400`}>
                    {formatNPR(sellItems.reduce((s, i) => s + (i.discount || 0), 0))}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Net Receivable Bill Amount</span>
                  <span className="font-mono font-extrabold text-purple-700 dark:text-purple-300 text-sm">
                    {formatNPR(Math.max(0, sellItems.reduce((s, i) => s + ((i.quantity || 0) * (i.sellingPrice || 0)), 0) - sellItems.reduce((s, i) => s + (i.discount || 0), 0)))}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block font-bold mb-1">Sale Notes / Remarks</label>
              <textarea
                rows={2}
                value={sellNotes}
                onChange={(e) => setSellNotes(e.target.value)}
                className={`w-full rounded-xl border p-2.5 bg-slate-50 border-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:text-white`}
              />
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={handleResetSellForm}
                className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset / Cancel Form</span>
              </button>

              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-purple-600 text-white font-bold hover:bg-purple-500 shadow-md flex items-center gap-2 cursor-pointer"
              >
                <PackageMinus className="h-4 w-4" />
                <span>Submit Product Sales Invoice</span>
              </button>
            </div>
          </form>
        </FormCard>
      )}
    </>
  );
};
