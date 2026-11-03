/**
 * PDF reporting — real HTTP routes against PostgreSQL.
 *
 * The plan names pdfmake with Noto Sans + Noto Sans Devanagari. These tests pin
 * the parts a route that merely returns bytes would not prove:
 *
 *   1. each print endpoint answers a real `%PDF-` buffer with a private,
 *      no-store content type through the same route/permission/branch gate as
 *      its JSON counterpart;
 *   2. an invoice carrying Devanagari text embeds the Noto Sans Devanagari
 *      subset (FontFile2 + ToUnicode), so the script path is exercised rather
 *      than silently dropped by a Latin-only font;
 *   3. the same font pipeline refuses a missing file by name instead of
 *      falling back to pdfmake's Roboto;
 *   4. a document from another branch and a caller without the view operation
 *      are refused, so print cannot widen the read contract.
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
import { ensureReferenceData } from './fixtures/referenceData';
import { resolvePdfFonts, scriptRuns, statementSectionsContent } from '../server/src/services/pdf.service';

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

const BR = 'pdf-branch';
const OTHER = 'pdf-other';
const PRODUCT = 'pdf-prod';
const CUSTOMER = 'pdf-customer';
const TODAY = new Date().toISOString().split('T')[0];
const PERIOD = TODAY.slice(0, 7);

const USERS = {
  super: { id: 'pdf-super', email: 'pdf-super@example.com', name: 'PDF Super', role: 'SUPER_ADMIN', branchId: 'ALL', allowedBranchIds: [], canSwitchUser: false },
  accountant: { id: 'pdf-accountant', email: 'pdf-accountant@example.com', name: 'PDF Accountant', role: 'ACCOUNTANT', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
  frontdesk: { id: 'pdf-frontdesk', email: 'pdf-frontdesk@example.com', name: 'PDF Front Desk', role: 'FRONT_DESK', branchId: BR, allowedBranchIds: [BR], canSwitchUser: false },
} as const;

const TOKENS = Object.fromEntries(
  Object.entries(USERS).map(([key, user]) => [key, issueAuthToken(user as any)])
) as Record<keyof typeof USERS, string>;

interface PdfResponse {
  status: number;
  contentType: string;
  disposition: string;
  cacheControl: string;
  buffer: Buffer;
  json: any;
}

describe('PDF reporting (real HTTP + PostgreSQL)', { skip: skipNoDb }, () => {
  let port = 0;
  let close: (() => Promise<void>) | null = null;
  let employee: any = null;
  let run: any = null;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    token: string = TOKENS.super,
    body?: unknown
  ): Promise<PdfResponse> {
    const res = await fetch('http://127.0.0.1:' + port + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: 'Bearer ' + token,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { json = JSON.parse(buffer.toString('utf8')); } catch { /* a broken JSON body is itself a finding */ }
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      disposition: res.headers.get('content-disposition') || '',
      cacheControl: res.headers.get('cache-control') || '',
      buffer,
      json,
    };
  }

  const get = (path: string, token?: string) => request('GET', path, token);
  const post = (path: string, body: unknown, token?: string) => request('POST', path, token, body);

  function assertPdf(res: PdfResponse, label: string) {
    assert.equal(res.status, 200, `${label}: ${res.json ? JSON.stringify(res.json) : res.buffer.toString('utf8', 0, 300)}`);
    assert.match(res.contentType, /^application\/pdf\b/, `${label} must answer a PDF content type`);
    assert.match(res.cacheControl, /no-store/, `${label} must not be cached by a shared proxy`);
    assert.match(res.disposition, /\.pdf"/, `${label} must name a .pdf file`);
    assert.equal(res.buffer.subarray(0, 5).toString('latin1'), '%PDF-', `${label} must be a real PDF`);
    assert.ok(res.buffer.length > 5000, `${label} must contain a rendered page, not a stub`);
  }

  function latin1(res: PdfResponse): string {
    return res.buffer.toString('latin1');
  }

  async function cleanup() {
    await pool!.query('DELETE FROM gl_journals WHERE branch_id = ANY($1::varchar[])', [[BR, OTHER]]);
    await pool!.query("DELETE FROM sales_invoices WHERE id LIKE 'pdf-%'");
    await pool!.query("DELETE FROM purchase_invoices WHERE id LIKE 'pdf-%'");
    await pool!.query(
      "DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE branch_id = ANY($1::varchar[]))",
      [[BR, OTHER]]
    );
    await pool!.query('DELETE FROM payroll_runs WHERE branch_id = ANY($1::varchar[])', [[BR, OTHER]]);
    await pool!.query("DELETE FROM employees WHERE employee_code LIKE 'PDFT-%'");
    await pool!.query("DELETE FROM transaction_logs WHERE product_id = $1", [PRODUCT]);
    await pool!.query("DELETE FROM inventory_stock WHERE product_id = $1", [PRODUCT]);
    await pool!.query('DELETE FROM customer_records WHERE id = $1', [CUSTOMER]);
    await pool!.query('DELETE FROM products WHERE id = $1', [PRODUCT]);
    await pool!.query("DELETE FROM audit_logs WHERE details LIKE '%PDF-SI-%' OR details LIKE '%PDF-PI-%'");
    await pool!.query('DELETE FROM branches WHERE id = ANY($1::varchar[])', [[BR, OTHER]]);
  }

  before(async () => {
    await ensureReferenceData(pool!, TODAY);
    await cleanup();
    await pool!.query(
      `INSERT INTO branches (id, code, name, location) VALUES
         ($1, 'PDFB', 'PDF Print Branch', 'Kathmandu'),
         ($2, 'PDFO', 'PDF Other Branch', 'Lalitpur')`,
      [BR, OTHER]
    );
    await pool!.query(
      `INSERT INTO customer_records (id, customer_id, customer_name, contact_number, branch_id, status)
       VALUES ($1, $1, 'नमस्ते ग्राहक', '9800000000', $2, 'ACTIVE')`,
      [CUSTOMER, BR]
    );
    await pool!.query(
      `INSERT INTO products
        (id, name, sku, category, product_group, unit, cost_price, selling_price,
         requires_serial_tracking, tracking_type)
       VALUES ($1, 'नेपाल राउटर', 'PDF-SKU', 'Equipment', 'Product Item', 'Pcs', 80, 500, FALSE, 'QUANTITY_ONLY')`,
      [PRODUCT]
    );
    await pool!.query(
      `INSERT INTO inventory_stock (id, product_id, branch_id, quantity_on_hand, average_cost, min_reorder_level)
       VALUES ('stk-pdf-br', $1, $2, 20, 80, 1), ('stk-pdf-other', $1, $3, 5, 80, 1)`,
      [PRODUCT, BR, OTHER]
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

    const item = {
      productId: PRODUCT,
      productName: 'नेपाल राउटर',
      sku: 'PDF-SKU',
      unit: 'Pcs',
      quantity: 1,
      unitPrice: 500,
      discount: 0,
      taxRate: 13,
      isTaxExempt: false,
    };

    const sale = await post('/api/sales-invoices', {
      id: 'pdf-si-1',
      invoiceNumber: 'PDF-SI-1',
      customerId: CUSTOMER,
      customerName: 'नमस्ते ग्राहक',
      branchId: BR,
      invoiceDateAD: TODAY,
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [item],
    });
    assert.equal(sale.status, 201, `sales invoice fixture: ${JSON.stringify(sale.json)}`);

    const bill = await post('/api/purchase-invoices', {
      id: 'pdf-pi-1',
      invoiceNumber: 'PDF-PI-1',
      branchId: BR,
      invoiceDateAD: TODAY,
      supplierName: 'PDF Supplier',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      items: [{ ...item, quantity: 2, unitPrice: 100 }],
    });
    assert.equal(bill.status, 201, `purchase bill fixture: ${JSON.stringify(bill.json)}`);

    const otherSale = await post('/api/sales-invoices', {
      id: 'pdf-si-other',
      invoiceNumber: 'PDF-SI-OTHER',
      branchId: OTHER,
      invoiceDateAD: TODAY,
      customerName: 'Other Branch Customer',
      paymentMethod: 'CREDIT',
      paymentStatus: 'UNPAID',
      amountPaid: 0,
      items: [{ ...item, productName: 'Other Router' }],
    });
    assert.equal(otherSale.status, 201, `other-branch fixture: ${JSON.stringify(otherSale.json)}`);

    const createdEmployee = await post('/api/employees', {
      employeeCode: 'PDFT-001',
      name: 'नमस्ते कर्मचारी',
      branchId: BR,
      department: 'Field Operations',
      designation: 'Technician',
      panNumber: 'PDF-PAN',
      ssfNumber: 'PDF-SSF',
    });
    assert.equal(createdEmployee.status, 201, `employee fixture: ${JSON.stringify(createdEmployee.json)}`);
    employee = createdEmployee.json;

    const createdRun = await post('/api/payroll-runs', {
      branchId: BR,
      periodKey: PERIOD,
      runDateAD: TODAY,
      lines: [{ employeeId: employee.id, gross: 5000, tds: 500, ssf: 550, advance: 0, loan: 0 }],
    });
    assert.equal(createdRun.status, 201, `payroll fixture: ${JSON.stringify(createdRun.json)}`);
    run = createdRun.json;
  });

  after(async () => {
    if (close) await close();
    setPermissionMatrix({});
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  test('the sales invoice and purchase bill print through their own routes', async () => {
    const sale = await get('/api/sales-invoices/pdf-si-1/print');
    assertPdf(sale, 'sales invoice print');
    assert.match(sale.disposition, /sales-invoice-PDF-SI-1\.pdf/, 'the filename names the document');

    const bill = await get('/api/purchase-invoices/pdf-pi-1/print');
    assertPdf(bill, 'purchase bill print');
    assert.match(bill.disposition, /purchase-bill-PDF-PI-1\.pdf/, 'the filename names the document');
  });

  test('Devanagari text uses an embedded Noto Sans Devanagari subset', async () => {
    const res = await get('/api/sales-invoices/pdf-si-1/print');
    assertPdf(res, 'Devanagari invoice print');
    const raw = latin1(res);
    assert.match(
      raw,
      /BaseFont\s*\/[A-Z]{6}\+NotoSansDevanagari-(Regular|Bold)/,
      'the invoice must embed a subset of the Devanagari font'
    );
    assert.match(raw, /\/FontFile2/, 'the subset must be embedded, not referenced from the viewer');
    assert.match(raw, /\/ToUnicode/, 'the subset must carry a Unicode map so glyphs can be extracted');
    assert.deepEqual(
      scriptRuns('नमस्ते Customer').map((run: any) => run.font),
      ['NotoSansDevanagari', 'NotoSans'],
      'mixed-script text must split into font runs rather than one Latin run'
    );
  });

  test('the three statements print from the same posted-line builders', async () => {
    const trial = await get(
      `/api/accounting/statements/trial-balance/print?branchId=${BR}&asOf=${TODAY}`,
      TOKENS.accountant
    );
    assertPdf(trial, 'trial balance print');
    assert.match(trial.disposition, /trial-balance-/, 'the trial balance filename stays stable');

    const pnl = await get(
      `/api/accounting/statements/profit-and-loss/print?branchId=${BR}&from=${TODAY}&to=${TODAY}`,
      TOKENS.accountant
    );
    assertPdf(pnl, 'profit and loss print');
    assert.match(pnl.disposition, /profit-and-loss-/, 'the P&L filename stays stable');

    const balance = await get(
      `/api/accounting/statements/balance-sheet/print?branchId=${BR}&asOf=${TODAY}`,
      TOKENS.accountant
    );
    assertPdf(balance, 'balance sheet print');
    assert.match(balance.disposition, /balance-sheet-/, 'the balance sheet filename stays stable');
  });

  test('a payslip prints from the posted run line and employee record', async () => {
    const res = await get(
      `/api/payroll-runs/${run.id}/payslips/${employee.id}/print`,
      TOKENS.accountant
    );
    assertPdf(res, 'payslip print');
    assert.match(res.disposition, /payslip-PR-/, 'the payslip filename names the run');
    assert.match(latin1(res), /NotoSansDevanagari/, 'the employee name is Devanagari and must use that font');
  });

  test('a document outside the caller branch is refused before rendering', async () => {
    const sale = await get('/api/sales-invoices/pdf-si-other/print', TOKENS.accountant);
    assert.equal(sale.status, 403, JSON.stringify(sale.json));
    assert.match(sale.contentType, /application\/json/, 'the refusal is a JSON error, not a PDF');
    assert.match(String(sale.json?.message || ''), /branch/i);
  });

  test('a caller without the view operation is refused', async () => {
    const statement = await get(
      `/api/accounting/statements/trial-balance/print?branchId=${BR}&asOf=${TODAY}`,
      TOKENS.frontdesk
    );
    assert.equal(statement.status, 403, JSON.stringify(statement.json));

    const payslip = await get(
      `/api/payroll-runs/${run.id}/payslips/${employee.id}/print`,
      TOKENS.frontdesk
    );
    assert.equal(payslip.status, 403, JSON.stringify(payslip.json));

    const bill = await get('/api/purchase-invoices/pdf-pi-1/print', TOKENS.frontdesk);
    assert.equal(bill.status, 403, JSON.stringify(bill.json));
  });
});

describe('PDF statement hierarchy', () => {
  test('a nested statement prints parent and sub-group subtotal rows', () => {
    const content = statementSectionsContent([
      {
        statementGroup: 'OPERATING_EXPENSE',
        label: 'Operating expenses',
        amount: 300,
        groups: [
          {
            groupId: 'g-exp',
            parentGroupId: null,
            groupCode: 'EXP',
            groupName: 'Operating',
            sortOrder: 1,
            amount: 300,
            accounts: [
              { accountId: 'a-rent', code: '5000', name: 'Rent', groupCode: 'EXP', groupName: 'Operating', amount: 100 },
            ],
            children: [
              {
                groupId: 'g-exp-sub',
                parentGroupId: 'g-exp',
                groupCode: 'EXP-SUB',
                groupName: 'Payroll',
                sortOrder: 2,
                amount: 200,
                accounts: [
                  { accountId: 'a-wages', code: '5100', name: 'Wages', groupCode: 'EXP-SUB', groupName: 'Payroll', amount: 200 },
                ],
                children: [],
              },
            ],
          },
        ],
      },
    ]) as any;
    const body = content.table.body as any[][];
    // `pdfText` splits a cell into script runs, so the visible label is the
    // concatenation of those runs rather than a single string.
    const cellText = (cell: any): string =>
      typeof cell?.text === 'string'
        ? cell.text
        : Array.isArray(cell?.text)
          ? cell.text.map((run: any) => run.text || '').join('')
          : '';
    const heading = (label: string) => body.find((row) => cellText(row[0]) === label);

    const parent = heading('EXP · Operating');
    assert.ok(parent, 'the parent group heading must be printed');
    assert.equal(parent![2].text, '300.00', 'the parent heading carries its rolled-up subtotal');

    const child = heading('  EXP-SUB · Payroll');
    assert.ok(child, 'the sub-group must be indented under its parent');
    assert.equal(child![2].text, '200.00', 'the sub-group carries its own subtotal');
  });
});

describe('PDF font resolution', () => {
  test('a missing font file fails by name instead of silently substituting', () => {
    assert.throws(
      () => resolvePdfFonts(() => 'C:/missing/font.woff'),
      /PDF font missing: Noto Sans normal/,
      'the named font, not a generic PDF error, must surface'
    );
  });
});
