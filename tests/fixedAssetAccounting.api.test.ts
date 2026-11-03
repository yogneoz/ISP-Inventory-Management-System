/**
 * Fixed-asset → ledger, driven through the real HTTP routes against PostgreSQL.
 *
 * The register was the last large value holder that never reached the ledger:
 * acquiring, depreciating or disposing of an asset changed its row and the
 * balance sheet's fixed-asset line not at all. The claims pinned here are the
 * ones a journal-less implementation cannot satisfy:
 *
 *   1. a directly capitalised asset debits Fixed Assets at Cost and credits the
 *      cash account named on the request;
 *   2. an asset capitalised from a purchase bill reclassifies the cost the bill
 *      already put into inventory (the bill's own posting created the payable),
 *      so the acquisition journal never raises it twice;
 *   3. a depreciation run posts expense / accumulated depreciation, updates the
 *      register, and a second run for the same month is refused with no extra
 *      journal;
 *   4. disposal clears the posted cost and accumulated depreciation, books the
 *      proceeds and recognises the loss, so the balance-sheet fixed-asset figure
 *      equals cost less accumulated depreciation;
 *   5. the finance-only permission gates the run.
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
import { ensureBsDayRecords, ensureReferenceData } from './fixtures/referenceData';

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

const BR = 'fad-branch';
const PRODUCT = 'fad-prod';
const ACQ = '2026-08-10';
const PERIOD = '2026-09';
const MONTH_END = '2026-09-30';

const ADMIN = {
  id: 'fad-admin',
  email: 'fad-admin@example.com',
  name: 'FAD Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: [],
  canSwitchUser: false,
} as any;

const INVENTORY_MANAGER = {
  id: 'fad-inv-manager',
  email: 'fad-inv-manager@example.com',
  name: 'FAD Inventory Manager',
  role: 'INVENTORY_MANAGER',
  branchId: BR,
  allowedBranchIds: [BR],
  canSwitchUser: false,
} as any;

describe('fixed-asset ledger posting (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  const token = issueAuthToken(ADMIN);
  const managerToken = issueAuthToken(INVENTORY_MANAGER);

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, auth = token) {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + auth,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* a non-JSON body is itself a finding */
    }
    return { status: res.status, json };
  }

  const get = (path: string) => request('GET', path);
  const post = (path: string, body: unknown, auth = token) => request('POST', path, body, auth);
  const patch = (path: string, body: unknown) => request('PATCH', path, body);

  async function cleanup() {
    await pool!.query("DELETE FROM gl_journals WHERE source_id LIKE 'fad-%'");
    await pool!.query("DELETE FROM purchase_invoices WHERE id LIKE 'fad-%'");
    await pool!.query("DELETE FROM fixed_assets WHERE id LIKE 'fad-%'");
    await pool!.query("DELETE FROM inventory_stock WHERE product_id LIKE 'fad-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id LIKE 'fad-%'");
    await pool!.query("DELETE FROM products WHERE id LIKE 'fad-%'");
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%FAD-%'");
    await pool!.query('DELETE FROM branches WHERE id = $1', [BR]);
  }

  async function journalFor(sourceType: string, sourceId: string) {
    const { rows } = await pool!.query(
      `SELECT id, journal_no AS "journalNo", status, branch_id AS "branchId",
              source_type AS "sourceType", source_id AS "sourceId",
              journal_date_ad AS "journalDateAD"
         FROM gl_journals
        WHERE source_type = $1 AND source_id = $2
        ORDER BY posted_at ASC, journal_no ASC`,
      [sourceType, sourceId]
    );
    return rows;
  }

  async function journalLines(journalId: string) {
    const { rows } = await pool!.query(
      `SELECT a.code, l.debit::numeric AS debit, l.credit::numeric AS credit
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no ASC`,
      [journalId]
    );
    return rows.map((row) => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
  }

  async function accountNet(account: 'FIXED_ASSET' | 'ACCUMULATED_DEPRECIATION'): Promise<number> {
    const { rows } = await pool!.query(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0)::numeric AS net
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
         JOIN gl_journals j ON j.id = l.journal_id
        WHERE j.status = 'POSTED' AND a.posting_role = $1 AND l.branch_id = $2`,
      [account, BR]
    );
    // Accumulated depreciation is a credit-balance contra asset: report it in
    // its natural (positive) direction for the arithmetic below.
    const net = Number(rows[0]?.net || 0);
    return account === 'ACCUMULATED_DEPRECIATION' ? -net : net;
  }

  function assetBody(id: string, tag: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      tagNumber: tag,
      name: `FAD ${tag}`,
      category: 'IT Equipment',
      branchId: BR,
      acquisitionDateAD: ACQ,
      acquisitionCost: 1200,
      depreciationMethod: 'STRAIGHT_LINE',
      depreciationRatePercent: 12,
      ...extra,
    };
  }

  before(async () => {
    await ensureReferenceData(pool!, ACQ);
    await ensureBsDayRecords(pool!, [ACQ, MONTH_END]);
    await cleanup();

    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES ($1, 'FAD', 'FAD Asset Branch', 'Test')`,
      [BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'FAD Asset Router', 'FAD-SKU', 'Equipment', 'Product Item', 'Pcs', 600, 700, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT]
    );

    const matrix = JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS_MATRIX));
    setPermissionMatrix(matrix);

    const app = createApp();
    registerAllRoutes(app);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
    close = () =>
      new Promise<void>((done) => {
        (server as any).closeAllConnections?.();
        server.close(() => done());
      });
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('direct capitalisation debits fixed-asset cost and credits the named cash account', async () => {
    const created = await post(
      '/api/assets',
      assetBody('fad-cash', 'FAD-CASH', { paymentMethod: 'CASH' })
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const [journal] = await journalFor('FIXED_ASSET_ACQUISITION', 'fad-cash');
    assert.ok(journal, 'capitalisation must write a journal in the asset transaction');
    assert.equal(journal.status, 'POSTED');
    assert.equal(journal.branchId, BR);
    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '1520')?.debit, 1200, 'fixed asset cost is debited');
    assert.equal(lines.find((line) => line.code === '1010')?.credit, 1200, 'cash is credited');
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 1200);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 1200);
  });

  test('an asset capitalised from a purchase bill reclassifies the cost out of inventory', async () => {
    const invoice = await post('/api/purchase-invoices', {
      id: 'fad-pi-1',
      invoiceNumber: 'FAD-PI-1',
      branchId: BR,
      invoiceDateAD: ACQ,
      supplierName: 'FAD Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [
        {
          productId: PRODUCT,
          productName: 'FAD Asset Router',
          sku: 'FAD-SKU',
          unit: 'Pcs',
          quantity: 2,
          unitPrice: 600,
          discount: 0,
          taxRate: 13,
          isTaxExempt: false,
        },
      ],
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.json));
    assert.equal(invoice.json.grandTotal, 1356);

    const [billJournal] = await journalFor('PURCHASE_INVOICE', 'fad-pi-1');
    assert.ok(billJournal, 'the bill posts inventory + input VAT / AP first');
    const billLines = await journalLines(billJournal.id);
    assert.equal(billLines.find((line) => line.code === '1200')?.debit, 1200);

    const created = await post('/api/assets', assetBody('fad-inv', 'FAD-INV', {
      purchaseInvoiceId: 'fad-pi-1',
      supplierName: 'FAD Supplier',
    }));
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const [journal] = await journalFor('FIXED_ASSET_ACQUISITION', 'fad-inv');
    assert.ok(journal, 'capitalising the bill line must write a journal');
    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '1520')?.debit, 1200);
    assert.equal(
      lines.find((line) => line.code === '1200')?.credit,
      1200,
      'the bill already recognised the payable, so the cost moves out of inventory'
    );
    assert.equal(
      lines.find((line) => line.code === '2100'),
      undefined,
      'crediting AP again would double the liability the bill already booked'
    );
  });

  test('a depreciation run posts the month once and refuses a duplicate run', async () => {
    const run = await post('/api/fixed-assets/depreciation', { branchId: BR, periodKey: PERIOD });
    assert.equal(run.status, 201, JSON.stringify(run.json));
    assert.equal(run.json.periodKey, PERIOD);
    assert.equal(run.json.total, 24, 'two assets × 1200 × 12% / 12');
    assert.equal(run.json.posted.length, 2);

    for (const entry of run.json.posted) {
      const [journal] = await journalFor('FIXED_ASSET_DEPRECIATION', `${entry.assetId}:${PERIOD}`);
      assert.ok(journal, `${entry.assetId} must have its own period journal`);
      const lines = await journalLines(journal.id);
      assert.equal(lines.find((line) => line.code === '6300')?.debit, 12);
      assert.equal(lines.find((line) => line.code === '1525')?.credit, 12);
    }

    const credited = await accountNet('ACCUMULATED_DEPRECIATION');
    assert.equal(credited, 24);

    const beforeDuplicate = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE source_type = 'FIXED_ASSET_DEPRECIATION' AND source_id LIKE 'fad-%'"
    );
    const duplicate = await post('/api/fixed-assets/depreciation', { branchId: BR, periodKey: PERIOD });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.match(duplicate.json.message, /already been posted/i);

    const afterDuplicate = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM gl_journals WHERE source_type = 'FIXED_ASSET_DEPRECIATION' AND source_id LIKE 'fad-%'"
    );
    assert.equal(
      Number(afterDuplicate.rows[0].count),
      Number(beforeDuplicate.rows[0].count),
      'a refused duplicate run writes nothing'
    );
    assert.equal(await accountNet('ACCUMULATED_DEPRECIATION'), 24);

    // The register's cached columns follow the posted amounts.
    const asset = await pool!.query(
      "SELECT accumulated_depreciation::numeric AS accumulated, net_book_value::numeric AS nbv FROM fixed_assets WHERE id = 'fad-cash'"
    );
    assert.equal(Number(asset.rows[0].accumulated), 12);
    assert.equal(Number(asset.rows[0].nbv), 1188);
  });

  test('disposal clears cost and accumulated depreciation and books the loss', async () => {
    const disposed = await patch('/api/assets/fad-cash/status', {
      status: 'DISPOSED',
      disposalDateAD: MONTH_END,
      disposalProceeds: 1180,
      disposalPaymentMethod: 'CASH',
    });
    assert.equal(disposed.status, 200, JSON.stringify(disposed.json));

    const [journal] = await journalFor('FIXED_ASSET_DISPOSAL', 'fad-cash');
    assert.ok(journal, 'disposal must write a journal');
    const lines = await journalLines(journal.id);
    assert.equal(lines.find((line) => line.code === '1525')?.debit, 12, 'accumulated depreciation is cleared');
    assert.equal(lines.find((line) => line.code === '1010')?.debit, 1180, 'proceeds are received');
    assert.equal(lines.find((line) => line.code === '6500')?.debit, 8, 'NBV 1188 − proceeds 1180');
    assert.equal(lines.find((line) => line.code === '1520')?.credit, 1200, 'cost is cleared');
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 1200);
    assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 1200);

    // Balance sheet: the one remaining asset is 1200 cost − 12 accumulated.
    const balanceSheet = await get(`/api/accounting/statements/balance-sheet?branchId=${BR}&to=${MONTH_END}`);
    assert.equal(balanceSheet.status, 200, JSON.stringify(balanceSheet.json));
    const fixedAssets = balanceSheet.json.assets.sections.find(
      (section: any) => section.statementGroup === 'NON_CURRENT_ASSET'
    );
    assert.equal(fixedAssets.amount, 1188, 'fixed assets at cost less accumulated depreciation');
    assert.equal(balanceSheet.json.balanced, true);
    assert.equal(
      balanceSheet.json.totalAssets,
      balanceSheet.json.totalLiabilitiesAndEquity,
      'the balance sheet still balances after the disposal'
    );
    assert.equal(await accountNet('FIXED_ASSET'), 1200);
    assert.equal(await accountNet('ACCUMULATED_DEPRECIATION'), 12);

    // A second disposal of the same asset is refused rather than posting twice.
    const again = await patch('/api/assets/fad-cash/status', {
      status: 'DISPOSED',
      disposalDateAD: MONTH_END,
      disposalProceeds: 1180,
    });
    assert.equal(again.status, 200, 'repeating the status stays idempotent');
    assert.equal((await journalFor('FIXED_ASSET_DISPOSAL', 'fad-cash')).length, 1);

    // The other side of the same rule: proceeds above NBV are a gain, never a
    // negative loss. This asset was capitalised after the month's run, so it
    // has no accumulated depreciation to clear.
    const gainAsset = await post('/api/assets', assetBody('fad-gain', 'FAD-GAIN', {
      acquisitionCost: 500,
      paymentMethod: 'CASH',
    }));
    assert.equal(gainAsset.status, 201, JSON.stringify(gainAsset.json));
    const gainDisposed = await patch('/api/assets/fad-gain/status', {
      status: 'DISPOSED',
      disposalDateAD: MONTH_END,
      disposalProceeds: 600,
      disposalPaymentMethod: 'CASH',
    });
    assert.equal(gainDisposed.status, 200, JSON.stringify(gainDisposed.json));
    const [gainJournal] = await journalFor('FIXED_ASSET_DISPOSAL', 'fad-gain');
    assert.ok(gainJournal, 'a gain disposal must also post a journal');
    const gainLines = await journalLines(gainJournal.id);
    assert.equal(gainLines.find((line) => line.code === '1010')?.debit, 600, 'proceeds are received');
    assert.equal(gainLines.find((line) => line.code === '1520')?.credit, 500, 'cost is cleared');
    assert.equal(gainLines.find((line) => line.code === '4200')?.credit, 100, 'proceeds 600 − NBV 500');
    assert.equal(gainLines.find((line) => line.code === '6500'), undefined, 'a gain is not double-booked as a loss');
    assert.equal(gainLines.reduce((sum, line) => sum + line.debit, 0), 600);
    assert.equal(gainLines.reduce((sum, line) => sum + line.credit, 0), 600);
  });

  test('the depreciation run is gated on the finance permission', async () => {
    const refused = await post(
      '/api/fixed-assets/depreciation',
      { branchId: BR, periodKey: '2026-10' },
      managerToken
    );
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
  });
});
