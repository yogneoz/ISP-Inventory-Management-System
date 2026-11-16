#!/usr/bin/env node
/**
 * OPS-3 — measure the real GET /api/bootstrap payload by key.
 *
 * Signs in (or reuses --token), fetches the full payload once, and reports:
 *   - the raw JSON and gzip byte totals;
 *   - one row per top-level key with its raw bytes, standalone gzip bytes and
 *     share of the payload gzip total;
 *   - every key whose share is over 10% of that total.
 *
 * The measurement is deliberately taken from the API, not from a fixture
 * object: it is the bytes a browser actually receives. `--json` writes the
 * same evidence for the worklist note.
 *
 * Usage:
 *   node scripts/measure_bootstrap_payload.mjs
 *   node scripts/measure_bootstrap_payload.mjs --base-url http://127.0.0.1:3100 --json
 *   npm run measure:bootstrap -- --json docs/performance/bootstrap-payload.json
 *
 * Env: BASE_URL, SMOKE_USER_EMAIL, SMOKE_USER_PASSWORD.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  email: process.env.SMOKE_USER_EMAIL || process.env.BOOTSTRAP_PROBE_EMAIL || 'superadmin@example.com',
  password: process.env.SMOKE_USER_PASSWORD || process.env.BOOTSTRAP_PROBE_PASSWORD || 'Demo@123',
  timeoutMs: 10_000,
  branchId: null,
  fiscalYearId: null,
  token: null,
  json: null,
};

function usage() {
  console.log(`Usage: node scripts/measure_bootstrap_payload.mjs [options]

  --base-url <url>        default ${DEFAULTS.baseUrl}
  --email <email>         login email (or SMOKE_USER_EMAIL)
  --password <password>   login password (or SMOKE_USER_PASSWORD)
  --token <jwt>           reuse a token instead of logging in
  --branch-id <id>        optional bootstrap scope
  --fiscal-year-id <id>   optional bootstrap scope
  --json [path]           write the measurement (default docs/performance/bootstrap-payload.json)
  --help`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const take = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        usage();
        process.exit(0);
      case '--base-url':
        opts.baseUrl = take(i, arg); i += 1; break;
      case '--email':
        opts.email = take(i, arg); i += 1; break;
      case '--password':
        opts.password = take(i, arg); i += 1; break;
      case '--token':
        opts.token = take(i, arg); i += 1; break;
      case '--branch-id':
        opts.branchId = take(i, arg); i += 1; break;
      case '--fiscal-year-id':
        opts.fiscalYearId = take(i, arg); i += 1; break;
      case '--json': {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts.json = next; i += 1;
        } else {
          opts.json = 'docs/performance/bootstrap-payload.json';
        }
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  opts.baseUrl = opts.baseUrl.replace(/\/$/, '');
  return opts;
}

const serialize = (value) => JSON.stringify(value) ?? 'null';
const gzipSize = (text) => zlib.gzipSync(Buffer.from(text, 'utf8')).length;

/**
 * Pure measurement of a parsed bootstrap payload. Kept exported so the guard
 * test can prove the table/flag arithmetic without a server or a database.
 */
export function measurePayload(payload, options = {}) {
  const threshold = options.threshold ?? 0.1;
  const text = serialize(payload);
  const rawBytes = Buffer.byteLength(text, 'utf8');
  const gzipBytes = gzipSize(text);
  const rows = Object.entries(payload)
    .map(([key, value]) => {
      const keyText = serialize(value);
      const keyRaw = Buffer.byteLength(keyText, 'utf8');
      const keyGzip = gzipSize(keyText);
      return {
        key,
        rawBytes: keyRaw,
        gzipBytes: keyGzip,
        share: gzipBytes === 0 ? 0 : keyGzip / gzipBytes,
        flagged: gzipBytes > 0 && keyGzip / gzipBytes > threshold,
      };
    })
    .sort((a, b) => b.gzipBytes - a.gzipBytes || a.key.localeCompare(b.key));
  return {
    rawBytes,
    gzipBytes,
    threshold,
    rows,
    flagged: rows.filter((row) => row.flagged).map((row) => row.key),
  };
}

function scopePath(opts) {
  const params = new URLSearchParams();
  if (opts.branchId) params.append('branchId', opts.branchId);
  if (opts.fiscalYearId) params.append('fiscalYearId', opts.fiscalYearId);
  return `/api/bootstrap${params.toString() ? `?${params.toString()}` : ''}`;
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

async function fetchPayload(opts, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${opts.baseUrl}${scopePath(opts)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`bootstrap returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
    }
    if (!res.ok) {
      throw new Error(`bootstrap failed (${res.status}): ${payload?.message || res.statusText}`);
    }
    return { payload, etag: res.headers.get('etag') || null };
  } finally {
    clearTimeout(timer);
  }
}

function formatBytes(value) {
  return value.toLocaleString('en-US');
}

function printMeasurement(measurement, opts, etag) {
  console.log(`Bootstrap payload — ${opts.baseUrl}${scopePath(opts)}`);
  console.log(`  raw:  ${formatBytes(measurement.rawBytes)} bytes`);
  console.log(`  gzip: ${formatBytes(measurement.gzipBytes)} bytes`);
  if (etag) console.log(`  ETag: ${etag}`);
  console.log('');
  console.log(`  ${'key'.padEnd(24)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)} ${'% gzip'.padStart(8)}`);
  for (const row of measurement.rows) {
    console.log(
      `  ${row.key.padEnd(24)} ${formatBytes(row.rawBytes).padStart(10)} ` +
        `${formatBytes(row.gzipBytes).padStart(10)} ${(row.share * 100).toFixed(1).padStart(7)}%`
    );
  }
  console.log('');
  console.log(
    measurement.flagged.length
      ? `  >10% of gzip: ${measurement.flagged.join(', ')}`
      : '  >10% of gzip: none'
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = opts.token || (await login(opts));
  const { payload, etag } = await fetchPayload(opts, token);
  const measurement = measurePayload(payload);
  printMeasurement(measurement, opts, etag);

  if (opts.json) {
    const output = {
      generatedAt: new Date().toISOString(),
      baseUrl: opts.baseUrl,
      scope: { branchId: opts.branchId, fiscalYearId: opts.fiscalYearId },
      etag,
      ...measurement,
    };
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`\nMeasurement: ${opts.json}`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`bootstrap payload measurement failed: ${err?.message || err}`);
    process.exitCode = 1;
  });
}
