/**
 * SSE auth (audit backlog #2): /api/sync/stream was a public route — anyone
 * who could reach the server got a live change feed (product/stock/customer
 * events) with zero credentials. The global requireAuth gate in app.ts
 * explicitly exempted '/sync/stream' (and '/sync/version') because the
 * browser's native EventSource cannot send an Authorization header.
 *
 * Fix: a dedicated SSE auth middleware that accepts the same HMAC token the
 * app already issues, delivered via EITHER:
 *   - the standard 'Authorization: Bearer <token>' header (testable, and used
 *     by fetch-based reconnects), or
 *   - the 'token' query parameter (?token=<token>) — the standard workaround
 *     for EventSource's missing-header limitation.
 *
 * The client (client/src/services/api/sync.ts) is updated to append the token
 * from localStorage ('inventory_auth_token') to the stream URL, so
 * authenticated browser sessions reconnect transparently. Token in a query
 * string can leak into server/proxy logs; acceptable here because the app
 * runs on the company's own single server over a trusted LAN (per the
 * user's single-instance deployment decision) and the token is the same
 * short-lived (8h) HMAC credential as every other request.
 *
 * Unauthenticated requests are rejected with 401 BEFORE any SSE handshake,
 * so no stream, keep-alive timer or client registration is created.
 */
import type { Request, Response, NextFunction } from 'express';
import { verifyAuthToken } from './auth';

export function requireSseAuth(req: Request, res: Response, next: NextFunction) {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof (req.query as any)?.token === 'string' ? String((req.query as any).token).trim() : '';
  const token = headerToken || queryToken;

  const user = token ? verifyAuthToken(token) : null;
  if (!user || !user.email) {
    return res.status(401).json({ message: 'Unauthorized: a valid token is required to access the sync stream.' });
  }
  (req as any).user = user;
  next();
}

/**
 * Standard (non-SSE) sync endpoints, e.g. GET /api/sync/version: same token
 * rules, so polling clients can authenticate via header or query parameter.
 */
export const requireSseAuthPlain = requireSseAuth;
