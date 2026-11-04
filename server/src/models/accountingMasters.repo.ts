/**
 * SQL for the accounting dimensions that stay outside the chart itself:
 * cost centres and narration templates. Both are master data; neither rewrites
 * posted history when edited.
 */

export const COST_CENTER_SELECT = `SELECT cc.id, cc.code, cc.name,
  cc.parent_id AS "parentId", parent.name AS "parentName",
  cc.branch_id AS "branchId", b.name AS "branchName",
  cc.active, cc.is_demo AS "isDemo"
 FROM cost_centers cc
 LEFT JOIN cost_centers parent ON parent.id = cc.parent_id
 LEFT JOIN branches b ON b.id = cc.branch_id`;

export const COST_CENTER_LIST_SQL = `${COST_CENTER_SELECT}
 ORDER BY cc.code ASC`;

export const COST_CENTER_BY_ID_SQL = `${COST_CENTER_SELECT} WHERE cc.id = $1 LIMIT 1`;

export const COST_CENTER_BY_CODE_SQL = `${COST_CENTER_SELECT}
 WHERE LOWER(cc.code) = LOWER($1) LIMIT 1`;

export const COST_CENTERS_BY_IDS_SQL = `${COST_CENTER_SELECT}
 WHERE cc.id = ANY($1::varchar[])`;

export const COST_CENTER_INSERT_SQL = `INSERT INTO cost_centers (
   id, code, name, parent_id, branch_id, active, is_demo
 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`;

export const COST_CENTER_UPDATE_SQL = `UPDATE cost_centers SET
   code = $1,
   name = $2,
   parent_id = $3,
   branch_id = $4,
   active = $5,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $6`;

export const COST_CENTER_DELETE_SQL = 'DELETE FROM cost_centers WHERE id = $1';

/** Posted lines and child centres both block a delete. */
export const COST_CENTER_USAGE_COUNT_SQL = `SELECT (
   (SELECT COUNT(*) FROM gl_journal_lines WHERE cost_center_id = $1) +
   (SELECT COUNT(*) FROM cost_centers WHERE parent_id = $1)
 )::int AS count`;

export const COST_CENTER_CHILDREN_SQL = `SELECT id, branch_id AS "branchId"
 FROM cost_centers WHERE parent_id = $1`;

export const ACCOUNTING_MASTER_BRANCH_EXISTS_SQL = 'SELECT id FROM branches WHERE id = $1';

export function costCenterInsertParams(center: Record<string, any>): unknown[] {
  return [
    center.id,
    center.code,
    center.name,
    center.parentId || null,
    center.branchId || null,
    Boolean(center.active),
    Boolean(center.isDemo),
  ];
}

export function costCenterUpdateParams(center: Record<string, any>, id: string): unknown[] {
  return [
    center.code,
    center.name,
    center.parentId || null,
    center.branchId || null,
    Boolean(center.active),
    id,
  ];
}

export const NARRATION_TEMPLATE_SELECT = `SELECT nt.id, nt.code, nt.text,
  nt.transaction_type AS "transactionType", nt.active, nt.is_demo AS "isDemo"
 FROM narration_templates nt`;

export const NARRATION_TEMPLATE_LIST_SQL = `${NARRATION_TEMPLATE_SELECT}
 ORDER BY nt.transaction_type ASC, nt.code ASC`;

export const NARRATION_TEMPLATE_BY_ID_SQL = `${NARRATION_TEMPLATE_SELECT}
 WHERE nt.id = $1 LIMIT 1`;

export const NARRATION_TEMPLATE_BY_CODE_SQL = `${NARRATION_TEMPLATE_SELECT}
 WHERE LOWER(nt.code) = LOWER($1) LIMIT 1`;

export const NARRATION_TEMPLATE_INSERT_SQL = `INSERT INTO narration_templates (
   id, code, text, transaction_type, active, is_demo
 ) VALUES ($1, $2, $3, $4, $5, $6)`;

export const NARRATION_TEMPLATE_UPDATE_SQL = `UPDATE narration_templates SET
   code = $1,
   text = $2,
   transaction_type = $3,
   active = $4,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $5`;

export const NARRATION_TEMPLATE_DELETE_SQL = 'DELETE FROM narration_templates WHERE id = $1';

export function narrationTemplateInsertParams(template: Record<string, any>): unknown[] {
  return [
    template.id,
    template.code,
    template.text,
    template.transactionType,
    Boolean(template.active),
    Boolean(template.isDemo),
  ];
}

export function narrationTemplateUpdateParams(template: Record<string, any>, id: string): unknown[] {
  return [
    template.code,
    template.text,
    template.transactionType,
    Boolean(template.active),
    id,
  ];
}