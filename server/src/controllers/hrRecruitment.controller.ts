/**
 * Phase 4 recruitment — requisitions, candidates, interviews and offers.
 *
 * Reads use the employee-view grant and writes use the employee-manage grant,
 * with the legacy payroll-master grant accepted on both, matching the rest of
 * People & HR. Every list is intersected with the caller's session branches;
 * a child row's branch is derived from its requisition/candidate, never from
 * the request body. The hire action is the only path that sets a candidate to
 * HIRED and it refuses unless the candidate's offer is ACCEPTED.
 *
 * A resume is stored as bounded bytes in PostgreSQL beside its metadata so the
 * upload and its audit row commit or roll back together. The bytes are never
 * part of a list or detail projection; the content route is the only read.
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
import {
  EMPLOYEE_BY_CODE_SQL,
  EMPLOYEE_INSERT_SQL,
  employeeInsertParams,
} from '../models/payroll.repo';
import { resolveBsDateForLedger } from '../utils/bsDate';
import {
  HR_RECRUITMENT_CANDIDATE_BY_ID_SQL,
  HR_RECRUITMENT_CANDIDATE_HIRE_SQL,
  HR_RECRUITMENT_CANDIDATE_INSERT_SQL,
  HR_RECRUITMENT_CANDIDATE_LIST_SQL,
  HR_RECRUITMENT_CANDIDATE_MARK_INTERVIEW_SQL,
  HR_RECRUITMENT_CANDIDATE_MARK_OFFER_SQL,
  HR_RECRUITMENT_CANDIDATE_STATUSES,
  HR_RECRUITMENT_CANDIDATE_UPDATE_SQL,
  HR_RECRUITMENT_HIRE_CONTEXT_SQL,
  HR_RECRUITMENT_INTERVIEW_BY_ID_SQL,
  HR_RECRUITMENT_INTERVIEW_INSERT_SQL,
  HR_RECRUITMENT_INTERVIEW_LIST_SQL,
  HR_RECRUITMENT_INTERVIEW_MODES,
  HR_RECRUITMENT_INTERVIEW_STATUSES,
  HR_RECRUITMENT_INTERVIEW_UPDATE_SQL,
  HR_RECRUITMENT_OFFER_BY_ID_SQL,
  HR_RECRUITMENT_OFFER_INSERT_SQL,
  HR_RECRUITMENT_OFFER_LIST_SQL,
  HR_RECRUITMENT_OFFER_STATUSES,
  HR_RECRUITMENT_OFFER_UPDATE_SQL,
  HR_RECRUITMENT_REQUISITION_BY_ID_SQL,
  HR_RECRUITMENT_REQUISITION_INSERT_SQL,
  HR_RECRUITMENT_REQUISITION_LIST_SQL,
  HR_RECRUITMENT_REQUISITION_STATUSES,
  HR_RECRUITMENT_REQUISITION_UPDATE_SQL,
  HR_RECRUITMENT_RESUME_ALLOWED_MIME,
  HR_RECRUITMENT_RESUME_CONTENT_SQL,
  HR_RECRUITMENT_RESUME_MAX_BYTES,
  HR_RECRUITMENT_RESUME_UPDATE_SQL,
  type HrRecruitmentCandidateStatus,
  type HrRecruitmentInterviewMode,
  type HrRecruitmentInterviewStatus,
  type HrRecruitmentOfferStatus,
  type HrRecruitmentRequisitionStatus,
} from '../models/hrRecruitment.repo';

const REQUISITION_FILTERS = new Set(['branchId', 'status']);
const CANDIDATE_FILTERS = new Set(['branchId', 'requisitionId', 'status']);
const INTERVIEW_FILTERS = new Set(['branchId', 'candidateId', 'status']);
const OFFER_FILTERS = new Set(['branchId', 'candidateId', 'status']);

const FINAL_OFFER_STATUSES: readonly HrRecruitmentOfferStatus[] = [
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
];

const OFFER_TRANSITIONS: Record<HrRecruitmentOfferStatus, readonly HrRecruitmentOfferStatus[]> = {
  DRAFT: ['DRAFT', 'SENT', 'WITHDRAWN'],
  SENT: ['SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'],
  ACCEPTED: ['ACCEPTED'],
  DECLINED: ['DECLINED'],
  WITHDRAWN: ['WITHDRAWN'],
};

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
    throw new ApiError(403, 'Recruitment changes require the HR manage permission.');
  }
}

function privateNoStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(value: unknown, label: string): string {
  const date = text(value, 10);
  if (!date) throw new ApiError(400, `${label} is required.`);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, `${label} must be a real date in YYYY-MM-DD form.`);
  }
  return date;
}

function optionalDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseDate(value, label);
}

function parseOpenings(value: unknown): number {
  const openings = Number(value);
  if (!Number.isInteger(openings) || openings < 1 || openings > 999) {
    throw new ApiError(400, 'Openings must be a whole number between 1 and 999.');
  }
  return openings;
}

function parseAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
    throw new ApiError(400, 'Monthly salary must be between 0 and 100,000,000.');
  }
  return Math.round(amount * 100) / 100;
}

function parseRating(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ApiError(400, 'Interview rating must be a whole number from 1 to 5.');
  }
  return rating;
}

function parseEmail(value: unknown): string | null {
  const email = optionalText(value, 150);
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'Candidate email must be a valid email address.');
  }
  return email;
}

function normalizeEmployeeCode(value: unknown): string {
  const code = text(value, 50).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._/-]{0,49}$/.test(code)) {
    throw new ApiError(
      400,
      'Employee code must be 1–50 letters, digits, dots, dashes, slashes or underscores.'
    );
  }
  return code;
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

function parseMode(value: unknown): HrRecruitmentInterviewMode {
  const mode = text(value, 20).toUpperCase();
  if (!(HR_RECRUITMENT_INTERVIEW_MODES as readonly string[]).includes(mode)) {
    throw new ApiError(400, `Interview mode must be one of: ${HR_RECRUITMENT_INTERVIEW_MODES.join(', ')}.`);
  }
  return mode as HrRecruitmentInterviewMode;
}

function referenceNo(prefix: string): string {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function sanitizeFileName(value: unknown): string {
  const raw = text(value, 300);
  const base = raw.split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 200);
}

/** Reject every unknown or repeated query key, and refuse the literal ALL. */
function readFilters(req: any, allowedKeys: Set<string>): Record<string, string | null> {
  const query = req.query || {};
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) {
      throw new ApiError(403, `Unknown recruitment filter "${key}" is not allowed.`);
    }
  }
  for (const key of allowedKeys) {
    const value = query[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new ApiError(403, `Repeated or structured recruitment filter "${key}" is not allowed.`);
    }
  }
  if (query.branchId === 'ALL') {
    throw new ApiError(403, 'Forbidden: recruitment does not widen to all branches by name.');
  }
  const filters: Record<string, string | null> = {};
  for (const key of allowedKeys) {
    filters[key] = query[key] === undefined ? null : text(query[key], 60);
  }
  return filters;
}

