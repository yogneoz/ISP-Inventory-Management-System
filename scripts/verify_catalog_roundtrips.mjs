/**
 * Catalog round-trip proof (SCALE-3).
 *
 * Counts PostgreSQL round trips at the pooler itself — `SHOW STATS`
 * `total_query_count` on the PgBouncer admin console — around one catalog write
 * and the reads that follow it, so the claim "this read costs no PostgreSQL work"
 * is measured on the wire rather than inferred from the code.
 *
 * Usage (server running against a PgBouncer, in transaction mode):
 *   BASE_URL=http://localhost:3100 npm run verify:catalog-roundtrips
 *   POOLER_ADMIN_PORT=56440 PGBOUNCER_ADMIN_USER=... npm run verify:catalog-roundtrips
 *
 * Run it twice to see both columns of the report: once with `REDIS_URL` set on
 * the server (repeat read = 0 round trips) and once without it (repeat read = 1).
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const EMAIL = process.env.SMOKE_USER_EMAIL || 'superadmin@example.com';
const PASSWORD = process.env.SMOKE_USER_PASSWORD || 'Demo@123';
const PSQL = process.env.PSQL_BIN || 'psql';
const ADMIN_PORT = process.env.POOLER_ADMIN_PORT || '56440';
const ADMIN_DB = process.env.POOLER_ADMIN_DB || 'pgbouncer';

function databaseUrl() {
  return (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
}

function connectionParts() {
  const url = new URL(databaseUrl() || 'postgresql://inventory_user:securepassword@127.0.0.1:56440/inventory_db');
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: url.pathname.replace(/^\//, '') || 'inventory_db',
  };
}

/** PostgreSQL round trips served for `db`, straight from the pooler's own counters. */
function stats(db) {
  const out = execFileSync(
    PSQL,
    ['-h', '127.0.0.1', '-p', ADMIN_PORT, '-U', connectionParts().user, ADMIN_DB, '--csv', '-t', '-c', 'SHOW STATS'],
    { env: { ...process.env, PGPASSWORD: connectionParts().password }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const line of out.trim().split(/\r?\n/)) {
    const cells = line.split(',');
    // database, total_xact_count, total_query_count, ...
    if (cells[0] === db) return Number(cells[2]);
  }
  throw new Error(`no SHOW STATS row for database "${db}" — has the app connected through the pooler yet?`);
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  const token = login.token || login.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login).slice(0, 200)}`);
  const auth = { authorization: `Bearer ${token}` };

  const db = connectionParts().db;
  const id = `rt-${Date.now()}`;
  const rows = [];
  let fresh = false;

  const step = async (label, fn) => {
    const before = stats(db);
    const t0 = performance.now();
    const res = await fn();
    const ms = performance.now() - t0;
    const after = stats(db);
    rows.push({ label, status: res.status, queries: after - before, ms: ms.toFixed(1) });
    return res;
  };

  await step('POST /api/locations (one catalog write)', () =>
    fetch(`${BASE}/api/locations`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: `RT probe ${id}`, type: 'STORE', branchId: 'WH001', address: 'RT probe' }),
    })
  );
  const first = await step('GET /api/locations (read right after the write)', () => fetch(`${BASE}/api/locations`, { headers: auth }));
  const body = await first.json();
  fresh = Array.isArray(body) && body.some((l) => l.id === id);
  await step('GET /api/locations (repeat read)', () => fetch(`${BASE}/api/locations`, { headers: auth }));
  await step('DEL /api/locations/:id (one catalog delete)', () => fetch(`${BASE}/api/locations/${id}`, { method: 'DELETE', headers: auth }));

  console.log(`the read right after the write returned the committed row: ${fresh ? 'yes' : 'NO — STALE'}`);
  console.log('step'.padEnd(50) + ' status  PG round trips  ms');
  for (const r of rows) {
    console.log(r.label.padEnd(50) + ` ${String(r.status).padEnd(7)} ${String(r.queries).padEnd(15)} ${r.ms}`);
  }
  if (!fresh) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
