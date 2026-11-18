/**
 * SCALE-3 — pre-aggregated stock and closed-year read models.
 *
 * Runs against its own throwaway database (scripts/schema.sql already carries
 * the read-model DDL), because the rebuild truncates and recomputes a table that
 * every other suite's stock writes touch.
 *
 * What is proven, not asserted:
 *   - the trigger-maintained table equals a from-scratch rebuild, byte for byte;
 *   - a rolled-back ledger write leaves no phantom row behind;
 *   - a read-model write that could not be applied (locked row, timed out) is
 *     queued durably, is visible as pending, and replays through the same
 *     function the operator command calls;
 *   - a truncated/stale read model rebuilds to the right values;
 *   - the closed-year snapshot rebuild reproduces the close-time definition on a
 *     hand-computed fixture;
 *   - the read SQL is branch-scoped.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { createThrowawayDatabase, dropThrowawayDatabase } from './fixtures/throwawayDatabase';
import {
  ACCOUNT_BALANCE_ROWS_SQL,
  FISCAL_YEAR_BALANCE_ACCOUNT_ROWS_SQL,
} from '../server/src/models/accounting.repo';
import {
  buildTrialBalance,
  resolveStatementWindow,
} from '../server/src/services/accountingStatements.service';
import {
  BRANCH_STOCK_BALANCES_SQL,
  BRANCH_STOCK_VALUE_SQL,
  FISCAL_YEAR_BALANCES_REBUILD_SQL,
  READ_MODEL_FLUSH_SQL,
  READ_MODEL_PENDING_COUNT_SQL,
  STOCK_BALANCE_REBUILD_SQL,
} from '../server/src/models/readModels.repo';

dotenv.config();

const TEST_DB = 'inventory_read_models_test';
const BRANCH = 'RMB1';
const OTHER_BRANCH = 'RMB2';
const PRODUCT = 'rm-p1';
const PRODUCT_2 = 'rm-p2';
const FY = 'fy-rm';

let pool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;
let ready = false;

try {
  if (process.env.DATABASE_URL) {
    const db = await createThrowawayDatabase(process.env.DATABASE_URL, TEST_DB);
    pool = db.pool;
    adminPool = db.adminPool;

    await pool.query(
      `INSERT INTO branches (id, code, name, location, is_demo)
       VALUES ($1, $1, 'Read Model Branch', 'Test', FALSE),
              ($2, $2, 'Read Model Branch 2', 'Test', FALSE)`,
      [BRANCH, OTHER_BRANCH]
    );
    await pool.query(
      `INSERT INTO product_groups (id, code, name, behavior)
       VALUES ('rmpg', 'RMPG', 'Read Model Group', 'STOCK_ITEM')`
    );
    await pool.query(
      `INSERT INTO products (id, sku, name, category, product_group, cost_price)
       VALUES ($1, 'RM-P1', 'Read Model Product 1', 'Test', 'Read Model Group', 5),
              ($2, 'RM-P2', 'Read Model Product 2', 'Test', 'Read Model Group', 7)`,
      [PRODUCT, PRODUCT_2]
    );
    ready = true;
  }
} catch {
  ready = false;
  pool = null;
}

const skipNoDb = !ready && 'needs a reachable PostgreSQL (read-model fixture)';

/** One ledger row; the trigger is what puts it into the read model. */
async function ledgerRow(
  client: pg.Client | pg.Pool,
  id: string,
  productId: string,
  quantityAfter: number,
  options: { timestamp?: string; unitCost?: number; branchId?: string } = {}
): Promise<void> {
  await client.query(
    `INSERT INTO transaction_logs (
       id, transaction_number, product_id, product_sku, product_name, branch_id,
       change_type, quantity_before, quantity_changed, quantity_after, unit_cost, timestamp_ad, timestamp_bs
     ) VALUES ($1, $1, $2, 'SKU', 'Product', $3, 'MANUAL_ADJUSTMENT', $4, $5, $6, $7, COALESCE($8::timestamptz, now()), '2082-01-01')`,
    [
      id,
      productId,
      options.branchId ?? BRANCH,
      Math.max(0, quantityAfter - 1),
      1,
      quantityAfter,
      options.unitCost ?? 5,
      options.timestamp ?? null,
    ]
  );
}

async function stockRow(productId: string = PRODUCT) {
  const result = await pool!.query(
    `SELECT branch_id, product_id, quantity, value::text AS value, source_txn_id, source_timestamp, updated_at
       FROM branch_stock_balances WHERE branch_id = $1 AND product_id = $2`,
    [BRANCH, productId]
  );
  return result.rows[0] ?? null;
}

async function stockSnapshot() {
  const result = await pool!.query(
    `SELECT branch_id, product_id, quantity, value::text AS value, source_txn_id, source_timestamp, updated_at
       FROM branch_stock_balances ORDER BY branch_id, product_id`
  );
  return result.rows;
}

