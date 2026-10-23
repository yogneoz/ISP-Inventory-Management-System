/**
 * Production auth-secret guard (architecture backlog D1/D2).
 *
 * `middleware/auth.ts` signs login tokens with `AUTH_TOKEN_SECRET`, falling back
 * to a per-process `crypto.randomBytes(32)` value when the variable is unset.
 * That fallback is convenient in development and test, and dangerous in
 * production: every restart (pm2 restarts this process at 1 GB of memory)
 * silently invalidates every signed-in session, and a second instance could
 * never verify tokens signed by the first.
 *
 * D1 + D2 therefore make production refuse to boot unless the secret is
 * present, carries enough entropy for HMAC-SHA256, and is not one of the
 * template values published in `.env.example` / the README. The check is a pure
 * function of the environment so every rule is unit-testable without starting a
 * server, and `server/index.ts` routes a failure through the one lifecycle
 * exit path (`failBoot`) before the database is touched or the port opens.
 *
 * Development and test are deliberately untouched: `tsx watch` keeps serving
 * with the ephemeral secret (and its warning) so a fresh clone works before any
 * `.env` exists.
 */

/** HMAC-SHA256 keys shorter than this are not worth accepting in production. */
export const AUTH_SECRET_MIN_LENGTH = 32;

/**
 * Values that ship in templates and docs. They are public, so a deployment that
 * kept one is not just weak — it is forgeable by anyone who read the repo.
 * Compared case-insensitively.
 */
export const AUTH_SECRET_PLACEHOLDERS: readonly string[] = [
  'replace-with-a-long-random-production-secret',
  'your-secret-here',
  'your_secret_here',
  'changeme',
  'change-me',
  'secret',
];

export interface AuthSecretEnv {
  NODE_ENV?: string;
  AUTH_TOKEN_SECRET?: string;
}

export type AuthSecretIssue = 'missing' | 'placeholder' | 'too-short';

export type AuthSecretCheck =
  | { ok: true }
  | { ok: false; issue: AuthSecretIssue; message: string };

const GENERATE_HINT =
  'Generate one with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
  'and set it in .env (or in the process manager environment).';

/**
 * Decide whether the process may boot. Only production is enforced; every other
 * environment keeps the ephemeral fallback documented in `middleware/auth.ts`.
 */
export function validateAuthSecret(env: AuthSecretEnv): AuthSecretCheck {
  if (env.NODE_ENV !== 'production') return { ok: true };

  const secret = (env.AUTH_TOKEN_SECRET || '').trim();
  if (!secret) {
    return {
      ok: false,
      issue: 'missing',
      message:
        'AUTH_TOKEN_SECRET is required in production. ' +
        GENERATE_HINT +
        ' Without a persistent secret every restart invalidates all sessions, and a second ' +
        'instance cannot verify tokens signed by the first.',
    };
  }

  if (AUTH_SECRET_PLACEHOLDERS.includes(secret.toLowerCase())) {
    return {
      ok: false,
      issue: 'placeholder',
      message:
        `AUTH_TOKEN_SECRET is still the template placeholder ("${secret}"). ` +
        GENERATE_HINT +
        ' A value published in .env.example is public and must never sign real sessions.',
    };
  }

  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    return {
      ok: false,
      issue: 'too-short',
      message:
        `AUTH_TOKEN_SECRET is only ${secret.length} characters; use at least ` +
        `${AUTH_SECRET_MIN_LENGTH}. ` +
        GENERATE_HINT,
    };
  }

  return { ok: true };
}
