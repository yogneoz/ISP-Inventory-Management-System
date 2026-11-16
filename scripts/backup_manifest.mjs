#!/usr/bin/env node
/**
 * BAK-1 manifest generator.
 *
 * Reads the parent-only table counts and the ledger block directly from the
 * source database, then writes one JSON sidecar. Kept separate from the shell
 * script so numbers are typed (not string-joined) and JSON escaping cannot be
 * broken by a table name.
 *
 * Required connection: DATABASE_URL, or POSTGRES_HOST/PORT/DB/USER/PASSWORD.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

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
for (const required of ['output', 'database', 'file', 'created-at', 'bytes', 'sha256', 'encryption-mode']) {
  if (!args[required]) throw new Error(`missing --${required}`);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'inventory_db',
  user: process.env.POSTGRES_USER || 'inventory_user',
  password: process.env.POSTGRES_PASSWORD || 'securepassword',
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const tables = await pool.query(`
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

  const totals = await pool.query(`
    SELECT COALESCE(sum(debit), 0)::text AS debit,
           COALESCE(sum(credit), 0)::text AS credit
    FROM gl_journal_lines
  `);
  const imbalances = await pool.query(`
    SELECT count(*)::int AS imbalances
    FROM (
      SELECT journal_id
      FROM gl_journal_lines
      GROUP BY journal_id, journal_date_ad
      HAVING sum(debit) <> sum(credit)
    ) bad
  `);
  const trial = await pool.query(`
    WITH balances AS (
      SELECT account_id, sum(debit - credit)::numeric(16, 2) AS balance
      FROM gl_journal_lines
      GROUP BY account_id
    )
    SELECT md5(string_agg(account_id || ':' || balance::text,
                          '|' ORDER BY account_id COLLATE "C")) AS checksum,
           COALESCE(sum(balance), 0)::text AS net
    FROM balances
  `);

  const manifest = {
    format: 'pg_dump-custom',
    created_at: args['created-at'],
    database: args.database,
    file: args.file,
    byte_size: Number(args.bytes),
    sha256: args.sha256,
    // The checksum of the pre-encryption archive. Restore verifies this after
    // decrypting; `sha256` remains the on-disk artifact checksum.
    plaintext_sha256: args['plaintext-sha256'] || null,
    encryption: {
      mode: args['encryption-mode'],
      ...(args.recipient ? { recipient: args.recipient } : {}),
    },
    tools: {
      server: args['server-version'] || null,
      pg_dump: args['pg-dump-version'] || null,
      pg_restore: args['pg-restore-version'] || null,
    },
    table_count: tables.rows.length,
    tables: tables.rows.map((row) => ({ name: row.name, rows: Number(row.rows) })),
    gl: {
      debit: totals.rows[0].debit,
      credit: totals.rows[0].credit,
      imbalance_journals: imbalances.rows[0].imbalances,
      checksum: trial.rows[0].checksum,
      net: trial.rows[0].net,
    },
  };

  const output = path.resolve(args.output);
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`[backup] manifest: ${tables.rows.length} tables, GL debit=${manifest.gl.debit} credit=${manifest.gl.credit}`);
} finally {
  await pool.end().catch(() => {});
}