describe('read models (throwaway PostgreSQL)', { skip: skipNoDb }, () => {
  after(async () => {
    if (pool) await pool.end().catch(() => undefined);
    await dropThrowawayDatabase(adminPool, TEST_DB);
  });

  test('a ledger write updates the stock model in the same transaction', async () => {
    await ledgerRow(pool!, 'rm-txn-1', PRODUCT, 10, { unitCost: 5, timestamp: '2026-01-01T00:00:00Z' });
    const row = await stockRow();
    assert.equal(row.quantity, 10);
    assert.equal(row.value, '50.00');
    assert.equal(row.source_txn_id, 'rm-txn-1');
  });

  test('a rolled-back write leaves no phantom in the read model', async () => {
    const before = await stockRow();
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await ledgerRow(client, 'rm-txn-rollback', PRODUCT, 999);
      const inside = await client.query(
        'SELECT quantity FROM branch_stock_balances WHERE branch_id = $1 AND product_id = $2',
        [BRANCH, PRODUCT]
      );
      assert.equal(inside.rows[0].quantity, 999, 'inside the transaction the model already reflects the write');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(await stockRow(), before, 'after ROLLBACK the model is exactly what it was');
  });

  test('a late, backdated ledger row does not overwrite a newer position', async () => {
    await ledgerRow(pool!, 'rm-txn-2', PRODUCT, 4, { timestamp: '2026-01-03T00:00:00Z' });
    await ledgerRow(pool!, 'rm-txn-0-backdated', PRODUCT, 99, { timestamp: '2026-01-02T00:00:00Z' });
    const row = await stockRow();
    assert.equal(row.quantity, 4, 'the newest (timestamp, id) wins');
    assert.equal(row.source_txn_id, 'rm-txn-2');
  });

  test('incremental maintenance equals a from-scratch rebuild, byte for byte', async () => {
    await ledgerRow(pool!, 'rm-txn-3', PRODUCT_2, 7, { unitCost: 3, timestamp: '2026-02-01T00:00:00Z' });
    await ledgerRow(pool!, 'rm-txn-4', PRODUCT_2, 8, { unitCost: 3, timestamp: '2026-02-02T00:00:00Z' });

    const incremental = await stockSnapshot();
    assert.equal(incremental.length, 2, JSON.stringify(incremental));

    const rebuilt = await pool!.query(STOCK_BALANCE_REBUILD_SQL);
    assert.equal(Number(rebuilt.rows[0].rows), 2);
    const afterRebuild = await stockSnapshot();
    assert.deepEqual(afterRebuild, incremental, 'the rebuilt table is identical, including updated_at');

    // The fixture's numbers are hand-checkable: 4 × 5 and 8 × 3.
    const byProduct = new Map(afterRebuild.map((row: any) => [row.product_id, row]));
    assert.equal(byProduct.get(PRODUCT).quantity, 4);
    assert.equal(byProduct.get(PRODUCT).value, '20.00');
    assert.equal(byProduct.get(PRODUCT_2).quantity, 8);
    assert.equal(byProduct.get(PRODUCT_2).value, '24.00');
  });

  test('a locked read-model row is queued, visible as pending, and replays', async () => {
    const holder = await pool!.connect();
    const writer = await pool!.connect();
    try {
      // Hold the model row so the trigger's apply cannot complete.
      await holder.query('BEGIN');
      await holder.query(
        'SELECT quantity FROM branch_stock_balances WHERE branch_id = $1 AND product_id = $2 FOR UPDATE',
        [BRANCH, PRODUCT]
      );

      await writer.query('BEGIN');
      await writer.query(`SET LOCAL lock_timeout = '200ms'`);
      await ledgerRow(writer, 'rm-txn-queued', PRODUCT, 15);
      await writer.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      writer.release();
    }

    // The ledger row committed, the model update did not: the work is queued,
    // not dropped, and the gap is observable.
    const pending = (await pool!.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0];
    assert.equal(pending.pending, 1, JSON.stringify(pending));
    assert.equal((await stockRow()).quantity, 4, 'the read model is still behind');

    const flushed = (await pool!.query(READ_MODEL_FLUSH_SQL, [100])).rows[0];
    assert.equal(Number(flushed.applied), 1);
    assert.equal(Number(flushed.failed), 0);
    assert.equal(Number(flushed.remaining), 0);
    assert.equal((await stockRow()).quantity, 15, 'the queued write replayed into the model');

    const after = (await pool!.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0];
    assert.equal(after.pending, 0);
  });

  test('a truncated read model rebuilds to the values the ledger implies', async () => {
    const expected = await stockSnapshot();
    await pool!.query('TRUNCATE branch_stock_balances');
    assert.equal((await stockSnapshot()).length, 0, 'the model is empty first');

    await pool!.query(STOCK_BALANCE_REBUILD_SQL);
    assert.deepEqual(await stockSnapshot(), expected);
  });

  test('reads are branch-scoped, and the per-branch total comes from the model', async () => {
    const mine = (await pool!.query(BRANCH_STOCK_BALANCES_SQL, [BRANCH, 100])).rows;
    assert.equal(mine.length, 2);
    const other = (await pool!.query(BRANCH_STOCK_BALANCES_SQL, [OTHER_BRANCH, 100])).rows;
    assert.deepEqual(other, [], 'another branch sees nothing');

    const total = (await pool!.query(BRANCH_STOCK_VALUE_SQL, [BRANCH])).rows[0];
    assert.equal(total.productCount, 2);
    assert.equal(total.quantity, '23');
    assert.equal(total.value, '99.00');
  });

  test('the closed-year snapshot rebuilds to the close-time definition', async () => {
    // A closed year with one ordinary journal and its closing journal. The
    // expected snapshot is computed by hand below, not by the function itself.
    await pool!.query(
      `INSERT INTO fiscal_years (id, code, start_date_ad, end_date_ad, start_date_bs, end_date_bs, is_current, is_closed)
       VALUES ($1, 'RM-2080', '2023-07-17', '2024-07-15', '2080-04-01', '2081-03-31', FALSE, TRUE)`,
      [FY]
    );
    await pool!.query(
      `INSERT INTO gl_periods (id, fiscal_year_id, period_key, start_date_ad, start_date_bs, end_date_ad, end_date_bs, status)
       VALUES ('per-rm', $1, '2080-04', '2023-07-17', '2080-04-01', '2024-07-15', '2081-03-31', 'CLOSED')`,
      [FY]
    );
    await pool!.query(
      `INSERT INTO gl_account_groups (id, code, name, account_type, statement_group, normal_balance) VALUES
         ('rm-cash', 'RMCASH', 'RM Cash', 'ASSET', 'CURRENT_ASSET', 'DEBIT'),
         ('rm-income', 'RMINC', 'RM Income', 'INCOME', 'REVENUE', 'CREDIT'),
         ('rm-equity', 'RMEQ', 'RM Retained', 'EQUITY', 'EQUITY', 'CREDIT')`
    );
    await pool!.query(
      `INSERT INTO gl_accounts (id, code, name, group_id, normal_balance) VALUES
         ('rm-cash', 'RM1000', 'RM Cash', 'rm-cash', 'D'),
         ('rm-sales', 'RM4000', 'RM Sales', 'rm-income', 'C'),
         ('rm-retained', 'RM3000', 'RM Retained', 'rm-equity', 'C')`
    );

    const journal = async (id: string, date: string, sourceType: string, sourceId: string | null, lines: Array<[string, number, number]>) => {
      // The registry row is created by trg_gl_journals_registry_sync.
      await pool!.query(
        `INSERT INTO gl_journals (id, journal_no, journal_date_ad, journal_date_bs, fiscal_year_id, period_id, branch_id, source_type, source_id)
         VALUES ($1, $1, $2, '2080-01-01', $3, 'per-rm', $4, $5, $6)`,
        [id, date, FY, BRANCH, sourceType, sourceId]
      );
      let lineNo = 0;
      for (const [accountId, debit, credit] of lines) {
        lineNo += 1;
        await pool!.query(
          `INSERT INTO gl_journal_lines (id, journal_id, journal_date_ad, journal_date_bs, line_no, account_id, branch_id, debit, credit)
           VALUES ($1, $2, $3, '2080-01-01', $4, $5, $6, $7, $8)`,
          [`${id}-l${lineNo}`, id, date, lineNo, accountId, BRANCH, debit, credit]
        );
      }
    };

    await journal('rm-j1', '2024-06-30', 'MANUAL', null, [
      ['rm-cash', 1000, 0],
      ['rm-sales', 0, 1000],
    ]);
    await journal('rm-j2', '2024-07-15', 'YEAR_END_CLOSE', FY, [
      ['rm-sales', 1000, 0],
      ['rm-retained', 0, 1000],
    ]);

    const rebuilt = await pool!.query(FISCAL_YEAR_BALANCES_REBUILD_SQL, [FY]);
    assert.equal(Number(rebuilt.rows[0].rows), 3);

    const rows = (
      await pool!.query(
        `SELECT account_id, pre_close_debit::text AS pd, pre_close_credit::text AS pc,
                pre_close_balance::text AS pb, close_debit::text AS cd, close_credit::text AS cc,
                post_close_balance::text AS po
           FROM fiscal_year_balances WHERE fiscal_year_id = $1 ORDER BY account_id`,
        [FY]
      )
    ).rows;
    assert.deepEqual(rows, [
      { account_id: 'rm-cash', pd: '1000.00', pc: '0.00', pb: '1000.00', cd: '0.00', cc: '0.00', po: '1000.00' },
      { account_id: 'rm-retained', pd: '0.00', pc: '0.00', pb: '0.00', cd: '0.00', cc: '1000.00', po: '-1000.00' },
      { account_id: 'rm-sales', pd: '0.00', pc: '1000.00', pb: '-1000.00', cd: '1000.00', cc: '0.00', po: '0.00' },
    ]);

    // Idempotent: the second rebuild produces exactly the same snapshot.
    const first = rows;
    await pool!.query(FISCAL_YEAR_BALANCES_REBUILD_SQL, [FY]);
    const second = (
      await pool!.query(
        `SELECT account_id, pre_close_debit::text AS pd, pre_close_credit::text AS pc,
                pre_close_balance::text AS pb, close_debit::text AS cd, close_credit::text AS cc,
                post_close_balance::text AS po
           FROM fiscal_year_balances WHERE fiscal_year_id = $1 ORDER BY account_id`,
        [FY]
      )
    ).rows;
    assert.deepEqual(second, first);
  });

  test('a queued closed-year rebuild replays through the same flush', async () => {
    // The snapshot is immutable by design; the documented purge switch (used by
    // the admin reset) is what allows the simulated loss here.
    await pool!.query('BEGIN');
    await pool!.query(`SELECT set_config('inventory.allow_ledger_purge', 'on', true)`);
    await pool!.query('DELETE FROM fiscal_year_balances WHERE fiscal_year_id = $1', [FY]);
    await pool!.query('COMMIT');
    await pool!.query(
      `SELECT enqueue_read_model_write('fiscal_year_balances', jsonb_build_object('fiscalYearId', $1::text), '{}'::jsonb, 'simulated close failure')`,
      [FY]
    );
    const pending = (await pool!.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0];
    assert.equal(pending.pending, 1);

    const flushed = (await pool!.query(READ_MODEL_FLUSH_SQL, [100])).rows[0];
    assert.equal(Number(flushed.applied), 1);
    assert.equal(Number(flushed.remaining), 0);
    const count = (await pool!.query(
      'SELECT count(*)::int AS n FROM fiscal_year_balances WHERE fiscal_year_id = $1',
      [FY]
    )).rows[0].n;
    assert.equal(count, 3, 'the snapshot was recomputed by the queued replay');
  });

  test('a closed year reads the snapshot with the ledger\'s own figures', async () => {
    const fy = (
      await pool!.query(
        `SELECT start_date_ad::text AS start, end_date_ad::text AS "end"
           FROM fiscal_years WHERE id = $1`,
        [FY]
      )
    ).rows[0];
    assert.ok(fy, 'the fixture fiscal year exists');
    await pool!.query(FISCAL_YEAR_BALANCES_REBUILD_SQL, [FY]);

    // Same shape, same figures: the snapshot is a read path, not a definition.
    const ledger = (await pool!.query(ACCOUNT_BALANCE_ROWS_SQL, [fy.start, fy.end, null])).rows;
    const snapshot = (
      await pool!.query(FISCAL_YEAR_BALANCE_ACCOUNT_ROWS_SQL, [FY, null])
    ).rows;
    const shape = (row: any) => ({
      accountId: row.accountId,
      openingBalance: Number(row.openingBalance),
      periodDebit: Number(row.periodDebit),
      periodCredit: Number(row.periodCredit),
    });
    assert.deepEqual(snapshot.map(shape), ledger.map(shape));

    // The window switches onto the snapshot only for a closed year whose bounds
    // are exactly the requested window.
    await pool!.query('UPDATE fiscal_years SET is_closed = TRUE WHERE id = $1', [FY]);
    try {
      const client = await pool!.connect();
      try {
        const window = await resolveStatementWindow(
          client as any,
          { from: fy.start, to: fy.end },
          'TRIAL_BALANCE',
          { branchId: null, empty: false }
        );
        assert.equal(window.snapshotFiscalYearId, FY);
        const viaSnapshot = await buildTrialBalance(client as any, window);
        const viaLedger = await buildTrialBalance(client as any, {
          ...window,
          snapshotFiscalYearId: null,
        });
        assert.deepEqual(viaSnapshot.accounts, viaLedger.accounts);
        assert.deepEqual(viaSnapshot.totals, viaLedger.totals);

        const partial = await resolveStatementWindow(
          client as any,
          { from: fy.start, to: fy.start },
          'TRIAL_BALANCE',
          { branchId: null, empty: false }
        );
        assert.equal(partial.snapshotFiscalYearId, null, 'a partial window stays on the ledger');
      } finally {
        client.release();
      }
    } finally {
      await pool!.query('UPDATE fiscal_years SET is_closed = FALSE WHERE id = $1', [FY]);
    }
  });
});
