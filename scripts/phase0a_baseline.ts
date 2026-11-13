/**
 * Phase 0A synthetic baseline: 100k customers in a throwaway database.
 *
 * The harness deliberately measures the current shape before Phase 0B removes
 * the full-table cache:
 *   - customer page 1 and a deep OFFSET page;
 *   - each CACHE_LOADS query individually;
 *   - two full operational-cache hydrations (the second is representative of a
 *     write-path refresh, which runs the same list);
 *   - EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the page queries.
 *
 * Run with `npm run bench:phase0a`. The throwaway database is dropped unless
 * PHASE0A_KEEP_DB=1 is set. Results are written to docs/performance/.
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
const DB_NAME = process.env.PHASE0A_DB || 'inventory_phase0a_baseline';
const CUSTOMER_COUNT = Number(process.env.PHASE0A_CUSTOMERS || 100_000);
const KEEP_DB = process.env.PHASE0A_KEEP_DB === '1';
const BRANCH_ID = 'P0A';

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
const SEARCH_SQL = `
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
       VALUES ($1, 'P0A', 'Phase 0A Baseline', 'Benchmark', FALSE, TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [BRANCH_ID]
    );
    console.log(`Seeding ${CUSTOMER_COUNT.toLocaleString()} customers...`);
    const seededAt = performance.now();
    await setup.query(
      `INSERT INTO customer_records
         (id, customer_id, customer_name, username, contact_number, branch_id, address, status, is_demo)
       SELECT
         'p0a-' || lpad(g::text, 8, '0'),
         'P0A-' || lpad(g::text, 8, '0'),
         'Baseline Customer ' || lpad(g::text, 8, '0'),
         'p0a-user-' || g,
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
    });
    const deepPage = await measure(async () => {
      await setup!.query(DEEP_PAGE_SQL);
    });
    const search = await measure(async () => {
      await setup!.query(SEARCH_SQL);
    });

    const explain = async (sql: string) => {
      const result = await setup!.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`
      );
      return result.rows[0]['QUERY PLAN'];
    };
    const pagePlan = await explain(PAGE_SQL);
    const deepPagePlan = await explain(DEEP_PAGE_SQL);
    const searchPlan = await explain(SEARCH_SQL);

    // Point the app's pool at the throwaway database before loading runtime
    // state, then use the same CACHE_LOADS list the server hydrates at boot and
    // refreshes after a write.
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

    const baseline = {
      generatedAt: new Date().toISOString(),
      phase: '0A',
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
        customer_deep_offset: deepPage,
        customer_search: search,
        cache_hydration: {
          passes: hydration.length,
          samples: hydration,
          p50Ms: round(percentile(hydration, 50)),
          maxMs: round(Math.max(...hydration)),
        },
        cache_loads: cacheLoads,
      },
      explain: {
        customer_page_1: pagePlan,
        customer_deep_offset: deepPagePlan,
        customer_search: searchPlan,
      },
      notes: [
        'Deep OFFSET is intentionally measured at the end of the table to show the Phase 0B keyset-pagination target.',
        'Cache loads are the current full-table CACHE_LOADS queries; the second hydration is representative of a post-write refresh.',
      ],
    };

    const jsonPath = path.join(OUTPUT_DIR, 'phase0a-baseline.json');
    fs.writeFileSync(jsonPath, JSON.stringify(baseline, null, 2) + '\n');

    const cacheRows = cacheLoads
      .slice(0, 12)
      .map((entry) => `| ${entry.name} | ${entry.p50Ms} | ${entry.maxMs} |`)
      .join('\n');
    const markdown = `# Phase 0A baseline

Recorded ${baseline.generatedAt} against a throwaway PostgreSQL database.

- Customers: **${baseline.database.customerCount.toLocaleString()}**
- Database size: **${baseline.database.size}**
- PostgreSQL: ${baseline.database.serverVersion}
- Seed time: **${baseline.seed.elapsedMs} ms**

## Request/page probes

| Probe | p50 ms | min ms | max ms |
| --- | ---: | ---: | ---: |
| Customer page 1 | ${page.p50Ms} | ${page.minMs} | ${page.maxMs} |
| Customer deep OFFSET | ${deepPage.p50Ms} | ${deepPage.minMs} | ${deepPage.maxMs} |
| Customer search | ${search.p50Ms} | ${search.minMs} | ${search.maxMs} |

## Full operational cache

| Pass | Duration ms |
| --- | ---: |
| First hydration | ${hydration[0]} |
| Second hydration (post-write shape) | ${hydration[1]} |

Slowest CACHE_LOADS entries (p50 over 3 runs):

| Load | p50 ms | max ms |
| --- | ---: | ---: |
${cacheRows}

The complete measurements and EXPLAIN (ANALYZE, BUFFERS) plans are in
\`phase0a-baseline.json\`.
`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'phase0a-baseline.md'), markdown);
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
