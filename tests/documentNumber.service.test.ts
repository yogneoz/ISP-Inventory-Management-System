/**
 * NUM-1: document numbers are fail-closed and operator overrides carry the
 * same prefix/period/retirement rules as journals. These tests deliberately
 * use a failing sequence client: the old fallback invented an in-memory or
 * random number, while the new contract refuses the document outright.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueNextDocNumber,
  resolveDocumentNumber,
  validateDocumentNumberOverride,
} from '../server/src/utils/docNumber';
import { generateNextDocNumberForServer } from '../server/src/services/serverDocNumber';
import {
  setBranches,
  setDocNumberConfigs,
  setFiscalYears,
  setPgConnected,
} from '../server/src/state/runtimeState';
import { ApiError } from '../server/src/errors/ApiError';

const TODAY = '2026-11-14';

describe('document number allocation is fail-closed', () => {
  beforeEach(() => {
    setPgConnected(true);
    setBranches([{ id: 'br-1', code: 'BRX', name: 'Branch X' }] as any[]);
    setDocNumberConfigs([
      { id: 'INV', documentType: 'Sales Invoice', prefix: 'INV-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: '' },
      { id: 'PI', documentType: 'Purchase Invoice', prefix: 'PI-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: '' },
    ] as any[]);
    setFiscalYears([
      { code: '2083-84', startDateAD: '2026-07-17', endDateAD: '2027-07-16' },
    ] as any[]);
  });

  test('a sequence query failure refuses the document instead of inventing a number', async () => {
    let calls = 0;
    const failing = {
      query: async () => {
        calls += 1;
        const err: any = new Error('relation "document_sequence_daily" does not exist');
        err.code = '42P01';
        throw err;
      },
    };
    await assert.rejects(
      issueNextDocNumber('br-1', 'INV', TODAY, failing),
      (err: any) => {
        assert.ok(err instanceof ApiError, 'refusal must be a structured ApiError');
        assert.equal(err.status, 503);
        assert.match(String(err.message), /could not allocate the next legal number; nothing was posted/);
        return true;
      }
    );
    assert.equal(calls, 1, 'the failed sequence must not be retried or replaced by an in-memory counter');
  });

  test('the document-resolution path refuses an auto-numbered create when the sequence fails', async () => {
    await assert.rejects(
      resolveDocumentNumber({
        docType: 'INV',
        branchId: 'br-1',
        dateAd: TODAY,
        client: {
          query: async () => {
            const err: any = new Error('sequence table unavailable');
            err.code = '42P01';
            throw err;
          },
        },
      }),
      (err: any) => err instanceof ApiError && err.status === 503 && /nothing was posted/.test(err.message)
    );
  });

  test('the server helper refuses an unavailable or unconfigured sequence', async () => {
    await assert.rejects(
      generateNextDocNumberForServer('INV', {
        query: async () => {
          const err: any = new Error('connection refused');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      }),
      (err: any) => err instanceof ApiError && err.status === 503
    );
    await assert.rejects(
      generateNextDocNumberForServer('MISSING', { query: async () => ({ rows: [] }) }),
      (err: any) => err instanceof ApiError && err.status === 404
    );
  });
});

describe('operator/import document-number overrides', () => {
  beforeEach(() => {
    setPgConnected(false);
    setBranches([{ id: 'br-1', code: 'BRX', name: 'Branch X' }] as any[]);
    setDocNumberConfigs([
      { id: 'INV', documentType: 'Sales Invoice', prefix: 'INV-2081-', suffix: '', minDigits: 4, startingNumber: 1, nextNumber: 1, resetEveryFiscalYear: true, notes: '' },
    ] as any[]);
    setFiscalYears([
      { code: '2083-84', startDateAD: '2026-07-17', endDateAD: '2027-07-16' },
    ] as any[]);
  });

  test('accepts the configured prefix and matching fiscal period', async () => {
    assert.equal(
      await validateDocumentNumberOverride({ number: 'inv-2083-0042', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      'INV-2083-0042'
    );
  });

  test('accepts the canonical same-day/same-branch shape', async () => {
    assert.equal(
      await validateDocumentNumberOverride({ number: 'INV-BRX-202611140001', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      'INV-BRX-202611140001'
    );
    await assert.rejects(
      validateDocumentNumberOverride({ number: 'INV-BRX-202611130001', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      /is dated 2026-11-13, not 2026-11-14/
    );
    await assert.rejects(
      validateDocumentNumberOverride({ number: 'INV-OTHER-202611140001', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      /belongs to branch OTHER, not BRX/
    );
  });

  test('refuses a wrong prefix, a wrong fiscal period, and a malformed override', async () => {
    await assert.rejects(
      validateDocumentNumberOverride({ number: 'PI-2083-0042', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      /must use the INV- prefix/
    );
    await assert.rejects(
      validateDocumentNumberOverride({ number: 'INV-2082-0042', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      /period 2082, but 2026-11-14 belongs to 2083-84/
    );
    await assert.rejects(
      validateDocumentNumberOverride({ number: 'INV-2083', docType: 'INV', branchId: 'br-1', dateAd: TODAY }),
      /must be INV-\{BRANCH\}-\{YYYYMMDD\}\{SEQ\} or INV-\{FISCAL_YEAR\}-\{SEQ\}/
    );
  });

  test('refuses reuse of a number the retirement registry marks retired', async () => {
    const retiredClient = {
      query: async (sql: string) => {
        if (/fiscal_years/.test(sql)) return { rows: [{ code: '2083-84' }] };
        if (/document_number_retirements/.test(sql)) return { rows: [{ reason: 'Sales invoice cancelled' }] };
        return { rows: [] };
      },
    };
    await assert.rejects(
      resolveDocumentNumber({
        provided: 'INV-2083-0042',
        docType: 'INV',
        branchId: 'br-1',
        dateAd: TODAY,
        client: retiredClient,
      }),
      /was retired \(Sales invoice cancelled\) and cannot be reused/
    );
  });
});
