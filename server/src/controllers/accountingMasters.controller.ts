/**
 * Accounting dimension masters: cost centres and narration templates.
 *
 * Cost centres are a journal-line dimension; deleting one is refused while a
 * posted line or a child centre still points at it. Narration templates are
 * quick-pick text only; the journal keeps the chosen text, not the template id.
 */
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { allowedBranchScope } from '../middleware/branchScope';
import { isForeignKeyViolation } from '../services/accounting.service';
import { logAuditEvent } from '../services/audit.service';
import {
  ACCOUNTING_MASTER_BRANCH_EXISTS_SQL,
  COST_CENTER_BY_CODE_SQL,
  COST_CENTER_BY_ID_SQL,
  COST_CENTER_CHILDREN_SQL,
  COST_CENTER_DELETE_SQL,
  COST_CENTER_INSERT_SQL,
  COST_CENTER_LIST_SQL,
  COST_CENTER_UPDATE_SQL,
  COST_CENTER_USAGE_COUNT_SQL,
  NARRATION_TEMPLATE_BY_CODE_SQL,
  NARRATION_TEMPLATE_BY_ID_SQL,
  NARRATION_TEMPLATE_DELETE_SQL,
  NARRATION_TEMPLATE_INSERT_SQL,
  NARRATION_TEMPLATE_LIST_SQL,
  NARRATION_TEMPLATE_UPDATE_SQL,
  costCenterInsertParams,
  costCenterUpdateParams,
  narrationTemplateInsertParams,
  narrationTemplateUpdateParams,
} from '../models/accountingMasters.repo';
import {
  costCenters,
  narrationTemplates,
  setCostCenters,
  setNarrationTemplates,
} from '../state/runtimeState';
import type {
  CostCenter,
  NarrationTemplate,
  NarrationTransactionType,
} from '../../../client/src/types';

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;
const NARRATION_TYPES = new Set<NarrationTransactionType>([
  'ALL',
  'MANUAL_JOURNAL',
  'CUSTOMER_RECEIPT',
  'VENDOR_PAYMENT',
  'EXPENSE',
  'PAYROLL',
  'OPENING_BALANCE',
]);

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function masterCode(value: unknown, label: string): string {
  const code = text(value, 30).toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new ApiError(
      400,
      `${label} code is required: 1–30 letters, digits, hyphens or underscores.`
    );
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
    throw new ApiError(403, 'Forbidden: you cannot create or edit a cost centre outside your branches.');
  }
}

async function branchExists(branchId: string): Promise<boolean> {
  if (!getPgConnected()) return true;
  return Boolean((await pgPool.query(ACCOUNTING_MASTER_BRANCH_EXISTS_SQL, [branchId])).rows[0]);
}

async function costCenterById(id: string): Promise<CostCenter | null> {
  if (!id) return null;
  if (getPgConnected()) {
    return ((await pgPool.query(COST_CENTER_BY_ID_SQL, [id])).rows[0] as CostCenter) || null;
  }
  return costCenters.find((center) => center.id === id) || null;
}

async function assertCostCenterParent(
  centerId: string,
  parentId: string | null,
  branchId: string | null
): Promise<void> {
  if (!parentId) return;
  if (parentId === centerId) throw new ApiError(400, 'A cost centre cannot be its own parent.');
  const parent = await costCenterById(parentId);
  if (!parent) throw new ApiError(400, 'The selected parent cost centre was not found.');
  if (!parent.active) throw new ApiError(400, 'The selected parent cost centre is inactive.');
  if (parent.branchId && parent.branchId !== branchId) {
    throw new ApiError(
      400,
      'A branch-specific parent requires a child cost centre in the same branch.'
    );
  }
  // Walk up from the proposed parent; reaching this centre would create a loop.
  let cursor: string | null = parent.parentId || null;
  const seen = new Set<string>([parent.id]);
  while (cursor && !seen.has(cursor)) {
    if (cursor === centerId) {
      throw new ApiError(400, 'That parent would make the cost-centre hierarchy circular.');
    }
    seen.add(cursor);
    cursor = (await costCenterById(cursor))?.parentId || null;
  }
}

