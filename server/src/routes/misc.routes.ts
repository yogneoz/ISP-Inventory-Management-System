/**
 * Misc routes — extracted verbatim from server.ts by
 * scripts/split_routes2.mjs. Registration order is preserved by
 * server.ts calling registerMiscRoutes(app) at the original
 * position of this domain's first route.
 */
import type { Express } from 'express';
import { get_status, get_auditTrail, get_transactionLogs, get_approvalRequests, post_approvalRequests, post_process, post_cancel } from '../controllers/misc.controller';
import { requirePermission, requireRole } from '../app';
import { ensurePostgresConnection, pgPool, realPoolInstance, setIsPgConnected } from '../app';
import type { ApprovalRequest, AuditLog, CustomerDeviceRecord, TransactionLog } from '../../../client/src/types';

export function registerMiscRoutes(app: Express) {
app.get('/api/db/status', async (req, res, next) => { get_status(req as any, res as any).catch(next); });

// Serial-scoped audit trail: the Audit Trail screen asks this for one unit's
// full claim/refusal history instead of filtering the 200-row bootstrap slice.
// Gated by the same operation that shows the screen.
app.get('/api/audit-trail', requirePermission('admin-audit'), async (req, res, next) => { get_auditTrail(req as any, res as any).catch(next); });

app.get('/api/transaction-logs', async (req, res, next) => { get_transactionLogs(req as any, res as any).catch(next); });

app.get('/api/approval-requests', async (req, res, next) => { get_approvalRequests(req as any, res as any).catch(next); });

app.post('/api/approval-requests', async (req, res, next) => { post_approvalRequests(req as any, res as any).catch(next); });

app.post('/api/approval-requests/:id/process', requireRole('SUPER_ADMIN', 'HEAD_OFFICE_ADMIN', 'BRANCH_MANAGER', 'AUDITOR'), async (req, res, next) => { post_process(req as any, res as any).catch(next); });

app.post('/api/approval-requests/:id/cancel', async (req, res, next) => { post_cancel(req as any, res as any).catch(next); });

}
