/**
 * Phase 4 onboarding/offboarding checklists.
 *
 * A checklist is branch custody derived from its employee. Items inherit the
 * header and never accept a branch claim. OFFBOARDING checklists surface every
 * fixed asset currently assigned to the employee and, when linked, the user
 * account; completing those items returns the asset and deactivates/activates
 * the account in the same transaction. The header follows DRAFT → OPEN →
 * COMPLETED, and completion is irreversible.
 */
import crypto from 'crypto';
import { businessDateAD } from '../../../shared/businessDate';
import type { Response } from 'express';
import { rememberSessionVersion } from '../state/sessionVersion';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  setUsers,
  userPermissionOverrides,
  userPermissionSetGrants,
  users,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { readEmployeeStockCustody } from '../models/employeeStock.repo';
import { isAccountingDate, isUniqueViolation } from '../services/accounting.service';
import { collectCpeFixedAsset } from '../services/cpeAssetLifecycle.service';
import { resolveBsDateForLedger } from '../utils/bsDate';
import {
  HR_LIFECYCLE_ACCOUNT_LOCK_SQL,
  HR_LIFECYCLE_ACCOUNT_STATUS_SQL,
  HR_LIFECYCLE_ACTIVE_BY_EMPLOYEE_SQL,
  HR_LIFECYCLE_ASSET_LOCK_SQL,
  HR_LIFECYCLE_ASSIGNED_ASSETS_SQL,
  HR_LIFECYCLE_AVAILABLE_ASSETS_SQL,
  HR_LIFECYCLE_BY_ID_SQL,
  HR_LIFECYCLE_CATEGORIES,
  HR_LIFECYCLE_COMPLETE_SQL,
  HR_LIFECYCLE_EMPLOYEE_SQL,
  HR_LIFECYCLE_INSERT_SQL,
  HR_LIFECYCLE_ISSUE_ASSET_SQL,
  HR_LIFECYCLE_ITEM_BY_ID_SQL,
  HR_LIFECYCLE_ITEM_COMPLETE_SQL,
  HR_LIFECYCLE_ITEM_INSERT_SQL,
  HR_LIFECYCLE_ITEM_LOCK_SQL,
  HR_LIFECYCLE_ITEMS_SQL,
  HR_LIFECYCLE_LIST_SQL,
  HR_LIFECYCLE_LOCK_SQL,
  HR_LIFECYCLE_NEXT_ORDER_SQL,
  HR_LIFECYCLE_PENDING_REQUIRED_SQL,
  HR_LIFECYCLE_STATUSES,
  HR_LIFECYCLE_TYPES,
  HR_LIFECYCLE_UPDATE_SQL,
  type HrLifecycleAction,
  type HrLifecycleCategory,
  type HrLifecycleStatus,
  type HrLifecycleType,
} from '../models/hrLifecycle.repo';

const FILTERS = new Set(['branchId', 'type', 'status', 'employeeId']);

interface LifecycleScope {
  branchId: string | null;
  branchIds: string[] | null;
}

interface DefaultItem {
  category: HrLifecycleCategory;
  title: string;
  description: string | null;
  required: boolean;
  action: HrLifecycleAction;
  assetId: string | null;
}

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function requireManage(req: any): void {
  const user = req.user || getUserFromReq(req);
  const allowed =
    effectivePermission(
      user,
      'hr-employee-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    ) ||
    effectivePermission(
      user,
      'gl-payroll-manage',
      permissionMatrix,
      userPermissionOverrides,
      userPermissionSetGrants
    );
  if (!allowed) {
    throw new ApiError(403, 'Lifecycle changes require the HR manage permission.');
  }
}

function privateNoStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function parseType(value: unknown): HrLifecycleType {
  const type = text(value, 20).toUpperCase();
  if (!(HR_LIFECYCLE_TYPES as readonly string[]).includes(type)) {
    throw new ApiError(400, `Checklist type must be one of: ${HR_LIFECYCLE_TYPES.join(', ')}.`);
  }
  return type as HrLifecycleType;
}

function parseStatus(value: unknown): HrLifecycleStatus {
  const status = text(value, 20).toUpperCase();
  if (!(HR_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `Checklist status must be one of: ${HR_LIFECYCLE_STATUSES.join(', ')}.`);
  }
  return status as HrLifecycleStatus;
}

function parseCategory(value: unknown): HrLifecycleCategory {
  const category = text(value, 20).toUpperCase();
  if (!(HR_LIFECYCLE_CATEGORIES as readonly string[]).includes(category)) {
    throw new ApiError(400, `Checklist item category must be one of: ${HR_LIFECYCLE_CATEGORIES.join(', ')}.`);
  }
  return category as HrLifecycleCategory;
}

function readFilters(req: any): Record<string, string | null> {
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    if (!FILTERS.has(key)) {
      throw new ApiError(403, `Unknown lifecycle filter "${key}" is not allowed.`);
    }
  }
  for (const key of FILTERS) {
    const value = query[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ApiError(403, `Repeated or structured lifecycle filter "${key}" is not allowed.`);
    }
  }
  if (query.branchId === 'ALL') {
    throw new ApiError(403, 'Forbidden: lifecycle does not widen to all branches by name.');
  }
  const filters: Record<string, string | null> = {};
  for (const key of FILTERS) {
    filters[key] = query[key] === undefined ? null : text(query[key], 60);
  }
  return filters;
}

