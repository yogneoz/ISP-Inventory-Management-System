/**
 * Dual-date report guard (2026-11-07).
 *
 * Persisting BS beside AD is only half of the Nepal dual-date rule: the
 * registers and printed reports must show both halves too. These tests pin the
 * two report surfaces that used to print one calendar:
 *
 *   1. the customer/vendor/GL ledger CSV — both Date (AD) and Date (BS) columns
 *      are always emitted, with the reader's chosen mode leading;
 *   2. the printed statement PDF — the header date and the period range carry
 *      the BS half beside every AD boundary.
 *
 * The PDF text stream is compressed, so the header test asserts the identity
 * object buildStatementPdf feeds to documentIdentity(), and a separate test
 * renders a real PDF to prove the pipeline still produces a document.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportCsv } from '../client/src/utils/exportUtils';
import { ledgerExportColumns } from '../client/src/components/common/LedgerView';
import { buildStatementPdf, statementPdfMeta } from '../server/src/services/pdf.service';

describe('finance reports carry both AD and BS dates', () => {
  test('ledger CSV emits both date columns, chosen mode first', () => {
    const { content } = buildExportCsv({
      filename: 'Customer_Ledger_Test',
      includeMetadataHeader: false,
      columns: ledgerExportColumns({}, 'BS'),
      data: [
        {
          DateAD: '2026-11-02',
          DateBS: '2083-07-17 BS',
          'Document No': 'SI-1',
          Type: 'INVOICE',
          Debit: 100,
          Credit: 0,
          'Running Balance': 100,
          Notes: '',
        },
      ],
    });
    assert.match(content, /"Date \(BS\)","Date \(AD\)"/, 'BS leads when the reader works in BS');
    assert.ok(content.includes('2083-07-17 BS'), 'the BS half must reach the file');
    assert.ok(content.includes('2026-11-02'), 'the AD half must reach the file');
  });

  test('ledger CSV keeps both halves when AD leads', () => {
    const { content } = buildExportCsv({
      filename: 'Vendor_Ledger_Test',
      includeMetadataHeader: false,
      columns: ledgerExportColumns({ date: 'Posting Date' }, 'AD'),
      data: [
        {
          DateAD: '2026-11-02',
          DateBS: '2083-07-17 BS',
          'Document No': 'PI-1',
          Type: 'BILL',
          Debit: 0,
          Credit: 100,
          'Running Balance': 100,
          Notes: '',
        },
      ],
    });
    assert.match(content, /"Posting Date \(AD\)","Posting Date \(BS\)"/);
    assert.ok(content.includes('2083-07-17 BS') && content.includes('2026-11-02'));
  });

  test('statement PDF header prints both calendars for the period', () => {
    const meta = statementPdfMeta({
      kind: 'PROFIT_AND_LOSS',
      statement: { from: '2026-08-01', to: '2026-11-02' },
      fromBS: '2083-04-17 BS',
      toBS: '2083-07-17 BS',
    });
    assert.equal(meta.dateBS, '2083-07-17', 'the header appends its own BS suffix');
    assert.equal(
      meta.rangeLabel,
      '2026-08-01 (2083-04-17 BS) → 2026-11-02 (2083-07-17 BS)'
    );
  });

  test('balance sheet PDF header prints the as-of date in both calendars', () => {
    const meta = statementPdfMeta({
      kind: 'BALANCE_SHEET',
      statement: { asOf: '2026-11-02' },
      toBS: '2083-07-17 BS',
    });
    assert.equal(meta.rangeLabel, 'As of 2026-11-02 (2083-07-17 BS)');
  });

  test('a statement with BS halves still renders a real PDF', async () => {
    const buffer = await buildStatementPdf({
      kind: 'PROFIT_AND_LOSS',
      statement: { from: '2026-08-01', to: '2026-11-02', sections: [] },
      company: { name: 'Test Company' },
      branchName: 'Head Office',
      fromBS: '2083-04-17 BS',
      toBS: '2083-07-17 BS',
    });
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buffer.length > 1000, 'the statement must render a page, not a stub');
  });
});
