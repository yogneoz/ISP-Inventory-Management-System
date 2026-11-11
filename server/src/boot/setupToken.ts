/**
 * One-time Super Admin setup token (audit finding C1).
 *
 * `/api/auth/setup-superadmin` is reachable before sign-in by design — the first
 * account has to come from somewhere. What that endpoint must never allow is an
 * ANONYMOUS caller creating the highest-privilege account, which is what the
 * check-then-act existence probe allowed whenever `users` held no SUPER_ADMIN
 * row (a demoted admin, a restored dump, a half-finished seed).
 *
 * The gate is a secret that only an operator with server access can read:
 *
 *   - `SETUP_TOKEN` in the environment when the deployment sets one (the
 *     recommended form: it survives restarts and is easy to inject from a
 *     secret store), or
 *   - a random token generated once at boot and printed to the server log.
 *
 * The token is consumed by the first successful claim, so it cannot be replayed
 * to create a second Super Admin. Verification is constant-time and compares
 * whole buffers, so a wrong token reveals nothing about the right one.
 *
 * Kept free of Express/DB imports so the rules are unit-testable without
 * booting a server.
 */
import crypto from 'crypto';

export const SETUP_TOKEN_ENV = 'SETUP_TOKEN';

/**
 * A token shorter than this is guessable enough to defeat the gate. The
 * generated fallback is 36 hex characters (144 bits); this floor only applies
 * to an operator-supplied value.
 */
export const SETUP_TOKEN_MIN_LENGTH = 16;

export type SetupTokenSource = 'env' | 'generated';

interface ActiveToken {
  token: string;
  source: SetupTokenSource;
}

let active: ActiveToken | null = null;

/**
 * Resolve the token this process will accept. Called once at boot.
 *
 * An env value that is present but too short is a configuration error, not a
 * silent fallback: a deployment that believes it set a token must not end up
 * with a generated one nobody reads from the log.
 */
export function resolveSetupToken(env: { [SETUP_TOKEN_ENV]?: string }): ActiveToken {
  const fromEnv = String(env[SETUP_TOKEN_ENV] || '').trim();
  if (fromEnv) {
    if (fromEnv.length < SETUP_TOKEN_MIN_LENGTH) {
      throw new Error(
        `${SETUP_TOKEN_ENV} must be at least ${SETUP_TOKEN_MIN_LENGTH} characters. ` +
          'Generate one with `node -e "console.log(require(\'crypto\').randomBytes(18).toString(\'hex\'))"` ' +
          'or remove it to have the server print a one-time token at boot.'
      );
    }
    active = { token: fromEnv, source: 'env' };
    return active;
  }

  active = { token: crypto.randomBytes(18).toString('hex'), source: 'generated' };
  return active;
}

/** The token currently accepted, or null once a claim has consumed it. */
export function getSetupToken(): string | null {
  return active?.token ?? null;
}

export function getSetupTokenSource(): SetupTokenSource | null {
  return active?.source ?? null;
}

/** Constant-time comparison against the live token. */
export function verifySetupToken(candidate: unknown): boolean {
  const expected = active?.token;
  if (!expected) return false;
  const supplied = typeof candidate === 'string' ? candidate.trim() : '';
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  if (expectedBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/**
 * Read the token a first-launch request carries: the `x-setup-token` header, or
 * `setupToken` in the JSON body (the setup form posts it there so the request
 * needs no special header handling in the client's request pipeline).
 */
export function setupTokenFromRequest(req: any): string {
  const header = req?.headers?.['x-setup-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const body = req?.body;
  if (body && typeof body === 'object' && typeof body.setupToken === 'string') {
    return body.setupToken.trim();
  }
  return '';
}

/**
 * Retire the token after the first Super Admin is created. Setup is a
 * one-time act; a live token afterwards would be a standing invitation.
 */
export function consumeSetupToken(): void {
  active = null;
}

/** Test seam only — production never needs to re-arm a consumed token. */
export function resetSetupTokenForTests(): void {
  active = null;
}