function readScope(req: any, requestedBranch: string | null): LifecycleScope {
  const user = getUserFromReq(req);
  if (!user || !user.id) throw new ApiError(401, 'Unauthorized: Authentication required');

  const allowed = allowedBranchScope(user);
  if (allowed === null) {
    return {
      branchId: requestedBranch,
      branchIds: requestedBranch ? [requestedBranch] : null,
    };
  }
  if (allowed.size === 0) return { branchId: null, branchIds: [] };
  if (requestedBranch && !allowed.has(requestedBranch)) {
    throw new ApiError(403, 'Forbidden: this account is not authorized for the requested branch.');
  }
  if (requestedBranch) return { branchId: requestedBranch, branchIds: [requestedBranch] };
  if (allowed.size === 1) {
    const only = [...allowed][0];
    return { branchId: only, branchIds: [only] };
  }
  return { branchId: null, branchIds: [...allowed] };
}

function assertBranch(req: any, branchId: string): void {
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this record belongs to another branch.');
  }
}

function hasNonEmployeeAssetCustody(asset: any): boolean {
  const status = String(asset.status || '').toUpperCase();
  return (
    status === 'ASSIGNED_TO_CUSTOMER' ||
    status === 'ASSIGNED_TO_LOCATION' ||
    Boolean(asset.assignedCustomerId) ||
    Boolean(asset.assignedLocationId) ||
    Boolean(asset.assignedType && asset.assignedType !== 'EMPLOYEE')
  );
}

