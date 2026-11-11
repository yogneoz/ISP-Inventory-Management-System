/**
 * The journal line cap must hold the widest payroll document.
 *
 * A posted run writes one salary-cost debit plus, per employee, TDS, employee
 * SSF, employer SSF, advance recovery, loan recovery and net payable — six
 * credits. With the run capped at 190 employees that is 1 + 6×190 = 1141 lines.
 *
 * When employer SSF became a posted credit the cap was still 1000 (sized for
 * five credits per employee), so a large run would have been refused at posting
 * time with "a journal can hold at most 1000 lines". This test pins the
 * arithmetic that keeps the two limits in step.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_JOURNAL_LINES } from '../server/src/services/accounting.service';
import { PAYROLL_EMPLOYEES_PER_RUN_MAX } from '../server/src/controllers/payroll.controller';

/** Debit line + six credit lines per employee. */
const LINES_PER_EMPLOYEE = 6;

describe('journal line cap', () => {
  test('a full payroll run fits inside the cap', () => {
    const worstCase = 1 + LINES_PER_EMPLOYEE * PAYROLL_EMPLOYEES_PER_RUN_MAX;
    assert.equal(worstCase, 1141);
    assert.ok(
      worstCase <= MAX_JOURNAL_LINES,
      `a full run needs ${worstCase} lines but the journal cap is ${MAX_JOURNAL_LINES}`
    );
  });
});
