/**
 * Warranty claim / RMA SQL. Pure builders and statements only, so the
 * controller/service keep the HTTP and transaction concerns.
 *
 * The claim header owns the branch. Events are reachable only through their
 * claim; the branch-scope registry guards the header path.
 */
import {
  WARRANTY_CLAIM_OPEN_STATUSES,
  WARRANTY_CLAIM_STATUSES,
  type WarrantyClaimStatus,
} from '../../../shared/warrantyClaim';

export interface WarrantyClaimQueryOptions {
  branchId?: unknown;
  branchScope?: string[];
  query?: unknown;
  status?: unknown;
  /** Only rows that are not CLOSED/REJECTED (`open=1`). */
  openOnly?: unknown;
  coverageType?: unknown;
}

const CLAIM_STATUSES = new Set<string>(WARRANTY_CLAIM_STATUSES);
const OPEN_STATUSES = new Set<string>(WARRANTY_CLAIM_OPEN_STATUSES);

export const WARRANTY_CLAIM_COLUMNS = `c.id,
  c.claim_no AS "claimNo",
  c.branch_id AS "branchId",
  COALESCE(b.name, c.branch_id) AS "branchName",
  c.coverage_id AS "coverageId",
  c.coverage_type AS "coverageType",
  c.customer_id AS "customerId",
  c.customer_name AS "customerName",
  c.serial_number AS "serialNumber",
  c.product_id AS "productId",
  c.product_name AS "productName",
  to_char(c.reported_date_ad, 'YYYY-MM-DD') AS "reportedDateAD",
  c.reported_date_bs AS "reportedDateBS",
  c.symptom,
  c.status,
  c.resolution,
  c.vendor_id AS "vendorId",
  c.vendor_name AS "vendorName",
  c.vendor_claim_ref AS "vendorClaimRef",
  c.expected_credit::float8 AS "expectedCredit",
  c.received_credit::float8 AS "receivedCredit",
  c.credit_note_no AS "creditNoteNo",
  c.journal_id AS "journalId",
  c.replacement_serial AS "replacementSerial",
  c.rma_reference AS "rmaReference",
  to_char(c.sent_to_vendor_date_ad, 'YYYY-MM-DD') AS "sentToVendorDateAD",
  c.sent_to_vendor_date_bs AS "sentToVendorDateBS",
  to_char(c.resolved_date_ad, 'YYYY-MM-DD') AS "resolvedDateAD",
  c.resolved_date_bs AS "resolvedDateBS",
  to_char(c.closed_date_ad, 'YYYY-MM-DD') AS "closedDateAD",
  c.closed_date_bs AS "closedDateBS",
  c.notes,
  c.is_demo AS "isDemo",
  c.created_by AS "createdBy",
  c.created_at AS "createdAt",
  GREATEST(0, CURRENT_DATE - c.reported_date_ad)::int AS "slaDays",
  (c.status NOT IN ('CLOSED', 'REJECTED')) AS "open"`;

export const WARRANTY_CLAIM_FROM = `
 FROM warranty_claims c
 LEFT JOIN branches b ON b.id = c.branch_id`;

export const WARRANTY_CLAIM_SELECT = `${WARRANTY_CLAIM_COLUMNS}${WARRANTY_CLAIM_FROM}`;

function normalizeStatus(value: unknown): WarrantyClaimStatus | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return CLAIM_STATUSES.has(normalized) ? (normalized as WarrantyClaimStatus) : null;
}

function buildClaimWhere(opts: WarrantyClaimQueryOptions): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (Array.isArray(opts.branchScope)) {
    if (opts.branchScope.length === 0) conditions.push('FALSE');
    else {
      params.push(opts.branchScope);
      conditions.push(`c.branch_id = ANY($${params.length})`);
    }
  } else if (typeof opts.branchId === 'string' && opts.branchId && opts.branchId !== 'ALL') {
    params.push(opts.branchId);
    conditions.push(`c.branch_id = $${params.length}`);
  }
  if (opts.coverageType === 'VENDOR' || opts.coverageType === 'SELLER') {
    params.push(opts.coverageType);
    conditions.push(`c.coverage_type = $${params.length}`);
  }
  const status = normalizeStatus(opts.status);
  if (status) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (String(opts.openOnly ?? '') === '1' || opts.openOnly === true) {
    params.push([...OPEN_STATUSES]);
    conditions.push(`c.status = ANY($${params.length}::varchar[])`);
  }
  if (typeof opts.query === 'string' && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`);
    conditions.push(
      `lower(COALESCE(c.claim_no, '') || ' ' || COALESCE(c.serial_number, '') || ' ' || COALESCE(c.customer_name, '') || ' ' || COALESCE(c.product_name, '') || ' ' || COALESCE(c.vendor_name, '') || ' ' || COALESCE(c.vendor_claim_ref, '') || ' ' || COALESCE(c.rma_reference, '')) LIKE $${params.length}`
    );
  }
  return { whereSql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}

export function buildWarrantyClaimPageQuery(
  opts: WarrantyClaimQueryOptions,
  page = 1,
  pageSize = 15
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildClaimWhere(opts);
  const limit = Math.max(1, Math.min(200, Math.trunc(pageSize) || 15));
  const offset = (Math.max(1, Math.trunc(page) || 1) - 1) * limit;
  return {
    sql: `SELECT ${WARRANTY_CLAIM_SELECT}${whereSql}
      ORDER BY c.reported_date_ad DESC, c.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  };
}

