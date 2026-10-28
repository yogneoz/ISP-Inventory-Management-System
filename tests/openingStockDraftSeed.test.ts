/**
 * Fiscal-year opening stock — a draft seeds its untouched fields from the row.
 *
 * Editing a cell used to create a draft with the other two fields as empty
 * strings. The inputs then rendered blank (they follow the draft once the row
 * is marked changed), the amber "old → new" hint read the blank as 0, and Save
 * failed validation on fields the operator never touched — "Damaged quantity
 * must be a whole number" after a quantity-only edit. The draft now starts from
 * the row's own values and applies the edit on top.
 *
 * PROVES:
 *   1. Editing quantity alone leaves damaged and unit cost showing the row's
 *      values, and the save payload carries them.
 *   2. Editing unit cost alone likewise keeps quantity and damaged.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { OpeningStockManager } from '../client/src/features/finance/OpeningStockManager';
import { api } from '../client/src/services/api';

const branches = [{ id: 'br-a', code: 'BRA', name: 'Branch A', location: 'L' }] as any[];

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

const user = {
  id: 'u-branch',
  email: 'branch@example.com',
  name: 'Branch Manager',
  role: 'INVENTORY_MANAGER',
  branchId: 'br-a',
  allowedBranchIds: ['br-a'],
} as any;

const row = {
  id: 'r-a',
  productId: 'p1',
  productName: 'Router',
  productSku: 'RTR-1',
  branchId: 'br-a',
  branchName: 'Branch A',
  quantityOnHand: 5,
  damagedQty: 2,
  unitCost: 10,
  sourceType: 'FISCAL_CLOSE',
  sourceReference: null,
  postedAt: null,
  postedBy: null,
  liveQty: 5,
  liveDamagedQty: 2,
};

const payload = {
  fiscalYear: fiscalYears[0],
  rows: [row],
  stats: { totalRows: 1, manualAdjustments: 0, zeroQtyRows: 0, totalUnits: 5, totalValue: 50 },
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

describe('opening-stock draft seeding', () => {
  const real = {
    getOpening: api.getFiscalYearOpeningStock,
    adjustOpening: api.adjustFiscalYearOpeningStock,
  };

  afterEach(() => {
    api.getFiscalYearOpeningStock = real.getOpening;
    api.adjustFiscalYearOpeningStock = real.adjustOpening;
  });

  const mountScreen = async (submitted: any[]) => {
    api.getFiscalYearOpeningStock = async () => payload as any;
    api.adjustFiscalYearOpeningStock = async (_id: string, rows: any[]) => {
      submitted.push(...rows);
      return { applied: rows.length, created: 0, message: 'saved' };
    };
    const tree = mountTree(
      createElement(OpeningStockManager, {
        currentUser: user,
        fiscalYears,
        branches,
        products,
      } as any)
    );
    await settle();
    const inputs = [...tree.container.querySelectorAll('tbody input[type="number"]')] as HTMLInputElement[];
    assert.equal(inputs.length, 3, 'the row renders qty, damaged and cost inputs');
    return { tree, inputs };
  };

  const save = async (container: HTMLElement) => {
    const button = findButton(container, /^Save \d+ Adjustment/);
    assert.ok(button, 'a changed row exposes Save');
    inAct(() => button!.click());
    await settle();
  };

  test('editing quantity alone keeps damaged and unit cost on screen and in the payload', async () => {
    const submitted: any[] = [];
    const { tree, inputs } = await mountScreen(submitted);
    try {
      setNumberInput(inputs[0], '9');

      assert.equal(inputs[1].value, '2', 'damaged quantity must keep its row value');
      assert.equal(inputs[2].value, '10', 'unit cost must keep its row value');

      await save(tree.container);

      assert.deepEqual(
        submitted.map((r) => ({ quantityOnHand: r.quantityOnHand, damagedQty: r.damagedQty, unitCost: r.unitCost })),
        [{ quantityOnHand: 9, damagedQty: 2, unitCost: 10 }],
        'the untouched fields travel with the edit instead of as empty strings'
      );
      assert.doesNotMatch(
        tree.container.textContent || '',
        /must be a whole number/,
        'validation must not fail on a field the operator did not edit'
      );
    } finally {
      tree.unmount();
    }
  });

  test('editing unit cost alone keeps quantity and damaged in the payload', async () => {
    const submitted: any[] = [];
    const { tree, inputs } = await mountScreen(submitted);
    try {
      setNumberInput(inputs[2], '12.5');

      assert.equal(inputs[0].value, '5', 'quantity must keep its row value');
      assert.equal(inputs[1].value, '2', 'damaged quantity must keep its row value');

      await save(tree.container);

      assert.deepEqual(
        submitted.map((r) => ({ quantityOnHand: r.quantityOnHand, damagedQty: r.damagedQty, unitCost: r.unitCost })),
        [{ quantityOnHand: 5, damagedQty: 2, unitCost: 12.5 }]
      );
    } finally {
      tree.unmount();
    }
  });
});
