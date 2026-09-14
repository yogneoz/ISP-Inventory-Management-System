import React, { useState } from 'react';
import { Branch, Product } from '../../types';
import { UploadCloud, FileSpreadsheet, Download, CheckCircle2, AlertCircle, ArrowRight, FileText, Check, Upload, RefreshCw } from 'lucide-react';

interface ImportStockProps {
  branches: Branch[];
  products: Product[];
  onCreateProduct: (prod: Omit<Product, 'id'>) => Promise<void>;
  onRefreshData?: () => void;
}

interface ParsedImportRow {
  sku: string;
  barcode: string;
  name: string;
  productGroup: 'Product Item' | 'Fixed Asset' | 'Consumable Item';
  category: string;
  unit: string;
  costPrice: number;
  sellingPrice: number;
  taxRate: number;
  minReorderLevel: number;
  targetBranchId: string;
  initialQty: number;
  isValid: boolean;
  isDuplicate: boolean;
  notes: string;
}

export const ImportStock: React.FC<ImportStockProps> = ({
  branches,
  products,
  onCreateProduct,
  onRefreshData,
}) => {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedImportRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);

  const sampleCsvData = `SKU,Barcode,ProductName,ProductGroup,Category,Unit,CostPrice,SellingPrice,TaxRate,MinReorder,TargetBranch,InitialQty
SPL-1X8-01,890102938101,PLC Fiber Optic Splitter 1x8 SC/APC,Consumable Item,Splitters,Pcs,450,650,13,20,ALL,100
SLV-60MM-01,890102938102,Fiber Fusion Protection Sleeve 60mm (Box of 100),Consumable Item,Sleeves,Box,250,380,13,30,WH001,50
CPL-SCAPC-01,890102938103,Fiber Optic Coupler SC/APC Simplex Adapter,Consumable Item,Coupler,Pcs,35,50,13,50,ALL,200
EXM-109282,890102938104,Dual Band Wi-Fi 6 GPON ONT Fiber Router,Product Item,Routers & ONTs,Pcs,4200,6500,13,15,WH001,40
EXM-109283,890102938105,Fusion Splicer Fiber Toolkit Heavy Duty,Fixed Asset,Fixed Assets,Set,145000,185000,13,0,WH001,3`;

  const parseCsvContent = (content: string, filename?: string) => {
    if (filename) setSelectedFileName(filename);
    const lines = content.trim().split('\n');
    if (lines.length <= 1) {
      setParsedRows([]);
      return;
    }

    const rows: ParsedImportRow[] = [];
    const existingSkus = new Set(products.map((p) => (p?.sku || '').toLowerCase().trim()));

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));

      if (cols.length < 3) continue;

      const sku = cols[0] || `INV-${Math.floor(100000 + Math.random() * 900000)}`;
      const barcode = cols[1] || `890${Math.floor(100000000 + Math.random() * 900000000)}`;
      const name = cols[2] || 'Imported Stock Item';
      const rawGrp = (cols[3] || 'Product Item').toLowerCase();
      const category = cols[4] || 'General Inventory';
      const catLower = (category || '').toLowerCase();
      const nameLower = (name || '').toLowerCase();

      let productGroup: 'Product Item' | 'Fixed Asset' | 'Consumable Item' = 'Product Item';
      if (
        rawGrp.includes('consumable') ||
        rawGrp.includes('splitter') ||
        rawGrp.includes('sleeve') ||
        rawGrp.includes('coupler') ||
        catLower.includes('splitter') ||
        catLower.includes('sleeve') ||
        catLower.includes('coupler') ||
        catLower.includes('fast connector') ||
        catLower.includes('patch cord') ||
        nameLower.includes('splitter') ||
        nameLower.includes('sleeve') ||
        nameLower.includes('coupler') ||
        nameLower.includes('fast connector')
      ) {
        productGroup = 'Consumable Item';
      } else if (rawGrp.includes('asset') || rawGrp.includes('fixed')) {
        productGroup = 'Fixed Asset';
      }
      const unit = cols[5] || 'Pcs';
      const costPrice = parseFloat(cols[6]) || 0;
      const sellingPrice = parseFloat(cols[7]) || 0;
      const taxRate = parseFloat(cols[8]) || 13;
      const minReorderLevel = parseInt(cols[9]) || 10;
      const targetBranchCode = cols[10] || 'ALL';
      const initialQty = parseInt(cols[11]) || 0;

      const matchingBranch = branches.find(
        (b) => (b?.code || '').toLowerCase() === (targetBranchCode || '').toLowerCase() || (b?.id || '').toLowerCase() === (targetBranchCode || '').toLowerCase()
      );
      const targetBranchId = matchingBranch ? matchingBranch.id : branches[0]?.id || 'ALL';

      const isDuplicateSku = existingSkus.has((sku || '').toLowerCase());
      const isValid = Boolean(sku && name && costPrice >= 0);
      let notes = 'New SKU ready to insert';
      if (isDuplicateSku) notes = 'Existing SKU detected (will update existing entry)';
      if (!name) notes = 'Missing Product Name';

      rows.push({
        sku,
        barcode,
        name,
        productGroup,
        category,
        unit,
        costPrice,
        sellingPrice,
        taxRate,
        minReorderLevel,
        targetBranchId,
        initialQty,
        isValid,
        isDuplicate: isDuplicateSku,
        notes,
      });
    }

    setParsedRows(rows);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        parseCsvContent(text, file.name);
      }
    };
    reader.readAsText(file);
  };

  const handleLoadSample = () => {
    parseCsvContent(sampleCsvData, 'Sample_Stock_Data.csv');
  };

  const handleDownloadSampleCsv = () => {
    const blob = new Blob([sampleCsvData], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Inventory_Stock_Import_Template.csv';
    a.click();
  };

  const handleProcessImport = async () => {
    if (parsedRows.length === 0) return;
    setIsProcessing(true);
    setImportSuccessMessage(null);

    try {
      let createdCount = 0;
      let updatedCount = 0;

      for (const row of parsedRows) {
        if (!row.isValid) continue;
        
        await onCreateProduct({
          sku: row.sku,
          barcode: row.barcode,
          name: row.name,
          productGroup: row.productGroup,
          category: row.category,
          unit: row.unit,
          costPrice: row.costPrice,
          sellingPrice: row.sellingPrice,
          taxRate: row.taxRate,
          minReorderLevel: row.minReorderLevel,
          description: `Imported stock file: ${selectedFileName || 'Template'}. Initial Qty: ${row.initialQty} ${row.unit}`,
        });

        if (row.isDuplicate) {
          updatedCount++;
        } else {
          createdCount++;
        }
      }

      if (onRefreshData) onRefreshData();
      setImportSuccessMessage(`Import complete: ${createdCount} new products added, ${updatedCount} existing SKUs updated!`);
      setParsedRows([]);
      setSelectedFileName(null);
    } catch (err: any) {
      alert(`Import error: ${err.message || 'Failed to import records'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      {/* Header */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white`}>
            <UploadCloud className="h-5 w-5 text-indigo-500" />
            <span>Import Stock Data</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 text-slate-500 dark:text-slate-400`}>
            Upload stock spreadsheet template directly. Automatically detects existing SKUs and updates product details without creating duplicate copies.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handleDownloadSampleCsv}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold cursor-pointer transition-all border-slate-300 text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800`}
          >
            <Download className="h-4 w-4" />
            <span>Download CSV Template</span>
          </button>

          <button
            onClick={handleLoadSample}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 px-3 py-2 text-xs font-semibold hover:bg-indigo-100 transition-all cursor-pointer"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>Load Sample File</span>
          </button>
        </div>
      </div>

      {/* Success Banner */}
      {importSuccessMessage && (
        <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 flex items-center justify-between text-xs font-bold animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            <span>{importSuccessMessage}</span>
          </div>
          <button
            onClick={() => setImportSuccessMessage(null)}
            className="text-emerald-700 dark:text-emerald-300 hover:opacity-80 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Split Screen */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0">
        {/* Direct File Upload Dropzone */}
        <div className={`lg:col-span-5 flex flex-col justify-between rounded-2xl border p-5 shadow-sm bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <FileText className="h-4 w-4 text-indigo-500" />
                <span>Upload CSV / Excel File</span>
              </label>
              <span className="text-[10px] text-slate-400 font-mono">.csv, .txt</span>
            </div>

            <div className={`relative border-2 border-dashed rounded-2xl p-6 text-center flex flex-col items-center justify-center transition-all ${selectedFileName ? 'border-indigo-500 bg-indigo-50/50 dark:border-indigo-500 dark:bg-indigo-950/20' : 'border-slate-300 bg-slate-50 hover:border-indigo-300 dark:border-slate-800 dark:bg-slate-900/40 dark:hover:border-slate-700'}`}>
              <input
                type="file"
                accept=".csv,.txt"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />

              <div className={`h-12 w-12 rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-3`}>
                <Upload className="h-6 w-6" />
              </div>

              {selectedFileName ? (
                <div>
                  <span className={`font-bold text-xs text-indigo-600 dark:text-indigo-400 block truncate max-w-[200px]`}>
                    {selectedFileName}
                  </span>
                  <span className="text-[11px] text-slate-400 block mt-0.5">
                    {parsedRows.length} rows loaded & validated
                  </span>
                </div>
              ) : (
                <div>
                  <span className="font-bold text-xs text-slate-800 dark:text-slate-200 block">
                    Click to browse or drag & drop CSV template file
                  </span>
                  <span className="text-[11px] text-slate-400 block mt-1">
                    Supports Inventory CSV format with auto-duplicate detection
                  </span>
                </div>
              )}
            </div>

            <div className="mt-4 p-3.5 rounded-xl border border-indigo-100 dark:border-indigo-950 bg-indigo-50/50 dark:bg-indigo-950/30 text-[11px] text-slate-600 dark:text-slate-300 space-y-1.5">
              <div className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Smart Duplicate SKU Protection</span>
              </div>
              <p>
                If a row contains an existing SKU, the system will update cost price, selling price, and category without creating duplicate copies.
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 font-medium">
              {parsedRows.length} Rows Ready
            </span>
            <button
              disabled={parsedRows.length === 0 || isProcessing}
              onClick={handleProcessImport}
              className={`flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow-md transition-all ${
                parsedRows.length === 0 || isProcessing
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-indigo-500 cursor-pointer'
              }`}
            >
              <span>Execute Smart Import</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Live Preview Panel */}
        <div className={`lg:col-span-7 flex flex-col rounded-2xl border shadow-lg overflow-hidden bg-white border-slate-200 dark:bg-[#0f1218] dark:border-slate-800`}>
          <div className={`p-3.5 border-b flex items-center justify-between border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/50`}>
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>Parsed Import Preview</span>
            </span>
            <span className="text-[11px] text-slate-500 font-medium">
              Valid: {parsedRows.filter((r) => r.isValid).length} / {parsedRows.length}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[9px] tracking-wider border-b bg-slate-100 text-slate-700 border-slate-200 dark:bg-[#12161f] dark:text-slate-400 dark:border-slate-800`}>
                <tr>
                  <th className="px-2.5 py-1.5">SKU / Name</th>
                  <th className="px-2.5 py-1.5">Group & Category</th>
                  <th className="px-2.5 py-1.5 text-right">Cost / Sell</th>
                  <th className="px-2.5 py-1.5 text-center">Initial Qty</th>
                  <th className="px-2.5 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className={`divide-y divide-slate-200 dark:divide-slate-800`}>
                {parsedRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center text-slate-500 text-xs">
                      No file uploaded yet. Upload a CSV file or click "Load Sample File" above.
                    </td>
                  </tr>
                ) : (
                  parsedRows.map((row, idx) => (
                    <tr key={idx} className={`transition-colors hover:bg-slate-200 dark:hover:bg-slate-800/40`}>
                      <td className="p-2.5">
                        <div className={`font-mono font-bold text-indigo-600 dark:text-indigo-400 text-[11px]`}>{row.sku}</div>
                        <div className="font-semibold text-slate-900 dark:text-white line-clamp-1">{row.name}</div>
                      </td>
                      <td className="p-2.5 text-[11px]">
                        <div className="font-medium text-slate-800 dark:text-slate-200">{row.category}</div>
                        <div className="text-[10px] text-slate-500">{row.productGroup}</div>
                      </td>
                      <td className="p-2.5 text-right font-mono text-[11px]">
                        <div>रु {(row.costPrice ?? 0).toLocaleString('en-IN')}</div>
                        <div className="text-slate-400 text-[10px]">रु {(row.sellingPrice ?? 0).toLocaleString('en-IN')}</div>
                      </td>
                      <td className={`p-2.5 text-center font-mono font-bold text-emerald-600 dark:text-emerald-400`}>
                        {row.initialQty} {row.unit}
                      </td>
                      <td className="p-2.5">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          row.isDuplicate
                            ? 'bg-amber-50 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800'
                            : row.isValid
                            ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                            : 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                        }`}>
                          {row.isDuplicate ? <RefreshCw className="h-3 w-3 text-amber-500" /> : row.isValid ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                          <span>{row.notes}</span>
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
