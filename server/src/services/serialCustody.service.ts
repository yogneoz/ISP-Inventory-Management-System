/**
 * Serial-level custody — a serialised device that leaves the branch shelf has
 * to be somewhere: on a technician's van, at a customer, or written off.
 *
 * Slice 1 of the custody ledger made *quantities* follow the person. This module
 * makes a device's *identity* follow as well, so the serial register and the
 * custody ledger can never tell different stories about the same unit:
 *
 *   IN_STOCK    → IN_CUSTODY (holder_employee_id set)   issue to a person
 *   IN_CUSTODY  → IN_STOCK                              return to the branch
 *   IN_CUSTODY  → CUSTOMER_ASSIGNED (+ customer)        consumed on a work order
 *   IN_CUSTODY  → CONSUMED                              consumed with no customer
 *   IN_CUSTODY  → LOST                                  written off
 *   IN_CUSTODY  → IN_CUSTODY (new holder)               transferred to a colleague
 *
 * This is what serialised inventory does in every ERP that tracks devices: a
 * unit sits in an internal "technician stock" location until an installation
 * document names the customer, and only then does the customer-facing register
 * show it. The register's customer attribution is therefore written exactly once,
 * at the moment of installation — not at issue, when nobody yet owns it.
 *
 * Rules:
 *   - a serial is addressed by its case/trim key, the key the register's unique
 *     identity uses (`serialGateKey`);
 *   - every write is guarded by the state it expects, so two callers cannot both
 *     move the same unit, and a lost race is a refusal rather than a silent
 *     overwrite;
 *   - a refusal names the serial and the state it is really in;
 *   - the caller's transaction owns the move: this module never commits.
 *
 * All SQL lives in `models/inventory.repo.ts`, like the rest of the register.
 */
import {
  SERIAL_CUSTODY_LOCK_SQL,
  SERIAL_LOG_CUSTODY_HOLDER_SQL,
  SERIAL_LOG_CUSTODY_ISSUE_SQL,
  SERIAL_LOG_CUSTODY_RELEASE_SQL,
} from '../models/inventory.repo';
import { serialGateKey } from './serialGate.service';

/** The states a unit can leave custody into. */
export type CustodyReleaseStatus = 'IN_STOCK' | 'CUSTOMER_ASSIGNED' | 'CONSUMED' | 'LOST';

/** A refusal the caller can answer with; `status` is the HTTP status to send. */
export class SerialCustodyRefusal extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code:
      | 'SERIAL_UNKNOWN'
      | 'SERIAL_NOT_IN_CUSTODY'
      | 'SERIAL_WRONG_HOLDER'
      | 'SERIAL_WRONG_PRODUCT'
      | 'SERIAL_WRONG_BRANCH'
      | 'SERIAL_NOT_IN_STOCK' = 'SERIAL_NOT_IN_CUSTODY'
  ) {
    super(message);
    this.name = 'SerialCustodyRefusal';
  }
}

export interface CustodySerialRow {
  deviceSerial: string;
  productId: string;
  branchId: string;
  status: string;
  holderEmployeeId: string | null;
}

export interface CustodyIssueInput {
  employeeId: string;
  productId: string;
  branchId: string;
  serials: readonly string[];
  sourceType: string;
  sourceId: string;
  dateAD: string;
  note: string;
}

export interface CustodyReleaseInput {
  employeeId: string;
  productId: string;
  branchId: string;
  serials: readonly string[];
  status: CustodyReleaseStatus;
  sourceType: string;
  sourceId: string;
  dateAD: string;
  note: string;
  customerId?: string | null;
  customerName?: string | null;
  /**
   * true (default) — every named serial must be held by this person, or the
   * whole movement is refused. false — only the units this person actually holds
   * are moved and the rest are left alone; used by the phone's work-order
   * completion, which also records a serial purely as the order's ONT tag.
   */
  strict?: boolean;
}

export interface CustodyTransferInput {
  fromEmployeeId: string;
  toEmployeeId: string;
  productId: string;
  branchId: string;
  serials: readonly string[];
  sourceType: string;
  sourceId: string;
  dateAD: string;
  note: string;
}

