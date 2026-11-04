/**
 * Bill-terms repository — SQL for the reusable credit-policy master and the
 * party-default lookups used when an invoice does not name a term.
 */
export const BILL_TERM_SELECT = `SELECT bt.id, bt.code, bt.name,
  bt.due_days AS "dueDays",
  bt.discount_days AS "discountDays",
  bt.discount_percent AS "discountPercent",
  bt.active, bt.is_demo AS "isDemo"
 FROM bill_terms bt`;

export const BILL_TERM_LIST_SQL = `${BILL_TERM_SELECT}
 ORDER BY bt.due_days ASC, bt.name ASC`;

export const BILL_TERM_BY_ID_SQL = `${BILL_TERM_SELECT} WHERE bt.id = $1 LIMIT 1`;

export const BILL_TERM_BY_CODE_SQL = `${BILL_TERM_SELECT}
 WHERE LOWER(bt.code) = LOWER($1) LIMIT 1`;

export const BILL_TERM_INSERT_SQL = `INSERT INTO bill_terms (
   id, code, name, due_days, discount_days, discount_percent, active, is_demo
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

export const BILL_TERM_UPDATE_SQL = `UPDATE bill_terms SET
   code = $1,
   name = $2,
   due_days = $3,
   discount_days = $4,
   discount_percent = $5,
   active = $6,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $7`;

export const BILL_TERM_DELETE_SQL = 'DELETE FROM bill_terms WHERE id = $1';

/**
 * A term is referenced by party defaults and by posted invoices. Both must be
 * counted before a delete so history can never point at a missing policy.
 */
export const BILL_TERM_USAGE_COUNT_SQL = `SELECT (
   (SELECT COUNT(*) FROM customer_records WHERE bill_terms_id = $1) +
   (SELECT COUNT(*) FROM suppliers WHERE bill_terms_id = $1) +
   (SELECT COUNT(*) FROM sales_invoices WHERE bill_terms_id = $1) +
   (SELECT COUNT(*) FROM purchase_invoices WHERE bill_terms_id = $1)
 )::int AS count`;

export const BILL_TERM_CUSTOMER_DEFAULT_SQL = `${BILL_TERM_SELECT}
 JOIN customer_records c ON c.bill_terms_id = bt.id
 WHERE c.id = $1 OR c.customer_id = $1
 LIMIT 1`;

export const BILL_TERM_SUPPLIER_DEFAULT_SQL = `${BILL_TERM_SELECT}
 JOIN suppliers s ON s.bill_terms_id = bt.id
 WHERE s.id = $1
 LIMIT 1`;

export function billTermInsertParams(term: Record<string, any>): unknown[] {
  return [
    term.id,
    term.code,
    term.name,
    Number(term.dueDays) || 0,
    term.discountDays ?? null,
    term.discountPercent ?? null,
    Boolean(term.active),
    Boolean(term.isDemo),
  ];
}

export function billTermUpdateParams(term: Record<string, any>, id: string): unknown[] {
  return [
    term.code,
    term.name,
    Number(term.dueDays) || 0,
    term.discountDays ?? null,
    term.discountPercent ?? null,
    Boolean(term.active),
    id,
  ];
}
