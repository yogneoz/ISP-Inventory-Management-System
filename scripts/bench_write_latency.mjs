#!/usr/bin/env node
/**
 * Write-latency benchmark — measures the cost of the automatic cache-refresh
 * fan-out and reports the slowest write endpoints.
 *
 * Phase A (direct PostgreSQL): extracts the CACHE_LOADS queries from
 * server.ts (single source of truth — no drift) and times each one, then
 * times the full 22-query sequence the way the refresh hook runs it.
 *
 * Phase B (live HTTP): drives real write endpoints N times each against a
 * RUNNING server and reads the `Server-Timing: cache-refresh;dur=...` header
 * the refresh hook attaches to every successful mutating response.
 *   handler ms = total ms − refresh ms;  refresh % = refresh / total.
 * A few read endpoints are benchmarked too as the no-refresh baseline.
 *
 * Usage:
 *   node scripts/bench_write_latency.mjs                       # localhost:3000
 *   BASE_URL=http://localhost:3001 N=20 node scripts/bench_write_latency.mjs
 *
 * Safety: every row is tagged "BENCH" (or captured by reference) and removed
 * at the end; the serial rename always restores the original; no destructive
 * endpoints are called. Rows only where the DB is reachable.
 */

import fs from 'fs';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const N = Math.max(3, Number(process.env.N || 12));
const TAG = 'BENCH';
const EMAIL = process.env.SMOKE_USER_EMAIL || 'superadmin@example.com';
const PASSWORD = process.env.SMOKE_USER_PASSWORD || 'Demo@123';

// ---------------------------------------------------------------------------
// Phase A — extract + time the CACHE_LOADS fan-out
// ---------------------------------------------------------------------------
function extractCacheLoads() {
  const src = fs.readFileSync(new URL('../server/src/app.ts', import.meta.url), 'utf8');
  const start = src.indexOf('const CACHE_LOADS');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('CACHE_LOADS block not found in server/src/app.ts');
  const block = src.slice(start, end);
  const re = /name:\s*'([^']+)',\s*query:\s*'((?:[^'\\])*)'/g;
  const loads = [];
  let m;
  while ((m = re.exec(block)) !== null) loads.push({ name: m[1], query: m[2] });
  return loads;
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] ?? NaN;
};
const median = (arr) => pct(arr, 50);
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : 'n/a');

async function phaseA(db) {
  const loads = extractCacheLoads();
  console.log(`Phase A — cache refresh fan-out (${loads.length} queries, direct PostgreSQL, median of 5 runs)`);
  if (loads.length < 20) console.warn(`  ⚠ only ${loads.length} CACHE_LOADS entries parsed — server/src/app.ts format may have changed`);

  const perQuery = new Map();
  // Warm the pool + PG caches once.
  for (const l of loads) await db.query(l.query);

  for (const l of loads) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await db.query(l.query);
      times.push(performance.now() - t0);
    }
    perQuery.set(l.name, times);
  }

  // Full sequence on one client — mirrors refreshOperationalCache exactly.
  const seqTimes = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    for (const l of loads) await db.query(l.query);
    seqTimes.push(performance.now() - t0);
  }

  const rows = loads
    .map((l) => ({ name: l.name, med: median(perQuery.get(l.name)) }))
    .sort((a, b) => b.med - a.med);
  console.log('  slowest cache loads:');
  for (const r of rows.slice(0, 8)) console.log(`    ${r.name.padEnd(26)} ${fmt(r.med)} ms`);
  console.log(`  single-query median across all:   ${fmt(median(rows.map((r) => r.med)))} ms`);
  console.log(`  FULL FAN-OUT (22 sequential):     ${fmt(median(seqTimes))} ms (min ${fmt(Math.min(...seqTimes))}, max ${fmt(Math.max(...seqTimes))})`);
  return { loads: rows, fanout: median(seqTimes) };
}

// ---------------------------------------------------------------------------
// Phase B — live HTTP endpoints
// ---------------------------------------------------------------------------
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON ok */ }
  const st = res.headers.get('server-timing') || '';
  const mm = /cache-refresh;dur=([\d.]+)/.exec(st);
  return { status: res.status, data, refreshMs: mm ? Number(mm[1]) : null };
}

