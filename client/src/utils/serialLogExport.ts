/**
 * CSV projection of the serial log register.
 *
 * The register is paged, so callers pass the unpaged read (`all: true`). The
 * last-updated timestamp is a business date like any other: AD is the stored
 * authority and BS is derived here once, so the spreadsheet never has to
 * convert a Nepali date itself — or silently lose it.
 */
import type { SerialLog } from '../types';
import type { CSVColumn } from './exportUtils';
import { formatBSDate } from './nepaliCalendar';

export interface SerialLogExportRow {
  deviceSerial: string;
  ponSerial: string;
  macAddress: string;
  productName: string;
  status: string;
  branchName: string;
  customerName: string;
  historyEvents: number;
  lastUpdatedAD: string;
  lastUpdatedBS: string;
}

export function buildSerialLogExportRows(
  rows: Array<SerialLog & { branchName?: string }>
): SerialLogExportRow[] {
  return (rows || []).map((row) => {
    const lastUpdatedAD = row.updatedAt || row.createdAt || '-';
    return {
      deviceSerial: row.deviceSerial,
      ponSerial: row.ponSerial || '-',
      macAddress: row.macAddress || '-',
      productName: row.productName || '-',
      status: row.status,
      branchName: row.branchName || '-',
      customerName: row.customerName || 'Unassigned Stock',
      historyEvents: (row.history || []).length,
      lastUpdatedAD,
      lastUpdatedBS: formatBSDate(lastUpdatedAD),
    };
  });
}

export function serialLogExportColumns(): CSVColumn<SerialLogExportRow>[] {
  return [
    { key: 'deviceSerial', label: 'Device Serial' },
    { key: 'ponSerial', label: 'PON Serial' },
    { key: 'macAddress', label: 'MAC Address' },
    { key: 'productName', label: 'Product Name' },
    { key: 'status', label: 'Status' },
    { key: 'branchName', label: 'Branch' },
    { key: 'customerName', label: 'Customer (if assigned)' },
    { key: 'historyEvents', label: 'History Events' },
    { key: 'lastUpdatedAD', label: 'Last Updated (AD)' },
    { key: 'lastUpdatedBS', label: 'Last Updated (BS)' },
  ];
}
