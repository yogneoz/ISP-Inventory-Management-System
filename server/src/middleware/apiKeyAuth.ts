/**
 * Partner API-key authentication (Round 14 Part C).
 *
 * Accepts `X-API-Key: isp_live_…` or `Authorization: Bearer isp_live_…` (the SSE
 * transport and any HTTP client can send either). A key is *not* a session: it
 * resolves one row by prefix, verifies sha256(secret) in constant time, checks
 * active/expiry/CIDR/RPM, and then sets a synthetic principal so every existing
 * guard keeps working unchanged:
 *
 *   - `requirePermission(operation)` consults the key's operation list (a key
 *     never receives the Super Admin override),
 *   - `enforceBranchAccess` sees `branchId`/`allowedBranchIds` from the key,
 *   - `enforceFiscalYearWriteAccess` sees role `API_KEY`, so a closed year still
 *     refuses a write and no key may use the Super Admin override.
 *
 * The `read_only` flag is enforced HERE, before RBAC, because one operation
 * name often guards a GET and a POST route: operation scoping alone would let a
 * read-only key write.
 */
import { authenticateApiKey } from '../services/apiKeys.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function apiKeyAuth(req: any, res: any, next: any) {
  const headerKey = typeof req.headers?.['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  const authorization = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const token = headerKey || (bearer.startsWith('isp_live_') ? bearer : '');
  if (!token) return next();

  try {
    const verdict = await authenticateApiKey(token, req.ip ?? null);
    if (!verdict.ok) {
      return res.status(verdict.status).json({ message: verdict.reason, code: verdict.code });
    }
    if (verdict.user.apiKeyReadOnly && !READ_METHODS.has(String(req.method || '').toUpperCase())) {
      return res.status(403).json({
        message: `This API key is read-only; ${req.method} is refused before RBAC runs.`,
        code: 'API_KEY_READ_ONLY',
      });
    }
    req.user = verdict.user;
    req.apiKey = verdict.key;
    return next();
  } catch (err: any) {
    // A key that cannot be verified is not a key. Fail closed, as the session
    // path does when shared state is unavailable.
    console.error('API key verification failed:', err?.message || err);
    return res.status(503).json({
      message: 'API key verification is temporarily unavailable. Retry shortly.',
      code: 'SHARED_STATE_UNAVAILABLE',
    });
  }
}
