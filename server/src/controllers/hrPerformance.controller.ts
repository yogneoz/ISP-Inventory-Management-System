/**
 * Phase 4 performance — appraisal cycles, weighted goals and 360 feedback.
 *
 * A cycle is branch custody. Goals and feedback derive their branch from the
 * cycle, never from the request body; every list is intersected with the
 * caller's session branches. Sign-off is the lock: once a cycle is signed off,
 * the cycle, its goals and its feedback all refuse further writes. Reads use
 * the employee-view grant and writes use the employee-manage grant, with the
 * legacy payroll-master grant accepted during the HR permission migration.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import {
  getPgConnected,
  permissionMatrix,
  pgPool,
  userPermissionOverrides,
  userPermissionSetGrants,
} from '../app';
import { effectivePermission } from '../services/permissionOverrides.service';
import { withTransaction } from '../db/transactions';
import { logAuditEvent } from '../services/audit.service';
import { getUserFromReq } from '../middleware/auth';
import { allowedBranchScope } from '../middleware/branchScope';
import { ApiError } from '../errors/ApiError';
import { isAccountingDate, isUniqueViolation } from '../services/accounting.service';
import { BRANCH_EXISTS_SQL } from '../models/accounting.repo';
import { resolveBsDateForLedger } from '../utils/bsDate';
import {
  HR_FEEDBACK_INSERT_SQL,
  HR_FEEDBACK_LIST_SQL,
  HR_FEEDBACK_RELATIONSHIPS,
  HR_GOAL_BY_ID_SQL,
  HR_GOAL_INSERT_SQL,
  HR_GOAL_LIST_SQL,
  HR_GOAL_STATUSES,
  HR_GOAL_UPDATE_SQL,
  HR_PERFORMANCE_EMPLOYEE_SQL,
  HR_REVIEW_CYCLE_BY_ID_SQL,
  HR_REVIEW_CYCLE_INSERT_SQL,
  HR_REVIEW_CYCLE_LIST_SQL,
  HR_REVIEW_CYCLE_SIGN_OFF_SQL,
  HR_REVIEW_CYCLE_STATUSES,
  HR_REVIEW_CYCLE_UPDATE_SQL,
  type HrFeedbackRelationship,
  type HrGoalStatus,
  type HrReviewCycleStatus,
} from '../models/hrPerformance.repo';

const CYCLE_FILTERS = new Set(['branchId', 'status']);
const GOAL_FILTERS = new Set(['branchId', 'cycleId', 'employeeId', 'status']);
const FEEDBACK_FILTERS = new Set([
  'branchId',
  'cycleId',
  'employeeId',
  'reviewerEmployeeId',
]);

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
    throw new ApiError(403, 'Performance changes require the HR manage permission.');
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

function parsePeriod(startAD: string, endAD: string): void {
  if (endAD < startAD) throw new ApiError(400, 'The cycle end date cannot be before its start date.');
}

function parseStatus<T extends string>(
  value: unknown,
  statuses: readonly T[],
  label: string
): T {
  const status = text(value, 30).toUpperCase();
  if (!(statuses as readonly string[]).includes(status)) {
    throw new ApiError(400, `${label} must be one of: ${statuses.join(', ')}.`);
  }
  return status as T;
}

function parseCycleStatus(value: unknown, fallback?: HrReviewCycleStatus): HrReviewCycleStatus {
  if (value === undefined && fallback) return fallback;
  const status = parseStatus(value, HR_REVIEW_CYCLE_STATUSES, 'Cycle status');
  if (status === 'SIGNED_OFF') {
    throw new ApiError(400, 'Use the sign-off action to close a cycle.');
  }
  return status;
}

function parseGoalStatus(value: unknown, fallback: HrGoalStatus): HrGoalStatus {
  if (value === undefined) return fallback;
  return parseStatus(value, HR_GOAL_STATUSES, 'Goal status');
}

function parseRelationship(value: unknown): HrFeedbackRelationship {
  return parseStatus(value, HR_FEEDBACK_RELATIONSHIPS, 'Feedback relationship');
}

function parseWeight(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
    throw new ApiError(400, 'Goal weight must be greater than 0 and at most 100.');
  }
  return Math.round(weight * 100) / 100;
}

function parseRating(value: unknown, label: string, fallback?: number | null): number | null {
  if (value === undefined) return fallback === undefined ? null : fallback;
  if (value === null || value === '') return null;
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new ApiError(400, `${label} must be between 1 and 5.`);
  }
  return Math.round(rating * 100) / 100;
}

function parseFeedbackRating(value: unknown): number {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ApiError(400, 'Feedback rating must be a whole number from 1 to 5.');
  }
  return rating;
}

function referenceNo(prefix: string): string {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Reject every unknown or repeated query key, and refuse the literal ALL. */
function readFilters(req: any, allowedKeys: Set<string>): Record<string, string | null> {
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) {
      throw new ApiError(403, `Unknown performance filter "${key}" is not allowed.`);
    }
  }
  for (const key of allowedKeys) {
    const value = query[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ApiError(403, `Repeated or structured performance filter "${key}" is not allowed.`);
    }
  }
  if (query.branchId === 'ALL') {
    throw new ApiError(403, 'Forbidden: performance does not widen to all branches by name.');
  }
  const filters: Record<string, string | null> = {};
  for (const key of allowedKeys) {
    filters[key] = query[key] === undefined ? null : text(query[key], 60);
  }
  return filters;
}

