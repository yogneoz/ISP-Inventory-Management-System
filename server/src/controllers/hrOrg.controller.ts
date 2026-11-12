/**
 * People & HR organisation masters: departments, designations and work
 * stations. Reads use the employee-view grant; writes use the employee-manage
 * grant (or the legacy payroll-master grant). The values are suggestions for
 * the employee form, so renaming or retiring one never rewrites payroll history.
 */
import crypto from 'crypto';
import type { Response } from 'express';
import { getPgConnected, pgPool } from '../app';
import { ApiError } from '../errors/ApiError';
import { getUserFromReq } from '../middleware/auth';
import { logAuditEvent } from '../services/audit.service';
import { isUniqueViolation } from '../services/accounting.service';
import {
  HR_BRANCH_PLAN_SQL,
  HR_ORG_CLUSTERS_SQL,
  HR_ORG_DEPARTMENTS_SQL,
  HR_ORG_DESIGNATIONS_SQL,
  HR_DESIGNATION_PROFILE_BY_MASTER_SQL,
  HR_DESIGNATION_PROFILE_UPSERT_SQL,
  HR_ORG_KINDS,
  HR_ORG_MASTER_BY_ID_SQL,
  HR_ORG_MASTER_INSERT_SQL,
  HR_ORG_MASTER_LIST_SQL,
  HR_ORG_MASTER_UPDATE_SQL,
  HR_SALARY_GRADE_BY_CODE_SQL,
  HR_SALARY_GRADES_SQL,
  buildHrOrgChartQuery,
  buildHrOrgHeadcountQuery,
  buildHrOrgUnmatchedQuery,
  type HrOrgKind,
} from '../models/hrOrg.repo';
import { resolveScope } from './payroll.controller';

function requireDb(): void {
  if (!getPgConnected()) throw new ApiError(503, 'PostgreSQL is unavailable.');
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function actorOf(req: any): string | null {
  const user = getUserFromReq(req);
  return user.email || user.name || null;
}

function parseKind(value: unknown): HrOrgKind {
  const kind = text(value, 20).toUpperCase();
  if (!(HR_ORG_KINDS as readonly string[]).includes(kind)) {
    throw new ApiError(400, `kind must be one of: ${HR_ORG_KINDS.join(', ')}.`);
  }
  return kind as HrOrgKind;
}

function parseName(value: unknown): string {
  const name = text(value, 120);
  if (!name) throw new ApiError(400, 'A name is required.');
  return name;
}

function parseCode(value: unknown, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  const code = text(value, 30).toUpperCase();
  if (!code) return null;
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,29}$/.test(code)) {
    throw new ApiError(400, 'Code must be 1–30 letters, digits, dots, dashes, slashes or underscores.');
  }
  return code;
}

function uniqueConflict(): ApiError {
  return new ApiError(409, 'An organisation entry with that name or code already exists.');
}

/** GET /api/hr/org-masters?kind=&activeOnly=1 */
export async function get_hrOrgMasters(req: any, res: Response): Promise<any> {
  requireDb();
  const kind = req.query?.kind ? parseKind(req.query.kind) : null;
  const activeOnly = String(req.query?.activeOnly ?? '') === '1';
  const rows = await pgPool.query(HR_ORG_MASTER_LIST_SQL, [kind, activeOnly]);
  return res.json(rows.rows);
}

/**
 * GET /api/hr/org-masters/headcounts — one grouped read for the tab cards.
 * Counts the employees linked through each catalogue id, under the caller's
 * branch scope (the same scope the employee list uses).
 */
export async function get_hrOrgHeadcounts(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  const counts = { DEPARTMENT: 0, DESIGNATION: 0, WORK_STATION: 0 } as Record<HrOrgKind, number>;
  if (scope.empty) return res.json(counts);

  const options = scope.allowed
    ? { branchScope: [...scope.allowed] }
    : scope.branchId
      ? { branchId: scope.branchId }
      : {};
  const { sql, params } = buildHrOrgHeadcountQuery(options);
  const rows = (await pgPool.query(sql, params)).rows as Array<{ kind: string; count: number }>;
  for (const row of rows) {
    if ((HR_ORG_KINDS as readonly string[]).includes(row.kind)) {
      counts[row.kind as HrOrgKind] = Number(row.count) || 0;
    }
  }
  return res.json(counts);
}

