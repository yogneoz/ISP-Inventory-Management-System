/**
 * CSV projection of the two warranty registers.
 *
 * The registers are paged, so a file built from the rows on screen would
 * publish one page as the whole filtered population; callers pass the unpaged
 * read (`all: true`). Both calendars travel for both dates: AD is the stored
 * authority and BS is derived here once, so a spreadsheet never has to convert
 * a Nepali date itself — or silently lose it.
 *
 * State wording matches the register's pill, not the stored enum, so a reader
 * who has seen the screen recognises the file.
 */
import type { WarrantyCoverageRow } from '../types';
import type { CSVColumn } from './exportUtils';
import { BS_NOT_SEEDED, tryConvertADToBS } from './nepaliCalendar';

export interface WarrantyExportRow {
  product: string;
  category: string;
  serial: string;
  party: string;
  source: string;
  sourceNumber: string;
  branch: string;
  startAD: string;
  startBS: string;
  expiryAD: string;
  expiryBS: string;
  state: string;
  daysRemaining: string;
  retired: string;
  notes: string;
}

const SOURCE_LABELS: Record<string, string> = {
  PURCHASE_INVOICE: 'Purchase invoice',
  FIXED_ASSET: 'Fixed asset',
  CUSTOMER_ASSIGNMENT: 'Asset assignment',
  CUSTOMER_DEVICE: 'Device issue',
  CUSTOMER_EXCHANGE: 'Device exchange',
  SALES_INVOICE: 'Sales invoice',
  SALES_RETURN: 'Sales return',
};

const RETIRED_REASON_LABELS: Record<string, string> = {
  SALES_RETURN: 'Returned by customer',
  PURCHASE_RETURN: 'Returned to supplier',
};

const STATE_LABELS: Record<WarrantyCoverageRow['warrantyState'], string> = {
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon (within 30 days)',
  EXPIRED: 'Expired',
  RETURNED: 'Returned (retired)',
};

/** The register's readable source name for a stored source type. */
export function warrantySourceLabel(sourceType?: string | null): string {
  const key = String(sourceType || '').toUpperCase();
  return SOURCE_LABELS[key] || sourceType || '';
}

/** The register's readable category name; the two sides name CPE differently. */
export function warrantyCategoryLabel(category: string | null | undefined, isVendor: boolean): string {
  const key = String(category || '').toUpperCase();
  if (key === 'CPE') return isVendor ? 'Customer CPE' : 'Rental CPE';
  if (key === 'FIXED_ASSET') return 'Fixed asset';
  if (key === 'SOLD_PRODUCT') return 'Sold product';
  return category || '';
}

/** "Returned by customer · CN-…" — empty unless the row was retired. */
export function warrantyRetiredLabel(row: WarrantyCoverageRow): string {
  if (row.warrantyState !== 'RETURNED') return '';
  const reason =
    RETIRED_REASON_LABELS[String(row.retiredReason || '').toUpperCase()] || 'Retired';
  return row.retiredRef ? `${reason} · ${row.retiredRef}` : reason;
}

/**
 * BS for an AD date, or blank when there is no date to convert. An unseeded
 * day carries the app's explicit marker instead of an AD value in a BS column.
 */
function bsOrBlank(adDate: string | null | undefined): string {
  if (!adDate) return '';
  const bs = tryConvertADToBS(adDate.split('T')[0]);
  if (!bs) return BS_NOT_SEEDED;
  return bs.formattedBSShort.replace(' BS', '');
}

/**
 * One CSV row per coverage record. Nothing is recomputed from a term: the
 * stored expiry is what ships, which is the same rule the register renders.
 */
export function buildWarrantyExportRows(
  rows: WarrantyCoverageRow[],
  isVendor: boolean
): WarrantyExportRow[] {
  return (rows || []).map((row) => {
    const returned = row.warrantyState === 'RETURNED';
    const days = Number(row.daysRemaining);
    return {
      product: row.productName || '',
      category: warrantyCategoryLabel(row.itemCategory, isVendor),
      serial: row.serialNumber || '',
      party: row.partyName || '',
      source: warrantySourceLabel(row.sourceType),
      sourceNumber: row.sourceNumber || '',
      branch: row.branchName || row.branchId || '',
      startAD: row.startDateAD || '',
      startBS: bsOrBlank(row.startDateAD),
      expiryAD: row.endDateAD || '',
      expiryBS: bsOrBlank(row.endDateAD),
      state: STATE_LABELS[row.warrantyState] || row.warrantyState || '',
      // A retired row's expiry delta is not what the reader is asking about.
      daysRemaining: returned || !Number.isFinite(days) ? '' : String(days),
      retired: warrantyRetiredLabel(row),
      notes: row.notes || '',
    };
  });
}

/**
 * Column labels for one side. The party column is named for who owes the
 * promise: a supplier on the inbound register, a customer or assignee on the
 * outbound one.
 */
export function warrantyExportColumns(isVendor: boolean): CSVColumn<WarrantyExportRow>[] {
  return [
    { key: 'product', label: 'Product' },
    { key: 'category', label: isVendor ? 'Category' : 'Type' },
    { key: 'serial', label: 'Serial / Tag' },
    { key: 'party', label: isVendor ? 'Supplier' : 'Customer / Assignee' },
    { key: 'source', label: 'Source' },
    { key: 'sourceNumber', label: 'Source Document' },
    { key: 'branch', label: 'Branch' },
    { key: 'startAD', label: 'Coverage Start (AD)' },
    { key: 'startBS', label: 'Coverage Start (BS)' },
    { key: 'expiryAD', label: 'Warranty Expiry (AD)' },
    { key: 'expiryBS', label: 'Warranty Expiry (BS)' },
    { key: 'state', label: 'Warranty State' },
    { key: 'daysRemaining', label: 'Days Remaining' },
    { key: 'retired', label: 'Returned / Retired' },
    { key: 'notes', label: 'Notes' },
  ];
}
