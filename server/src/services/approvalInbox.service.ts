/**
 * The approvals inbox.
 *
 * Three rules from the v2 design are enforced here rather than per screen:
 *
 *   - **No self-approval.** The approver can never be the requester, even when
 *     they hold the capability; the SQL already excludes the caller's rows and
 *     the decision path refuses one by id (`SELF_APPROVAL`).
 *   - **Delegation with an end date.** An active `hr_delegations` row that
 *     covers `approve.expense` lets the named delegate decide, and the audit
 *     row says it was delegated. Before this, delegations were written and
 *     never read, so they granted nothing.
 *   - **Scope is part of the grant.** The claim or punch must be in the
 *     approver's own branch, and the decision is a conditional UPDATE, so a
 *     second decision is a 409 instead of a rewrite.
 */
import { pgPool, permissionMatrix, userPermissionOverrides, userPermissionSetGrants } from '../app';
import { ApiError } from '../errors/ApiError';
import { effectivePermission } from './permissionOverrides.service';
import { logAuditEvent } from './audit.service';
import {
  cancelExpenseClaimPosting,
  queueExpenseClaimPosting,
} from './accountingOutbox.service';
import { withTransaction } from '../db/transactions';
import {
  APPROVAL_CLAIM_BY_ID_SQL,
  APPROVAL_CLAIM_DECIDE_SQL,
  APPROVAL_CLAIMS_PENDING_SQL,
  APPROVAL_DELEGATION_COVERS_SQL,
  APPROVAL_DELEGATIONS_FOR_SQL,
  APPROVAL_PUNCH_BY_ID_SQL,
  APPROVAL_PUNCH_REVIEW_SQL,
  APPROVAL_PUNCHES_PENDING_SQL,
} from '../models/approvalInbox.repo';

const APPROVAL_OPERATION = 'hr-attendance-manage';

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function holdsOperation(user: any): boolean {
  return effectivePermission(
    user,
    APPROVAL_OPERATION,
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

/** The delegation that authorises this decision, or null. */
async function delegationCovering(employeeId: string, capability: string): Promise<any | null> {
  const row = (await pgPool.query(APPROVAL_DELEGATION_COVERS_SQL, [employeeId, capability])).rows[0];
  return row || null;
}

async function assertApprovalRight(user: any, employee: any, capability: string): Promise<any | null> {
  if (holdsOperation(user)) return null;
  const delegation = await delegationCovering(String(employee.id), capability);
  if (!delegation) {
    throw new ApiError(
      403,
      `Forbidden: approving needs '${APPROVAL_OPERATION}' or an active delegation for ${capability}.`
    );
  }
  return delegation;
}

function assertOwnBranch(employee: any, rowBranchId: string): void {
  const user = employee?.branch_id ? String(employee.branch_id) : '';
  if (user && String(rowBranchId) !== user) {
    throw new ApiError(403, 'Forbidden: this record belongs to another branch.');
  }
}

/** GET /api/v1/workplace/approvals */
export async function listApprovals(employee: any): Promise<any> {
  const [claims, punches, delegations] = await Promise.all([
    pgPool.query(APPROVAL_CLAIMS_PENDING_SQL, [employee.branch_id, employee.id]),
    pgPool.query(APPROVAL_PUNCHES_PENDING_SQL, [employee.branch_id, employee.id]),
    pgPool.query(APPROVAL_DELEGATIONS_FOR_SQL, [employee.id]),
  ]);
  return {
    claims: claims.rows,
    punches: punches.rows,
    delegations: delegations.rows,
    counts: { claims: claims.rowCount || 0, punches: punches.rowCount || 0 },
  };
}

/** POST /api/v1/workplace/approvals/EXPENSE_CLAIM/:id */
export async function decideClaim(
  req: any,
  user: any,
  employee: any,
  claimId: string,
  body: any
): Promise<any> {
  if (typeof body?.approve !== 'boolean') {
    throw new ApiError(400, '`approve` must be true (approve) or false (reject).');
  }
  const claim = (await pgPool.query(APPROVAL_CLAIM_BY_ID_SQL, [text(claimId, 60)])).rows[0];
  if (!claim) throw new ApiError(404, 'Claim not found.');
  assertOwnBranch(employee, String(claim.branchId || ''));
  if (String(claim.employeeId) === String(employee.id)) {
    throw new ApiError(403, 'Forbidden: nobody may approve their own claim.');
  }
  const delegation = await assertApprovalRight(user, employee, 'approve.expense');
  // The decision and the accounting-outbox state commit together: an approved
  // claim always owes exactly one posting, and a rejected one owes none.
  const decision = await withTransaction(async (client) => {
    const decided = (
      await client.query(APPROVAL_CLAIM_DECIDE_SQL, [
        claim.id,
        body.approve ? 'APPROVED' : 'REJECTED',
        String(user?.email || employee.employee_code),
        text(body?.note, 500) || null,
      ])
    ).rows[0];
    if (!decided) return null;
    const outboxStatus = body.approve
      ? await queueExpenseClaimPosting(client, String(claim.id))
      : await cancelExpenseClaimPosting(client, String(claim.id));
    return { decided, outboxStatus };
  });
  if (!decision) throw new ApiError(409, 'This claim was already decided.');
  const { decided, outboxStatus } = decision;
  await logAuditEvent(
    req,
    'MOBILE_CLAIM_DECISION',
    'OPERATIONS',
    `${body.approve ? 'Approved' : 'Rejected'} claim ${claim.id} (${delegation ? `delegated from ${delegation.delegatorEmployeeId}` : 'own authority'})`,
    String(employee.branch_id)
  );
  return {
    id: decided.id,
    status: decided.status,
    accountingOutboxStatus: outboxStatus,
    decidedAt: decided.decidedAt,
    decidedBy: decided.decidedBy,
    delegated: Boolean(delegation),
  };
}

/** POST /api/v1/workplace/approvals/PUNCH/:attendanceId */
export async function reviewPunch(
  req: any,
  user: any,
  employee: any,
  attendanceId: string,
  body: any
): Promise<any> {
  const punch = (await pgPool.query(APPROVAL_PUNCH_BY_ID_SQL, [text(attendanceId, 60)])).rows[0];
  if (!punch) throw new ApiError(404, 'Attendance record not found.');
  assertOwnBranch(employee, String(punch.branchId || ''));
  if (String(punch.employeeId) === String(employee.id)) {
    throw new ApiError(403, 'Forbidden: nobody may review their own punch.');
  }
  const delegation = await assertApprovalRight(user, employee, 'approve.attendance_ot');
  const reviewed = (
    await pgPool.query(APPROVAL_PUNCH_REVIEW_SQL, [
      punch.attendanceId,
      String(user?.email || employee.employee_code),
      text(body?.note, 500) || 'Confirmed by supervisor',
    ])
  ).rows[0];
  if (!reviewed) throw new ApiError(409, 'This punch was already reviewed.');
  await logAuditEvent(
    req,
    'MOBILE_PUNCH_REVIEW',
    'OPERATIONS',
    `Reviewed ${punch.verdict} punch ${punch.attendanceId} (${body?.note ? text(body.note, 120) : 'confirmed'})`,
    String(employee.branch_id)
  );
  return {
    attendanceId: reviewed.attendanceId,
    reviewedAt: reviewed.reviewedAt,
    reviewedBy: String(user?.email || employee.employee_code),
    verdict: punch.verdict,
    delegated: Boolean(delegation),
  };
}
