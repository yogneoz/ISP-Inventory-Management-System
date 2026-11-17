#!/usr/bin/env node
/**
 * Scale measurements for worklist A9 — the debt the database-optimization
 * audit recorded in §6: no EXPLAIN (ANALYZE, BUFFERS) had ever been run at
 * volume. This script produces the numbers that §4 and §6 were guessing at.
 *
 * Against the fixture seeded by `seed_scale_fixture.mjs` it measures:
 *
 *   1. the year-end trial balance (`FISCAL_YEAR_TRIAL_BALANCE_ROWS_SQL`, the
 *      statement a close runs) — median of N runs plus its plan;
 *   2. a one-month trial balance twice: filtered on the journals' date (what
 *      the app does) and on the lines' date (the only filter that can prune
 *      line partitions), with the partitions each plan actually scanned;
 *   3. whether the planner picks the BRIN on the log tables, and the forced
 *      plan that proves the index is usable at all;
 *   4. the `pages_per_range` decision: 32 / 128 / 256 / 512 reindexed on one
 *      month partition, with index size, heap blocks and time for each.
 *
 * The index is a *partitioned* index: PostgreSQL refuses `ALTER INDEX … SET`
 * on the parent (`42809`), and only the parent's definition is inherited by
 * future month partitions. The script records that refusal and recommends the
 * inherited value, so the recommendation is something the keeper can actually
 * maintain rather than a one-off tweak that the next partition undoes.
 *
 * It prints its findings and writes JSON with `--json`; it changes no schema.
 * A different `pages_per_range` would be a numbered migration, not a script.
 *
 * Usage:
 *   SCALE_FIXTURE_DATABASE_URL=postgres://…/inventory_scale node scripts/measure_scale.mjs --runs 5 --json /tmp/a9.json
 *
 * The target must be a scratch `_scale` database (the same guard as the seed):
 * the last step reindexes a BRIN several times and must never run against the
 * application database.
 */
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
function intFlag(name, fallback) {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} needs a positive integer`);
    process.exit(2);
  }
  return value;
}
const runs = intFlag('--runs', 5);
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const url = process.env.SCALE_FIXTURE_DATABASE_URL;
if (!url) {
  console.error('SCALE_FIXTURE_DATABASE_URL is required; DATABASE_URL is never used for a measurement.');
  process.exit(2);
}
let databaseName = '';
try {
  databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
} catch {
  console.error('SCALE_FIXTURE_DATABASE_URL is not a valid PostgreSQL URL.');
  process.exit(2);
}
if (!/_scale(?:$|_)/i.test(databaseName)) {
  console.error(`Refusing to measure '${databaseName}': the database name must contain '_scale'.`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

/** Run a statement `runs` times; with `plan`, also keep the last plan. */
async function timeQuery(sql, params, { plan = false } = {}) {
  const times = [];
  let lastPlan = null;
  for (let i = 0; i < runs; i += 1) {
    if (plan) {
      const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const text = res.rows[0]['QUERY PLAN'];
      // FORMAT JSON wraps the tree: the root node is under `Plan`, and the
      // timing sits beside it on the outer object.
      const outer = (typeof text === 'string' ? JSON.parse(text) : text)[0];
      lastPlan = outer.Plan;
      times.push(outer['Execution Time']);
    } else {
      const started = process.hrtime.bigint();
      await client.query(sql, params);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
  return {
    medianMs: round(median(times)),
    minMs: round(Math.min(...times)),
    maxMs: round(Math.max(...times)),
    plan: lastPlan,
  };
}

/** Every relation the plan touches, in plan order. */
function relationsIn(plan, found = []) {
  if (!plan) return found;
  if (plan['Relation Name']) found.push(plan['Relation Name']);
  for (const child of plan.Plans || []) relationsIn(child, found);
  return found;
}

/** Sum a per-node counter (e.g. Shared Hit Blocks) across the whole plan. */
function blocksIn(plan, key) {
  let total = plan?.[key] ?? 0;
  for (const child of plan?.Plans || []) total += blocksIn(child, key);
  return total;
}

/** The plan's top-most node and the nodes doing the scanning. */
function planShape(plan) {
  const scans = [];
  const walk = (node) => {
    if (!node) return;
    if (node['Node Type'] && /Scan/.test(node['Node Type'])) {
      scans.push({
        node: node['Node Type'],
        relation: node['Relation Name'] || node['Index Name'] || null,
        rows: node['Actual Rows'],
        loops: node['Actual Loops'],
      });
    }
    for (const child of node.Plans || []) walk(child);
  };
  walk(plan);
  return { topNode: plan?.['Node Type'] ?? null, scans };
}

const TRIAL_BALANCE_SQL = `SELECT
  l.branch_id AS "branchId",
  a.id AS "accountId",
  a.code,
  a.name,
  g.account_type AS "accountType",
  COALESCE(SUM(l.debit), 0)::numeric AS debit,
  COALESCE(SUM(l.credit), 0)::numeric AS credit,
  COALESCE(SUM(l.debit - l.credit), 0)::numeric AS balance
