/**
 * Equipment custody screen — the branch-wide "who holds what" board.
 *
 * The screen must show the holdings the server returns, issue and transfer
 * through the existing employee-stock routes, and — the point of the pass —
 * show a refusal as the readable message the server writes, with the
 * cross-branch code and its return-then-issue remedy, instead of a crash or a
 * silent no-op.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { mountTree } from './harness/mount';
import { EquipmentCustody } from '../client/src/features/inventory/EquipmentCustody';
import { api } from '../client/src/services/api';

const user = {
  id: 'cst-ui-manager',
  email: 'cst-ui@example.com',
  name: 'Custody Manager',
  role: 'BRANCH_MANAGER',
  branchId: 'b1',
} as any;

const HOLDINGS = [
  {
    employee_id: 'e1',
    employee_code: 'EMP-1',
    employee_name: 'Asha Rai',
    product_id: 'p1',
    product_code: 'SKU-1',
    product_name: 'Fiber router',
    branch_id: 'b1',
    branch_name: 'Kathmandu',
    quantity: 4,
    updated_at: '2026-11-20T10:00:00.000Z',
  },
];

const ROSTER = [
  { id: 'e1', employee_code: 'EMP-1', name: 'Asha Rai', department: 'Field', branch_id: 'b1' },
  { id: 'e2', employee_code: 'EMP-2', name: 'Bikash Thapa', department: 'Field', branch_id: 'b1' },
];

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const clickButton = (root: HTMLElement, text: string) => {
  const button = [...root.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  assert.ok(button, `expected a "${text}" button`);
  act(() => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

const chooseOption = (root: HTMLElement, labelText: string, value: string) => {
  const label = [...root.querySelectorAll('label')].find((el) =>
    el.textContent?.trim().startsWith(labelText)
  );
  const select = label?.querySelector('select');
  assert.ok(select, `expected a "${labelText}" select`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};

const typeInto = (root: HTMLElement, placeholder: string, value: string) => {
  const input = root.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(input, `expected an input with placeholder "${placeholder}"`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};

describe('equipment custody screen', () => {
  let mounted: ReturnType<typeof mountTree> | null = null;
  const real = {
    holdings: api.getEmployeeStockHoldings,
    roster: api.getCustodyEmployees,
    transfer: api.transferEmployeeStock,
    issue: api.recordEmployeeStockMovement,
  };

  beforeEach(() => {
    api.getEmployeeStockHoldings = (async () => HOLDINGS) as any;
    api.getCustodyEmployees = (async () => ROSTER) as any;
    api.transferEmployeeStock = (async () => ({ transferGroupId: 'g1', from: {}, to: {} })) as any;
    api.recordEmployeeStockMovement = (async () => ({}) ) as any;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    api.getEmployeeStockHoldings = real.holdings;
    api.getCustodyEmployees = real.roster;
    api.transferEmployeeStock = real.transfer;
    api.recordEmployeeStockMovement = real.issue;
  });

  test('shows who holds what across the branch', async () => {
    mounted = mountTree(createElement(EquipmentCustody, { currentUser: user, selectedBranchId: 'b1' }));
    await settle();
    const text = mounted.container.textContent || '';
    assert.match(text, /Asha Rai/);
    assert.match(text, /Fiber router/);
    assert.match(text, /Kathmandu/);
    assert.match(text, /EMP-1/);
    assert.match(text, /Who holds what/);
  });

  test('the cross-branch refusal is shown with its code and remedy, not swallowed', async () => {
    api.transferEmployeeStock = (async () => {
      const error: any = new Error(
        'Custody cannot cross branches in one step: return the units to the source branch, then issue them from the receiving branch.'
      );
      error.status = 409;
      error.body = { code: 'CROSS_BRANCH_TRANSFER', message: error.message };
      throw error;
    }) as any;

    mounted = mountTree(createElement(EquipmentCustody, { currentUser: user, selectedBranchId: 'b1' }));
    await settle();

    chooseOption(mounted.container, 'From holder', 'e1');
    chooseOption(mounted.container, 'To receiver', 'e2');
    chooseOption(mounted.container, 'Product to move', 'p1');
    typeInto(mounted.container, 'Why custody moves', 'van rebalance');
    clickButton(mounted.container, 'Transfer units');
    await settle();

    const alert = mounted.container.querySelector('[role="alert"]');
    assert.ok(alert, 'the refusal must surface as an alert');
    const text = alert.textContent || '';
    assert.match(text, /CROSS_BRANCH_TRANSFER/);
    assert.match(text, /return the units to the source branch/);
    assert.match(text, /Return the units to the branch that holds them/);
  });

  test('a transfer that stays inside the branch confirms what moved, to whom', async () => {
    const calls: any[] = [];
    api.transferEmployeeStock = (async (input: any) => {
      calls.push(input);
      return { transferGroupId: 'g1', from: {}, to: {} };
    }) as any;

    mounted = mountTree(createElement(EquipmentCustody, { currentUser: user, selectedBranchId: 'b1' }));
    await settle();

    chooseOption(mounted.container, 'From holder', 'e1');
    chooseOption(mounted.container, 'To receiver', 'e2');
    chooseOption(mounted.container, 'Product to move', 'p1');
    typeInto(mounted.container, 'Why custody moves', 'van rebalance');
    clickButton(mounted.container, 'Transfer units');
    await settle();

    assert.equal(calls.length, 1);
    assert.deepEqual(
      {
        fromEmployeeId: calls[0].fromEmployeeId,
        toEmployeeId: calls[0].toEmployeeId,
        productId: calls[0].productId,
        reason: calls[0].reason,
      },
      { fromEmployeeId: 'e1', toEmployeeId: 'e2', productId: 'p1', reason: 'van rebalance' }
    );
    const status = mounted.container.querySelector('[role="status"]');
    assert.ok(status, 'a stored movement must confirm itself');
    assert.match(status.textContent || '', /Transferred 1 unit from Asha Rai \(EMP-1\) to Bikash Thapa \(EMP-2\)/);
  });
});
