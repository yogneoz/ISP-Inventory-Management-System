import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLenderTdsCertificateHtml } from '../client/src/utils/lenderTdsCertificate';

const statement = {
  lender: {
    id: 'lender-1',
    code: 'LNT-BANK',
    name: 'A & B <script>alert(1)</script>',
    lenderType: 'OTHER',
    panNumber: '123456789',
    address: 'Kathmandu',
    active: true,
    loanCount: 1,
    openPrincipal: 0,
    bookBalance: 0,
  },
  book: null,
  control: { accountId: 'acct-1', accountCode: '2100', accountName: 'Loan Payable' },
  from: '2026-08-01',
  to: '2026-08-31',
  branchId: 'BRH01',
  openingBalance: 0,
  entries: [],
  totals: { debit: 0, credit: 0, closingBalance: 0 },
  loans: [],
  tdsEntries: [
    {
      id: 'txn-1',
      txnNumber: 'LP-0001',
      dateAD: '2026-08-20',
      dateBS: '2083-05-04',
      principalAmount: 100,
      interestAmount: 100,
      tdsAmount: 15,
      cashAmount: 185,
      tdsStatus: 'WITHHELD',
      exemptionReason: null,
      exemptionReference: null,
      loanNumber: 'LN-0001',
      journalNo: 'JV-0001',
    },
    {
      id: 'txn-2',
      txnNumber: 'LP-0002',
      dateAD: '2026-08-21',
      dateBS: '2083-05-05',
      principalAmount: 50,
      interestAmount: 10,
      tdsAmount: 0,
      cashAmount: 60,
      tdsStatus: 'EXEMPT',
      exemptionReason: 'RESIDENT_BANK',
      exemptionReference: 'Bank certificate',
      loanNumber: 'EXEMPT-LOAN',
      journalNo: 'JV-0002',
    },
  ],
  tdsTotals: {
    principal: 150,
    interest: 110,
    tds: 15,
    cash: 245,
    withheldInterest: 100,
    withheldTax: 15,
    exemptInterest: 10,
    unexplainedInterest: 0,
    noInterestPrincipal: 0,
    withheldCount: 1,
    exemptCount: 1,
    unexplainedCount: 0,
    noInterestCount: 0,
    ledgerPrincipal: 150,
    ledgerInterest: 110,
    ledgerTds: 15,
    ledgerCash: 245,
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

test('lender TDS certificate lists only withheld rows and escapes lender identity', () => {
  const html = buildLenderTdsCertificateHtml(statement, {
    name: 'Example Co',
    legalName: 'Example Co Pvt. Ltd.',
    address: 'Lalitpur',
    city: 'Lalitpur',
    country: 'Nepal',
    panVatNumber: '987654321',
  });
  assert.match(html, /TDS WITHHOLDING CERTIFICATE/);
  assert.match(html, /Example Co Pvt\. Ltd\./);
  assert.match(html, /LP-0001/);
  assert.match(html, /LN-0001/);
  assert.match(html, /A &amp; B &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /EXEMPT-LOAN/, 'exempt rows must not be presented as tax withheld');
  assert.match(html, /Total withheld on 1 repayment/);
  assert.match(html, /RECONCILED/);
});
