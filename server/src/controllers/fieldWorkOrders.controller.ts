/**
 * Field capture API — technician work orders (install, service, disconnect).
 *
 * The flow the screen drives:
 *   POST   /api/field-work-orders          create an OPEN order against a subscriber
 *   PATCH  /api/field-work-orders/:id/assign   name the technician (OPEN -> ASSIGNED)
 *   POST   /api/field-work-orders/:id/complete record the visit (-> COMPLETED)
 *   POST   /api/field-work-orders/:id/cancel   abandon it (-> CANCELLED)
 *   GET    /api/field-work-orders          branch-scoped list
 *
 * Every write derives its branch from the caller's session scope, never from a
 * browser claim, and every response is `private, no-store` like the neighbouring
 * registers. Status rules live in the repository's WHERE clauses, so a second
 * completion is a 409 rather than a doubled write.
 */
import type { Request, Response } from 'express';
import { resolveBranchScope } from './accounting.controller';
import {
  assignFieldWorkOrder,
  cancelFieldWorkOrder,
  completeFieldWorkOrderInTransaction,
  customerInBranch,
  employeeInBranch,
  findFieldWorkOrder,
  insertFieldWorkOrder,
  listFieldWorkOrders,
} from '../models/fieldWorkOrders.repo';
import { withTransaction } from '../db/transactions';
import { FIXED_ASSET_HELD_BY_SERIAL_SQL } from '../models/inventory.repo';
import { businessDateAD } from '../../../shared/businessDate';
import { CustodyInstallRefusal, installHeldAssetAtCustomer } from '../services/custodyInstall.service';
import {
  appendFieldWorkOrderEvidence,
  findFieldWorkOrderEvidenceContent,
  listFieldWorkOrderEvidence,
} from '../models/fieldWorkOrderEvidence.repo';
import { parseEvidenceBody } from '../services/workOrderEvidence.service';
import { logAuditEvent } from '../services/audit.service';

