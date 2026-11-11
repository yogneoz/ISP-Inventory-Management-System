/**
 * Employee document vault.
 *
 * Metadata is readable with the employee-view grant; the bytes, uploads and
 * deletions require the employee-manage grant (or the legacy payroll-manage
 * grant). Someone who may only view the masked employee master must not be
 * able to download a PAN card or bank statement and bypass that masking.
 *
 * Uploads are bounded raw bodies, not multipart: the request body is the file
 * itself, capped at 5 MiB by the route and re-checked here. Files are stored in
 * PostgreSQL with a generated storage key, so a document and its audit row
 * commit or roll back together.
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
import { isAccountingDate } from '../services/accounting.service';
import {
  HR_DOCUMENT_ALLOWED_MIME,
  HR_DOCUMENT_COUNT_SQL,
  HR_DOCUMENT_DELETE_SQL,
  HR_DOCUMENT_EMPLOYEE_SCOPE_SQL,
  HR_DOCUMENT_INSERT_SQL,
  HR_DOCUMENT_MAX_BYTES,
  HR_DOCUMENT_MAX_PER_EMPLOYEE,
  HR_DOCUMENT_TYPES,
  HR_DOCUMENTS_BY_EMPLOYEE_SQL,
  HR_DOCUMENT_CONTENT_SQL,
  type HrDocumentType,
} from '../models/hrDocuments.repo';

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

function holdsPermission(req: any, operation: string): boolean {
  const user = req.user || getUserFromReq(req);
  return effectivePermission(
    user,
    operation,
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

function canManage(req: any): boolean {
  return holdsPermission(req, 'hr-employee-manage') || holdsPermission(req, 'gl-payroll-manage');
}

function requireManage(req: any): void {
  if (!canManage(req)) {
    throw new ApiError(403, 'Employee documents require the HR manage permission.');
  }
}

interface DocumentEmployee {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  userId: string | null;
}

/**
 * Loads the owning employee and enforces branch custody. A row outside the
 * caller's branches is reported as missing, not forbidden, so the endpoint
 * cannot be used to probe another branch's employee ids.
 */
async function loadEmployee(req: any, employeeId: string): Promise<DocumentEmployee> {
  const employee = (await pgPool.query(HR_DOCUMENT_EMPLOYEE_SCOPE_SQL, [employeeId])).rows[0];
  if (!employee) throw new ApiError(404, 'Employee not found.');
  const allowed = allowedBranchScope(req.user || getUserFromReq(req));
  if (allowed && !allowed.has(String(employee.branchId))) {
    throw new ApiError(404, 'Employee not found.');
  }
  return employee;
}

function requireEmployeeId(req: any): string {
  const id = text(req.params?.id, 50);
  if (!id) throw new ApiError(400, 'An employee id is required.');
  return id;
}

function requireDocumentId(req: any): string {
  const id = text(req.params?.documentId, 60);
  if (!id) throw new ApiError(400, 'A document id is required.');
  return id;
}

function parseDocType(value: unknown): HrDocumentType {
  const type = text(value, 40).toUpperCase().replace(/[\s-]+/g, '_');
  if (!(HR_DOCUMENT_TYPES as readonly string[]).includes(type)) {
    throw new ApiError(400, `Document type must be one of: ${HR_DOCUMENT_TYPES.join(', ')}.`);
  }
  return type as HrDocumentType;
}

/** Last path segment only, with characters that do not belong in a name removed. */
function sanitizeFileName(value: unknown): string {
  const raw = text(value, 300);
  const base = raw.split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 200);
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = text(value, 10);
  if (!isAccountingDate(date)) {
    throw new ApiError(400, 'Expiry date must be a real date in YYYY-MM-DD form.');
  }
  return date;
}

function optionalText(value: unknown, max: number): string | null {
  const parsed = text(value, max);
  return parsed || null;
}

/** GET /api/employees/:id/documents — metadata only. */
export async function get_hrEmployeeDocuments(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  const rows = (await pgPool.query(HR_DOCUMENTS_BY_EMPLOYEE_SQL, [employee.id])).rows;
  return res.json(rows);
}