export function buildWarrantyClaimCountQuery(opts: WarrantyClaimQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildClaimWhere(opts);
  return {
    sql: `SELECT COUNT(*)::int AS count FROM warranty_claims c${whereSql}`,
    params,
  };
}

/** KPI counts for the filtered population, ignoring the status filter. */
export function buildWarrantyClaimSummaryQuery(opts: WarrantyClaimQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildClaimWhere({ ...opts, status: undefined });
  return {
    sql: `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.status NOT IN ('CLOSED', 'REJECTED'))::int AS open,
      COUNT(*) FILTER (WHERE c.status = 'REPORTED')::int AS reported,
      COUNT(*) FILTER (WHERE c.status = 'SENT_TO_VENDOR')::int AS "withVendor",
      COUNT(*) FILTER (WHERE c.status IN ('REPLACED', 'REPAIRED', 'CREDITED'))::int AS resolved,
      COUNT(*) FILTER (WHERE c.status = 'CLOSED')::int AS closed,
      COUNT(*) FILTER (WHERE c.status = 'REJECTED')::int AS rejected
      FROM warranty_claims c${whereSql}`,
    params,
  };
}

export const WARRANTY_CLAIM_FIND_SQL = `SELECT ${WARRANTY_CLAIM_SELECT}
  WHERE c.id = $1`;

export interface WarrantyRecoveryQueryOptions extends WarrantyClaimQueryOptions {
  onlyShortfall?: unknown;
  outstandingRma?: unknown;
}

/**
 * Recovery rows are claims with an RMA or money in flight. The common branch,
 * coverage and search predicates stay identical to the claims register.
 */
function buildWarrantyRecoveryWhere(opts: WarrantyRecoveryQueryOptions): {
  whereSql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildClaimWhere(opts);
  const conditions: string[] = [];
  if (whereSql) conditions.push(whereSql.replace(/^ WHERE /, ''));
  conditions.push(
    `(c.expected_credit > 0 OR c.received_credit > 0 OR c.status = 'SENT_TO_VENDOR')`
  );
  if (String(opts.onlyShortfall ?? '') === '1' || opts.onlyShortfall === true) {
    conditions.push('c.expected_credit > c.received_credit + 0.005');
  }
  if (String(opts.outstandingRma ?? '') === '1' || opts.outstandingRma === true) {
    conditions.push(`c.status = 'SENT_TO_VENDOR'`);
  }
  return { whereSql: ` WHERE ${conditions.join(' AND ')}`, params };
}