const KINDS = new Set(['INSTALL', 'SERVICE', 'DISCONNECT']);
const STATUSES = new Set(['OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED']);

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function isoDate(value: unknown): string | null {
  const raw = text(value, 10);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function actorEmail(req: any): string {
  const user = req.user || {};
  return String(user.email || user.name || user.id || 'unknown');
}

function canSeeBranch(req: any, row: { branch_id: string }): boolean {
  const user = req.user || {};
  if (user.role === 'SUPER_ADMIN' || user.role === 'HEAD_OFFICE_ADMIN' || user.branchId === 'ALL') return true;
  const allowed = new Set<string>([user.branchId || '', ...(user.allowedBranchIds || [])].filter(Boolean));
  return allowed.has(row.branch_id);
}

function notFound(res: Response) {
  return res.status(404).json({ message: 'Work order not found.' });
}

function conflict(res: Response, state: string) {
  return res.status(409).json({
    message: `Work order is ${state.toLowerCase()}; only an open or assigned order can be changed.`,
  });
}

export async function get_fieldWorkOrders(req: Request, res: Response): Promise<any> {
  const scope = resolveBranchScope(req as any, res);
  if (!scope) return;
  const status = text(req.query.status, 16)?.toUpperCase();
  if (status && !STATUSES.has(status)) {
    return res.status(400).json({ message: `Unknown status "${status}".` });
  }
  const rows = await listFieldWorkOrders({
    branchId: scope.branchId,
    status: status || undefined,
    customerId: text(req.query.customerId, 40) || undefined,
  });
  res.set('Cache-Control', 'private, no-store');
  res.json(rows);
}

export async function get_fieldWorkOrder(req: Request, res: Response): Promise<any> {
  const row = await findFieldWorkOrder(String(req.params.id));
  if (!row) return notFound(res);
  if (!canSeeBranch(req as any, row)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.json(row);
}

export async function post_fieldWorkOrder(req: Request, res: Response): Promise<any> {
  const body = req.body || {};
  const scope = resolveBranchScope(req as any, res, body.branchId);
  if (!scope) return;
  if (scope.empty) return res.status(403).json({ message: 'Forbidden: no branch is assigned to this account.' });
  const branchId = scope.branchId;
  if (!branchId) return res.status(400).json({ message: 'branchId is required.' });

  const kind = text(body.kind, 16)?.toUpperCase();
  if (!kind || !KINDS.has(kind)) {
    return res.status(400).json({ message: 'kind must be INSTALL, SERVICE or DISCONNECT.' });
  }
  const customerId = text(body.customerId, 40);
  if (!customerId) return res.status(400).json({ message: 'customerId is required.' });
  if (!(await customerInBranch(customerId, branchId))) {
    return res.status(400).json({ message: 'That subscriber is not in the selected branch.' });
  }
  const scheduled = isoDate(body.scheduledDateAd);
  if (!scheduled) return res.status(400).json({ message: 'scheduledDateAd must be a valid YYYY-MM-DD date.' });

  const technicianId = text(body.technicianId, 40);
  let technicianName = text(body.technicianName, 200);
  if (technicianId) {
    if (!(await employeeInBranch(technicianId, branchId))) {
      return res.status(400).json({ message: 'That technician is not in the selected branch.' });
    }
    technicianName = technicianName || technicianId;
  }

  const row = await insertFieldWorkOrder({
    branchId,
    customerId,
    kind,
    scheduledDateAd: scheduled,
    technicianId,
    technicianName,
    ontSerial: text(body.ontSerial, 64),
    routerSerial: text(body.routerSerial, 64),
    ipAddress: text(body.ipAddress, 64),
    planName: text(body.planName, 120),
    notes: text(body.notes, 1000) || '',
    createdBy: actorEmail(req as any),
  });
  res.set('Cache-Control', 'private, no-store');
  res.status(201).json(row);
}

export async function patch_fieldWorkOrderAssign(req: Request, res: Response): Promise<any> {
  const existing = await findFieldWorkOrder(String(req.params.id));
  if (!existing) return notFound(res);
  if (!canSeeBranch(req as any, existing)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  if (!['OPEN', 'ASSIGNED'].includes(existing.status)) return conflict(res, existing.status);

  const technicianId = text(req.body?.technicianId, 40);
  const technicianName = text(req.body?.technicianName, 200);
  if (!technicianId && !technicianName) {
    return res.status(400).json({ message: 'technicianId or technicianName is required.' });
  }
  if (technicianId && !(await employeeInBranch(technicianId, existing.branch_id))) {
    return res.status(400).json({ message: 'That technician is not in this branch.' });
  }
  const updated = await assignFieldWorkOrder(String(req.params.id), technicianId, technicianName || technicianId!);
  if (!updated) return conflict(res, existing.status);
  res.set('Cache-Control', 'private, no-store');
  res.json(updated);
}

export async function post_fieldWorkOrderComplete(req: Request, res: Response): Promise<any> {
  const existing = await findFieldWorkOrder(String(req.params.id));
  if (!existing) return notFound(res);
  if (!canSeeBranch(req as any, existing)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  if (!['OPEN', 'ASSIGNED'].includes(existing.status)) return conflict(res, existing.status);

  const completionNotes = text(req.body?.completionNotes, 1000);
  if (!completionNotes) {
    return res.status(400).json({ message: 'completionNotes is required to complete a visit.' });
  }
  // Closing a visit and installing the CPE it delivered are one act. The
  // completion and the install share a transaction, so a refused install leaves
  // the order open instead of closing a job whose device never reached the
  // customer.
  const installedAssetId = text(req.body?.installedAssetId, 50);
  const installedSerial = text(req.body?.installedSerial, 100);
  const completion = {
    completionNotes,
    ontSerial: text(req.body?.ontSerial, 64),
    routerSerial: text(req.body?.routerSerial, 64),
    ipAddress: text(req.body?.ipAddress, 64),
    planName: text(req.body?.planName, 120),
  };

  let installed: Awaited<ReturnType<typeof installHeldAssetAtCustomer>> | null = null;
  try {
    const outcome = await withTransaction(async (client) => {
      const done = await completeFieldWorkOrderInTransaction(client, String(req.params.id), completion);
      if (!done) return null;
      if (!installedAssetId && !installedSerial) return { installed: null };
      const holderId = String(existing.technician_id || '');
      if (!holderId) {
        throw new CustodyInstallRefusal(
          409,
          'This visit has no technician, so there is no custody the unit could leave.',
          'ASSET_NOT_HELD'
        );
      }
      let assetId = installedAssetId || '';
      if (!assetId) {
        const held = (await client.query(FIXED_ASSET_HELD_BY_SERIAL_SQL, [String(installedSerial), holderId])).rows[0];
        if (!held) {
          throw new CustodyInstallRefusal(
            409,
            `Serial ${installedSerial} is not a unit held by this visit's technician.`,
            'ASSET_NOT_HELD'
          );
        }
        assetId = String(held.id);
      }
      const result = await installHeldAssetAtCustomer({
        client,
        assetId,
        employeeId: holderId,
        workOrderId: String(existing.id),
        dateAD: businessDateAD(),
        actor: (req as any).user?.email || null,
      });
      return { installed: result };
    });
    if (!outcome) return conflict(res, existing.status);
    installed = outcome.installed;
  } catch (error) {
    if (error instanceof CustodyInstallRefusal) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    throw error;
  }

  const updated = await findFieldWorkOrder(String(req.params.id));
  res.set('Cache-Control', 'private, no-store');
  res.json(installed ? { ...updated, installedAsset: installed } : updated);
}

/** GET /api/field-work-orders/:id/evidence — metadata for the visit's captures. */
export async function get_fieldWorkOrderEvidence(req: Request, res: Response): Promise<any> {
  const order = await findFieldWorkOrder(String(req.params.id));
  if (!order) return notFound(res);
  if (!canSeeBranch(req as any, order)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  const rows = await listFieldWorkOrderEvidence(order.id);
  res.set('Cache-Control', 'private, no-store');
  res.json({ evidence: rows, count: rows.length });
}

/**
 * POST /api/field-work-orders/:id/evidence — store a photo or signature.
 *
 * A closed order still accepts evidence: the technician may capture the proof
 * offline, complete the visit, and only reach the network later. The bytes are
 * content-addressed, so the replay stores once.
 */
export async function post_fieldWorkOrderEvidence(req: Request, res: Response): Promise<any> {
  const order = await findFieldWorkOrder(String(req.params.id));
  if (!order) return notFound(res);
  if (!canSeeBranch(req as any, order)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  let parsed;
  try {
    parsed = parseEvidenceBody(req.body || {});
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || 'Invalid evidence.' });
  }
  const saved = await appendFieldWorkOrderEvidence({
    workOrderId: order.id,
    branchId: order.branch_id,
    kind: parsed.kind,
    contentType: parsed.contentType,
    dataBase64: parsed.dataBase64,
    caption: parsed.caption,
    capturedAt: parsed.capturedAt,
    capturedBy: actorEmail(req as any),
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    accuracyMeters: parsed.accuracyMeters,
  });
  await logAuditEvent(
    req as any,
    'FIELD_WORK_ORDER_EVIDENCE',
    'OPERATIONS',
    `${saved.inserted ? 'Captured' : 'Replayed'} ${parsed.kind.toLowerCase()} ${saved.sha256.slice(0, 12)} on work order ${order.work_order_no}`,
    order.branch_id
  );
  res.set('Cache-Control', 'private, no-store');
  res.status(201).json({
    id: saved.row.id,
    kind: saved.row.kind,
    contentType: saved.row.content_type,
    byteSize: saved.row.byte_size,
    sha256: saved.sha256,
    capturedAt: saved.row.captured_at,
    inserted: saved.inserted,
    count: saved.count,
  });
}

/** GET /api/field-work-orders/:id/evidence/:evidenceId/content — the bytes. */
export async function get_fieldWorkOrderEvidenceContent(req: Request, res: Response): Promise<any> {
  const order = await findFieldWorkOrder(String(req.params.id));
  if (!order) return notFound(res);
  if (!canSeeBranch(req as any, order)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  const content = await findFieldWorkOrderEvidenceContent(String(req.params.evidenceId));
  if (!content) return res.status(404).json({ message: 'Evidence not found.' });
  const rows = await listFieldWorkOrderEvidence(order.id);
  if (!rows.some((row) => row.id === String(req.params.evidenceId))) {
    return res.status(404).json({ message: 'Evidence not found on this work order.' });
  }
  res.set('Cache-Control', 'private, no-store');
  res.type(content.content_type);
  res.send(Buffer.from(content.data_base64, 'base64'));
}

export async function post_fieldWorkOrderCancel(req: Request, res: Response): Promise<any> {
  const existing = await findFieldWorkOrder(String(req.params.id));
  if (!existing) return notFound(res);
  if (!canSeeBranch(req as any, existing)) {
    return res.status(403).json({ message: 'Forbidden: this work order belongs to another branch.' });
  }
  if (!['OPEN', 'ASSIGNED'].includes(existing.status)) return conflict(res, existing.status);
  const updated = await cancelFieldWorkOrder(String(req.params.id));
  if (!updated) return conflict(res, existing.status);
  res.set('Cache-Control', 'private, no-store');
  res.json(updated);
}