async function assertCostCenterBranchForChildren(
  centerId: string,
  previousBranchId: string | null,
  branchId: string | null
): Promise<void> {
  if (previousBranchId === branchId || !branchId) return;
  const children = getPgConnected()
    ? ((await pgPool.query(COST_CENTER_CHILDREN_SQL, [centerId])).rows as Array<{
        id: string;
        branchId: string | null;
      }>)
    : costCenters.filter((row) => row.parentId === centerId);
  if (children.some((child) => child.branchId !== branchId)) {
    throw new ApiError(
      400,
      'A branch-specific parent must keep every child cost centre in the same branch.'
    );
  }
}

function parseCostCenter(body: Record<string, any>, existing?: CostCenter): CostCenter {
  const id = existing?.id || newId('cc');
  const code = masterCode(body.code ?? existing?.code, 'Cost-centre');
  const name = text(body.name ?? existing?.name, 150);
  if (!name) throw new ApiError(400, 'A cost-centre name is required.');

  const parentIdRaw = Object.prototype.hasOwnProperty.call(body, 'parentId')
    ? body.parentId
    : existing?.parentId;
  const parentId = text(parentIdRaw, 50) || null;
  const branchIdRaw = Object.prototype.hasOwnProperty.call(body, 'branchId')
    ? body.branchId
    : existing?.branchId;
  const branchId = text(branchIdRaw, 50) || null;

  return {
    id,
    code,
    name,
    parentId,
    branchId,
    active: body.active === undefined ? existing?.active ?? true : Boolean(body.active),
    isDemo: existing?.isDemo ?? false,
  };
}

async function assertCostCenterCodeAvailable(center: CostCenter): Promise<void> {
  if (!getPgConnected()) {
    const conflict = costCenters.find(
      (row) => row.code.toLowerCase() === center.code.toLowerCase() && row.id !== center.id
    );
    if (conflict) throw new ApiError(409, `Cost-centre code '${center.code}' is already in use.`);
    return;
  }
  const conflict = (await pgPool.query(COST_CENTER_BY_CODE_SQL, [center.code])).rows[0] as
    | CostCenter
    | undefined;
  if (conflict && conflict.id !== center.id) {
    throw new ApiError(409, `Cost-centre code '${center.code}' is already in use.`);
  }
}

function rememberCostCenter(center: CostCenter): void {
  setCostCenters(
    costCenters.some((row) => row.id === center.id)
      ? costCenters.map((row) => (row.id === center.id ? center : row))
      : [...costCenters, center]
  );
}

/** GET /api/accounting/cost-centers?includeInactive=1 */
export async function get_costCenters(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const allowed = allowedBranchScope(req.user);
  const rows = getPgConnected()
    ? ((await pgPool.query(COST_CENTER_LIST_SQL)).rows as CostCenter[])
    : [...costCenters];
  return res.json(
    rows
      .filter((row) =>
        (includeInactive || row.active) &&
        (!allowed || !row.branchId || allowed.has(row.branchId))
      )
      .sort((a, b) => a.code.localeCompare(b.code))
  );
}

/** POST /api/accounting/cost-centers */
export async function post_costCenter(req: any, res: Response): Promise<any> {
  const center = parseCostCenter(req.body || {});
  assertBranchAllowed(req, center.branchId || null);
  await assertCostCenterCodeAvailable(center);
  if (center.branchId && !(await branchExists(center.branchId))) {
    throw new ApiError(400, `Branch ${center.branchId} does not exist.`);
  }
  await assertCostCenterParent(center.id, center.parentId || null, center.branchId || null);
  if (getPgConnected()) {
    await pgPool.query(COST_CENTER_INSERT_SQL, costCenterInsertParams(center));
  }
  const saved = getPgConnected()
    ? ((await pgPool.query(COST_CENTER_BY_ID_SQL, [center.id])).rows[0] as CostCenter)
    : center;
  rememberCostCenter(saved);
  await logAuditEvent(
    req,
    'CREATE_COST_CENTER',
    'ACCOUNTING',
    `Created cost centre ${center.code} ${center.name}`
  );
  return res.status(201).json(saved);
}

