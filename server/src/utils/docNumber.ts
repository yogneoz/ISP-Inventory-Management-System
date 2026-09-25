/**
 * Document-number generators extracted from app.ts (backlog item #6 — app.ts
 * extraction). Owns the daily in-memory sequence map (offline/demo fallback
 * only) and the branch-scoped daily document-number issuer.
 */
import { pgPool } from '../../db';
import { branches, docNumberConfigs, getPgConnected } from '../state/runtimeState';

const transactionSequenceMap: Record<string, { lastDateStr: string; count: number }> = {};

// Standard Transaction ID Generator
// Pattern: {BRANCH_CODE}-{OP_TYPE}-{YYYYMMDD}-{0001}
// Daily counter resets automatically at 12:00 AM (midnight) per branch & operation type
export function generateStandardTransactionId(branchIdOrCode: string, opType: string, customDate?: Date): string {
  const br = branches.find((b) => b.id === branchIdOrCode || b.code === branchIdOrCode);
  const branchCode = br?.code || branchIdOrCode || 'WH001';

  const opPrefixMap: Record<string, string> = {
    'PO': 'PO',
    'PURCHASE_ORDER': 'PO',
    'PURCHASE_INVOICE': 'PI',
    'INV': 'PI',
    'PI': 'PI',
    'TRF': 'TRF',
    'TRANSFER': 'TRF',
    'SHIPMENT': 'TRF',
    'SALE': 'SALE',
    'STOCK_OUT': 'SALE',
    'CON': 'CON',
    'CONSUMABLE_ISSUE': 'CON',
    'DMG': 'DMG',
    'DAMAGE': 'DMG',
    'DSP': 'DSP',
    'DISPOSAL': 'DSP',
    'PLT': 'PLT',
    'PULLOUT': 'PLT',
  };
  const opCode = opPrefixMap[opType.toUpperCase()] || opType.toUpperCase().slice(0, 4);

  const d = customDate || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  const seqKey = `${branchCode}:${opCode}:${dateStr}`;

  if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
    transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
  } else {
    transactionSequenceMap[seqKey].count += 1;
  }

  const counterStr = String(transactionSequenceMap[seqKey].count).padStart(4, '0');
  return `${branchCode}-${opCode}-${dateStr}-${counterStr}`;
}

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
// When PostgreSQL is unreachable we fall back to the in-memory legacy
// generator ONLY so a DB outage never blocks creating documents; once the DB
// returns the real sequences resume.
const DOC_TYPE_CODE_MAP: Record<string, string> = {
  'PO': 'PO',
  'PURCHASE_ORDER': 'PO',
  'PURCHASE_INVOICE': 'PI',
  'INV': 'PI',
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
  'PV': 'PV',
  'RV': 'RV',
  'CP': 'CP',
  'CR': 'CR',
  'BP': 'BP',
  'BR': 'BR',
  'DC': 'DC',
};

export function normalizeDocTypeCode(docType: string): string {
  return DOC_TYPE_CODE_MAP[docType.toUpperCase()] || docType.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// Formats a raw sequence with a flexible width: 4 digits normally, widening
// automatically once the counter exceeds 9999 (e.g. 10000 → "10000").
export function padSequence(seqNum: number): string {
  return String(seqNum).padStart(4, '0');
}

/**
 * Issues the next document number for a branch + document type on the given
 * calendar day. When `client` is provided (inside an existing transaction) the
 * counter claim joins that transaction; otherwise a one-off connection is used.
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
  const cfg = docNumberConfigs.find((c) => c.id === docType);
  const configuredPrefix = String(cfg?.prefix || '').trim();
  const opCode = configuredPrefix
    ? (configuredPrefix.match(/^[A-Z0-9]+/i)?.[0] || normalizeDocTypeCode(docType)).toUpperCase()
    : normalizeDocTypeCode(docType);
  const day = (dateAd || new Date().toISOString().split('T')[0]).slice(0, 10);

  if (!getPgConnected()) {
    // DB is down — mirror the exact same format using the in-memory daily map
    // so callers never see a different shape (still per-branch + per-day).
    const dateStr = day.replace(/-/g, '');
    const seqKey = `${branchCode}:${opCode}:${dateStr}`;
    if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
      transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
    } else {
      transactionSequenceMap[seqKey].count += 1;
    }
    return `${opCode}-${branchCode}-${dateStr}${String(transactionSequenceMap[seqKey].count).padStart(4, '0')}`;
  }

  try {
    const pool = client || pgPool;
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
    const seqStr = padSequence(issuedSeq);
    return `${opCode}-${branchCode}-${day.replace(/-/g, '')}${seqStr}`;
  } catch (e: any) {
    console.warn('issueNextDocNumber DB fallback:', e?.message);
    const dateStr = day.replace(/-/g, '');
    const seqKey = `${branchCode}:${opCode}:${dateStr}`;
    if (!transactionSequenceMap[seqKey] || transactionSequenceMap[seqKey].lastDateStr !== dateStr) {
      transactionSequenceMap[seqKey] = { lastDateStr: dateStr, count: 1 };
    } else {
      transactionSequenceMap[seqKey].count += 1;
    }
    return `${opCode}-${branchCode}-${dateStr}${String(transactionSequenceMap[seqKey].count).padStart(4, '0')}`;
  }
}
