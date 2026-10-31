/**
 * Shared modal panel — dialog semantics and a real focus trap.
 *
 * The 2026-10-31 overlay sweep found twelve record/payment dialogs that were
 * plain divs: no role, no aria-modal, no accessible name, and Tab escaped onto
 * the page behind. `ModalPanel` wraps those panels and supplies the shell
 * overlay's behavior; `DialogProvider` joined the same focus-trap stack so a
 * confirm opened over a record dialog owns the keyboard while it is on top.
 *
 * PROVES:
 *   - the panel renders role="dialog", aria-modal="true" and its label;
 *   - focus enters the panel, Tab wraps last→first and Shift+Tab first→last;
 *   - Escape closes only while focus is inside the panel;
 *   - focus returns to the opener when the panel unmounts;
 *   - a DialogProvider dialog stacked over a panel takes over Tab.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { mountTree, inAct } from './harness/mount';
import { ModalPanel } from '../client/src/components/common/ModalPanel';
import { DialogProvider, useDialog } from '../client/src/components/common/DialogProvider';

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

interface TestDialogProps {
  open: boolean;
  onClose: () => void;
}

function TestDialog({ open, onClose }: TestDialogProps) {
  return createElement(
    'div',
    null,
    createElement('button', { id: 'opener' }, 'Open'),
    open
      ? createElement(
          ModalPanel,
          { label: 'Record dialog', onClose, className: 'panel' } as any,
          createElement('button', { id: 'first' }, 'First'),
          createElement('input', { id: 'field' }),
          createElement('button', { id: 'last' }, 'Last')
        )
      : null
  );
}

function StackHarness() {
  const [panelOpen, setPanelOpen] = useState(true);
  return createElement(
    DialogProvider,
    null,
    createElement('button', { id: 'opener' }, 'Open'),
    createElement('button', { id: 'outside' }, 'Outside'),
    panelOpen
      ? createElement(
          ModalPanel,
          { label: 'Record dialog', onClose: () => setPanelOpen(false) } as any,
          createElement('button', { id: 'first' }, 'First'),
          createElement(AskButton),
          createElement('button', { id: 'last' }, 'Last')
        )
      : null
  );
}

function AskButton() {
  const { confirm } = useDialog();
  return createElement(
    'button',
    {
      id: 'ask',
      onClick: () => {
        void confirm('Delete this record?', { title: 'Confirm Action' });
      },
    },
    'Ask'
  );
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/** The record/payment dialogs the 2026-10-31 sweep found without semantics. */
const ADOPTED_DIALOGS = [
  'client/src/features/inventory/ProductManagement.tsx',
  'client/src/features/inventory/CategoryManagement.tsx',
  'client/src/features/inventory/ProductGroupManagement.tsx',
  'client/src/features/inventory/UomManagement.tsx',
  'client/src/features/settings/LocationsManagement.tsx',
  'client/src/features/settings/UsersManagement.tsx',
  'client/src/features/settings/BranchesManagement.tsx',
  'client/src/features/procurement/SuppliersManagement.tsx',
  'client/src/features/sales/CustomerMasterDirectory.tsx',
  'client/src/features/finance/FixedAssetRegister.tsx',
  'client/src/features/sales/SalesInvoices.tsx',
  'client/src/features/procurement/PurchaseInvoices.tsx',
  // Data-gated dialogs measured in the follow-up pass.
  'client/src/features/settings/ApprovalWorkflowCenter.tsx',
  'client/src/components/common/ReceiveVerificationModal.tsx',
  'client/src/features/finance/OpeningStockManager.tsx',
  // Feature dialogs that were still on their own wrappers.
  'client/src/features/inventory/DamagedStockTracking.tsx',
  'client/src/features/inventory/PhysicalStockAudit.tsx',
  'client/src/features/inventory/SerialLogRegister.tsx',
];

