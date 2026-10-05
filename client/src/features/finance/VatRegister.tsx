import React, { useState } from 'react';
import { PurchaseInvoice, CompanyProfile } from '../../types';
import { formatDualDate } from '../../utils/nepaliCalendar';
import { exportToCSV } from '../../utils/exportUtils';
import { formatNPR } from '../../utils/nprFormat';
import { getDefaultTaxRate } from '../../utils/taxConfig';
import { DocumentLetterhead } from '../../components/common/DocumentLetterhead';
import { FilterCard } from '../../components/common/FilterCard';
import { PageHeader } from '../../components/common/PageHeader';
import {
  Receipt,
  FileSpreadsheet,
  Download,
  Printer,
  DollarSign,
  Percent,
} from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';
import { StatCard } from '../../components/common/StatCard';

interface VatRegisterProps {
  invoices: PurchaseInvoice[];
  dateMode: 'BS' | 'AD';
  companyProfile?: CompanyProfile | null;
}

export const VatRegister: React.FC<VatRegisterProps> = ({
  invoices,
  dateMode,
  companyProfile,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  // 'TAXABLE' is the rate-agnostic token for "has input VAT"; its label always
  // renders the company-configured rate instead of a hard-coded 13%.
  const [vatTypeFilter, setVatTypeFilter] = useState<'ALL' | 'TAXABLE' | '0%'>('ALL');

  const filteredInvoices = (invoices || []).filter((inv) => {
    const matchesSearch =
      !searchQuery ||
      inv.invoiceNumber?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      inv.supplierName?.toLowerCase().includes((searchQuery || '').toLowerCase()) ||
      inv.vendorBillNumber?.toLowerCase().includes((searchQuery || '').toLowerCase());

    const vatAmt = inv.vatAmount ?? 0;
    if (vatTypeFilter === 'TAXABLE') return matchesSearch && vatAmt > 0;
    if (vatTypeFilter === '0%') return matchesSearch && vatAmt === 0;

    return matchesSearch;
  });

  const totalTaxableAmount = filteredInvoices.reduce(
    (sum, inv) => sum + ((inv.taxableAmount ?? inv.subtotalAmount ?? 0) - (inv.totalDiscount ?? 0)),
    0
  );
  const totalVatAmount = filteredInvoices.reduce((sum, inv) => sum + (inv.vatAmount ?? 0), 0);
  const totalGrandAmount = filteredInvoices.reduce((sum, inv) => sum + (inv.grandTotal ?? 0), 0);

  const vatPagination = useClientPagination(filteredInvoices, 15, [searchQuery, vatTypeFilter]);

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
      { key: 'VAT13Percent', label: `VAT ${getDefaultTaxRate()}%` },
      { key: 'GrandTotal', label: 'Grand Total' },
      { key: 'PaymentStatus', label: 'Status' },
    ], companyProfile);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="printable-document space-y-6">
      {/* Company letterhead — print/export only (hidden on screen) */}
      <DocumentLetterhead
        companyProfile={companyProfile}
        title="Value Added Tax (VAT) Register"
        subtitle={`IRD Nepal Tax compliant Purchase VAT Ledger, ${getDefaultTaxRate()}% input tax deduction register, and supplier PAN records.`}
      />

      {/* Header — shared PageHeader (single h2 per screen rule). The screen
          description lives only here; the print letterhead keeps its own
          print-only subtitle. */}
      <PageHeader
        title="Value Added Tax (VAT) Register"
        description={`IRD Nepal Tax compliant Purchase VAT Ledger, ${getDefaultTaxRate()}% input tax deduction register, and supplier PAN records.`}
        icon={<Receipt className="h-5 w-5 text-indigo-500" />}
        actionsClassName="items-center"
        actions={
          <>
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5 text-slate-400" />
              <span>Export IRD CSV</span>
            </button>

            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer border-slate-300 bg-white text-slate-700 hover:bg-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <Printer className="h-3.5 w-3.5 text-slate-400" />
              <span>Print Register</span>
            </button>
          </>
        }
      />

      {/* Summary KPI Cards — shared compact StatCard component */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatCard
          label="TOTAL TAXABLE PURCHASE"
          icon={<DollarSign className="h-4 w-4" />}
          tone="emerald"
          value={formatNPR(totalTaxableAmount)}
          hint={`Subtotal before ${getDefaultTaxRate()}% VAT calculation`}
        />
        <StatCard
          label={`${getDefaultTaxRate()}% INPUT VAT CREDIT`}
          icon={<Percent className="h-4 w-4" />}
          tone="indigo"
          value={formatNPR(totalVatAmount)}
          hint="Claimable Input Tax Credit from Purchase Invoices"
        />
        <StatCard
          label="GROSS INVOICE VALUE"
          icon={<FileSpreadsheet className="h-4 w-4" />}
          tone="amber"
          value={formatNPR(totalGrandAmount)}
          hint={`Total Purchase Cost including VAT (${filteredInvoices.length} Invoices)`}
        />
      </div>

      {/* Filter and Search Bar — shared FilterCard for register consistency. */}
      <FilterCard
        searchPlaceholder="Search Tax Invoice #, Supplier, PAN..."
        searchValue={searchQuery}
        onSearchApply={setSearchQuery}
        hasActiveFilters={Boolean(searchQuery) || vatTypeFilter !== 'ALL'}
        onClearAll={() => {
          setSearchQuery('');
          setVatTypeFilter('ALL');
        }}
        rightChildren={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setVatTypeFilter('ALL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${vatTypeFilter === 'ALL' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
            >
              All Rates
            </button>
            <button
              onClick={() => setVatTypeFilter('TAXABLE')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${vatTypeFilter === 'TAXABLE' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
            >
              {getDefaultTaxRate()}% Taxable
            </button>
            <button
              onClick={() => setVatTypeFilter('0%')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${vatTypeFilter === '0%' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}
            >
              0% Exempt
            </button>
          </div>
        }
      />

      {/* Tax Invoice Table */}
      <div
        className={`rounded-2xl border overflow-hidden bg-white border-slate-200 dark:bg-slate-900/40 dark:border-slate-800`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead
              className={`border-b font-bold uppercase tracking-wider text-[10px] bg-slate-100 border-slate-200 text-slate-700 dark:bg-slate-800/90 dark:border-slate-700 dark:text-slate-300`}
            >
              <tr>
                <th className="px-2.5 py-1.5">Tax Invoice #</th>
                <th className="px-2.5 py-1.5">Invoice Date</th>
                <th className="px-2.5 py-1.5">Supplier Name</th>
                <th className="px-2.5 py-1.5">PAN / VAT No</th>
                <th className="px-2.5 py-1.5 text-right">Taxable Subtotal</th>
                <th className="px-2.5 py-1.5 text-right">{getDefaultTaxRate()}% Input VAT</th>
                <th className="px-2.5 py-1.5 text-right">Grand Total (NPR)</th>
                <th className="px-2.5 py-1.5 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                    No purchase tax invoices matching your filter criteria.
                  </td>
                </tr>
              ) : (
                vatPagination.pagedItems.map((inv) => {
                  const taxable = (inv.taxableAmount ?? inv.subtotalAmount ?? 0) - (inv.totalDiscount ?? 0);
                  const vat = inv.vatAmount ?? 0;
                  const grand = inv.grandTotal ?? 0;
                  return (
                    <tr
                      key={inv.id}
                      className={`hover:bg-slate-200 dark:hover:bg-slate-800/40 transition-colors text-slate-800 dark:text-slate-300`}
                    >
                      <td className={`px-2.5 py-1.5 font-mono font-bold text-indigo-600 dark:text-indigo-400`}>
                        {inv.invoiceNumber}
                      </td>
                      <td className="px-2.5 py-1.5 font-mono text-[11px]">
                        {formatDualDate(inv.invoiceDateAD, dateMode)}
                      </td>
                      <td className="px-2.5 py-1.5 font-bold">{inv.supplierName}</td>
                      <td className="px-2.5 py-1.5 font-mono text-slate-400">
                        {inv.vendorBillNumber || '600123987'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono">
                        {formatNPR(taxable)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-bold text-indigo-500">
                        {formatNPR(vat)}
                      </td>
                      <td className="px-2.5 py-1.5 text-right font-mono font-bold">
                        {formatNPR(grand)}
                      </td>
                      <td className="px-2.5 py-1.5 text-center">
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
              className={`border-t font-bold text-xs bg-slate-100 border-slate-200 text-slate-800 dark:bg-slate-900/80 dark:border-slate-800 dark:text-slate-200`}
            >
              <tr>
                <td colSpan={4} className="px-2.5 py-1.5 text-right uppercase tracking-wider">
                  Total Tax Register Balance:
                </td>
                <td className={`px-2.5 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400`}>
                  {formatNPR(totalTaxableAmount)}
                </td>
                <td className={`px-2.5 py-1.5 text-right font-mono text-indigo-600 dark:text-indigo-400`}>
                  {formatNPR(totalVatAmount)}
                </td>
                <td className="px-2.5 py-1.5 text-right font-mono">
                  {formatNPR(totalGrandAmount)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <TablePagination
          page={vatPagination.page}
          pageCount={vatPagination.pageCount}
          totalItems={vatPagination.totalItems}
          rangeStart={vatPagination.rangeStart}
          rangeEnd={vatPagination.rangeEnd}
          pageSize={vatPagination.pageSize}
          onPageChange={vatPagination.setPage}
          onPageSizeChange={vatPagination.setPageSize}
          className="mt-1"
        />
      </div>
    </div>
  );
};
