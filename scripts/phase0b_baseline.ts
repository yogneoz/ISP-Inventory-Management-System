/**
 * Phase 0B synthetic baseline: 100k customers in a throwaway database.
 *
 * Measures the post-cache shape against the recorded Phase 0A numbers:
 *   - customer page 1 and a deep OFFSET probe (the old path, for comparison);
 *   - the keyset page (customer_name, customer_id) > anchor;
 *   - reference-only CACHE_LOADS hydration (no transaction tables);
 *   - EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for every probe.
 *
 * Run with `npm run bench:phase0b`. The throwaway database is dropped unless
 * PHASE0B_KEEP_DB=1 is set. Results are written beside the 0A record in
 * docs/performance/.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const ROOT = path.resolve('.');
const SCHEMA_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'schema.sql'), 'utf8');
const OUTPUT_DIR = path.join(ROOT, 'docs', 'performance');
const BASE_URL = process.env.DATABASE_URL || '';
const DB_NAME = process.env.PHASE0B_DB || 'inventory_phase0b_baseline';
const CUSTOMER_COUNT = Number(process.env.PHASE0B_CUSTOMERS || 100_000);
const KEEP_DB = process.env.PHASE0B_KEEP_DB === '1';
const BRANCH_ID = 'P0B';
const ANCHOR_INDEX = Math.max(1, Math.floor(CUSTOMER_COUNT * 0.9));
const ANCHOR_NAME = `Baseline Customer ${String(ANCHOR_INDEX).padStart(8, '0')}`;
const ANCHOR_ID = `P0B-${String(ANCHOR_INDEX).padStart(8, '0')}`;

if (!BASE_URL) throw new Error('DATABASE_URL is required for the Phase 0A baseline harness.');
if (!Number.isInteger(CUSTOMER_COUNT) || CUSTOMER_COUNT < 1) {
  throw new Error('PHASE0A_CUSTOMERS must be a positive integer.');
}

function withDbName(baseUrl: string, dbName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function measure(
  fn: () => Promise<void>,
  runs = 5
): Promise<{ p50Ms: number; minMs: number; maxMs: number; samples: number[] }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const startedAt = performance.now();
    await fn();
    samples.push(round(performance.now() - startedAt));
  }
  return {
    p50Ms: round(percentile(samples, 50)),
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    samples,
  };
}

const PAGE_SQL = `
  SELECT id, customer_id, customer_name, contact_number, status
  FROM customer_records
  WHERE branch_id = '${BRANCH_ID}'
  ORDER BY customer_name, customer_id
  LIMIT 50 OFFSET 0`;
const DEEP_PAGE_SQL = `
  SELECT id, customer_id, customer_name, contact_number, status
  FROM customer_records
  WHERE branch_id = '${BRANCH_ID}'
  ORDER BY customer_name, customer_id
  LIMIT 50 OFFSET ${Math.max(0, CUSTOMER_COUNT - 50)}`;
const KEYSET_SQL = `
  SELECT id, customer_id, customer_name, contact_number, status
  FROM customer_records
  WHERE branch_id = '${BRANCH_ID}'
    AND (customer_name, customer_id) > ('${ANCHOR_NAME}', '${ANCHOR_ID}')
  ORDER BY customer_name, customer_id
  LIMIT 50`;
// The directory's actual search predicate (CUSTOMER_SEARCH_TEXT_SQL in
// server/src/models/masterdata.repo.ts) — the expression the existing GIN
// trigram index covers. The name-only probe above is the Phase 0A comparison.
const SEARCH_SQL = `
  SELECT id, customer_id, customer_name, contact_number, status
  FROM customer_records
  WHERE branch_id = '${BRANCH_ID}'
    AND lower(COALESCE(customer_id, '') || ' ' || COALESCE(customer_name, '') || ' ' ||
      COALESCE(username, '') || ' ' || COALESCE(contact_number, '') || ' ' ||
      COALESCE(email, '') || ' ' || COALESCE(address, '')) LIKE '%customer 999%'
  ORDER BY customer_name, customer_id
  LIMIT 50`;
const NAME_SEARCH_SQL = `
  SELECT id, customer_id, customer_name, contact_number, status
  FROM customer_records
  WHERE branch_id = '${BRANCH_ID}'
    AND customer_name ILIKE '%Customer 999%'
  ORDER BY customer_name, customer_id
  LIMIT 50`;

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const admin = new pg.Client({ connectionString: withDbName(BASE_URL, 'postgres') });
  await admin.connect();
  let setup: pg.Client | null = null;
  let dbModule: any = null;

  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DB_NAME]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);

    const targetUrl = withDbName(BASE_URL, DB_NAME);
    setup = new pg.Client({ connectionString: targetUrl });
    await setup.connect();
    await setup.query(SCHEMA_SQL);

    const version = await setup.query('SHOW server_version');
    await setup.query(
      `INSERT INTO branches (id, code, name, location, is_headquarters, active, is_demo)
       VALUES ($1, 'P0B', 'Phase 0B Baseline', 'Benchmark', FALSE, TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH_ID]
    );
    console.log(`Seeding ${CUSTOMER_COUNT.toLocaleString()} customers...`);
    const seededAt = performance.now();
    await setup.query(
      `INSERT INTO customer_records
         (id, customer_id, customer_name, username, contact_number, branch_id, address, status, is_demo)
       SELECT
         'p0b-' || lpad(g::text, 8, '0'),
         'P0B-' || lpad(g::text, 8, '0'),
         'Baseline Customer ' || lpad(g::text, 8, '0'),
         'p0b-user-' || g,
         '9800' || lpad(g::text, 8, '0'),
         $1,
         'Benchmark address ' || g,
         'ACTIVE',
         TRUE
       FROM generate_series(1, $2) AS g`,
      [BRANCH_ID, CUSTOMER_COUNT]
    );
    const seedMs = performance.now() - seededAt;
    await setup.query('ANALYZE customer_records');

    const count = await setup.query('SELECT count(*)::int AS count FROM customer_records');
    const size = await setup.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database()) AS bytes`
    );

    const page = await measure(async () => {
      await setup!.query(PAGE_SQL);
    }, 20);
    const deepPage = await measure(async () => {
      await setup!.query(DEEP_PAGE_SQL);
    });
    const keyset = await measure(async () => {
      await setup!.query(KEYSET_SQL);
    }, 20);
    const search = await measure(async () => {
      await setup!.query(SEARCH_SQL);
    }, 10);
    const nameSearch = await measure(async () => {
      await setup!.query(NAME_SEARCH_SQL);
    });
    const keysetRows = await setup.query(KEYSET_SQL);

    const explain = async (sql: string) => {
      const result = await setup!.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`
      );
      return result.rows[0]['QUERY PLAN'];
    };
    const pagePlan = await explain(PAGE_SQL);
    const deepPagePlan = await explain(DEEP_PAGE_SQL);
    const keysetPlan = await explain(KEYSET_SQL);
    const searchPlan = await explain(SEARCH_SQL);
    const nameSearchPlan = await explain(NAME_SEARCH_SQL);

    // Point the app's pool at the throwaway database before loading runtime
    // state. Phase 0B hydrates reference data only; this loop is the entire
    // boot cost, and there is no write-path refresh to measure.
    process.env.DATABASE_URL = targetUrl;
    dbModule = await import('../server/db');
    const runtime = await import('../server/src/state/runtimeState');

    const hydration: number[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const startedAt = performance.now();
      await runtime.hydrateOperationalData(setup);
      hydration.push(round(performance.now() - startedAt));
    }

    const cacheLoads: Array<{ name: string; p50Ms: number; maxMs: number }> = [];
    for (const load of runtime.CACHE_LOADS) {
      const result = await measure(async () => {
        await setup!.query(load.query);
      }, 3);
      cacheLoads.push({ name: load.name, p50Ms: result.p50Ms, maxMs: result.maxMs });
    }
    cacheLoads.sort((a, b) => b.p50Ms - a.p50Ms);

    const TRANSACTIONAL = [
      'customer_records', 'customer_device_records', 'sales_invoices',
      'purchase_invoices', 'purchase_orders', 'purchase_returns',
      'sales_returns', 'shipments', 'serial_log', 'stock_operations',
      'audit_logs', 'transaction_logs', 'approval_requests',
      'damage_records', 'customer_payments', 'vendor_payments', 'fixed_assets',
    ];
    const transactionalPresent = runtime.CACHE_LOADS
      .map((load: any) => load.name)
      .filter((name: string) => TRANSACTIONAL.includes(name));

    let p0a: any = null;
    try {
      p0a = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'phase0a-baseline.json'), 'utf8'));
    } catch {
      p0a = null;
    }
    const p0aMeasurements = p0a?.measurements;
    const comparison = {
      source: p0a ? 'phase0a-baseline.json' : null,
      customer_page_1: p0aMeasurements
        ? { phase0a_p50Ms: p0aMeasurements.customer_page_1.p50Ms, phase0b_p50Ms: page.p50Ms }
        : null,
      customer_deep_offset: p0aMeasurements
        ? { phase0a_p50Ms: p0aMeasurements.customer_deep_offset.p50Ms, phase0b_p50Ms: keyset.p50Ms }
        : null,
      customer_search: p0aMeasurements
        ? { phase0a_p50Ms: p0aMeasurements.customer_search.p50Ms, phase0b_p50Ms: search.p50Ms }
        : null,
      cache_hydration: p0aMeasurements
        ? { phase0a_p50Ms: p0aMeasurements.cache_hydration.p50Ms, phase0b_p50Ms: round(percentile(hydration, 50)) }
        : null,
    };

    const baseline = {
      generatedAt: new Date().toISOString(),
      phase: '0B',
      database: {
        name: DB_NAME,
        serverVersion: version.rows[0].server_version,
        customerCount: count.rows[0].count,
        size: size.rows[0].size,
        bytes: Number(size.rows[0].bytes),
        schemaVersion: '0001_baseline (scripts/schema.sql direct)',
      },
      seed: { customers: CUSTOMER_COUNT, elapsedMs: round(seedMs) },
      measurements: {
        customer_page_1: page,
        customer_deep_offset_before: deepPage,
        customer_keyset: {
          ...keyset,
          anchor: { name: ANCHOR_NAME, id: ANCHOR_ID },
          rows: keysetRows.rowCount,
        },
        customer_search: search,
        customer_search_name_scan_before: nameSearch,
        cache_hydration: {
          mode: 'reference-only',
          loads: runtime.CACHE_LOADS.map((load: any) => load.name),
          transactionalPresent,
          passes: hydration.length,
          samples: hydration,
          p50Ms: round(percentile(hydration, 50)),
          maxMs: round(Math.max(...hydration)),
        },
        cache_loads: cacheLoads,
      },
      comparison,
      explain: {
        customer_page_1: pagePlan,
        customer_deep_offset_before: deepPagePlan,
        customer_keyset: keysetPlan,
        customer_search: searchPlan,
        customer_search_name_scan_before: nameSearchPlan,
      },
      notes: [
        'customer_deep_offset_before is the old path, retained only as a before measurement.',
        'customer_keyset anchors at 90% of the directory and is the path GET /api/customers?cursor=... uses.',
        'CACHE_LOADS is reference-only; no write triggers a full refresh and no transaction table is hydrated.',
      ],
    };

    const jsonPath = path.join(OUTPUT_DIR, 'phase0b-baseline.json');
    fs.writeFileSync(jsonPath, JSON.stringify(baseline, null, 2) + '\n');

    const cacheRows = cacheLoads
      .map((entry) => `| ${entry.name} | ${entry.p50Ms} | ${entry.maxMs} |`)
      .join('\n');
    const beforeDeep = p0aMeasurements?.customer_deep_offset?.p50Ms;
    const beforeSearch = p0aMeasurements?.customer_search?.p50Ms;
    const beforePage = p0aMeasurements?.customer_page_1?.p50Ms;
    const beforeCache = p0aMeasurements?.cache_hydration?.p50Ms;
    const markdown = `# Phase 0B baseline — reference-only runtime

Recorded ${baseline.generatedAt} against a throwaway PostgreSQL database.

- Customers: **${baseline.database.customerCount.toLocaleString()}**
- Database size: **${baseline.database.size}**
- PostgreSQL: ${baseline.database.serverVersion}
- Seed time: **${baseline.seed.elapsedMs} ms**
- Reference loads: **${runtime.CACHE_LOADS.length}** (${runtime.CACHE_LOADS.map((load: any) => load.name).join(', ')})
- Transactional loads still present: **${transactionalPresent.length === 0 ? 'none' : transactionalPresent.join(', ')}**

## Before / after

| Probe | Phase 0A p50 ms | Phase 0B p50 ms |
| --- | ---: | ---: |
| Customer page 1 | ${beforePage ?? 'n/a'} | ${page.p50Ms} |
| Deep page (0A OFFSET → 0B keyset) | ${beforeDeep ?? 'n/a'} | ${keyset.p50Ms} |
| Customer search (0A name-only probe → 0B API expression) | ${beforeSearch ?? 'n/a'} | ${search.p50Ms} |
| Boot/refresh hydration | ${beforeCache ?? 'n/a'} | ${round(percentile(hydration, 50))} |

The old deep-OFFSET query is still recorded as a before probe
(${deepPage.p50Ms} ms p50); it is no longer on the request path. The keyset
query returns ${keysetRows.rowCount} rows starting after the 90% anchor. The
name-only search probe (${nameSearch.p50Ms} ms p50) is retained only as the 0A
comparison; the directory now runs the indexed six-column expression above.

## Reference-only hydration

| Pass | Duration ms |
| --- | ---: |
| First hydration | ${hydration[0]} |
| Second hydration | ${hydration[1]} |

There is no third pass and no write-path refresh: \`cacheRefreshHook\` and the
full \`refreshOperationalCache\` runner were removed. The second pass is included
only to show the cost is stable and reference-sized.

| Reference load | p50 ms | max ms |
| --- | ---: | ---: |
${cacheRows}

The complete measurements and EXPLAIN (ANALYZE, BUFFERS) plans are in
\`phase0b-baseline.json\`.
`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'phase0b-baseline.md'), markdown);
    console.log(`Wrote ${jsonPath}`);
    console.log(markdown);
  } finally {
    if (setup) await setup.end().catch(() => undefined);
    if (dbModule?.realPoolInstance?.end) {
      await dbModule.realPoolInstance.end().catch(() => undefined);
    }
    if (!KEEP_DB) {
      await admin
        .query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [DB_NAME]
        )
        .catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
