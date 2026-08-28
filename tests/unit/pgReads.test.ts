import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPgOrStore, readPgOneOrStore, num } from '../../server/lib/pgReads';
import * as db from '../../server/lib/db';

describe('pgReads helpers', () => {
  const originalQuery = db.pgPool.query;

  beforeEach(() => {
    db.setPgConnected(false);
    db.setDbMode('memory');
  });

  afterEach(() => {
    db.pgPool.query = originalQuery;
    db.setPgConnected(false);
    db.setDbMode('memory');
  });

  it('num coerces safely', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num(undefined, 3)).toBe(3);
    expect(num('nope', 1)).toBe(1);
  });

  it('uses fallback when postgres is offline', async () => {
    const rows = await readPgOrStore({
      sql: 'SELECT 1',
      fallback: () => [{ id: 'mem' }],
    });
    expect(rows).toEqual([{ id: 'mem' }]);
  });

  it('uses SQL rows when durable and refreshes via onRows', async () => {
    db.setDbMode('postgres');
    db.setPgConnected(true);
    let mirrored: any[] = [];
    db.pgPool.query = async () => ({ rows: [{ id: 'pg', n: '2' }] }) as any;

    const rows = await readPgOrStore({
      sql: 'SELECT id FROM t',
      fallback: () => [{ id: 'mem' }],
      map: (r) => ({ id: r.id, n: num(r.n) }),
      onRows: (r) => {
        mirrored = r;
      },
    });
    expect(rows).toEqual([{ id: 'pg', n: 2 }]);
    expect(mirrored).toEqual(rows);
  });

  it('falls back when SQL throws', async () => {
    db.setDbMode('postgres');
    db.setPgConnected(true);
    db.pgPool.query = async () => {
      throw new Error('boom');
    };
    const rows = await readPgOrStore({
      sql: 'SELECT 1',
      fallback: () => [{ id: 'fb' }],
    });
    expect(rows).toEqual([{ id: 'fb' }]);
  });

  it('readPgOneOrStore returns first row or null', async () => {
    db.setPgConnected(false);
    const one = await readPgOneOrStore({
      sql: 'SELECT 1',
      fallback: () => ({ id: 'x' }),
    });
    expect(one).toEqual({ id: 'x' });

    const none = await readPgOneOrStore({
      sql: 'SELECT 1',
      fallback: () => null,
    });
    expect(none).toBeNull();
  });
});
