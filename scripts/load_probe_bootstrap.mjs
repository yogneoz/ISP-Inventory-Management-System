#!/usr/bin/env node
/**
 * OPS-5 — repeatable bootstrap load probe.
 *
 * Wave 1: GET /api/bootstrap without a validator (full payload).
 * Wave 2: the same request with If-None-Match from wave 1 (the cached path).
 *
 * This is deliberately a CLI, not a test: it needs a seeded database and a
 * running server. `--assert` makes it a gate:
 *   - any 503 or 5xx in either wave fails;
 *   - fewer than 90% 304s in wave 2 fails;
 *   - wave 2's 304 p95 at or above 1,000 ms fails.
 *
 * `--json` writes the measurement for the worklist note. `--token` skips the
 * login (useful in CI); otherwise it signs in once and reuses the token.
 *
 * Usage:
 *   npm run perf:bootstrap -- --concurrency 10 --requests 20
 *   npm run perf:bootstrap -- --concurrency 50 --requests 120 --assert --json
 *
 * Env: BASE_URL, SMOKE_USER_EMAIL, SMOKE_USER_PASSWORD, SERVER_LOG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  email: process.env.SMOKE_USER_EMAIL || process.env.BOOTSTRAP_PROBE_EMAIL || 'superadmin@example.com',
  password: process.env.SMOKE_USER_PASSWORD || process.env.BOOTSTRAP_PROBE_PASSWORD || 'Demo@123',
  concurrency: 50,
  requests: 120,
  timeoutMs: 10_000,
  assert: false,
  json: null,
  token: null,
  branchId: null,
  fiscalYearId: null,
  serverLog: process.env.SERVER_LOG || '.tmp-server.log',
};

function usage() {
  console.log(`Usage: node scripts/load_probe_bootstrap.mjs [options]

  --base-url <url>        default ${DEFAULTS.baseUrl}
  --email <email>         login email (or SMOKE_USER_EMAIL)
  --password <password>   login password (or SMOKE_USER_PASSWORD)
  --token <jwt>           reuse a token instead of logging in
  --concurrency <n>       parallel requests per wave (default ${DEFAULTS.concurrency})
  --requests <n>          requests per wave (default ${DEFAULTS.requests})
  --timeout-ms <n>        per-request abort (default ${DEFAULTS.timeoutMs})
  --branch-id <id>        optional bootstrap scope
  --fiscal-year-id <id>   optional bootstrap scope
  --server-log <path>     log file the operator should grep (default ${DEFAULTS.serverLog})
  --json [path]           write the measurement (default docs/performance/bootstrap-probe.json)
  --assert                exit 1 when the contract fails
  --help`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        usage();
        process.exit(0);
      case '--base-url':
        opts.baseUrl = take(i, arg); i++; break;
      case '--email':
        opts.email = take(i, arg); i++; break;
      case '--password':
        opts.password = take(i, arg); i++; break;
      case '--token':
        opts.token = take(i, arg); i++; break;
      case '--concurrency':
        opts.concurrency = Number(take(i, arg)); i++; break;
      case '--requests':
        opts.requests = Number(take(i, arg)); i++; break;
      case '--timeout-ms':
        opts.timeoutMs = Number(take(i, arg)); i++; break;
      case '--branch-id':
        opts.branchId = take(i, arg); i++; break;
      case '--fiscal-year-id':
        opts.fiscalYearId = take(i, arg); i++; break;
      case '--server-log':
        opts.serverLog = take(i, arg); i++; break;
      case '--json': {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts.json = next; i++;
        } else {
          opts.json = 'docs/performance/bootstrap-probe.json';
        }
        break;
      }
      case '--assert':
        opts.assert = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  for (const key of ['concurrency', 'requests', 'timeoutMs']) {
    if (!Number.isFinite(opts[key]) || opts[key] < 1) {
      throw new Error(`--${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())} must be a positive integer`);
    }
  }
  opts.baseUrl = opts.baseUrl.replace(/\/$/, '');
  return opts;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/** Nearest-rank percentile; no interpolation, matching the other probes. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(results) {
  const byStatus = {};
  const errors = [];
  for (const result of results) {
    const key = String(result.status);
    byStatus[key] = (byStatus[key] || 0) + 1;
    if (result.error) errors.push(result.error);
  }
  const answered = results.filter((r) => r.status === 200 || r.status === 304);
  const ms = answered.map((r) => r.ms);
  const bytes = answered.map((r) => r.bytes);
  const notModified = results.filter((r) => r.status === 304);
  const notModifiedMs = notModified.map((r) => r.ms);
  return {
    requests: results.length,
    byStatus,
    errors: errors.length,
    errorSamples: errors.slice(0, 5),
    ms: { p50: round(percentile(ms, 50)), p95: round(percentile(ms, 95)), p99: round(percentile(ms, 99)) },
    bytes: { p50: round(percentile(bytes, 50)), p95: round(percentile(bytes, 95)), max: bytes.length ? Math.max(...bytes) : 0 },
    notModified: {
      count: notModified.length,
      ratio: results.length ? round(notModified.length / results.length) : 0,
      ms: { p50: round(percentile(notModifiedMs, 50)), p95: round(percentile(notModifiedMs, 95)), p99: round(percentile(notModifiedMs, 99)) },
    },
  };
}

/**
 * The pure gate. Kept separate from the CLI so its failure branches are
 * testable from fabricated measurements without a server or a clock.
 */