/** PATCH /api/accounting/cost-centers/:id */
export async function patch_costCenter(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A cost-centre id is required.');
  const existing = await costCenterById(id);
  if (!existing) throw new ApiError(404, 'Cost centre not found.');
  const center = parseCostCenter(req.body || {}, existing);
  assertBranchAllowed(req, center.branchId || null);
  await assertCostCenterCodeAvailable(center);
  if (center.branchId && !(await branchExists(center.branchId))) {
    throw new ApiError(400, `Branch ${center.branchId} does not exist.`);
  }
  await assertCostCenterParent(center.id, center.parentId || null, center.branchId || null);
  await assertCostCenterBranchForChildren(existing.id, existing.branchId || null, center.branchId || null);
  if (getPgConnected()) {
    await pgPool.query(COST_CENTER_UPDATE_SQL, costCenterUpdateParams(center, id));
  }
  const saved = getPgConnected()
    ? ((await pgPool.query(COST_CENTER_BY_ID_SQL, [id])).rows[0] as CostCenter)
    : center;
  rememberCostCenter(saved);
  await logAuditEvent(
    req,
    'UPDATE_COST_CENTER',
    'ACCOUNTING',
    `Updated cost centre ${center.code} ${center.name} (${center.active ? 'active' : 'inactive'})`
  );
  return res.json(saved);
}

/** DELETE /api/accounting/cost-centers/:id */
export async function delete_costCenter(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A cost-centre id is required.');
  const existing = await costCenterById(id);
  if (!existing) throw new ApiError(404, 'Cost centre not found.');
  if (getPgConnected()) {
    const used = Number((await pgPool.query(COST_CENTER_USAGE_COUNT_SQL, [id])).rows[0]?.count) || 0;
    if (used > 0) {
      throw new ApiError(
        409,
        `'${existing.name}' is used by ${used} posted line(s) or child centre(s). Retire it instead of deleting it.`
      );
    }
    try {
      await pgPool.query(COST_CENTER_DELETE_SQL, [id]);
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new ApiError(409, 'This cost centre is still in use. Retire it instead of deleting it.');
      }
      throw err;
    }
  }
  setCostCenters(costCenters.filter((row) => row.id !== id));
  await logAuditEvent(
    req,
    'DELETE_COST_CENTER',
    'ACCOUNTING',
    `Deleted cost centre ${existing.code} ${existing.name}`
  );
  return res.json({ deleted: true, id });
}

function parseNarrationTemplate(
  body: Record<string, any>,
  existing?: NarrationTemplate
): NarrationTemplate {
  const code = masterCode(body.code ?? existing?.code, 'Narration');
  const narration = text(body.text ?? existing?.text, 1000);
  if (!narration) throw new ApiError(400, 'Narration text is required.');
  const type = text(body.transactionType ?? existing?.transactionType ?? 'ALL', 40).toUpperCase() as
    | NarrationTransactionType
    | '';
  if (!type || !NARRATION_TYPES.has(type)) {
    throw new ApiError(400, 'Choose a valid narration transaction type.');
  }
  return {
    id: existing?.id || newId('nt'),
    code,
    text: narration,
    transactionType: type,
    active: body.active === undefined ? existing?.active ?? true : Boolean(body.active),
    isDemo: existing?.isDemo ?? false,
  };
}

