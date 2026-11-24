/**
 * Sensitive-read gate for the mobile surface.
 *
 * Payslips, PAN/SSF/bank details and documents are not readable with the normal
 * 8-hour session token: the phone asks for the account password again and gets
 * a short-lived elevation token bound to that user id. The token is signed with
 * the same secret as the session token but under its own HMAC prefix, so a
 * session token can never be replayed as an elevation token or vice versa.
 */
import { verifySensitiveToken } from './auth';
import { logAuditEvent } from '../services/audit.service';

export const REAUTH_HEADER = 'x-reauth-token';

/**
 * Require a fresh elevation for this request. A missing, expired or mismatched
 * token is a 401 with `REAUTH_REQUIRED` so the app can show its PIN/biometric
 * prompt instead of treating it as a dead session.
 */
export function requireSensitiveAuth(req: any, res: any, next: any) {
  const user = req.user;
  if (!user || !user.email) {
    return res.status(401).json({ message: 'Unauthorized: Authentication required' });
  }
  const header = req.headers?.[REAUTH_HEADER];
  const token = typeof header === 'string' ? header.trim() : '';
  const subject = token ? verifySensitiveToken(token) : null;
  if (!subject || subject !== String(user.id)) {
    return res.status(401).json({
      code: 'REAUTH_REQUIRED',
      retryable: false,
      message: 'Confirm your password again before opening this record.',
    });
  }
  return next();
}

/**
 * Write one audit row per open of a sensitive screen, before its data is sent.
 *
 * The v2 design asks for a record of who looked at a payslip or a document on
 * which phone; the action names the record and the module is AUTH, because the
 * question after a lost device is "what did that session unlock", not "what did
 * payroll change".
 */
export function auditSensitiveRead(action: string, label: string) {
  return async (req: any, _res: any, next: any) => {
    await logAuditEvent(
      req,
      action,
      'AUTH',
      `${label} opened from the app`,
      String(req.user?.branchId || '')
    );
    next();
  };
}