/** Shared scope shape for the employee-reading reports. */
function scopeOptions(scope: any): any {
  return scope.allowed
    ? { branchScope: [...scope.allowed] }
    : scope.branchId
      ? { branchId: scope.branchId }
      : {};
}

/**
 * GET /api/hr/org-catalogue — the refactored master sheet: the graded
 * designations with their reporting lines, the seven departments and their
 * heads, the G1-G10 bands, the four clusters and the 24-branch plan.
 *
 * This is reference data, not employee data: it is the same for every branch,
 * so it is not branch-scoped. Reads use the employee-view grant.
 */
export async function get_hrOrgCatalogue(_req: any, res: Response): Promise<any> {
  requireDb();
  const [designations, departments, grades, clusters, branchPlan] = await Promise.all([
    pgPool.query(HR_ORG_DESIGNATIONS_SQL),
    pgPool.query(HR_ORG_DEPARTMENTS_SQL),
    pgPool.query(HR_SALARY_GRADES_SQL),
    pgPool.query(HR_ORG_CLUSTERS_SQL),
    pgPool.query(HR_BRANCH_PLAN_SQL),
  ]);
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.json({
    designations: designations.rows,
    departments: departments.rows,
    grades: grades.rows,
    clusters: clusters.rows,
    branchPlan: branchPlan.rows,
  });
}

/**
 * GET /api/hr/org-chart — active employees, branch-scoped, each resolved to
 * the catalogue designation they hold. The client draws the tree by joining
 * this to the catalogue's reporting lines, so the chart follows the employee
 * directory for holders and the master sheet for vacancies.
 */
export async function get_hrOrgChart(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);

  const { sql, params } = buildHrOrgChartQuery(scopeOptions(scope));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json((await pgPool.query(sql, params)).rows);
}

/**
 * GET /api/hr/org-masters/unmatched — employees whose stored catalogue text no
 * longer names an entry, so the screen can relink them.
 */
export async function get_hrOrgUnmatched(req: any, res: Response): Promise<any> {
  requireDb();
  const scope = resolveScope(req, res);
  if (!scope) return;
  if (scope.empty) return res.json([]);

  const { sql, params } = buildHrOrgUnmatchedQuery(scopeOptions(scope));
  return res.json((await pgPool.query(sql, params)).rows);
}

/** POST /api/hr/org-masters */
export async function post_hrOrgMaster(req: any, res: Response): Promise<any> {
  requireDb();
  const kind = parseKind(req.body?.kind);
  const name = parseName(req.body?.name);
  const code = parseCode(req.body?.code, null);
  const isActive = typeof req.body?.isActive === 'boolean' ? req.body.isActive : true;
  const id = `hr-org-${crypto.randomUUID()}`;

  try {
    const saved = (
      await pgPool.query(HR_ORG_MASTER_INSERT_SQL, [
        id,
        kind,
        name,
        code,
        isActive,
        actorOf(req),
      ])
    ).rows[0];
    await logAuditEvent(
      req,
      'CREATE_HR_ORG_MASTER',
      'ACCOUNTING',
      `Created HR ${kind.toLowerCase()} ${saved.code || saved.name}`
    );
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueConflict();
    throw err;
  }
}