export function evaluateProbe(first, second) {
  const failures = [];
  for (const [name, wave] of [['first', first], ['second', second]]) {
    for (const [status, count] of Object.entries(wave.byStatus)) {
      const code = Number(status);
      if (code === 503) failures.push(`${name} wave: ${count} request(s) returned 503`);
      else if (code >= 500) failures.push(`${name} wave: ${count} request(s) returned ${code}`);
      else if (code === 0) failures.push(`${name} wave: ${count} request(s) had no HTTP status`);
      else if (code !== 200 && code !== 304) failures.push(`${name} wave: ${count} request(s) returned ${code}`);
    }
    if (wave.errors > 0) failures.push(`${name} wave: ${wave.errors} request(s) errored before a response`);
  }
  if (second.notModified.ratio < 0.9) {
    failures.push(`second wave: only ${(second.notModified.ratio * 100).toFixed(1)}% were 304 (need >= 90%)`);
  }
  if (second.notModified.ms.p95 >= 1000) {
    failures.push(`second wave: 304 p95 is ${second.notModified.ms.p95} ms (need < 1000 ms)`);
  }
  return failures;
}

async function login(opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: opts.email, password: opts.password }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) {
      throw new Error(`login failed (${res.status}): ${body?.message || res.statusText}`);
    }
    return body.token;
  } finally {
    clearTimeout(timer);
  }
}

function bootstrapPath(opts) {
  const params = new URLSearchParams();
  if (opts.branchId) params.append('branchId', opts.branchId);
  if (opts.fiscalYearId) params.append('fiscalYearId', opts.fiscalYearId);
  return `/api/bootstrap${params.toString() ? `?${params.toString()}` : ''}`;
}

async function oneRequest(opts, token, etag) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const startedAt = performance.now();
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(`${opts.baseUrl}${bootstrapPath(opts)}`, { headers, signal: controller.signal });
    const body = await res.arrayBuffer();
    return {
      status: res.status,
      ms: round(performance.now() - startedAt),
      bytes: body.byteLength,
      etag: res.headers.get('etag') || null,
    };
  } catch (err) {
    return {
      status: 0,
      ms: round(performance.now() - startedAt),
      bytes: 0,
      etag: null,
      error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runWave(opts, token, etag, label) {
  const results = new Array(opts.requests);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= opts.requests) return;
      results[index] = await oneRequest(opts, token, etag);
    }
  };
  const workers = Math.min(opts.concurrency, opts.requests);
  await Promise.all(Array.from({ length: workers }, worker));
  // The first wave must hand its OBSERVED validator to the second wave; using
  // the input `etag` (null on wave 1) would silently make every request full.
  const observedEtag = results.find((result) => result.etag)?.etag || etag || null;
  return { label, etag: observedEtag, ...summarize(results) };
}

function printWave(wave) {
  const statuses = Object.entries(wave.byStatus)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([status, count]) => `${status === '0' ? 'no-status' : status}=${count}`)
    .join(' ');
  console.log(`  ${wave.label}: ${statuses || 'no responses'}`);
  console.log(`    latency p50/p95/p99: ${wave.ms.p50}/${wave.ms.p95}/${wave.ms.p99} ms; bytes p50/p95/max: ${wave.bytes.p50}/${wave.bytes.p95}/${wave.bytes.max}`);
  console.log(`    304: ${wave.notModified.count} (${(wave.notModified.ratio * 100).toFixed(1)}%), p95 ${wave.notModified.ms.p95} ms`);
  if (wave.errorSamples.length) console.log(`    errors: ${wave.errorSamples.join('; ')}`);
}

function grepServerLog(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.split(/\r?\n/).filter((line) => line.includes('PostgreSQL is not connected')).length;
    return { found: true, notConnectedLines: matches };
  } catch {
    return { found: false, notConnectedLines: null };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`Bootstrap probe — ${opts.baseUrl}/api/bootstrap`);
  console.log(`  concurrency=${opts.concurrency} requests/wave=${opts.requests} timeout=${opts.timeoutMs}ms`);

  const token = opts.token || (await login(opts));
  const first = await runWave(opts, token, null, 'wave 1 (full)');
  const etag = first.etag;
  if (!etag) {
    console.warn('  ⚠ wave 1 returned no ETag; wave 2 cannot be conditional');
  }
  const second = await runWave(opts, token, etag, 'wave 2 (If-None-Match)');

  printWave(first);
  printWave(second);

  const failures = evaluateProbe(first, second);
  if (failures.length) {
    console.log('\nAssertion failures:');
    for (const failure of failures) console.log(`  ✖ ${failure}`);
  } else {
    console.log('\nAssertions: PASS');
  }

  const serverLog = grepServerLog(opts.serverLog);
  console.log(`\nServer log: ${path.resolve(opts.serverLog)}`);
  if (serverLog.found) {
    console.log(`  "PostgreSQL is not connected" lines: ${serverLog.notConnectedLines}`);
  } else {
    console.log('  (log file not found; set --server-log to the server output file)');
  }
  console.log(`  grep -c "PostgreSQL is not connected" ${opts.serverLog}`);

  const measurement = {
    generatedAt: new Date().toISOString(),
    baseUrl: opts.baseUrl,
    config: {
      concurrency: opts.concurrency,
      requests: opts.requests,
      timeoutMs: opts.timeoutMs,
      branchId: opts.branchId,
      fiscalYearId: opts.fiscalYearId,
    },
    first,
    second,
    failures,
    passed: failures.length === 0,
    serverLog: { path: path.resolve(opts.serverLog), ...serverLog },
  };

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(measurement, null, 2) + '\n');
    console.log(`Measurement: ${opts.json}`);
  }

  if (opts.assert && failures.length) process.exitCode = 1;
}

// Importing the module (the unit test uses evaluateProbe) must not run a probe.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`bootstrap probe failed: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
