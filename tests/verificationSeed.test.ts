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
  TARGETS,
  buildVerificationDataset,
  checkDatasetInvariants,
} from '../scripts/seed/verificationDataset';

const dataset = buildVerificationDataset();

describe('verification dataset', () => {
  test('satisfies every rule the seeder asserts at run time', () => {
    assert.deepEqual(checkDatasetInvariants(dataset), []);
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

    assert.equal(balance('1100'), TARGETS.accountsReceivable);
    assert.equal(-balance('2100'), TARGETS.accountsPayable);
    assert.equal(balance('1200'), TARGETS.inventory);
    assert.equal(balance('1010') + balance('1020'), TARGETS.cashAndBank);
    assert.equal(-balance('3010'), TARGETS.equity);
    assert.equal(balance('1520'), TARGETS.fixedAssets);
    assert.equal(balance('1400'), TARGETS.prepaid);

    // Assets = liabilities + equity + current-year result.
    const assets =
      balance('1100') + balance('1200') + balance('1010') + balance('1020') + balance('1400') + balance('1520');
    const liabilities = -balance('2100');
    const equity = -balance('3010');
    const result = -(balance('4000') + balance('4020') + balance('5000') + balance('6100') + balance('6400'));
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