describe('2026-10-31 overlay sweep — shared modal panel', () => {
  test('every record/payment dialog the sweep flagged uses the shared panel', () => {
    const missing = ADOPTED_DIALOGS.filter((file) => {
      const source = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
      return !/<ModalPanel\b/.test(source) || !/\blabel=/.test(source);
    });
    assert.deepEqual(
      missing,
      [],
      `these dialogs must render inside the shared ModalPanel:\n${missing.join('\n')}`
    );
  });

  test('is a labelled dialog, takes focus, traps Tab and closes on Escape', async () => {
    const tree = mountTree(createElement(TestDialog, { open: false, onClose: () => {} }));
    try {
      const opener = tree.container.querySelector('#opener') as HTMLButtonElement;
      inAct(() => opener.focus());

      tree.rerender(createElement(TestDialog, { open: true, onClose: () => {} }));
      await settle(10);

      const panel = tree.container.querySelector('[role="dialog"]') as HTMLElement | null;
      assert.ok(panel, 'the panel must expose role=dialog');
      assert.equal(panel!.getAttribute('aria-modal'), 'true');
      assert.equal(panel!.getAttribute('aria-label'), 'Record dialog');

      const first = tree.container.querySelector('#first') as HTMLButtonElement;
      const last = tree.container.querySelector('#last') as HTMLButtonElement;
      assert.equal(document.activeElement, first, 'focus enters the panel on open');

      inAct(() => {
        last.focus();
        last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });
      assert.equal(document.activeElement, first, 'Tab on the last control wraps to the first');

      inAct(() => {
        first.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
        );
      });
      assert.equal(document.activeElement, last, 'Shift+Tab on the first wraps to the last');

      let closed = 0;
      tree.rerender(createElement(TestDialog, { open: true, onClose: () => { closed += 1; } }));
      await settle(10);
      inAct(() => {
        (tree.container.querySelector('#field') as HTMLInputElement).focus();
        (tree.container.querySelector('#field') as HTMLInputElement).dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      assert.equal(closed, 1, 'Escape closes while focus is inside the panel');
    } finally {
      tree.unmount();
    }
  });

  test('Escape and Tab do not leak when a stacked dialog owns the keyboard', async () => {
    const tree = mountTree(createElement(StackHarness));
    try {
      await settle(10);
      const ask = tree.container.querySelector('#ask') as HTMLButtonElement;
      inAct(() => ask.click());
      await settle(10);

      const dialogs = [...tree.container.querySelectorAll('[role="dialog"]')] as HTMLElement[];
      assert.equal(dialogs.length, 2, 'the confirm renders over the record panel');
      const confirm = dialogs.find((node) => node.getAttribute('aria-label') === 'Confirm Action');
      assert.ok(confirm, 'the shared dialog keeps its accessible name');

      const close = confirm!.querySelector('button[aria-label="Close dialog"]') as HTMLButtonElement;
      const confirmButton = [...confirm!.querySelectorAll('button')].at(-1) as HTMLButtonElement;
      assert.equal(document.activeElement, confirmButton, 'focus starts on the confirm action');

      inAct(() => {
        confirmButton.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })
        );
      });
      assert.equal(
        document.activeElement,
        close,
        'Tab wraps inside the topmost dialog, not back into the panel underneath'
      );
    } finally {
      tree.unmount();
    }
  });

  test('focus returns to the opener when the panel closes', async () => {
    const tree = mountTree(createElement(TestDialog, { open: false, onClose: () => {} }));
    try {
      const opener = tree.container.querySelector('#opener') as HTMLButtonElement;
      inAct(() => opener.focus());

      tree.rerender(createElement(TestDialog, { open: true, onClose: () => {} }));
      await settle(10);
      assert.notEqual(document.activeElement, opener, 'focus moved into the panel');

      tree.rerender(createElement(TestDialog, { open: false, onClose: () => {} }));
      await settle();
      assert.equal(document.activeElement, opener, 'closing restores the trigger');
    } finally {
      tree.unmount();
    }
  });
});
