/**
 * Warranty claim / RMA lifecycle.
 *
 * Stock and ledger effects are part of the status transition, not a side
 * script the UI runs afterwards:
 *   SENT_TO_VENDOR → the old serial is marked RETURNED_TO_VENDOR (the RMA /
 *                    vendor-custody bucket);
 *   REPLACED       → exactly one replacement unit leaves branch stock and the
 *                    replacement serial becomes CUSTOMER_ASSIGNED;
 *   REPAIRED       → exactly one unit returns to branch stock and the serial
 *                    becomes IN_STOCK;
 *   CREDITED       → an optional vendor-credit journal debits AP and credits
 *                    stock expense, then the claim stores its journal id.
 *
 * All writes use the caller's transaction. The unique open-unit index is the
 * final guard against two open claims for the same side of a warranty.
 */
import { businessDateAD } from '../../../shared/businessDate';
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import { resolveBsDateForLedger } from '../utils/bsDate';
import { normalizeWarrantySerial } from './warranty.service';
import { postJournalLegs, type JournalLeg } from './accounting.service';
import {
  ACCOUNTS_BY_POSTING_ROLES_SQL,
  JOURNAL_FIND_BY_SOURCE_SQL,
} from '../models/accounting.repo';
import {
  STOCK_CONSUME_QOH_SQL,
  STOCK_RETURN_FROM_ASSET_SQL,
  TXN_FIND_BY_ID_SQL,
  TXN_INSERT_ON_CONFLICT_SQL,
  txnInsertOnConflictParams,
} from '../models/inventory.repo';
import {
  WARRANTY_CLAIM_EVENT_INSERT_SQL,
  WARRANTY_CLAIM_INSERT_SQL,
  WARRANTY_CLAIM_OPEN_FOR_UNIT_SQL,
  WARRANTY_CLAIM_RAW_SQL,
  WARRANTY_CLAIM_SERIAL_SQL,
  WARRANTY_CLAIM_SERIAL_STATUS_SQL,
  WARRANTY_CLAIM_STOCK_LOCK_SQL,
  WARRANTY_CLAIM_UPDATE_SQL,
  type WarrantyClaimQueryOptions,
} from '../models/warrantyClaim.repo';
import { WARRANTY_FIND_CURRENT_SQL } from '../models/warranty.repo';
import {
  canTransitionWarrantyClaim,
  isWarrantyClaimResolution,
  normalizeWarrantyClaimStatus,
  WARRANTY_CLAIM_OPEN_STATUSES,
  type WarrantyClaimStatus,
} from '../../../shared/warrantyClaim';

type Executor = { query: (sql: string, params?: any[]) => Promise<any> };

export interface CreateWarrantyClaimInput {
  coverageId?: unknown;
  coverageType?: unknown;
  serialNumber?: unknown;
  reportedDateAD?: unknown;
  symptom?: unknown;
  vendorId?: unknown;
  vendorName?: unknown;
  vendorClaimRef?: unknown;
  expectedCredit?: unknown;
  notes?: unknown;
  /** Null means a global account; an array is the branch user's allowed set. */
  branchScope?: string[] | null;
  actor?: string | null;
}

export interface TransitionWarrantyClaimInput {
  status?: unknown;
  note?: unknown;
  dateAD?: unknown;
  vendorId?: unknown;
  vendorName?: unknown;
  vendorClaimRef?: unknown;
  expectedCredit?: unknown;
  receivedCredit?: unknown;
  creditNoteNo?: unknown;
  postCreditJournal?: unknown;
  replacementSerial?: unknown;
  rmaReference?: unknown;
  notes?: unknown;
  actor?: string | null;
}

