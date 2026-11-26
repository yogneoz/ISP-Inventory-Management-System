/**
 * Assign Fixed Asset — a refused dispatch is the server's answer, shown.
 *
 * The dispatch PATCH now refuses a technician or a visit from another branch
 * ("That technician is not in the branch that holds this asset."). The panel
 * used to await the PATCH with no error branch at all: the rejection escaped
 * the submit handler, so a refusal was an unhandled promise rejection — no
 * message, and nothing on screen said the unit had not moved. The panel now
 * names the refused line, shows the server's own message and re-reads the
 * register, while a legitimate in-branch dispatch still confirms itself.
 *
 * PROVES:
 *   1. A refused dispatch shows "Deployment stopped at ..." plus the server's
 *      message, never "Deployment complete", and keeps the bin line visible.
 *   2. The screen is re-read after the refusal, so the register shows what
 *      really committed instead of a stale assignment.
 *   3. A dispatch the server accepts still confirms and clears the bin.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement, useMemo } from 'react';
import { mountTree, type MountedTree } from './harness/mount';
import { DialogProvider, useDialog } from '../client/src/components/common/DialogProvider';
import { StockOperationsProvider } from '../client/src/features/inventory/stockops/StockOperationsContext';
import { AssignAssetPanel } from '../client/src/features/inventory/stockops/AssignAssetPanel';
import { api } from '../client/src/services/api';

const IDLE_ASSET = {
  id: 'asset-idle',
  tagNumber: 'FA-20',
  name: 'Idle Unit',
  category: 'Equipment',
  branchId: 'b1',
  status: 'ACTIVE',
  acquisitionCost: 1000,
  depreciationRatePercent: 15,
} as any;

const IN_BRANCH_TECH = { id: 'emp-in', name: 'Asha Rai', employee_code: 'EMP-1' };
const OTHER_BRANCH_TECH = { id: 'emp-out', name: 'Bikash Thapa', employee_code: 'EMP-9' };
// The panel only offers a visit to the technician it is already assigned to,
// so each technician gets its own live visit.
const WORK_ORDERS = [
  {
    id: 'wo-in',
    work_order_no: 'WO-1',
    customer_name: 'Sita Sharma',
    scheduled_date_ad: '2026-11-26',
    status: 'ASSIGNED',
    technician_id: 'emp-in',
  },
  {
    id: 'wo-out',
    work_order_no: 'WO-9',
    customer_name: 'Ram Karki',
    scheduled_date_ad: '2026-11-26',
    status: 'ASSIGNED',
    technician_id: 'emp-out',
  },
];

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const findButton = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((el) => (el.textContent || '').includes(text)) as
    | HTMLButtonElement
    | undefined;

const clickButton = (root: HTMLElement, text: string) => {
  const button = findButton(root, text);
  assert.ok(button, `expected a "${text}" button`);
  act(() => {
    button!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

const chooseOption = (root: HTMLElement, labelText: string, value: string) => {
  const label = [...root.querySelectorAll('label')].find((el) =>
    (el.textContent || '').trim().startsWith(labelText)
  );
  // The panel renders each label beside its select (not wrapped around it).
  const select = (label?.querySelector('select') ||
    label?.parentElement?.querySelector('select')) as HTMLSelectElement | null | undefined;
  assert.ok(select, `expected a "${labelText}" select`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select!, value);
    select!.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};

/** Put the ledger unit in the bin as a technician dispatch to `tech` / `order`. */
const fillDispatchLine = async (root: HTMLElement, techId: string, orderId: string) => {
  const search = root.querySelector('#assign-product-search-input') as HTMLInputElement | null;
  assert.ok(search, 'the panel must offer the asset search');
  act(() => search!.focus());
  await settle();
  clickButton(root, '+ Add to bin');
  await settle();
  chooseOption(root, 'Deploy To', 'EMPLOYEE');
  await settle();
  chooseOption(root, 'Technician', techId);
  await settle();
  chooseOption(root, 'Work order', orderId);
  await settle();
};

