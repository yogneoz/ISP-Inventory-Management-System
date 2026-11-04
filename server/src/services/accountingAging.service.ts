/**
 * AR / AP aging read side.
 *
 * The report is built only from POSTED `gl_subledger_entries` on the chart's
 * AR_CONTROL or AP_CONTROL account. Operational payment/invoice rows are never
 * summed: the journal is the source of truth, which is what lets the aging net
 * equal the control-account balance for the same branch and date.
 *
 * Open items:
 *   - a debit on AR (or credit on AP) is a charge, with the invoice's document
 *     number and due date when the journal came from that invoice;
 *   - the opposite side is a credit (receipt, payment, return, reversal) and is
 *     applied FIFO against that party's charges, earliest first;
 *   - whatever credit remains after allocation is returned as its own CREDIT
 *     row and in `unappliedCredit` instead of disappearing from the buckets.
 *
 * Due date: a document's recorded due date is used when it is a real due date.
 * Sales invoices store one; purchase invoices currently store the vendor bill
 * date in the same column, so a value on or before the invoice date is treated
 * as missing and the invoice date is used. No payment terms are recorded on
 * either document today, so the fallback is the invoice date itself. A journal
 * with no invoice behind it (an opening or manual AR line) ages from its own
 * date. `termsDays` exposes the resulting document-date → due-date gap so the
 * fallback is visible rather than implied.
 */
import { ApiError } from '../errors/ApiError';
import { roundMoney } from '../utils/money';
import {
  AGING_CONTROL_ACCOUNT_SQL,
  AGING_CONTROL_GL_BALANCE_SQL,
  AGING_SUBLEDGER_ROWS_SQL,
} from '../models/accounting.repo';
import type { AccountingClient } from './accounting.service';

export type AgingType = 'AR' | 'AP';
export type AgingBucketKey =
  | 'CURRENT'
  | 'DAYS_1_30'
  | 'DAYS_31_60'
  | 'DAYS_61_90'
  | 'DAYS_90_PLUS';

export const AGING_BUCKETS: ReadonlyArray<{
  key: AgingBucketKey;
  label: string;
  minDays: number | null;
  maxDays: number | null;
}> = [
  { key: 'CURRENT', label: 'Not yet due', minDays: null, maxDays: 0 },
  { key: 'DAYS_1_30', label: '1–30 days', minDays: 1, maxDays: 30 },
  { key: 'DAYS_31_60', label: '31–60 days', minDays: 31, maxDays: 60 },
  { key: 'DAYS_61_90', label: '61–90 days', minDays: 61, maxDays: 90 },
  { key: 'DAYS_90_PLUS', label: '90+ days', minDays: 91, maxDays: null },
];

export interface AgingInput {
  type: AgingType;
  asOf: string;
  /** `null` rolls every branch up to company level. */
  branchId: string | null;
  empty: boolean;
}

export interface AgingItemRow {
  kind: 'INVOICE' | 'ADJUSTMENT' | 'CREDIT';
  documentId: string | null;
  documentNo: string | null;
  documentDateAD: string;
  dueDateAD: string | null;
  termsDays: number | null;
  daysPastDue: number | null;
  bucket: AgingBucketKey | null;
  branchId: string;
  journalNo: string;
  sourceType: string;
  description: string;
  originalAmount: number;
  allocatedAmount: number;
  amount: number;
}

export interface AgingParty {
  partyId: string;
  partyName: string;
  buckets: Record<AgingBucketKey, number>;
  /** Open charges before credits. */
  grossTotal: number;
  unappliedCredit: number;
  /** Open charges less unapplied credits: the amount the party still owes. */
  total: number;
  rows: AgingItemRow[];
}

interface ChargeItem {
  kind: 'INVOICE' | 'ADJUSTMENT';
  documentId: string | null;
  documentNo: string | null;
  documentDateAD: string;
  dueDateAD: string;
  branchId: string;
  journalNo: string;
  sourceType: string;
  description: string;
  originalAmount: number;
  applied: number;
  termsDays: number;
}

interface CreditItem {
  documentId: string | null;
  documentDateAD: string;
  branchId: string;
  journalNo: string;
  sourceType: string;
  description: string;
  originalAmount: number;
  applied: number;
}

interface PartyState {
  partyId: string;
  partyName: string;
  charges: ChargeItem[];
  credits: CreditItem[];
}