/** Distinct, trimmed serial values (the register key is case/trim-insensitive). */
export function custodySerials(serials: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of serials || []) {
    const value = String(raw ?? '').trim();
    const key = serialGateKey(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** The history entry a custody move appends to the register row. */
export function custodyHistoryEntry(
  status: string,
  sourceType: string,
  sourceId: string,
  dateAD: string,
  notes: string
): string {
  return JSON.stringify([
    {
      status,
      sourceType,
      sourceId,
      dateAD: String(dateAD || '').slice(0, 10),
      notes,
    },
  ]);
}

async function lockSerials(client: any, serials: readonly string[]): Promise<Map<string, CustodySerialRow>> {
  if (serials.length === 0) return new Map();
  const keys = serials.map((serial) => serialGateKey(serial));
  const result = await client.query(SERIAL_CUSTODY_LOCK_SQL, [keys]);
  const rows = new Map<string, CustodySerialRow>();
  for (const row of result.rows || []) {
    rows.set(serialGateKey(row.deviceSerial), {
      deviceSerial: String(row.deviceSerial || ''),
      productId: String(row.productId || ''),
      branchId: String(row.branchId || ''),
      status: String(row.status || ''),
      holderEmployeeId: row.holderEmployeeId ? String(row.holderEmployeeId) : null,
    });
  }
  return rows;
}

function assertInStockForIssue(row: CustodySerialRow, input: CustodyIssueInput): void {
  if (row.status !== 'IN_STOCK') {
    throw new SerialCustodyRefusal(
      409,
      `Device serial ${row.deviceSerial} is ${row.status} (not IN_STOCK) at this branch — it cannot be issued into custody.`,
      'SERIAL_NOT_IN_STOCK'
    );
  }
  if (row.productId && row.productId !== input.productId) {
    throw new SerialCustodyRefusal(
      409,
      `Device serial ${row.deviceSerial} belongs to a different product than the one being issued.`,
      'SERIAL_WRONG_PRODUCT'
    );
  }
  if (row.branchId && row.branchId !== input.branchId) {
    throw new SerialCustodyRefusal(
      409,
      `Device serial ${row.deviceSerial} is held at branch ${row.branchId}, not ${input.branchId}.`,
      'SERIAL_WRONG_BRANCH'
    );
  }
}

/**
 * Issues the named units into one person's custody.
 *
 * Refuses anything that is not IN_STOCK at that branch and of that product, so a
 * unit already on someone's van, sold, deployed or damaged can never be issued
 * twice. Returns the serials actually moved (the caller links them to its
 * movement).
 */
export async function issueCustodySerialsInDb(
  client: any,
  input: CustodyIssueInput
): Promise<string[]> {
  const serials = custodySerials(input.serials);
  if (serials.length === 0) return [];
  const rows = await lockSerials(client, serials);
  const moved: string[] = [];
  for (const serial of serials) {
    const row = rows.get(serialGateKey(serial));
    if (!row) {
      throw new SerialCustodyRefusal(
        400,
        `Device serial ${serial} is not in the serial register — only received units can be issued.`,
        'SERIAL_UNKNOWN'
      );
    }
    assertInStockForIssue(row, input);
    const result = await client.query(SERIAL_LOG_CUSTODY_ISSUE_SQL, [
      input.employeeId,
      input.sourceType,
      input.sourceId,
      custodyHistoryEntry('IN_CUSTODY', input.sourceType, input.sourceId, input.dateAD, input.note),
      input.dateAD,
      serial,
      input.branchId,
    ]);
    if (result.rowCount !== 1) {
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} changed state before this issue could be saved. Nothing was saved; please retry.`,
        'SERIAL_NOT_IN_STOCK'
      );
    }
    moved.push(serial);
  }
  return moved;
}

/**
 * Releases the named units from one person's custody into their next state.
 *
 * A unit must be IN_CUSTODY and held by *this* person; the holder is the
 * authority, not the branch, because two technicians can hold the same product.
 * `strict: false` (the phone's completion) moves whichever of the named units the
 * person really holds and leaves the others untouched.
 */
export async function releaseCustodySerialsInDb(
  client: any,
  input: CustodyReleaseInput
): Promise<string[]> {
  const serials = custodySerials(input.serials);
  if (serials.length === 0) return [];
  const strict = input.strict !== false;
  const rows = await lockSerials(client, serials);
  const moved: string[] = [];
  for (const serial of serials) {
    const row = rows.get(serialGateKey(serial));
    if (!row) {
      if (!strict) continue;
      throw new SerialCustodyRefusal(
        400,
        `Device serial ${serial} is not in the serial register.`,
        'SERIAL_UNKNOWN'
      );
    }
    const heldByPerson = row.status === 'IN_CUSTODY' && row.holderEmployeeId === input.employeeId;
    if (!heldByPerson) {
      if (!strict) continue;
      throw new SerialCustodyRefusal(
        409,
        row.status !== 'IN_CUSTODY'
          ? `Device serial ${serial} is ${row.status} (not IN_CUSTODY) — it is not in this person's custody.`
          : `Device serial ${serial} is held by another technician, not this person.`,
        row.status !== 'IN_CUSTODY' ? 'SERIAL_NOT_IN_CUSTODY' : 'SERIAL_WRONG_HOLDER'
      );
    }
    if (row.productId && row.productId !== input.productId) {
      if (!strict) continue;
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} belongs to a different product than the movement records.`,
        'SERIAL_WRONG_PRODUCT'
      );
    }
    if (row.branchId && row.branchId !== input.branchId) {
      if (!strict) continue;
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} is held at branch ${row.branchId}, not ${input.branchId}.`,
        'SERIAL_WRONG_BRANCH'
      );
    }

    const result = await client.query(SERIAL_LOG_CUSTODY_RELEASE_SQL, [
      input.status,
      input.customerId || null,
      input.customerName || null,
      input.sourceType,
      input.sourceId,
      custodyHistoryEntry(input.status, input.sourceType, input.sourceId, input.dateAD, input.note),
      input.dateAD,
      serial,
      input.branchId,
      input.employeeId,
    ]);
    if (result.rowCount !== 1) {
      if (!strict) continue;
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} changed state before this movement could be saved. Nothing was saved; please retry.`,
        'SERIAL_NOT_IN_CUSTODY'
      );
    }
    moved.push(serial);
  }
  return moved;
}

/** Custody moves person to person; the units stay IN_CUSTODY under a new holder. */
export async function transferCustodySerialsInDb(
  client: any,
  input: CustodyTransferInput
): Promise<string[]> {
  const serials = custodySerials(input.serials);
  if (serials.length === 0) return [];
  const rows = await lockSerials(client, serials);
  const moved: string[] = [];
  for (const serial of serials) {
    const row = rows.get(serialGateKey(serial));
    if (!row) {
      throw new SerialCustodyRefusal(
        400,
        `Device serial ${serial} is not in the serial register.`,
        'SERIAL_UNKNOWN'
      );
    }
    if (row.status !== 'IN_CUSTODY' || row.holderEmployeeId !== input.fromEmployeeId) {
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} is not in ${input.fromEmployeeId}'s custody.`,
        'SERIAL_WRONG_HOLDER'
      );
    }
    if (row.productId && row.productId !== input.productId) {
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} belongs to a different product than the transfer records.`,
        'SERIAL_WRONG_PRODUCT'
      );
    }
    const result = await client.query(SERIAL_LOG_CUSTODY_HOLDER_SQL, [
      input.toEmployeeId,
      input.sourceType,
      input.sourceId,
      custodyHistoryEntry('IN_CUSTODY', input.sourceType, input.sourceId, input.dateAD, input.note),
      input.dateAD,
      serial,
      input.branchId,
      input.fromEmployeeId,
    ]);
    if (result.rowCount !== 1) {
      throw new SerialCustodyRefusal(
        409,
        `Device serial ${serial} changed hands before this transfer could be saved. Nothing was saved; please retry.`,
        'SERIAL_WRONG_HOLDER'
      );
    }
    moved.push(serial);
  }
  return moved;
}