const submit = async (root: HTMLElement) => {
  const form = root.querySelector('form');
  assert.ok(form, 'the deployment form must render');
  act(() => {
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
};

interface HarnessProps {
  onUpdateAssetStatus: (id: string, body: any) => Promise<any>;
  onRefreshData: () => Promise<void>;
}

const Harness: React.FC<HarnessProps> = ({ onUpdateAssetStatus, onRefreshData }) => {
  const { alert } = useDialog();
  const ctx = useMemo(
    () => ({
      activeTab: 'ASSIGN_ASSET',
      allowedBranches: [{ id: 'b1', code: 'B1', name: 'Main Branch' }],
      alertDialog: alert,
      availableAssetsError: '',
      availableAssetsTruncated: false,
      availableStockAssets: [IDLE_ASSET],
      ensureBsDateAvailable: () => true,
      locations: [],
      onRefreshData,
      onUpdateAssetStatus,
      products: [],
      serialRegister: [],
      stock: [],
      userBranchId: 'b1',
    }),
    [alert, onRefreshData, onUpdateAssetStatus]
  );
  return createElement(
    StockOperationsProvider,
    { value: ctx as any },
    createElement(AssignAssetPanel)
  );
};

describe('assign fixed asset — a refused dispatch is shown, not swallowed', () => {
  let tree: MountedTree | null = null;
  const real = {
    employees: api.getCustodyEmployees,
    workOrders: api.getFieldWorkOrders,
  };

  beforeEach(() => {
    api.getCustodyEmployees = (async () => [IN_BRANCH_TECH, OTHER_BRANCH_TECH]) as any;
    api.getFieldWorkOrders = (async () => WORK_ORDERS) as any;
  });

  afterEach(() => {
    tree?.unmount();
    tree = null;
    api.getCustodyEmployees = real.employees;
    api.getFieldWorkOrders = real.workOrders;
  });

  test('the branch refusal is shown with the server message and no success banner', async () => {
    const calls: { id: string; body: any }[] = [];
    let refreshes = 0;
    const onUpdateAssetStatus = async (id: string, body: any) => {
      calls.push({ id, body });
      const error: any = new Error('That technician is not in the branch that holds this asset.');
      error.status = 400;
      throw error;
    };
    const onRefreshData = async () => {
      refreshes += 1;
    };

    tree = mountTree(
      createElement(
        DialogProvider as any,
        null,
        createElement(Harness, { onUpdateAssetStatus, onRefreshData })
      )
    );
    await settle();
    await fillDispatchLine(tree.container, OTHER_BRANCH_TECH.id, 'wo-out');
    await submit(tree.container);

    const text = tree.container.textContent || '';
    assert.equal(calls.length, 1, 'the refused dispatch must still have been attempted once');
    assert.equal(calls[0].body.assignedEmployeeId, OTHER_BRANCH_TECH.id);
    assert.match(
      text,
      /Deployment stopped at "Idle Unit": That technician is not in the branch that holds this asset\./
    );
    assert.doesNotMatch(text, /Deployment complete/, 'a refusal must never read as a deployment');
    assert.equal(refreshes, 1, 'the screen must re-read the register after a refusal');
    assert.match(
      text,
      /Deployment Bin Lines \(1\)/,
      'the refused line stays in the bin so the operator can correct it'
    );
  });

  test('an in-branch dispatch still confirms and clears the bin', async () => {
    const calls: { id: string; body: any }[] = [];
    let refreshes = 0;
    const onUpdateAssetStatus = async (id: string, body: any) => {
      calls.push({ id, body });
      return {};
    };
    const onRefreshData = async () => {
      refreshes += 1;
    };

    tree = mountTree(
      createElement(
        DialogProvider as any,
        null,
        createElement(Harness, { onUpdateAssetStatus, onRefreshData })
      )
    );
    await settle();
    await fillDispatchLine(tree.container, IN_BRANCH_TECH.id, 'wo-in');
    await submit(tree.container);

    const text = tree.container.textContent || '';
    assert.equal(calls.length, 1);
    assert.deepEqual(
      {
        id: calls[0].id,
        status: calls[0].body.status,
        assignedType: calls[0].body.assignedType,
        assignedEmployeeId: calls[0].body.assignedEmployeeId,
        assignedWorkOrderId: calls[0].body.assignedWorkOrderId,
      },
      {
        id: 'asset-idle',
        status: 'IN_USE',
        assignedType: 'EMPLOYEE',
        assignedEmployeeId: IN_BRANCH_TECH.id,
        assignedWorkOrderId: 'wo-in',
      }
    );
    assert.match(text, /Deployment complete — 1 bin line\(s\) processed/);
    assert.match(text, /No assets in the deployment bin yet/, 'the bin clears on success');
    assert.equal(refreshes, 1);
  });
});
