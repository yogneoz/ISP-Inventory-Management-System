/**
 * Physical Stock Audit — the admin direct-reconcile path is real.
 *
 * The audit's separate "Direct Stock Reconcile (Admin Direct Override)" panel
 * was never opened: its state only ever changed to `false`. The live
 * approve/reconcile confirmation already handled the no-pending-request case by
 * calling the direct reconcile handler, so the orphan panel was deleted and the
 * live confirmation now labels that mode explicitly.
 *
 * PROVES:
 *   - with counted discrepancies and no pending request, the admin action reads
 *     "Direct Reconcile Stock" and opens exactly one dialog;
 *   - that dialog is labelled as the direct admin override and its confirm
 *     button calls onReconcileStockAudit with the entered variance;
 *   - the pending-request path still opens the approval confirmation and calls
 *     onProcessApproval instead of the direct handler.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { DarkModeProvider } from '../client/src/contexts/DarkModeContext';
import { PhysicalStockAudit } from '../client/src/features/inventory/PhysicalStockAudit';

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const admin = {
  id: 'u-admin',
  name: 'Super Admin',
  email: 'superadmin@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'br-1',
  allowedBranchIds: ['br-1'],
} as any;

const branches = [
  { id: 'br-1', code: 'HQ', name: 'Head Office', location: 'Kathmandu', isHeadquarters: true },
] as any[];

const longProductName = 'PLC Fiber Optic Splitter 1x8 SC/APC';

const products = [
  {
    id: 'p-1',
    sku: 'SKU-1',
    barcode: 'BAR-1',
    name: longProductName,
    category: 'General',
    unit: 'Pcs',
    costPrice: 100,
    requiresSerialTracking: false,
  },
] as any[];

const stock = [{ id: 's-1', productId: 'p-1', branchId: 'br-1', quantityOnHand: 10 }] as any[];

const baseProps = {
  currentUser: admin,
  products,
  branches,
  stock,
  selectedBranchId: 'br-1',
  dateMode: 'AD',
  approvalRequests: [],
};

function render(props: Record<string, unknown> = {}) {
  return mountTree(
    createElement(
      DarkModeProvider,
      null,
      createElement(PhysicalStockAudit, { ...baseProps, ...props } as any)
    )
  );
}

function buttonByText(container: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) =>
    pattern.test((node.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a button matching ${pattern}`);
  return button;
}

describe('physical stock audit — direct admin reconcile', () => {
  test('counts a discrepancy, opens one direct-override dialog and posts the variance', async () => {
    const calls: any[] = [];
    const tree = render({
      onReconcileStockAudit: async (payload: any) => {
        calls.push(payload);
      },
    });

    try {
      const increase = tree.container.querySelector(
        'button[title="Increase Count (+1)"]'
      ) as HTMLButtonElement;
      assert.ok(increase, 'the audit grid renders a count control');
      inAct(() => increase.click());

      const direct = buttonByText(tree.container, /^Direct Reconcile Stock$/);
      assert.equal(direct.disabled, false, 'a discrepancy enables the direct action');
      inAct(() => direct.click());

      const dialogs = [...tree.container.querySelectorAll('[role="dialog"]')] as HTMLElement[];
      assert.equal(dialogs.length, 1, 'there is exactly one reconcile dialog');
      assert.equal(dialogs[0].getAttribute('aria-label'), 'Direct Stock Reconcile (Admin Override)');
      assert.match(dialogs[0].textContent || '', /No approval request/);
      assert.match(dialogs[0].textContent || '', new RegExp(longProductName));
      const nameCell = [...dialogs[0].querySelectorAll('div')].find(
        (node) => (node.textContent || '').trim() === longProductName
      ) as HTMLElement | undefined;
      assert.ok(nameCell, 'the adjustment table names the product in full');
      assert.match(nameCell!.className, /\bbreak-words\b/);
      assert.doesNotMatch(nameCell!.className, /\btruncate\b/);

      const confirm = buttonByText(tree.container, /^Authorize & Update Balances$/);
      inAct(() => confirm.click());
      await settle();

      assert.equal(calls.length, 1, 'the direct reconcile callback runs exactly once');
      assert.equal(calls[0].branchId, 'br-1');
      assert.match(calls[0].auditRefNumber, /^AUD-2083-\d{3}$/);
      assert.equal(calls[0].varianceItems.length, 1);
      assert.equal(calls[0].varianceItems[0].productId, 'p-1');
      assert.equal(calls[0].varianceItems[0].bookQty, 10);
      assert.equal(calls[0].varianceItems[0].countedQty, 11);
      assert.equal(calls[0].varianceItems[0].varianceQty, 1);
      assert.equal(calls[0].varianceItems[0].varianceValue, 100);
      assert.match(calls[0].notes, /Direct Physical Stock Audit Reconciliation/);
    } finally {
      tree.unmount();
    }
  });

  test('a pending request still uses the approval confirmation, not the direct handler', async () => {
    const approved: Array<{ id: string; status: string }> = [];
    const directCalls: any[] = [];
    const pending = {
      id: 'req-1',
      requestNumber: 'REQ-1',
      type: 'STOCK_AUDIT_RECONCILIATION',
      status: 'PENDING',
      branchId: 'br-1',
      branchName: 'Head Office',
      requestedByRole: 'BRANCH_MANAGER',
      requestedByName: 'Branch Manager',
      requestedAtAD: '2026-10-01',
      auditData: {
        auditRefNumber: 'AUD-2083-777',
        varianceItems: [
          { productId: 'p-1', countedQty: 9, varianceReason: 'Shrinkage / Missing Stock' },
        ],
      },
    } as any;

    const tree = render({
      approvalRequests: [pending],
      onProcessApproval: async (id: string, status: string) => {
        approved.push({ id, status });
      },
      onReconcileStockAudit: async (payload: any) => {
        directCalls.push(payload);
      },
    });

    try {
      const approve = buttonByText(tree.container, /^Approve & Reconcile Stock$/);
      inAct(() => approve.click());

      const dialog = tree.container.querySelector('[role="dialog"]') as HTMLElement;
      assert.ok(dialog, 'the approval confirmation opens');
      assert.equal(dialog.getAttribute('aria-label'), 'Approve & Reconcile Physical Stock');
      assert.doesNotMatch(dialog.textContent || '', /No approval request/);

      const confirm = buttonByText(tree.container, /^Confirm Approve & Reconcile$/);
      inAct(() => confirm.click());
      await settle();

      assert.deepEqual(approved, [{ id: 'req-1', status: 'APPROVED' }]);
      assert.equal(directCalls.length, 0, 'the pending path must not post a direct adjustment');
    } finally {
      tree.unmount();
    }
  });
});