export function buildWarrantyRecoveryPageQuery(
  opts: WarrantyRecoveryQueryOptions,
  page = 1,
  pageSize = 15
): { sql: string; params: unknown[] } {
  const { whereSql, params } = buildWarrantyRecoveryWhere(opts);
  const limit = Math.max(1, Math.min(200, Math.trunc(pageSize) || 15));
  const offset = (Math.max(1, Math.trunc(page) || 1) - 1) * limit;
  return {
    sql: `SELECT ${WARRANTY_CLAIM_COLUMNS},
      COALESCE((SELECT SUM(l.debit) FROM gl_journal_lines l WHERE l.journal_id = c.journal_id), 0)::float8 AS "postedCredit",
      GREATEST(0, c.expected_credit - c.received_credit)::float8 AS "shortfall",
      CASE WHEN c.status <> 'SENT_TO_VENDOR' OR c.sent_to_vendor_date_ad IS NULL THEN NULL
        ELSE GREATEST(0, CURRENT_DATE - c.sent_to_vendor_date_ad)::int END AS "rmaAgeDays"
      ${WARRANTY_CLAIM_FROM}${whereSql}
      ORDER BY "shortfall" DESC, "rmaAgeDays" DESC NULLS LAST, c.reported_date_ad DESC, c.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  };
}

export function buildWarrantyRecoveryCountQuery(opts: WarrantyRecoveryQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildWarrantyRecoveryWhere(opts);
  return {
    sql: `SELECT COUNT(*)::int AS count FROM warranty_claims c${whereSql}`,
    params,
  };
}

export function buildWarrantyRecoverySummaryQuery(opts: WarrantyRecoveryQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildWarrantyRecoveryWhere(opts);
  return {
    sql: `SELECT
      COUNT(*)::int AS claims,
      COUNT(*) FILTER (WHERE c.status NOT IN ('CLOSED', 'REJECTED'))::int AS "openClaims",
      COUNT(*) FILTER (WHERE c.status = 'SENT_TO_VENDOR')::int AS "outstandingRmas",
      COALESCE(SUM(c.expected_credit), 0)::float8 AS "expectedCredit",
      COALESCE(SUM(c.received_credit), 0)::float8 AS "receivedCredit",
      COALESCE(SUM(credit.posted), 0)::float8 AS "postedCredit",
      COALESCE(SUM(GREATEST(0, c.expected_credit - c.received_credit)), 0)::float8 AS shortfall,
      COUNT(*) FILTER (WHERE c.expected_credit > c.received_credit + 0.005)::int AS "shortfallClaims",
      COUNT(*) FILTER (WHERE c.received_credit > 0 AND (
        c.journal_id IS NULL OR ABS(COALESCE(credit.posted, 0) - c.received_credit) > 0.005
      ))::int AS "postingExceptions"
      FROM warranty_claims c
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(l.debit), 0) AS posted
        FROM gl_journal_lines l WHERE l.journal_id = c.journal_id
      ) credit ON TRUE${whereSql}`,
    params,
  };
}

export function buildWarrantyRecoveryAgingQuery(opts: WarrantyRecoveryQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildWarrantyRecoveryWhere(opts);
  return {
    sql: `SELECT
      CASE
        WHEN CURRENT_DATE - c.sent_to_vendor_date_ad <= 7 THEN '0-7'
        WHEN CURRENT_DATE - c.sent_to_vendor_date_ad <= 14 THEN '8-14'
        WHEN CURRENT_DATE - c.sent_to_vendor_date_ad <= 30 THEN '15-30'
        ELSE '31+'
      END AS bucket,
      COUNT(*)::int AS claims,
      COALESCE(SUM(c.expected_credit), 0)::float8 AS "expectedCredit",
      COALESCE(SUM(c.received_credit), 0)::float8 AS "receivedCredit",
      COALESCE(SUM(GREATEST(0, c.expected_credit - c.received_credit)), 0)::float8 AS shortfall
      FROM warranty_claims c${whereSql}
      AND c.status = 'SENT_TO_VENDOR' AND c.sent_to_vendor_date_ad IS NOT NULL
      GROUP BY 1`,
    params,
  };
}

export function buildWarrantyRecoveryVendorQuery(opts: WarrantyRecoveryQueryOptions): {
  sql: string;
  params: unknown[];
} {
  const { whereSql, params } = buildWarrantyRecoveryWhere(opts);
  return {
    sql: `SELECT
      COALESCE(NULLIF(c.vendor_name, ''), 'Unassigned') AS "vendorName",
      COUNT(*)::int AS claims,
      COALESCE(SUM(c.expected_credit), 0)::float8 AS "expectedCredit",
      COALESCE(SUM(c.received_credit), 0)::float8 AS "receivedCredit",
      COALESCE(SUM(credit.posted), 0)::float8 AS "postedCredit",
      COALESCE(SUM(GREATEST(0, c.expected_credit - c.received_credit)), 0)::float8 AS shortfall
      FROM warranty_claims c
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(l.debit), 0) AS posted
        FROM gl_journal_lines l WHERE l.journal_id = c.journal_id
      ) credit ON TRUE${whereSql}
      GROUP BY 1
      ORDER BY shortfall DESC, "expectedCredit" DESC, "vendorName" ASC
      LIMIT 50`,
    params,
  };
}

export const WARRANTY_CLAIM_RAW_SQL = `SELECT
  id, claim_no AS "claimNo", branch_id AS "branchId", coverage_id AS "coverageId",
  coverage_type AS "coverageType", customer_id AS "customerId",
  customer_name AS "customerName", serial_number AS "serialNumber",
  product_id AS "productId", product_name AS "productName",
  to_char(reported_date_ad, 'YYYY-MM-DD') AS "reportedDateAD",
  reported_date_bs AS "reportedDateBS", symptom, status, resolution,
  vendor_id AS "vendorId", vendor_name AS "vendorName",
  vendor_claim_ref AS "vendorClaimRef", expected_credit::float8 AS "expectedCredit",
  received_credit::float8 AS "receivedCredit", credit_note_no AS "creditNoteNo",
  journal_id AS "journalId", replacement_serial AS "replacementSerial",
  rma_reference AS "rmaReference",
  to_char(sent_to_vendor_date_ad, 'YYYY-MM-DD') AS "sentToVendorDateAD",
  sent_to_vendor_date_bs AS "sentToVendorDateBS",
  to_char(resolved_date_ad, 'YYYY-MM-DD') AS "resolvedDateAD",
  resolved_date_bs AS "resolvedDateBS",
  to_char(closed_date_ad, 'YYYY-MM-DD') AS "closedDateAD",
  closed_date_bs AS "closedDateBS", notes
 FROM warranty_claims WHERE id = $1 FOR UPDATE`;

export const WARRANTY_CLAIM_OPEN_FOR_UNIT_SQL = `SELECT id FROM warranty_claims
  WHERE coverage_type = $1 AND lower(trim(serial_number)) = lower(trim($2))
    AND status = ANY($3::varchar[])
  LIMIT 1`;

export const WARRANTY_CLAIM_INSERT_SQL = `INSERT INTO warranty_claims (
  id, claim_no, branch_id, coverage_id, coverage_type, customer_id, customer_name,
  serial_number, product_id, product_name, reported_date_ad, reported_date_bs,
  symptom, status, resolution, vendor_id, vendor_name, vendor_claim_ref,
  expected_credit, received_credit, credit_note_no, journal_id, replacement_serial,
  rma_reference, notes,
  is_demo, created_by, updated_by
) VALUES (
  $1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12,
  $13, $14, $15, $16, $17, $18,
  $19, $20, $21, $22, $23,
  $24, $25,
  $26, $27, $28
)`;

export const WARRANTY_CLAIM_UPDATE_SQL = `UPDATE warranty_claims SET
  status = $2,
  resolution = $3,
  vendor_id = $4,
  vendor_name = $5,
  vendor_claim_ref = $6,
  expected_credit = $7,
  received_credit = $8,
  credit_note_no = $9,
  journal_id = $10,
  replacement_serial = $11,
  rma_reference = $12,
  sent_to_vendor_date_ad = $13,
  sent_to_vendor_date_bs = $14,
  resolved_date_ad = $15,
  resolved_date_bs = $16,
  closed_date_ad = $17,
  closed_date_bs = $18,
  notes = $19,
  updated_by = $20,
  updated_at = CURRENT_TIMESTAMP
 WHERE id = $1`;

export const WARRANTY_CLAIM_EVENT_INSERT_SQL = `INSERT INTO warranty_claim_events
  (id, claim_id, from_status, status, note, actor)
 VALUES ($1, $2, $3, $4, $5, $6)`;

export const WARRANTY_CLAIM_EVENT_SELECT_SQL = `SELECT
  id, claim_id AS "claimId", from_status AS "fromStatus", status, note, actor,
  created_at AS "createdAt"
 FROM warranty_claim_events WHERE claim_id = $1 ORDER BY created_at ASC, id ASC`;

/** The replacement unit must still be an in-stock unit in the claim branch. */
export const WARRANTY_CLAIM_SERIAL_SQL = `SELECT
  s.id, s.device_serial AS "serialNumber", s.product_id AS "productId",
  COALESCE(s.product_name, p.name) AS "productName", p.sku,
  s.branch_id AS "branchId", s.status, s.history_json AS "historyJson"
 FROM serial_log s
 LEFT JOIN products p ON p.id = s.product_id
 WHERE lower(trim(s.device_serial)) = lower(trim($1))
 LIMIT 1 FOR UPDATE OF s`;

/** Claim stock movements lock the row and read its moving-average cost. */
export const WARRANTY_CLAIM_STOCK_LOCK_SQL = `SELECT
  id, quantity_on_hand::float8 AS "quantityOnHand", average_cost::float8 AS "averageCost"
 FROM inventory_stock WHERE product_id = $1 AND branch_id = $2 FOR UPDATE`;

export const WARRANTY_CLAIM_SERIAL_STATUS_SQL = `UPDATE serial_log SET
  status = $2,
  customer_id = $3,
  customer_name = $4,
  source_type = 'WARRANTY_CLAIM',
  source_id = $5,
  history_json = (COALESCE(NULLIF(history_json, ''), '[]')::jsonb || $6::jsonb)::text,
  updated_at = CURRENT_TIMESTAMP
 WHERE id = $1`;

export const WARRANTY_CLAIM_CREDIT_JOURNAL_SQL = `SELECT
  j.id, j.journal_no AS "journalNo", COALESCE(SUM(l.debit), 0)::float8 AS amount
 FROM gl_journals j
 LEFT JOIN gl_journal_lines l ON l.journal_id = j.id
 WHERE j.id = $1
 GROUP BY j.id, j.journal_no`;
