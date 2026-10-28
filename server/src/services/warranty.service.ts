/**
 * WTY-1 warranty capture. One place that supersedes the previous current row
 * and inserts the next period, so every flow (purchase, asset, issue, sale,
 * exchange, edit) keeps the one-current-per-unit invariant.
 */
import type { Product, WarrantyCoverageRecord, WarrantyCoverageType, WarrantyItemCategory } from '../../../client/src/types';
import {
  addCalendarMonths,
  DEFAULT_WARRANTY_MONTHS,
  isValidWarrantyRange,
  MAX_WARRANTY_MONTHS,
} from '../../../shared/warrantyTerm';
import { warrantyCoverages, setWarrantyCoverages } from '../state/runtimeState';
import {
  WARRANTY_INSERT_SQL,
  WARRANTY_SUPERSEDE_CURRENT_SQL,
  WARRANTY_SUPERSEDE_BY_DEVICE_SQL,
  WARRANTY_SUPERSEDE_BY_SOURCE_SQL,
  WARRANTY_SUPERSEDE_BY_ID_SQL,
  warrantyInsertParams,
  type WarrantyInsertInput,
} from '../models/warranty.repo';

export interface CaptureCoverageInput extends Omit<WarrantyInsertInput, 'id'> {
  id?: string;
}