interface RecruitmentScope {
  branchId: string | null;
  branchIds: string[] | null;
}

function readScope(req: any, requestedBranch: string | null): RecruitmentScope {
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

function candidateResponse(row: any): any {
  if (!row) return row;
  return {
    ...row,
    offerMonthlySalary:
      row.offerMonthlySalary === null || row.offerMonthlySalary === undefined
        ? null
        : Number(row.offerMonthlySalary),
  };
}

function offerResponse(row: any): any {
  if (!row) return row;
  return {
    ...row,
    monthlySalary: Number(row.monthlySalary ?? 0),
  };
}

async function findRequisition(id: string): Promise<any | null> {
  return (await pgPool.query(HR_RECRUITMENT_REQUISITION_BY_ID_SQL, [id])).rows[0] || null;
}

async function findCandidate(id: string): Promise<any | null> {
  return candidateResponse((await pgPool.query(HR_RECRUITMENT_CANDIDATE_BY_ID_SQL, [id])).rows[0] || null);
}

async function findInterview(id: string): Promise<any | null> {
  return (await pgPool.query(HR_RECRUITMENT_INTERVIEW_BY_ID_SQL, [id])).rows[0] || null;
}

async function findOffer(id: string): Promise<any | null> {
  return offerResponse((await pgPool.query(HR_RECRUITMENT_OFFER_BY_ID_SQL, [id])).rows[0] || null);
}

/** GET /api/hr/recruitment/requisitions?branchId=&status= */
export async function get_hrRecruitmentRequisitions(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, REQUISITION_FILTERS);
  const status = filters.status
    ? parseStatus(filters.status, HR_RECRUITMENT_REQUISITION_STATUSES, 'Requisition status')
    : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_RECRUITMENT_REQUISITION_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      status,
    ])
  ).rows;
  return res.json(rows);
}

