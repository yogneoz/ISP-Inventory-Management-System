/**
 * SSF payable reconciliation.
 *
 * The report has to answer one question: does the SSF payable control account
 * carry exactly what the posted runs owe the fund, at the configured rates?
 * These cases pin each way that can fail, so a mismatch is never reported as a
 * pass and a missing configuration is never reported as a zero difference.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSsfEmployeeRows,
  buildSsfReconciliation,
} from '../server/src/services/ssfReconciliation.service';

const MATCHED = {
  employeeSsf: 286,
  employerSsf: 520,
  configuredEmployeeSsf: 286,
  configuredEmployerSsf: 520,
  rateMismatchLines: 0,
  unconfiguredLines: 0,
  controlBalance: 806,
  controlLineCount: 8,
  controlAccountCode: '2300',
  controlAccountName: 'SSF Payable',
};

describe('SSF payable reconciliation', () => {
  test('a fully posted, configured period reconciles', () => {
    const result = buildSsfReconciliation(MATCHED);
    assert.equal(result.payable, 806);
    assert.equal(result.configured, 806);
    assert.equal(result.difference, 0);
    assert.equal(result.matches, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.controlAccount, { code: '2300', name: 'SSF Payable' });
  });

  test('a control balance short of the contributions is a difference', () => {
    const result = buildSsfReconciliation({ ...MATCHED, controlBalance: 800 });
    assert.equal(result.difference, -6);
    assert.equal(result.matches, false);
    assert.match(String(result.reason), /differs from the posted contributions by -6\.00/);
  });

  test('a rate difference is a configuration variance, not a ledger break', () => {
    // The control account still carries what was paid; only the rates on file
    // have moved (a configuration edited after the run was prepared).
    const result = buildSsfReconciliation({ ...MATCHED, rateMismatchLines: 1 });
    assert.equal(result.matches, true);
    assert.equal(result.ratesMatch, false);
    assert.equal(result.reason, null);
    assert.match(String(result.rateNote), /may have been edited after the run was prepared/);
  });

  test('a contributing line with no statutory configuration cannot be verified', () => {
    const result = buildSsfReconciliation({ ...MATCHED, unconfiguredLines: 2 });
    assert.equal(result.matches, true);
    assert.equal(result.ratesMatch, false);
    assert.match(String(result.rateNote), /2 contributing payroll lines cannot be verified/);
  });

  test('per-employee rows are ordered by the largest absolute difference', () => {
    const rows = buildSsfEmployeeRows([
      {
        employeeId: 'e-clean',
        employeeCode: 'EMP-001',
        employeeName: 'Clean Row',
        branchId: 'br-a',
        employeeSsf: 100,
        employerSsf: 200,
        controlBalance: 300,
      },
      {
        employeeId: 'e-gap',
        employeeCode: 'EMP-002',
        employeeName: 'Gap Row',
        branchId: 'br-a',
        employeeSsf: 110,
        employerSsf: 200,
        controlBalance: 0,
      },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].employeeCode, 'EMP-002', 'the gap must lead the list');
    assert.equal(rows[0].payable, 310);
    assert.equal(rows[0].difference, -310);
    assert.equal(rows[0].matches, false);
    assert.equal(rows[1].difference, 0);
    assert.equal(rows[1].matches, true);
  });

  test('the rows plus the unattributed remainder add back to the account difference', () => {
    const result = buildSsfReconciliation(
      { ...MATCHED, controlBalance: 900 },
      [
        {
          employeeId: 'e-1',
          employeeCode: 'EMP-001',
          employeeSsf: 286,
          employerSsf: 520,
          configuredEmployeeSsf: 286,
          configuredEmployerSsf: 520,
          controlBalance: 806,
        },
      ]
    );
    assert.equal(result.difference, 94);
    assert.equal(result.byEmployee[0].difference, 0);
    assert.equal(result.unattributedControl, 94);
    assert.equal(
      result.byEmployee.reduce((sum, row) => sum + row.difference, 0) + Number(result.unattributedControl),
      result.difference
    );
  });

  test('an unmapped control account leaves the employee control side null-free', () => {
    const result = buildSsfReconciliation(
      { ...MATCHED, controlAccountCode: null, controlBalance: null },
      [{ employeeId: 'e-1', employeeCode: 'EMP-001', employeeSsf: 100, employerSsf: 200 }]
    );
    assert.equal(result.matches, null);
    assert.equal(result.unattributedControl, null);
    assert.equal(result.byEmployee[0].payable, 300);
    assert.equal(result.byEmployee[0].difference, -300);
    assert.equal(result.byEmployee[0].matches, false);
  });

  test('an unmapped control account is null, not a false reconciliation', () => {
    const result = buildSsfReconciliation({
      ...MATCHED,
      controlAccountCode: null,
      controlAccountName: null,
      controlBalance: 0,
    });
    assert.equal(result.controlAccount, null);
    assert.equal(result.controlBalance, null);
    assert.equal(result.difference, null);
    assert.equal(result.matches, null);
    assert.match(String(result.reason), /no SSF_PAYABLE posting default/);
  });
});
