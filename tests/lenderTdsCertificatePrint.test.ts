import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildLenderTdsCertificateHtml } from '../client/src/utils/lenderTdsCertificate';

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const LARGE_TABLE_ROWS = 48;

/** PDF text extraction may split a value at a ligature or hyphen; removing
 * whitespace compares the characters the reader actually sees. */
function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

function browserCandidates(): string[] {
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  return [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(programFiles, 'Google/Chrome/Application/chrome.exe'),
    path.join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    path.join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function findBrowser(): string | null {
  const pinned = process.env.TDS_CERT_BROWSER?.trim();
  if (pinned) return fs.existsSync(pinned) ? pinned : null;

  for (const candidate of browserCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [
    process.platform === 'win32' ? 'chrome.exe' : 'google-chrome',
  ], { encoding: 'utf8' });
  if (lookup.status === 0) {
    const first = lookup.stdout.trim().split(/\r?\n/)[0];
    if (first) return first;
  }
  return null;
}

function requireBrowser(t: TestContext): string | null {
  const browser = findBrowser();
  if (browser) {
    console.log(`TDS certificate print browser: ${browser}`);
    return browser;
  }

  const pinned = process.env.TDS_CERT_BROWSER?.trim();
  if (pinned) {
    assert.fail(`TDS_CERT_BROWSER points to "${pinned}", but no browser exists there.`);
  }
  if (process.env.CI) {
    assert.fail(
      'CI must run the TDS certificate print regression, but no browser was found. ' +
        'Pin TDS_CERT_BROWSER to the installed Chrome path.'
    );
  }

  t.skip(
    'No Chrome/Chromium/Edge executable found for headless PDF rendering; ' +
      'set TDS_CERT_BROWSER to pin one and run this test.'
  );
  return null;
}

function printStatement() {
  const withheld = Array.from({ length: 21 }, (_, index) => {
    if (index === 0) {
      return {
        id: 'txn-original',
        txnNumber: 'LP-WH001-202611100002',
        dateAD: '2026-11-10',
        dateBS: '2083-07-24',
        principalAmount: 1000,
        interestAmount: 200,
        tdsAmount: 30,
        cashAmount: 1170,
        tdsStatus: 'WITHHELD' as const,
        exemptionReason: null,
        exemptionReference: null,
        loanNumber: 'LOAN-WH001-202611010002',
        journalNo: 'MJ-2083-84-30761',
      };
    }
    return {
      id: `txn-extra-${index}`,
      txnNumber: `LP-PRINT-${String(index).padStart(2, '0')}`,
      dateAD: `2026-11-${String(10 + index).padStart(2, '0')}`,
      dateBS: '2083-07-24',
      principalAmount: 45,
      interestAmount: 20,
      tdsAmount: 3,
      cashAmount: 62,
      tdsStatus: 'WITHHELD' as const,
      exemptionReason: null,
      exemptionReference: null,
      loanNumber: 'LOAN-WH001-202611010002',
      journalNo: `MJ-PRINT-${String(index).padStart(2, '0')}`,
    };
  });

  return {
    lender: {
      id: 'lender-print',
      code: 'UICERT-1',
      name: 'UI Certificate <Bank> & Co',
      lenderType: 'OTHER',
      panNumber: 'PAN<987>',
      address: 'Kathmandu, Nepal',
      active: true,
      loanCount: 1,
      openPrincipal: 0,
      bookBalance: 0,
    },
    book: null,
    control: { accountId: 'acct-loan', accountCode: '2350', accountName: 'Loan Payable' },
    from: '2026-11-01',
    to: '2026-11-30',
    branchId: 'WH001',
    openingBalance: 0,
    entries: [],
    totals: { debit: 0, credit: 0, closingBalance: 0 },
    loans: [],
    tdsEntries: [
      ...withheld,
      {
        id: 'txn-exempt',
        txnNumber: 'LP-EXEMPT-202611120001',
        dateAD: '2026-11-12',
        dateBS: '2083-07-26',
        principalAmount: 100,
        interestAmount: 100,
        tdsAmount: 0,
        cashAmount: 200,
        tdsStatus: 'EXEMPT' as const,
        exemptionReason: 'RESIDENT_BANK',
        exemptionReference: 'Bank certificate',
        loanNumber: 'LOAN-WH001-202611010002',
        journalNo: 'MJ-EXEMPT-01',
      },
    ],
    tdsTotals: {
      principal: 2000,
      interest: 700,
      tds: 90,
      cash: 2610,
      withheldInterest: 600,
      withheldTax: 90,
      exemptInterest: 100,
      unexplainedInterest: 0,
      noInterestPrincipal: 0,
      withheldCount: 21,
      exemptCount: 1,
      unexplainedCount: 0,
      noInterestCount: 0,
      ledgerPrincipal: 2000,
      ledgerInterest: 700,
      ledgerTds: 90,
      ledgerCash: 2610,
      principalDifference: 0,
      interestDifference: 0,
      tdsDifference: 0,
      cashDifference: 0,
      reconciled: true,
    },
    tieOut: {
      glBalance: 0,
      subledgerBalance: 0,
      lenderBooksBalance: 0,
      unassignedLenderBalance: 0,
      difference: 0,
      booksDifference: 0,
      status: 'RECONCILED' as const,
    },
  } as any;
}

test('TDS certificate prints on A4 with intact rows and totals', async (t) => {
  const browser = requireBrowser(t);
  if (!browser) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tds-certificate-print-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const htmlPath = path.join(dir, 'certificate.html');
  const pdfPath = path.join(dir, 'certificate.pdf');
  const html = buildLenderTdsCertificateHtml(printStatement(), {
    name: 'Example Co',
    legalName: 'Example Co Pvt. Ltd.',
    address: 'Kathmandu, Nepal',
    city: 'Kathmandu',
    country: 'Nepal',
    panVatNumber: '300000000',
  });
  fs.writeFileSync(htmlPath, html.replace(/<script>[\s\S]*?<\/script>/i, ''));

  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--no-first-run',
      '--no-pdf-header-footer',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      `--print-to-pdf=${pdfPath}`,
      '--virtual-time-budget=1500',
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'pipe', timeout: 30_000 }
  );
  assert.ok(fs.existsSync(pdfPath), 'headless Chrome must write a PDF');

  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)) }).promise;
  assert.equal(doc.numPages, 2, '21 withheld rows plus signatures must paginate to two A4 pages');

  const pages: Array<{ text: string[]; width: number; height: number; maxRight: number; minY: number; maxY: number }> = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => 'str' in item && Boolean(item.str.trim()))
      .map((item) => {
        const textItem = item as { str: string; transform: number[]; width: number };
        return {
          text: textItem.str.trim(),
          x: textItem.transform[4],
          y: textItem.transform[5],
          width: textItem.width,
        };
      });
    pages.push({
      text: items.map((item) => item.text),
      width: viewport.width,
      height: viewport.height,
      maxRight: Math.max(...items.map((item) => item.x + item.width)),
      minY: Math.min(...items.map((item) => item.y)),
      maxY: Math.max(...items.map((item) => item.y)),
    });
  }

  for (const [index, page] of pages.entries()) {
    assert.ok(
      Math.abs(page.width - A4_WIDTH_PT) < 1 && Math.abs(page.height - A4_HEIGHT_PT) < 1,
      `page ${index + 1} must be A4 (${page.width}x${page.height}pt)`
    );
    assert.ok(page.maxRight <= page.width - 20, `page ${index + 1} must keep content inside the right margin`);
    assert.ok(page.minY >= 20, `page ${index + 1} must keep content inside the bottom margin`);
    assert.ok(page.maxY <= page.height - 20, `page ${index + 1} must keep content inside the top margin`);
  }

  const page1 = pages[0].text.join('\n');
  const page2 = pages[1].text.join('\n');
  const allText = `${page1}\n${page2}`;
  const page1Compact = compact(page1);
  const page2Compact = compact(page2);
  const allCompact = compact(allText);

  assert.match(page1Compact, /TDS\/UICERT-1\/2026-11-01\/2026-11-30/);
  assert.match(page1Compact, /UICertificate<Bank>&Co/);
  assert.match(page1Compact, /PAN<987>/);
  assert.match(page1Compact, /Kathmandu,Nepal/);
  assert.doesNotMatch(page1Compact, /Kathmandu,Nepal,Kathmandu,Nepal/);
  const totalsPage = pages.find((page) => compact(page.text.join('')).includes('Totalwithheldon21repayments'));
  assert.ok(totalsPage, 'the certificate must print its totals row');
  const totalsCompact = compact(totalsPage.text.join(''));
  assert.match(totalsCompact, /NPR600/);
  assert.match(totalsCompact, /NPR90/);
  assert.match(totalsCompact, /NPR2,410/);
  assert.match(totalsCompact, /NPR100/);
  assert.match(page1Compact, /2026-11-10/);
  assert.match(page1Compact, /LOAN-WH001-202611010002/);
  assert.match(page1Compact, /LP-WH001-202611100002/);
  assert.match(page1Compact, /MJ-2083-84-30761/);
  assert.match(page1Compact, /NPR200/);
  assert.match(page1Compact, /NPR1,170/);
  assert.equal(
    (page1Compact.match(/LP-(?:WH001|PRINT)-[0-9]+/g) || []).length,
    21,
    'every withheld repayment must survive on page 1'
  );
  assert.doesNotMatch(page2Compact, /LP-(?:WH001|PRINT)-[0-9]+/, 'no table row may be split onto the signature page');
  assert.match(page2Compact, /Registerreconciliation:/);
  assert.match(page2Compact, /RECONCILED\./);
  assert.match(page2Compact, /Place\/date/);
  assert.match(page2Compact, /Authorisedsignatory/);
  assert.doesNotMatch(allCompact, /Print\/SaveasPDF/);
  assert.doesNotMatch(allCompact, /TDSCSV/);
});

