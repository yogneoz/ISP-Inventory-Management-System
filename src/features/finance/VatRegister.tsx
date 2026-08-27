import React, { useState } from 'react';
import { PurchaseInvoice } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import {
  Receipt,
  FileSpreadsheet,
  Download,
  Printer,
  Search,
  Filter,
  CheckCircle2,
  Calendar,
  DollarSign,
  Percent,
} from 'lucide-react';

interface VatRegisterProps {
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  isDarkMode?: boolean;
}

export const VatRegister: React.FC<VatRegisterProps> = ({
  invoices,
  dateMode,
  isDarkMode = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [vatTypeFilter, setVatTypeFilter] = useState<'ALL' | '13%' | '0%'>('ALL');

  const filteredInvoices = (invoices || []).filter((inv) => {
    const matchesSearch =
      !searchQuery ||
      inv.invoiceNumber?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      inv.supplierName?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      inv.vendorBillNumber?.toLowerCase().includes((searchQuery || '').toLowerCase());

    const vatAmt = inv.vatAmount ?? 0;
    if (vatTypeFilter === '13%') return matchesSearch && vatAmt > 0;
    if (vatTypeFilter === '0%') return matchesSearch && vatAmt === 0;

    return matchesSearch;
  });

  const totalTaxableAmount = filteredInvoices.reduce(
    (sum, inv) => sum + ((inv.taxableAmount ?? inv.subtotalAmount ?? 0) - (inv.totalDiscount ?? 0)),
    0
  );
  const totalVatAmount = filteredInvoices.reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const totalGrandAmount = filteredInvoices.reduce((sum, inv) => sum + (inv.grandTotal ?? 0), 0);

  const handleExportCSV = () => {
    const data = filteredInvoices.map((inv) => ({
      InvoiceNumber: inv.invoiceNumber,
      DateAD: inv.invoiceDateAD,
      DateBS: inv.invoiceDateBS,
      SupplierName: inv.supplierName,
      SupplierPAN: inv.vendorBillNumber || '600123987',
      TaxableSubtotal: (inv.taxableAmount ?? inv.subtotalAmount ?? 0) - (inv.totalDiscount ?? 0),
      VAT13Percent: inv.vatAmount ?? 0,
      GrandTotal: inv.grandTotal ?? 0,
      PaymentStatus: inv.paymentStatus,
    }));

    exportToCSV('IRD_Nepal_VAT_Register', data, [
      { key: 'InvoiceNumber', label: 'Tax Invoice #' },
      { key: 'DateAD', label: 'Date (AD)' },
      { key: 'DateBS', label: 'Date (BS)' },
      { key: 'SupplierName', label: 'Supplier Name' },
      { key: 'SupplierPAN', label: 'PAN / VAT #' },
      { key: 'TaxableSubtotal', label: 'Taxable Subtotal' },
      { key: 'VAT13Percent', label: 'VAT 13%' },
      { key: 'GrandTotal', label: 'Grand Total' },
      { key: 'PaymentStatus', label: 'Status' },
    ]);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className={`text-xl font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <Receipt className="h-6 w-6 text-indigo-500" />
            <span>Value Added Tax (VAT) Register</span>
          </h2>
          <p className="text-slate-400 text-xs mt-0.5">
            IRD Nepal Tax compliant Purchase VAT Ledger, 13% input tax deduction register, and supplier PAN records.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              isDarkMode
                ? 'border-slate-800 bg-slate-900 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Download className="h-3.5 w-3.5 text-slate-400" />
            <span>Export IRD CSV</span>
          </button>

          <button
            onClick={handlePrint}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer ${
              isDarkMode
                ? 'border-slate-800 bg-slate-900 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Printer className="h-3.5 w-3.5 text-slate-400" />
            <span>Print Register</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div
          className={`p-5 rounded-2xl border ${
            isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
            <span>TOTAL TAXABLE PURCHASE</span>
            <DollarSign className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="text-2xl font-bold font-mono text-slate-900 dark:text-white">
            {(totalTaxableAmount ?? 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Subtotal before 13% VAT calculation
          </p>
        </div>

        <div
          className={`p-5 rounded-2xl border ${
            isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
            <span>13% INPUT VAT CREDIT</span>
            <Percent className="h-4 w-4 text-indigo-500" />
          </div>
          <p className="text-2xl font-bold font-mono text-indigo-500">
            {(totalVatAmount ?? 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Claimable Input Tax Credit from Purchase Invoices
          </p>
        </div>

        <div
          className={`p-5 rounded-2xl border ${
            isDarkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold mb-2">
            <span>GROSS INVOICE VALUE</span>
            <FileSpreadsheet className="h-4 w-4 text-amber-500" />
          </div>
          <p className="text-2xl font-bold font-mono text-amber-500">
            {(totalGrandAmount ?? 0).toLocaleString('en-IN')}
          </p>
          <p className="text-[11px] text-slate-400 mt-1">
            Total Purchase Cost including VAT ({filteredInvoices.length} Invoices)
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        className={`p-4 rounded-2xl border flex flex-col md:flex-row gap-3 items-center justify-between ${
          isDarkMode ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border w-full md:w-80 text-xs ${
            isDarkMode ? 'bg-slate-900 border-slate-800 text-white' : 'bg-slate-50 border-slate-200 text-slate-800'
          }`}
        >
          <Search className="h-4 w-4 text-slate-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search Tax Invoice #, Supplier, PAN..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-transparent focus:outline-none placeholder:text-slate-400"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <span className="text-xs font-semibold text-slate-400">VAT Rate:</span>
          <button
            onClick={() => setVatTypeFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              vatTypeFilter === 'ALL'
                ? 'bg-indigo-600 text-white'
                : isDarkMode
                ? 'bg-slate-800 text-slate-300'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            All Rates
          </button>
          <button
            onClick={() => setVatTypeFilter('13%')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              vatTypeFilter === '13%'
                ? 'bg-indigo-600 text-white'
                : isDarkMode
                ? 'bg-slate-800 text-slate-300'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            13% Taxable
          </button>
          <button
            onClick={() => setVatTypeFilter('0%')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              vatTypeFilter === '0%'
                ? 'bg-indigo-600 text-white'
                : isDarkMode
                ? 'bg-slate-800 text-slate-300'
                : 'bg-slate-100 text-slate-700'
            }`}
          >
            0% Exempt
          </button>
        </div>
      </div>

      {/* Tax Invoice Table */}
      <div
        className={`rounded-2xl border overflow-hidden ${
          isDarkMode ? 'bg-slate-900/40 border-slate-800' : 'bg-white border-slate-200'
        }`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead
              className={`border-b font-bold uppercase tracking-wider text-[10px] ${
                isDarkMode ? 'bg-slate-800/90 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700'
              }`}
            >
              <tr>
                <th className="px-4 py-3">Tax Invoice #</th>
                <th className="px-4 py-3">Invoice Date</th>
                <th className="px-4 py-3">Supplier Name</th>
                <th className="px-4 py-3">PAN / VAT No</th>
                <th className="px-4 py-3 text-right">Taxable Subtotal</th>
                <th className="px-4 py-3 text-right">13% Input VAT</th>
                <th className="px-4 py-3 text-right">Grand Total</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No purchase tax invoices matching your filter criteria.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const taxable = (inv.taxableAmount ?? inv.subtotalAmount ?? 0) - (inv.totalDiscount ?? 0);
                  const vat = inv.vatAmount ?? 0;
                  const grand = inv.grandTotal ?? 0;
                  return (
                    <tr
                      key={inv.id}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors ${
                        isDarkMode ? 'text-slate-300' : 'text-slate-800'
                      }`}
                    >
                      <td className="px-4 py-3 font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        {inv.invoiceNumber}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        {formatDualDate(inv.invoiceDateAD, dateMode)}
                      </td>
                      <td className="px-4 py-3 font-bold">{inv.supplierName}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">
                        {inv.vendorBillNumber || '600123987'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {(taxable ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-indigo-500">
                        {(vat ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-bold">
                        {(grand ?? 0).toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            inv.paymentStatus === 'PAID'
                              ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800'
                              : 'bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-800'
                          }`}
                        >
                          {inv.paymentStatus}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            <tfoot
              className={`border-t font-bold text-xs ${
                isDarkMode ? 'bg-slate-900/80 border-slate-800 text-slate-200' : 'bg-slate-100 border-slate-200 text-slate-800'
              }`}
            >
              <tr>
                <td colSpan={4} className="px-4 py-3 text-right uppercase tracking-wider">
                  Total Tax Register Balance:
                </td>
                <td className="px-4 py-3 text-right font-mono text-emerald-600 dark:text-emerald-400">
                  {(totalTaxableAmount ?? 0).toLocaleString('en-IN')}
                </td>
                <td className="px-4 py-3 text-right font-mono text-indigo-600 dark:text-indigo-400">
                  {(totalVatAmount ?? 0).toLocaleString('en-IN')}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {(totalGrandAmount ?? 0).toLocaleString('en-IN')}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
};
