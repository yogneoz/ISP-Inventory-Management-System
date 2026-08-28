/**
 * PostgreSQL-first read helpers.
 *
 * When durable Postgres is connected, prefer SQL results and refresh the
 * in-memory cache. When offline, fall back to store arrays.
 */
import { isPgConnected, pgPool } from './db';
import { logger } from './logger';

export type PgRowMapper<T> = (row: any) => T;

/**
 * Run a SELECT against Postgres when connected; otherwise return fallback().
 * Optionally sync rows into memory via onRows.
 */
export async function readPgOrStore<T>(options: {
  sql: string;
  params?: any[];
  fallback: () => T[] | Promise<T[]>;
  map?: PgRowMapper<T>;
  onRows?: (rows: T[]) => void | Promise<void>;
  label?: string;
}): Promise<T[]> {
  if (isPgConnected) {
    try {
      const result = await pgPool.query(options.sql, options.params || []);
      const rows = (result.rows || []).map((r: any) => (options.map ? options.map(r) : (r as T)));
      if (options.onRows) await options.onRows(rows);
      return rows;
    } catch (err: any) {
      logger.warn({
        msg: 'pg_read_fallback',
        label: options.label || 'query',
        error: err?.message || String(err),
      });
    }
  }
  return options.fallback();
}

/** Convenience: single-row lookup. */
export async function readPgOneOrStore<T>(options: {
  sql: string;
  params?: any[];
  fallback: () => T | null | undefined | Promise<T | null | undefined>;
  map?: PgRowMapper<T>;
  label?: string;
}): Promise<T | null> {
  const rows = await readPgOrStore<T>({
    sql: options.sql,
    params: options.params,
    fallback: async () => {
      const one = await options.fallback();
      return one ? [one] : [];
    },
    map: options.map,
    label: options.label,
  });
  return rows[0] || null;
}

export function num(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
