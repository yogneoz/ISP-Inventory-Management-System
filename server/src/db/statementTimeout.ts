/**
 * SCALE-3 — `statement_timeout` as server-side role configuration, not a
 * per-connection startup parameter.
 *
 * OPS-4 sent `statement_timeout` to PostgreSQL in the startup packet, which is
 * correct only while every client owns its connection. Behind a transaction-mode
 * pooler it is not: PgBouncer reuses one server connection for many clients and
 * does not replay a client's startup parameters, so the timeout would either be
 * ignored or make the connection fail as an unsupported startup parameter. The
 * pooler also cannot restore it after a client disconnects, so it must not be
 * part of the client's session at all.
 *
 * The pool-safe place is the role: `ALTER ROLE … SET statement_timeout` is applied
 * to every server connection that logs in as that role, whichever pooler opened
 * it, and survives a server/connection swap. It is idempotent — boot compares the
 * effective setting and only issues the ALTER when it differs, so an operator's
 * own value is never rewritten on every restart.
 *
 * `PG_STATEMENT_TIMEOUT_MS=0` still means "disabled" and becomes
 * `statement_timeout = '0'`.
 */
import { intFromEnv } from '../utils/envGuard';

/** The value PostgreSQL is given: milliseconds, or '0' for disabled. */
export function statementTimeoutValue(ms: number): string {
  return ms > 0 ? `${ms}ms` : '0';
}

/**
 * The DDL, with the role and value quoted by PostgreSQL itself (`format('%I',
 * '%L')`) rather than by string building, so a role with quotes in its name
 * cannot turn this into a different statement.
 */
export const ROLE_STATEMENT_TIMEOUT_DDL_SQL =
  `SELECT format('ALTER ROLE %I SET statement_timeout = %L', current_user, $1::text) AS ddl`;

/** Effective value on this connection, e.g. '30s' or '0'. */
export const CURRENT_STATEMENT_TIMEOUT_SQL = `SELECT current_setting('statement_timeout') AS value`;

/**
 * The value configured ON THE ROLE (not the session's effective value, which
 * `ALTER ROLE` does not change for connections that already exist). `NULL` when
 * the role sets no statement_timeout at all.
 */
export const ROLE_STATEMENT_TIMEOUT_CONFIGURED_SQL = `
SELECT option AS configured
  FROM pg_roles r, unnest(COALESCE(r.rolconfig, ARRAY[]::text[])) AS option
 WHERE r.rolname = current_user AND option LIKE 'statement_timeout=%'
 LIMIT 1`;

/**
 * The value configured on the role, or `null` when the role sets none. Used by
 * boot (idempotence) and by tests that must leave the role exactly as they found
 * it.
 */
export async function readRoleStatementTimeout(client: {
  query: (text: string) => Promise<any>;
}): Promise<string | null> {
  const row = await client.query(ROLE_STATEMENT_TIMEOUT_CONFIGURED_SQL);
  const configured = String(row.rows[0]?.configured ?? '').replace(/^statement_timeout=/, '');
  return configured || null;
}

/** Compare two PostgreSQL interval strings ('30000ms' vs '30s') for equality. */
export const SAME_INTERVAL_SQL = `SELECT $1::text::interval = $2::text::interval AS same`;

export type RoleStatementTimeoutResult = {
  changed: boolean;
  target: string;
  previous: string;
};

/**
 * Apply `PG_STATEMENT_TIMEOUT_MS` to the connected role. Returns whether the
 * role was changed, so the boot log can say which happened. Must run on the
 * primary, before the request path starts.
 */
export async function ensureRoleStatementTimeout(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  ms: number,
  log: (message: string) => void = (message) => console.log(message)
): Promise<RoleStatementTimeoutResult> {
  const target = statementTimeoutValue(ms);
  const current = await client.query(CURRENT_STATEMENT_TIMEOUT_SQL);
  const previous = String(current.rows[0]?.value ?? '');
  // What matters is what the ROLE carries, not this session's effective value
  // (`ALTER ROLE` only affects connections opened afterwards). PostgreSQL may
  // render the stored value as '30000ms' or '30s', so compare intervals.
  const configured = await readRoleStatementTimeout(client);
  if (configured) {
    const same = await client.query(SAME_INTERVAL_SQL, [target, configured]);
    if (same.rows[0]?.same === true) return { changed: false, target, previous };
  }
  const ddl = await client.query(ROLE_STATEMENT_TIMEOUT_DDL_SQL, [target]);
  await client.query(ddl.rows[0].ddl);
  log(
    `✅ statement_timeout set on the database role to ${target} (was ${previous || 'unset'}) — pool-safe under PgBouncer transaction pooling.`
  );
  return { changed: true, target, previous };
}