function referenceNo(type: HrLifecycleType): string {
  return `${type === 'ONBOARDING' ? 'ONB' : 'OFF'}-${businessDateAD().slice(0, 4)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function findChecklist(id: string): Promise<any | null> {
  return (await pgPool.query(HR_LIFECYCLE_BY_ID_SQL, [id])).rows[0] || null;
}

async function findEmployee(id: string): Promise<any | null> {
  return (await pgPool.query(HR_LIFECYCLE_EMPLOYEE_SQL, [id])).rows[0] || null;
}

async function buildDetail(id: string): Promise<any> {
  const checklist = await findChecklist(id);
  if (!checklist) throw new ApiError(404, 'Lifecycle checklist not found.');
  const items = (await pgPool.query(HR_LIFECYCLE_ITEMS_SQL, [id])).rows;
  let availableAssets: any[] = [];
  if (checklist.status !== 'COMPLETED') {
    const used = new Set(items.map((item: any) => item.assetId).filter(Boolean));
    const rows =
      checklist.checklistType === 'ONBOARDING'
        ? (await pgPool.query(HR_LIFECYCLE_AVAILABLE_ASSETS_SQL, [String(checklist.branchId)])).rows
        : (await pgPool.query(HR_LIFECYCLE_ASSIGNED_ASSETS_SQL, [String(checklist.employeeId)])).rows;
    availableAssets = rows.filter((asset: any) => !used.has(asset.id));
  }
  // Custody is derived from the live holdings on every read: an offboarding
  // checklist cannot cache a "returned" answer the ledger does not support.
  const custody =
    checklist.checklistType === 'OFFBOARDING'
      ? await readEmployeeStockCustody(String(checklist.employeeId))
      : null;
  return {
    ...checklist,
    custody,
    account: checklist.userId
      ? {
          userId: checklist.userId,
          email: checklist.accountEmail,
          name: checklist.accountName,
          status: checklist.accountStatus,
          role: checklist.accountRole,
        }
      : null,
    items,
    availableAssets,
  };
}

function defaultItems(
  type: HrLifecycleType,
  employee: any,
  assignedAssets: any[]
): DefaultItem[] {
  const items: DefaultItem[] = [];
  if (type === 'ONBOARDING') {
    items.push({
      category: 'DOCUMENT',
      title: 'Signed offer and onboarding documents',
      description: 'Collect the signed offer, identification, PAN and bank details.',
      required: true,
      action: 'NONE',
      assetId: null,
    });
    items.push({
      category: 'ACCESS',
      title: 'Workspace, email and system access prepared',
      description: 'Prepare the desk, internal email and the systems the role needs.',
      required: true,
      action: 'NONE',
      assetId: null,
    });
    if (employee.userId) {
      items.push({
        category: 'ACCOUNT',
        title: 'Activate linked user account',
        description: `Set the linked sign-in account ${employee.accountEmail || employee.userId} to active.`,
        required: true,
        action: 'ACTIVATE_ACCOUNT',
        assetId: null,
      });
    }
    return items;
  }

  items.push({
    category: 'OTHER',
    title: 'Exit interview and knowledge transfer',
    description: 'Complete the exit conversation, handover notes and team knowledge transfer.',
    required: true,
    action: 'NONE',
    assetId: null,
  });
  items.push({
    category: 'OTHER',
    title: 'Final settlement and clearance',
    description: 'Confirm final pay, deductions and department clearance before the exit date.',
    required: true,
    action: 'NONE',
    assetId: null,
  });
  for (const asset of assignedAssets) {
    items.push({
      category: 'ASSET',
      title: `Return ${asset.tagNumber} — ${asset.name}`,
      description: 'Return this assigned fixed asset and reconcile its custody record.',
      required: true,
      action: 'RETURN_ASSET',
      assetId: String(asset.id),
    });
  }
  if (employee.userId) {
    items.push({
      category: 'ACCOUNT',
      title: 'Deactivate linked user account',
      description: `Set the linked sign-in account ${employee.accountEmail || employee.userId} to inactive.`,
      required: true,
      action: 'DEACTIVATE_ACCOUNT',
      assetId: null,
    });
  }
  return items;
}

async function insertDefaultItems(
  client: any,
  checklistId: string,
  type: HrLifecycleType,
  employee: any,
  assignedAssets: any[]
): Promise<void> {
  let order = 10;
  for (const item of defaultItems(type, employee, assignedAssets)) {
    await client.query(HR_LIFECYCLE_ITEM_INSERT_SQL, [
      `hr-life-item-${crypto.randomUUID()}`,
      checklistId,
      item.category,
      item.title,
      item.description,
      item.required,
      item.action,
      item.assetId,
      order,
    ]);
    order += 10;
  }
}

/** GET /api/hr/lifecycle-checklists?branchId=&type=&status=&employeeId= */
export async function get_hrLifecycleChecklists(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req);
  const type = filters.type ? parseType(filters.type) : null;
  const status = filters.status ? parseStatus(filters.status) : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_LIFECYCLE_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      type,
      status,
      filters.employeeId,
    ])
  ).rows;
  return res.json(rows);
}

/** GET /api/hr/lifecycle-checklists/:id */
export async function get_hrLifecycleChecklist(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A checklist id is required.');
  const existing = await findChecklist(id);
  if (!existing) throw new ApiError(404, 'Lifecycle checklist not found.');
  assertBranch(req, String(existing.branchId));
  return res.json(await buildDetail(id));
}

/** POST /api/hr/lifecycle-checklists */
export async function post_hrLifecycleChecklist(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await findEmployee(employeeId);
  if (!employee) throw new ApiError(400, 'The selected employee does not exist.');
  const branchId = String(employee.branchId);
  assertBranch(req, branchId);
  const type = parseType(req.body?.type);
  const effectiveDateAD = parseDate(req.body?.effectiveDateAD, 'Effective date');
  const duplicate = (await pgPool.query(HR_LIFECYCLE_ACTIVE_BY_EMPLOYEE_SQL, [employeeId, type])).rows[0];
  if (duplicate) {
    throw new ApiError(409, `An active ${type.toLowerCase()} checklist already exists for this employee.`);
  }

  const assignedAssets =
    type === 'OFFBOARDING'
      ? (await pgPool.query(HR_LIFECYCLE_ASSIGNED_ASSETS_SQL, [employeeId])).rows
      : [];
  const foreignAsset = assignedAssets.find((asset: any) => String(asset.branchId) !== branchId);
  if (foreignAsset) {
    throw new ApiError(
      409,
      `Assigned asset ${foreignAsset.tagNumber} belongs to another branch; reconcile it before starting offboarding.`
    );
  }

  const id = `hr-lifecycle-${crypto.randomUUID()}`;
  try {
    await withTransaction(async (client) => {
      const effectiveDateBS = await resolveBsDateForLedger(effectiveDateAD, client);
      await client.query(HR_LIFECYCLE_INSERT_SQL, [
        id,
        referenceNo(type),
        employeeId,
        branchId,
        type,
        'DRAFT',
        effectiveDateAD,
        effectiveDateBS,
        optionalText(req.body?.notes, 2000),
        actorOf(req),
      ]);
      await insertDefaultItems(client, id, type, employee, assignedAssets);
      await logAuditEvent(
        req,
        'CREATE_HR_LIFECYCLE_CHECKLIST',
        'ACCOUNTING',
        `Created ${type.toLowerCase()} checklist for ${employee.employeeCode} ${employee.name}`,
        branchId,
        client
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, `An active ${type.toLowerCase()} checklist already exists for this employee.`);
    }
    throw err;
  }
  return res.status(201).json(await buildDetail(id));
}

/** PATCH /api/hr/lifecycle-checklists/:id */
export async function patch_hrLifecycleChecklist(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A checklist id is required.');
  const existing = await findChecklist(id);
  if (!existing) throw new ApiError(404, 'Lifecycle checklist not found.');
  assertBranch(req, String(existing.branchId));
  if (existing.status === 'COMPLETED') {
    throw new ApiError(409, 'This checklist is completed and is locked against changes.');
  }
  if (
    req.body?.employeeId !== undefined &&
    text(req.body.employeeId, 50) !== existing.employeeId
  ) {
    throw new ApiError(400, 'A checklist cannot be moved to another employee.');
  }
  if (req.body?.type !== undefined && parseType(req.body.type) !== existing.checklistType) {
    throw new ApiError(400, 'A checklist cannot change type.');
  }
  if (req.body?.branchId !== undefined && text(req.body.branchId, 50) !== existing.branchId) {
    throw new ApiError(400, 'A checklist cannot be moved to another branch.');
  }

  const nextStatus =
    req.body?.status === undefined ? existing.status : parseStatus(req.body.status);
  if (nextStatus === 'COMPLETED') {
    throw new ApiError(400, 'Use the complete action to complete a checklist.');
  }
  if (existing.status === 'OPEN' && nextStatus === 'DRAFT') {
    throw new ApiError(409, 'An open checklist cannot return to draft.');
  }
  const effectiveDateAD =
    req.body?.effectiveDateAD === undefined
      ? existing.effectiveDateAD
      : parseDate(req.body.effectiveDateAD, 'Effective date');
  const notes =
    req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 2000);

  const saved = await withTransaction(async (client) => {
    const effectiveDateBS = await resolveBsDateForLedger(effectiveDateAD, client);
    const updated = await client.query(HR_LIFECYCLE_UPDATE_SQL, [
      id,
      nextStatus,
      effectiveDateAD,
      effectiveDateBS,
      notes,
      actorOf(req),
    ]);
    if (updated.rowCount === 0) {
      throw new ApiError(409, 'This checklist is completed and is locked against changes.');
    }
    await logAuditEvent(
      req,
      'UPDATE_HR_LIFECYCLE_CHECKLIST',
      'ACCOUNTING',
      `Updated ${existing.checklistType.toLowerCase()} checklist ${existing.checklistNo} (${nextStatus})`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_LIFECYCLE_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** POST /api/hr/lifecycle-checklists/:id/complete */
export async function post_hrLifecycleComplete(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A checklist id is required.');

  const saved = await withTransaction(async (client) => {
    const header = (await client.query(HR_LIFECYCLE_LOCK_SQL, [id])).rows[0];
    if (!header) throw new ApiError(404, 'Lifecycle checklist not found.');
    assertBranch(req, String(header.branchId));
    if (header.status === 'COMPLETED') {
      throw new ApiError(409, 'This checklist is already completed.');
    }
    if (header.status !== 'OPEN') {
      throw new ApiError(409, 'Open the checklist before completing it.');
    }
    const pending = Number(
      (await client.query(HR_LIFECYCLE_PENDING_REQUIRED_SQL, [id])).rows[0]?.count || 0
    );
    if (pending > 0) {
      throw new ApiError(
        409,
        `${pending} required item${pending === 1 ? ' is' : 's are'} still pending.`
      );
    }
    // Completion is the authority on custody: this read runs in the same
    // transaction as the completion write and locks the holding rows, so a
    // concurrent return either lands before it (completion sees zero) or waits.
    // Nothing is written when it refuses — the throw rolls the whole
    // transaction back.
    if (header.checklistType === 'OFFBOARDING') {
      const custody = await readEmployeeStockCustody(String(header.employeeId), {
        client,
        forUpdate: true,
      });
      if (custody.units > 0) {
        throw new ApiError(
          409,
          `${custody.units} unit${custody.units === 1 ? '' : 's'} across ${custody.items} ` +
            `product${custody.items === 1 ? '' : 's'} ${custody.units === 1 ? 'is' : 'are'} still issued to this ` +
            'employee. Return the equipment from My Stock (or the employee profile) before completing offboarding.',
          { code: 'EMPLOYEE_STOCK_HELD' }
        );
      }
    }
    const updated = await client.query(HR_LIFECYCLE_COMPLETE_SQL, [id, actorOf(req)]);
    if (updated.rowCount === 0) {
      throw new ApiError(409, 'This checklist is no longer open for completion.');
    }
    await logAuditEvent(
      req,
      'COMPLETE_HR_LIFECYCLE_CHECKLIST',
      'ACCOUNTING',
      `Completed ${header.checklistType.toLowerCase()} checklist ${header.checklistNo}`,
      String(header.branchId),
      client
    );
    return (await client.query(HR_LIFECYCLE_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** POST /api/hr/lifecycle-checklists/:id/items */
export async function post_hrLifecycleItem(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A checklist id is required.');
  const category = parseCategory(req.body?.category);
  if (category === 'ACCOUNT') {
    throw new ApiError(400, 'Account items are generated from the employee\'s linked user account.');
  }
  const title = text(req.body?.title, 200);
  if (!title) throw new ApiError(400, 'An item title is required.');
  const required = typeof req.body?.required === 'boolean' ? req.body.required : true;
  const assetId = text(req.body?.assetId, 60);
  if (category === 'ASSET' && !assetId) {
    throw new ApiError(400, 'Choose a fixed asset for an asset item.');
  }
  if (category !== 'ASSET' && assetId) {
    throw new ApiError(400, 'Only an asset item may name a fixed asset.');
  }

  const existing = await findChecklist(id);
  if (!existing) throw new ApiError(404, 'Lifecycle checklist not found.');
  assertBranch(req, String(existing.branchId));
  if (existing.status === 'COMPLETED') {
    throw new ApiError(409, 'This checklist is completed and is locked against changes.');
  }

  try {
    const saved = await withTransaction(async (client) => {
      const header = (await client.query(HR_LIFECYCLE_LOCK_SQL, [id])).rows[0];
      if (!header) throw new ApiError(404, 'Lifecycle checklist not found.');
      if (header.status === 'COMPLETED') {
        throw new ApiError(409, 'This checklist is completed and is locked against changes.');
      }
      let action: HrLifecycleAction = 'NONE';
      if (category === 'ASSET') {
        const asset = (await client.query(HR_LIFECYCLE_ASSET_LOCK_SQL, [assetId])).rows[0];
        if (!asset) throw new ApiError(400, 'The selected fixed asset does not exist.');
        if (String(asset.branchId) !== String(header.branchId)) {
          throw new ApiError(409, 'The selected asset belongs to another branch.');
        }
        if (hasNonEmployeeAssetCustody(asset)) {
          throw new ApiError(409, 'The selected asset is assigned to a customer or location.');
        }
        if (header.checklistType === 'ONBOARDING') {
          if (asset.assignedEmployeeId && String(asset.assignedEmployeeId) !== String(header.employeeId)) {
            throw new ApiError(409, 'The selected asset is already assigned to another employee.');
          }
          if (!asset.assignedEmployeeId && asset.status !== 'ACTIVE') {
            throw new ApiError(409, 'Only an active, unassigned asset can be issued.');
          }
          action = 'ISSUE_ASSET';
        } else {
          if (String(asset.assignedEmployeeId || '') !== String(header.employeeId)) {
            throw new ApiError(409, 'The selected asset is not assigned to this employee.');
          }
          action = 'RETURN_ASSET';
        }
      }
      const nextOrder = Number(
        (await client.query(HR_LIFECYCLE_NEXT_ORDER_SQL, [id])).rows[0]?.nextOrder || 10
      );
      const itemId = `hr-life-item-${crypto.randomUUID()}`;
      await client.query(HR_LIFECYCLE_ITEM_INSERT_SQL, [
        itemId,
        id,
        category,
        title,
        optionalText(req.body?.description, 1000),
        required,
        action,
        assetId || null,
        nextOrder,
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_LIFECYCLE_ITEM',
        'ACCOUNTING',
        `Added ${category.toLowerCase()} item "${title}" to ${header.checklistNo}`,
        String(header.branchId),
        client
      );
      return (await client.query(HR_LIFECYCLE_ITEM_BY_ID_SQL, [itemId])).rows[0];
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'That asset or account action is already on this checklist.');
    }
    throw err;
  }
}

/** POST /api/hr/lifecycle-checklists/:id/items/:itemId/complete */
export async function post_hrLifecycleItemComplete(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  const itemId = text(req.params?.itemId, 60);
  if (!id || !itemId) throw new ApiError(400, 'A checklist id and item id are required.');

  const item = (await pgPool.query(HR_LIFECYCLE_ITEM_BY_ID_SQL, [itemId])).rows[0];
  if (!item || String(item.checklistId) !== id) {
    throw new ApiError(404, 'Lifecycle checklist item not found.');
  }
  assertBranch(req, String(item.checklistBranchId));
  if (item.checklistStatus === 'COMPLETED') {
    throw new ApiError(409, 'This checklist is completed and is locked against changes.');
  }
  if (item.checklistStatus !== 'OPEN') {
    throw new ApiError(409, 'Open the checklist before completing its items.');
  }
  if (item.status === 'DONE') {
    throw new ApiError(409, 'This checklist item is already complete.');
  }

  let accountChange: { id: string; status: string } | null = null;
  const saved = await withTransaction(async (client) => {
    const header = (await client.query(HR_LIFECYCLE_LOCK_SQL, [id])).rows[0];
    if (!header) throw new ApiError(404, 'Lifecycle checklist not found.');
    if (header.status === 'COMPLETED') {
      throw new ApiError(409, 'This checklist is completed and is locked against changes.');
    }
    if (header.status !== 'OPEN') {
      throw new ApiError(409, 'Open the checklist before completing its items.');
    }
    const lockedItem = (await client.query(HR_LIFECYCLE_ITEM_LOCK_SQL, [itemId])).rows[0];
    if (!lockedItem || lockedItem.status === 'DONE') {
      throw new ApiError(409, 'This checklist item is already complete.');
    }

    let accountEmail: string | null = null;
    if (lockedItem.action === 'ISSUE_ASSET' || lockedItem.action === 'RETURN_ASSET') {
      const asset = (await client.query(HR_LIFECYCLE_ASSET_LOCK_SQL, [lockedItem.assetId])).rows[0];
      if (!asset) throw new ApiError(409, 'The linked fixed asset no longer exists.');
      if (String(asset.branchId) !== String(header.branchId)) {
        throw new ApiError(409, 'The linked asset belongs to another branch.');
      }
      if (hasNonEmployeeAssetCustody(asset)) {
        throw new ApiError(409, 'The linked asset is assigned to a customer or location.');
      }
      if (lockedItem.action === 'ISSUE_ASSET') {
        if (asset.assignedEmployeeId && String(asset.assignedEmployeeId) !== String(header.employeeId)) {
          throw new ApiError(409, 'The linked asset is assigned to another employee.');
        }
        if (!asset.assignedEmployeeId && asset.status !== 'ACTIVE') {
          throw new ApiError(409, 'Only an active, unassigned asset can be issued.');
        }
        const effectiveDateBS =
          header.effectiveDateBS ||
          (await resolveBsDateForLedger(header.effectiveDateAD, client));
        await client.query(HR_LIFECYCLE_ISSUE_ASSET_SQL, [
          asset.id,
          header.employeeId,
          item.employeeName,
          header.effectiveDateAD,
          effectiveDateBS,
          `Issued via lifecycle checklist ${header.checklistNo} on ${header.effectiveDateAD}`,
        ]);
      } else {
        if (String(asset.assignedEmployeeId || '') !== String(header.employeeId)) {
          throw new ApiError(409, 'The linked asset is no longer assigned to this employee.');
        }
        // One return rule for an employee-held asset. The unassign screen and
        // this checklist used to differ: the screen credited branch stock when
        // the unit ever drew it, the checklist never did. Both now go through
        // the collection service, so the same unit returned either way produces
        // the same ledger.
        await collectCpeFixedAsset({
          client,
          assetId: String(asset.id),
          requestNumber: `HR-ASSET-RETURN-${header.checklistNo}`,
          todayAD: header.effectiveDateAD,
          branchId: String(asset.branchId),
          extraNote: `Returned via lifecycle checklist ${header.checklistNo} on ${header.effectiveDateAD}`,
          changeType: 'MANUAL_ADJUSTMENT',
          actor: getUserFromReq(req)?.email || null,
        });
      }
    } else if (
      lockedItem.action === 'ACTIVATE_ACCOUNT' ||
      lockedItem.action === 'DEACTIVATE_ACCOUNT'
    ) {
      const employee = (await client.query(HR_LIFECYCLE_EMPLOYEE_SQL, [header.employeeId])).rows[0];
      if (!employee?.userId) {
        throw new ApiError(409, 'This employee has no linked user account to reconcile.');
      }
      const account = (await client.query(HR_LIFECYCLE_ACCOUNT_LOCK_SQL, [employee.userId])).rows[0];
      if (!account) throw new ApiError(409, 'The linked user account no longer exists.');
      accountEmail = account.email;
      if (lockedItem.action === 'ACTIVATE_ACCOUNT') {
        if (account.status === 'inactive') {
          await client.query(HR_LIFECYCLE_ACCOUNT_STATUS_SQL, [account.id, 'active']);
          accountChange = { id: account.id, status: 'active' };
        } else if (account.status !== 'active') {
          throw new ApiError(409, 'Only an inactive account can be activated from onboarding.');
        }
      } else {
        if (account.role === 'SUPER_ADMIN') {
          throw new ApiError(409, 'Super Admin accounts cannot be deactivated from a lifecycle checklist.');
        }
        const actor = getUserFromReq(req);
        if (actor?.id && String(actor.id) === String(account.id)) {
          throw new ApiError(409, 'You cannot deactivate your own account from a lifecycle checklist.');
        }
        if (account.status !== 'inactive') {
          await client.query(HR_LIFECYCLE_ACCOUNT_STATUS_SQL, [account.id, 'inactive']);
          accountChange = { id: account.id, status: 'inactive' };
        }
      }
    }

    await client.query(HR_LIFECYCLE_ITEM_COMPLETE_SQL, [itemId, actorOf(req)]);
    const actionNote =
      lockedItem.action === 'ISSUE_ASSET'
        ? ' and issued its fixed asset'
        : lockedItem.action === 'RETURN_ASSET'
          ? ' and returned its fixed asset'
          : lockedItem.action === 'ACTIVATE_ACCOUNT'
            ? ` and activated ${accountEmail}`
            : lockedItem.action === 'DEACTIVATE_ACCOUNT'
              ? ` and deactivated ${accountEmail}`
              : '';
    await logAuditEvent(
      req,
      'COMPLETE_HR_LIFECYCLE_ITEM',
      'ACCOUNTING',
      `Completed "${lockedItem.title}" on ${header.checklistNo}${actionNote}`,
      String(header.branchId),
      client
    );
    return (await client.query(HR_LIFECYCLE_ITEM_BY_ID_SQL, [itemId])).rows[0];
  });
  if (accountChange) {
    const changed = users.map((user: any) =>
      String(user.id) === String(accountChange!.id)
        ? { ...user, status: accountChange!.status }
        : user
    );
    setUsers(changed);
    const updated = changed.find((user: any) => String(user.id) === String(accountChange!.id));
    if (updated) await rememberSessionVersion(updated);
  }
  return res.json(saved);
}