/** POST /api/hr/recruitment/requisitions */
export async function post_hrRecruitmentRequisition(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const user = getUserFromReq(req);
  const requestedBranch = text(req.body?.branchId, 50);
  const branchId = requestedBranch || (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN' ? '' : user.branchId || '');
  if (!branchId || branchId === 'ALL') {
    throw new ApiError(400, 'A concrete branch is required for a requisition.');
  }
  assertBranch(req, branchId);
  const title = text(req.body?.title, 150);
  if (!title) throw new ApiError(400, 'A requisition title is required.');
  const status = req.body?.status === undefined
    ? 'DRAFT'
    : parseStatus(req.body.status, HR_RECRUITMENT_REQUISITION_STATUSES, 'Requisition status');
  const openedOnAD = req.body?.openedOnAD === undefined
    ? today()
    : optionalDate(req.body.openedOnAD, 'Opened date');
  const closesOnAD = optionalDate(req.body?.closesOnAD, 'Closes date');
  if (openedOnAD && closesOnAD && closesOnAD < openedOnAD) {
    throw new ApiError(400, 'Closes date must be on or after the opened date.');
  }
  const openings = req.body?.openings === undefined ? 1 : parseOpenings(req.body.openings);
  const id = `hr-req-${crypto.randomUUID()}`;
  const requisitionNo = referenceNo('REQ');

  try {
    const saved = await withTransaction(async (client) => {
      if (!(await client.query(BRANCH_EXISTS_SQL, [branchId])).rows[0]) {
        throw new ApiError(400, `Branch ${branchId} does not exist.`);
      }
      const openedOnBS = openedOnAD ? await resolveBsDateForLedger(openedOnAD, client) : null;
      const closesOnBS = closesOnAD ? await resolveBsDateForLedger(closesOnAD, client) : null;
      await client.query(HR_RECRUITMENT_REQUISITION_INSERT_SQL, [
        id,
        requisitionNo,
        branchId,
        title,
        optionalText(req.body?.department, 120),
        optionalText(req.body?.designation, 120),
        optionalText(req.body?.employmentType, 30),
        openings,
        status,
        openedOnAD,
        openedOnBS,
        closesOnAD,
        closesOnBS,
        optionalText(req.body?.description, 2000),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_REQUISITION',
        'ACCOUNTING',
        `Created recruitment requisition ${requisitionNo} for ${title}`,
        branchId,
        client
      );
      return (await client.query(HR_RECRUITMENT_REQUISITION_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(saved);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'A requisition with that number already exists. Try again.');
    }
    throw err;
  }
}

/** PATCH /api/hr/recruitment/requisitions/:id */
export async function patch_hrRecruitmentRequisition(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A requisition id is required.');
  const existing = await findRequisition(id);
  if (!existing) throw new ApiError(404, 'Requisition not found.');
  assertBranch(req, String(existing.branchId));
  if (req.body?.branchId !== undefined && text(req.body.branchId, 50) !== existing.branchId) {
    throw new ApiError(400, 'A requisition cannot be moved to another branch.');
  }

  const title = req.body?.title === undefined ? existing.title : text(req.body.title, 150);
  if (!title) throw new ApiError(400, 'A requisition title is required.');
  const status = req.body?.status === undefined
    ? existing.status
    : parseStatus(req.body.status, HR_RECRUITMENT_REQUISITION_STATUSES, 'Requisition status');
  const openings =
    req.body?.openings === undefined ? Number(existing.openings) : parseOpenings(req.body.openings);
  const openedOnAD = req.body?.openedOnAD === undefined
    ? existing.openedOnAD
    : optionalDate(req.body.openedOnAD, 'Opened date');
  const closesOnAD = req.body?.closesOnAD === undefined
    ? existing.closesOnAD
    : optionalDate(req.body.closesOnAD, 'Closes date');
  if (openedOnAD && closesOnAD && closesOnAD < openedOnAD) {
    throw new ApiError(400, 'Closes date must be on or after the opened date.');
  }

  const saved = await withTransaction(async (client) => {
    const openedOnBS = openedOnAD ? await resolveBsDateForLedger(openedOnAD, client) : null;
    const closesOnBS = closesOnAD ? await resolveBsDateForLedger(closesOnAD, client) : null;
    await client.query(HR_RECRUITMENT_REQUISITION_UPDATE_SQL, [
      id,
      title,
      req.body?.department === undefined ? existing.department : optionalText(req.body.department, 120),
      req.body?.designation === undefined
        ? existing.designation
        : optionalText(req.body.designation, 120),
      req.body?.employmentType === undefined
        ? existing.employmentType
        : optionalText(req.body.employmentType, 30),
      openings,
      status,
      openedOnAD,
      openedOnBS,
      closesOnAD,
      closesOnBS,
      req.body?.description === undefined
        ? existing.description
        : optionalText(req.body.description, 2000),
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'UPDATE_HR_REQUISITION',
      'ACCOUNTING',
      `Updated recruitment requisition ${existing.requisitionNo} (${status})`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_RECRUITMENT_REQUISITION_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** GET /api/hr/recruitment/candidates?branchId=&requisitionId=&status= */
export async function get_hrRecruitmentCandidates(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, CANDIDATE_FILTERS);
  const status = filters.status
    ? parseStatus(filters.status, HR_RECRUITMENT_CANDIDATE_STATUSES, 'Candidate status')
    : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_RECRUITMENT_CANDIDATE_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      filters.requisitionId,
      status,
    ])
  ).rows.map(candidateResponse);
  return res.json(rows);
}

/** POST /api/hr/recruitment/candidates */
export async function post_hrRecruitmentCandidate(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const requisitionId = text(req.body?.requisitionId, 60);
  if (!requisitionId) throw new ApiError(400, 'A requisition is required.');
  const requisition = await findRequisition(requisitionId);
  if (!requisition) throw new ApiError(400, 'The selected requisition does not exist.');
  assertBranch(req, String(requisition.branchId));
  if (requisition.status === 'CLOSED') {
    throw new ApiError(409, 'A closed requisition cannot accept new candidates.');
  }
  if (requisition.status === 'DRAFT') {
    throw new ApiError(409, 'Open the requisition before adding candidates.');
  }
  const name = text(req.body?.name, 200);
  if (!name) throw new ApiError(400, 'A candidate name is required.');
  const email = parseEmail(req.body?.email);
  const id = `hr-cand-${crypto.randomUUID()}`;
  const candidateNo = referenceNo('CAND');

  try {
    const saved = await withTransaction(async (client) => {
      await client.query(HR_RECRUITMENT_CANDIDATE_INSERT_SQL, [
        id,
        candidateNo,
        requisitionId,
        String(requisition.branchId),
        name,
        email,
        optionalText(req.body?.phone, 30),
        optionalText(req.body?.source, 80),
        optionalText(req.body?.currentEmployer, 150),
        'NEW',
        optionalText(req.body?.notes, 1000),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'CREATE_HR_CANDIDATE',
        'ACCOUNTING',
        `Added recruitment candidate ${candidateNo} for ${requisition.requisitionNo}`,
        String(requisition.branchId),
        client
      );
      return (await client.query(HR_RECRUITMENT_CANDIDATE_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(candidateResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This candidate email is already on that requisition.');
    }
    throw err;
  }
}

/** PATCH /api/hr/recruitment/candidates/:id */
export async function patch_hrRecruitmentCandidate(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A candidate id is required.');
  const existing = await findCandidate(id);
  if (!existing) throw new ApiError(404, 'Candidate not found.');
  assertBranch(req, String(existing.branchId));
  if (existing.hiredEmployeeId || existing.status === 'HIRED') {
    throw new ApiError(409, 'A hired candidate can no longer be changed on the pipeline.');
  }
  if (req.body?.requisitionId !== undefined && text(req.body.requisitionId, 60) !== existing.requisitionId) {
    throw new ApiError(400, 'A candidate cannot be moved to another requisition.');
  }
  const status = req.body?.status === undefined
    ? existing.status
    : parseStatus(req.body.status, HR_RECRUITMENT_CANDIDATE_STATUSES, 'Candidate status');
  if (status === 'HIRED') {
    throw new ApiError(400, 'Use the hire action to convert a candidate into an employee.');
  }
  const name = req.body?.name === undefined ? existing.name : text(req.body.name, 200);
  if (!name) throw new ApiError(400, 'A candidate name is required.');
  const email = req.body?.email === undefined ? existing.email : parseEmail(req.body.email);

  try {
    const saved = await withTransaction(async (client) => {
      await client.query(HR_RECRUITMENT_CANDIDATE_UPDATE_SQL, [
        id,
        name,
        email,
        req.body?.phone === undefined ? existing.phone : optionalText(req.body.phone, 30),
        req.body?.source === undefined ? existing.source : optionalText(req.body.source, 80),
        req.body?.currentEmployer === undefined
          ? existing.currentEmployer
          : optionalText(req.body.currentEmployer, 150),
        status,
        req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 1000),
        actorOf(req),
      ]);
      await logAuditEvent(
        req,
        'UPDATE_HR_CANDIDATE',
        'ACCOUNTING',
        `Updated recruitment candidate ${existing.candidateNo} (${status})`,
        String(existing.branchId),
        client
      );
      return (await client.query(HR_RECRUITMENT_CANDIDATE_BY_ID_SQL, [id])).rows[0];
    });
    return res.json(candidateResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This candidate email is already on that requisition.');
    }
    throw err;
  }
}

/** GET /api/hr/recruitment/candidates/:id/resume — metadata only. */
export async function get_hrRecruitmentCandidateResume(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A candidate id is required.');
  const candidate = await findCandidate(id);
  if (!candidate) throw new ApiError(404, 'Candidate not found.');
  assertBranch(req, String(candidate.branchId));
  if (!candidate.hasResume) throw new ApiError(404, 'This candidate has no resume on file.');
  return res.json({
    fileName: candidate.resumeFileName,
    mimeType: candidate.resumeMimeType,
    byteSize: candidate.resumeByteSize,
    uploadedAt: candidate.resumeUploadedAt,
  });
}

/** POST /api/hr/recruitment/candidates/:id/resume?fileName= */
export async function post_hrRecruitmentCandidateResume(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A candidate id is required.');
  const candidate = await findCandidate(id);
  if (!candidate) throw new ApiError(404, 'Candidate not found.');
  assertBranch(req, String(candidate.branchId));

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ApiError(400, 'Choose a resume file to upload.');
  }
  if (body.length > HR_RECRUITMENT_RESUME_MAX_BYTES) {
    throw new ApiError(413, 'The resume exceeds the 5 MB limit.');
  }
  const mimeType = String(req.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!(HR_RECRUITMENT_RESUME_ALLOWED_MIME as readonly string[]).includes(mimeType)) {
    throw new ApiError(400, 'Resume must be a PDF, DOC or DOCX file.');
  }
  const fileName = sanitizeFileName(req.query?.fileName);
  if (!fileName) throw new ApiError(400, 'A resume file name is required.');

  await withTransaction(async (client) => {
    await client.query(HR_RECRUITMENT_RESUME_UPDATE_SQL, [
      id,
      fileName,
      mimeType,
      body.length,
      body,
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'UPLOAD_HR_CANDIDATE_RESUME',
      'ACCOUNTING',
      `Uploaded resume for recruitment candidate ${candidate.candidateNo}`,
      String(candidate.branchId),
      client
    );
  });
  return res.status(201).json(await findCandidate(id));
}

/** GET /api/hr/recruitment/candidates/:id/resume/content */
export async function get_hrRecruitmentCandidateResumeContent(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'A candidate id is required.');
  const candidate = await findCandidate(id);
  if (!candidate) throw new ApiError(404, 'Candidate not found.');
  assertBranch(req, String(candidate.branchId));
  const row = (await pgPool.query(HR_RECRUITMENT_RESUME_CONTENT_SQL, [id])).rows[0];
  if (!row) throw new ApiError(404, 'This candidate has no resume on file.');
  res.setHeader('Content-Type', row.mimeType);
  res.setHeader('Content-Length', String(row.byteSize));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${String(row.fileName).replace(/["\\]/g, '_')}"`
  );
  return res.send(row.content);
}

/** GET /api/hr/recruitment/interviews?branchId=&candidateId=&status= */
export async function get_hrRecruitmentInterviews(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, INTERVIEW_FILTERS);
  const status = filters.status
    ? parseStatus(filters.status, HR_RECRUITMENT_INTERVIEW_STATUSES, 'Interview status')
    : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_RECRUITMENT_INTERVIEW_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      filters.candidateId,
      status,
    ])
  ).rows;
  return res.json(rows);
}

/** POST /api/hr/recruitment/interviews */
export async function post_hrRecruitmentInterview(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const candidateId = text(req.body?.candidateId, 60);
  if (!candidateId) throw new ApiError(400, 'A candidate is required.');
  const candidate = await findCandidate(candidateId);
  if (!candidate) throw new ApiError(400, 'The selected candidate does not exist.');
  assertBranch(req, String(candidate.branchId));
  if (['HIRED', 'REJECTED', 'WITHDRAWN'].includes(String(candidate.status))) {
    throw new ApiError(409, 'This candidate is no longer active in the pipeline.');
  }
  const roundName = text(req.body?.roundName, 60);
  if (!roundName) throw new ApiError(400, 'An interview round is required.');
  const scheduledOnAD = parseDate(req.body?.scheduledOnAD, 'Interview date');
  const status = req.body?.status === undefined
    ? 'SCHEDULED'
    : parseStatus(req.body.status, HR_RECRUITMENT_INTERVIEW_STATUSES, 'Interview status');
  const mode = req.body?.mode === undefined ? 'VIDEO' : parseMode(req.body.mode);
  const rating = parseRating(req.body?.rating);
  const id = `hr-int-${crypto.randomUUID()}`;

  const saved = await withTransaction(async (client) => {
    const scheduledOnBS = await resolveBsDateForLedger(scheduledOnAD, client);
    await client.query(HR_RECRUITMENT_INTERVIEW_INSERT_SQL, [
      id,
      candidateId,
      String(candidate.branchId),
      roundName,
      scheduledOnAD,
      scheduledOnBS,
      optionalText(req.body?.interviewer, 150),
      mode,
      status,
      rating,
      optionalText(req.body?.notes, 1000),
      actorOf(req),
    ]);
    await client.query(HR_RECRUITMENT_CANDIDATE_MARK_INTERVIEW_SQL, [candidateId]);
    await logAuditEvent(
      req,
      'CREATE_HR_INTERVIEW',
      'ACCOUNTING',
      `Scheduled ${roundName} interview for candidate ${candidate.candidateNo} on ${scheduledOnAD}`,
      String(candidate.branchId),
      client
    );
    return (await client.query(HR_RECRUITMENT_INTERVIEW_BY_ID_SQL, [id])).rows[0];
  });
  return res.status(201).json(saved);
}

/** PATCH /api/hr/recruitment/interviews/:id */
export async function patch_hrRecruitmentInterview(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'An interview id is required.');
  const existing = await findInterview(id);
  if (!existing) throw new ApiError(404, 'Interview not found.');
  assertBranch(req, String(existing.branchId));

  const roundName =
    req.body?.roundName === undefined ? existing.roundName : text(req.body.roundName, 60);
  if (!roundName) throw new ApiError(400, 'An interview round is required.');
  const scheduledOnAD = req.body?.scheduledOnAD === undefined
    ? existing.scheduledOnAD
    : parseDate(req.body.scheduledOnAD, 'Interview date');
  const status = req.body?.status === undefined
    ? existing.status
    : parseStatus(req.body.status, HR_RECRUITMENT_INTERVIEW_STATUSES, 'Interview status');
  const mode = req.body?.mode === undefined ? existing.mode : parseMode(req.body.mode);
  const rating = req.body?.rating === undefined ? existing.rating : parseRating(req.body.rating);

  const saved = await withTransaction(async (client) => {
    const scheduledOnBS = await resolveBsDateForLedger(scheduledOnAD, client);
    await client.query(HR_RECRUITMENT_INTERVIEW_UPDATE_SQL, [
      id,
      roundName,
      scheduledOnAD,
      scheduledOnBS,
      req.body?.interviewer === undefined
        ? existing.interviewer
        : optionalText(req.body.interviewer, 150),
      mode,
      status,
      rating,
      req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 1000),
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'UPDATE_HR_INTERVIEW',
      'ACCOUNTING',
      `Updated ${roundName} interview for candidate ${existing.candidateNo} (${status})`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_RECRUITMENT_INTERVIEW_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(saved);
}

/** GET /api/hr/recruitment/offers?branchId=&candidateId=&status= */
export async function get_hrRecruitmentOffers(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  const filters = readFilters(req, OFFER_FILTERS);
  const status = filters.status
    ? parseStatus(filters.status, HR_RECRUITMENT_OFFER_STATUSES, 'Offer status')
    : null;
  const scope = readScope(req, filters.branchId);
  if (scope.branchIds && scope.branchIds.length === 0) return res.json([]);
  const rows = (
    await pgPool.query(HR_RECRUITMENT_OFFER_LIST_SQL, [
      scope.branchId,
      scope.branchIds,
      filters.candidateId,
      status,
    ])
  ).rows.map(offerResponse);
  return res.json(rows);
}

/** POST /api/hr/recruitment/offers */
export async function post_hrRecruitmentOffer(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const candidateId = text(req.body?.candidateId, 60);
  if (!candidateId) throw new ApiError(400, 'A candidate is required.');
  const candidate = await findCandidate(candidateId);
  if (!candidate) throw new ApiError(400, 'The selected candidate does not exist.');
  assertBranch(req, String(candidate.branchId));
  if (['HIRED', 'REJECTED', 'WITHDRAWN'].includes(String(candidate.status))) {
    throw new ApiError(409, 'This candidate is no longer active in the pipeline.');
  }
  if (candidate.offerId) {
    throw new ApiError(409, 'This candidate already has an offer. Update the existing offer instead.');
  }
  const positionTitle = text(req.body?.positionTitle, 150);
  if (!positionTitle) throw new ApiError(400, 'An offer position is required.');
  const monthlySalary = parseAmount(req.body?.monthlySalary ?? 0);
  const startDateAD = parseDate(req.body?.startDateAD, 'Offer start date');
  const offeredOnAD =
    req.body?.offeredOnAD === undefined ? today() : parseDate(req.body.offeredOnAD, 'Offered date');
  const status = req.body?.status === undefined
    ? 'DRAFT'
    : parseStatus(req.body.status, HR_RECRUITMENT_OFFER_STATUSES, 'Offer status');
  if (status !== 'DRAFT' && status !== 'SENT') {
    throw new ApiError(400, 'A new offer must start as DRAFT or SENT.');
  }
  const id = `hr-offer-${crypto.randomUUID()}`;
  const offerNo = referenceNo('OFF');

  try {
    const saved = await withTransaction(async (client) => {
      const startDateBS = await resolveBsDateForLedger(startDateAD, client);
      const offeredOnBS = await resolveBsDateForLedger(offeredOnAD, client);
      await client.query(HR_RECRUITMENT_OFFER_INSERT_SQL, [
        id,
        offerNo,
        candidateId,
        String(candidate.branchId),
        positionTitle,
        monthlySalary,
        startDateAD,
        startDateBS,
        offeredOnAD,
        offeredOnBS,
        status,
        null,
        optionalText(req.body?.notes, 1000),
        actorOf(req),
      ]);
      await client.query(HR_RECRUITMENT_CANDIDATE_MARK_OFFER_SQL, [candidateId]);
      await logAuditEvent(
        req,
        'CREATE_HR_OFFER',
        'ACCOUNTING',
        `Created offer ${offerNo} for candidate ${candidate.candidateNo} (${status})`,
        String(candidate.branchId),
        client
      );
      return (await client.query(HR_RECRUITMENT_OFFER_BY_ID_SQL, [id])).rows[0];
    });
    return res.status(201).json(offerResponse(saved));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'This candidate already has an offer. Update the existing offer instead.');
    }
    throw err;
  }
}

/** PATCH /api/hr/recruitment/offers/:id */
export async function patch_hrRecruitmentOffer(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const id = text(req.params?.id, 60);
  if (!id) throw new ApiError(400, 'An offer id is required.');
  const existing = await findOffer(id);
  if (!existing) throw new ApiError(404, 'Offer not found.');
  assertBranch(req, String(existing.branchId));
  if (FINAL_OFFER_STATUSES.includes(existing.status)) {
    throw new ApiError(409, `A ${String(existing.status).toLowerCase()} offer is final and cannot be changed.`);
  }

  const status = req.body?.status === undefined
    ? existing.status
    : parseStatus(req.body.status, HR_RECRUITMENT_OFFER_STATUSES, 'Offer status');
  if (!OFFER_TRANSITIONS[existing.status as HrRecruitmentOfferStatus].includes(status)) {
    throw new ApiError(409, `An offer cannot move from ${existing.status} to ${status}.`);
  }
  const positionTitle =
    req.body?.positionTitle === undefined
      ? existing.positionTitle
      : text(req.body.positionTitle, 150);
  if (!positionTitle) throw new ApiError(400, 'An offer position is required.');
  const monthlySalary =
    req.body?.monthlySalary === undefined ? Number(existing.monthlySalary) : parseAmount(req.body.monthlySalary);
  const startDateAD = req.body?.startDateAD === undefined
    ? existing.startDateAD
    : parseDate(req.body.startDateAD, 'Offer start date');
  const offeredOnAD = req.body?.offeredOnAD === undefined
    ? existing.offeredOnAD
    : parseDate(req.body.offeredOnAD, 'Offered date');
  const respondedOnAD =
    status === 'ACCEPTED' || status === 'DECLINED' ? today() : existing.respondedOnAD;

  const saved = await withTransaction(async (client) => {
    const startDateBS = await resolveBsDateForLedger(startDateAD, client);
    const offeredOnBS = await resolveBsDateForLedger(offeredOnAD, client);
    await client.query(HR_RECRUITMENT_OFFER_UPDATE_SQL, [
      id,
      positionTitle,
      monthlySalary,
      startDateAD,
      startDateBS,
      offeredOnAD,
      offeredOnBS,
      status,
      respondedOnAD,
      req.body?.notes === undefined ? existing.notes : optionalText(req.body.notes, 1000),
      actorOf(req),
    ]);
    await logAuditEvent(
      req,
      'UPDATE_HR_OFFER',
      'ACCOUNTING',
      `Updated offer ${existing.offerNo} for candidate ${existing.candidateNo} (${status})`,
      String(existing.branchId),
      client
    );
    return (await client.query(HR_RECRUITMENT_OFFER_BY_ID_SQL, [id])).rows[0];
  });
  return res.json(offerResponse(saved));
}

/**
 * POST /api/hr/recruitment/candidates/:id/hire
 *
 * The only conversion path. The employee is created from the accepted offer's
 * salary/start date and the requisition's department/designation; the candidate
 * row then records the employee id in the same transaction. A missing or
 * non-accepted offer is a 409, never an auto-created placeholder offer.
 */
export async function post_hrRecruitmentHire(req: any, res: Response): Promise<any> {
  requireDb();
  privateNoStore(res);
  requireManage(req);
  const candidateId = text(req.params?.id, 60);
  if (!candidateId) throw new ApiError(400, 'A candidate id is required.');
  const employeeCode = normalizeEmployeeCode(req.body?.employeeCode);

  try {
    const result = await withTransaction(async (client) => {
      const context = (await client.query(HR_RECRUITMENT_HIRE_CONTEXT_SQL, [candidateId])).rows[0];
      if (!context) throw new ApiError(404, 'Candidate not found.');
      assertBranch(req, String(context.branchId));
      if (context.hiredEmployeeId || context.candidateStatus === 'HIRED') {
        throw new ApiError(409, 'This candidate has already been converted to an employee.');
      }
      if (!context.offerId) {
        throw new ApiError(409, 'A candidate cannot become an employee without a completed offer.');
      }
      if (context.offerStatus !== 'ACCEPTED') {
        throw new ApiError(409, 'The offer must be accepted before the candidate can become an employee.');
      }
      if ((await client.query(EMPLOYEE_BY_CODE_SQL, [employeeCode])).rows[0]) {
        throw new ApiError(409, `Employee code ${employeeCode} already exists.`);
      }

      const employeeId = `emp-${crypto.randomUUID()}`;
      const employee = (
        await client.query(
          EMPLOYEE_INSERT_SQL,
          employeeInsertParams({
            id: employeeId,
            employeeCode,
            name: context.name,
            branchId: String(context.branchId),
            userId: null,
            department: context.department || null,
            designation: context.designation || context.positionTitle || null,
            panNumber: null,
            ssfNumber: null,
            bankAccount: null,
            bankName: null,
            employmentType: context.employmentType || null,
            joiningDateAD: context.startDateAD || null,
            dateOfBirthAD: null,
            contractExpiryAD: null,
            separationDateAD: null,
            designationCode: null,
            workStation: null,
            address: null,
            personalContact: context.phone || null,
            emergencyContactPerson: null,
            emergencyContactNumber: null,
            internalEmail: null,
            personalEmail: context.email || null,
            monthlySalary: Number(context.monthlySalary ?? 0),
            ssfEligible: false,
            isActive: true,
            createdBy: actorOf(req),
          })
        )
      ).rows[0];
      const hired = await client.query(HR_RECRUITMENT_CANDIDATE_HIRE_SQL, [
        candidateId,
        employeeId,
        actorOf(req),
      ]);
      if (hired.rowCount !== 1) {
        throw new ApiError(409, 'This candidate has already been converted to an employee.');
      }
      await logAuditEvent(
        req,
        'HIRE_HR_CANDIDATE',
        'ACCOUNTING',
        `Hired recruitment candidate ${context.candidateNo} as employee ${employeeCode}`,
        String(context.branchId),
        client
      );
      return {
        candidateId,
        candidateNo: context.candidateNo,
        employeeId,
        employeeCode: employee.employeeCode,
        name: employee.name,
        branchId: employee.branchId,
        joiningDateAD: context.startDateAD,
        monthlySalary: Number(context.monthlySalary ?? 0),
      };
    });
    return res.status(201).json(result);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'The employee code or candidate conversion is already in use.');
    }
    throw err;
  }
}
