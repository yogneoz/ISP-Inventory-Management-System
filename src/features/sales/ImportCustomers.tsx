import React, { useState } from 'react';
import { Branch, CustomerRecord } from '../../types';
import { UserPlus, Download, CheckCircle2, AlertCircle, ArrowRight, FileText, Check, Upload, Smartphone, FileSpreadsheet } from 'lucide-react';
import { useClientPagination, TablePagination } from '../../components/common/TablePagination';

interface ImportCustomersProps {
  branches: Branch[];
  onImportCustomersSuccess?: (newCustomers: CustomerRecord[]) => void;
  isDarkMode?: boolean;
}

interface ParsedCustomerRow {
  customerId: string;
  customerName: string;
  username: string;
  contactNumber: string;
  targetBranchCode: string;
  address: string;
  email?: string;
  isValid: boolean;
  notes: string;
}

const parseCsvRows = (content: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field.trim());
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1;
      row.push(field.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
};

const createCsv = (rows: Record<string, string>[]): string => {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value: string) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
};

export const ImportCustomers: React.FC<ImportCustomersProps> = ({
  branches,
  onImportCustomersSuccess,
  isDarkMode = false,
}) => {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedCustomerRow[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importSuccessMessage, setImportSuccessMessage] = useState<string | null>(null);
  const rowsPagination = useClientPagination(parsedRows, 25, [parsedRows]);

  // Sample data array for CSV creation (example/dummy data only)
  const sampleCsvData = [
    {
      'Cus. Code': 'CUS-10291',
      'Customer Name': 'Example Customer 1',
      'Username': 'example.customer1',
      'Primary Mobile': '9800000011',
      'Branch Code': 'WH001',
      'Address': 'Example Street, Example City',
      'Email': 'example.customer1@example.com',
    },
    {
      'Cus. Code': 'CUS-10292',
      'Customer Name': 'Example Customer 2',
      'Username': 'example.customer2',
      'Primary Mobile': '9800000012',
      'Branch Code': 'BRH01',
      'Address': 'Example Avenue, Example City',
      'Email': 'example.customer2@example.com',
    },
    {
      'Cus. Code': 'CUS-10293',
      'Customer Name': 'Example Customer 3',
      'Username': 'example.customer3',
      'Primary Mobile': '9800000013',
      'Branch Code': 'WH001',
      'Address': 'Example Road, Example City',
      'Email': 'example.customer3@example.com',
    },
    {
      'Cus. Code': 'CUS-10294',
      'Customer Name': 'Example Customer 4',
      'Username': 'example.customer4',
      'Primary Mobile': '9800000014',
      'Branch Code': 'BRH01',
      'Address': 'Example Lane, Example City',
      'Email': 'example.customer4@example.com',
    },
  ];

  const parseCsvContent = (content: string, filename: string) => {
    setSelectedFileName(filename);
    try {
      const csvRows = parseCsvRows(content);
      const headers = csvRows.shift() || [];
      const jsonRows = csvRows.map((values) =>
        headers.reduce<Record<string, string>>((result, header, index) => {
          result[header] = values[index] || '';
          return result;
        }, {})
      );

      if (headers.length === 0 || jsonRows.length === 0) {
        alert('Uploaded CSV file is empty');
        setParsedRows([]);
        return;
      }

      const rows: ParsedCustomerRow[] = [];

      jsonRows.forEach((row: any, idx: number) => {
        // Support flexible header names
        const customerId =
          String(row['Cus. Code'] || row['Cus Code'] || row['CustomerID'] || row['Customer ID'] || row['Code'] || `CUS-${10000 + idx}`).trim();
        const customerName =
          String(row['Customer Name'] || row['CustomerName'] || row['Name'] || '').trim();
        const username =
          String(row['Username'] || row['User Name'] || (customerId || '').toLowerCase()).trim();
        const contactNumber =
          String(row['Primary Mobile'] || row['Contact Number'] || row['Mobile'] || row['Phone'] || '').trim();
        const targetBranchCode =
          String(row['Branch Code'] || row['Branch'] || row['BranchCode'] || 'WH001').trim();
        const address =
          String(row['Address'] || row['Location'] || '').trim();
        const email =
          String(row['Email'] || row['Email Address'] || '').trim();

        const isValid = Boolean(customerName && contactNumber);
        let notes = 'Valid Customer Record';
        if (!customerName) notes = 'Missing Customer Name';
        else if (!contactNumber) notes = 'Missing Primary Mobile';

        rows.push({
          customerId: customerId || `CUS-${10000 + idx}`,
          customerName: customerName || 'Imported Customer',
          username: username || (customerId ? (customerId || '').toLowerCase() : `user${idx}`),
          contactNumber: contactNumber || '9800000000',
          targetBranchCode: targetBranchCode || 'WH001',
          address: address || 'Nepal',
          email,
          isValid,
          notes,
        });
      });

      setParsedRows(rows);
    } catch (err: any) {
      alert(`CSV Parse Error: ${err.message || 'Could not parse CSV file'}`);
      setParsedRows([]);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === 'string' && result) {
        parseCsvContent(result, file.name);
      }
    };
    reader.readAsText(file);
  };

  const handleLoadSample = () => {
    parseCsvContent(createCsv(sampleCsvData), 'Sample_Customer_Master_List.csv');
  };

  const handleDownloadSampleCSV = () => {
    const csvOutput = createCsv(sampleCsvData);
    const blob = new Blob([csvOutput], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'iZone_Customer_Master_Template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleProcessImport = async () => {
    if (parsedRows.length === 0) return;
    setIsProcessing(true);
    setImportSuccessMessage(null);

    try {
      const validRows = parsedRows.filter((r) => r.isValid);
      if (validRows.length === 0) {
        alert('No valid customer rows found to import.');
        return;
      }

      const importedCustomers: CustomerRecord[] = validRows.map((r) => {
        const matchingBranch = branches.find(
          (b) =>
            (b?.code || '').toLowerCase() === (r?.targetBranchCode || '').toLowerCase() ||
            (b?.id || '').toLowerCase() === (r?.targetBranchCode || '').toLowerCase() ||
            (b?.name || '').toLowerCase().includes((r?.targetBranchCode || '').toLowerCase())
        );
        return {
          id: r.customerId || `CUS-${Math.floor(1000 + Math.random() * 9000)}`,
          customerId: r.customerId,
          customerName: r.customerName,
          username: r.username,
          contactNumber: r.contactNumber,
          branchId: matchingBranch ? matchingBranch.id : branches[0]?.id || 'WH001',
          address: r.address,
          email: r.email,
          status: 'ACTIVE',
          assignedDevicesCount: 0,
        };
      });

      if (onImportCustomersSuccess) {
        await onImportCustomersSuccess(importedCustomers);
      }

      setImportSuccessMessage(`Successfully imported ${importedCustomers.length} customer records into Master Directory!`);
      setParsedRows([]);
      setSelectedFileName(null);
    } catch (err: any) {
      alert(`Import error: ${err.message || 'Failed to import customer records'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-6.5rem)] overflow-hidden space-y-4">
      {/* Header */}
      <div className="flex-none flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className={`text-lg font-serif font-bold tracking-tight flex items-center gap-2 ${
            isDarkMode ? 'text-white' : 'text-slate-900'
          }`}>
            <UserPlus className="h-5 w-5 text-indigo-500" />
            <span>Import Customer Database (CSV)</span>
          </h2>
          <p className={`truncate text-xs mt-0.5 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Bulk import customer master records (Cus. Code, Customer Name, Username, Primary Mobile, Branch, Address) via CSV (.csv) template.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          <button
            onClick={handleDownloadSampleCSV}
            className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold cursor-pointer transition-all ${
              isDarkMode ? 'border-slate-800 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <Download className="h-4 w-4 text-emerald-600" />
            <span>Download CSV Template (.csv)</span>
          </button>

          <button
            onClick={handleLoadSample}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 px-3 py-2 text-xs font-semibold hover:bg-indigo-100 transition-all cursor-pointer"
          >
            <Smartphone className="h-4 w-4" />
            <span>Load Sample CSV Data</span>
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
        {/* Upload Dropzone */}
        <div className={`lg:col-span-5 flex flex-col justify-between rounded-2xl border p-5 shadow-sm ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <FileSpreadsheet className="h-4 w-4 text-emerald-500" />
                <span>Upload CSV File</span>
              </label>
              <span className="text-[10px] text-emerald-600 font-mono font-bold">.csv, .txt</span>
            </div>

            <div className={`relative border-2 border-dashed rounded-2xl p-6 text-center flex flex-col items-center justify-center transition-all ${
              selectedFileName
                ? isDarkMode ? 'border-emerald-500 bg-emerald-950/20' : 'border-emerald-500 bg-emerald-50/50'
                : isDarkMode ? 'border-slate-800 bg-slate-900/40 hover:border-slate-700' : 'border-slate-300 bg-slate-50 hover:border-emerald-300'
            }`}>
              <input
                type="file"
                accept=".csv, text/csv, .txt"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />

              <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-3">
                <Upload className="h-6 w-6" />
              </div>

              {selectedFileName ? (
                <div>
                  <span className="font-bold text-xs text-emerald-600 dark:text-emerald-400 block truncate max-w-[200px]">
                    {selectedFileName}
                  </span>
                  <span className="text-[11px] text-slate-400 block mt-0.5">
                    {parsedRows.length} customer records extracted from CSV
                  </span>
                </div>
              ) : (
                <div>
                  <span className="font-bold text-xs text-slate-800 dark:text-slate-200 block">
                    Click to browse or drag & drop CSV (.csv) file
                  </span>
                  <span className="text-[11px] text-slate-400 block mt-1">
                    Columns: Cus. Code, Customer Name, Username, Primary Mobile, Branch Code, Address, Email
                  </span>
                </div>
              )}
            </div>

            <div className="mt-4 p-3.5 rounded-xl border border-indigo-100 dark:border-indigo-950 bg-indigo-50/50 dark:bg-indigo-950/30 text-[11px] text-slate-600 dark:text-slate-300 space-y-1.5">
              <div className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                <span>Customer Master Direct Binding</span>
              </div>
              <p>
                Imported customers populate the Customer Master Table directly and become available instantly for product sales and rental asset assignments.
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 font-medium">
              {parsedRows.length} Records Extracted
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
              <span>{isProcessing ? 'Importing...' : 'Import to Customer Master'}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Live CSV Preview Panel */}
        <div className={`lg:col-span-7 flex flex-col rounded-2xl border shadow-lg overflow-hidden ${
          isDarkMode ? 'bg-[#0f1218] border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className={`p-3.5 border-b flex items-center justify-between ${
            isDarkMode ? 'border-slate-800 bg-slate-900/50' : 'border-slate-200 bg-slate-50'
          }`}>
            <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span>CSV Customer Import Preview</span>
            </span>
            <span className="text-[11px] text-slate-500 font-medium">
              Valid: {parsedRows.filter((r) => r.isValid).length} / {parsedRows.length}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 z-20 font-bold text-[9px] tracking-wider border-b ${
                isDarkMode ? 'bg-[#12161f] text-slate-400 border-slate-800' : 'bg-slate-100 text-slate-700 border-slate-200'
              }`}>
                <tr>
                  <th className="px-2.5 py-1.5">Cus. Code / Name</th>
                  <th className="px-2.5 py-1.5">Username & Mobile</th>
                  <th className="px-2.5 py-1.5">Branch Code</th>
                  <th className="px-2.5 py-1.5">Address</th>
                  <th className="px-2.5 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-slate-200'}`}>
                {parsedRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-12 text-center text-slate-500 text-xs">
                      No CSV file loaded yet. Upload a .csv file or click "Load Sample CSV Data" above.
                    </td>
                  </tr>
                ) : (
                  rowsPagination.pagedItems.map((row, idx) => (
                    <tr key={idx} className={`transition-colors ${
                      isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'
                    }`}>
                      <td className="p-2.5">
                        <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400 text-[11px]">{row.customerId}</div>
                        <div className="font-semibold text-slate-900 dark:text-white line-clamp-1">{row.customerName}</div>
                      </td>
                      <td className="p-2.5 text-[11px]">
                        <div className="font-medium text-slate-800 dark:text-slate-200">@{row.username}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{row.contactNumber}</div>
                      </td>
                      <td className="p-2.5 font-mono text-[11px] font-bold text-slate-700 dark:text-slate-300">
                        {row.targetBranchCode}
                      </td>
                      <td className="p-2.5 text-[11px] text-slate-600 dark:text-slate-400 line-clamp-1">
                        {row.address}
                      </td>
                      <td className="p-2.5">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          row.isValid
                            ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                            : 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                        }`}>
                          {row.isValid ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                          <span>{row.notes}</span>
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={rowsPagination.page}
            pageCount={rowsPagination.pageCount}
            totalItems={rowsPagination.totalItems}
            rangeStart={rowsPagination.rangeStart}
            rangeEnd={rowsPagination.rangeEnd}
            pageSize={rowsPagination.pageSize}
            onPageChange={rowsPagination.setPage}
            onPageSizeChange={rowsPagination.setPageSize}
            isDarkMode={isDarkMode}
            className="mt-1"
          />
        </div>
      </div>
    </div>
  );
};
