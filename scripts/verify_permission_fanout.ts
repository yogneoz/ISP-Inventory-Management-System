/**
 * Real-Redis, two-process proof of the C2 permission fan-out (audit 2026-11-28).
 *
 * C2 was the finding that `permission_matrix`, the per-user overrides and the
 * permission-set grants were published to the *serving* worker's memory only:
 * they are not `CACHE_LOADS` entries and their setters never announced, so under
 * `instances: 'max'` `requirePermission` enforced whichever copy of the matrix
 * the load balancer's worker happened to hold — a revoked grant stayed usable
 * and a newly granted one kept answering 403. The fix routes the three setters
 * through the shared cache bus under the reserved name `permissions`.
 * `tests/referenceCacheInvalidation.test.ts` pins that announcement, but it
 * shares one process. This script is the half a single process cannot show:
 *
 *   worker B  (a CHILD PROCESS) subscribes to `isp:cache:invalidated`, hydrates
 *             its three RBAC caches from PostgreSQL, and evaluates the real
 *             resolver — `effectivePermission`, the function `requirePermission`
 *             calls — for a temp user on an operation its role does not have. It
 *             must DENY.
 *   worker A  (this process) commits a `grant` override for that user and tells
 *             worker B it is committed. Worker B must STILL DENY: a committed row
 *             alone changes nothing on a worker that has not been told, which is
 *             precisely the defect C2 was.
 *   worker A  then publishes exactly as `permissions.controller.ts` does after
 *             COMMIT: it reads the rows back and calls
 *             `setUserPermissionOverrides`, whose write hook announces
 *             `permissions` on the bus.
 *   worker B  receives the message, re-reads all three tables together, and must
 *             now ALLOW the same operation, with `permissionsVersion` higher.
 *
 * Nothing is shared between the two processes but the database and the bus: two
 * OS processes, one real Redis server, real PostgreSQL.
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run verify:permissions-fanout
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { initializeSharedState, closeSharedState } from '../server/src/state/sharedStore';
import {
  CACHE_INVALIDATION_CHANNEL,
  startReferenceCacheInvalidation,
  stopReferenceCacheInvalidation,
  reloadReferenceCache,
} from '../server/src/state/cacheInvalidation';
import {
  permissionMatrix,
  userPermissionOverrides,
  userPermissionSetGrants,
  setUserPermissionOverrides,
} from '../server/src/state/runtimeState';
import {
  effectivePermission,
  getPermissionsVersion,
  roleBaseAllowed,
} from '../server/src/services/permissionOverrides.service';
import {
  USER_PERMISSION_OVERRIDES_SELECT_SQL,
  rowsToUserPermissionOverrideMap,
} from '../server/src/models/permissions.repo';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { pgPool, ensurePostgresConnection } from '../server/db';

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const PROOF_USER = 'TMPC2-FANOUT';
const PROOF_EMAIL = 'tmp-c2-fanout@local.invalid';
const PROOF_ROLE = 'AUDITOR';

const PROOF_SUBJECT = { id: PROOF_USER, role: PROOF_ROLE };

/** The same resolution `requirePermissionAny` performs for this user. */
function allowed(operation: string): boolean {
  return effectivePermission(
    PROOF_SUBJECT,
    operation,
    permissionMatrix,
    userPermissionOverrides,
    userPermissionSetGrants
  );
}

/** The role's own answer is no AND no exception opens it: a closed gate. */
function closed(operation: string): boolean {
  return !roleBaseAllowed(PROOF_SUBJECT, operation, permissionMatrix) && !allowed(operation);
}

/** Resolves on the next line worker A writes to this process's stdin. */
function nextInstruction(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData);
      resolve(chunk.toString().trim());
    };
    process.stdin.on('data', onData);
  });
}

if (process.argv[2] === 'worker-b') {
  await ensurePostgresConnection();
  await initializeSharedState({ REDIS_URL: URL } as any);
  if (!(await startReferenceCacheInvalidation({ origin: 'worker-B' }))) {
    console.error('worker B could not subscribe - is REDIS_URL a live Redis server?');
    process.exit(2);
  }
  await reloadReferenceCache('permissions');

  const operation = Object.keys(DEFAULT_PERMISSIONS_MATRIX).sort().find(closed);
  if (!operation) {
    console.error(
      'worker B has no closed gate to open: every catalogued operation is already allowed for the proof role.'
    );
    process.exit(2);
  }
  const versionBefore = getPermissionsVersion();
  console.log(
    `worker B before: "${operation}" is DENIED for ${PROOF_ROLE} ` +
      `(matrix, overrides and set grants all say no), permissionsVersion ${versionBefore}`
  );
  console.log(`worker B READY ${operation}`);

  if ((await nextInstruction()) !== 'COMMITTED') {
    console.error('worker B expected "COMMITTED" on stdin');
    process.exit(2);
  }
  // The negative control. The grant row is committed and visible to any fresh
  // query, and this worker still refuses: a worker that is not told keeps
  // enforcing the old answer, which is exactly what C2 was.
  if (allowed(operation)) {
    console.error(
      `worker B already ALLOWS "${operation}" without a message - the fixture does not prove delivery.`
    );
    process.exit(2);
  }
  console.log(
    `worker B after commit: STILL DENIES "${operation}" with the row committed in PostgreSQL`
  );
  console.log('worker B WAITING for the invalidation');

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !allowed(operation)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const nowAllowed = allowed(operation);
  const versionAfter = getPermissionsVersion();
  console.log(
    nowAllowed
      ? `worker B RESULT: now ALLOWS "${operation}" for ${PROOF_USER} ` +
          `(permissionsVersion ${versionBefore} -> ${versionAfter}) after the Redis message`
      : `worker B RESULT: still DENIES "${operation}" after 20s - the invalidation never reached this worker`
  );
  stopReferenceCacheInvalidation();
  await closeSharedState();
  process.exit(nowAllowed && versionAfter > versionBefore ? 0 : 1);
}

