/**
 * Read-model maintenance and observability (SCALE-3).
 *
 *   npm run read-models:pending
 *   npm run read-models:flush -- --limit 100
 *   npm run read-models:rebuild                      # stock + every closed year
 *   npm run read-models:rebuild -- --stock
 *   npm run read-models:rebuild -- --fiscal-year fy-2082
 *   npm run read-models:rebuild -- --stock --verify   # exit 1 if a rebuild differs
 *   npm run read-models:rebuild -- --period-balances --verify
 *   npm run read-models:rebuild -- --party-balances --verify
 *
 * `--verify` is the demonstration that the incrementally maintained table and a
 * from-scratch rebuild agree: it snapshots the read model, rebuilds it, and
 * compares every column byte for byte (updated_at included, because it carries
 * the source ledger row's timestamp in both paths).
 */
import 'dotenv/config';
import pg from 'pg';
import {
  FISCAL_YEAR_BALANCES_REBUILD_SQL,
  GL_PARTY_PERIOD_BALANCES_REBUILD_SQL,
  GL_PERIOD_BALANCES_REBUILD_SQL,
  READ_MODEL_FLUSH_SQL,
  READ_MODEL_PENDING_COUNT_SQL,
  READ_MODEL_PENDING_LIST_SQL,
  STOCK_BALANCE_REBUILD_SQL,
} from '../server/src/models/readModels.repo';

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

type Row = Record<string, unknown>;

async function stockSnapshot(client: pg.Client): Promise<Row[]> {
  const result = await client.query(
    `SELECT branch_id, product_id, quantity, value::text AS value, source_txn_id, source_timestamp, updated_at
       FROM branch_stock_balances
      ORDER BY branch_id, product_id`
  );
  return result.rows;
}

async function fiscalYearSnapshot(client: pg.Client, fiscalYearId: string): Promise<Row[]> {
  const result = await client.query(
    `SELECT fiscal_year_id, branch_id, account_id, account_code, account_name, account_type,
            pre_close_debit::text AS pre_close_debit, pre_close_credit::text AS pre_close_credit,
            pre_close_balance::text AS pre_close_balance, close_debit::text AS close_debit,
            close_credit::text AS close_credit, post_close_balance::text AS post_close_balance,
            closed_at
       FROM fiscal_year_balances
      WHERE fiscal_year_id = $1
      ORDER BY branch_id, account_code`,
    [fiscalYearId]
  );
  return result.rows;
}

async function periodBalancesSnapshot(client: pg.Client): Promise<Row[]> {
  const result = await client.query(
    `SELECT branch_id, account_id, period_id, period_key, fiscal_year_id, period_start_ad,
            opening_balance::text AS opening_balance, period_debit::text AS period_debit,
            period_credit::text AS period_credit, closing_balance::text AS closing_balance,
            updated_at
       FROM gl_period_balances
      ORDER BY branch_id, account_id, period_start_ad, period_id`
  );
  return result.rows;
}

async function partyBalancesSnapshot(client: pg.Client): Promise<Row[]> {
  const result = await client.query(
    `SELECT branch_id, account_id, subledger_type, party_id, period_id, period_key, fiscal_year_id,
            period_start_ad, opening_balance::text AS opening_balance,
            period_debit::text AS period_debit, period_credit::text AS period_credit,
            closing_balance::text AS closing_balance, updated_at
       FROM gl_party_period_balances
      ORDER BY branch_id, account_id, subledger_type, party_id, period_start_ad, period_id`
  );
  return result.rows;
}

async function closedFiscalYears(client: pg.Client): Promise<string[]> {
  const result = await client.query(
    `SELECT b.fiscal_year_id AS id
       FROM fiscal_year_balances b
      GROUP BY b.fiscal_year_id
      ORDER BY b.fiscal_year_id`
  );
  return result.rows.map((row) => String(row.id));
}

