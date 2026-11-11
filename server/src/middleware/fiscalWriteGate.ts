/**
 * The closed-fiscal-year write gate, as a pure decision (audit finding H1).
 *
 * The middleware used to answer "may this write land in a locked year?" from the
 * `x-fiscal-year-id` REQUEST HEADER — a value the caller supplies. Omitting the
 * header skipped the check entirely, so any client could post into an IRD-locked
 * year, and `INVENTORY_MANAGER` (a non-finance role) could override a lock. Both
 * made the period lock advisory.
 *
 * The rule now derives the accounting year from the DOCUMENT's own date, so the
 * request cannot choose whether it is checked, and only a Super Admin may
 * override — with a written reason that the middleware audit-logs.
 *
 * This module is pure (no Express, no DB, no runtime state) so every branch of
 * the rule is unit-testable without a server, and `fiscalYears` is passed in so
 * the caller decides whether that list is the boot cache or a fresh read.
 */
import { pickCurrentFiscalYear, toCalendarDate } from '../utils/fiscalYear';

/** Methods that can change stored financial data. */
export const FISCAL_WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Paths whose writes are not document postings. Closing/reopening a year,
 * signing in, streaming sync, maintenance repairs and the database probe must
 * stay usable — otherwise a closed year would lock the operator out of the
 * screen that reopens it.
 */
export const FISCAL_WRITE_EXEMPT_PREFIXES: readonly string[] = [
  '/auth/',
  '/fiscal-years/',
  '/sync/',
  '/admin/',
  '/db/',
  '/health',
];

/**
 * Body fields that carry a document's accounting date, most specific first.
 * A request with none of them is judged against the current fiscal year, which
 * is the period an undated write belongs to.
 */
export const DOCUMENT_DATE_FIELDS: readonly string[] = [
  'journalDateAD',
  'invoiceDateAD',
  'paymentDateAD',
  'receiptDateAD',
  'returnDateAD',
  'transactionDateAD',
  'documentDateAD',
  'runDateAD',
  'shipmentDateAD',
  'orderDateAD',
  'closeDateAD',
  'asOfDateAD',
  'effectiveFromAD',
  'dateAD',
  'dateAd',
  'date',
];

/** Minimum length of a closed-period override reason. */
export const OVERRIDE_REASON_MIN_LENGTH = 10;

/** The first parseable document date in the body, or '' when there is none. */
export function writeDateFromBody(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  for (const field of DOCUMENT_DATE_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const date = toCalendarDate(value);
    if (date) return date;
  }
  return '';
}

/** The fiscal year whose AD range contains `dateAD`, if any. */
export function fiscalYearForDate(fiscalYears: readonly any[], dateAD: string): any | undefined {
  if (!dateAD) return undefined;
  return (fiscalYears || []).find((fiscalYear: any) => {
    const start = toCalendarDate(fiscalYear?.startDateAD);
    const end = toCalendarDate(fiscalYear?.endDateAD);
    return Boolean(start && end && dateAD >= start && dateAD <= end);
  });
}

export interface FiscalWriteGateInput {
  method: string;
  path: string;
  body: unknown;
  role: string | undefined;
  fiscalYears: readonly any[];
}

export type FiscalWriteGateVerdict =
  /** Not a gated write, not a closed year, or no fiscal year covers the date. */
  | { kind: 'allow' }
  /** The derived year is closed and this caller may not override it. */
  | { kind: 'closed'; fiscalYearCode: string; dateAD: string; requiresReason: boolean }
  /** A Super Admin supplied a reason: allow it and record the override. */
  | { kind: 'override'; fiscalYearCode: string; dateAD: string; reason: string };

/**
 * Decide whether a mutating request may land in the fiscal year its own document
 * date falls in.
 *
 * `requiresReason` distinguishes "you are not allowed at all" (423 with no
 * escape hatch) from "you may, but say why" (423 with `requiresOverrideReason`),
 * so the client can render the right instruction instead of a generic refusal.
 */
export function evaluateFiscalYearWriteGate(input: FiscalWriteGateInput): FiscalWriteGateVerdict {
  const method = String(input.method || '').toUpperCase();
  if (!FISCAL_WRITE_METHODS.includes(method)) return { kind: 'allow' };

  const path = String(input.path || '');
  if (FISCAL_WRITE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return { kind: 'allow' };

  const dateAD = writeDateFromBody(input.body);
  // An undated write is judged against the current year. Deriving the year from
  // the document (never the view header) is what closes the "omit the header"
  // bypass: there is no request shape that skips the comparison.
  const fiscalYear = dateAD
    ? fiscalYearForDate(input.fiscalYears, dateAD)
    : pickCurrentFiscalYear(input.fiscalYears as any[]);
  if (!fiscalYear || !fiscalYear.isClosed) return { kind: 'allow' };

  const fiscalYearCode = String(fiscalYear.code || fiscalYear.id || 'closed year');
  if (String(input.role || '') !== 'SUPER_ADMIN') {
    return { kind: 'closed', fiscalYearCode, dateAD, requiresReason: false };
  }

  const record = (input.body && typeof input.body === 'object' ? input.body : {}) as Record<string, unknown>;
  const reason = typeof record.overrideReason === 'string' ? record.overrideReason.trim() : '';
  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) {
    return { kind: 'closed', fiscalYearCode, dateAD, requiresReason: true };
  }

  return { kind: 'override', fiscalYearCode, dateAD, reason };
}
