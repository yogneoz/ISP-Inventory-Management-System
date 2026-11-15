/**
 * Document-number generators extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns the fail-closed branch-scoped daily document-number issuer
 * and the operator/import override validation.
 */
import { pgPool } from '../../db';
import { ApiError } from '../errors/ApiError';
import { branches, docNumberConfigs, fiscalYears, getPgConnected } from '../state/runtimeState';
import { getFiscalYearCodeForDate } from './fiscalYear';

// ---------------------------------------------------------------------------
// STRICT PER-BRANCH DAILY DOCUMENT NUMBERING (audit-safe)
// ---------------------------------------------------------------------------
// Produces the canonical, branch-scoped, daily-reset document number used by
// every operational document in the system:
//
//   {DOC_TYPE}-{BRANCH_CODE}-{YYYYMMDD}{NNNN}
//   e.g. PO-BRC01-202609150001   (4-digit counter, rolls to 5 digits at 9999)
//   e.g. ST-BRH01-2026091510002  (branch transfers / shipments)
//
// The counter is a database row in `document_sequence_daily` keyed by
// (branch, doc_type, date). Issuing is atomic:
//   INSERT ... ON CONFLICT (branch_id, doc_type, date_ad)
//   DO UPDATE SET next_number = document_sequence_daily.next_number + 1
//   RETURNING next_number
// so two concurrent users (or server restarts) can never receive the same
// number. Because the key includes the calendar date, the counter resets to 1
// automatically each day with no fiscal-year reset and no reuse across days.
//
// There is deliberately no in-memory or timestamp fallback: a sequence that
// cannot allocate the next legal number refuses the posting/import entirely.
const DOC_TYPE_CODE_MAP: Record<string, string> = {
  'PO': 'PO',
  'PURCHASE_ORDER': 'PO',
  'PURCHASE_INVOICE': 'PI',
  'INV': 'INV',
  'PI': 'PI',
  'BILL': 'PI',
  'TRF': 'ST',
  'TRANSFER': 'ST',
  'SHIPMENT': 'ST',
  'ST': 'ST',
  'SALE': 'SALE',
  'STOCK_OUT': 'SALE',
  'INVOICE': 'INV',
  'SALES_INVOICE': 'INV',
  'CON': 'CON',
  'CONSUMABLE_ISSUE': 'CON',
  'DMG': 'DMG',
  'DAMAGE': 'DMG',
  'DSP': 'DSP',
  'DISPOSAL': 'DSP',
  'PLT': 'PLT',
  'PULLOUT': 'PLT',
  'SA': 'SA',
  'STOCK_ADJUSTMENT': 'SA',
  'GRN': 'GRN',
  'DN': 'DN',
  'QUO': 'QUO',
  'CN': 'CN',
  'EXC': 'EXC',
  'WC': 'WC',
  'FAA': 'FAA',
  'FAR': 'FAR',
  'JV': 'JV',
  'CP': 'CP',
  'CR': 'CR',
  'BP': 'BP',
  'BR': 'BR',
  'DC': 'DC',
  'PAYROLL_RUN': 'PR',
  'LOAN': 'LOAN',
  'LOAN_RECEIPT': 'LR',
  'LOAN_REPAYMENT': 'LP',
  'LOAN_ACCRUAL': 'LA',
};

