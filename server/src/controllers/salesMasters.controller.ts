/**
 * Sales-master HTTP surface — areas (territories) and sales agents.
 * Writes are gated by `customers-manage`; a branch account may only write an
 * area in its own branch, and an agent's area must be visible to that account.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { allowedBranchScope } from '../middleware/branchScope';
import { isForeignKeyViolation } from '../services/accounting.service';
import { logAuditEvent } from '../services/audit.service';
import { booleanFlag } from '../utils/booleanFlag';
import {
  AREA_BY_CODE_SQL,
  AREA_BY_ID_SQL,
  AREA_CHILDREN_SQL,
  AREA_DELETE_SQL,
  AREA_INSERT_SQL,
  AREA_LIST_SQL,
  AREA_UPDATE_SQL,
  AREA_USAGE_COUNT_SQL,
  SALES_AGENT_BY_CODE_SQL,
  SALES_AGENT_BY_ID_SQL,
  SALES_AGENT_DELETE_SQL,
  SALES_AGENT_INSERT_SQL,
  SALES_AGENT_LIST_SQL,
  SALES_AGENT_UPDATE_SQL,
  SALES_AGENT_USAGE_COUNT_SQL,
  SALES_MASTER_BRANCH_EXISTS_SQL,
  areaInsertParams,
  areaUpdateParams,
  salesAgentInsertParams,
  salesAgentUpdateParams,
} from '../models/salesMasters.repo';
import {
  areas,
  salesAgents,
  setAreas,
  setSalesAgents,
} from '../state/runtimeState';
import type { Area, SalesAgent } from '../../../client/src/types';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function masterCode(value: unknown, label: string): string {
  const code = text(value, 30).toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new ApiError(400, `${label} code is required: 1–30 letters, digits, hyphens or underscores.`);
  }
  return code;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function assertBranchAllowed(req: any, branchId: string | null): void {
  const allowed = allowedBranchScope(req.user);
  if (!allowed) return;
  if (!branchId || !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: you cannot create or edit an area outside your branches.');
  }
}

async function areaById(id: string): Promise<Area | null> {
  if (!id) return null;
  if (getPgConnected()) {
    return ((await pgPool.query(AREA_BY_ID_SQL, [id])).rows[0] as Area) || null;
  }
  return areas.find((area) => area.id === id) || null;
}

async function assertAreaParent(areaId: string, parentId: string | null, branchId: string | null): Promise<void> {
  if (!parentId) return;
  if (parentId === areaId) throw new ApiError(400, 'An area cannot be its own parent.');
  const parent = await areaById(parentId);
  if (!parent) throw new ApiError(400, 'The selected parent area was not found.');
  if (!parent.active) throw new ApiError(400, 'The selected parent area is inactive.');
  if (parent.branchId && parent.branchId !== branchId) {
    throw new ApiError(400, 'A branch-specific parent requires a child area in the same branch.');
  }
  let cursor = parent.parentId || null;
  const seen = new Set<string>([parent.id]);
  while (cursor && !seen.has(cursor)) {
    if (cursor === areaId) throw new ApiError(400, 'That parent would make the area hierarchy circular.');
    seen.add(cursor);
    cursor = (await areaById(cursor))?.parentId || null;
  }
}

async function assertAreaBranchForChildren(
  areaId: string,
  previousBranchId: string | null,
  branchId: string | null
): Promise<void> {
  if (previousBranchId === branchId || !branchId) return;
  const children = getPgConnected()
    ? ((await pgPool.query(AREA_CHILDREN_SQL, [areaId])).rows as Array<{ id: string; branchId: string | null }>)
    : areas.filter((row) => row.parentId === areaId);
  if (children.some((child) => child.branchId !== branchId)) {
    throw new ApiError(400, 'A branch-specific parent must keep every child area in the same branch.');
  }
}

function parseArea(body: Record<string, any>, existing?: Area): Area {
  const code = masterCode(body.code ?? existing?.code, 'Area');
  const name = text(body.name ?? existing?.name, 150);
  if (!name) throw new ApiError(400, 'An area name is required.');
  const parentRaw = Object.prototype.hasOwnProperty.call(body, 'parentId') ? body.parentId : existing?.parentId;
  const branchRaw = Object.prototype.hasOwnProperty.call(body, 'branchId') ? body.branchId : existing?.branchId;
  return {
    id: existing?.id || newId('area'),
    code,
    name,
    parentId: text(parentRaw, 50) || null,
    branchId: text(branchRaw, 50) || null,
    active: booleanFlag(body.active, existing?.active ?? true),
    isDemo: existing?.isDemo ?? false,
  };
}

async function assertAreaCodeAvailable(area: Area): Promise<void> {
  if (!getPgConnected()) {
    const conflict = areas.find((row) => row.code.toLowerCase() === area.code.toLowerCase() && row.id !== area.id);
    if (conflict) throw new ApiError(409, `Area code '${area.code}' is already in use.`);
    return;
  }
  const conflict = (await pgPool.query(AREA_BY_CODE_SQL, [area.code])).rows[0] as Area | undefined;
  if (conflict && conflict.id !== area.id) throw new ApiError(409, `Area code '${area.code}' is already in use.`);
}

function rememberArea(area: Area): void {
  setAreas(areas.some((row) => row.id === area.id) ? areas.map((row) => (row.id === area.id ? area : row)) : [...areas, area]);
}

export async function get_areas(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const allowed = allowedBranchScope(req.user);
  const rows = getPgConnected() ? ((await pgPool.query(AREA_LIST_SQL)).rows as Area[]) : [...areas];
  return res.json(
    rows
      .filter((row) => (includeInactive || row.active) && (!allowed || !row.branchId || allowed.has(row.branchId)))
      .sort((a, b) => a.code.localeCompare(b.code))
  );
}

export async function post_area(req: any, res: Response): Promise<any> {
  const area = parseArea(req.body || {});
  assertBranchAllowed(req, area.branchId || null);
  await assertAreaCodeAvailable(area);
  if (area.branchId && getPgConnected() && !(await pgPool.query(SALES_MASTER_BRANCH_EXISTS_SQL, [area.branchId])).rows[0]) {
    throw new ApiError(400, `Branch ${area.branchId} does not exist.`);
  }
  await assertAreaParent(area.id, area.parentId || null, area.branchId || null);
  if (getPgConnected()) await pgPool.query(AREA_INSERT_SQL, areaInsertParams(area));
  const saved = getPgConnected() ? ((await pgPool.query(AREA_BY_ID_SQL, [area.id])).rows[0] as Area) : area;
  rememberArea(saved);
  await logAuditEvent(req, 'CREATE_AREA', 'MASTER_DATA', `Created area ${saved.code} ${saved.name}`, saved.branchId || undefined);
  return res.status(201).json(saved);
}

export async function patch_area(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An area id is required.');
  const existing = await areaById(id);
  if (!existing) throw new ApiError(404, 'Area not found.');
  const area = parseArea(req.body || {}, existing);
  assertBranchAllowed(req, area.branchId || null);
  await assertAreaCodeAvailable(area);
  if (area.branchId && getPgConnected() && !(await pgPool.query(SALES_MASTER_BRANCH_EXISTS_SQL, [area.branchId])).rows[0]) {
    throw new ApiError(400, `Branch ${area.branchId} does not exist.`);
  }
  await assertAreaParent(area.id, area.parentId || null, area.branchId || null);
  await assertAreaBranchForChildren(existing.id, existing.branchId || null, area.branchId || null);
  if (getPgConnected()) await pgPool.query(AREA_UPDATE_SQL, areaUpdateParams(area, id));
  const saved = getPgConnected() ? ((await pgPool.query(AREA_BY_ID_SQL, [id])).rows[0] as Area) : area;
  rememberArea(saved);
  await logAuditEvent(req, 'UPDATE_AREA', 'MASTER_DATA', `Updated area ${saved.code} ${saved.name}`, saved.branchId || undefined);
  return res.json(saved);
}

export async function delete_area(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An area id is required.');
  const existing = await areaById(id);
  if (!existing) throw new ApiError(404, 'Area not found.');
  if (getPgConnected()) {
    const used = Number((await pgPool.query(AREA_USAGE_COUNT_SQL, [id])).rows[0]?.count) || 0;
    if (used > 0) {
      throw new ApiError(409, `'${existing.name}' is used by ${used} customer/invoice/agent/child record(s). Retire it instead.`);
    }
    try { await pgPool.query(AREA_DELETE_SQL, [id]); }
    catch (err) {
      if (isForeignKeyViolation(err)) throw new ApiError(409, 'This area is still in use. Retire it instead.');
      throw err;
    }
  }
  setAreas(areas.filter((row) => row.id !== id));
  await logAuditEvent(req, 'DELETE_AREA', 'MASTER_DATA', `Deleted area ${existing.code} ${existing.name}`);
  return res.json({ deleted: true, id });
}

async function assertAreaVisible(req: any, areaId: string | null): Promise<void> {
  if (!areaId) return;
  const area = await areaById(areaId);
  if (!area) throw new ApiError(400, 'The selected area was not found.');
  if (!area.active) throw new ApiError(400, 'The selected area is inactive.');
  const allowed = allowedBranchScope(req.user);
  if (allowed && area.branchId && !allowed.has(area.branchId)) {
    throw new ApiError(403, 'Forbidden: that area belongs to another branch.');
  }
}

function parseAgent(body: Record<string, any>, existing?: SalesAgent): SalesAgent {
  const code = masterCode(body.code ?? existing?.code, 'Sales-agent');
  const name = text(body.name ?? existing?.name, 150);
  if (!name) throw new ApiError(400, 'A sales-agent name is required.');
  const commission = Number(body.commissionRate ?? existing?.commissionRate ?? 0);
  if (!Number.isFinite(commission) || commission < 0 || commission > 100) {
    throw new ApiError(400, 'Commission rate must be between 0 and 100.');
  }
  const areaRaw = Object.prototype.hasOwnProperty.call(body, 'areaId') ? body.areaId : existing?.areaId;
  return {
    id: existing?.id || newId('sa'),
    code,
    name,
    phone: text(body.phone ?? existing?.phone, 50) || null,
    email: text(body.email ?? existing?.email, 150) || null,
    areaId: text(areaRaw, 50) || null,
    commissionRate: commission,
    active: booleanFlag(body.active, existing?.active ?? true),
    isDemo: existing?.isDemo ?? false,
  };
}

async function assertAgentCodeAvailable(agent: SalesAgent): Promise<void> {
  if (!getPgConnected()) {
    const conflict = salesAgents.find((row) => row.code.toLowerCase() === agent.code.toLowerCase() && row.id !== agent.id);
    if (conflict) throw new ApiError(409, `Sales-agent code '${agent.code}' is already in use.`);
    return;
  }
  const conflict = (await pgPool.query(SALES_AGENT_BY_CODE_SQL, [agent.code])).rows[0] as SalesAgent | undefined;
  if (conflict && conflict.id !== agent.id) throw new ApiError(409, `Sales-agent code '${agent.code}' is already in use.`);
}

function rememberAgent(agent: SalesAgent): void {
  setSalesAgents(salesAgents.some((row) => row.id === agent.id) ? salesAgents.map((row) => (row.id === agent.id ? agent : row)) : [...salesAgents, agent]);
}

export async function get_salesAgents(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const rows = getPgConnected() ? ((await pgPool.query(SALES_AGENT_LIST_SQL)).rows as SalesAgent[]) : [...salesAgents];
  return res.json(rows.filter((row) => includeInactive || row.active).sort((a, b) => a.code.localeCompare(b.code)));
}

export async function post_salesAgent(req: any, res: Response): Promise<any> {
  const agent = parseAgent(req.body || {});
  await assertAgentCodeAvailable(agent);
  await assertAreaVisible(req, agent.areaId || null);
  if (getPgConnected()) await pgPool.query(SALES_AGENT_INSERT_SQL, salesAgentInsertParams(agent));
  const saved = getPgConnected() ? ((await pgPool.query(SALES_AGENT_BY_ID_SQL, [agent.id])).rows[0] as SalesAgent) : agent;
  rememberAgent(saved);
  await logAuditEvent(req, 'CREATE_SALES_AGENT', 'MASTER_DATA', `Created sales agent ${saved.code} ${saved.name}`);
  return res.status(201).json(saved);
}

export async function patch_salesAgent(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A sales-agent id is required.');
  const existing = getPgConnected()
    ? (((await pgPool.query(SALES_AGENT_BY_ID_SQL, [id])).rows[0] as SalesAgent) || null)
    : salesAgents.find((row) => row.id === id) || null;
  if (!existing) throw new ApiError(404, 'Sales agent not found.');
  const agent = parseAgent(req.body || {}, existing);
  await assertAgentCodeAvailable(agent);
  await assertAreaVisible(req, agent.areaId || null);
  if (getPgConnected()) await pgPool.query(SALES_AGENT_UPDATE_SQL, salesAgentUpdateParams(agent, id));
  const saved = getPgConnected() ? ((await pgPool.query(SALES_AGENT_BY_ID_SQL, [id])).rows[0] as SalesAgent) : agent;
  rememberAgent(saved);
  await logAuditEvent(req, 'UPDATE_SALES_AGENT', 'MASTER_DATA', `Updated sales agent ${saved.code} ${saved.name}`);
  return res.json(saved);
}

export async function delete_salesAgent(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A sales-agent id is required.');
  const existing = getPgConnected()
    ? (((await pgPool.query(SALES_AGENT_BY_ID_SQL, [id])).rows[0] as SalesAgent) || null)
    : salesAgents.find((row) => row.id === id) || null;
  if (!existing) throw new ApiError(404, 'Sales agent not found.');
  if (getPgConnected()) {
    const used = Number((await pgPool.query(SALES_AGENT_USAGE_COUNT_SQL, [id])).rows[0]?.count) || 0;
    if (used > 0) throw new ApiError(409, `'${existing.name}' is used by ${used} customer/invoice record(s). Retire it instead.`);
    await pgPool.query(SALES_AGENT_DELETE_SQL, [id]);
  }
  setSalesAgents(salesAgents.filter((row) => row.id !== id));
  await logAuditEvent(req, 'DELETE_SALES_AGENT', 'MASTER_DATA', `Deleted sales agent ${existing.code} ${existing.name}`);
  return res.json({ deleted: true, id });
}

/** Used by customer master and sales invoice posting to resolve the snapshot. */
export async function findAreaById(id: string): Promise<Area | null> {
  return areaById(id);
}

export async function findSalesAgentById(id: string): Promise<SalesAgent | null> {
  if (!id) return null;
  if (getPgConnected()) {
    return ((await pgPool.query(SALES_AGENT_BY_ID_SQL, [id])).rows[0] as SalesAgent) || null;
  }
  return salesAgents.find((row) => row.id === id) || null;
}