function stressStatement() {
  const withheld = Array.from({ length: LARGE_TABLE_ROWS }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 1 + index));
    return {
      id: `txn-stress-${index + 1}`,
      txnNumber: `LP-STRESS-2026-${String(index + 1).padStart(3, '0')}`,
      dateAD: date.toISOString().slice(0, 10),
      dateBS: '2083-07-15',
      principalAmount: 1000,
      interestAmount: 100,
      tdsAmount: 15,
      cashAmount: 1085,
      tdsStatus: 'WITHHELD' as const,
      exemptionReason: null,
      exemptionReference: null,
      loanNumber: 'LOAN-STRESS-2026-0001',
      journalNo: `MJ-STRESS-${String(index + 1).padStart(3, '0')}`,
    };
  });

  return {
    ...printStatement(),
    lender: {
      ...printStatement().lender,
      code: 'UICERT-STRESS-2026-LONG-CODE',
      name:
        'UI Certificate <Bank> & Co — National Infrastructure and Rural Electrification Finance Corporation Limited (Stress Test)',
      panNumber: 'PANABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789SUPERLONGIDENTIFIER',
    },
    from: '2026-11-01',
    to: '2026-12-31',
    tdsEntries: [
      ...withheld,
      {
        id: 'txn-stress-exempt',
        txnNumber: 'LP-STRESS-EXEMPT-001',
        dateAD: '2026-12-20',
        dateBS: '2083-09-04',
        principalAmount: 100,
        interestAmount: 100,
        tdsAmount: 0,
        cashAmount: 200,
        tdsStatus: 'EXEMPT' as const,
        exemptionReason: 'RESIDENT_BANK',
        exemptionReference: 'Stress-test bank certificate',
        loanNumber: 'LOAN-STRESS-2026-0001',
        journalNo: 'MJ-STRESS-EXEMPT',
      },
    ],
    tdsTotals: {
      principal: 48100,
      interest: 4900,
      tds: 720,
      cash: 52280,
      withheldInterest: 4800,
      withheldTax: 720,
      exemptInterest: 100,
      unexplainedInterest: 0,
      noInterestPrincipal: 0,
      withheldCount: LARGE_TABLE_ROWS,
      exemptCount: 1,
      unexplainedCount: 0,
      noInterestCount: 0,
      ledgerPrincipal: 48100,
      ledgerInterest: 4900,
      ledgerTds: 720,
      ledgerCash: 52280,
      principalDifference: 0,
      interestDifference: 0,
      tdsDifference: 0,
      cashDifference: 0,
      reconciled: true,
    },
  } as any;
}