export function normalizeDocTypeCode(docType: string): string {
  return DOC_TYPE_CODE_MAP[docType.toUpperCase()] || docType.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Formats a raw sequence with a flexible width: 4 digits normally, widening
// automatically once the counter exceeds 9999 (e.g. 10000 → "10000").
export function padSequence(seqNum: number): string {
  return String(seqNum).padStart(4, '0');
}

/** The configured leading code (INV, PI, CN, DN, ...) for a document type. */
function documentNumberCode(docType: string): string {
  const cfg = docNumberConfigs.find((c) => c.id === docType);
  const configuredPrefix = String(cfg?.prefix || '').trim();
  return configuredPrefix
    ? (configuredPrefix.match(/^[A-Z0-9]+/i)?.[0] || normalizeDocTypeCode(docType)).toUpperCase()
    : normalizeDocTypeCode(docType);
}

/**
 * Issues the next document number for a branch + document type on the given
 * calendar day. When `client` is provided (inside an existing transaction) the
 * counter claim joins that transaction; otherwise a one-off connection is used.
 * Any allocation failure is a 503 refusal, never an invented number.
 */
export async function issueNextDocNumber(
  branchIdOrCode: string,
  docType: string,
  dateAd?: string,
  client?: any
): Promise<string> {
  const br = branches.find((b) => b.id === branchIdOrCode || b.code === branchIdOrCode);
  const branchCode = br?.code || branchIdOrCode || 'WH001';
  const branchId = br?.id || branchIdOrCode || 'WH001';
  // The admin-editable "doctype prefix" from document_number_configs is the
  // single source of the issued code (e.g. prefix "PO" -> "PO-BRC01-202609150001").
  // Only the leading letters/digits of the saved prefix are used, so legacy
  // values like "PO-2081-" still resolve to "PO". Unconfigured doc types
  // fall back to the built-in code map.
  const opCode = documentNumberCode(docType);
  const day = (dateAd || new Date().toISOString().split('T')[0]).slice(0, 10);
  const pool = client || pgPool;
  if (!pool) {
    throw new ApiError(503, `Document number sequence ${opCode} is unavailable; nothing was posted.`);
  }

  try {
    const result = await pool.query(
      `INSERT INTO document_sequence_daily (branch_id, doc_type, date_ad, next_number)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (branch_id, doc_type, date_ad)
       DO UPDATE SET
         next_number = document_sequence_daily.next_number + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING next_number;`,
      [branchId, opCode, day]
    );
    const issuedSeq = Number(result.rows[0]?.next_number);
    if (!Number.isInteger(issuedSeq) || issuedSeq <= 0) {
      throw new Error('The sequence returned no legal next number.');
    }
    const seqStr = padSequence(issuedSeq);
    return `${opCode}-${branchCode}-${day.replace(/-/g, '')}${seqStr}`;
  } catch (e: any) {
    console.error('Document number sequence allocation failed:', opCode, e?.message || e);
    throw new ApiError(
      503,
      `Document number sequence ${opCode} could not allocate the next legal number; nothing was posted.`
    );
  }
}

function realCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Validates an operator/import document number against the same series the
 * sequence issues. Accepted shapes are:
 *
 *   {CODE}-{BRANCH}-{YYYYMMDD}{SEQ}   same branch and same document date
 *   {CODE}-{FYYY}[-{YY}]-{...}        same fiscal year as the document date
 *
 * Prefix, branch/date period, duplicate and retirement checks are separate: a
 * caller must still enforce the table's own uniqueness constraint. This
 * function is async because the fiscal-year lookup is authoritative in PG.
 */
export async function validateDocumentNumberOverride(input: {
  number: unknown;
  docType: string;
  branchId: string;
  dateAd: string;
  client?: any;
}): Promise<string> {
  const number = typeof input.number === 'string' ? input.number.trim().toUpperCase() : '';
  const dateAd = String(input.dateAd || '').slice(0, 10);
  if (!number) throw new ApiError(400, 'A document number is required when an override is supplied.');
  if (number.length > 100) throw new ApiError(400, 'A document number may be at most 100 characters.');
  if (!realCalendarDate(dateAd)) throw new ApiError(400, 'The document date is not a real calendar date.');

  const code = documentNumberCode(input.docType);
  if (!number.startsWith(`${code}-`)) {
    throw new ApiError(400, `Document number ${number} must use the ${code}- prefix for ${input.docType}.`);
  }
  const rest = number.slice(code.length + 1);

  // Canonical daily form: the date and branch are part of the number. The
  // document must be dated the same day; a number from another branch/day is
  // not a legal override for this document.
  const daily = rest.match(/^([A-Z0-9]+)-(\d{8})(\d+)$/);
  if (daily) {
    const embedded = `${daily[2].slice(0, 4)}-${daily[2].slice(4, 6)}-${daily[2].slice(6, 8)}`;
    if (!realCalendarDate(embedded) || embedded !== dateAd) {
      throw new ApiError(400, `Document number ${number} is dated ${embedded}, not ${dateAd}.`);
    }
    const branch = branches.find((b) => b.id === input.branchId || b.code === input.branchId);
    const expectedBranch = String(branch?.code || input.branchId || '').toUpperCase();
    if (daily[1] !== expectedBranch) {
      throw new ApiError(400, `Document number ${number} belongs to branch ${daily[1]}, not ${expectedBranch}.`);
    }
    return number;
  }

  // Fiscal-year form used by the configured prefixes (INV-2081-...): the
  // embedded BS fiscal year must be the one that covers the document date.
  const legacy = rest.match(/^(\d{4})(?:-(\d{2,4}))?-(.+)$/);
  if (!legacy) {
    throw new ApiError(
      400,
      `Document number ${number} must be ${code}-{BRANCH}-{YYYYMMDD}{SEQ} or ${code}-{FISCAL_YEAR}-{SEQ}.`
    );
  }

  let fiscalYearCode = '';
  const db = input.client || (getPgConnected() ? pgPool : null);
  if (db) {
    try {
      const found = await db.query(
        `SELECT code FROM fiscal_years
          WHERE start_date_ad <= $1::date AND end_date_ad >= $1::date
          ORDER BY start_date_ad DESC LIMIT 1`,
        [dateAd]
      );
      fiscalYearCode = String(found.rows[0]?.code || '');
    } catch (e: any) {
      throw new ApiError(
        503,
        `Document number ${number} could not be validated because the fiscal-year sequence is unavailable; nothing was posted.`
      );
    }
  } else {
    fiscalYearCode = getFiscalYearCodeForDate(dateAd, fiscalYears);
  }
  if (!fiscalYearCode) {
    throw new ApiError(400, `No fiscal year covers ${dateAd}; the document number's period cannot be validated.`);
  }
  const startYear = fiscalYearCode.split('-')[0];
  const expected = legacy[2] ? `${legacy[1]}-${legacy[2]}` : legacy[1];
  if (expected !== startYear && expected !== fiscalYearCode) {
    throw new ApiError(
      400,
      `Document number ${number} carries period ${legacy[1]}${legacy[2] ? `-${legacy[2]}` : ''}, but ${dateAd} belongs to ${fiscalYearCode}.`
    );
  }
  return number;
}

/**
 * Allocate the next register number, or validate and accept an operator/import
 * override. The table's unique constraint remains the final duplicate guard;
 * this additionally refuses a number already retired by a cancelled/deleted
 * document.
 */
export async function resolveDocumentNumber(input: {
  provided?: unknown;
  docType: string;
  branchId: string;
  dateAd: string;
  client?: any;
}): Promise<string> {
  const provided = typeof input.provided === 'string' ? input.provided.trim() : '';
  if (!provided) {
    return issueNextDocNumber(input.branchId, input.docType, input.dateAd, input.client);
  }
  const number = await validateDocumentNumberOverride({
    number: provided,
    docType: input.docType,
    branchId: input.branchId,
    dateAd: input.dateAd,
    client: input.client,
  });
  const db = input.client || (getPgConnected() ? pgPool : null);
  if (db) {
    const retired = await db.query(
      'SELECT reason FROM document_number_retirements WHERE doc_type = $1 AND number = $2',
      [input.docType, number]
    );
    if (retired.rows[0]) {
      throw new ApiError(
        409,
        `Document number ${number} was retired${retired.rows[0].reason ? ` (${retired.rows[0].reason})` : ''} and cannot be reused.`
      );
    }
  }
  return number;
}

/** Mark a cancelled/deleted document number as permanently retired. */
export async function retireDocumentNumber(
  client: any,
  input: { docType: string; number: string; branchId?: string | null; documentId?: string | null; reason?: string | null }
): Promise<void> {
  if (!client || !input?.number) return;
  await client.query(
    `INSERT INTO document_number_retirements (doc_type, number, branch_id, document_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (doc_type, number) DO UPDATE SET
       branch_id = COALESCE(EXCLUDED.branch_id, document_number_retirements.branch_id),
       document_id = COALESCE(EXCLUDED.document_id, document_number_retirements.document_id),
       reason = COALESCE(EXCLUDED.reason, document_number_retirements.reason),
       retired_at = CURRENT_TIMESTAMP`,
    [input.docType, String(input.number).trim().toUpperCase(), input.branchId || null, input.documentId || null, input.reason || null]
  );
}
