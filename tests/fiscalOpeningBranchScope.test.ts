/**
 * Fiscal opening registers — the client offers and submits only branches the
 * signed-in account is scoped to.
 *
 * The server's branch registry refuses records outside the actor's branches
 * (AUTHZ-1/12/13 in tests/authorization.audit.test.ts), but both fiscal screens
 * used to build their branch pickers from every branch in bootstrap. A branch
 * Inventory Manager was therefore offered branches whose writes the server
 * would reject — and an older payload/cache could even put another branch's row
 * on screen and into a save.
 *
 * PROVES:
 *   1. `getScopedBranches` mirrors the server: Super Admin / Head Office Admin /
 *      `branchId: 'ALL'` are global, everyone else is branchId + allowedBranchIds
 *      (an INVENTORY_MANAGER with one branch is NOT global).
 *   2. OpeningStockManager's filter and add-row pickers list only the account's
 *      branches, its table hides foreign rows, and Save submits only scoped rows
 *      even when the payload contains one from another branch.
 *   3. VendorOpeningBalances behaves the same for its filter and Save.
 *   4. An HQ-wide account still sees everything — the scoping is not over-blocking.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { OpeningStockManager } from '../client/src/features/finance/OpeningStockManager';
import { VendorOpeningBalances } from '../client/src/features/finance/VendorOpeningBalances';
import { api } from '../client/src/services/api';
import { getScopedBranches } from '../client/src/utils/permissions';

const branches = [
  { id: 'br-a', code: 'BRA', name: 'Branch A', location: 'L' },
  { id: 'br-b', code: 'BRB', name: 'Branch B', location: 'L' },
] as any[];

const fiscalYears = [
  {
    id: 'fy-1',
    code: '2083/84',
    startDateAD: '2026-07-16',
    endDateAD: '2027-07-15',
    startDateBS: '2083-04-01',
    endDateBS: '2084-03-31',
    isCurrent: true,
    isClosed: false,
  },
] as any[];

const products = [{ id: 'p1', name: 'Router', sku: 'RTR-1' }] as any[];

const branchUser = (over: Record<string, unknown> = {}) => ({
  id: 'u-branch',
  email: 'branch@example.com',
  name: 'Branch Manager',
  role: 'INVENTORY_MANAGER',
  branchId: 'br-a',
  allowedBranchIds: ['br-a'],
  ...over,
} as any);

const hqUser = branchUser({ id: 'u-hq', email: 'hq@example.com', branchId: 'ALL', allowedBranchIds: [] });

const openingRow = (id: string, branchId: string, branchName: string, quantityOnHand: number) => ({
  id,
  productId: 'p1',
  productName: 'Router',
  productSku: 'RTR-1',
  branchId,
  branchName,
  quantityOnHand,
  damagedQty: 0,
  unitCost: 10,
  sourceType: 'FISCAL_CLOSE',
  sourceReference: null,
  postedAt: null,
  postedBy: null,
  liveQty: quantityOnHand,
  liveDamagedQty: 0,
});

const vendorRow = (id: string, branchId: string, branchName: string, openingBalance: number) => ({
  id,
  supplierId: 'sup-1',
  supplierName: 'Supplier One',
  supplierCode: 'SUP-1',
  branchId,
  branchName,
  openingBalance,
  sourceType: 'FISCAL_CLOSE',
  sourceReference: null,
  postedAt: null,
  postedBy: null,
});

const openingPayload = {
  fiscalYear: fiscalYears[0],
  rows: [openingRow('r-a', 'br-a', 'Branch A', 5), openingRow('r-b', 'br-b', 'Branch B', 7)],
  stats: { totalRows: 2, manualAdjustments: 0, zeroQtyRows: 0, totalUnits: 12, totalValue: 120 },
};

const vendorPayload = {
  fiscalYear: fiscalYears[0],
  rows: [vendorRow('v-a', 'br-a', 'Branch A', 100), vendorRow('v-b', 'br-b', 'Branch B', 200)],
  stats: { totalRows: 2, manualAdjustments: 0, zeroRows: 0, totalDebitOpening: 300, totalCreditOpening: 0 },
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** React's controlled-input change, via the native setter the tracker watches. */
function setNumberInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function findButton(container: HTMLElement, pattern: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    pattern.test((button.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
}

/** Option values across every select currently rendered (filter + add form). */
function optionValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll('option')].map((option) => option.getAttribute('value') || '');
}

