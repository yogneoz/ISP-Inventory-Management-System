/**
 * The Query gate on the converted sales and inventory registers.
 *
 * Every one of these screens now shows ONE period field (draft + applied) and a
 * Query button. The contract, proven here against the real App and the real
 * screens:
 *
 *   1. NO AUTO-QUERY: editing either date sends no request and changes no
 *      figure on screen. A half-typed range must never launch a read.
 *   2. QUERY APPLIES: pressing Query is the only path from the draft to the
 *      figures — a server register sends the applied range, a client-filtered
 *      register filters on it.
 *
 * Modelled on `accountingWorkspaceRoute.test.ts` (same harness, same stub
 * style), so the four screens converted with the shared field cannot drift back
 * to the old "one DateField per end" behaviour without failing here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { User } from '../client/src/types';
import { clearRecentBootstrapCache } from '../client/src/utils/sessionCache';
import { inAct } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  installEventSource,
  mountAppRouteTree,
  seedSession,
  setInputValue,
  settleUntil,
} from './harness/appRouteTreeProbe';

const admin = {
  id: 'u-period-gate',
  name: 'Period Gate Admin',
  email: 'period-gate@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  isActive: true,
} as unknown as User;

const bootstrap = {
  ...bootstrapFixture,
  userPreferences: { activeTab: 'sales-list', dateMode: 'AD', theme: 'light' },
};

const bootstrapWithTab = (activeTab: string) => ({
  ...bootstrap,
  userPreferences: { ...bootstrap.userPreferences, activeTab },
});

/** Opens `tab` as a signed-in admin, with a fresh bootstrap cache. */
function mountScreen(tab: string) {
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession(tab, admin);
  return installEventSource();
}

function text(container: HTMLElement): string {
  return container.textContent || '';
}

/** The Query button that belongs to the period field holding `input`. */
function queryButtonFor(input: HTMLInputElement): HTMLButtonElement {
  const field = input.closest('div.flex.items-end');
  const button = field?.querySelector('button') as HTMLButtonElement | null;
  assert.ok(button, 'the period field must carry its own Query button');
  return button;
}

function dateInput(container: HTMLElement, ariaLabel: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement | null;
  assert.ok(input, `the period field must expose "${ariaLabel}"`);
  return input;
}

/**
 * Types a date into one end of the period field, exactly as a user would.
 *
 * The wait is a real 300 ms inside act(), not just microtasks: a debounced
 * auto-query (a dead filter, a stale effect) would fire in this window. Without
 * it the gate could pass on timing rather than on the contract.
 */
async function pickDate(container: HTMLElement, ariaLabel: string, value: string): Promise<void> {
  setInputValue(dateInput(container, ariaLabel), value);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

test('sales invoices: a date edit sends nothing; Query sends the applied range', async () => {
  const calls: any[] = [];
  const restored = mountScreen('sales-list');
  const restoreApi = installApiStubs({
    getBootstrapState: async () => bootstrapWithTab('sales-list'),
    getSalesInvoices: (async (query: any) => {
      calls.push(query);
      return { items: [], data: [], nextCursor: null, hasMore: false };
    }) as any,
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => Boolean(tree.container.querySelector('input[aria-label="Sales invoice date from"]'))),
      'the sales register must render the shared period field'
    );

    assert.ok(
      await settleUntil(() => calls.length > 0),
      'the register must read its first page on mount'
    );
    assert.equal(calls.length, 1, 'one read on mount, before any date is picked');

    await pickDate(tree.container, 'Sales invoice date from', '2026-02-01');
    await pickDate(tree.container, 'Sales invoice date to', '2026-02-28');

    assert.equal(calls.length, 1, 'editing the range must not read the invoices — Query is the gate');

    inAct(() => queryButtonFor(dateInput(tree.container, 'Sales invoice date from')).click());
    assert.ok(
      await settleUntil(() => calls.length > 1),
      'Query must load the applied range'
    );
    const applied = calls[calls.length - 1];
    assert.equal(applied.dateFromAD, '2026-02-01', 'Query must send the applied start date');
    assert.equal(applied.dateToAD, '2026-02-28', 'Query must send the applied end date');
  } finally {
    tree.unmount();
    restoreApi();
    restored();
  }
});

