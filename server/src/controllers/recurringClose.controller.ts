/**
 * Recurring journals and close-checklist HTTP surface.
 *
 * Reads share `gl-view`; creating/editing/running a recurring template needs
 * `gl-post` because it can create a journal; checklist writes and the period
 * gate need `gl-close`. A recurring template is branch-owned, so a branch user
 * can only see and run their own templates.
 */
import type { Response } from 'express';
import { pgPool } from '../app';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { ApiError } from '../errors/ApiError';
import { resolveBranchScope } from './accounting.controller';
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  getCloseChecklist,
  getRecurringTemplate,
  listRecurringTemplates,
  previewRecurringTemplate,
  runRecurringTemplate,
  updateCloseChecklistItem,
  updateRecurringTemplate,
} from '../services/recurringClose.service';
import { isUniqueViolation } from '../services/accounting.service';

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

async function inTransaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(fn);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'That recurring template already exists.');
    }
    throw err;
  }
}

function templateId(req: any): string {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'A recurring template id is required.');
  return id;
}

function periodId(req: any): string {
  const id = String(req.params?.id || '').trim();
  if (!id) throw new ApiError(400, 'An accounting period id is required.');
  return id;
}

function assertTemplateBranch(scope: { branchId?: string; allowed?: Set<string> }, branchId: string) {
  if (scope.branchId && scope.branchId !== branchId) {
    throw new ApiError(403, 'Forbidden: this recurring template belongs to another branch.');
  }
  if (scope.allowed && !scope.allowed.has(branchId)) {
    throw new ApiError(403, 'Forbidden: this recurring template belongs to another branch.');
  }
}

/** GET /api/accounting/recurring-templates */
export async function get_recurringTemplates(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);
  return res.json(await listRecurringTemplates(pgPool, scope.branchId));
}

/** GET /api/accounting/recurring-templates/:id */
export async function get_recurringTemplate(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  const template = await getRecurringTemplate(pgPool, templateId(req));
  assertTemplateBranch(scope, template.branchId);
  return res.json(template);
}

/** POST /api/accounting/recurring-templates */
export async function post_recurringTemplate(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res, req.body?.branchId);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  if (!scope.branchId || scope.branchId === 'ALL') {
    throw new ApiError(400, 'Choose a concrete branch for a recurring template.');
  }
  const template = await inTransaction(async (client) => {
    const created = await createRecurringTemplate(
      client,
      { ...(req.body || {}), branchId: scope.branchId },
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'CREATE_RECURRING_JOURNAL_TEMPLATE',
      'ACCOUNTING',
      `Created recurring template ${created.code} ${created.name} (${created.frequency}, next ${created.nextRunDate})`,
      undefined,
      client
    );
    return created;
  });
  return res.status(201).json(template);
}

/** PATCH /api/accounting/recurring-templates/:id */
export async function patch_recurringTemplate(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  const existing = await getRecurringTemplate(pgPool, templateId(req));
  assertTemplateBranch(scope, existing.branchId);
  const template = await inTransaction(async (client) => {
    const updated = await updateRecurringTemplate(
      client,
      templateId(req),
      req.body || {},
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'UPDATE_RECURRING_JOURNAL_TEMPLATE',
      'ACCOUNTING',
      `Updated recurring template ${updated.code} ${updated.name} (${updated.active ? 'active' : 'paused'})`,
      undefined,
      client
    );
    return updated;
  });
  return res.json(template);
}

/** DELETE /api/accounting/recurring-templates/:id */
export async function delete_recurringTemplate(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  const existing = await getRecurringTemplate(pgPool, templateId(req));
  assertTemplateBranch(scope, existing.branchId);
  const result = await inTransaction(async (client) => {
    const removed = await deleteRecurringTemplate(client, templateId(req));
    await logAuditEvent(
      req,
      'DELETE_RECURRING_JOURNAL_TEMPLATE',
      'ACCOUNTING',
      `Deleted recurring template ${existing.code} ${existing.name}`,
      undefined,
      client
    );
    return removed;
  });
  return res.json(result);
}

/** GET /api/accounting/recurring-templates/:id/preview */
export async function get_recurringTemplatePreview(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  const template = await getRecurringTemplate(pgPool, templateId(req));
  assertTemplateBranch(scope, template.branchId);
  return res.json(await previewRecurringTemplate(pgPool, templateId(req), req.query?.date));
}

/** POST /api/accounting/recurring-templates/:id/run */
export async function post_recurringTemplateRun(req: any, res: Response): Promise<any> {
  const scope = resolveBranchScope(req, res);
  if (!scope) return;
  if (scope.empty) throw new ApiError(403, 'Forbidden: no branch is assigned to this account.');
  const existing = await getRecurringTemplate(pgPool, templateId(req));
  assertTemplateBranch(scope, existing.branchId);
  const result = await inTransaction(async (client) => {
    const generated = await runRecurringTemplate(
      client,
      templateId(req),
      req.body?.date,
      actorOf(req)
    );
    await logAuditEvent(
      req,
      generated.status === 'GENERATED'
        ? 'GENERATE_RECURRING_JOURNAL'
        : generated.status === 'SKIPPED'
          ? 'SKIP_RECURRING_JOURNAL'
          : 'REPEAT_RECURRING_JOURNAL_RUN',
      'ACCOUNTING',
      generated.status === 'GENERATED'
        ? `Generated recurring journal for ${existing.code} on ${generated.runDate}`
        : generated.status === 'SKIPPED'
          ? `Skipped recurring journal for ${existing.code} on ${generated.runDate}: ${generated.reason}`
          : `Recurring journal ${existing.code} was already generated for ${generated.runDate}`,
      undefined,
      client
    );
    return generated;
  });
  return res.json(result);
}

/** GET /api/accounting/periods/:id/checklist */
export async function get_periodChecklist(req: any, res: Response): Promise<any> {
  return res.json(await getCloseChecklist(pgPool, periodId(req)));
}

/** PATCH /api/accounting/periods/:id/checklist/:itemId */
export async function patch_periodChecklistItem(req: any, res: Response): Promise<any> {
  const updated = await inTransaction(async (client) => {
    const item = await updateCloseChecklistItem(
      client,
      periodId(req),
      String(req.params?.itemId || '').trim(),
      req.body || {},
      actorOf(req)
    );
    await logAuditEvent(
      req,
      'UPDATE_CLOSE_CHECKLIST_ITEM',
      'ACCOUNTING',
      `Close checklist ${item.taskCode} for period ${periodId(req)} set to ${item.status}`,
      undefined,
      client
    );
    return item;
  });
  return res.json(updated);
}