FROM gl_journal_lines l
JOIN gl_journals j ON j.id = l.journal_id
JOIN gl_accounts a ON a.id = l.account_id
JOIN gl_account_groups g ON g.id = a.group_id
WHERE j.status = 'POSTED'
  AND j.journal_date_ad <= $1::date
GROUP BY l.branch_id, a.id, a.code, a.name, g.account_type
ORDER BY l.branch_id ASC, a.code ASC`;

const MONTH_TRIAL_BALANCE_SQL = TRIAL_BALANCE_SQL.replace(
  'AND j.journal_date_ad <= $1::date',
  "AND j.journal_date_ad >= $1::date AND j.journal_date_ad < $1::date + INTERVAL '1 month'"
);

const LINE_MONTH_SQL = TRIAL_BALANCE_SQL.replace(
  'AND j.journal_date_ad <= $1::date',
  "AND l.journal_date_ad >= $1::date AND l.journal_date_ad < $1::date + INTERVAL '1 month'"
);

const result = {
  database: databaseName,
  generatedAt: new Date().toISOString(),
  runs,
  volumes: {},
  trialBalance: null,
  monthTrialBalance: null,
  brin: null,
};

try {
  for (const table of ['gl_journals', 'gl_journal_lines', 'gl_accounts', 'audit_logs', 'transaction_logs']) {
    const count = await client.query(`SELECT count(*)::bigint AS n FROM ${table}`);
    // A partitioned parent has no storage of its own, so its size is the sum of
    // its children's.
    const size = await client.query(
      `SELECT pg_size_pretty(
          pg_total_relation_size(to_regclass($1))
          + COALESCE((SELECT sum(pg_total_relation_size(inhrelid)) FROM pg_inherits
                       WHERE inhparent = to_regclass($1)), 0)
        ) AS size`,
      [table]
    );
    result.volumes[table] = { rows: Number(count.rows[0].n), size: size.rows[0].size };
  }
  console.log('Volumes', result.volumes);

  // 1. Year-end trial balance over every posted line.
  result.trialBalance = await timeQuery(TRIAL_BALANCE_SQL, ['2026-12-31'], { plan: true });
  result.trialBalance.plan = planShape(result.trialBalance.plan);
  console.log(
    `Trial balance (all posted lines): median ${result.trialBalance.medianMs} ms ` +
      `(${result.trialBalance.minMs}–${result.trialBalance.maxMs}), top node ${result.trialBalance.plan.topNode}, ` +
      `${result.trialBalance.plan.scans.length} scan nodes`
  );

  // 2. One-month trial balance, filtered the way the app filters and the way
  //    that can prune line partitions.
  const monthStart = await client.query(
    `SELECT to_char(date_trunc('month', min(journal_date_ad)), 'YYYY-MM-DD') AS start FROM gl_journals`
  );
  const monthFrom = monthStart.rows[0].start;
  const partitionCount = await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'gl_journal_lines'`
  );
  const lineScanned = (plan) =>
    [...new Set(relationsIn(plan))].filter((name) => name.startsWith('gl_journal_lines'));

  const journalMonth = await timeQuery(MONTH_TRIAL_BALANCE_SQL, [monthFrom], { plan: true });
  const lineMonth = await timeQuery(LINE_MONTH_SQL, [monthFrom], { plan: true });
  result.monthTrialBalance = {
    month: monthFrom.slice(0, 7),
    partitionsAvailable: partitionCount.rows[0].n,
    journalDateFilter: {
      medianMs: journalMonth.medianMs,
      partitionsScanned: lineScanned(journalMonth.plan),
      shape: planShape(journalMonth.plan),
    },
    lineDateFilter: {
      medianMs: lineMonth.medianMs,
      partitionsScanned: lineScanned(lineMonth.plan),
      shape: planShape(lineMonth.plan),
    },
  };
  console.log(
    `One month (${result.monthTrialBalance.month}): journal-date filter ${journalMonth.medianMs} ms ` +
      `(${result.monthTrialBalance.journalDateFilter.partitionsScanned.length}/${partitionCount.rows[0].n} line partitions), ` +
      `line-date filter ${lineMonth.medianMs} ms ` +
      `(${result.monthTrialBalance.lineDateFilter.partitionsScanned.join(', ') || 'no line partition'} )`
  );

  // 3/4. BRIN on the log partitions.
  const brin = { parentAlterSupported: false, settings: [], recommendation: null };
  try {
    await client.query('ALTER INDEX idx_audit_timestamp_brin SET (pages_per_range = 64)');
    brin.parentAlterSupported = true;
    await client.query('ALTER INDEX idx_audit_timestamp_brin SET (pages_per_range = 128)');
  } catch (err) {
    brin.parentAlterError = `${err.code}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`;
  }

  // One index per month partition; a setting has to be applied to every child,
  // which is exactly why the recommendation has to weigh maintenance cost.
  const childIndexes = (
    await client.query(
      `SELECT ci.relname AS index_name, t.relname AS table_name
         FROM pg_inherits i
         JOIN pg_class ci ON ci.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_index x ON x.indexrelid = ci.oid
         JOIN pg_class t ON t.oid = x.indrelid
        WHERE p.relname = 'idx_audit_timestamp_brin'
        ORDER BY t.relname`
    )
  ).rows;
  if (!childIndexes.length) throw new Error('no audit_logs month partition carries the timestamp BRIN');
  brin.children = childIndexes.map((row) => row.index_name);

  // A day-wide probe on the parent: the plan prunes to the month's partition and
  // within it the BRIN is the only index that can narrow the range.
  const oneDay = `SELECT count(*) FROM audit_logs
     WHERE timestamp_ad >= TIMESTAMPTZ '2025-06-15T00:00:00Z'
       AND timestamp_ad <  TIMESTAMPTZ '2025-06-16T00:00:00Z'`;

  const defaultRun = await timeQuery(oneDay, [], { plan: true });
  brin.defaultPick = {
    medianMs: defaultRun.medianMs,
    shape: planShape(defaultRun.plan),
    picksBrin: relationsIn(defaultRun.plan).some((name) => name.includes('brin')),
  };

  await client.query('BEGIN');
  await client.query('SET LOCAL enable_seqscan = off');
  const forcedRun = await timeQuery(oneDay, [], { plan: true });
  brin.forced = {
    medianMs: forcedRun.medianMs,
    relations: [...new Set(relationsIn(forcedRun.plan))],
    usesBrin: relationsIn(forcedRun.plan).some((name) => name.includes('brin')),
    heapBlocks: blocksIn(forcedRun.plan, 'Shared Hit Blocks') + blocksIn(forcedRun.plan, 'Shared Read Blocks'),
  };
  await client.query('ROLLBACK');

  const heapBytes = Number(
    (
      await client.query(
        `SELECT pg_relation_size('audit_logs') + COALESCE((SELECT sum(pg_relation_size(inhrelid))
           FROM pg_inherits WHERE inhparent = 'audit_logs'::regclass), 0) AS n`
      )
    ).rows[0].n
  );
  for (const pagesPerRange of [32, 128, 256, 512]) {
    for (const indexName of brin.children) {
      await client.query(`ALTER INDEX ${indexName} SET (pages_per_range = ${pagesPerRange})`);
      await client.query(`REINDEX INDEX ${indexName}`);
    }
    const indexBytes = Number(
      (
        await client.query(
          `SELECT COALESCE(sum(pg_relation_size(oid)), 0) AS n FROM pg_class WHERE relname = ANY($1::text[])`,
          [brin.children]
        )
      ).rows[0].n
    );
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const run = await timeQuery(oneDay, [], { plan: true });
    await client.query('ROLLBACK');
    const entry = {
      pagesPerRange,
      indexKb: round(indexBytes / 1024, 1),
      indexPercentOfHeap: round((indexBytes / Math.max(1, heapBytes)) * 100, 3),
      medianMs: run.medianMs,
      heapBlocks: blocksIn(run.plan, 'Shared Hit Blocks') + blocksIn(run.plan, 'Shared Read Blocks'),
      usesBrin: relationsIn(run.plan).some((name) => name.includes('brin')),
    };
    brin.settings.push(entry);
    console.log(
      `pages_per_range=${pagesPerRange}: index ${entry.indexKb} kB (${entry.indexPercentOfHeap} % of the ` +
        `${round(heapBytes / 1024 / 1024, 1)} MB log heap), ${entry.medianMs} ms, ${entry.heapBlocks} heap blocks`
    );
  }
  // Leave the scratch database as it was found.
  for (const indexName of brin.children) {
    await client.query(`ALTER INDEX ${indexName} SET (pages_per_range = 128)`);
    await client.query(`REINDEX INDEX ${indexName}`);
  }

  // Fewest heap blocks wins; ties go to the smaller index. With a partitioned
  // index only the inherited default is maintainable, so the recommendation is
  // "keep 128" unless a measured value would win outright *and* the keeper
  // gained a step to re-apply it to each new month.
  const best = brin.settings.reduce((a, b) =>
    b.heapBlocks < a.heapBlocks || (b.heapBlocks === a.heapBlocks && b.indexKb < a.indexKb) ? b : a
  );
  const defaultSetting = brin.settings.find((s) => s.pagesPerRange === 128) ?? null;
  brin.bestMeasured = best;
  brin.recommendation = {
    pagesPerRange: 128,
    keepDefault: true,
    bestMeasured: best.pagesPerRange,
    reason: brin.parentAlterSupported
      ? 'the parent accepts the option, so a migration could set it once'
      : 'a partitioned index rejects ALTER ... SET, and only the parent definition is inherited ' +
        'by new month partitions, so any other value would have to be re-applied to every new ' +
        'partition — the default stays until that step exists',
    delta: defaultSetting
      ? { heapBlocks: defaultSetting.heapBlocks - best.heapBlocks, ms: round(defaultSetting.medianMs - best.medianMs) }
      : null,
  };
  result.brin = brin;
  brin.spread = {
    indexKb: [...new Set(brin.settings.map((s) => s.indexKb))],
    heapBlocks: [...new Set(brin.settings.map((s) => s.heapBlocks))],
  };
  console.log(
    `BRIN planner pick at default settings: ${brin.defaultPick.picksBrin ? 'yes' : 'no'} ` +
      `(${brin.defaultPick.shape.scans.map((s) => `${s.node} ${s.relation}`).join(', ')}); ` +
      `forced: ${brin.forced.usesBrin ? 'yes' : 'no'} (${brin.forced.relations.join(', ')}), ` +
      `${brin.forced.heapBlocks} heap blocks, ${brin.forced.medianMs} ms`
  );
  console.log(
    `pages_per_range recommendation: ${brin.recommendation.pagesPerRange} (best measured ${best.pagesPerRange}) — ` +
      brin.recommendation.reason
  );

  if (jsonAt) fs.writeFileSync(jsonAt, `${JSON.stringify(result, null, 2)}\n`);
  console.log('\nJSON', JSON.stringify(result));
} finally {
  await client.end();
}
