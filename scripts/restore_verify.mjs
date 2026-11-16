#!/usr/bin/env node
/**
 * BAK-2 post-restore proof.
 *
 * Compares the restored target with the backup manifest:
 *   - every parent-only public table is present with the recorded row count;
 *   - GL debit/credit, imbalance count, trial-balance checksum and net match.
 *
 * Reads the target connection from RESTORE_TARGET_URL (the restore script
 * builds it from DATABASE_URL + --target) or the normal PG* variables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.manifest) throw new Error('missing --manifest');
const target = args.database || process.env.PGDATABASE || '(target)';
const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
if (!Array.isArray(manifest.tables)) throw new Error('manifest has no tables array');
if (!manifest.gl) throw new Error('manifest has no gl block');

const pool = new pg.Pool({
  connectionString: process.env.RESTORE_TARGET_URL || process.env.DATABASE_URL || undefined,
  host: process.env.PGHOST || 'localhost',
  port: Number.parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'inventory_db',
  user: process.env.PGUSER || 'inventory_user',
  password: process.env.PGPASSWORD || 'securepassword',
  max: 1,
  connectionTimeoutMillis: 10_000,
});

function normalize(value) {
  return Number(value);
}

try {
  const actual = await pool.query(`
    SELECT c.relname AS name,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                               false, true, '')))[1]::text::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
    ORDER BY 1
  `);
  const expected = new Map(manifest.tables.map((row) => [row.name, Number(row.rows)]));
  const found = new Map(actual.rows.map((row) => [row.name, Number(row.rows)]));
  const problems = [];
  for (const [name, rows] of expected) {
    if (!found.has(name)) problems.push(`missing table ${name} (expected ${rows})`);
    else if (found.get(name) !== rows) {
      problems.push(`table ${name}: expected ${rows} rows, found ${found.get(name)}`);
    }
  }
  for (const [name, rows] of found) {
    if (!expected.has(name)) problems.push(`unexpected table ${name} (${rows} rows)`);
  }
  const glActual = (await pool.query(fs.readFileSync(path.join(HERE, 'restore_checks.sql'), 'utf8'))).rows[0];
  for (const key of ['debit', 'credit']) {
    if (normalize(glActual[key]) !== normalize(manifest.gl[key])) {
      problems.push(`GL ${key}: expected ${manifest.gl[key]}, found ${glActual[key]}`);
    }
  }
  if (normalize(glActual.net) !== normalize(manifest.gl.net)) {
    problems.push(`GL net: expected ${manifest.gl.net}, found ${glActual.net}`);
  }
  if (Number(glActual.imbalance_journals) !== Number(manifest.gl.imbalance_journals)) {
    problems.push(
      `GL imbalance journals: expected ${manifest.gl.imbalance_journals}, found ${glActual.imbalance_journals}`
    );
  }
  if (manifest.gl.checksum && glActual.checksum !== manifest.gl.checksum) {
    problems.push(`GL checksum: expected ${manifest.gl.checksum}, found ${glActual.checksum}`);
  }

  console.log(
    `[restore:verify] ${target}: ${found.size}/${expected.size} tables checked; ` +
      `GL debit=${glActual.debit} credit=${glActual.credit} imbalances=${glActual.imbalance_journals} net=${glActual.net}`
  );
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 10)) console.error(`[restore:verify] MISMATCH: ${problem}`);
    if (problems.length > 10) console.error(`[restore:verify] … +${problems.length - 10} more mismatch(es)`);
    process.exitCode = 1;
  }
} finally {
  await pool.end().catch(() => {});
}
