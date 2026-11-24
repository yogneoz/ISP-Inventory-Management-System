/**
 * Verification dataset guards (scripts/seed/verificationDataset.ts).
 *
 * The seeder writes figures the whole app can be checked against, so the
 * numbers must be right BEFORE they reach PostgreSQL. These assertions are the
 * ones a reviewer would make by hand: exactly two fiscal years, four branches
 * with 20 customers each, 5 pieces of every stocked product at a cost under
 * 100, service items with no stock at all, a balanced trial balance per branch,
 * and the brief's AR/AP/inventory/cash/equity targets.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COST_CENTER_BY_EXPENSE_ACCOUNT,
  TARGETS,
  buildVerificationDataset,
  checkDatasetInvariants,
} from '../scripts/seed/verificationDataset';
import { buildDemoModuleFixtures } from '../scripts/seed/demoModuleFixtures';

const dataset = buildVerificationDataset();

describe('verification dataset', () => {
  test('satisfies every rule the seeder asserts at run time', () => {
    assert.deepEqual(checkDatasetInvariants(dataset), []);

    const modules = buildDemoModuleFixtures(dataset);
    assert.equal(modules.finance.budgets.length, 4, 'one budget per branch');
    assert.equal(modules.finance.budgetLines.length, 144, '12 periods x 3 accounts x 4 branches');
    assert.equal(modules.finance.allocationProfiles.length, 4, 'one allocation profile per branch');
    assert.equal(modules.finance.allocationLines.length, 20, 'five cost centres in each branch profile');
    for (const branch of dataset.branches) {
      const branchLines = modules.finance.budgetLines.filter(
        (line) => line.budget_id === `demo-budget-${branch.code.toLowerCase()}-2083`
      );
      assert.equal(branchLines.length, 36);
      assert.equal(
        branchLines.reduce((sum, line) => sum + Number(line.amount), 0),
        3_960_000,
        `${branch.code} demo budget must total 3,960,000`
      );
      const profile = modules.finance.allocationProfiles.find(
        (row) => row.branch_id === branch.id
      );
      assert.ok(profile, `${branch.code} must have an allocation profile`);
      const ruleLines = modules.finance.allocationLines.filter(
        (line) => line.profile_id === profile.id
      );
      assert.equal(ruleLines.length, 5, `${branch.code} must allocate all five demo centres`);
      assert.equal(
        ruleLines.reduce((sum, line) => sum + Number(line.percentage_bp), 0),
        10_000,
        `${branch.code} demo allocation must total exactly 100.00%`
      );
    }
    assert.equal(modules.finance.openingStock.length, 80, '5 opening units for every stocked product/branch');
    assert.ok(modules.operations.customerDevices.length > 0);
    assert.ok(modules.operations.warranties.length > 0);
    assert.ok(modules.operations.damage.length > 0);
    assert.ok(modules.operations.purchaseOrders.length > 0);
    assert.ok(modules.operations.shipments.length > 0);
    // 6 payroll/attendance demo employees (the auditor now holds one too) + 14
    // chart-only employees that hold the refactored designations.
    assert.equal(modules.hr.employees.length, 20);
    assert.equal(modules.hr.attendance.length, 10);
    // One payslip per demo account that has an employee record — including the
    // auditor, whose payslip rides the posted Kathmandu run rather than a second
    // cycle of its own.
    assert.equal(modules.hr.payrollLines.length, 9);
    const payrollDebit = modules.hr.journalLines.reduce((sum, line) => sum + Number(line.debit), 0);
    const payrollCredit = modules.hr.journalLines.reduce((sum, line) => sum + Number(line.credit), 0);
    assert.equal(payrollDebit, 744_000, 'demo payroll journal debits');
    assert.equal(payrollCredit, 744_000, 'demo payroll journals must balance');
    // One posted cycle per payroll branch, each carrying its own employees.
    assert.equal(modules.hr.payrollRuns.length, 4);
    for (const run of modules.hr.payrollRuns) {
      const lines = modules.hr.payrollLines.filter((line) => line.run_id === run.id);
      assert.ok(lines.length > 0, `${run.run_no} must carry a payslip`);
      assert.equal(
        lines.reduce((sum, line) => sum + Number(line.net_amount), 0),
        Number(run.net_total),
        `${run.run_no} line nets must equal the posted run total`
      );
      assert.equal(
        lines.reduce((sum, line) => sum + Number(line.gross_amount), 0),
        Number(run.gross_total),
        `${run.run_no} line gross must equal the posted run total`
      );
    }
    // The salary expense leg must carry its cost centre or the branch's
    // department preview reports payroll as untagged actuals.
    const payrollSalary = modules.hr.journalLines.find((line: any) => line.account_id === 'gla-7110');
    assert.equal(payrollSalary?.cost_center_id, 'cc-demo-ops', 'the payroll salary line must stay tagged');
    assert.equal(
      modules.hr.journalLines.filter((line: any) => line.debit > 0 && !line.cost_center_id).length,
      0,
      'every demo payroll expense leg must be tagged'
    );
    assert.equal(
      modules.hr.payrollLines.reduce((sum, line) => sum + Number(line.net_amount), 0),
      modules.hr.payrollRuns.reduce((sum, run) => sum + Number(run.net_total), 0),
      'run line nets must equal every posted run total'
    );
    // Three, not two: the verification seed also carries the deliberate
    // "Demo Branch Finance Read" set that widens a Branch Manager (see
    // scripts/seed/demoPermissionFixtures.ts and tests/demoPermissionFixtures.test.ts).
    assert.equal(modules.permissions.sets.length, 3);
    assert.ok(modules.permissions.matrix.length > 0);
  });

  test('tags every demo expense line deterministically and leaves other lines untagged', () => {
    const expenseLines = dataset.journalLines.filter(
      (line) => COST_CENTER_BY_EXPENSE_ACCOUNT[line.accountCode]
    );
    assert.ok(expenseLines.length > 0, 'the demo ledger must contain expense lines');
    for (const line of expenseLines) {
      assert.equal(
        line.costCenterId,
        COST_CENTER_BY_EXPENSE_ACCOUNT[line.accountCode],
        `${line.accountCode} line ${line.id} must carry its deterministic cost centre`
      );
    }
    assert.equal(
      dataset.journalLines.filter(
        (line) => !COST_CENTER_BY_EXPENSE_ACCOUNT[line.accountCode] && line.costCenterId
      ).length,
      0,
      'non-expense lines must not be tagged by the demo seed'
    );
  });

  test('has the requested masters: two fiscal years, four branches, 20 customers each', () => {
    assert.equal(dataset.fiscalYears.length, 2);
    assert.deepEqual(dataset.fiscalYears.map((fy) => fy.code), ['2082-83', '2083-84']);
    assert.equal(dataset.fiscalYears.filter((fy) => fy.isCurrent).length, 1);

    assert.equal(dataset.branches.length, 4);
    for (const branch of dataset.branches) {
      assert.equal(
        dataset.customers.filter((c) => c.branchId === branch.id).length,
        20,
        `${branch.code} must have exactly 20 customers`
      );
    }
    assert.equal(dataset.customers.length, 80);

    assert.deepEqual(
      dataset.costCenters.map((center) => [center.code, center.name]),
      [
        ['CC-01-EXEC', 'Executive Management'],
        ['CC-02-FIN', 'Finance & Administration'],
        ['CC-03-OPS', 'Operations & Network Engineering'],
        ['CC-04-COMM', 'Commercial & Business Development'],
        ['CC-05-CX', 'Customer Experience & Support'],
      ],
      'the five demo departments must be global cost centres in display order'
    );
    assert.ok(
      dataset.costCenters.every(
        (center) => center.branchId === null && center.active && center.isDemo
      ),
      'demo cost centres must be active, global and removable as demo data'
    );
  });

  test('stocks 5 pcs of every stock product below 100 and no service item', () => {
    const serviceIds = new Set(dataset.products.filter((p) => p.productGroup === 'Service Item').map((p) => p.id));
    assert.ok(serviceIds.size >= 2, 'the Service Item group must carry products');
    assert.deepEqual(
      [...serviceIds].sort(),
      ['prd-svc-150', 'prd-svc-200', 'prd-svc-80', 'prd-svc-router', 'prd-svc-static'],
      'the Service Item group must carry the Unlimited plans and add-ons'
    );
    assert.ok(dataset.products.some((p) => p.name === 'Unlimited 80Mbps'));
    assert.ok(dataset.products.some((p) => p.name === 'Unlimited 150Mbps'));

    for (const branch of dataset.branches) {
      const rows = dataset.inventoryStock.filter((s) => s.branchId === branch.id);
      assert.equal(rows.length, 20, `${branch.code}: one stock row per stocked product`);
      for (const row of rows) {
        assert.equal(row.quantityOnHand, TARGETS.piecesPerProductPerBranch);
        assert.ok(row.averageCost < TARGETS.maxUnitCost, `${row.productId}: cost must stay below 100`);
        assert.ok(!serviceIds.has(row.productId), `${branch.code}: a service item must never hold stock`);
      }
    }
  });

  test('the ledger lands on the accounting verification targets', () => {
    const balance = (code: string) =>
      dataset.journalLines
        .filter((line) => line.accountCode === code)
        .reduce((sum, line) => sum + (line.debit || 0) - (line.credit || 0), 0);

    assert.equal(balance('2110'), TARGETS.accountsReceivable);
    assert.equal(-balance('5010'), TARGETS.accountsPayable);
    assert.equal(balance('2030'), TARGETS.inventory);
    assert.equal(balance('2310') + balance('2320'), TARGETS.cashAndBank);
    assert.equal(-balance('3010'), TARGETS.equity);
    assert.equal(balance('1000'), TARGETS.fixedAssets);
    assert.equal(balance('2150'), TARGETS.prepaid);

    // Assets = liabilities + equity + current-year result.
    const assets =
      balance('2110') + balance('2030') + balance('2310') + balance('2320') + balance('2150') +
      balance('1000') + balance('2140');
    const liabilities = -balance('5010');
    const equity = -balance('3010');
    const result = -(balance('6010') + balance('6030') + balance('7000') + balance('7300') + balance('7110'));
    assert.equal(assets, liabilities + equity + result, 'the balance sheet must balance');
  });

  test('both fiscal years carry documents, and no date falls outside them', () => {
    const inYear = (date: string, fy: (typeof dataset.fiscalYears)[number]) =>
      date >= fy.startDateAD && date <= fy.endDateAD;
    const [fy1, fy2] = dataset.fiscalYears;
    const sales = dataset.salesInvoices;

    assert.ok(sales.some((inv) => inYear(inv.invoiceDateAD, fy1)), '2082-83 needs sales');
    assert.ok(sales.some((inv) => inYear(inv.invoiceDateAD, fy2)), '2083-84 needs sales');
    assert.equal(
      dataset.salesInvoices.filter((inv) => !dataset.fiscalYears.some((fy) => inYear(inv.invoiceDateAD, fy))).length,
      0,
      'every invoice date must fall inside one of the two fiscal years'
    );
    assert.equal(
      dataset.purchaseInvoices.filter((inv) => !dataset.fiscalYears.some((fy) => inYear(inv.invoiceDateAD, fy))).length,
      0,
      'every purchase date must fall inside one of the two fiscal years'
    );

    // Serials back the stock: 7 purchased per serial product per branch.
    const serialProducts = dataset.products.filter((p) => p.requiresSerialTracking);
    assert.equal(dataset.serialLogs.length, serialProducts.length * 7 * dataset.branches.length);
    assert.equal(dataset.serialLogs.filter((s) => s.status === 'SOLD').length, serialProducts.length * 2 * dataset.branches.length);
  });
});