async function assertNarrationCodeAvailable(template: NarrationTemplate): Promise<void> {
  if (!getPgConnected()) {
    const conflict = narrationTemplates.find(
      (row) => row.code.toLowerCase() === template.code.toLowerCase() && row.id !== template.id
    );
    if (conflict) throw new ApiError(409, `Narration code '${template.code}' is already in use.`);
    return;
  }
  const conflict = (await pgPool.query(NARRATION_TEMPLATE_BY_CODE_SQL, [template.code])).rows[0] as
    | NarrationTemplate
    | undefined;
  if (conflict && conflict.id !== template.id) {
    throw new ApiError(409, `Narration code '${template.code}' is already in use.`);
  }
}

function rememberNarrationTemplate(template: NarrationTemplate): void {
  setNarrationTemplates(
    narrationTemplates.some((row) => row.id === template.id)
      ? narrationTemplates.map((row) => (row.id === template.id ? template : row))
      : [...narrationTemplates, template]
  );
}

/** GET /api/accounting/narrations?includeInactive=1&type=MANUAL_JOURNAL */
export async function get_narrationTemplates(req: any, res: Response): Promise<any> {
  const includeInactive = String(req.query?.includeInactive ?? '1') !== '0';
  const requestedType = text(req.query?.type, 40).toUpperCase();
  const rows = getPgConnected()
    ? ((await pgPool.query(NARRATION_TEMPLATE_LIST_SQL)).rows as NarrationTemplate[])
    : [...narrationTemplates];
  return res.json(
    rows.filter(
      (row) =>
        (includeInactive || row.active) &&
        (!requestedType || row.transactionType === 'ALL' || row.transactionType === requestedType)
    )
  );
}

/** POST /api/accounting/narrations */
export async function post_narrationTemplate(req: any, res: Response): Promise<any> {
  const template = parseNarrationTemplate(req.body || {});
  await assertNarrationCodeAvailable(template);
  if (getPgConnected()) {
    await pgPool.query(NARRATION_TEMPLATE_INSERT_SQL, narrationTemplateInsertParams(template));
  }
  rememberNarrationTemplate(template);
  await logAuditEvent(
    req,
    'CREATE_NARRATION_TEMPLATE',
    'ACCOUNTING',
    `Created narration ${template.code} for ${template.transactionType}`
  );
  return res.status(201).json(template);
}

/** PATCH /api/accounting/narrations/:id */
export async function patch_narrationTemplate(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A narration id is required.');
  const existing = getPgConnected()
    ? (((await pgPool.query(NARRATION_TEMPLATE_BY_ID_SQL, [id])).rows[0] as NarrationTemplate) || null)
    : narrationTemplates.find((row) => row.id === id) || null;
  if (!existing) throw new ApiError(404, 'Narration template not found.');
  const template = parseNarrationTemplate(req.body || {}, existing);
  await assertNarrationCodeAvailable(template);
  if (getPgConnected()) {
    await pgPool.query(NARRATION_TEMPLATE_UPDATE_SQL, narrationTemplateUpdateParams(template, id));
  }
  rememberNarrationTemplate(template);
  await logAuditEvent(
    req,
    'UPDATE_NARRATION_TEMPLATE',
    'ACCOUNTING',
    `Updated narration ${template.code} (${template.active ? 'active' : 'inactive'})`
  );
  return res.json(template);
}

/** DELETE /api/accounting/narrations/:id */
export async function delete_narrationTemplate(req: any, res: Response): Promise<any> {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'A narration id is required.');
  const existing = getPgConnected()
    ? (((await pgPool.query(NARRATION_TEMPLATE_BY_ID_SQL, [id])).rows[0] as NarrationTemplate) || null)
    : narrationTemplates.find((row) => row.id === id) || null;
  if (!existing) throw new ApiError(404, 'Narration template not found.');
  if (getPgConnected()) {
    await pgPool.query(NARRATION_TEMPLATE_DELETE_SQL, [id]);
  }
  setNarrationTemplates(narrationTemplates.filter((row) => row.id !== id));
  await logAuditEvent(
    req,
    'DELETE_NARRATION_TEMPLATE',
    'ACCOUNTING',
    `Deleted narration ${existing.code}`
  );
  return res.json({ deleted: true, id });
}