/** PATCH /api/hr/org-masters/:id */
export async function patch_hrOrgMaster(req: any, res: Response): Promise<any> {
  requireDb();
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An organisation-master id is required.');

  const existing = (await pgPool.query(HR_ORG_MASTER_BY_ID_SQL, [id])).rows[0];
  if (!existing) throw new ApiError(404, 'Organisation entry not found.');
  if (req.body?.kind !== undefined && parseKind(req.body.kind) !== existing.kind) {
    throw new ApiError(400, 'The organisation kind cannot be changed.');
  }

  const name = req.body?.name === undefined ? existing.name : parseName(req.body.name);
  const code = parseCode(req.body?.code, existing.code);
  const isActive =
    typeof req.body?.isActive === 'boolean' ? req.body.isActive : Boolean(existing.isActive);

  try {
    const saved = (
      await pgPool.query(HR_ORG_MASTER_UPDATE_SQL, [
        id,
        name,
        code,
        isActive,
        actorOf(req),
      ])
    ).rows[0];
    // Grade, reporting line and branch scope live on the designation profile.
    // They are written in the same request as the catalogue row so one save
    // cannot leave a role with a code but no place on the chart.
    const roleKeys = ['grade', 'reportsToId', 'reportsToLabel', 'dottedLineTo', 'branchScope'];
    const wantsRoleUpdate =
      existing.kind === 'DESIGNATION' && roleKeys.some((key) => req.body?.[key] !== undefined);
    if (existing.kind !== 'DESIGNATION' && roleKeys.some((key) => req.body?.[key] !== undefined)) {
      throw new ApiError(400, 'Grade, reporting line and branch scope apply to designations only.');
    }

    let profile: any = null;
    if (wantsRoleUpdate) {
      const current = (
        await pgPool.query(HR_DESIGNATION_PROFILE_BY_MASTER_SQL, [id])
      ).rows[0];

      let grade: string | null = current?.grade ?? null;
      if (req.body?.grade !== undefined) {
        const raw = text(req.body.grade, 5).toUpperCase();
        if (!raw) {
          grade = null;
        } else {
          const known = (await pgPool.query(HR_SALARY_GRADE_BY_CODE_SQL, [raw])).rows[0];
          if (!known) throw new ApiError(400, `Grade ${raw} is not in the grading matrix.`);
          grade = known.grade;
        }
      }

      let reportsToId: string | null = current?.reportsToId ?? null;
      if (req.body?.reportsToId !== undefined) {
        const raw = text(req.body.reportsToId, 50);
        if (!raw) {
          reportsToId = null;
        } else {
          if (raw === id) throw new ApiError(400, 'A designation cannot report to itself.');
          const target = text(raw, 50);
          const targetRow = (await pgPool.query(HR_ORG_MASTER_BY_ID_SQL, [target])).rows[0];
          if (!targetRow || targetRow.kind !== 'DESIGNATION' || !targetRow.isActive) {
            throw new ApiError(400, 'The reporting line must point at an active designation.');
          }
          // Walk the target's chain to refuse a cycle (A -> B -> A would drop
          // both posts off the chart).
          let cursor: string | null = target;
          for (let depth = 0; cursor && depth < 60; depth += 1) {
            if (cursor === id) throw new ApiError(400, 'That reporting line would create a loop.');
            const parentRow: any = (
              await pgPool.query(HR_DESIGNATION_PROFILE_BY_MASTER_SQL, [cursor])
            ).rows[0];
            cursor = parentRow?.reportsToId ?? null;
          }
          reportsToId = target;
        }
      }

      const reportsToLabel =
        req.body?.reportsToLabel === undefined
          ? current?.reportsToLabel ?? null
          : text(req.body.reportsToLabel, 120) || null;
      const dottedLineTo =
        req.body?.dottedLineTo === undefined
          ? current?.dottedLineTo ?? null
          : text(req.body.dottedLineTo, 120) || null;
      const branchScope =
        req.body?.branchScope === undefined
          ? current?.branchScope ?? null
          : text(req.body.branchScope, 80) || null;

      profile = (
        await pgPool.query(HR_DESIGNATION_PROFILE_UPSERT_SQL, [
          id,
          grade,
          reportsToId,
          reportsToLabel,
          dottedLineTo,
          branchScope,
        ])
      ).rows[0];
    }

    await logAuditEvent(
      req,
      'UPDATE_HR_ORG_MASTER',
      'ACCOUNTING',
      wantsRoleUpdate
        ? `Updated HR designation ${saved.code || saved.name}: grade ${profile?.grade || 'none'}, reports to ${profile?.reportsToId || profile?.reportsToLabel || 'none'}, scope ${profile?.branchScope || 'none'}`
        : `Updated HR ${saved.kind.toLowerCase()} ${saved.code || saved.name} (${saved.isActive ? 'active' : 'inactive'})`
    );
    return res.json(profile ? { ...saved, profile } : saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueConflict();
    throw err;
  }
}
