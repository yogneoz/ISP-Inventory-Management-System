/**
 * Bill-term service — the one place that turns a term id (or a party's
 * default) into the due date an invoice stores. Controllers pass the invoice
 * date and optional explicit override; history keeps the resolved date even
 * if the master is renamed or retired later.
 */
import { pgPool } from '../../db';
import { ApiError } from '../errors/ApiError';
import {
  billTerms,
  customerMasterRecords,
  getPgConnected,
  purchaseInvoices,
  salesInvoices,
  suppliers,
} from '../state/runtimeState';
import {
  BILL_TERM_BY_CODE_SQL,
  BILL_TERM_BY_ID_SQL,
  BILL_TERM_CUSTOMER_DEFAULT_SQL,
  BILL_TERM_LIST_SQL,
  BILL_TERM_SUPPLIER_DEFAULT_SQL,
  BILL_TERM_USAGE_COUNT_SQL,
} from '../models/billTerms.repo';
import { computeDueDateAD, isValidADDate } from '../../../shared/billTerms';
import { resolveBsDateForLedger } from '../utils/bsDate';
import type { BillTerm } from '../../../client/src/types';

export interface ResolvedInvoiceTerms {
  billTermsId: string | null;
  dueDateAD: string | null;
  dueDateBS: string | null;
}

export interface ResolveInvoiceTermsInput {
  invoiceDateAD: string;
  /** A deliberate operator override; validated against the invoice date. */
  dueDateAD?: string | null;
  /** Optional client hint; the server derives the stored BS value. */
  dueDateBS?: string | null;
  /** Explicitly selected term, or the party default when omitted. */
  billTermsId?: string | null;
  partyType?: 'CUSTOMER' | 'SUPPLIER';
  partyId?: string | null;
}

const dateOnly = (value: unknown): string => String(value ?? '').split('T')[0];

/** All terms, newest master edits visible immediately. */
export async function listBillTerms(includeInactive = true): Promise<BillTerm[]> {
  if (getPgConnected()) {
    const rows = (await pgPool.query(BILL_TERM_LIST_SQL)).rows as BillTerm[];
    return includeInactive ? rows : rows.filter((term) => term.active);
  }
  return billTerms
    .filter((term) => includeInactive || term.active)
    .map((term) => ({ ...term }));
}

/** How many parties or invoices point at this term. */
export async function billTermUsageCount(id: string): Promise<number> {
  const clean = String(id || '').trim();
  if (!clean) return 0;
  if (getPgConnected()) {
    const result = await pgPool.query(BILL_TERM_USAGE_COUNT_SQL, [clean]);
    return Number(result.rows[0]?.count) || 0;
  }
  return (
    customerMasterRecords.filter((row) => row.billTermsId === clean).length +
    suppliers.filter((row) => row.billTermsId === clean).length +
    salesInvoices.filter((row) => row.billTermsId === clean).length +
    purchaseInvoices.filter((row) => row.billTermsId === clean).length
  );
}

/** One term by id, or null when it does not exist. */
export async function findBillTermById(id: string): Promise<BillTerm | null> {
  const clean = String(id || '').trim();
  if (!clean) return null;
  if (getPgConnected()) {
    const rows = (await pgPool.query(BILL_TERM_BY_ID_SQL, [clean])).rows as BillTerm[];
    return rows[0] || null;
  }
  return billTerms.find((term) => term.id === clean) || null;
}

/** Case-insensitive code lookup, used by the uniqueness guard. */
export async function findBillTermByCode(code: string): Promise<BillTerm | null> {
  const clean = String(code || '').trim();
  if (!clean) return null;
  if (getPgConnected()) {
    const rows = (await pgPool.query(BILL_TERM_BY_CODE_SQL, [clean])).rows as BillTerm[];
    return rows[0] || null;
  }
  return billTerms.find((term) => term.code.toLowerCase() === clean.toLowerCase()) || null;
}

/** The party's configured default term, or null when none is set. */
export async function findPartyDefaultBillTerm(
  partyType: 'CUSTOMER' | 'SUPPLIER',
  partyId: string
): Promise<BillTerm | null> {
  const clean = String(partyId || '').trim();
  if (!clean) return null;
  if (getPgConnected()) {
    const sql =
      partyType === 'CUSTOMER' ? BILL_TERM_CUSTOMER_DEFAULT_SQL : BILL_TERM_SUPPLIER_DEFAULT_SQL;
    const rows = (await pgPool.query(sql, [clean])).rows as BillTerm[];
    return rows[0] || null;
  }
  if (partyType === 'CUSTOMER') {
    const customer = customerMasterRecords.find(
      (row) => row.id === clean || row.customerId === clean
    );
    return billTerms.find((term) => term.id === customer?.billTermsId) || null;
  }
  const supplier = suppliers.find((row) => row.id === clean);
  return billTerms.find((term) => term.id === supplier?.billTermsId) || null;
}

/**
 * Resolve the term and due date for a new invoice.
 *
 * Rules:
 * - An explicit due date wins, but may never precede the invoice date.
 * - Otherwise the selected term (or the party's default) supplies the days.
 * - No term and no override means no stored due date; aging falls back to the
 *   document date, which is the existing no-terms behaviour.
 */
export async function resolveInvoiceTerms(
  input: ResolveInvoiceTermsInput
): Promise<ResolvedInvoiceTerms> {
  const invoiceDateAD = dateOnly(input.invoiceDateAD);
  if (!isValidADDate(invoiceDateAD)) {
    throw new ApiError(400, 'A valid invoice date is required to calculate bill terms.');
  }

  const explicitDueDateAD = dateOnly(input.dueDateAD);
  if (explicitDueDateAD && !isValidADDate(explicitDueDateAD)) {
    throw new ApiError(400, `Due date '${input.dueDateAD}' is not a valid date.`);
  }
  if (explicitDueDateAD && explicitDueDateAD < invoiceDateAD) {
    throw new ApiError(400, 'The due date cannot be before the invoice date.');
  }

  const requestedTermId = String(input.billTermsId || '').trim();
  let term: BillTerm | null = null;
  if (requestedTermId) {
    term = await findBillTermById(requestedTermId);
    if (!term || !term.active) {
      throw new ApiError(400, 'The selected bill terms were not found or are inactive.');
    }
  } else if (input.partyType && input.partyId) {
    term = await findPartyDefaultBillTerm(input.partyType, input.partyId);
    if (term && !term.active) term = null;
  }

  const dueDateAD =
    explicitDueDateAD ||
    (term ? computeDueDateAD(invoiceDateAD, Number(term.dueDays) || 0) : null);
  if (!dueDateAD) {
    return { billTermsId: term?.id || null, dueDateAD: null, dueDateBS: null };
  }
  if (dueDateAD < invoiceDateAD) {
    throw new ApiError(400, 'The calculated due date falls before the invoice date.');
  }

  return {
    billTermsId: term?.id || null,
    dueDateAD,
    // The calendar, not the client, owns the BS spelling. An unseeded day is
    // stored as the explicit marker rather than a fabricated date.
    dueDateBS: await resolveBsDateForLedger(dueDateAD),
  };
}