/** POST /api/employees/:id/documents?type=&fileName=&expiresOn=&notes= */
export async function post_hrEmployeeDocument(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  requireManage(req);

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ApiError(400, 'Choose a document file to upload.');
  }
  if (body.length > HR_DOCUMENT_MAX_BYTES) {
    throw new ApiError(413, 'The document exceeds the 5 MB limit.');
  }

  const mimeType = String(req.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!(HR_DOCUMENT_ALLOWED_MIME as readonly string[]).includes(mimeType)) {
    throw new ApiError(400, 'Document must be a PDF, PNG, JPEG, WebP or DOCX file.');
  }

  const originalName = sanitizeFileName(req.query?.fileName);
  if (!originalName) throw new ApiError(400, 'A document file name is required.');
  const docType = parseDocType(req.query?.type);
  const expiresOnAD = optionalDate(req.query?.expiresOn);
  const notes = optionalText(req.query?.notes, 500);

  const count = (await pgPool.query(HR_DOCUMENT_COUNT_SQL, [employee.id])).rows[0]?.count ?? 0;
  if (Number(count) >= HR_DOCUMENT_MAX_PER_EMPLOYEE) {
    throw new ApiError(
      409,
      `An employee can hold at most ${HR_DOCUMENT_MAX_PER_EMPLOYEE} documents. Remove one first.`
    );
  }

  const unique = crypto.randomUUID();
  const id = `hr-doc-${unique}`;
  const storageKey = `hrdoc-${unique}`;

  const saved = await withTransaction(async (client) => {
    const row = (
      await client.query(HR_DOCUMENT_INSERT_SQL, [
        id,
        employee.id,
        docType,
        originalName,
        mimeType,
        body.length,
        storageKey,
        expiresOnAD,
        notes,
        body,
        actorOf(req),
      ])
    ).rows[0];
    await logAuditEvent(
      req,
      'UPLOAD_EMPLOYEE_DOCUMENT',
      'ACCOUNTING',
      `Uploaded ${docType} document for employee ${employee.employeeCode}`,
      employee.branchId,
      client
    );
    return row;
  });

  return res.status(201).json(saved);
}

/**
 * GET /api/employees/:id/documents/:documentId/content — the bytes.
 *
 * HR managers keep their existing access. A self-service caller may read a
 * document only when the route's employee row is linked to their own login; a
 * mismatched employee is reported as missing so this route cannot be used to
 * probe another employee's document ids.
 */
export async function get_hrEmployeeDocumentContent(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  if (!canManage(req)) {
    const user = getUserFromReq(req);
    const ownsDocument =
      Boolean(user?.id) &&
      holdsPermission(req, 'hr-self-service') &&
      Boolean(employee.userId) &&
      String(employee.userId) === String(user.id);
    if (!ownsDocument) throw new ApiError(404, 'Document not found.');
  }
  const documentId = requireDocumentId(req);

  const row = (
    await pgPool.query(HR_DOCUMENT_CONTENT_SQL, [documentId, employee.id])
  ).rows[0];
  if (!row) throw new ApiError(404, 'Document not found.');

  const asciiName =
    String(row.originalName)
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '') || 'document';
  res.setHeader('Content-Type', String(row.mimeType));
  res.setHeader('Content-Length', String(row.byteSize));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(
      String(row.originalName)
    )}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(row.content);
}

/** DELETE /api/employees/:id/documents/:documentId */
export async function delete_hrEmployeeDocument(req: any, res: Response): Promise<any> {
  requireDb();
  const employee = await loadEmployee(req, requireEmployeeId(req));
  requireManage(req);
  const documentId = requireDocumentId(req);

  const removed = await withTransaction(async (client) => {
    const deleted = (
      await client.query(HR_DOCUMENT_DELETE_SQL, [documentId, employee.id])
    ).rows[0];
    if (!deleted) return false;
    await logAuditEvent(
      req,
      'DELETE_EMPLOYEE_DOCUMENT',
      'ACCOUNTING',
      `Removed document ${documentId} for employee ${employee.employeeCode}`,
      employee.branchId,
      client
    );
    return true;
  });
  if (!removed) throw new ApiError(404, 'Document not found.');
  return res.status(204).end();
}
