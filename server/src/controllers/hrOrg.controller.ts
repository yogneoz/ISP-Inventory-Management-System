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
  HR_ORG_KINDS,
  HR_ORG_MASTER_BY_ID_SQL,
  HR_ORG_MASTER_INSERT_SQL,
  HR_ORG_MASTER_LIST_SQL,
  HR_ORG_MASTER_UPDATE_SQL,
  type HrOrgKind,
} from '../models/hrOrg.repo';

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
    await logAuditEvent(
      req,
      'UPDATE_HR_ORG_MASTER',
      'ACCOUNTING',
      `Updated HR ${saved.kind.toLowerCase()} ${saved.code || saved.name} (${saved.isActive ? 'active' : 'inactive'})`
    );
    return res.json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) throw uniqueConflict();
    throw err;
  }
}