/** Column-wise comparison, so a mismatch says which row and column. */
function differences(before: Row[], after: Row[]): string[] {
  const out: string[] = [];
  const key = (row: Row) =>
    [
      row.branch_id ?? row.fiscal_year_id,
      row.account_id ?? row.product_id,
      row.account_code ?? '',
      row.period_id ?? '',
      row.subledger_type ?? '',
      row.party_id ?? '',
    ].join('|');
  const index = new Map(after.map((row) => [key(row), row]));
  if (before.length !== after.length) out.push(`row count ${before.length} → ${after.length}`);
  for (const row of before) {
    const other = index.get(key(row));
    if (!other) {
      out.push(`missing after rebuild: ${key(row)}`);
      continue;
    }
    for (const column of Object.keys(row)) {
      if (String(row[column]) !== String(other[column])) {
        out.push(`${key(row)}.${column}: ${String(row[column])} → ${String(other[column])}`);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  const verify = process.argv.includes('--verify');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (action === 'pending') {
      const summary = (await client.query(READ_MODEL_PENDING_COUNT_SQL)).rows[0];
      const limit = Number(argValue('--limit') ?? 20);
      const rows = (await client.query(READ_MODEL_PENDING_LIST_SQL, [limit])).rows;
      console.log(
        `read models — pending ${summary.pending} write(s)` +
          (summary.oldestCreatedAt ? `, oldest ${new Date(summary.oldestCreatedAt).toISOString()}` : '') +
          (summary.maxAttempts ? `, max attempts ${summary.maxAttempts}` : '')
      );
      for (const row of rows) {
        console.log(
          `  #${row.id} ${row.model} ${JSON.stringify(row.key)} attempts=${row.attempts} ${row.lastError ? `last_error=${row.lastError}` : ''}`
        );
      }
      if (summary.pending > 0) process.exitCode = 1;
      return;
    }

    if (action === 'flush') {
      const limit = Number(argValue('--limit') ?? 100);
      const result = (await client.query(READ_MODEL_FLUSH_SQL, [limit])).rows[0];
      console.log(
        `read models — flushed: applied ${result.applied}, failed ${result.failed}, remaining ${result.remaining}`
      );
      if (Number(result.remaining) > 0) process.exitCode = 1;
      return;
    }

    if (action === 'rebuild') {
      const fiscalYearArg = argValue('--fiscal-year');
      const onlyStock = process.argv.includes('--stock');
      const onlyPeriod = process.argv.includes('--period-balances');
      const onlyParty = process.argv.includes('--party-balances');
      const narrowed = onlyStock || onlyPeriod || onlyParty;
      const wantStock = !narrowed || onlyStock;
      const wantFiscalYear = !narrowed;
      const wantPeriod = !narrowed || onlyPeriod;
      const wantParty = !narrowed || onlyParty;
      const targets: Array<{ label: string; before: Row[]; rebuild: () => Promise<number>; after: () => Promise<Row[]> }> = [];

      if (!fiscalYearArg && wantStock) {
        targets.push({
          label: 'branch_stock_balances',
          before: await stockSnapshot(client),
          rebuild: async () => Number((await client.query(STOCK_BALANCE_REBUILD_SQL)).rows[0].rows),
          after: () => stockSnapshot(client),
        });
      }

      if (wantFiscalYear) {
        const years = fiscalYearArg ? [fiscalYearArg] : await closedFiscalYears(client);
        for (const year of years) {
          targets.push({
            label: `fiscal_year_balances(${year})`,
            before: await fiscalYearSnapshot(client, year),
            rebuild: async () =>
              Number((await client.query(FISCAL_YEAR_BALANCES_REBUILD_SQL, [year])).rows[0].rows),
            after: () => fiscalYearSnapshot(client, year),
          });
        }
      }

      if (wantPeriod) {
        targets.push({
          label: 'gl_period_balances',
          before: await periodBalancesSnapshot(client),
          rebuild: async () =>
            Number((await client.query(GL_PERIOD_BALANCES_REBUILD_SQL)).rows[0].rows),
          after: () => periodBalancesSnapshot(client),
        });
      }

      if (wantParty) {
        targets.push({
          label: 'gl_party_period_balances',
          before: await partyBalancesSnapshot(client),
          rebuild: async () =>
            Number((await client.query(GL_PARTY_PERIOD_BALANCES_REBUILD_SQL)).rows[0].rows),
          after: () => partyBalancesSnapshot(client),
        });
      }

      for (const target of targets) {
        const rows = await target.rebuild();
        console.log(`read models — rebuilt ${target.label}: ${rows} row(s)`);
        if (verify) {
          const diff = differences(target.before, await target.after());
          if (diff.length > 0) {
            console.error(`✖ ${target.label} differs from its from-scratch rebuild:`);
            for (const line of diff.slice(0, 20)) console.error(`    ${line}`);
            process.exitCode = 1;
          } else {
            console.log(
              `✅ ${target.label}: incremental rows equal the rebuild byte for byte (${target.before.length} row(s)).`
            );
          }
        }
      }
      return;
    }

    console.error(
      'read-models — usage: pending [--limit n] | flush [--limit n] | rebuild [--stock] [--fiscal-year id] [--period-balances] [--party-balances] [--verify]'
    );
    process.exitCode = 2;
  } finally {
    await client.end();
  }
}

await main();