function money(value: unknown): number {
  return roundMoney(Number(value) || 0);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function dateOnly(value: unknown): string {
  return String(value || '').slice(0, 10);
}

/** Whole calendar days between two real AD dates (UTC, so DST is irrelevant). */
function daysBetween(fromAD: string, toAD: string): number {
  const [fy, fm, fd] = fromAD.split('-').map(Number);
  const [ty, tm, td] = toAD.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function agingBucketFor(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return 'CURRENT';
  if (daysPastDue <= 30) return 'DAYS_1_30';
  if (daysPastDue <= 60) return 'DAYS_31_60';
  if (daysPastDue <= 90) return 'DAYS_61_90';
  return 'DAYS_90_PLUS';
}

function emptyBuckets(): Record<AgingBucketKey, number> {
  return {
    CURRENT: 0,
    DAYS_1_30: 0,
    DAYS_31_60: 0,
    DAYS_61_90: 0,
    DAYS_90_PLUS: 0,
  };
}

/**
 * The date this charge is due. Sales and purchase invoices now store the
 * resolved bill-term due date; a purchase invoice's vendor bill date lives in
 * its own column and is never read here. A due date on or after the document
 * date is genuine, so a 0-day term (due on receipt) is preserved as the
 * document date rather than treated as missing. A non-invoice journal ages
 * from its own date.
 */
function resolveDueDate(row: any): { documentDateAD: string; dueDateAD: string; termsDays: number } {
  const entryDateAD = dateOnly(row.entryDateAD);
  const documentDateAD = dateOnly(row.documentDateAD) || entryDateAD;
  const storedDueDateAD = dateOnly(row.storedDueDateAD);
  const sourceType = text(row.sourceType).toUpperCase();
  const fromPurchaseInvoice = sourceType.startsWith('PURCHASE_INVOICE');
  let dueDateAD = documentDateAD;
  if (storedDueDateAD) {
    const genuine = fromPurchaseInvoice
      ? storedDueDateAD > documentDateAD
      : storedDueDateAD >= documentDateAD;
    if (genuine) dueDateAD = storedDueDateAD;
  }
  return {
    documentDateAD,
    dueDateAD,
    termsDays: Math.max(0, daysBetween(documentDateAD, dueDateAD)),
  };
}

function emptyReport(type: AgingType, input: AgingInput, account: any) {
  const buckets = emptyBuckets();
  return {
    report: type === 'AR' ? ('AR_AGING' as const) : ('AP_AGING' as const),
    type,
    asOf: input.asOf,
    branchId: input.branchId,
    account: {
      accountId: String(account.id),
      code: String(account.code),
      name: String(account.name),
      postingRole: String(account.postingRole),
      subledgerType: String(account.subledgerType),
      isActive: account.isActive === true,
    },
    buckets: AGING_BUCKETS.map((bucket) => ({ ...bucket, amount: buckets[bucket.key] })),
    parties: [] as AgingParty[],
    totals: {
      ...buckets,
      grossTotal: 0,
      unappliedCredit: 0,
      total: 0,
      controlBalance: 0,
      difference: 0,
      reconciled: true,
    },
  };
}

export async function buildAging(client: AccountingClient, input: AgingInput) {
  const type = input.type;
  if (type !== 'AR' && type !== 'AP') {
    throw new ApiError(400, 'Aging type must be AR or AP.');
  }
  const role = type === 'AR' ? 'AR_CONTROL' : 'AP_CONTROL';
  const account = (await client.query(AGING_CONTROL_ACCOUNT_SQL, [role])).rows[0];
  if (!account) {
    throw new ApiError(
      400,
      `The ${role} posting default is not configured. Assign it to the ${type === 'AR' ? 'receivable' : 'payable'} control account before reading aging.`
    );
  }

  if (input.empty) return emptyReport(type, input, account);

  const [rowsResult, controlResult] = await Promise.all([
    client.query(AGING_SUBLEDGER_ROWS_SQL, [account.id, input.asOf, input.branchId]),
    client.query(AGING_CONTROL_GL_BALANCE_SQL, [account.id, input.asOf, input.branchId]),
  ]);

  const parties = new Map<string, PartyState>();
  for (const row of rowsResult.rows) {
    const partyId = text(row.partyId) || 'UNASSIGNED';
    let party = parties.get(partyId);
    if (!party) {
      party = {
        partyId,
        partyName: text(row.partyName) || partyId,
        charges: [],
        credits: [],
      };
      parties.set(partyId, party);
    } else if (text(row.partyName)) {
      party.partyName = text(row.partyName);
    }

    const debit = money(row.debit);
    const credit = money(row.credit);
    const chargeAmount = type === 'AR' ? debit : credit;
    const creditAmount = type === 'AR' ? credit : debit;
    if (chargeAmount > 0) {
      const { documentDateAD, dueDateAD, termsDays } = resolveDueDate(row);
      const documentNo = text(row.documentNo) || null;
      party.charges.push({
        kind: documentNo ? 'INVOICE' : 'ADJUSTMENT',
        documentId: text(row.sourceId) || null,
        documentNo,
        documentDateAD,
        dueDateAD,
        branchId: text(row.branchId),
        journalNo: text(row.journalNo),
        sourceType: text(row.sourceType),
        description: text(row.memo) || documentNo || 'Opening / manual item',
        originalAmount: chargeAmount,
        applied: 0,
        termsDays,
      });
    } else if (creditAmount > 0) {
      party.credits.push({
        documentId: text(row.sourceId) || null,
        documentDateAD: dateOnly(row.entryDateAD),
        branchId: text(row.branchId),
        journalNo: text(row.journalNo),
        sourceType: text(row.sourceType),
        description: text(row.memo) || 'Unapplied credit',
        originalAmount: creditAmount,
        applied: 0,
      });
    }
  }

  const bucketTotals = emptyBuckets();
  const partyRows: AgingParty[] = [];
  for (const party of parties.values()) {
    // Charges and credits are already date-ordered by the query; allocate
    // credits FIFO so an old receipt clears the oldest invoice first.
    let creditIndex = 0;
    for (const charge of party.charges) {
      let open = roundMoney(charge.originalAmount - charge.applied);
      while (open > 0.004 && creditIndex < party.credits.length) {
        const credit = party.credits[creditIndex];
        const available = roundMoney(credit.originalAmount - credit.applied);
        if (available <= 0.004) {
          creditIndex += 1;
          continue;
        }
        const applied = roundMoney(Math.min(open, available));
        credit.applied = roundMoney(credit.applied + applied);
        charge.applied = roundMoney(charge.applied + applied);
        open = roundMoney(open - applied);
        if (available - applied <= 0.004) creditIndex += 1;
      }
    }

    const buckets = emptyBuckets();
    const rows: AgingItemRow[] = [];
    let grossTotal = 0;
    for (const charge of party.charges) {
      const open = roundMoney(charge.originalAmount - charge.applied);
      if (open <= 0.004) continue;
      const daysPastDue = daysBetween(charge.dueDateAD, input.asOf);
      const bucket = agingBucketFor(daysPastDue);
      buckets[bucket] = roundMoney(buckets[bucket] + open);
      grossTotal = roundMoney(grossTotal + open);
      rows.push({
        kind: charge.kind,
        documentId: charge.documentId,
        documentNo: charge.documentNo,
        documentDateAD: charge.documentDateAD,
        dueDateAD: charge.dueDateAD,
        termsDays: charge.termsDays,
        daysPastDue,
        bucket,
        branchId: charge.branchId,
        journalNo: charge.journalNo,
        sourceType: charge.sourceType,
        description: charge.description,
        originalAmount: charge.originalAmount,
        allocatedAmount: charge.applied,
        amount: open,
      });
    }

    let unappliedCredit = 0;
    for (const credit of party.credits) {
      const open = roundMoney(credit.originalAmount - credit.applied);
      if (open <= 0.004) continue;
      unappliedCredit = roundMoney(unappliedCredit + open);
      rows.push({
        kind: 'CREDIT',
        documentId: credit.documentId,
        documentNo: null,
        documentDateAD: credit.documentDateAD,
        dueDateAD: null,
        termsDays: null,
        daysPastDue: null,
        bucket: null,
        branchId: credit.branchId,
        journalNo: credit.journalNo,
        sourceType: credit.sourceType,
        description: credit.description,
        originalAmount: credit.originalAmount,
        allocatedAmount: credit.applied,
        amount: open,
      });
    }

    if (grossTotal === 0 && unappliedCredit === 0) continue;
    for (const [key, amount] of Object.entries(buckets) as Array<[AgingBucketKey, number]>) {
      bucketTotals[key] = roundMoney(bucketTotals[key] + amount);
    }
    partyRows.push({
      partyId: party.partyId,
      partyName: party.partyName,
      buckets,
      grossTotal,
      unappliedCredit,
      total: roundMoney(grossTotal - unappliedCredit),
      rows,
    });
  }

  partyRows.sort((left, right) =>
    left.partyName.localeCompare(right.partyName, undefined, { sensitivity: 'base' })
  );

  const grossTotal = roundMoney(partyRows.reduce((sum, party) => sum + party.grossTotal, 0));
  const unappliedCredit = roundMoney(
    partyRows.reduce((sum, party) => sum + party.unappliedCredit, 0)
  );
  // The report's headline total is net of credits, which is exactly what the
  // control account carries; gross open items are exposed separately.
  const total = roundMoney(grossTotal - unappliedCredit);
  // The GL side is debit-positive; AP's natural payable side is credit-positive.
  const glSigned = money(controlResult.rows[0]?.balance);
  const controlBalance = type === 'AR' ? glSigned : roundMoney(-glSigned);
  const difference = roundMoney(controlBalance - total);

  return {
    report: type === 'AR' ? ('AR_AGING' as const) : ('AP_AGING' as const),
    type,
    asOf: input.asOf,
    branchId: input.branchId,
    account: {
      accountId: String(account.id),
      code: String(account.code),
      name: String(account.name),
      postingRole: String(account.postingRole),
      subledgerType: String(account.subledgerType),
      isActive: account.isActive === true,
    },
    buckets: AGING_BUCKETS.map((bucket) => ({
      ...bucket,
      amount: bucketTotals[bucket.key],
    })),
    parties: partyRows,
    totals: {
      ...bucketTotals,
      grossTotal,
      unappliedCredit,
      total,
      controlBalance,
      difference,
      reconciled: Math.abs(difference) < 0.005,
    },
  };
}

export type AgingResponse = Awaited<ReturnType<typeof buildAging>>;
