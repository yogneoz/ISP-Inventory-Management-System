/**
 * Read-side view of the seller warranty captured with a sales invoice.
 *
 * WTY-5 stores the promise per serialised line. The register can only show one
 * cell per invoice, so this collapses the lines without inventing a single
 * expiry when they disagree: an invoice with two different covered dates stays
 * "multiple" and the UI can name the earliest one.
 */
import type { SalesInvoiceItem } from '../types';

export type SalesWarrantyCoverage = 'COVERED' | 'NOT_COVERED' | 'NOT_RECORDED' | 'NONE';

export type SalesWarrantyState =
  | 'NONE'
  | 'NOT_RECORDED'
  | 'NOT_COVERED'
  | 'COVERED'
  | 'MULTIPLE'
  | 'MIXED';

export interface SalesWarrantySummary {
  state: SalesWarrantyState;
  /** Earliest covered expiry (ISO AD), present for COVERED and MULTIPLE. */
  endDateAD?: string;
  /** Number of distinct covered expiry dates (0 unless covered lines exist). */
  dateCount: number;
  coveredCount: number;
  uncoveredCount: number;
  unrecordedCount: number;
}

/** A line that belongs to a serialised unit, whether or not a promise was captured. */
export function isWarrantyBearingLine(item: SalesInvoiceItem): boolean {
  return Boolean(
    item.sellerWarrantyCovered !== undefined ||
      item.sellerWarrantyEndDateAD ||
      (item.deviceSerials && item.deviceSerials.length > 0)
  );
}

/**
 * The per-line coverage answer, independent of how the UI chooses to style it.
 * `NONE` means a quantity-only line, not "no warranty".
 */
export function salesWarrantyCoverage(item: SalesInvoiceItem): SalesWarrantyCoverage {
  if (!isWarrantyBearingLine(item)) return 'NONE';
  if (item.sellerWarrantyCovered === false) return 'NOT_COVERED';
  return item.sellerWarrantyEndDateAD ? 'COVERED' : 'NOT_RECORDED';
}

/** Human wording shared by the print/export row and the read-only chips. */
export function salesWarrantyCoverageLabel(item: SalesInvoiceItem): string {
  switch (salesWarrantyCoverage(item)) {
    case 'COVERED':
      return 'Covered';
    case 'NOT_COVERED':
      return 'Not covered';
    case 'NOT_RECORDED':
      return 'Not recorded';
    default:
      return '';
  }
}

/**
 * Summarise the warranty promise on one invoice.
 *
 * `sellerWarrantyCovered === false` is an explicit "no coverage"; a missing
 * switch/date on a serialised line is "not recorded", so old invoices never
 * masquerade as either covered or uncovered.
 */
export function summarizeSalesWarranty(
  items: SalesInvoiceItem[] | null | undefined
): SalesWarrantySummary {
  const lines = (items || []).filter(isWarrantyBearingLine);
  if (lines.length === 0) {
    return {
      state: 'NONE',
      dateCount: 0,
      coveredCount: 0,
      uncoveredCount: 0,
      unrecordedCount: 0,
    };
  }

  const dates = new Set<string>();
  let coveredCount = 0;
  let uncoveredCount = 0;
  let unrecordedCount = 0;

  for (const line of lines) {
    if (line.sellerWarrantyCovered === false) {
      uncoveredCount += 1;
      continue;
    }
    if (line.sellerWarrantyEndDateAD) {
      coveredCount += 1;
      dates.add(line.sellerWarrantyEndDateAD);
      continue;
    }
    unrecordedCount += 1;
  }

  const orderedDates = [...dates].sort();
  const counts = { coveredCount, uncoveredCount, unrecordedCount };

  if (coveredCount === 0 && uncoveredCount === 0) {
    return { state: 'NOT_RECORDED', dateCount: 0, ...counts };
  }
  if (coveredCount === 0) {
    return { state: 'NOT_COVERED', dateCount: 0, ...counts };
  }
  if (uncoveredCount > 0 || unrecordedCount > 0) {
    return {
      state: 'MIXED',
      endDateAD: orderedDates[0],
      dateCount: orderedDates.length,
      ...counts,
    };
  }
  return {
    state: orderedDates.length > 1 ? 'MULTIPLE' : 'COVERED',
    endDateAD: orderedDates[0],
    dateCount: orderedDates.length,
    ...counts,
  };
}
