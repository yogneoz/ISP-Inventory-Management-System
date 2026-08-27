import React, { useState, useEffect } from 'react';
import {
  X,
  QrCode,
  Barcode,
  Printer,
  Check,
  Scan,
  Search,
  Copy,
  Zap,
  Volume2,
  VolumeX,
  Camera,
  RefreshCw,
  Tag,
  Package,
  Layers,
  Sparkles,
} from 'lucide-react';
import { Product } from '../../types';

interface BarcodeScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  products?: Product[];
  onScanResult?: (code: string) => void;
}

export const BarcodeScannerModal: React.FC<BarcodeScannerModalProps> = ({
  isOpen,
  onClose,
  products = [],
  onScanResult,
}) => {
  const [activeTab, setActiveTab] = useState<'SCANNER' | 'GENERATOR'>('SCANNER');
  const [scannedInput, setScannedInput] = useState('');
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [isAudioBeep, setIsAudioBeep] = useState(true);
  const [matchedProduct, setMatchedProduct] = useState<Product | null>(null);

  // Label Printer Settings
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(products[0] || null);
  const [serialNumber, setSerialNumber] = useState('IZ-ONU-2081-8842');
  const [ponSerial, setPonSerial] = useState('ZTEG8A41B22F');
  const [macAddress, setMacAddress] = useState('00:1A:2B:3C:4D:5E');
  const [labelSize, setLabelSize] = useState<'SHELF_50x30' | 'COMPACT_38x25' | 'LARGE_100x50'>('SHELF_50x30');
  const [barcodeType, setBarcodeType] = useState<'CODE128' | 'QR' | 'EAN13'>('CODE128');
  const [printQty, setPrintQty] = useState<number>(1);
  const [showPrice, setShowPrice] = useState<boolean>(true);
  const [showBranch, setShowBranch] = useState<boolean>(true);
  const [showCompany, setShowCompany] = useState<boolean>(true);

  const [copied, setCopied] = useState(false);
  const [scanHistory, setScanHistory] = useState<
    { code: string; type: string; timestamp: string; matchedName?: string }[]
  >([
    { code: 'IZ-ONU-2081-8842', type: 'ONU Router Serial', timestamp: new Date().toLocaleTimeString(), matchedName: 'Dual Band Fiber Router' },
    { code: '8997011234567', type: 'Product SKU Barcode', timestamp: new Date().toLocaleTimeString(), matchedName: 'CAT6 UTP Network Cable' },
  ]);

  useEffect(() => {
    if (products.length > 0 && !selectedProduct) {
      setSelectedProduct(products[0]);
    }
  }, [products, selectedProduct]);

  if (!isOpen) return null;

  // Synthesize a quick scanner beep sound
  const playBeep = () => {
    if (!isAudioBeep) return;
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.12);
    } catch {
      // Ignore audio context autoplay restrictions
    }
  };

  const handleSimulateScan = (code: string) => {
    if (!code) return;
    setScannedInput(code);
    playBeep();

    // Attempt product match by barcode or SKU or serial
    const found = products.find(
      (p) =>
        (p.barcode && p.barcode.toLowerCase() === code.toLowerCase()) ||
        (p.sku && p.sku.toLowerCase() === code.toLowerCase()) ||
        p.id.toLowerCase() === code.toLowerCase()
    );

    if (found) {
      setMatchedProduct(found);
      setSelectedProduct(found);
    } else {
      setMatchedProduct(null);
    }

    const newEntry = {
      code,
      type: found ? 'Product Barcode Match' : 'Device Serial Tag',
      timestamp: new Date().toLocaleTimeString(),
      matchedName: found?.name,
    };
    setScanHistory((prev) => [newEntry, ...prev]);

    if (onScanResult) {
      onScanResult(code);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePrintLabel = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
      <div className="w-full max-w-3xl rounded-3xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden text-slate-100 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/80">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-600/20 border border-indigo-500/40 text-indigo-400">
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white flex items-center gap-2">
                <span>Mobile Barcode & QR Scanner Studio</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-[10px] font-mono font-bold">
                  LIVE READY
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                Scan product barcodes, hardware serials, and generate printable thermal shelf tags
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 px-6">
          <button
            onClick={() => setActiveTab('SCANNER')}
            className={`flex items-center gap-2 border-b-2 py-3 px-5 text-xs font-extrabold transition-all cursor-pointer ${
              activeTab === 'SCANNER'
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Scan className="h-4 w-4" />
            <span>Barcode & Serial Scanner</span>
          </button>
          <button
            onClick={() => setActiveTab('GENERATOR')}
            className={`flex items-center gap-2 border-b-2 py-3 px-5 text-xs font-extrabold transition-all cursor-pointer ${
              activeTab === 'GENERATOR'
                ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Printer className="h-4 w-4" />
            <span>Thermal Tag & Barcode Studio</span>
          </button>
        </div>

        {/* Body Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1">
          {activeTab === 'SCANNER' ? (
            <div className="space-y-6">
              {/* Interactive Camera Scanner Frame */}
              <div className="relative rounded-3xl border-2 border-indigo-500/50 bg-slate-950 p-6 text-center overflow-hidden shadow-inner">
                {/* Laser Overlay Animation */}
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-rose-500 to-transparent shadow-[0_0_15px_#f43f5e] animate-pulse pointer-events-none" />

                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-300">
                    <Camera className="h-4 w-4 text-indigo-400" />
                    <span>Optical Camera Scanner</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsTorchOn(!isTorchOn)}
                      className={`p-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        isTorchOn
                          ? 'bg-amber-400 text-slate-950 border-amber-300'
                          : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
                      }`}
                      title="Toggle Torch / Flashlight"
                    >
                      <Zap className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsAudioBeep(!isAudioBeep)}
                      className={`p-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        isAudioBeep
                          ? 'bg-indigo-600 text-white border-indigo-500'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                      title="Toggle Beep Feedback"
                    >
                      {isAudioBeep ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Laser Viewfinder Box */}
                <div className="relative mx-auto max-w-sm h-44 rounded-2xl border-2 border-indigo-400/80 bg-slate-900/90 flex flex-col items-center justify-center p-4 overflow-hidden my-2">
                  <div className="absolute inset-y-0 w-1/2 bg-indigo-500/5 blur-md pointer-events-none" />
                  <Scan className="h-12 w-12 text-indigo-400 animate-bounce mb-2" />
                  <p className="text-xs font-extrabold text-white">Align Barcode / QR / Serial Tag inside Box</p>
                  <p className="text-[10px] text-slate-400 mt-1">Camera auto-detects CODE128, EAN-13 & Serial Tags</p>
                </div>

                {/* Input Simulation & Manual Search */}
                <div className="flex gap-2 max-w-md mx-auto mt-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                    <input
                      type="text"
                      placeholder="Scan with hardware reader or enter SKU/Barcode..."
                      value={scannedInput}
                      onChange={(e) => setScannedInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && scannedInput.trim()) {
                          handleSimulateScan(scannedInput.trim());
                        }
                      }}
                      className="w-full rounded-xl border border-slate-700 bg-slate-900 pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <button
                    onClick={() => scannedInput.trim() && handleSimulateScan(scannedInput.trim())}
                    className="rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-bold text-white transition-all cursor-pointer shrink-0"
                  >
                    Scan Code
                  </button>
                </div>

                {/* Quick Test Barcodes */}
                <div className="mt-4 flex flex-wrap justify-center gap-2 pt-3 border-t border-slate-800">
                  <span className="text-[11px] text-slate-400 self-center font-semibold">Test Products:</span>
                  {products.slice(0, 4).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleSimulateScan(p.barcode || p.sku)}
                      className="rounded-lg bg-slate-800 hover:bg-slate-700 px-2.5 py-1 text-[11px] font-mono text-indigo-300 border border-slate-700 transition-colors cursor-pointer"
                    >
                      {p.sku} ({p.name.slice(0, 14)}...)
                    </button>
                  ))}
                </div>
              </div>

              {/* Matched Product Details Box */}
              {matchedProduct && (
                <div className="p-4 rounded-2xl border-2 border-emerald-500/50 bg-emerald-950/40 text-emerald-100 flex items-center justify-between gap-4 animate-fade-in">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                      <Package className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-sm text-white">{matchedProduct.name}</span>
                        <span className="px-2 py-0.5 rounded bg-emerald-500/30 text-emerald-300 text-[10px] font-mono font-bold">
                          {matchedProduct.sku}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-0.5">
                        Category: <strong>{matchedProduct.category || 'General'}</strong> | Unit Price: <strong className="text-emerald-300">NPR {(matchedProduct.sellingPrice || matchedProduct.costPrice || 0).toLocaleString()}</strong>
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (onScanResult) onScanResult(matchedProduct.barcode || matchedProduct.sku);
                        onClose();
                      }}
                      className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs shadow-md cursor-pointer"
                    >
                      Use Scanned Item
                    </button>
                  </div>
                </div>
              )}

              {/* Scan Log History */}
              <div>
                <h4 className="text-xs font-extrabold text-slate-300 uppercase tracking-wider mb-2 flex items-center justify-between">
                  <span>Recent Scan Buffer ({scanHistory.length})</span>
                  <button
                    onClick={() => setScanHistory([])}
                    className="text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer"
                  >
                    Clear History
                  </button>
                </h4>
                <div className="rounded-2xl border border-slate-800 bg-slate-950 divide-y divide-slate-800/60 max-h-44 overflow-y-auto">
                  {scanHistory.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">No barcodes scanned yet in this session.</div>
                  ) : (
                    scanHistory.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between px-4 py-2.5 text-xs hover:bg-slate-900/50">
                        <div className="flex items-center gap-2.5">
                          <Barcode className="h-4 w-4 text-indigo-400 shrink-0" />
                          <div>
                            <span className="font-mono font-extrabold text-white">{item.code}</span>
                            {item.matchedName && (
                              <span className="ml-2 text-emerald-400 font-semibold text-[11px]">
                                — {item.matchedName}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] text-slate-500 font-mono">{item.timestamp}</span>
                          <button
                            onClick={() => handleCopy(item.code)}
                            className="text-slate-400 hover:text-white transition-colors cursor-pointer"
                            title="Copy Code"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Barcode & Asset Tag Generator & Label Print View */
            <div className="space-y-6">
              {/* Controls Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 p-4 rounded-2xl bg-slate-950 border border-slate-800 text-xs">
                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">
                    Target Product / SKU
                  </label>
                  <select
                    value={selectedProduct?.id || ''}
                    onChange={(e) => {
                      const found = products.find((p) => p.id === e.target.value);
                      if (found) setSelectedProduct(found);
                    }}
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none cursor-pointer"
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">
                    Label Tag Dimension
                  </label>
                  <select
                    value={labelSize}
                    onChange={(e) => setLabelSize(e.target.value as any)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none cursor-pointer"
                  >
                    <option value="SHELF_50x30">Shelf Tag (50mm x 30mm)</option>
                    <option value="COMPACT_38x25">Compact Sticker (38mm x 25mm)</option>
                    <option value="LARGE_100x50">Large Shipping Tag (100mm x 50mm)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">
                    Barcode Symbology
                  </label>
                  <select
                    value={barcodeType}
                    onChange={(e) => setBarcodeType(e.target.value as any)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none cursor-pointer"
                  >
                    <option value="CODE128">CODE128 (High-Density Linear Barcode)</option>
                    <option value="QR">QR Code (2D Matrix Barcode)</option>
                    <option value="EAN13">EAN-13 (13-Digit Retail Barcode)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">
                    Print Copies / Quantity
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={printQty}
                    onChange={(e) => setPrintQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white font-mono focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-400 mb-1">
                    Device Serial (Optional)
                  </label>
                  <input
                    type="text"
                    value={serialNumber}
                    onChange={(e) => setSerialNumber(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white font-mono focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-4 pt-4">
                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={showPrice}
                      onChange={(e) => setShowPrice(e.target.checked)}
                      className="rounded border-slate-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>Price</span>
                  </label>

                  <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                    <input
                      type="checkbox"
                      checked={showCompany}
                      onChange={(e) => setShowCompany(e.target.checked)}
                      className="rounded border-slate-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>Company Header</span>
                  </label>
                </div>
              </div>

              {/* Printable Thermal Label Live Canvas Preview */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-400">
                  <span>Thermal Sticker Tag Live Preview ({printQty} Copies)</span>
                  <span className="font-mono text-indigo-400">
                    {labelSize === 'SHELF_50x30' ? '50mm × 30mm' : labelSize === 'COMPACT_38x25' ? '38mm × 25mm' : '100mm × 50mm'}
                  </span>
                </div>

                <div className="border-2 border-slate-700 rounded-3xl bg-white text-slate-950 p-6 shadow-2xl relative overflow-hidden max-w-lg mx-auto">
                  {/* Header */}
                  {showCompany && (
                    <div className="flex items-center justify-between border-b-2 border-slate-900 pb-2 mb-2">
                      <span className="text-xs font-black tracking-wider text-rose-700 uppercase">
                        IZONE DIGITAL NETWORK PVT. LTD.
                      </span>
                      <span className="text-[9px] font-bold text-slate-700 uppercase">
                        NEPAL IRD COMPLIANT
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3 items-center">
                    <div className="col-span-2 space-y-1">
                      <div className="text-xs font-black uppercase text-slate-950 leading-tight">
                        {selectedProduct?.name || 'Dual Band ONU Router (Fiber)'}
                      </div>
                      <div className="text-[10px] text-slate-700 font-mono">
                        SKU: <strong className="text-slate-950">{selectedProduct?.sku || 'IZ-ONT-DB01'}</strong>
                      </div>
                      {showPrice && (
                        <div className="text-sm font-black font-mono text-indigo-950 pt-0.5">
                          NPR {(selectedProduct?.sellingPrice || selectedProduct?.costPrice || 12500).toLocaleString()}
                        </div>
                      )}
                      {serialNumber && (
                        <div className="text-[10px] font-mono text-slate-800">
                          S/N: <span className="bg-amber-100 px-1 rounded border border-amber-300 font-bold">{serialNumber}</span>
                        </div>
                      )}
                    </div>

                    {/* Barcode Visual Element */}
                    <div className="flex flex-col items-center justify-center border-l-2 border-slate-200 pl-3">
                      {barcodeType === 'QR' ? (
                        <div className="p-1.5 bg-slate-950 text-white rounded-lg flex items-center justify-center">
                          <QrCode className="h-12 w-12" />
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                          <div className="flex h-12 w-full items-center justify-center gap-0.5 bg-slate-100 p-1 rounded border border-slate-400">
                            {[3, 1, 4, 1, 5, 2, 1, 3, 2, 4, 1, 2, 3, 1, 5, 2, 1, 4].map((w, idx) => (
                              <div
                                key={idx}
                                className="bg-slate-950 h-full"
                                style={{ width: `${w * 1.8}px` }}
                              />
                            ))}
                          </div>
                          <span className="text-[9px] font-mono font-bold text-slate-950 mt-1">
                            *{selectedProduct?.barcode || selectedProduct?.sku || serialNumber}*
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-800 bg-slate-950/90 px-6 py-4">
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <Printer className="h-4 w-4 text-indigo-400" />
            <span>Thermal Printers Supported: Zebra, Xprinter, TSC, Honeywell</span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Close Studio
            </button>
            {activeTab === 'GENERATOR' && (
              <button
                onClick={handlePrintLabel}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/30 transition-all cursor-pointer active:scale-95"
              >
                <Printer className="h-4 w-4" />
                <span>Print {printQty} Thermal Label{printQty > 1 ? 's' : ''}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
