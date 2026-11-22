/**
 * PeriodRangeField — the FilterCard date filter follows the header calendar.
 *
 * The header's BS/AD switch sets the session `dateMode`, which each register
 * passes to its card's date filter. In BS mode both ends must open the seeded
 * Nepali grid and still report the canonical AD ISO date, so the register keeps
 * sending AD bounds and every existing keyset read stays the same.
 *
 * PROVES:
 *   1. BS MODE — each end is the Nepali picker, not a native AD date input.
 *   2. MAPPING — a picked BS day is stored as the AD date it maps to.
 *   3. GATE — picking edits the draft only; Query applies the AD bounds.
 *   4. AD MODE — the native date inputs are unchanged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useState } from 'react';
import { inAct, mountTree } from './harness/mount';
import { PeriodRangeField } from '../client/src/components/common/PeriodRangeField';
import { convertADToBS } from '../client/src/utils/nepaliCalendar';
import { AccountingRegisterShell } from '../client/src/components/accounting/AccountingRegisterShell';
import type { AccountingScope } from '../client/src/components/accounting/AccountingRegisterShell';

function Harness({ mode, applies }: { mode: 'BS' | 'AD'; applies: string[] }) {
  const [range, setRange] = useState({ from: '', to: '' });
  return h(PeriodRangeField, {
    mode,
    label: 'Activity',
    startAriaLabel: 'Activity from',
    endAriaLabel: 'Activity to',
    requireEnd: false,
    from: range.from,
    to: range.to,
    onChange: (next) => setRange(next),
    onApply: () => applies.push(`${range.from}..${range.to}`),
  });
}

const queryButtonOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Query'
  ) ?? null;

/** Day cells of the open BS grid — each names the AD date it maps to. */
const dayButtonsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label*=" AD)"]'));

/** The ONE bordered control that holds both ends of the range. */
const rangeShellOf = (node: Element | null) => node?.closest('[data-range-shell]') ?? null;

describe('PeriodRangeField — BS mode follows the header calendar', () => {
  test('each end is the Nepali picker, and a picked day is stored as its AD date', () => {
    const applies: string[] = [];
    const tree = mountTree(h(Harness, { mode: 'BS', applies }));

    try {
      assert.equal(
        tree.container.querySelector('input[type="date"]'),
        null,
        'BS mode must not render a native AD date input'
      );

      const start = tree.container.querySelector('input[aria-label="Activity from"]') as HTMLInputElement | null;
      const end = tree.container.querySelector('input[aria-label="Activity to"]') as HTMLInputElement | null;
      assert.ok(start, 'the start end keeps its own accessible name');
      assert.ok(end, 'the end end keeps its own accessible name');
      assert.equal(start!.getAttribute('readonly'), '', 'a BS value is picked from the grid, not typed as AD');

      // The whole point of the BS layout: the two Nepali pickers share the one
      // range control, so the row is the same size in both calendars.
      const shell = rangeShellOf(start);
      assert.ok(shell, 'BS mode keeps the single range control');
      assert.equal(rangeShellOf(end), shell, 'both BS ends live inside THAT one control');
      assert.ok(shell!.className.includes('h-8'), 'the range control keeps the card row height');
      assert.equal(
        tree.container.querySelectorAll('[data-range-shell]').length,
        1,
        'BS mode renders one range control, not one box per end'
      );

      inAct(() => start!.click());
      const day = dayButtonsOf(tree.container).find((button) => !button.disabled);
      assert.ok(day, 'opening the BS picker lists selectable Nepali days');
      const mapped = (day!.getAttribute('aria-label') || '').match(/\((\d{4}-\d{2}-\d{2}) AD\)/);
      assert.ok(mapped, 'every pickable day names the AD date it maps to');
      const adDate = mapped![1];

      inAct(() => day!.click());
      const shown = (tree.container.querySelector('input[aria-label="Activity from"]') as HTMLInputElement).value;
      assert.equal(shown, convertADToBS(adDate).formattedBSShort, 'the box shows the BS day that was picked');
      assert.deepEqual(applies, [], 'picking a BS day edits the draft, it does not query');

      const query = queryButtonOf(tree.container);
      assert.ok(query, 'the range keeps its Query gate');
      inAct(() => query!.click());
      assert.deepEqual(applies, [`${adDate}..`], 'Query applies the AD bound the register sends');
    } finally {
      tree.unmount();
    }
  });

  test('AD mode keeps the native date inputs', () => {
    const tree = mountTree(h(Harness, { mode: 'AD', applies: [] }));

    try {
      const start = tree.container.querySelector('input[aria-label="Activity from"]') as HTMLInputElement | null;
      assert.ok(start, 'AD mode exposes the same accessible name');
      assert.equal(start!.type, 'date', 'AD mode keeps the native picker');
      const end = tree.container.querySelector('input[aria-label="Activity to"]') as HTMLInputElement | null;
      const shell = rangeShellOf(start);
      assert.ok(shell, 'AD mode renders the single range control');
      assert.equal(rangeShellOf(end), shell, 'AD mode puts both ends in that one control');
    } finally {
      tree.unmount();
    }
  });

  test("the accounting registers' own period field follows the header too", () => {
    const scope: AccountingScope = {
      allowed: true,
      canSeeAllBranches: true,
      scopedBranches: [],
      branchId: 'ALL',
      setBranchId: () => {},
      asOfDate: '2026-11-21',
      fromDate: '',
      draft: { from: '', to: '' },
      setDraftFrom: () => {},
      setDraftTo: () => {},
      applyPeriod: () => {},
      periodPending: false,
      query: { to: '2026-11-21' },
      rangeQuery: { to: '2026-11-21' },
    };
    const tree = mountTree(
      h(AccountingRegisterShell, {
        title: 'Trial Balance',
        description: 'Debits = Credits',
        icon: null,
        registerName: 'trial balance',
        scope,
        dateMode: 'BS',
        loading: false,
        error: '',
        onRefresh: () => {},
        onRetry: () => {},
        children: h('div', null, 'rows'),
      })
    );

    try {
      const shell = tree.container.querySelector('[data-range-shell]');
      assert.ok(shell, 'the register period field keeps its single range control in BS mode');
      assert.equal(
        tree.container.querySelector('input[type="date"]'),
        null,
        'a BS session must not leave the register on native AD date inputs'
      );
      const start = tree.container.querySelector('input[aria-label="Accounting period start"]');
      const end = tree.container.querySelector('input[aria-label="Accounting period end"]');
      assert.ok(start && end, 'both ends of the register period stay on screen');
      assert.equal(start!.closest('[data-range-shell]'), shell, 'the start end sits in that control');
      assert.equal(end!.closest('[data-range-shell]'), shell, 'the end end sits in that control');
    } finally {
      tree.unmount();
    }
  });
});