interface PerformanceScope {
  branchId: string | null;
  branchIds: string[] | null;
}

function readScope(req: any, requestedBranch: string | null): PerformanceScope {
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

function goalResponse(row: any): any {
  if (!row) return row;
  const numberOrNull = (value: unknown) =>
    value === null || value === undefined ? null : Number(value);
  return {
    ...row,
    weight: Number(row.weight ?? 0),
    selfRating: numberOrNull(row.selfRating),
    managerRating: numberOrNull(row.managerRating),
    finalRating: numberOrNull(row.finalRating),
  };
}

async function findCycle(id: string): Promise<any | null> {
  return (await pgPool.query(HR_REVIEW_CYCLE_BY_ID_SQL, [id])).rows[0] || null;
}

async function findGoal(id: string): Promise<any | null> {
  return (await pgPool.query(HR_GOAL_BY_ID_SQL, [id])).rows[0] || null;
}

async function findEmployee(id: string): Promise<any | null> {
  return (await pgPool.query(HR_PERFORMANCE_EMPLOYEE_SQL, [id])).rows[0] || null;
}

async function assertBranchExists(branchId: string): Promise<void> {
  const branch = (await pgPool.query(BRANCH_EXISTS_SQL, [branchId])).rows[0];
  if (!branch) throw new ApiError(400, 'The selected branch does not exist.');
}

function assertCycleWritable(cycle: any): void {
  if (cycle.status === 'SIGNED_OFF') {
    throw new ApiError(409, 'This cycle is signed off and is locked against changes.');
  }
}

/** GET /api/hr/performance/cycles?branchId=&status= */
export async function get_hrReviewCycles(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, CYCLE_FILTERS);
  const status = filters.status
    ? parseStatus(filters.status, HR_REVIEW_CYCLE_STATUSES, 'Cycle status')
    : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_REVIEW_CYCLE_LIST_SQL, [scope.branchId, scope.branchIds, status])
  ).rows;
  return res.json(rows);
}

