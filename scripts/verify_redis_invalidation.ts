/**
 * Real-Redis proof of the catalog invalidation path (SCALE-3/OPS-2).
 *
 * Two separate OS processes, one real Redis server, one real PostgreSQL:
 *   worker B  subscribes to `isp:cache:invalidated` and hydrates its `branches`
 *             binding, which does NOT contain the proof row;
 *   worker A  writes the row to PostgreSQL and publishes the invalidation;
 *   worker B  re-runs its `CACHE_LOADS.branches` query and now sees the row.
 *
 * That is the guarantee the write-path work relies on: the worker that took a
 * write serves it immediately (staleness 0, asserted in
 * tests/adminPerformance.api.test.ts), and every other worker converges from the
 * database on the invalidation message rather than on a restart.
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm run verify:redis-invalidation
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { initializeSharedState, closeSharedState } from '../server/src/state/sharedStore';
import {
  reloadReferenceCache,
  publishReferenceCacheInvalidation,
  startReferenceCacheInvalidation,
  stopReferenceCacheInvalidation,
} from '../server/src/state/cacheInvalidation';
import { branches } from '../server/src/state/runtimeState';
import { pgPool, ensurePostgresConnection } from '../server/db';

const URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const ID = 'TMPREDIS-WORKER';
const has = () => branches.some((row: any) => String(row.id) === ID);

if (process.argv[2] === 'subscribe') {
  await ensurePostgresConnection();
  await initializeSharedState({ REDIS_URL: URL } as any);
  const subscribed = await startReferenceCacheInvalidation({ origin: 'worker-B' });
  if (!subscribed) {
    console.error('worker B could not subscribe — is REDIS_URL a live Redis server?');
    process.exit(2);
  }
  await reloadReferenceCache('branches');
  console.log(`worker B before: ${has() ? 'row PRESENT (stale fixture!)' : 'row absent'}`);
  if (has()) process.exit(2);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !has()) await new Promise((resolve) => setTimeout(resolve, 250));
  const sawIt = has();
  console.log(
    sawIt
      ? 'worker B RESULT: reloaded its binding from PostgreSQL after the Redis message'
      : 'worker B RESULT: never saw the row — invalidation did not reach this worker'
  );
  stopReferenceCacheInvalidation();
  await closeSharedState();
  process.exit(sawIt ? 0 : 1);
}

const child = spawn('npx', ['tsx', 'scripts/verify_redis_invalidation.ts', 'subscribe'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
await new Promise((resolve) => setTimeout(resolve, 6000));

await ensurePostgresConnection();
await pgPool.query(
  `INSERT INTO branches (id, code, name, location, is_demo)
   VALUES ($1, $1, 'Redis invalidation proof', 'Test', FALSE)
   ON CONFLICT (id) DO NOTHING`,
  [ID]
);
await initializeSharedState({ REDIS_URL: URL } as any);
await startReferenceCacheInvalidation({ origin: 'worker-A' });
const published = await publishReferenceCacheInvalidation('branches', { origin: 'worker-A' });
console.log(`worker A published over Redis: ${published}`);

const code = await new Promise<number>((resolve) => child.on('exit', (exit) => resolve(exit ?? 1)));
await pgPool.query('DELETE FROM branches WHERE id = $1', [ID]);
stopReferenceCacheInvalidation();
await closeSharedState();
process.exit(code === 0 && published ? 0 : 1);