export interface WarrantyClaimRaw {
  id: string;
  claimNo: string;
  branchId: string;
  coverageId: string | null;
  coverageType: 'VENDOR' | 'SELLER';
  customerId: string | null;
  customerName: string | null;
  serialNumber: string;
  productId: string | null;
  productName: string;
  reportedDateAD: string;
  reportedDateBS: string | null;
  symptom: string;
  status: WarrantyClaimStatus;
  resolution: string | null;
  vendorId: string | null;
  vendorName: string | null;
  vendorClaimRef: string | null;
  expectedCredit: number;
  receivedCredit: number;
  creditNoteNo: string | null;
  journalId: string | null;
  replacementSerial: string | null;
  rmaReference: string | null;
  sentToVendorDateAD: string | null;
  sentToVendorDateBS: string | null;
  resolvedDateAD: string | null;
  resolvedDateBS: string | null;
  closedDateAD: string | null;
  closedDateBS: string | null;
  notes: string | null;
}

export interface WarrantyClaimStockEffect {
  kind: 'REPLACEMENT' | 'REPAIR';
  serialNumber: string;
  productId: string;
  productName: string;
  quantityBefore: number;
  quantityAfter: number;
  ledgerId: string;
}

function text(value: unknown, limit = 2000): string {
  return String(value ?? '').trim().slice(0, limit);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : 0;
}

function requireMoney(value: unknown, field: string): number {
  const parsed = num(value);
  if (parsed < 0) throw new ApiError(400, `${field} cannot be negative.`);
  return parsed;
}

function requireDate(value: unknown, field: string): string {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError(400, `${field} must be an AD date (YYYY-MM-DD).`);
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== raw) {
    throw new ApiError(400, `${field} must be a real calendar date.`);
  }
  return raw;
}

