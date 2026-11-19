/**
 * Real-Redis, real-two-OS-process proof of the API-key RPM cap.
 *
 * Mirrors `scripts/verify_redis_invalidation.ts`: the parent is worker A, it
 * spawns worker B as a separate `tsx` process, and both serve the real Express
 * app on their own ports against the same PostgreSQL and Redis. The key has
 * `rpmLimit = 2`, so a budget that lived in process memory would give each
 * worker its own two requests.
 *
 *   worker A request 1 → 200      worker A request 2 → 200
 *   worker B request 3 → 429      (B sees A's usage: one shared budget)
 *   bucket deleted     → B 200, A 200            (Redis IS the counter)
 *   worker A request 3 → 429      (A sees B's usage too; both directions)
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run verify:apikey-rpm
 */
import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setUsers } from '../server/src/state/runtimeState';
import { getSharedStore, initializeSharedState, closeSharedState } from '../server/src/state/sharedStore';
import { API_KEY_RPM_NAMESPACE } from '../server/src/services/apiKeys.service';
import { ensurePostgresConnection, pgPool } from '../server/db';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const GATED = '/api/accounting/statements/trial-balance';
const ADMIN = {
  id: 'rpm-proof-admin',
  email: 'rpm-proof-admin@example.com',
  name: 'RPM Proof Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

async function startWorker(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createApp();
  registerAllRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as any).port,
    close: () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

async function call(port: number, path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}

/** Worker B: boot, announce its port, then wait to be stopped by the parent. */
if (process.argv[2] === 'worker-b') {
  await ensurePostgresConnection();
  await initializeSharedState({ REDIS_URL } as any);
  const worker = await startWorker();
  console.log(`WORKER_B_READY ${worker.port}`);
  await new Promise(() => undefined);
}

// ── Worker A (the parent process) ───────────────────────────────────────────
await ensurePostgresConnection();
await initializeSharedState({ REDIS_URL } as any);
setUsers([ADMIN]);
const workerA = await startWorker();
const token = issueAuthToken(ADMIN as any);

const child = spawn('npx', ['tsx', 'scripts/verify_apikey_rpm.ts', 'worker-b'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: true,
  env: process.env,
});

let workerBPort = 0;
let childOutput = '';
child.stdout?.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  childOutput += text;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    console.log(`  [worker B] ${line}`);
    const match = line.match(/WORKER_B_READY\s+(\d+)/);
    if (match) workerBPort = Number(match[1]);
  }
});

const deadline = Date.now() + 90_000;
while (!workerBPort && Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.error(`worker B exited before announcing its port (code ${child.exitCode})`);
    console.error(childOutput);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!workerBPort) {
  console.error('worker B did not announce a port within 90 s');
  child.kill();
  process.exit(1);
}

const cleanupKeys: string[] = [];
let failures = 0;
const check = (label: string, actual: number, expected: number, extra = '') => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual}${extra}${ok ? '' : ` (expected ${expected})`}`);
};

try {
  const created = await call(workerA.port, '/api/admin/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: `rpm cross-process proof ${Date.now()}`,
      operations: ['gl-view'],
      readOnly: true,
      rpmLimit: 2,
      expiresInDays: 1,
    }),
  });
  if (created.status !== 201) {
    console.error(`could not mint the proof key: ${created.status} ${created.body}`);
    process.exit(1);
  }
  const parsed = JSON.parse(created.body);
  const keyId: string = parsed.key.id;
  const secret: string = parsed.secret;
  cleanupKeys.push(keyId);
  const bucket = `isp:rate:${API_KEY_RPM_NAMESPACE}:${keyId}`;

  check('worker A request 1', (await call(workerA.port, GATED, { headers: { 'X-API-Key': secret } })).status, 200);
  check('worker A request 2', (await call(workerA.port, GATED, { headers: { 'X-API-Key': secret } })).status, 200);

  const third = await call(workerBPort, GATED, { headers: { 'X-API-Key': secret } });
  check('worker B request 3 (other OS process)', third.status, 429,
    third.headers.get('retry-after') ? ` Retry-After=${third.headers.get('retry-after')}` : '');
  if (third.status === 429 && !third.headers.get('retry-after')) {
    failures++;
    console.log('FAIL worker B 429 carried no Retry-After');
  }

  // If the budget lived in each process, deleting Redis state would change
  // nothing. It restores capacity, so the shared bucket is the decision.
  await getSharedStore().del(bucket);
  check('worker B after deleting the shared bucket', (await call(workerBPort, GATED, { headers: { 'X-API-Key': secret } })).status, 200);
  check('worker A after worker B spent one', (await call(workerA.port, GATED, { headers: { 'X-API-Key': secret } })).status, 200);
  check('worker A request 3 (A sees B usage too)', (await call(workerA.port, GATED, { headers: { 'X-API-Key': secret } })).status, 429);
} finally {
  child.kill();
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await workerA.close();

  const client = await pgPool.connect().catch(() => null);
  if (client) {
    try {
      await client.query("SELECT set_config('inventory.allow_ledger_purge', 'on', false)");
      for (const id of cleanupKeys) {
        await client.query('DELETE FROM api_key_audit_logs WHERE api_key_id = $1', [id]);
        await client.query('DELETE FROM api_keys WHERE id = $1', [id]);
      }
    } finally {
      client.release();
    }
  }
  await closeSharedState();
}

console.log(failures === 0
  ? 'PASS — two OS processes share one API-key RPM budget through Redis'
  : `FAIL — ${failures} assertion(s) did not hold`);
process.exit(failures === 0 ? 0 : 1);
