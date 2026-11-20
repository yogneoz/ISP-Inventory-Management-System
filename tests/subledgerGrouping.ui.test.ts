/**
 * Subledgers Management — grouped rows and refresh-stable disclosure.
 *
 * The register must group by the server-reported type, bucket an omitted type
 * under Unspecified, show per-group counts/totals, and keep a collapsed group
 * closed after Refresh replaces the rows. A legacy chart-health payload must
 * not take the screen down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { SubledgersManagement } from '../client/src/features/finance/SubledgersManagement';
import type { Branch, User } from '../client/src/types';
import { mountTree } from './harness/mount';
import { installApiStubs } from './harness/appRouteTreeProbe';
import { BootstrapDataProvider } from '../client/src/contexts/AppProviders';

const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const branches = [{ id: 'BR-KTM', code: 'KTM', name: 'Kathmandu' }] as Branch[];
const user = {
  id: 'u-accountant', email: 'accountant@example.com', name: 'Asha Accountant',
  role: 'ACCOUNTANT', branchId: 'ALL',
} as User;

const controlAccount = {
  id: 'gla-1100', code: '1100', name: 'Accounts Receivable', groupId: 'glg-1110',
  groupCode: '1110', groupName: 'Trade Receivables', description: null,
  isControl: true, subledgerType: 'CUSTOMER', postingRole: 'AR_CONTROL',
  isActive: true, isDemo: false, accountType: 'ASSET',
  statementGroup: 'CURRENT_ASSET', normalBalance: 'DEBIT', branchId: null,
};

function book(overrides: Record<string, unknown>) {
  return {
    id: 'sl-1', code: 'SL-1', name: 'Book 1', subledgerType: 'CUSTOMER',
    mainAccountId: 'gla-1100', partyId: 'CUST-1', description: null,
    isActive: true, isDemo: false, accountCode: '1100', accountName: 'Accounts Receivable',
    accountPostingRole: 'AR_CONTROL', groupCode: '1110', groupName: 'Trade Receivables',
    entryCount: 5, bookBalance: 150, subledgerBalance: 150, glBalance: 150,
    difference: 0, unlinkedCount: 0,
    ...overrides,
  };
}

const text = (node: HTMLElement = document.body) => node.textContent || '';

test('subledgers render grouped, collapse across refresh and tolerate legacy health', async () => {
  let loads = 0;
  const books = [
    book({ id: 'c-1', code: 'SL-C1', name: 'Customer Book', subledgerType: 'CUSTOMER', entryCount: 5, bookBalance: 150 }),
    book({ id: 'c-2', code: 'SL-C2', name: 'Second Customer', subledgerType: 'CUSTOMER', entryCount: 7, bookBalance: 250 }),
    book({ id: 's-1', code: 'SL-S1', name: 'Supplier Book', subledgerType: 'SUPPLIER', entryCount: 3, bookBalance: 80 }),
    book({
      id: 'u-1', code: 'SL-U1', name: 'Unspecified Book', subledgerType: undefined,
      entryCount: undefined, bookBalance: undefined,
    }),
  ];
  const restore = installApiStubs({
    getAccountingSubledgers: async () => {
      loads += 1;
      return books as any;
    },
    getAccountingAccounts: async () => [controlAccount] as any,
    // Deliberately the pre-ACC-6 shape: no unlinkedSubledgerRows and no arrays.
    getChartHealth: async () => ({}),
  });

  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(SubledgersManagement, { currentUser: user }))
    )
  );
  try {
    await settle();
    assert.equal(loads, 1);
    assert.match(text(), /2 books/);
    assert.match(text(), /12 rows/);
    assert.match(text(), /Book NPR 400/);
    assert.match(text(), /1 book/);
    assert.match(text(), /UNSPECIFIED/);
    assert.match(text(), /Book total not reported/);
    assert.doesNotMatch(text(), /NaN/);

    const customerGroup = [...document.querySelectorAll('button')].find(
      (button) => (button.getAttribute('aria-label') || '') === 'Collapse CUSTOMER subledgers'
    ) as HTMLButtonElement | undefined;
    assert.ok(customerGroup, 'CUSTOMER group must expose a collapse control');
    assert.equal(customerGroup.getAttribute('aria-expanded'), 'true');
    act(() => customerGroup.click());
    assert.equal(customerGroup.getAttribute('aria-expanded'), 'false');
    assert.doesNotMatch(text(), /Customer Book/);

    const refresh = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').trim() === 'Refresh'
    ) as HTMLButtonElement | undefined;
    assert.ok(refresh, 'Refresh must be available');
    act(() => refresh.click());
    await settle();
    assert.equal(loads, 2, 'refresh must reload the payload');
    const customerAfterRefresh = [...document.querySelectorAll('button')].find(
      (button) => (button.getAttribute('aria-label') || '') === 'Expand CUSTOMER subledgers'
    ) as HTMLButtonElement | undefined;
    assert.ok(customerAfterRefresh, 'the collapsed group must stay collapsed after refresh');
    assert.equal(customerAfterRefresh.getAttribute('aria-expanded'), 'false');
    assert.doesNotMatch(text(), /Customer Book/);
    assert.match(text(), /Supplier Book/, 'other groups remain visible after refresh');
  } finally {
    tree.unmount();
    restore();
  }
});