test('TDS certificate paginates a 48-row table with repeated headers and intact rows', async (t) => {
  const browser = requireBrowser(t);
  if (!browser) return;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tds-certificate-stress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const htmlPath = path.join(dir, 'certificate.html');
  const pdfPath = path.join(dir, 'certificate.pdf');
  const statement = stressStatement();
  const html = buildLenderTdsCertificateHtml(statement, {
    name: 'Example Co',
    legalName: 'Example Co Pvt. Ltd.',
    address: 'Kathmandu, Nepal',
    city: 'Kathmandu',
    country: 'Nepal',
    panVatNumber: '300000000',
  });
  fs.writeFileSync(htmlPath, html.replace(/<script>[\s\S]*?<\/script>/i, ''));

  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--no-first-run',
      '--no-pdf-header-footer',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      `--print-to-pdf=${pdfPath}`,
      '--virtual-time-budget=1500',
      pathToFileURL(htmlPath).href,
    ],
    { stdio: 'pipe', timeout: 30_000 }
  );
  assert.ok(fs.existsSync(pdfPath), 'headless Chrome must write a PDF');

  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)) }).promise;
  assert.ok(
    doc.numPages >= 2 && doc.numPages <= 3,
    `48 withheld rows must paginate across two or three A4 pages (got ${doc.numPages})`
  );

  const pages: Array<{
    text: string[];
    width: number;
    height: number;
    maxRight: number;
    minY: number;
    maxY: number;
  }> = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => 'str' in item && Boolean(item.str.trim()))
      .map((item) => {
        const textItem = item as { str: string; transform: number[]; width: number };
        return {
          text: textItem.str.trim(),
          x: textItem.transform[4],
          y: textItem.transform[5],
          width: textItem.width,
        };
      });
    pages.push({
      text: items.map((item) => item.text),
      width: viewport.width,
      height: viewport.height,
      maxRight: Math.max(...items.map((item) => item.x + item.width)),
      minY: Math.min(...items.map((item) => item.y)),
      maxY: Math.max(...items.map((item) => item.y)),
    });
  }

  for (const [index, page] of pages.entries()) {
    assert.ok(
      Math.abs(page.width - A4_WIDTH_PT) < 1 && Math.abs(page.height - A4_HEIGHT_PT) < 1,
      `page ${index + 1} must be A4 (${page.width}x${page.height}pt)`
    );
    assert.ok(page.maxRight <= page.width - 20, `page ${index + 1} must keep content inside the right margin`);
    assert.ok(page.minY >= 20, `page ${index + 1} must keep content inside the bottom margin`);
    assert.ok(page.maxY <= page.height - 20, `page ${index + 1} must keep content inside the top margin`);
  }

  const pageTexts = pages.map((page) => page.text.join('\n'));
  const firstPage = pageTexts[0];
  const lastPage = pageTexts[pageTexts.length - 1];
  const allText = pageTexts.join('\n');
  const firstCompact = compact(firstPage);
  const lastCompact = compact(lastPage);
  const allCompact = compact(allText);

  assert.match(firstCompact, /TDS\/UICERT-STRESS-2026-LONG-CODE\/2026-11-01\/2026-12-31/);
  assert.match(firstCompact, /UICertificate<Bank>&Co/);
  assert.match(firstCompact, /NationalInfrastructureandRural/);
  assert.match(firstCompact, /PAN:PANABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789SUPERLONGIDENTIFIER/);
  assert.equal(new Set(allCompact.match(/LP-STRESS-2026-\d{3}/g) || []).size, LARGE_TABLE_ROWS);
  assert.equal(
    (allCompact.match(/LP-STRESS-2026-\d{3}/g) || []).length,
    LARGE_TABLE_ROWS,
    'every large-table repayment must survive exactly once'
  );

  for (const [index, page] of pages.entries()) {
    assert.match(compact(page.text.join('')), /DATE\(AD\)/, `page ${index + 1} must repeat the table header`);
  }

  const rowPages = new Set<number>();
  const rows = statement.tdsEntries.filter((entry: any) => entry.tdsStatus === 'WITHHELD');
  assert.equal(rows.length, LARGE_TABLE_ROWS);
  for (const row of rows) {
    const found = pages.flatMap((page, pageIndex) =>
      compact(page.text.join('')).includes(row.txnNumber) ? [pageIndex] : []
    );
    assert.equal(found.length, 1, `${row.txnNumber} must appear on exactly one page`);
    const pageIndex = found[0];
    const rowPage = compact(pages[pageIndex].text.join(''));
    assert.ok(
      rowPage.includes(row.dateAD) && rowPage.includes(row.journalNo),
      `${row.txnNumber} must keep its date and journal on the same page`
    );
    rowPages.add(pageIndex);
  }
  assert.deepEqual(
    [...rowPages].sort((a, b) => a - b),
    pages.map((_, index) => index),
    'the table itself must continue across every page'
  );

  assert.doesNotMatch(firstCompact, /Totalwithheldon48repayments/, 'the grand total must not repeat before the table ends');
  assert.equal((lastCompact.match(/Totalwithheldon48repayments/g) || []).length, 1);
  assert.match(lastCompact, /NPR4,800/);
  assert.match(lastCompact, /NPR720/);
  assert.match(lastCompact, /NPR52,080/);
  assert.match(lastCompact, /NPR100/);
  assert.match(lastCompact, /Registerreconciliation:/);
  assert.match(lastCompact, /RECONCILED\./);
  assert.match(lastCompact, /Place\/date/);
  assert.match(lastCompact, /Authorisedsignatory/);
  assert.doesNotMatch(allCompact, /Print\/SaveasPDF/);
  assert.doesNotMatch(allCompact, /TDSCSV/);
});