test('serial log: a date edit sends nothing; Query sends the applied range', async () => {
  const calls: any[] = [];
  const restored = mountScreen('complete-serial-inventory');
  const restoreApi = installApiStubs({
    getBootstrapState: async () => bootstrapWithTab('complete-serial-inventory'),
    getSerialLogs: (async (query: any) => {
      calls.push(query);
      return { items: [], data: [], nextCursor: null, hasMore: false, statusCounts: {} };
    }) as any,
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => Boolean(tree.container.querySelector('input[aria-label="Activity from"]'))),
      'the serial log must render the shared period field'
    );
    assert.ok(
      await settleUntil(() => calls.length > 0),
      'the serial log must read its first page on mount'
    );
    const before = calls.length;

    await pickDate(tree.container, 'Activity from', '2026-03-01');
    await pickDate(tree.container, 'Activity to', '2026-03-31');

    assert.equal(calls.length, before, 'editing the activity range must not read the log — Query is the gate');

    inAct(() => queryButtonFor(dateInput(tree.container, 'Activity from')).click());
    assert.ok(
      await settleUntil(() => calls.length > before),
      'Query must load the applied range'
    );
    const applied = calls[calls.length - 1];
    assert.equal(applied.dateFromAD, '2026-03-01');
    assert.equal(applied.dateToAD, '2026-03-31');
  } finally {
    tree.unmount();
    restoreApi();
    restored();
  }
});

test('sales returns: a date edit changes no rows; Query sends the applied range', async () => {
  const calls: any[] = [];
  const restored = mountScreen('sales-returns');
  const restoreApi = installApiStubs({
    getBootstrapState: async () => bootstrapWithTab('sales-returns'),
    getSalesReturns: (async (query: any) => {
      calls.push(query);
      return { items: [], data: [], nextCursor: null, hasMore: false };
    }) as any,
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => Boolean(tree.container.querySelector('input[aria-label="Return date from"]'))),
      'the returns register must render the shared period field'
    );
    assert.ok(
      await settleUntil(() => calls.length > 0),
      'the returns register must read its first page on mount'
    );
    const before = calls.length;

    await pickDate(tree.container, 'Return date from', '2026-04-01');
    await pickDate(tree.container, 'Return date to', '2026-04-30');

    assert.equal(calls.length, before, 'editing the return range must not read the returns — Query is the gate');

    inAct(() => queryButtonFor(dateInput(tree.container, 'Return date from')).click());
    assert.ok(
      await settleUntil(() => calls.length > before),
      'Query must load the applied range'
    );
    const applied = calls[calls.length - 1];
    assert.equal(applied.dateFromAD, '2026-04-01');
    assert.equal(applied.dateToAD, '2026-04-30');
  } finally {
    tree.unmount();
    restoreApi();
    restored();
  }
});

test('stock ledger: a date edit changes no figures; Query applies the range', async () => {
  const calls: any[] = [];
  const restored = mountScreen('stock-ledger');
  const restoreApi = installApiStubs({
    getBootstrapState: async () => bootstrapWithTab('stock-ledger'),
    getTransactionLogs: (async (query: any) => {
      calls.push(query);
      return { data: [], totalItems: 0, capped: false };
    }) as any,
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => Boolean(tree.container.querySelector('input[aria-label="Movement date from"]'))),
      'the stock ledger must render the shared period field'
    );
    assert.ok(
      await settleUntil(() => calls.length > 0),
      'the ledger must read its fiscal-year window on mount'
    );
    const before = calls.length;
    const initialText = text(tree.container);

    await pickDate(tree.container, 'Movement date from', '2026-05-01');
    await pickDate(tree.container, 'Movement date to', '2026-05-31');

    assert.equal(calls.length, before, 'the ledger reads a fiscal-year window; a date edit must not refetch it');
    assert.equal(text(tree.container), initialText, 'a date edit must not change the figures on screen');

    inAct(() => queryButtonFor(dateInput(tree.container, 'Movement date from')).click());
    // The ledger filters its loaded window client-side; Query is what applies it.
    const input = dateInput(tree.container, 'Movement date from');
    assert.equal(input.value, '2026-05-01', 'the applied range must stay on screen after Query');
    assert.equal(calls.length, before, 'applying a client-side filter still must not refetch');
  } finally {
    tree.unmount();
    restoreApi();
    restored();
  }
});
