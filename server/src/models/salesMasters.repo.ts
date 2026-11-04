/**
 * SQL for sales territories (areas) and the agents who own them. These are
 * party/sales master data; customer defaults and invoice snapshots reference
 * the ids, while the invoice keeps its own name snapshot.
 */

export const AREA_SELECT = `SELECT a.id, a.code, a.name,
  a.parent_id AS "parentId", parent.name AS "parentName",
  a.branch_id AS "branchId", b.name AS "branchName",
  a.active, a.is_demo AS "isDemo"
 FROM areas a
 LEFT JOIN areas parent ON parent.id = a.parent_id
 LEFT JOIN branches b ON b.id = a.branch_id`;

export const AREA_LIST_SQL = `${AREA_SELECT} ORDER BY a.code ASC`;
export const AREA_BY_ID_SQL = `${AREA_SELECT} WHERE a.id = $1 LIMIT 1`;
export const AREA_BY_CODE_SQL = `${AREA_SELECT} WHERE LOWER(a.code) = LOWER($1) LIMIT 1`;
export const AREA_CHILDREN_SQL = 'SELECT id, branch_id AS "branchId" FROM areas WHERE parent_id = $1';

export const AREA_INSERT_SQL = `INSERT INTO areas (
   id, code, name, parent_id, branch_id, active, is_demo
 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`;
export const AREA_UPDATE_SQL = `UPDATE areas SET
   code = $1, name = $2, parent_id = $3, branch_id = $4, active = $5,
   updated_at = CURRENT_TIMESTAMP
 WHERE id = $6`;
export const AREA_DELETE_SQL = 'DELETE FROM areas WHERE id = $1';
export const AREA_USAGE_COUNT_SQL = `SELECT (
   (SELECT COUNT(*) FROM customer_records WHERE area_id = $1) +
   (SELECT COUNT(*) FROM sales_invoices WHERE area_id = $1) +
   (SELECT COUNT(*) FROM sales_agents WHERE area_id = $1) +
   (SELECT COUNT(*) FROM areas WHERE parent_id = $1)
 )::int AS count`;

export function areaInsertParams(area: Record<string, any>): unknown[] {
  return [
    area.id,
    area.code,
    area.name,
    area.parentId || null,
    area.branchId || null,
    Boolean(area.active),
    Boolean(area.isDemo),
  ];
}

export function areaUpdateParams(area: Record<string, any>, id: string): unknown[] {
  return [
    area.code,
    area.name,
    area.parentId || null,
    area.branchId || null,
    Boolean(area.active),
    id,
  ];
}

export const SALES_AGENT_SELECT = `SELECT sa.id, sa.code, sa.name, sa.phone, sa.email,
  sa.area_id AS "areaId", a.name AS "areaName",
  sa.commission_rate AS "commissionRate", sa.active, sa.is_demo AS "isDemo"
 FROM sales_agents sa
 LEFT JOIN areas a ON a.id = sa.area_id`;

export const SALES_AGENT_LIST_SQL = `${SALES_AGENT_SELECT} ORDER BY sa.code ASC`;
export const SALES_AGENT_BY_ID_SQL = `${SALES_AGENT_SELECT} WHERE sa.id = $1 LIMIT 1`;
export const SALES_AGENT_BY_CODE_SQL = `${SALES_AGENT_SELECT} WHERE LOWER(sa.code) = LOWER($1) LIMIT 1`;

export const SALES_AGENT_INSERT_SQL = `INSERT INTO sales_agents (
   id, code, name, phone, email, area_id, commission_rate, active, is_demo
 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
export const SALES_AGENT_UPDATE_SQL = `UPDATE sales_agents SET
   code = $1, name = $2, phone = $3, email = $4, area_id = $5,
   commission_rate = $6, active = $7, updated_at = CURRENT_TIMESTAMP
 WHERE id = $8`;
export const SALES_AGENT_DELETE_SQL = 'DELETE FROM sales_agents WHERE id = $1';
export const SALES_AGENT_USAGE_COUNT_SQL = `SELECT (
   (SELECT COUNT(*) FROM customer_records WHERE agent_id = $1) +
   (SELECT COUNT(*) FROM sales_invoices WHERE agent_id = $1)
 )::int AS count`;

export function salesAgentInsertParams(agent: Record<string, any>): unknown[] {
  return [
    agent.id,
    agent.code,
    agent.name,
    agent.phone || null,
    agent.email || null,
    agent.areaId || null,
    Number(agent.commissionRate) || 0,
    Boolean(agent.active),
    Boolean(agent.isDemo),
  ];
}

export function salesAgentUpdateParams(agent: Record<string, any>, id: string): unknown[] {
  return [
    agent.code,
    agent.name,
    agent.phone || null,
    agent.email || null,
    agent.areaId || null,
    Number(agent.commissionRate) || 0,
    Boolean(agent.active),
    id,
  ];
}

export const SALES_MASTER_BRANCH_EXISTS_SQL = 'SELECT id FROM branches WHERE id = $1';