function newClaimNo(reportedDateAD: string): string {
  return `WC-${reportedDateAD.replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function historyEntry(status: WarrantyClaimStatus, claimNo: string, dateAD: string, note: string): string {
  return JSON.stringify([{ at: dateAD, status, claimNo, note }]);
}

export function canCreateWarrantyClaim(status: unknown): boolean {
  return normalizeWarrantyClaimStatus(status) === 'REPORTED';
}

export async function createWarrantyClaim(
  executor: Executor,
  input: CreateWarrantyClaimInput
): Promise<string> {
  const coverageType = text(input.coverageType, 10).toUpperCase();
  if (coverageType !== 'VENDOR' && coverageType !== 'SELLER') {
    throw new ApiError(400, 'Choose whether this is a supplier (VENDOR) or customer (SELLER) claim.');
  }
  const serialNumber = normalizeWarrantySerial(input.serialNumber);
  if (!serialNumber) throw new ApiError(400, 'A device serial number is required.');
  const symptom = text(input.symptom, 2000);
  if (symptom.length < 5) throw new ApiError(400, 'Describe the reported fault in at least five characters.');
  const reportedDateAD = requireDate(input.reportedDateAD, 'Reported date');

  const coverage = (await executor.query(WARRANTY_FIND_CURRENT_SQL, [coverageType, serialNumber])).rows[0];
  if (!coverage) {
    throw new ApiError(
      404,
      `No current ${coverageType === 'VENDOR' ? 'supplier' : 'customer'} warranty coverage exists for serial ${serialNumber}. Capture the coverage before opening a claim.`
    );
  }
  if (input.coverageId && text(input.coverageId, 60) !== coverage.id) {
    throw new ApiError(409, 'The selected coverage is no longer the current period for this serial.');
  }
  if (Array.isArray(input.branchScope)) {
    if (input.branchScope.length === 0 || !input.branchScope.includes(String(coverage.branchId || ''))) {
      throw new ApiError(403, 'Forbidden: this warranty coverage is outside your branch scope.');
    }
  }

  const open = await executor.query(WARRANTY_CLAIM_OPEN_FOR_UNIT_SQL, [
    coverageType,
    serialNumber,
    [...WARRANTY_CLAIM_OPEN_STATUSES],
  ]);
  if (open.rows[0]) {
    throw new ApiError(409, `Serial ${serialNumber} already has an open ${coverageType === 'VENDOR' ? 'supplier' : 'customer'} claim.`);
  }

  const id = `wcl-${crypto.randomUUID()}`;
  const reportedDateBS = await resolveBsDateForLedger(reportedDateAD, executor as any);
  const vendorName =
    text(input.vendorName, 200) ||
    (coverageType === 'VENDOR' ? text(coverage.partyName, 200) : '');
  const vendorId =
    text(input.vendorId, 50) || (coverageType === 'VENDOR' ? text(coverage.partyId, 50) : '');
  const expectedCredit = requireMoney(input.expectedCredit, 'Expected vendor credit');
  const claimNo = newClaimNo(reportedDateAD);

  try {
    await executor.query(WARRANTY_CLAIM_INSERT_SQL, [
      id,
      claimNo,
      coverage.branchId,
      coverage.id,
      coverageType,
      coverage.partyId || null,
      coverage.partyName || null,
      serialNumber,
      coverage.productId || null,
      coverage.productName,
      reportedDateAD,
      reportedDateBS,
      symptom,
      'REPORTED',
      null,
      vendorId || null,
      vendorName || null,
      text(input.vendorClaimRef, 120) || null,
      expectedCredit,
      0,
      null,
      null,
      null,
      null,
      text(input.notes, 2000) || null,
      false,
      input.actor || null,
      input.actor || null,
    ]);
  } catch (error: any) {
    if (String(error?.code) === '23505') {
      throw new ApiError(409, `Serial ${serialNumber} already has an open claim for this warranty.`);
    }
    throw error;
  }
  await executor.query(WARRANTY_CLAIM_EVENT_INSERT_SQL, [
    `wce-${crypto.randomUUID()}`,
    id,
    null,
    'REPORTED',
    `Claim reported: ${symptom}`,
    input.actor || null,
  ]);
  return id;
}

async function lockStock(
  executor: Executor,
  productId: string,
  branchId: string
): Promise<{ id: string; quantityOnHand: number; averageCost: number }> {
  const row = (await executor.query(WARRANTY_CLAIM_STOCK_LOCK_SQL, [productId, branchId])).rows[0];
  if (!row) throw new ApiError(409, 'The claim product has no stock row in this branch, so no stock movement was applied.');
  return {
    id: String(row.id),
    quantityOnHand: Number(row.quantityOnHand) || 0,
    averageCost: Number(row.averageCost) || 0,
  };
}

async function moveSerial(
  executor: Executor,
  serial: string,
  status: string,
  claim: WarrantyClaimRaw,
  customerId: string | null,
  customerName: string | null,
  dateAD: string,
  note: string
): Promise<void> {
  const row = (await executor.query(WARRANTY_CLAIM_SERIAL_SQL, [serial])).rows[0];
  if (!row) return;
  await executor.query(WARRANTY_CLAIM_SERIAL_STATUS_SQL, [
    row.id,
    status,
    customerId,
    customerName,
    claim.id,
    historyEntry(status as WarrantyClaimStatus, claim.claimNo, dateAD, note),
  ]);
}

async function consumeReplacement(
  executor: Executor,
  claim: WarrantyClaimRaw,
  replacementSerial: string,
  dateAD: string,
  dateBS: string
): Promise<WarrantyClaimStockEffect> {
  const serial = normalizeWarrantySerial(replacementSerial);
  if (!serial) throw new ApiError(400, 'A replacement serial number is required.');
  if (serial === normalizeWarrantySerial(claim.serialNumber)) {
    throw new ApiError(400, 'The replacement serial must be a different unit from the reported serial.');
  }
  const ledgerId = `txn-warranty-replace-${claim.id}`;
  if ((await executor.query(TXN_FIND_BY_ID_SQL, [ledgerId])).rows[0]) {
    throw new ApiError(409, 'This claim has already consumed its replacement stock.');
  }
  const unit = (await executor.query(WARRANTY_CLAIM_SERIAL_SQL, [serial])).rows[0];
  if (!unit) throw new ApiError(404, `Replacement serial ${serial} is not in the serial register.`);
  if (String(unit.branchId || '') !== claim.branchId) {
    throw new ApiError(409, `Replacement serial ${serial} is held at another branch.`);
  }
  if (String(unit.status) !== 'IN_STOCK') {
    throw new ApiError(409, `Replacement serial ${serial} is ${unit.status}, not IN_STOCK.`);
  }
  const productId = String(unit.productId || '');
  if (!productId) throw new ApiError(409, `Replacement serial ${serial} has no product identity.`);
  const stock = await lockStock(executor, productId, claim.branchId);
  if (stock.quantityOnHand < 1) {
    throw new ApiError(409, `Branch stock for ${unit.productName || productId} is empty; the replacement was not applied.`);
  }
  await executor.query(STOCK_CONSUME_QOH_SQL, [1, productId, claim.branchId]);
  await executor.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams({
    id: ledgerId,
    transactionNumber: `WARRANTY-REPLACE-${claim.claimNo}`,
    productId,
    productSku: String(unit.sku || ''),
    productName: String(unit.productName || claim.productName),
    branchId: claim.branchId,
    changeType: 'STOCK_OUT',
    quantityBefore: stock.quantityOnHand,
    quantityChanged: -1,
    quantityAfter: stock.quantityOnHand - 1,
    unitCost: stock.averageCost,
    referenceDocId: claim.id,
    timestampAD: dateAD,
    timestampBS: dateBS,
  } as any));
  await moveSerial(executor, serial, 'CUSTOMER_ASSIGNED', claim, claim.customerId, claim.customerName, dateAD, 'Warranty replacement issued');
  await moveSerial(executor, claim.serialNumber, 'RETURNED_TO_VENDOR', claim, null, null, dateAD, 'Defective unit held for vendor RMA');
  return {
    kind: 'REPLACEMENT',
    serialNumber: serial,
    productId,
    productName: String(unit.productName || claim.productName),
    quantityBefore: stock.quantityOnHand,
    quantityAfter: stock.quantityOnHand - 1,
    ledgerId,
  };
}

async function returnRepair(
  executor: Executor,
  claim: WarrantyClaimRaw,
  dateAD: string,
  dateBS: string
): Promise<WarrantyClaimStockEffect> {
  if (!claim.productId) throw new ApiError(409, 'This claim has no product identity, so a repaired unit cannot return to stock.');
  const ledgerId = `txn-warranty-repair-${claim.id}`;
  if ((await executor.query(TXN_FIND_BY_ID_SQL, [ledgerId])).rows[0]) {
    throw new ApiError(409, 'This claim has already returned its repaired unit to stock.');
  }
  const stock = await lockStock(executor, claim.productId, claim.branchId);
  await executor.query(STOCK_RETURN_FROM_ASSET_SQL, [
    claim.productId,
    claim.branchId,
    1,
    `stk-${claim.productId}-${claim.branchId}`,
    stock.averageCost,
  ]);
  await executor.query(TXN_INSERT_ON_CONFLICT_SQL, txnInsertOnConflictParams({
    id: ledgerId,
    transactionNumber: `WARRANTY-REPAIR-${claim.claimNo}`,
    productId: claim.productId,
    productSku: '',
    productName: claim.productName,
    branchId: claim.branchId,
    changeType: 'MANUAL_ADJUSTMENT',
    quantityBefore: stock.quantityOnHand,
    quantityChanged: 1,
    quantityAfter: stock.quantityOnHand + 1,
    unitCost: stock.averageCost,
    referenceDocId: claim.id,
    timestampAD: dateAD,
    timestampBS: dateBS,
  } as any));
  await moveSerial(executor, claim.serialNumber, 'IN_STOCK', claim, null, null, dateAD, 'Repaired unit returned to stock');
  return {
    kind: 'REPAIR',
    serialNumber: claim.serialNumber,
    productId: claim.productId,
    productName: claim.productName,
    quantityBefore: stock.quantityOnHand,
    quantityAfter: stock.quantityOnHand + 1,
    ledgerId,
  };
}

async function postVendorCredit(
  executor: Executor,
  claim: WarrantyClaimRaw,
  amount: number,
  dateAD: string,
  note: string
): Promise<string> {
  const existing = (await executor.query(JOURNAL_FIND_BY_SOURCE_SQL, ['WARRANTY_RECOVERY', claim.id])).rows[0];
  if (existing) return String(existing.id);
  const rows = (await executor.query(ACCOUNTS_BY_POSTING_ROLES_SQL, [['AP_CONTROL', 'STOCK_EXPENSE']])).rows as any[];
  const ap = rows.find((row) => row.postingRole === 'AP_CONTROL');
  const expense = rows.find((row) => row.postingRole === 'STOCK_EXPENSE');
  if (!ap || !expense) {
    throw new ApiError(400, 'Set the AP_CONTROL and STOCK_EXPENSE posting defaults before posting a warranty vendor credit.');
  }
  const partyName = claim.vendorName || 'Warranty vendor';
  const legs: JournalLeg[] = [
    {
      accountId: ap.id,
      increase: false,
      amount,
      memo: `Vendor credit ${claim.claimNo}`,
      subledgerType: ap.subledgerType || 'SUPPLIER',
      partyId: claim.vendorId || null,
      partyName,
    },
    {
      accountId: expense.id,
      increase: false,
      amount,
      memo: `Warranty recovery ${claim.claimNo}`,
    },
  ];
  const journal = await postJournalLegs(executor as any, {
    journalDateAD: dateAD,
    branchId: claim.branchId,
    memo: `Warranty recovery ${claim.claimNo}${note ? ` — ${note}` : ''}`,
    sourceType: 'WARRANTY_RECOVERY',
    sourceId: claim.id,
    actor: null,
    legs,
  });
  return journal.id;
}

export interface TransitionResult {
  status: WarrantyClaimStatus;
  stockEffect?: WarrantyClaimStockEffect;
  journalId?: string;
}

export async function transitionWarrantyClaim(
  executor: Executor,
  claim: WarrantyClaimRaw,
  input: TransitionWarrantyClaimInput
): Promise<TransitionResult> {
  const target = normalizeWarrantyClaimStatus(input.status);
  if (!target) throw new ApiError(400, 'Choose a valid claim status.');
  if (!canTransitionWarrantyClaim(claim.status, target)) {
    throw new ApiError(409, `A ${claim.status} claim cannot move to ${target}.`);
  }
  const dateAD = requireDate(input.dateAD || businessDateAD(), 'Transition date');
  const dateBS = await resolveBsDateForLedger(dateAD, executor as any);
  const note = text(input.note, 2000);
  let resolution = claim.resolution;
  let vendorId = claim.vendorId;
  let vendorName = claim.vendorName;
  let vendorClaimRef = claim.vendorClaimRef;
  let expectedCredit = Number(claim.expectedCredit) || 0;
  let receivedCredit = Number(claim.receivedCredit) || 0;
  let creditNoteNo = claim.creditNoteNo;
  let journalId = claim.journalId;
  let replacementSerial = claim.replacementSerial;
  let rmaReference = claim.rmaReference;
  let sentToVendorDateAD = claim.sentToVendorDateAD;
  let sentToVendorDateBS = claim.sentToVendorDateBS;
  let resolvedDateAD = claim.resolvedDateAD;
  let resolvedDateBS = claim.resolvedDateBS;
  let closedDateAD = claim.closedDateAD;
  let closedDateBS = claim.closedDateBS;
  let notes = claim.notes;
  let stockEffect: WarrantyClaimStockEffect | undefined;

  if (text(input.vendorId, 50)) vendorId = text(input.vendorId, 50);
  if (text(input.vendorName, 200)) vendorName = text(input.vendorName, 200);
  if (text(input.vendorClaimRef, 120)) vendorClaimRef = text(input.vendorClaimRef, 120);
  if (input.expectedCredit !== undefined) expectedCredit = requireMoney(input.expectedCredit, 'Expected vendor credit');
  if (text(input.notes, 2000)) notes = text(input.notes, 2000);

  if (target === 'REJECTED') {
    if (note.length < 5) throw new ApiError(400, 'A rejection needs a reason of at least five characters.');
  }

  if (target === 'SENT_TO_VENDOR') {
    sentToVendorDateAD = dateAD;
    sentToVendorDateBS = dateBS;
    rmaReference = text(input.rmaReference, 120) || rmaReference;
    await moveSerial(executor, claim.serialNumber, 'RETURNED_TO_VENDOR', claim, null, null, dateAD, note || 'Unit sent to vendor for RMA');
  }

  if (target === 'REPLACED') {
    replacementSerial = normalizeWarrantySerial(input.replacementSerial);
    if (!replacementSerial) throw new ApiError(400, 'A replacement serial number is required.');
    stockEffect = await consumeReplacement(executor, claim, replacementSerial, dateAD, dateBS);
    resolution = 'REPLACED';
    resolvedDateAD = dateAD;
    resolvedDateBS = dateBS;
  }

  if (target === 'REPAIRED') {
    stockEffect = await returnRepair(executor, claim, dateAD, dateBS);
    resolution = 'REPAIRED';
    resolvedDateAD = dateAD;
    resolvedDateBS = dateBS;
  }

  if (target === 'CREDITED') {
    receivedCredit = requireMoney(input.receivedCredit, 'Received vendor credit');
    if (receivedCredit <= 0) throw new ApiError(400, 'Enter the vendor credit actually received.');
    if (expectedCredit > 0 && receivedCredit > expectedCredit + 0.005) {
      throw new ApiError(400, 'Received credit cannot exceed the expected vendor credit.');
    }
    if (expectedCredit === 0) expectedCredit = receivedCredit;
    creditNoteNo = text(input.creditNoteNo, 120) || creditNoteNo;
    if (String(input.postCreditJournal ?? '') === 'true' || input.postCreditJournal === true) {
      journalId = await postVendorCredit(executor, claim, receivedCredit, dateAD, creditNoteNo || '');
    }
    resolution = 'CREDITED';
    resolvedDateAD = dateAD;
    resolvedDateBS = dateBS;
  }

  if (target === 'CLOSED') {
    if (!isWarrantyClaimResolution(claim.resolution || claim.status)) {
      throw new ApiError(409, 'A claim can only be closed after it is replaced, repaired or credited.');
    }
    closedDateAD = dateAD;
    closedDateBS = dateBS;
    resolution = claim.resolution || claim.status;
  }

  await executor.query(WARRANTY_CLAIM_UPDATE_SQL, [
    claim.id,
    target,
    resolution,
    vendorId || null,
    vendorName || null,
    vendorClaimRef || null,
    expectedCredit,
    receivedCredit,
    creditNoteNo || null,
    journalId || null,
    replacementSerial || null,
    rmaReference || null,
    sentToVendorDateAD || null,
    sentToVendorDateBS || null,
    resolvedDateAD || null,
    resolvedDateBS || null,
    closedDateAD || null,
    closedDateBS || null,
    notes || null,
    input.actor || null,
  ]);

  const eventNote =
    note ||
    (target === 'REPLACED'
      ? `Replacement ${replacementSerial} issued from branch stock.`
      : target === 'REPAIRED'
        ? 'Repaired unit returned to branch stock.'
        : target === 'CREDITED'
          ? `Vendor credit ${receivedCredit.toFixed(2)} recorded${journalId ? ' and posted' : ''}.`
          : target === 'CLOSED'
            ? 'Resolution accepted and claim closed.'
            : `Status advanced to ${target}.`);
  await executor.query(WARRANTY_CLAIM_EVENT_INSERT_SQL, [
    `wce-${crypto.randomUUID()}`,
    claim.id,
    claim.status,
    target,
    eventNote,
    input.actor || null,
  ]);

  return { status: target, stockEffect, journalId: journalId || undefined };
}

export async function findClaimForTransition(
  executor: Executor,
  id: string
): Promise<WarrantyClaimRaw | null> {
  const row = (await executor.query(WARRANTY_CLAIM_RAW_SQL, [id])).rows[0];
  return row || null;
}

export type { WarrantyClaimQueryOptions };