// ---------------------------------------------------------------------------
// worker A — the writing worker
// ---------------------------------------------------------------------------
async function cleanupFixture(): Promise<void> {
  await pgPool.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [PROOF_USER]).catch(() => {});
  await pgPool.query('DELETE FROM users WHERE id = $1', [PROOF_USER]).catch(() => {});
}

let child: ReturnType<typeof spawn> | null = null;
let published = false;
let childCode = 1;

try {
  await ensurePostgresConnection();
  await cleanupFixture();
  await pgPool.query(
    `INSERT INTO users (id, email, password, name, role, is_demo)
     VALUES ($1, $2, 'proof', 'C2 fan-out proof', $3, TRUE)`,
    [PROOF_USER, PROOF_EMAIL, PROOF_ROLE]
  );

  const store = await initializeSharedState({ REDIS_URL: URL } as any);
  const announced: string[] = [];
  await store.subscribe(CACHE_INVALIDATION_CHANNEL, (raw) => announced.push(raw));
  await startReferenceCacheInvalidation({ store, origin: 'worker-A' });

  child = spawn('npx', ['tsx', 'scripts/verify_permission_fanout.ts', 'worker-b'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: true,
    env: process.env,
  });

  // One permanent relay: every line worker B prints is echoed here (so the run
  // reads as one log) and kept for the step markers below. A listener that is
  // added and removed per step would drop whatever the child printed between
  // them.
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    buffer += text;
  });
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve) => {
    child!.on('exit', (code) => {
      exitCode = code ?? 1;
      resolve(exitCode);
    });
  });

  const waitForChildLine = async (pattern: RegExp): Promise<string> => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const match = buffer.match(pattern);
      if (match) {
        buffer = buffer.slice(buffer.indexOf(match[0]) + match[0].length);
        return match[1] ?? '';
      }
      if (exitCode !== null) {
        throw new Error(`worker B exited (${exitCode}) before it reached the next step`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`worker B did not reach "${pattern.source}" within 25s`);
  };

  const operation = await waitForChildLine(/worker B READY (\S+)/);

  // The committed write — exactly what the controller does inside its
  // transaction, before anybody is told.
  await pgPool.query(
    `INSERT INTO user_permission_overrides (user_id, operation_id, effect, reason, created_by)
     VALUES ($1, $2, 'grant', 'C2 cross-worker fan-out proof (scripts/verify_permission_fanout.ts)', $1)
     ON CONFLICT (user_id, operation_id)
     DO UPDATE SET effect = 'grant', reason = EXCLUDED.reason, expires_at = NULL, updated_at = CURRENT_TIMESTAMP`,
    [PROOF_USER, operation]
  );
  child.stdin!.write('COMMITTED\n');
  await waitForChildLine(/worker B WAITING for the invalidation/);

  // ... and the publish step the controller performs after COMMIT. The
  // announcement itself comes from the write hook inside the setter, not from a
  // manual publish — that is the code path C2 added.
  const rows = await pgPool.query(USER_PERMISSION_OVERRIDES_SELECT_SQL);
  setUserPermissionOverrides(rowsToUserPermissionOverrideMap(rows.rows));

  const sawPermissionMessage = () =>
    announced.some((raw) => {
      try {
        return JSON.parse(raw)?.name === 'permissions';
      } catch {
        return false;
      }
    });
  const announceDeadline = Date.now() + 5000;
  while (Date.now() < announceDeadline && !sawPermissionMessage()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  published = sawPermissionMessage();
  console.log(`worker A announced "permissions" through the cache write hook: ${published}`);

  childCode = await exited;
} catch (err: any) {
  console.error('permission fan-out proof failed:', err?.message || err);
  if (child) (child as any).kill?.();
  childCode = 1;
} finally {
  await cleanupFixture();
  stopReferenceCacheInvalidation();
  await closeSharedState().catch(() => {});
}

process.exit(childCode === 0 && published ? 0 : 1);