export function newWarrantyCoverageId(): string {
  return `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Serials are compared and stored in one canonical form. */
export function normalizeWarrantySerial(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

/** The product's term for one side, or the built-in 12-month default. */
export function warrantyMonthsFor(product: Product | undefined | null, type: WarrantyCoverageType): number {
  const configured = type === 'VENDOR' ? product?.vendorWarrantyMonths : product?.sellerWarrantyMonths;
  const numeric = Number(configured);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= MAX_WARRANTY_MONTHS
    ? Math.trunc(numeric)
    : DEFAULT_WARRANTY_MONTHS;
}

/**
 * The suggested exact expiry for a new coverage. `0` months means "no
 * warranty", so there is no date to write. An operator-entered date always
 * wins in the caller; this is only the prefill/fallback.
 */
export function defaultCoverageEnd(
  startDateAD: string,
  product: Product | undefined | null,
  type: WarrantyCoverageType
): { termMonths: number; endDateAD: string | null } {
  const termMonths = warrantyMonthsFor(product, type);
  if (termMonths <= 0) return { termMonths: 0, endDateAD: null };
  return { termMonths, endDateAD: addCalendarMonths(startDateAD, termMonths) };
}

/** One validation rule for every capture path and the edit endpoint. */
export function warrantyDateError(startDateAD: unknown, endDateAD: unknown): string | null {
  const start = typeof startDateAD === 'string' ? startDateAD.trim() : '';
  const end = typeof endDateAD === 'string' ? endDateAD.trim() : '';
  if (!start || !end) return 'Warranty start and expiry dates are required.';
  if (!isValidWarrantyRange(start, end)) {
    return 'Warranty expiry must be a real date on or after the warranty start date.';
  }
  return null;
}

/** Normalises an optional term input to 0..120 (null when not supplied). */
export function normalizeTermMonths(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_WARRANTY_MONTHS) return undefined;
  return Math.trunc(numeric);
}

/**
 * Writes one coverage inside the caller's transaction: supersede the unit's
 * current row, then insert the new period. A same-serial reissue therefore
 * replaces the register row but keeps the old period for audit.
 */
export async function recordWarrantyCoverage(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  input: CaptureCoverageInput
): Promise<string> {
  const serial = normalizeWarrantySerial(input.serialNumber);
  const id = input.id || newWarrantyCoverageId();
  await executor.query(WARRANTY_SUPERSEDE_CURRENT_SQL, [input.coverageType, serial]);
  await executor.query(WARRANTY_INSERT_SQL, warrantyInsertParams({
    ...input,
    id,
    serialNumber: serial,
  }));
  return id;
}

/** Demo-mode twin of recordWarrantyCoverage (PostgreSQL down). */
export function recordWarrantyCoverageMirror(input: CaptureCoverageInput): string {
  const serial = normalizeWarrantySerial(input.serialNumber);
  const id = input.id || newWarrantyCoverageId();
  const now = new Date().toISOString();
  const next: WarrantyCoverageRecord[] = warrantyCoverages.map((row) =>
    row.coverageType === input.coverageType && row.serialNumber === serial && row.isCurrent
      ? { ...row, isCurrent: false, supersededAt: now }
      : row
  );
  next.push({
    id,
    coverageType: input.coverageType,
    itemCategory: input.itemCategory,
    productId: input.productId || null,
    productName: input.productName,
    serialNumber: serial,
    assetId: input.assetId || null,
    deviceRecordId: input.deviceRecordId || null,
    branchId: input.branchId || null,
    partyId: input.partyId || null,
    partyName: input.partyName || null,
    sourceType: input.sourceType,
    sourceId: input.sourceId || null,
    sourceNumber: input.sourceNumber || null,
    startDateAD: input.startDateAD,
    endDateAD: input.endDateAD,
    termMonths: input.termMonths ?? null,
    startBasis: input.startBasis as WarrantyCoverageRecord['startBasis'],
    notes: input.notes || null,
    isCurrent: true,
    supersededAt: null,
    isDemo: Boolean(input.isDemo),
  });
  setWarrantyCoverages(next);
  return id;
}

/** Supersede every current seller row for a device record (collection/exchange). */
export async function supersedeSellerCoverageForDevice(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  deviceRecordId: string
): Promise<void> {
  await executor.query(WARRANTY_SUPERSEDE_BY_DEVICE_SQL, [deviceRecordId]);
}

export function supersedeSellerCoverageForDeviceMirror(deviceRecordId: string): void {
  const now = new Date().toISOString();
  setWarrantyCoverages(warrantyCoverages.map((row) =>
    row.coverageType === 'SELLER' && row.deviceRecordId === deviceRecordId && row.isCurrent
      ? { ...row, isCurrent: false, supersededAt: now }
      : row
  ));
}

/** Supersede the coverage a document created (sale reversal, purchase return). */
export async function supersedeCoverageBySource(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  coverageType: WarrantyCoverageType,
  sourceType: string,
  sourceId: string
): Promise<void> {
  await executor.query(WARRANTY_SUPERSEDE_BY_SOURCE_SQL, [coverageType, sourceType, sourceId]);
}

export function supersedeCoverageBySourceMirror(
  coverageType: WarrantyCoverageType,
  sourceType: string,
  sourceId: string
): void {
  const now = new Date().toISOString();
  setWarrantyCoverages(warrantyCoverages.map((row) =>
    row.coverageType === coverageType && row.sourceType === sourceType && row.sourceId === sourceId && row.isCurrent
      ? { ...row, isCurrent: false, supersededAt: now }
      : row
  ));
}

/**
 * A correction retires the current row and inserts a corrected period with the
 * same unit, party and source-document identity. The caller runs this in one
 * transaction with its audit row, so a failed audit cannot leave an unaudited
 * correction behind (and a failed insert cannot lose the original).
 */
export interface CoverageCorrectionInput {
  record: Pick<
    WarrantyCoverageRecord,
    | 'id'
    | 'coverageType'
    | 'itemCategory'
    | 'productId'
    | 'productName'
    | 'serialNumber'
    | 'assetId'
    | 'deviceRecordId'
    | 'branchId'
    | 'partyId'
    | 'partyName'
    | 'sourceType'
    | 'sourceId'
    | 'sourceNumber'
    | 'isDemo'
  >;
  startDateAD: string;
  endDateAD: string;
  termMonths?: number | null;
  notes?: string | null;
  actor?: string | null;
}

export async function correctWarrantyCoverage(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  input: CoverageCorrectionInput
): Promise<string> {
  await executor.query(WARRANTY_SUPERSEDE_BY_ID_SQL, [input.record.id]);
  const id = newWarrantyCoverageId();
  await executor.query(WARRANTY_INSERT_SQL, warrantyInsertParams({
    id,
    coverageType: input.record.coverageType,
    itemCategory: input.record.itemCategory,
    productId: input.record.productId,
    productName: input.record.productName,
    serialNumber: normalizeWarrantySerial(input.record.serialNumber),
    assetId: input.record.assetId,
    deviceRecordId: input.record.deviceRecordId,
    branchId: input.record.branchId,
    partyId: input.record.partyId,
    partyName: input.record.partyName,
    sourceType: input.record.sourceType,
    sourceId: input.record.sourceId,
    sourceNumber: input.record.sourceNumber,
    startDateAD: input.startDateAD,
    endDateAD: input.endDateAD,
    termMonths: input.termMonths ?? null,
    startBasis: 'MANUAL',
    notes: input.notes,
    isDemo: input.record.isDemo,
    actor: input.actor,
  }));
  return id;
}

/** Demo-mode twin; returns the replacement id, or null when the row is gone. */
export function correctWarrantyCoverageMirror(input: CoverageCorrectionInput): string | null {
  const record = warrantyCoverages.find((row) => row.id === input.record.id && row.isCurrent);
  if (!record) return null;
  const now = new Date().toISOString();
  const id = newWarrantyCoverageId();
  const next: WarrantyCoverageRecord[] = warrantyCoverages.map((row) =>
    row.id === record.id ? { ...row, isCurrent: false, supersededAt: now } : row
  );
  next.push({
    ...record,
    id,
    serialNumber: normalizeWarrantySerial(record.serialNumber),
    startDateAD: input.startDateAD,
    endDateAD: input.endDateAD,
    termMonths: input.termMonths ?? null,
    startBasis: 'MANUAL',
    notes: input.notes || null,
    isCurrent: true,
    supersededAt: null,
  });
  setWarrantyCoverages(next);
  return id;
}

/** A coverage row for a unit that has one; the capture paths use this to decide. */
export function currentCoverageFor(
  coverageType: WarrantyCoverageType,
  serialNumber: string
): WarrantyCoverageRecord | undefined {
  const serial = normalizeWarrantySerial(serialNumber);
  return warrantyCoverages.find(
    (row) => row.coverageType === coverageType && row.serialNumber === serial && row.isCurrent
  );
}

export type { WarrantyItemCategory };
