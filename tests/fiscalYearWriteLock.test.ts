/**
 * Closed-fiscal-year write gate (audit finding H1).
 *
 * The old middleware read the year from the `x-fiscal-year-id` request header,
 * so a caller that simply omitted the header wrote into a locked IRD period, and
 * INVENTORY_MANAGER could override a lock. These tests pin the replacement rule:
 * the year comes from the document's own date, and only a Super Admin may
 * override — with a reason of real length.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateFiscalYearWriteGate,
  writeDateFromBody,
  fiscalYearForDate,
  OVERRIDE_REASON_MIN_LENGTH,
} from '../server/src/middleware/fiscalWriteGate';

const YEARS = [
  { id: 'fy-2081', code: '2081-82', startDateAD: '2024-07-17', endDateAD: '2025-07-16', isCurrent: false, isClosed: true },
  { id: 'fy-2082', code: '2082-83', startDateAD: '2025-07-17', endDateAD: '2026-07-16', isCurrent: true, isClosed: false },
];

const closedWrite = (body: any, role = 'BRANCH_MANAGER') =>
  evaluateFiscalYearWriteGate({ method: 'POST', path: '/sales-invoices', body, role, fiscalYears: YEARS });

describe('fiscal write gate', () => {
  describe('date resolution', () => {
    test('picks the first parseable document date field', () => {
      assert.equal(writeDateFromBody({ journalDateAD: '2025-01-15', dateAD: '2025-02-01' }), '2025-01-15');
      assert.equal(writeDateFromBody({ dateAD: '2025-02-01' }), '2025-02-01');
      assert.equal(writeDateFromBody({ dateAD: 'not-a-date' }), '');
      assert.equal(writeDateFromBody({}), '');
      assert.equal(writeDateFromBody(null), '');
    });

    test('finds the fiscal year containing a date', () => {
      assert.equal(fiscalYearForDate(YEARS, '2024-12-31')?.code, '2081-82');
      assert.equal(fiscalYearForDate(YEARS, '2026-01-01')?.code, '2082-83');
      assert.equal(fiscalYearForDate(YEARS, '2030-01-01'), undefined);
    });
  });

  describe('closed-year refusal no longer depends on a request header', () => {
    test('a closed-year document date is refused with no header at all', () => {
      const verdict = closedWrite({ invoiceDateAD: '2025-01-15' });
      assert.equal(verdict.kind, 'closed');
      if (verdict.kind !== 'closed') return;
      assert.equal(verdict.fiscalYearCode, '2081-82');
      assert.equal(verdict.requiresReason, false, 'a non-Super-Admin has no override path');
    });

    test('an undated write is judged against the current year, not skipped', () => {
      const closedCurrent = [{ id: 'fy', code: '2099-00', startDateAD: '2020-01-01', endDateAD: '2099-12-31', isCurrent: true, isClosed: true }];
      const verdict = evaluateFiscalYearWriteGate({
        method: 'PUT',
        path: '/products/p1',
        body: {},
        role: 'INVENTORY_MANAGER',
        fiscalYears: closedCurrent,
      });
      assert.equal(verdict.kind, 'closed', 'INVENTORY_MANAGER no longer overrides a closed year');
    });
  });

  describe('Super Admin override', () => {
    test('is refused until a reason of real length is supplied', () => {
      const verdict = closedWrite({ invoiceDateAD: '2025-01-15', overrideReason: 'fix' }, 'SUPER_ADMIN');
      assert.equal(verdict.kind, 'closed');
      if (verdict.kind !== 'closed') return;
      assert.equal(verdict.requiresReason, true);
    });

    test('is allowed with a written reason', () => {
      const reason = 'Re-posting the December bill after the supplier corrected its VAT number.';
      const verdict = closedWrite({ invoiceDateAD: '2025-01-15', overrideReason: reason }, 'SUPER_ADMIN');
      assert.equal(verdict.kind, 'override');
      if (verdict.kind !== 'override') return;
      assert.equal(verdict.reason, reason);
      assert.ok(reason.length >= OVERRIDE_REASON_MIN_LENGTH);
    });
  });

  describe('non-gated requests', () => {
    test('reads and exempt paths pass untouched', () => {
      assert.equal(
        evaluateFiscalYearWriteGate({ method: 'GET', path: '/sales-invoices', body: {}, role: 'BRANCH_MANAGER', fiscalYears: YEARS }).kind,
        'allow'
      );
      for (const path of ['/auth/login', '/fiscal-years/fy-2081/close', '/sync/broadcast', '/admin/recalculate/live-stock']) {
        assert.equal(
          evaluateFiscalYearWriteGate({ method: 'POST', path, body: { dateAD: '2025-01-15' }, role: 'BRANCH_MANAGER', fiscalYears: YEARS }).kind,
          'allow',
          path
        );
      }
    });

    test('a write dated in an open year passes', () => {
      assert.equal(closedWrite({ invoiceDateAD: '2026-01-15' }).kind, 'allow');
    });

    test('a date no fiscal year covers passes the gate (posting refuses it later)', () => {
      assert.equal(closedWrite({ invoiceDateAD: '2019-01-15' }).kind, 'allow');
    });
  });
});
