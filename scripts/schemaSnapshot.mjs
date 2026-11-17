/**
 * Runtime schema snapshot and diff (worklist A6).
 *
 * `scripts/verify_fresh_install.mjs` proves that what the server boot creates on
 * an empty database equals `scripts/schema.sql` plus the numbered migrations. It
 * compared tables, columns, constraints, indexes, triggers, sequences and views
 * — but not `reloptions`, so the storage tuning shipped in 2026-11-17
 * (`fillfactor = 80`, the autovacuum scale factors on the two hot tables, BRIN's
 * `pages_per_range`) could drift between a fresh install and a booted install
 * with CI staying green.
 *
 * This module is the guard's decision logic, kept importable so a test can prove
 * that a divergent `fillfactor` fails it without provisioning two databases.
 *
 * Categories, and what each one holds:
 *   tables      — relation name and kind
 *   columns     — type, nullability, default, identity/generated
 *   constraints — name, type and definition
 *   indexes     — `pg_indexes.indexdef` (shape and predicate; NOT storage params)
 *   storage     — `pg_class.reloptions` for tables, partitioned tables, indexes
 *                 and matviews: fillfactor, autovacuum, BRIN pages_per_range
 *   triggers    — non-internal trigger definitions
 *   sequences   — start/increment/min/max/cycle
 *   views       — whitespace-normalized definitions
 */

/**
 * Relation-level storage parameters. `pg_indexes.indexdef` carries no storage
 * parameters, so without this query an index's `fillfactor` (or a BRIN's
 * `pages_per_range`) is invisible to the guard.
 */
export const STORAGE_QUERY_SQL = `
  SELECT c.relname AS name,
         c.relkind AS kind,
         COALESCE(array_to_string(c.reloptions, ','), '') AS reloptions
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'i', 'm')
   ORDER BY 1`;

/**
 * Snapshot a database through an open client. Every row set is plain data so two
 * snapshots can be compared with no knowledge of PostgreSQL.
 */
export async function snapshotSchema(client) {
  const q = async (sql) => (await client.query(sql)).rows;

  const tables = await q(`
    SELECT c.relname AS table_name, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY 1`);

  const columns = await q(`
    SELECT cls.relname AS table_name, attr.attname AS column_name,
           pg_catalog.format_type(attr.atttypid, attr.atttypmod) AS data_type,
           attr.attnotnull AS not_null,
           COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS column_default,
           attr.attidentity AS identity, attr.attgenerated AS generated
    FROM pg_attribute attr
    JOIN pg_class cls ON cls.oid = attr.attrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = attr.attrelid AND d.adnum = attr.attnum
    WHERE n.nspname = 'public' AND cls.relkind IN ('r', 'p')
      AND attr.attnum > 0 AND NOT attr.attisdropped
    ORDER BY cls.relname, attr.attnum`);

  const constraints = await q(`
    SELECT cls.relname AS table_name, con.conname, con.contype,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY 1, 2`);

  const indexes = await q(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes WHERE schemaname = 'public'
    ORDER BY 1, 2`);

  const storage = await q(STORAGE_QUERY_SQL);

  const triggers = await q(`
    SELECT cls.relname AS table_name, trg.tgname,
           pg_get_triggerdef(trg.oid) AS def
    FROM pg_trigger trg
    JOIN pg_class cls ON cls.oid = trg.tgrelid
    JOIN pg_namespace n ON n.oid = cls.relnamespace
    WHERE n.nspname = 'public' AND NOT trg.tgisinternal
    ORDER BY 1, 2`);

  const sequences = await q(`
    SELECT sequencename, data_type, start_value, increment_by, min_value,
           max_value, cycle
    FROM pg_sequences WHERE schemaname = 'public'
    ORDER BY 1`);

  const views = await q(`
    SELECT viewname, regexp_replace(definition, '\\s+', ' ', 'g') AS definition
    FROM pg_views WHERE schemaname = 'public'
    ORDER BY 1`);

  return { tables, columns, constraints, indexes, storage, triggers, sequences, views };
}

/** Every category the guard compares, in reporting order. */
export const SNAPSHOT_CATEGORIES = [
  'tables',
  'columns',
  'constraints',
  'indexes',
  'storage',
  'triggers',
  'sequences',
  'views',
];

/** JSON rows, sorted, so a comparison is order-independent. */
export function renderRows(rows) {
  return rows.map((row) => JSON.stringify(row)).sort();
}

/**
 * Rows present on only one side. An empty result on both sides is parity; the
 * guard fails when either list is non-empty.
 */
export function diffRows(refRows, bootRows) {
  const ref = renderRows(refRows);
  const boot = renderRows(bootRows);
  return {
    onlyRef: ref.filter((row) => !boot.includes(row)),
    onlyBoot: boot.filter((row) => !ref.includes(row)),
  };
}