/** POST /api/hr/performance/cycles */
export async function post_hrReviewCycle(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const branchId = text(req.body?.branchId, 50);
  if (!branchId) throw new ApiError(400, 'A branch is required.');
  assertBranch(req, branchId);
  await assertBranchExists(branchId);
  const name = text(req.body?.name, 150);
  if (!name) throw new ApiError(400, 'A cycle name is required.');
  const periodStartAD = parseDate(req.body?.periodStartAD, 'Cycle start date');
  const periodEndAD = parseDate(req.body?.periodEndAD, 'Cycle end date');
  parsePeriod(periodStartAD, periodEndAD);
  const status = parseCycleStatus(req.body?.status, 'DRAFT');
  const id = `hr-cycle-${crypto.randomUUID()}`;
  const cycleNo = referenceNo('CYCLE');

  const saved = await withTransaction(async (client) => {
    const [periodStartBS, periodEndBS] = await Promise.all([
      resolveBsDateForLedger(periodStartAD, client),
      resolveBsDateForLedger(periodEndAD, client),
    ]);
    await client.query(HR_REVIEW_CYCLE_INSERT_SQL, [
      id,
      cycleNo,
      branchId,
      name,
      periodStartAD,
      periodStartBS,
      periodEndAD,
      periodEndBS,
      status,
      optionalText(req.body?.instructions, 2000),
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'CREATE_HR_REVIEW_CYCLE',
      'ACCOUNTING',
      `Created appraisal cycle ${cycleNo} (${status})`,
      branchId,
      client
    );
    return (await client.query(HR_REVIEW_CYCLE_BY_ID_SQL, [id])).rows[0];
  });
  return res.status(201).json(saved);
}

/** PATCH /api/hr/performance/cycles/:id */
export async function patch_hrReviewCycle(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A cycle id is required.');
  const existing = await findCycle(id);
  if (!existing) throw new ApiError(404, 'Review cycle not found.');
  assertBranch(req, String(existing.branchId));
  assertCycleWritable(existing);
  if (req.body?.branchId !== undefined && text(req.body.branchId, 50) !== existing.branchId) {
    throw new ApiError(400, 'A cycle cannot be moved to another branch.');
  }
  const name = req.body?.name === undefined ? existing.name : text(req.body.name, 150);
  if (!name) throw new ApiError(400, 'A cycle name is required.');
  const periodStartAD =
    req.body?.periodStartAD === undefined
      ? existing.periodStartAD
      : parseDate(req.body.periodStartAD, 'Cycle start date');
  const periodEndAD =
    req.body?.periodEndAD === undefined
      ? existing.periodEndAD
      : parseDate(req.body.periodEndAD, 'Cycle end date');
  parsePeriod(periodStartAD, periodEndAD);
  const status = parseCycleStatus(req.body?.status, existing.status);

  const saved = await withTransaction(async (client) => {
    const [periodStartBS, periodEndBS] = await Promise.all([
      resolveBsDateForLedger(periodStartAD, client),
      resolveBsDateForLedger(periodEndAD, client),
    ]);
    const updated = await client.query(HR_REVIEW_CYCLE_UPDATE_SQL, [
      id,
      name,
      periodStartAD,
      periodStartBS,
      periodEndAD,
      periodEndBS,
      status,
      req.body?.instructions === undefined
        ? existing.instructions
        : optionalText(req.body.instructions, 2000),
      actorOf(req),
    ]);
    if (updated.rowCount === 0) {
      throw new ApiError(409, 'This cycle is signed off and is locked against changes.');
    }
    await logAuditEvent(
      req,
      'UPDATE_HR_REVIEW_CYCLE',
      'ACCOUNTING',
      `Updated appraisal cycle ${existing.cycleNo} (${status})`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_REVIEW_CYCLE_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** POST /api/hr/performance/cycles/:id/sign-off */
export async function post_hrReviewCycleSignOff(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A cycle id is required.');
  const existing = await findCycle(id);
  if (!existing) throw new ApiError(404, 'Review cycle not found.');
  assertBranch(req, String(existing.branchId));
  if (existing.status === 'SIGNED_OFF') {
    throw new ApiError(409, 'This cycle is already signed off.');
  }
  if (existing.status !== 'OPEN') {
    throw new ApiError(409, 'Open the cycle before signing it off.');
  }

  const saved = await withTransaction(async (client) => {
    const updated = await client.query(HR_REVIEW_CYCLE_SIGN_OFF_SQL, [id, actorOf(req)]);
    if (updated.rowCount === 0) {
      throw new ApiError(409, 'This cycle is no longer open for sign-off.');
    }
    await logAuditEvent(
      req,
      'SIGN_OFF_HR_REVIEW_CYCLE',
      'ACCOUNTING',
      `Signed off appraisal cycle ${existing.cycleNo}`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_REVIEW_CYCLE_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** GET /api/hr/performance/goals?branchId=&cycleId=&employeeId=&status= */
export async function get_hrGoals(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, GOAL_FILTERS);
  const status = filters.status ? parseGoalStatus(filters.status, 'NOT_STARTED') : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_GOAL_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      filters.cycleId,
      filters.employeeId,
      status,
    ])
  ).rows.map(goalResponse);
  return res.json(rows);
}

/** POST /api/hr/performance/goals */
export async function post_hrGoal(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const cycleId = text(req.body?.cycleId, 60);
  if (!cycleId) throw new ApiError(400, 'A review cycle is required.');
  const cycle = await findCycle(cycleId);
  if (!cycle) throw new ApiError(400, 'The selected review cycle does not exist.');
  assertBranch(req, String(cycle.branchId));
  assertCycleWritable(cycle);
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await findEmployee(employeeId);
  if (!employee) throw new ApiError(400, 'The selected employee does not exist.');
  if (employee.branchId !== cycle.branchId) {
    throw new ApiError(400, 'A goal employee must belong to the cycle branch.');
  }
  const title = text(req.body?.title, 200);
  if (!title) throw new ApiError(400, 'A goal title is required.');
  const id = `hr-goal-${crypto.randomUUID()}`;
  const goalNo = referenceNo('GOAL');

  try {
    const saved = await withTransaction(async (client) => {
      await client.query(HR_GOAL_INSERT_SQL, [
        id,
        goalNo,
        cycleId,
        String(cycle.branchId),
        employeeId,
        title,
        optionalText(req.body?.description, 1000),
        parseWeight(req.body?.weight, 100),
        optionalText(req.body?.targetValue, 200),
        optionalText(req.body?.achievement, 500),
        parseGoalStatus(req.body?.status, 'NOT_STARTED'),
        parseRating(req.body?.selfRating, 'Self rating'),
        parseRating(req.body?.managerRating, 'Manager rating'),
        parseRating(req.body?.finalRating, 'Final rating'),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_GOAL',
        'ACCOUNTING',
        `Added goal ${goalNo} for ${employee.employeeCode} in ${cycle.cycleNo}`,
        String(cycle.branchId),
        client
      );
      return (await client.query(HR_GOAL_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(goalResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This employee already has that goal title in this cycle.');
    }
    throw err;
  }
}

/** PATCH /api/hr/performance/goals/:id */
export async function patch_hrGoal(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A goal id is required.');
  const existing = await findGoal(id);
  if (!existing) throw new ApiError(404, 'Goal not found.');
  assertBranch(req, String(existing.branchId));
  const cycle = await findCycle(String(existing.cycleId));
  if (!cycle) throw new ApiError(404, 'Review cycle not found.');
  assertCycleWritable(cycle);
  if (req.body?.cycleId !== undefined && text(req.body.cycleId, 60) !== existing.cycleId) {
    throw new ApiError(400, 'A goal cannot be moved to another cycle.');
  }
  if (req.body?.employeeId !== undefined && text(req.body.employeeId, 50) !== existing.employeeId) {
    throw new ApiError(400, 'A goal cannot be moved to another employee.');
  }
  const title = req.body?.title === undefined ? existing.title : text(req.body.title, 200);
  if (!title) throw new ApiError(400, 'A goal title is required.');

  try {
    const saved = await withTransaction(async (client) => {
      await client.query(HR_GOAL_UPDATE_SQL, [
        id,
        title,
        req.body?.description === undefined
          ? existing.description
          : optionalText(req.body.description, 1000),
        parseWeight(req.body?.weight, Number(existing.weight)),
        req.body?.targetValue === undefined
          ? existing.targetValue
          : optionalText(req.body.targetValue, 200),
        req.body?.achievement === undefined
          ? existing.achievement
          : optionalText(req.body.achievement, 500),
        parseGoalStatus(req.body?.status, existing.status),
        parseRating(req.body?.selfRating, 'Self rating', existing.selfRating === null ? null : Number(existing.selfRating)),
        parseRating(
          req.body?.managerRating,
          'Manager rating',
          existing.managerRating === null ? null : Number(existing.managerRating)
        ),
        parseRating(
          req.body?.finalRating,
          'Final rating',
          existing.finalRating === null ? null : Number(existing.finalRating)
        ),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'UPDATE_HR_GOAL',
        'ACCOUNTING',
        `Updated goal ${existing.goalNo} for ${existing.employeeCode} (${existing.cycleNo})`,
        String(existing.branchId),
        client
      );
      return (await client.query(HR_GOAL_BY_ID_SQL, [id])).rows[0];
    });
    return res.json(goalResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This employee already has that goal title in this cycle.');
    }
    throw err;
  }
}

/** GET /api/hr/performance/feedback?branchId=&cycleId=&employeeId=&reviewerEmployeeId= */
export async function get_hrPerformanceFeedback(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, FEEDBACK_FILTERS);
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_FEEDBACK_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      filters.cycleId,
      filters.employeeId,
      filters.reviewerEmployeeId,
    ])
  ).rows;
  return res.json(rows);
}

/** POST /api/hr/performance/feedback — immutable once submitted. */
export async function post_hrPerformanceFeedback(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const cycleId = text(req.body?.cycleId, 60);
  if (!cycleId) throw new ApiError(400, 'A review cycle is required.');
  const cycle = await findCycle(cycleId);
  if (!cycle) throw new ApiError(400, 'The selected review cycle does not exist.');
  assertBranch(req, String(cycle.branchId));
  assertCycleWritable(cycle);
  if (cycle.status !== 'OPEN') {
    throw new ApiError(409, 'Open the cycle before collecting 360 feedback.');
  }
  const employeeId = text(req.body?.employeeId, 50);
  if (!employeeId) throw new ApiError(400, 'An employee is required.');
  const employee = await findEmployee(employeeId);
  if (!employee) throw new ApiError(400, 'The selected employee does not exist.');
  if (employee.branchId !== cycle.branchId) {
    throw new ApiError(400, 'A feedback subject must belong to the cycle branch.');
  }
  const reviewerEmployeeId = text(req.body?.reviewerEmployeeId, 50);
  if (!reviewerEmployeeId) throw new ApiError(400, 'A reviewer is required.');
  const reviewer = await findEmployee(reviewerEmployeeId);
  if (!reviewer) throw new ApiError(400, 'The selected reviewer does not exist.');
  if (reviewer.branchId !== cycle.branchId) {
    throw new ApiError(400, 'A feedback reviewer must belong to the cycle branch.');
  }
  const relationship = parseRelationship(req.body?.relationship);
  if (relationship === 'SELF' && reviewerEmployeeId !== employeeId) {
    throw new ApiError(400, 'Self feedback must be written by the subject employee.');
  }
  if (relationship !== 'SELF' && reviewerEmployeeId === employeeId) {
    throw new ApiError(400, 'Only self feedback may use the subject employee as reviewer.');
  }
  const rating = parseFeedbackRating(req.body?.rating);
  const id = `hr-feedback-${crypto.randomUUID()}`;

  try {
    const saved = await withTransaction(async (client) => {
      await client.query(HR_FEEDBACK_INSERT_SQL, [
        id,
        cycleId,
        String(cycle.branchId),
        employeeId,
        reviewerEmployeeId,
        relationship,
        rating,
        optionalText(req.body?.strengths, 1000),
        optionalText(req.body?.improvements, 1000),
        optionalText(req.body?.comments, 2000),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_360_FEEDBACK',
        'ACCOUNTING',
        `Added 360 feedback for ${employee.employeeCode} by ${reviewer.employeeCode} in ${cycle.cycleNo}`,
        String(cycle.branchId),
        client
      );
      return (await client.query(HR_FEEDBACK_LIST_SQL, [String(cycle.branchId), null, cycleId, employeeId, reviewerEmployeeId])).rows[0];
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This reviewer has already submitted feedback for that employee in this cycle.');
    }
    throw err;
  }
}
