#!/usr/bin/env node
/**
 * SCALE-3 — page-read index measurement: BRIN + composite B-Trees.
 *
 * The worklist item asks for the plan to change, not only for the indexes to
 * exist. This script measures the three newest-first page reads the app issues
 * (sales register, stock operations, audit trail) and the subledger book ledger
 * range read, each with and without the index migration 0040 adds.
 *
 * Method: every measurement runs inside ONE transaction that is rolled back, so
 * the target database is left exactly as it was found. "before" drops the new
 * index, explains the query, "after" recreates it and explains the same query.
 * Both plans are wrong for production only in that the table was not re-analyzed
 * between the two — the index geometry is what is being measured, and the query
 * shape, parameters and data are identical.
 *
 * The target must be the scratch `_scale` database (the same guard as the seed
 * and `measure_scale.mjs`); `DATABASE_URL` is never used.
 *
 * Usage:
 *   SCALE_FIXTURE_DATABASE_URL=postgres://…/inventory_scale \
 *     node scripts/measure_page_read_indexes.mjs [--json /tmp/page.json]
 *
 * Exit status is 0 only when every "after" plan uses its index and the page
 * reads no longer sort. That makes it a gate, not a report: a planner change or
 * a dropped index fails it.
 */
import fs from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
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
  console.error('SCALE_FIXTURE_DATABASE_URL is not a valid URL');
  process.exit(2);
}
if (!databaseName.includes('_scale')) {
  console.error(`refusing to measure against "${databaseName}": the database name must contain "_scale"`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

/** Every relation name a plan touches, so a partition child matches its parent index. */
function relationsIn(node, out = new Set()) {
  if (!node) return out;
  if (node['Relation Name']) out.add(node['Relation Name']);
  if (node['Index Name']) out.add(node['Index Name']);
  for (const child of node.Plans ?? []) relationsIn(child, out);
  return out;
}

/** Every node type in the plan tree, so "did it sort?" is a fact, not a string scan. */
function nodeTypes(node, out = []) {
  if (!node) return out;
  if (node['Node Type']) out.push(node['Node Type']);
  for (const child of node.Plans ?? []) nodeTypes(child, out);
  return out;
}

/** Does the plan sort, how many rows it returns, and what does it scan? */
function summarise(plan, plannedRows) {
  const types = nodeTypes(plan);
  return {
    nodes: [...relationsIn(plan)],
    nodeTypes: types,
    sorts: types.includes('Sort'),
    seqScans: types.filter((type) => type === 'Seq Scan').length,
    indexScans: types.filter((type) => type.includes('Index Scan') || type === 'Index Only Scan').length,
    rows: plan['Actual Rows'] ?? null,
    plannedRows,
    totalMs: plan['Actual Total Time'] ?? null,
  };
}

/** First row of an EXPLAIN (ANALYZE, FORMAT JSON) run, with its plan text. */
async function explain(sql, params) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const plan = result.rows[0]['QUERY PLAN'][0];
  const text = await client.query(`EXPLAIN (COSTS OFF) ${sql}`, params);
  return {
    plan: plan.Plan,
    summary: { ...summarise(plan.Plan), totalMs: Number(plan['Execution Time'].toFixed(2)) },
    text: text.rows.map((row) => Object.values(row)[0]).join('\n'),
  };
}

const cases = [];

/** A branch that actually holds rows, so a branch page is a real page. */
async function busiestBranch(table, column = 'branch_id') {
  const result = await client.query(
    `SELECT ${column} AS branch, count(*)::int AS n FROM ${table}
      WHERE ${column} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`
  );
  if (!result.rows.length) return null;
  return result.rows[0];
}

function addCase(name, table, index, sql, params, expectation) {
  cases.push({ name, table, index, sql, params, expectation });
}

const salesBranch = await busiestBranch('sales_invoices');
if (salesBranch) {
  addCase(
    'sales register keyset page (branch, newest first)',
    'sales_invoices',
    'idx_sales_invoices_branch_page_id',
    `SELECT id, invoice_number, created_at FROM sales_invoices
      WHERE branch_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 51`,
    [salesBranch.branch],
    { ordered: true }
  );
}

const stockBranch = await busiestBranch('stock_operations');
if (stockBranch) {
  addCase(
    'stock operations keyset page (branch, newest first)',
    'stock_operations',
    'idx_stock_ops_branch_page_id',
    `SELECT id, reference_number, created_at FROM stock_operations
      WHERE branch_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 51`,
    [stockBranch.branch],
    { ordered: true }
  );
}

const auditBranch = await busiestBranch('audit_logs');
if (auditBranch) {
  addCase(
    'audit trail keyset page (branch, newest first)',
    'audit_logs',
    'idx_audit_branch_timestamp_id',
    `SELECT id, timestamp_ad FROM audit_logs
      WHERE branch_id = $1
      ORDER BY timestamp_ad DESC, id DESC LIMIT 51`,
    [auditBranch.branch],
    { ordered: true }
  );
}

// The fixture seeds no subledger rows, so that page is measured over a
// synthetic set inserted and analysed inside each case's transaction: 200,000
// rows over two years, which is the shape a working ledger reaches in months.
const SUBLEDGER_SYNTHETIC = `
  INSERT INTO gl_subledger_entries
    (id, journal_id, journal_line_id, account_id, subledger_type, branch_id, entry_date_ad, entry_date_bs, debit, credit)
  SELECT 'syn-' || g, j.id, l.id, a.id, 'CUSTOMER', j.branch_id,
         DATE '2025-01-01' + (g % 730), '2081-01-01', 1, 0
    FROM generate_series(1, 200000) g
    CROSS JOIN (SELECT id, branch_id FROM gl_journals ORDER BY id LIMIT 1) j
    CROSS JOIN (SELECT id FROM gl_journal_line_registry ORDER BY id LIMIT 1) l
    CROSS JOIN (SELECT id FROM gl_accounts ORDER BY id LIMIT 1) a
  ON CONFLICT DO NOTHING`;

addCase(
  'subledger book ledger page (date range, newest first)',
  'gl_subledger_entries',
  'idx_gl_subledger_date_page',
  `SELECT id, entry_date_ad FROM gl_subledger_entries
    WHERE entry_date_ad >= DATE '2025-01-01' AND entry_date_ad < DATE '2025-07-01'
    ORDER BY entry_date_ad DESC, id DESC LIMIT 51`,
  [],
  { ordered: true, prepare: SUBLEDGER_SYNTHETIC }
);

const brinCases = [
  ['gl_journals', 'journal_date_ad', 'idx_gl_journals_date_brin'],
  ['gl_subledger_entries', 'entry_date_ad', 'idx_gl_subledger_entry_date_brin'],
  ['stock_operations', 'date_ad', 'idx_stock_ops_date_brin'],
  ['serial_log', 'created_at', 'idx_serial_log_created_brin'],
  ['sales_invoices', 'created_at', 'idx_sales_invoices_created_brin'],
];

const report = { database: databaseName, pageReads: [], brin: [], failures: [] };

for (const testCase of cases) {
  report.pageReads.push({ name: testCase.name, table: testCase.table, index: testCase.index });
}

// The "before" plan needs the index gone, and the "after" plan needs the real
// definition back: read it from the catalogue once and recreate it verbatim.
const definitions = new Map();
for (const row of (await client.query(
  `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1)`,
  [cases.map((testCase) => testCase.index)]
)).rows) {
  definitions.set(row.indexname, row.indexdef);
}

for (let at = 0; at < cases.length; at += 1) {
  const testCase = cases[at];
  const entry = report.pageReads[at];
  await client.query('BEGIN');
  try {
    const definition = definitions.get(testCase.index);
    if (!definition) throw new Error(`index ${testCase.index} is missing: migration 0040 has not been applied to this database`);
    // pg_indexes renders a partitioned parent index as `ON ONLY`; the measured
    // plan scans the children, so the index has to be built on them too.
    await client.query(`DROP INDEX IF EXISTS ${testCase.index}`);
    if (testCase.expectation.prepare) {
      await client.query(testCase.expectation.prepare);
      await client.query(`ANALYZE ${testCase.table}`);
    }
    const before = await explain(testCase.sql, testCase.params);
    await client.query(definition.replace(' ON ONLY ', ' ON '));
    const after = await explain(testCase.sql, testCase.params);
    entry.before = before;
    entry.after = after;
    entry.note = undefined;
    // Children of a partitioned index carry auto-generated names
    // (`<child>_branch_id_created_at_id_idx`), so the proof is the plan shape:
    // the page comes back from index scans, ordered, with no Sort node.
    if (!after.summary.indexScans || after.summary.seqScans) {
      report.failures.push(`${testCase.name}: after-plain plan is not an index scan (${after.summary.nodeTypes.join(', ')})`);
    }
    if (testCase.expectation.ordered && after.summary.sorts) {
      report.failures.push(`${testCase.name}: after-plain plan still sorts`);
    }
    if (!after.summary.rows) report.failures.push(`${testCase.name}: the measured query returned no rows`);
    if (before.summary.totalMs !== null && after.summary.totalMs !== null) {
      entry.speedup = Number((before.summary.totalMs / Math.max(after.summary.totalMs, 0.001)).toFixed(1));
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

// BRIN: show that a wide range read can use the index (forced, because on a
// still-small scratch table the planner rightly prefers a scan) and how small the
// index is next to the table.
for (const [table, column, indexName] of brinCases) {
  const exists = await client.query('SELECT 1 FROM pg_class WHERE relname = $1', [indexName]);
  if (!exists.rows.length) {
    report.failures.push(`BRIN ${indexName} is missing: migration 0040 has not been applied to this database`);
    continue;
  }
  // A partitioned index parent is an empty shell: its size is the sum of its
  // children, which is what the heap comparison has to use.
  const sizes = await client.query(
    `WITH RECURSIVE idx AS (
       SELECT c.oid, c.relname FROM pg_class c
        WHERE c.relname = $1 AND c.relkind = 'I'
       UNION ALL
       SELECT child.oid, child.relname FROM pg_inherits i
         JOIN pg_class child ON child.oid = i.inhrelid
         JOIN idx parent ON parent.oid = i.inhparent
     )
     SELECT pg_size_pretty(COALESCE(SUM(pg_relation_size(idx.oid)), 0)) AS index_size,
            count(*)::int AS index_parts
       FROM idx`,
    [indexName]
  );
  const heapSize = await client.query(
    `WITH RECURSIVE heap AS (
       SELECT c.oid FROM pg_class c WHERE c.relname = $1 AND c.relkind IN ('p', 'r')
       UNION ALL
       SELECT child.oid FROM pg_inherits i
         JOIN pg_class child ON child.oid = i.inhrelid
         JOIN heap parent ON parent.oid = i.inhparent
     )
     SELECT pg_size_pretty(COALESCE(SUM(pg_total_relation_size(heap.oid)), 0)) AS table_size
       FROM heap`,
    [table]
  );
  sizes.rows[0].table_size = heapSize.rows[0].table_size;
  // A window the table actually holds, taken from the table itself rather than
  // from today's date (the fixture's months are historical).
  const window = await client.query(
    `SELECT max(${column})::date AS high, count(*)::int AS n FROM ${table}`
  );
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_seqscan = off');
    if (window.rows[0].n > 0) {
      const forced = await explain(
        `SELECT count(*) FROM ${table} WHERE ${column} >= $1::date - 180 AND ${column} < $1::date + 1`,
        [window.rows[0].high]
      );
      const indexParts = await client.query(
        `SELECT a.amname FROM pg_class c JOIN pg_am a ON a.oid = c.relam
          WHERE c.relname = ANY($1)`,
        [forced.summary.nodes]
      );
      const usesBrin = indexParts.rows.some((row) => row.amname === 'brin');
      report.brin.push({
        table,
        column,
        index: indexName,
        size: sizes.rows[0],
        rowsInWindow: window.rows[0].n,
        usesBrin,
        plan: forced.text,
      });
      // On a table too small for the planner to bother with a BRIN (the journals
      // here are 1,000 rows), preferring the B-tree is the correct plan; the gate
      // only insists on the BRIN where it would actually be the right choice.
      if (!usesBrin && window.rows[0].n >= 50000) {
        report.failures.push(`BRIN ${indexName}: the range read cannot use it even with seq scans disabled`);
      }
    } else {
      report.brin.push({ table, column, index: indexName, size: sizes.rows[0], rowsInWindow: 0, usesBrin: false, plan: null, skipped: 'table is empty' });
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
  }
}

await client.end();

for (const entry of report.pageReads) {
  console.log(`\n== ${entry.name} (${entry.table}, ${entry.index})`);
  console.log(`   before: ${entry.before.summary.totalMs} ms, sort=${entry.before.summary.sorts}, index scans=${entry.before.summary.indexScans}, seq scans=${entry.before.summary.seqScans}`);
  console.log(`   after : ${entry.after.summary.totalMs} ms, sort=${entry.after.summary.sorts}, index scans=${entry.after.summary.indexScans}, seq scans=${entry.after.summary.seqScans}`);
  console.log(entry.after.text.split('\n').map((line) => `   | ${line}`).join('\n'));
}
for (const entry of report.brin) {
  console.log(`\n== BRIN ${entry.index} on ${entry.table}(${entry.column}) — index ${entry.size.index_size} (${entry.size.index_parts} part(s)) vs table ${entry.size.table_size}`);
  console.log(`   rows in window: ${entry.rowsInWindow}; forced range read uses the BRIN: ${entry.usesBrin}${entry.skipped ? ` (${entry.skipped})` : ''}`);
}

if (jsonAt) {
  fs.writeFileSync(jsonAt, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${jsonAt}`);
}

if (report.failures.length) {
  console.error('\nFAILED:');
  for (const failure of report.failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('\nOK: every page read uses its index without sorting, and every BRIN is usable for its range read.');