async function phaseB() {
  const login = await req('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200 || !login.data?.token) throw new Error(`login failed (${login.status}) — start the server or fix credentials`);
  const token = login.data.token;
  const today = new Date().toISOString().split('T')[0];

  // Fixtures (created outside the measured loop).
  const stock = await req('GET', '/api/stock?branchId=WH001', undefined, token);
  const products = await req('GET', '/api/products', undefined, token);
  const stockRow = (stock.data || []).find((s) => Number(s.quantityOnHand) >= 1) || null;
  const product = stockRow ? (products.data || []).find((p) => p.id === stockRow.productId) || { name: 'Product' } : null;
  const suppliers = await req('GET', '/api/suppliers', undefined, token);
  const supplier = (suppliers.data || []).find((s) => s.id) || null;
  const serialReg = await req('GET', '/api/serial-log', undefined, token);
  const serialRow = (serialReg.data || []).find((s) => s.status === 'IN_STOCK' && s.deviceSerial) || null;

  // endpoint definitions: setup/cleanup captured, sample = one measured call
  const endpoints = [
    {
      name: 'GET  /api/health (baseline)',
      kind: 'read',
      sample: () => req('GET', '/api/health'),
    },
    {
      name: 'GET  /api/branches (baseline)',
      kind: 'read',
      sample: () => req('GET', '/api/branches', undefined, token),
    },
    {
      name: 'GET  /api/serial-log (baseline)',
      kind: 'read',
      sample: () => req('GET', '/api/serial-log', undefined, token),
    },
    {
      name: 'POST /api/locations',
      kind: 'write',
      sample: () => req('POST', '/api/locations', { name: `${TAG} ${Date.now()}`, type: 'FIBER_NETWORK_NODE', branchId: 'WH001', address: TAG }, token),
    },
    {
      name: 'DEL  /api/locations/:id',
      kind: 'write',
      precreated: [],
      async setup() {
        const r = await req('POST', '/api/locations', { name: `${TAG} tgt ${Date.now()}`, type: 'STORE', branchId: 'WH001', address: TAG }, token);
        if (r.status === 201 || r.status === 200) this.precreated.push(r.data.id);
      },
      sample() {
        const id = this.precreated.pop();
        return req('DELETE', `/api/locations/${encodeURIComponent(id)}`, undefined, token);
      },
    },
    supplier && {
      name: 'POST /api/vendor-payments',
      kind: 'write',
      refs: [],
      sample() {
        return req('POST', '/api/vendor-payments', {
          supplierId: supplier.id, amount: 1, paymentMethod: 'CHEQUE', dateAD: today, notes: `${TAG} bench`,
        }, token).then((r) => {
          const ref = r.data && (r.data.paymentNumber || r.data.payment_number);
          if (ref) this.refs.push(ref);
          return r;
        });
      },
    },
    stockRow && product && {
      name: 'POST /api/stock-operations (DISPOSAL)',
      kind: 'write',
      refs: [],
      sample() {
        return req('POST', '/api/stock-operations', {
          type: 'DISPOSAL', branchId: stockRow.branchId, dateAD: today, reason: `${TAG} bench`, inspectorName: TAG,
          items: [{ productId: stockRow.productId, productName: product.name, quantity: 1, unitCost: 0 }],
        }, token).then((r) => {
          const ref = r.data && r.data.referenceNumber;
          if (ref) this.refs.push(ref);
          return r;
        });
      },
    },
    serialRow && {
      name: 'PATCH /api/inventory/serials (rename)',
      kind: 'write',
      sample: () => req('PATCH', '/api/inventory/serials', {
        oldDeviceSerial: serialRow.deviceSerial,
        oldPonSerial: serialRow.ponSerial,
        oldMacAddress: serialRow.macAddress || '',
        deviceSerial: serialRow.deviceSerial,
        ponSerial: serialRow.ponSerial,
        macAddress: serialRow.macAddress || '',
      }, token),
    },
  ].filter(Boolean);

  // Warm up: one unmeasured pass (JIT, connection pool, PG caches).
  for (const ep of endpoints) {
    if (ep.setup) await ep.setup();
    const r = await ep.sample();
    if (r.status >= 400) console.warn(`  ⚠ warmup for "${ep.name}" returned ${r.status} — endpoint may be skipped`);
  }

  console.log(`\nPhase B — live endpoints (${N} samples each, median)`);
  const results = [];
  for (const ep of endpoints) {
    const totals = [];
    const refreshes = [];
    let badStatus = 0;
    for (let i = 0; i < N; i++) {
      if (ep.kind === 'write' && ep.setup) await ep.setup();
      const t0 = performance.now();
      const r = await ep.sample();
      const dt = performance.now() - t0;
      if (r.status >= 400) { badStatus++; continue; }
      totals.push(dt);
      if (r.refreshMs != null) refreshes.push(r.refreshMs);
    }
    if (totals.length === 0) {
      console.log(`  ${ep.name.padEnd(40)} SKIPPED (all samples failed)`);
      continue;
    }
    const med = median(totals);
    const refMed = refreshes.length ? median(refreshes) : 0;
    results.push({
      name: ep.name, kind: ep.kind, med, handler: med - refMed, refresh: refMed,
      p95: pct(totals, 95), badStatus, ep,
    });
  }

  results.sort((a, b) => b.med - a.med);
  console.log(`  ${'endpoint'.padEnd(40)} ${'total'.padStart(8)} ${'handler'.padStart(9)} ${'refresh'.padStart(8)} ${'refresh%'.padStart(9)} ${'p95'.padStart(7)}`);
  for (const r of results) {
    const share = r.refresh > 0 ? ` ${(100 * r.refresh / r.med).toFixed(0)}%` : '   -';
    console.log(`  ${r.name.padEnd(40)} ${fmt(r.med).padStart(8)} ${fmt(r.handler).padStart(9)} ${fmt(r.refresh).padStart(8)} ${share.padStart(8)}% ${fmt(r.p95).padStart(7)}`);
  }

  // Cleanup DB rows created during measurement.
  const cleanup = [];
  for (const r of results) {
    const ep = r.ep;
    if (ep.refs) for (const ref of ep.refs) cleanup.push(['transaction_logs', 'reference_doc_id', ref]);
    if (ep.precreated) for (const id of ep.precreated) cleanup.push(['locations', 'id', id]);
  }
  return { results, cleanup };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let db = null;
  try {
    const pg = await import('pg');
    db = new pg.default.Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER || 'inventory_user',
      password: process.env.POSTGRES_PASSWORD || 'securepassword',
      database: process.env.POSTGRES_DB || 'inventory_db',
      connectionTimeoutMillis: 3000,
    });
    await db.query('SELECT 1');
  } catch (e) {
    console.warn(`(DB unreachable: ${String(e.message).split('\n')[0]} — Phase A skipped)`);
    db = null;
  }

  let a = null;
  if (db) a = await phaseA(db);
  const b = await phaseB();

  if (db) {
    const dels = [
      ...b.cleanup.map(([t, c, v]) => [`DELETE FROM ${t} WHERE ${c} = $1`, [v]]),
      [`DELETE FROM transaction_logs WHERE reference_doc_id = ANY($1)`, [b.cleanup.filter(([t]) => t === 'transaction_logs').map(([, , v]) => v)]],
      [`DELETE FROM vendor_payments WHERE notes LIKE '%${TAG}%'`, []],
      [`DELETE FROM stock_operations WHERE inspector_name = '${TAG}' OR reference_number LIKE '%${TAG}%'`, []],
      [`DELETE FROM locations WHERE name LIKE '%${TAG}%'`, []],
      [`DELETE FROM serial_log WHERE device_serial LIKE '%${TAG}%'`, []],
    ];
    for (const [sql, params] of dels) { try { await db.query(sql, params); } catch { /* best effort */ } }
    console.log('\nCleanup: BENCH-tagged rows removed.');
  }

  const slowest = b.results[0];
  if (slowest) {
    console.log(`\nSlowest endpoint: ${slowest.name} — ${fmt(slowest.med)} ms total` +
      (slowest.refresh > 0 ? ` (refresh ${fmt(slowest.refresh)} ms = ${(100 * slowest.refresh / slowest.med).toFixed(0)}%)` : ''));
    if (a) console.log(`Full refresh fan-out standalone: ${fmt(a.fanout)} ms.`);
  }
  await db?.end().catch(() => {});
}

main().catch((err) => { console.error('Bench crashed:', err); process.exit(1); });
