/**
 * Customer statement — signed keyset body against real HTTP + PostgreSQL.
 *
 * The statement is unusual among the SCALE-2 registers: its running balance is
 * a property of the whole chronological statement, not of one page. This suite
 * pins that the response can be bounded without changing that fact:
 *
 *   1. a multi-page customer history is walked with the signed cursor;
 *   2. after page 1, a newer entry and an entry sharing the page-1 cursor's
 *      exact created_at are inserted — neither may leak into a later page;
 *   3. every original entry appears exactly once and the walk terminates;
 *   4. debit/credit totals, opening, closing and each line's running balance
 *      still match the unpaged statement (balances are never page-local);
 *   5. an unscoped cursor read is SCOPE_REQUIRED, a tampered cursor and a
 *      cursor from another customer's statement are INVALID_CURSOR.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import dotenv from 'dotenv';
import { createApp, registerAllRoutes } from '../server/src/app';
import { issueAuthToken } from '../server/src/middleware/auth';
import { setPermissionMatrix } from '../server/src/state/runtimeState';
import { DEFAULT_PERMISSIONS_MATRIX } from '../client/src/utils/permissionMatrixData';
import { ensureReferenceData, todayAd } from './fixtures/referenceData';
import { buildExportCsv } from '../client/src/utils/exportUtils';
import {
  ledgerExportColumns,
  ledgerExportRows,
  type SubLedgerData,
} from '../client/src/components/common/LedgerView';

dotenv.config();

let pool: pg.Pool | null = null;
let dbReachable = false;
try {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('SELECT 1');
    dbReachable = true;
  }
} catch {
  dbReachable = false;
  pool = null;
}
const skipNoDb = !dbReachable && 'needs a reachable PostgreSQL (requirePostgres gate)';

const BR = 'CLCB';
const CUSTOMER_A = 'clc-customer-a';
const CUSTOMER_B = 'clc-customer-b';
const PAGE_SIZE = 3;
const ORIGINAL_COUNT = 7;

const superUser = {
  id: 'clc-super',
  email: 'clc-super@example.com',
  name: 'CLC Super',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
};
const token = issueAuthToken(superUser as any);

function addDays(adDate: string, days: number): string {
  const date = new Date(`${adDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('customer ledger statement cursor (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let arAccount = '';
  let salesAccount = '';
  let today = '';
  let tomorrow = '';
  const journalIds: string[] = [];

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* a non-JSON body is itself a finding */ }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown) => request('POST', path, body);

  async function statement(customerId: string, query: string) {
    return get(`/api/customers/${encodeURIComponent(customerId)}/ledger?${query}`);
  }

  async function withPurge<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('inventory.allow_ledger_purge', 'on', true)");
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function postJournal(
    sourceId: string,
    amount: number,
    entryDate: string,
    options: { branchId?: string; partyId?: string; partyName?: string } = {}
  ) {
    const res = await post('/api/accounting/journals', {
      journalDateAD: entryDate,
      branchId: options.branchId || BR,
      sourceId,
      memo: `CLC ${sourceId}`,
      lines: [
        {
          accountId: arAccount,
          debit: amount,
          credit: 0,
          subledgerType: 'CUSTOMER',
          partyId: options.partyId || CUSTOMER_A,
          partyName: options.partyName || 'CLC Customer A',
        },
        { accountId: salesAccount, debit: 0, credit: amount },
      ],
    });
    assert.equal(res.status, 201, `journal ${sourceId}: ${JSON.stringify(res.json)}`);
    const id = String(res.json?.id || '');
    assert.ok(id, `journal ${sourceId} did not return its id`);
    journalIds.push(id);
    return id;
  }

  function csvOf(response: any): string {
    const data: SubLedgerData = {
      partyName: response.customer.name,
      partyCode: response.customer.customerId,
      openingBalance: response.openingBalance,
      totalDebit: response.totalDebit,
      totalCredit: response.totalCredit,
      closingBalance: response.closingBalance,
      ledger: response.ledger,
      tieOut: response.tieOut,
    };
    return buildExportCsv({
      filename: 'Customer_Ledger',
      data: ledgerExportRows(data),
      columns: ledgerExportColumns(
        {
          documentNumber: 'Document Number',
          type: 'Type',
          debit: 'Debit / Sales (NPR)',
          credit: 'Credit / Payments & Credit Notes (NPR)',
          balance: 'Running Balance (NPR)',
          notes: 'Notes',
        },
        'AD'
      ),
      includeMetadataHeader: false,
    }).content;
  }

  async function setCreatedAt(journalId: string, createdAt: string, id?: string) {
    await withPurge(async (client) => {
      const result = id
        ? await client.query(
            'UPDATE gl_subledger_entries SET created_at = $1, id = $2 WHERE journal_id = $3',
            [createdAt, id, journalId]
          )
        : await client.query(
            'UPDATE gl_subledger_entries SET created_at = $1 WHERE journal_id = $2',
            [createdAt, journalId]
          );
      assert.equal(result.rowCount, 1, `expected one subledger row for journal ${journalId}`);
    });
  }

  async function cleanup() {
    const ids = (
      await pool!.query('SELECT id FROM gl_journals WHERE branch_id = $1', [BR])
    ).rows.map((row: any) => String(row.id));
    const allIds = Array.from(new Set([...journalIds, ...ids]));
    await withPurge(async (client) => {
      if (allIds.length > 0) {
        await client.query('DELETE FROM gl_subledger_entries WHERE journal_id = ANY($1::varchar[])', [allIds]);
        await client.query('DELETE FROM gl_journal_lines WHERE journal_id = ANY($1::varchar[])', [allIds]);
        await client.query('DELETE FROM gl_journals WHERE id = ANY($1::varchar[])', [allIds]);
        await client.query('DELETE FROM gl_journals_registry WHERE id = ANY($1::varchar[])', [allIds]);
      }
      await client.query('DELETE FROM audit_logs WHERE details LIKE $1', ['%CLC clc-%']);
    });
    await pool!.query('DELETE FROM customer_records WHERE id = ANY($1::varchar[])', [[CUSTOMER_A, CUSTOMER_B]]);
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
    journalIds.length = 0;
  }

  before(async () => {
    today = todayAd();
    tomorrow = addDays(today, 1);
    await ensureReferenceData(pool!, today);
    await ensureReferenceData(pool!, tomorrow);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'CLCB', 'CLC Statement Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES
         ($1, $1, 'CLC Customer A', '9800000000', $3, 'ACTIVE'),
         ($2, $2, 'CLC Customer B', '9800000001', $3, 'ACTIVE')`,
      [CUSTOMER_A, CUSTOMER_B, BR]
    );

    const controls = await pool!.query(
      "SELECT id FROM gl_accounts WHERE posting_role = 'AR_CONTROL' ORDER BY id LIMIT 1"
    );
    arAccount = String(controls.rows[0]?.id || '');
    assert.ok(arAccount, 'the default chart must provide an AR control account');
    const sales = await pool!.query(
      "SELECT id FROM gl_accounts WHERE posting_role = 'SALES' ORDER BY id LIMIT 1"
    );
    salesAccount = String(sales.rows[0]?.id || '');
    assert.ok(salesAccount, 'the default chart must provide a sales account');

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);
    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () => new Promise<void>((done) => {
      (server as any).closeAllConnections?.();
      server.close(() => done());
    });

    const base = Date.UTC(2026, 10, 17, 10, 0, 0);
    for (let index = 0; index < ORIGINAL_COUNT; index += 1) {
      const journalId = await postJournal(`clc-original-${index}`, 10 + index, today);
      await setCreatedAt(journalId, new Date(base + index * 1000).toISOString());
    }
  });

  after(async () => {
    await close?.();
    await cleanup();
  });

  test('pages newest-created first without duplicating, leaking or resetting balances', async () => {
    const scope = `branchId=${BR}&fromAd=${today}&toAd=${tomorrow}`;
    const unpaged = await statement(CUSTOMER_A, scope);
    assert.equal(unpaged.status, 200, JSON.stringify(unpaged.json));
    assert.equal(unpaged.json.ledger.length, ORIGINAL_COUNT);
    const balanceById = new Map<string, number>(
      unpaged.json.ledger.map((line: any) => [String(line.id), Number(line.balance)] as [string, number])
    );

    const page1 = await statement(CUSTOMER_A, `${scope}&limit=${PAGE_SIZE}`);
    assert.equal(page1.status, 200, JSON.stringify(page1.json));
    assert.equal(page1.json.items.length, PAGE_SIZE);
    assert.equal(page1.json.hasMore, true);
    assert.ok(page1.json.nextCursor, 'page 1 must return a signed cursor');
    assert.equal(page1.json.totalDebit, unpaged.json.totalDebit);
    assert.equal(page1.json.totalCredit, unpaged.json.totalCredit);
    assert.equal(page1.json.openingBalance, unpaged.json.openingBalance);
    assert.equal(page1.json.closingBalance, unpaged.json.closingBalance);
    for (const line of page1.json.items) {
      assert.equal(Number(line.balance), balanceById.get(String(line.id)));
    }

    const anchor = page1.json.items[page1.json.items.length - 1];
    const newerId = await postJournal('clc-newer', 500, tomorrow);
    await setCreatedAt(newerId, new Date(Date.UTC(2026, 10, 17, 12, 0, 0)).toISOString());
    const tieId = await postJournal('clc-tie', 250, tomorrow);
    // Same exact timestamp as the page-1 cursor row, and a key that sorts
    // AFTER that cursor (so it belongs before it in the descending walk).
    await setCreatedAt(tieId, String(anchor.createdAt), 'zzzz-clc-tie-row');

    const seen = new Map<string, number>(
      page1.json.items.map((line: any) => [String(line.id), Number(line.balance)] as [string, number])
    );
    let cursor: string | null = page1.json.nextCursor;
    let lastPage: any = null;
    let pages = 0;
    while (cursor) {
      pages += 1;
      assert.ok(pages < 10, 'the cursor walk must terminate');
      const page = await statement(
        CUSTOMER_A,
        `${scope}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      );
      assert.equal(page.status, 200, JSON.stringify(page.json));
      assert.equal(
        page.json.totalDebit,
        unpaged.json.totalDebit + 750,
        'later pages must report the whole-filter debit total, including inserted entries'
      );
      assert.equal(
        page.json.closingBalance,
        unpaged.json.closingBalance + 750,
        'closing must not be derived from the page'
      );
      for (const line of page.json.items) {
        assert.ok(!seen.has(String(line.id)), `row ${line.id} was returned twice`);
        seen.set(String(line.id), Number(line.balance));
        assert.equal(
          Number(line.balance),
          balanceById.get(String(line.id)),
          `balance for ${line.id} changed across the page boundary`
        );
      }
      lastPage = page;
      cursor = page.json.hasMore ? page.json.nextCursor : null;
      if (!page.json.hasMore) {
        assert.equal(page.json.nextCursor, null);
      }
    }

    assert.ok(lastPage, 'the walk must read at least one page after page 1');
    assert.equal(lastPage.json.hasMore, false);
    assert.equal(seen.size, ORIGINAL_COUNT, 'every pre-existing entry appears exactly once');
    for (const id of balanceById.keys()) assert.ok(seen.has(id), `missing pre-existing row ${id}`);
    assert.ok(!seen.has('zzzz-clc-tie-row'), 'the same-timestamp tie row leaked into a later page');
    assert.ok(!seen.has(newerId), 'the newer row leaked into a later page');

    const finalUnpaged = await statement(CUSTOMER_A, scope);
    assert.equal(finalUnpaged.status, 200, JSON.stringify(finalUnpaged.json));
    assert.equal(finalUnpaged.json.ledger.length, ORIGINAL_COUNT + 2);
    assert.equal(lastPage.json.totalDebit, finalUnpaged.json.totalDebit);
    assert.equal(lastPage.json.totalCredit, finalUnpaged.json.totalCredit);
    assert.equal(lastPage.json.closingBalance, finalUnpaged.json.closingBalance);
    for (const [id, balance] of balanceById) {
      const row = finalUnpaged.json.ledger.find((line: any) => String(line.id) === id);
      assert.ok(row, `the unpaged statement lost ${id}`);
      assert.equal(Number(row.balance), balance, `the unpaged balance changed for ${id}`);
    }
  });

  test('rejects unscoped, tampered and cross-customer cursors', async () => {
    const unscoped = await statement(CUSTOMER_A, `limit=${PAGE_SIZE}`);
    assert.equal(unscoped.status, 400, JSON.stringify(unscoped.json));
    assert.equal(unscoped.json.code, 'SCOPE_REQUIRED');

    const scope = `branchId=${BR}&fromAd=${today}&toAd=${tomorrow}`;
    const page1 = await statement(CUSTOMER_A, `${scope}&limit=${PAGE_SIZE}`);
    assert.equal(page1.status, 200, JSON.stringify(page1.json));
    const cursor = String(page1.json.nextCursor);
    const tampered = cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A');
    const forged = await statement(
      CUSTOMER_A,
      `${scope}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(tampered)}`
    );
    assert.equal(forged.status, 400, JSON.stringify(forged.json));
    assert.equal(forged.json.code, 'INVALID_CURSOR');

    const crossCustomer = await statement(
      CUSTOMER_B,
      `${scope}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
    );
    assert.equal(crossCustomer.status, 400, JSON.stringify(crossCustomer.json));
    assert.equal(crossCustomer.json.code, 'INVALID_CURSOR');
  });

  test('all=1 exports the complete chronological statement regardless of pager position', async () => {
    // CUSTOMER_B has never been paged in this suite: the first export below is
    // the zero-pages-pre-loaded case. Seven entries make the export span more
    // than two pages at PAGE_SIZE.
    for (let index = 0; index < 5; index += 1) {
      await postJournal(`clc-b-${index}`, 100 + index, today, {
        partyId: CUSTOMER_B,
        partyName: 'CLC Customer B',
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await postJournal(`clc-b-tomorrow-${index}`, 200 + index, tomorrow, {
        partyId: CUSTOMER_B,
        partyName: 'CLC Customer B',
      });
    }
    const otherBranchId = await postJournal('clc-b-other-branch', 999, today, {
      branchId: 'WH001',
      partyId: CUSTOMER_B,
      partyName: 'CLC Customer B',
    });

    const scope = `branchId=${BR}&fromAd=${today}&toAd=${tomorrow}`;
    const zeroLoaded = await statement(CUSTOMER_B, `${scope}&all=1`);
    assert.equal(zeroLoaded.status, 200, JSON.stringify(zeroLoaded.json));
    assert.equal(zeroLoaded.json.exportAll, true);
    assert.equal(zeroLoaded.json.hasMore, false);
    assert.equal(zeroLoaded.json.nextCursor, null);
    assert.equal(zeroLoaded.json.ledger.length, 7);

    // Advance the pager two pages so the export is taken after several loaded
    // pages, then export again with the exact same filters.
    const page1 = await statement(CUSTOMER_B, `${scope}&limit=${PAGE_SIZE}`);
    assert.equal(page1.status, 200, JSON.stringify(page1.json));
    const page2 = await statement(
      CUSTOMER_B,
      `${scope}&limit=${PAGE_SIZE}&cursor=${encodeURIComponent(String(page1.json.nextCursor))}`
    );
    assert.equal(page2.status, 200, JSON.stringify(page2.json));
    assert.ok(page2.json.items.length > 0, 'the pager must advance before the second export');

    const afterPaging = await statement(CUSTOMER_B, `${scope}&all=1`);
    assert.equal(afterPaging.status, 200, JSON.stringify(afterPaging.json));
    assert.equal(csvOf(zeroLoaded.json), csvOf(afterPaging.json), 'the export bytes must not depend on pager position');

    const unpaged = await statement(CUSTOMER_B, scope);
    assert.equal(unpaged.status, 200, JSON.stringify(unpaged.json));
    assert.deepEqual(
      afterPaging.json.ledger.map((line: any) => String(line.id)),
      unpaged.json.ledger.map((line: any) => String(line.id)),
      'the file must read chronologically, exactly like the unpaged statement'
    );
    assert.equal(new Set(afterPaging.json.ledger.map((line: any) => String(line.id))).size, 7);
    assert.ok(!afterPaging.json.ledger.some((line: any) => String(line.id) === otherBranchId));
    assert.equal(afterPaging.json.totalDebit, unpaged.json.totalDebit);
    assert.equal(afterPaging.json.totalCredit, unpaged.json.totalCredit);
    assert.equal(afterPaging.json.openingBalance, unpaged.json.openingBalance);
    assert.equal(afterPaging.json.closingBalance, unpaged.json.closingBalance);
    const unpagedBalances = new Map(
      unpaged.json.ledger.map((line: any) => [String(line.id), Number(line.balance)] as [string, number])
    );
    for (const line of afterPaging.json.ledger) {
      assert.equal(Number(line.balance), unpagedBalances.get(String(line.id)));
    }

    const dateOnly = await statement(
      CUSTOMER_B,
      `branchId=${BR}&fromAd=${tomorrow}&toAd=${tomorrow}&all=1`
    );
    assert.equal(dateOnly.status, 200, JSON.stringify(dateOnly.json));
    assert.equal(dateOnly.json.ledger.length, 2, 'the active date range must stay applied to the export');
    assert.ok(dateOnly.json.ledger.every((line: any) => line.dateAD === tomorrow));
  });

  test('all=1 keeps the statement scope and cursor guards', async () => {
    const unscoped = await statement(CUSTOMER_B, 'all=1');
    assert.equal(unscoped.status, 400, JSON.stringify(unscoped.json));
    assert.equal(unscoped.json.code, 'SCOPE_REQUIRED');

    const scope = `branchId=${BR}&fromAd=${today}&toAd=${tomorrow}`;
    const page1 = await statement(CUSTOMER_B, `${scope}&limit=${PAGE_SIZE}`);
    const withCursor = await statement(
      CUSTOMER_B,
      `${scope}&all=1&cursor=${encodeURIComponent(String(page1.json.nextCursor))}`
    );
    assert.equal(withCursor.status, 400, JSON.stringify(withCursor.json));
    assert.equal(withCursor.json.code, 'INVALID_CURSOR');
  });
});