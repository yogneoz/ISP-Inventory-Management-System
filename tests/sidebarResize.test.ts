/**
 * Resizable navigation rail — drag, keyboard, persistence and wrapping.
 *
 * The rail used to be a fixed 18–19.5rem column chosen by viewport tier. Long
 * menu labels wrapped onto extra lines at that width, which pushed the lower
 * items below the fold of the scroll area. The rail now carries a splitter the
 * user can drag (or nudge with the keyboard), and the chosen width survives a
 * reload.
 *
 * PROVES:
 *   - the splitter is a labelled, focusable separator with min/max/now values;
 *   - dragging widens/narrows the rail and persists the width on release;
 *   - the drag clamps to 240–520 px in both directions;
 *   - ArrowLeft/ArrowRight step 16 px, Home/End jump to the bounds;
 *   - double-click restores the default width;
 *   - a stored width is applied before the first paint;
 *   - navigation labels wrap rather than ellipsize, so a narrow rail never
 *     hides the tail of a menu item.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import {
  Sidebar,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
} from '../client/src/components/layout/Sidebar';

const admin = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const base = {
  companyProfile: null,
  currentUser: admin,
  branches: [],
  selectedBranchId: 'ALL',
  onSelectBranch: () => {},
  fiscalYears: [],
  selectedFiscalYearId: '',
  onSelectFiscalYear: () => {},
  activeTab: 'dashboard',
  onSelectTab: () => {},
  lowStockCount: 0,
  pendingPoCount: 0,
  pendingBillCount: 0,
  inTransitShipmentCount: 0,
  onCloseMobile: () => {},
};

function renderSidebar() {
  const tree = mountTree(createElement(Sidebar, base as any));
  const aside = tree.container.querySelector('aside') as HTMLElement;
  const handle = tree.container.querySelector('[data-sidebar-resize-handle]') as HTMLElement;
  assert.ok(aside, 'the sidebar renders');
  assert.ok(handle, 'the sidebar renders a resize handle');
  return { tree, aside, handle };
}

function widthOf(aside: HTMLElement): number {
  return Number(aside.getAttribute('data-sidebar-width'));
}

function pointer(handle: HTMLElement, type: string, clientX: number) {
  handle.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  );
}

beforeEach(() => {
  localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
});

describe('sidebar resize — width math', () => {
  test('clamps to the rail bounds and rounds fractional drags', () => {
    assert.equal(clampSidebarWidth(100), SIDEBAR_MIN_WIDTH);
    assert.equal(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 1), SIDEBAR_MIN_WIDTH);
    assert.equal(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 1), SIDEBAR_MAX_WIDTH);
    assert.equal(clampSidebarWidth(333.6), 334);
    assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('sidebar resize — drag', () => {
  test('exposes a labelled vertical splitter with the current width', () => {
    const { tree, aside, handle } = renderSidebar();
    try {
      assert.equal(handle.getAttribute('role'), 'separator');
      assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
      assert.equal(handle.getAttribute('aria-label'), 'Resize navigation sidebar');
      assert.equal(handle.getAttribute('aria-valuemin'), String(SIDEBAR_MIN_WIDTH));
      assert.equal(handle.getAttribute('aria-valuemax'), String(SIDEBAR_MAX_WIDTH));
      assert.equal(handle.getAttribute('aria-valuenow'), String(SIDEBAR_DEFAULT_WIDTH));
      assert.equal(handle.getAttribute('tabindex'), '0');
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH);
    } finally {
      tree.unmount();
    }
  });

  test('dragging right widens the rail, dragging left narrows it, and release persists', () => {
    const { tree, aside, handle } = renderSidebar();
    try {
      inAct(() => {
        pointer(handle, 'pointerdown', SIDEBAR_DEFAULT_WIDTH);
        pointer(handle, 'pointermove', SIDEBAR_DEFAULT_WIDTH + 120);
      });
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH + 120);
      assert.equal(handle.getAttribute('aria-valuenow'), String(SIDEBAR_DEFAULT_WIDTH + 120));

      inAct(() => {
        pointer(handle, 'pointermove', SIDEBAR_DEFAULT_WIDTH + 120 - 60);
        pointer(handle, 'pointerup', SIDEBAR_DEFAULT_WIDTH + 60);
      });
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH + 60);
      assert.equal(
        localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY),
        String(SIDEBAR_DEFAULT_WIDTH + 60)
      );
    } finally {
      tree.unmount();
    }
  });

  test('the drag cannot leave the 240–520 px range', () => {
    const { tree, aside, handle } = renderSidebar();
    try {
      inAct(() => {
        pointer(handle, 'pointerdown', SIDEBAR_DEFAULT_WIDTH);
        pointer(handle, 'pointermove', -10_000);
        pointer(handle, 'pointerup', -10_000);
      });
      assert.equal(widthOf(aside), SIDEBAR_MIN_WIDTH);

      inAct(() => {
        pointer(handle, 'pointerdown', SIDEBAR_MIN_WIDTH);
        pointer(handle, 'pointermove', 10_000);
        pointer(handle, 'pointerup', 10_000);
      });
      assert.equal(widthOf(aside), SIDEBAR_MAX_WIDTH);
    } finally {
      tree.unmount();
    }
  });

  test('a pointer move without a drag does not resize the rail', () => {
    const { tree, aside, handle } = renderSidebar();
    try {
      inAct(() => pointer(handle, 'pointermove', SIDEBAR_DEFAULT_WIDTH + 200));
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH);
    } finally {
      tree.unmount();
    }
  });
});

describe('sidebar resize — keyboard and reset', () => {
  test('arrow keys step 16 px and Home/End jump to the bounds', () => {
    const { tree, aside, handle } = renderSidebar();
    try {
      const key = (name: string) => {
        inAct(() => {
          handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));
        });
      };

      key('ArrowRight');
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH + 16);
      assert.equal(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), String(SIDEBAR_DEFAULT_WIDTH + 16));

      key('ArrowLeft');
      key('ArrowLeft');
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH - 16);

      key('Home');
      assert.equal(widthOf(aside), SIDEBAR_MIN_WIDTH);

      key('End');
      assert.equal(widthOf(aside), SIDEBAR_MAX_WIDTH);

      key('Tab');
      assert.equal(widthOf(aside), SIDEBAR_MAX_WIDTH, 'unrelated keys leave the width alone');
    } finally {
      tree.unmount();
    }
  });

  test('double-click restores and persists the default width', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '420');
    const { tree, aside, handle } = renderSidebar();
    try {
      assert.equal(widthOf(aside), 420);
      inAct(() => {
        handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
      });
      assert.equal(widthOf(aside), SIDEBAR_DEFAULT_WIDTH);
      assert.equal(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), String(SIDEBAR_DEFAULT_WIDTH));
    } finally {
      tree.unmount();
    }
  });

  test('a stored width is applied on mount and invalid values fall back', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '365');
    const stored = renderSidebar();
    try {
      assert.equal(stored.aside.getAttribute('style')?.includes('width: 365px'), true);
      assert.equal(widthOf(stored.aside), 365);
    } finally {
      stored.tree.unmount();
    }

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'not-a-number');
    const invalid = renderSidebar();
    try {
      assert.equal(widthOf(invalid.aside), SIDEBAR_DEFAULT_WIDTH);
    } finally {
      invalid.tree.unmount();
    }
  });
});

describe('sidebar resize — labels stay readable', () => {
  test('group titles and menu items wrap instead of ellipsizing', () => {
    const { tree, aside } = renderSidebar();
    try {
      const groupTitle = aside.querySelector('[id^="nav-group-button-"] span') as HTMLElement;
      assert.ok(groupTitle, 'a group title renders');
      assert.match(groupTitle.className, /\bbreak-words\b/);
      assert.doesNotMatch(groupTitle.className, /\btruncate\b/);

      // Expand one group and check every visible item label.
      const groupButtons = [
        ...aside.querySelectorAll('[id^="nav-group-button-"]'),
      ] as HTMLButtonElement[];
      for (const button of groupButtons) {
        if (button.getAttribute('aria-expanded') !== 'true') inAct(() => button.click());
        const labels = [...aside.querySelectorAll('[data-nav-item] span')] as HTMLElement[];
        assert.ok(labels.length > 0, 'the open group renders item labels');
        for (const label of labels) {
          assert.match(label.className, /\bbreak-words\b/);
          assert.doesNotMatch(label.className, /\btruncate\b/);
        }
      }
    } finally {
      tree.unmount();
    }
  });
});
