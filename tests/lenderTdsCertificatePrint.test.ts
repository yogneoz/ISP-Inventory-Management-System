import { test } from 'node:test';
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
  const browser = findBrowser();
  if (!browser) {
    t.skip('No Chrome/Chromium/Edge executable found for headless PDF rendering.');
    return;
  }

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

  assert.match(page1, /TDS\/UICERT-1\/2026-11-01\/2026-11-30/);
  assert.match(page1, /UI Certificate <Bank> & Co/);
  assert.match(page1, /PAN<987>/);
  assert.match(page1, /Kathmandu, Nepal/);
  assert.doesNotMatch(page1, /Kathmandu, Nepal, Kathmandu, Nepal/);
  assert.match(page1, /Total withheld on 21 repayments/);
  assert.match(page1, /NPR 600/);
  assert.match(page1, /NPR 90/);
  assert.match(page1, /NPR 2,410/);
  assert.match(page1, /NPR 100/);
  assert.match(page1, /2026-11-10/);
  assert.match(page1, /LOAN-WH001-202611010002/);
  assert.match(page1, /LP-WH001-202611100002/);
  assert.match(page1, /MJ-2083-84-30761/);
  assert.match(page1, /NPR 200/);
  assert.match(page1, /NPR 1,170/);
  assert.equal(
    page1.split('\n').filter((line) => /^LP-(?:WH001|PRINT)-/.test(line)).length,
    21,
    'every withheld repayment must survive on page 1'
  );
  assert.doesNotMatch(page2, /^LP-/m, 'no table row may be split onto the signature page');
  assert.match(page2, /Register reconciliation:/);
  assert.match(page2, /RECONCILED\./);
  assert.match(page2, /Place \/ date/);
  assert.match(page2, /Authorised signatory/);
  assert.doesNotMatch(allText, /Print \/ Save as PDF/);
  assert.doesNotMatch(allText, /TDS CSV/);
});
