/**
 * UI/UX sweep 2026-10-30 — the shared components that caused most findings.
 *
 * The sweep drove all 68 registered tabs at 390/1067/1440 px. Two of the
 * repeated defects were systemic, not screen-specific:
 *
 *   - PageHeader/StatCard ended long titles, descriptions and KPI labels in an
 *     ellipsis. At 1440 the header's action row could leave the title ~200 px,
 *     so "Damaged Stock Matrix & Branch Loss Tracking" rendered as
 *     "Damaged Stock Matri…"; at 1067 "Per-Branch Reorder Level Matrix & Sync"
 *     did the same. StatCard cut "TOTAL INVENTORY COST VALUE" to
 *     "TOTAL INVENTORY …".
 *   - 102 micro-labels used text-[9px], below the 10 px floor the type scale
 *     already establishes (628 other labels use text-[10px]).
 *
 * PROVES:
 *   - a PageHeader renders its title and description in full, with no
 *     truncation class on either, and still wraps;
 *   - a StatCard renders its label and hint without truncation;
 *   - no client source file reintroduces text-[9px].
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React, { createElement } from 'react';
import { mountTree } from './harness/mount';
import { PageHeader } from '../client/src/components/common/PageHeader';
import { StatCard } from '../client/src/components/common/StatCard';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

function collectClientSources(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectClientSources(full, found);
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('2026-10-30 sweep — header and card text is never hidden', () => {
  test('PageHeader renders the whole title and description and wraps them', () => {
    const title = 'Damaged Stock Matrix & Branch Loss Tracking';
    const description =
      'Supplier × branch opening payables (Accounts Payable) rolled forward from the Vendor Ledger close step in the Fiscal Year Closing Wizard.';
    const tree = mountTree(
      createElement(PageHeader, {
        title,
        description,
        icon: createElement('span', { 'data-testid': 'icon' }, 'i'),
        actions: createElement('button', { type: 'button' }, 'Export'),
      } as any)
    );

    try {
      const heading = tree.container.querySelector('h2') as HTMLElement | null;
      assert.ok(heading, 'the header must render the screen h2');
      const titleSpan = heading!.querySelector('span:not([data-testid])') as HTMLElement | null;
      assert.ok(titleSpan, 'the header must render a title span');
      assert.equal(titleSpan!.textContent, title, 'the title text must be complete');
      assert.doesNotMatch(titleSpan!.className, /\btruncate\b/, 'a screen title must not ellipsize');
      assert.match(titleSpan!.className, /\bbreak-words\b/, 'a long title must wrap instead');

      const paragraph = tree.container.querySelector('p') as HTMLElement | null;
      assert.ok(paragraph, 'the header must render the description');
      assert.equal(paragraph!.textContent, description);
      assert.doesNotMatch(paragraph!.className, /\btruncate\b/, 'a description must not ellipsize');
      assert.match(paragraph!.className, /\bbreak-words\b/);
    } finally {
      tree.unmount();
    }
  });

  test('StatCard label and hint wrap instead of ellipsizing', () => {
    const tree = mountTree(
      createElement(StatCard, {
        label: 'TOTAL INVENTORY COST VALUE',
        value: 'NPR 1,234,567',
        hint: 'Across every branch and every product in the catalogue',
      } as any)
    );

    try {
      const label = [...tree.container.querySelectorAll('span')].find(
        (node) => node.textContent === 'TOTAL INVENTORY COST VALUE'
      ) as HTMLElement | undefined;
      assert.ok(label, 'the card must render its label');
      assert.doesNotMatch(label!.className, /\btruncate\b/, 'a KPI label must not ellipsize');
      assert.match(label!.className, /\bbreak-words\b/);

      const hint = [...tree.container.querySelectorAll('div')].find(
        (node) => node.textContent === 'Across every branch and every product in the catalogue'
      ) as HTMLElement | undefined;
      assert.ok(hint, 'the card must render its hint');
      assert.doesNotMatch(hint!.className, /\btruncate\b/, 'a KPI hint must not ellipsize');
      assert.match(hint!.className, /\bbreak-words\b/);
    } finally {
      tree.unmount();
    }
  });
});

describe('2026-10-30 sweep — 24 px click-target floor', () => {
  test('the floor is px-based so the density zoom cannot shrink it', () => {
    const css = fs.readFileSync(path.join(PROJECT_ROOT, 'client', 'src', 'index.css'), 'utf8');
    const buttonRule = css.match(/button\s*\{([^}]*)\}/s)?.[1] ?? '';
    assert.match(buttonRule, /min-height:\s*24px;/, 'every button must have a 24 px minimum height');
    assert.match(buttonRule, /min-width:\s*24px;/, 'icon-only buttons must have a 24 px minimum width');
    assert.doesNotMatch(
      buttonRule,
      /min-height:\s*1\.5rem|min-height:\s*[^;]*rem/,
      'a rem floor renders 18.7 px at the 78% density tier; the floor must be px'
    );

    const constants = fs.readFileSync(
      path.join(PROJECT_ROOT, 'client', 'src', 'components', 'common', 'styleConstants.ts'),
      'utf8'
    );
    assert.match(
      constants,
      /export const linkButton = '[^']*min-h-\[24px\]/,
      'link-style actions need the shared 24 px target token'
    );
    assert.match(
      constants,
      /export const iconButton = '[^']*min-h-\[24px\][^']*min-w-\[24px\]|export const iconButton = '[^']*min-w-\[24px\][^']*min-h-\[24px\]/,
      'icon-only actions need a 24 x 24 hit area from the shared token'
    );
  });
});

describe('2026-10-30 sweep — 10 px type floor', () => {
  test('no client source uses text-[9px]', () => {
    const offenders: string[] = [];
    for (const file of collectClientSources(path.join(PROJECT_ROOT, 'client', 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('text-[9px]')) offenders.push(path.relative(PROJECT_ROOT, file));
    }
    assert.deepEqual(
      offenders,
      [],
      `micro-labels must stay at the 10 px floor; found text-[9px] in:\n${offenders.join('\n')}`
    );
  });
});
