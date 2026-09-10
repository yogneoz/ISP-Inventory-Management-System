import React, { useState, useRef, useEffect } from 'react';
import { Product, InventoryStock } from '../../types';
import { Search, Barcode, Plus, Package, AlertTriangle } from 'lucide-react';

interface ProductSearchBarProps {
  products: Product[];
  onAddOrIncrementProduct: (product: Product) => void;
  placeholder?: string;
  inputId?: string;
  stock?: InventoryStock[];
  selectedBranchId?: string;
  showStockBadges?: boolean;}

export const ProductSearchBar: React.FC<ProductSearchBarProps> = ({
  products,
  onAddOrIncrementProduct,
  placeholder = 'Scan Barcode or Search & Enter Product Name / SKU:',
  inputId,
  stock,
  selectedBranchId,
  showStockBadges = true,}) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter matching products
  const matchingProducts = products.filter((p) => {
    if (!query.trim()) return false;
    const q = (query || '').toLowerCase().trim();
    return (
      (p?.sku || '').toLowerCase().includes(q) ||
      (p?.barcode || '').toLowerCase().includes(q) ||
      (p?.name || '').toLowerCase().includes(q)
    );
  });

  const handleSelect = (product: Product) => {
    onAddOrIncrementProduct(product);
    setQuery('');
    setIsOpen(false);
    const isSerialized = product.requiresSerialTracking !== false && product.trackingType !== 'QUANTITY_ONLY';
    if (!isSerialized && inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!query.trim()) return;

      const exactBarcodeMatch = products.find(
        (p) => (p?.barcode || '').toLowerCase() === query.trim().toLowerCase()
      );
      const exactSkuMatch = products.find(
        (p) => (p?.sku || '').toLowerCase() === query.trim().toLowerCase()
      );

      if (exactBarcodeMatch) {
        handleSelect(exactBarcodeMatch);
        return;
      }

      if (exactSkuMatch) {
        handleSelect(exactSkuMatch);
        return;
      }

      // First matching product if available
      if (matchingProducts.length > 0) {
        handleSelect(matchingProducts[0]);
      }
    }
  };

  return (
    <div className="relative w-full">
      <div className="relative flex items-center">
        <div className="absolute left-3 flex items-center gap-1 text-slate-400">
          <Search className="h-4 w-4" />
          <Barcode className="h-4 w-4 text-blue-600 hidden sm:inline" />
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          className={`w-full rounded-xl border pl-10 sm:pl-16 pr-4 py-2.5 text-xs font-medium shadow-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 border-blue-200 bg-white text-slate-900 placeholder-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:placeholder-slate-400 focus:border-blue-600`}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setIsOpen(false);
            }}
            className="absolute right-3 text-slate-400 hover:text-slate-600 text-xs font-bold"
          >
            Clear
          </button>
        )}
      </div>

      {/* Autocomplete dropdown */}
      {isOpen && query.trim().length > 0 && (
        <div className={`absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-xl border shadow-xl border-blue-200 bg-white dark:border-slate-600 dark:bg-slate-800`}>
          {matchingProducts.length === 0 ? (
            <div className={`p-3 text-xs text-center font-medium text-slate-500 dark:text-slate-400`}>
              No product found matching "{query}". Check SKU code or Barcode.
            </div>
          ) : (
            matchingProducts.map((prod) => {
              let qtyOnHand = 0;
              let damagedQty = 0;
              let hasStockData = false;

              if (stock && stock.length > 0) {
                hasStockData = true;
                const stk = stock.find(
                  (s) => s.productId === prod.id && (!selectedBranchId || selectedBranchId === 'ALL' || s.branchId === selectedBranchId)
                );
                if (stk) {
                  qtyOnHand = stk.quantityOnHand || 0;
                  damagedQty = stk.damagedQty || 0;
                }
              }

              return (
                <button
                  key={prod.id}
                  type="button"
                  onClick={() => handleSelect(prod)}
                  className={`w-full text-left px-4 py-2.5 flex items-center justify-between border-b last:border-b-0 transition-colors cursor-pointer border-slate-100 hover:bg-blue-50/80 dark:border-slate-700 dark:hover:bg-slate-700`}
                >
                  <div className="flex-1 pr-2">
                    <div className={`text-xs font-bold flex items-center gap-2 flex-wrap text-slate-900 dark:text-white`}>
                      <span className={`font-mono px-1.5 py-0.5 rounded text-[11px] text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/50`}>
                        {prod.sku}
                      </span>
                      <span>{prod.name}</span>
                    </div>

                    <div className={`text-[11px] flex items-center gap-3 mt-1 flex-wrap text-slate-500 dark:text-slate-400`}>
                      <span>Barcode: <strong className={`font-mono text-slate-700 dark:text-slate-300`}>{prod.barcode || '-'}</strong></span>
                      <span>Category: {prod.category || 'General'}</span>
                      <span>Unit: {prod.unit || 'pcs'}</span>
                    </div>

                    {showStockBadges && hasStockData && (
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] flex-wrap">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono font-bold qtyOnHand > 0 ? bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-300 dark:border dark:border-emerald-700 : bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-700 dark:text-slate-400 dark:border dark:border-slate-600`}>
                          <Package className="h-3 w-3 text-emerald-600" />
                          <span>Usable: {qtyOnHand} {prod.unit || 'pcs'}</span>
                        </span>

                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono font-bold damagedQty > 0 ? bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/50 dark:text-amber-300 dark:border dark:border-amber-700 : bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-700 dark:text-slate-400 dark:border dark:border-slate-600`}>
                          <AlertTriangle className="h-3 w-3 text-amber-600" />
                          <span>Damaged: {damagedQty} {prod.unit || 'pcs'}</span>
                        </span>

                        {qtyOnHand === 0 && damagedQty === 0 && (
                          <span className={`font-bold px-1.5 py-0.5 rounded border text-rose-600 bg-rose-50 border-rose-200 dark:text-rose-400 dark:bg-rose-900/50 dark:border-rose-700`}>
                            Out of Stock at Selected Branch
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    <span className={`text-xs font-bold font-mono block text-slate-900 dark:text-white`}>
                      रु {(prod.costPrice ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <div className={`text-[10px] font-semibold flex items-center gap-1 justify-end mt-1 text-blue-600 dark:text-blue-400`}>
                      <Plus className="h-3 w-3" /> Select / Add
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
