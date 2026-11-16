/**
 * OPS-5 — the bootstrap load probe.
 *
 * PROVES the probe end to end without sleeps:
 *   1. fixture: first wave 200 + ETag, second wave 304 -> --assert exits 0;
 *   2. fixture: a 503 -> --assert exits 1 and names the 503;
 *   3. fixture: 200 on both waves -> --assert exits 1 on the < 90% 304 rule;
 *   4. real app + PostgreSQL: createApp() serves the actual bootstrap, the
 *      probe's wave 2 is 304, and --assert exits 0.
 *
 * The fixture cases use a tiny local HTTP server and a child process; the
 * latency gate is exercised by fabricated measurements in the CLI's pure
 * evaluator (the fixture answers immediately, so a 1,000 ms p95 is not
 * something a test should wait for).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { ensureReferenceData } from './fixtures/referenceData';
import { evaluateProbe } from '../scripts/load_probe_bootstrap.mjs';

dotenv.config();

const ROOT = path.resolve('.');
const SCRIPT = path.join(ROOT, 'scripts', 'load_probe_bootstrap.mjs');
const ETAG = 'W/"1-test-validator"';

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (real createApp bootstrap)';

const SUPER_USER = {
  id: 'probe-super',
  email: 'probe-super@example.com',
  name: 'Probe Test',
  role: 'SUPER_ADMIN',
  branchId: 'WH001',
  allowedBranchIds: ['WH001'],
  canSwitchUser: false,
} as any;

type Fixture = { url: string; close: () => Promise<void> };

async function startFixture(
  bootstrap: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/auth/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'fixture-token' }));
      return;
    }
    if (req.url?.startsWith('/api/bootstrap')) {
      bootstrap(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as any).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function tempFile(name: string): string {
  return path.join(os.tmpdir(), `ops5-${process.pid}-${Date.now()}-${name}`);
}

function runProbe(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe did not exit in 30s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('OPS-5 bootstrap probe — pure gate', () => {
  const wave = (overrides: any = {}) => ({
    requests: 100,
    byStatus: { '200': 100 },
    errors: 0,
    ms: { p50: 10, p95: 10, p99: 10 },
    bytes: { p50: 1, p95: 1, max: 1 },
    notModified: { count: 0, ratio: 0, ms: { p50: 0, p95: 0, p99: 0 } },
    ...overrides,
  });

  test('the 304 p95 gate fails at 1,000 ms and passes below it', () => {
    const secondAtLimit = wave({
      byStatus: { '304': 100 },
      notModified: { count: 100, ratio: 1, ms: { p50: 20, p95: 1_000, p99: 1_000 } },
    });
    const failures = evaluateProbe(wave(), secondAtLimit);
    assert.ok(failures.some((line) => /1000 ms/.test(line)), failures.join('\n'));

    const secondBelow = wave({
      byStatus: { '304': 100 },
      notModified: { count: 100, ratio: 1, ms: { p50: 20, p95: 999, p99: 999 } },
    });
    assert.deepEqual(evaluateProbe(wave(), secondBelow), []);
  });
});

describe('OPS-5 bootstrap probe — fixture server', () => {
  test('200 then 304: --assert passes and wave 2 is all 304', async () => {
    const fixture = await startFixture((req, res) => {
      if (req.headers['if-none-match'] === ETAG) {
        res.writeHead(304, { ETag: ETAG });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', ETag: ETAG });
      res.end(JSON.stringify({ ok: true }));
    });
    const jsonPath = tempFile('success.json');
    const logPath = tempFile('success.log');
    fs.writeFileSync(logPath, 'server started\n', 'utf8');
    try {
      const result = await runProbe([
        '--base-url', fixture.url,
        '--email', 'probe@example.com',
        '--password', 'secret',
        '--concurrency', '2',
        '--requests', '4',
        '--server-log', logPath,
        '--json', jsonPath,
        '--assert',
      ]);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const measurement = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(measurement.passed, true);
      assert.equal(measurement.first.byStatus['200'], 4);
      assert.equal(measurement.second.byStatus['304'], 4);
      assert.equal(measurement.second.notModified.ratio, 1);
      assert.ok(measurement.serverLog.found);
      assert.equal(measurement.serverLog.notConnectedLines, 0);
      assert.match(result.stdout, /Server log:/);
    } finally {
      await fixture.close();
      fs.rmSync(jsonPath, { force: true });
      fs.rmSync(logPath, { force: true });
    }
  });

  test('a 503 fails --assert and is named in the JSON', async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unavailable' }));
    });
    const jsonPath = tempFile('503.json');
    try {
      const result = await runProbe([
        '--base-url', fixture.url,
        '--token', 'fixture-token',
        '--concurrency', '2',
        '--requests', '3',
        '--json', jsonPath,
        '--assert',
      ]);
      assert.equal(result.code, 1);
      const measurement = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(measurement.passed, false);
      assert.ok(measurement.failures.some((line: string) => /503/.test(line)));
      assert.equal(measurement.first.byStatus['503'], 3);
    } finally {
      await fixture.close();
      fs.rmSync(jsonPath, { force: true });
    }
  });

  test('no 304s fails --assert on the 90% rule', async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', ETag: ETAG });
      res.end(JSON.stringify({ ok: true }));
    });
    const jsonPath = tempFile('no304.json');
    try {
      const result = await runProbe([
        '--base-url', fixture.url,
        '--token', 'fixture-token',
        '--concurrency', '2',
        '--requests', '3',
        '--json', jsonPath,
        '--assert',
      ]);
      assert.equal(result.code, 1);
      const measurement = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(measurement.passed, false);
      assert.ok(measurement.failures.some((line: string) => /90%/.test(line)));
      assert.equal(measurement.second.notModified.count, 0);
    } finally {
      await fixture.close();
      fs.rmSync(jsonPath, { force: true });
    }
  });
});

describe('OPS-5 bootstrap probe — real createApp bootstrap', () => {
  let server: http.Server | null = null;
  let port = 0;
  let token = '';

  before(async () => {
    if (!dbReachable) return;
    await ensureReferenceData(pool!);
    const app = createApp();
    registerAllRoutes(app);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    port = (server!.address() as any).port;
    token = issueAuthToken(SUPER_USER);
  });

  after(async () => {
    if (server) {
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (pool && dbReachable) await pool.end();
  });

  test('wave 1 200, wave 2 304, --assert exits 0', { skip: skipNoDb }, async () => {
    const jsonPath = tempFile('real.json');
    try {
      const result = await runProbe([
        '--base-url', `http://127.0.0.1:${port}`,
        '--token', token,
        '--concurrency', '1',
        '--requests', '3',
        '--json', jsonPath,
        '--assert',
      ]);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const measurement = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      assert.equal(measurement.first.byStatus['200'], 3);
      assert.equal(measurement.second.byStatus['304'], 3);
      assert.equal(measurement.passed, true);
    } finally {
      fs.rmSync(jsonPath, { force: true });
    }
  });
});
