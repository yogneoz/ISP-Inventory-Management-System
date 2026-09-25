/**
 * Audit-trail service extracted from app.ts (backlog item #6 — app.ts
 * extraction). Builds the audit row, prepends it to the shared auditTrail
 * cache, broadcasts an SSE change, and persists to PostgreSQL.
 */
import { pgPool } from '../../db';
import { withPrepended } from '../utils/copyHelpers';
import { todayBs } from '../utils/bsDate';
import { auditTrail, setAuditTrail, getPgConnected } from '../state/runtimeState';
import { broadcastChange } from '../realtime/sse';
import { getUserFromReq } from '../middleware/auth';
import type { AuditLog } from '../../../client/src/types';

export function logAuditEvent(
  req: any,
  action: string,
  module: string,
  details: string,
  overrideBranchId?: string,
  client?: any
): AuditLog | Promise<AuditLog> {
  const u = getUserFromReq(req);
  const auditItem: AuditLog = {
    id: `aud-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
    userEmail: u.email || '',
    userName: u.name || '',
    action,
    module: module as AuditLog['module'],
    details,
    timestampAD: new Date().toISOString(),
    // C4: BS date from the hydrated bs_day_records cache (hydrate-
    // BsCalendarFromDb keeps it in sync with PostgreSQL). Sync resolution is
    // required here because logAuditEvent is called everywhere without await.
    timestampBS: todayBs(),
    branchId: overrideBranchId || u.branchId,
  };

  setAuditTrail(withPrepended(auditTrail, auditItem));

  // Broadcast event to all active real-time SSE client connections
  broadcastChange({
    type: action,
    entity: module,
    branchId: auditItem.branchId,
  });

  // Persist to Postgres. Two paths:
  //  - `client` provided: the INSERT runs (and is awaited by the caller) on
  //    the caller's transaction, so the audit row commits or rolls back
  //    together with the business action it records. Insert failures abort
  //    the transaction — an audited action is never committed unlogged.
  //  - no `client` (demo mode / non-transactional callers): fire-and-forget
  //    best-effort insert; failures are logged, never silently dropped.
  const insertAudit = async (executor: { query: (sql: string, params: any[]) => Promise<any> }) => {
    await executor.query(
      `INSERT INTO audit_logs (id, user_email, user_name, action, module, details, timestamp_ad, timestamp_bs, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        auditItem.id,
        auditItem.userEmail,
        auditItem.userName,
        auditItem.action,
        auditItem.module,
        auditItem.details,
        auditItem.timestampBS,
        // 'ALL' is the app-wide "all branches" sentinel, not a real branch id —
        // store NULL so the branch_id FK is never violated.
        auditItem.branchId && auditItem.branchId !== 'ALL' ? auditItem.branchId : null,
      ]
    );
    return auditItem;
  };

  if (client) return insertAudit(client);
  // Demo mode (PostgreSQL down): the register lives in memory only; skip the
  // pool insert instead of spamming connection errors for every event.
  if (getPgConnected()) {
    insertAudit(pgPool).catch((e: any) => console.error('audit_logs persist failed:', auditItem.action, e?.message || e));
  }
  return auditItem;
}