describe('fiscal opening registers — branch scope', () => {
  const real = {
    getOpening: api.getFiscalYearOpeningStock,
    adjustOpening: api.adjustFiscalYearOpeningStock,
    getVendor: api.getVendorOpeningBalances,
    adjustVendor: api.adjustVendorOpeningBalances,
  };

  afterEach(() => {
    api.getFiscalYearOpeningStock = real.getOpening;
    api.adjustFiscalYearOpeningStock = real.adjustOpening;
    api.getVendorOpeningBalances = real.getVendor;
    api.adjustVendorOpeningBalances = real.adjustVendor;
  });

  test('getScopedBranches mirrors the server: only ALL/HQ roles are global', () => {
    assert.deepEqual(getScopedBranches(branchUser(), branches).map((b) => b.id), ['br-a']);
    assert.deepEqual(
      getScopedBranches(branchUser({ allowedBranchIds: ['br-a', 'br-b'] }), branches).map((b) => b.id),
      ['br-a', 'br-b']
    );
    assert.deepEqual(getScopedBranches(hqUser, branches).map((b) => b.id), ['br-a', 'br-b']);
    assert.deepEqual(
      getScopedBranches(branchUser({ role: 'HEAD_OFFICE_ADMIN', branchId: 'br-a', allowedBranchIds: [] }), branches).map((b) => b.id),
      ['br-a', 'br-b']
    );
    assert.deepEqual(getScopedBranches(null, branches), []);
  });

  test('OpeningStockManager offers only scoped branches and submits only scoped rows', async () => {
    const submitted: any[] = [];
    api.getFiscalYearOpeningStock = async () => openingPayload as any;
    api.adjustFiscalYearOpeningStock = async (_id: string, rows: any[]) => {
      submitted.push(...rows);
      return { applied: rows.length, created: 0, message: 'saved' };
    };

    const tree = mountTree(
      createElement(OpeningStockManager, {
        currentUser: branchUser(),
        fiscalYears,
        branches,
        products,
      } as any)
    );
    try {
      await settle();

      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a'), 'the account’s own branch is offered');
      assert.ok(!values.includes('br-b'), 'another branch must not be offered in the filter');
      assert.ok(!(tree.container.textContent || '').includes('Branch B'), 'another branch’s row must not render');

      const addRow = findButton(tree.container, /^Add Row$/);
      assert.ok(addRow, 'an editable register exposes Add Row');
      inAct(() => addRow!.click());
      assert.ok(
        !optionValues(tree.container).includes('br-b'),
        'the add-row branch picker must not offer another branch either'
      );

      const rowInputs = [...tree.container.querySelectorAll('tbody input[type="number"]')] as HTMLInputElement[];
      assert.equal(rowInputs.length, 3, 'the own-branch row renders qty, damaged and cost inputs');
      setNumberInput(rowInputs[0], '9');
      setNumberInput(rowInputs[1], '0');
      setNumberInput(rowInputs[2], '10');

      const save = findButton(tree.container, /^Save \d+ Adjustment/);
      assert.ok(save, 'a changed scoped row exposes Save');
      inAct(() => save!.click());
      await settle();

      assert.equal(submitted.length, 1, 'only the changed scoped row is submitted');
      assert.deepEqual(
        submitted.map((row) => ({ branchId: row.branchId, quantityOnHand: row.quantityOnHand })),
        [{ branchId: 'br-a', quantityOnHand: 9 }],
        'the payload never carries the foreign-branch row that was in the response'
      );
    } finally {
      tree.unmount();
    }
  });

  test('OpeningStockManager offers every branch to an HQ-wide account', async () => {
    api.getFiscalYearOpeningStock = async () => openingPayload as any;

    const tree = mountTree(
      createElement(OpeningStockManager, {
        currentUser: hqUser,
        fiscalYears,
        branches,
        products,
      } as any)
    );
    try {
      await settle();
      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a') && values.includes('br-b'), 'HQ offers both branches');
      assert.match(tree.container.textContent || '', /Branch B/, 'HQ sees both branches’ rows');
    } finally {
      tree.unmount();
    }
  });

  test('VendorOpeningBalances offers only scoped branches and submits only scoped rows', async () => {
    const submitted: any[] = [];
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.adjustVendorOpeningBalances = async (_id: string, rows: any[]) => {
      submitted.push(...rows);
      return { applied: rows.length, created: 0, message: 'saved' };
    };

    const tree = mountTree(
      createElement(VendorOpeningBalances, {
        currentUser: branchUser(),
        fiscalYears,
        branches,
      } as any)
    );
    try {
      await settle();

      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a'), 'the account’s own branch is offered');
      assert.ok(!values.includes('br-b'), 'another branch must not be offered');
      assert.ok(!(tree.container.textContent || '').includes('Branch B'), 'another branch’s row must not render');

      const balanceInput = tree.container.querySelector('input[type="number"]') as HTMLInputElement | null;
      assert.ok(balanceInput, 'the own-branch row renders an editable balance');
      setNumberInput(balanceInput!, '150');

      const save = findButton(tree.container, /^Save \d+ Adjustment/);
      assert.ok(save, 'a changed scoped row exposes Save');
      inAct(() => save!.click());
      await settle();

      assert.deepEqual(
        submitted.map((row) => ({ branchId: row.branchId, openingBalance: row.openingBalance })),
        [{ branchId: 'br-a', openingBalance: 150 }],
        'the payload never carries the foreign-branch row that was in the response'
      );
    } finally {
      tree.unmount();
    }
  });
});
