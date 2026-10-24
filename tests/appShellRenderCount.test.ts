/**
 * A2 — measured: shell-only state changes never reach the tab tree.
 *
 * Mounts the REAL `AppShell` around a counting stand-in for App's workspace.
 * The probe host owns data (`rows`) exactly like App; the shell owns the
 * sidebar/modal/notification state. Three things are asserted here:
 *
 *   1. sidebars/modals/shortcuts still work (the DOM reacts),
 *   2. none of them re-renders the workspace (the tab tree's render count),
 *   3. a DATA change still reaches the workspace (the tree is not frozen),
 *   4. the shape is pinned: App does not own the shell flags again.
 *
 * Selector notes: the header search box and the Global Search overlay both
 * begin with "Scan Barcode", so the overlay is matched by its own longer
 * placeholder. Never `assert.equal(element, null)`: a failing assertion
 * serialises the element, whose `__reactFiber` back-pointer is circular, and
 * Node's diff printer exhausts the heap. Booleans keep failures readable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { NAVIGATE_TAB_EVENT } from '../client/src/services/api/http';
import { inAct, mountTree } from './harness/mount';
import { ShellProbe, createShellHandles } from './harness/appShellProbe';

const SIDEBAR_TOGGLE = 'button[aria-label="Toggle navigation menu"]';
const SEARCH_BUTTON = 'button[title^="Global Quick Search"]';
/** The mobile drawer backdrop AppShell renders only while the sidebar is open. */
const SIDEBAR_BACKDROP = '[class*="bg-black/60"]';

function query(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector(selector);
  assert.ok(element, `expected ${selector} in the shell DOM`);
  return element as HTMLElement;
}

const has = (container: HTMLElement, selector: string) =>
  container.querySelector(selector) !== null;

const text = (container: HTMLElement) => container.textContent || '';

/**
 * jsdom's selector engine misses attribute values containing `&`, so the
 * overlays are matched by reading attributes instead of CSS selectors:
 * `button[title="Notifications & Reorder Alerts"]` and
 * `input[placeholder^="Scan Barcode or Search & Enter"]` both find nothing
 * even though the elements are right there.
 */
function buttonByTitle(root: HTMLElement, prefix: string): HTMLElement | null {
  const found = Array.from(root.querySelectorAll('button[title]')).find((button) =>
    (button.getAttribute('title') || '').startsWith(prefix)
  );
  return (found as HTMLElement | undefined) ?? null;
}

function buttonByText(root: HTMLElement, label: string): HTMLElement {
  const found = Array.from(root.querySelectorAll('button')).find(
    (button) => (button.textContent || '').trim() === label
  );
  assert.ok(found, `expected a button labelled "${label}" in the shell DOM`);
  return found as HTMLElement;
}

/** The Global Search overlay's own input (the header box's placeholder is shorter). */
function searchOverlayOpen(root: HTMLElement): boolean {
  return Array.from(root.querySelectorAll('input')).some((input) =>
    (input.getAttribute('placeholder') || '').startsWith('Scan Barcode or Search & Enter')
  );
}

describe('A2 — shell state stays out of the tab tree', () => {
  test('sidebar, search modal and notification panel open without re-rendering the workspace', () => {
    const handles = createShellHandles();
    const tree = mountTree(h(ShellProbe, { handles }));

    assert.equal(handles.tabRenders, 1, 'precondition: the workspace rendered once on mount');

    // Sidebar toggle (Header's hamburger). The mobile backdrop appearing is the
    // proof the shell really re-rendered.
    assert.equal(has(tree.container, SIDEBAR_BACKDROP), false, 'precondition: drawer closed');
    inAct(() => query(tree.container, SIDEBAR_TOGGLE).click());
    assert.equal(has(tree.container, SIDEBAR_BACKDROP), true, 'the sidebar backdrop must appear');
    assert.equal(handles.tabRenders, 1, 'a sidebar toggle must not re-render the tab tree');

    // Global search overlay, opened from the header.
    assert.equal(searchOverlayOpen(tree.container), false, 'precondition: no search overlay');
    inAct(() => query(tree.container, SEARCH_BUTTON).click());
    assert.equal(searchOverlayOpen(tree.container), true, 'the search overlay must open');
    assert.equal(handles.tabRenders, 1, 'opening a modal must not re-render the tab tree');

    // Notification panel (bell). The search overlay is still open; the panel
    // must open on top without touching the tree either.
    const bell = buttonByTitle(tree.container, 'Notifications');
    assert.ok(bell, 'the header notification bell must be rendered');
    inAct(() => bell.click());
    assert.ok(
      text(tree.container).includes('Notification Center'),
      'the notification panel must open'
    );
    assert.equal(handles.tabRenders, 1, 'opening the notification panel must not re-render the tab tree');

    tree.unmount();
  });

  test('keyboard shortcuts still work and also skip the workspace', () => {
    const handles = createShellHandles();
    const tree = mountTree(h(ShellProbe, { handles }));
    const press = (init: KeyboardEventInit) =>
      inAct(() => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', init));
      });

    // Alt+B opens the barcode scanner (a shell modal).
    press({ key: 'b', altKey: true });
    assert.ok(text(tree.container).includes('Barcode & Serial Scanner'), 'Alt+B must open the scanner');
    assert.equal(handles.tabRenders, 1, 'Alt+B must not re-render the tab tree');

    // Alt+H asks the shell to navigate — the tab change is App's job, the shell
    // forwards it and touches no data.
    press({ key: 'h', altKey: true });
    assert.deepEqual(handles.selectedTabs, ['help-documentation']);
    assert.equal(handles.tabRenders, 1);

    // Ctrl+K toggles the global search overlay on, then off again.
    press({ key: 'k', ctrlKey: true });
    assert.equal(searchOverlayOpen(tree.container), true, 'Ctrl+K must open the search overlay');
    assert.equal(handles.tabRenders, 1);

    press({ key: 'k', ctrlKey: true });
    assert.equal(searchOverlayOpen(tree.container), false, 'Ctrl+K must toggle it closed');
    assert.equal(handles.tabRenders, 1);

    tree.unmount();
  });

  test('Escape closes the overlay on top — search, drawer, profile and scanner', () => {
    const handles = createShellHandles();
    const tree = mountTree(h(ShellProbe, { handles }));
    const press = (init: KeyboardEventInit) =>
      inAct(() => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', init));
      });

    // Nothing open: Escape belongs to the screen underneath, not the shell.
    press({ key: 'Escape' });
    assert.equal(handles.tabRenders, 1);

    // Search overlay: Escape closes it (the newest opened overlay).
    press({ key: 'k', ctrlKey: true });
    assert.equal(searchOverlayOpen(tree.container), true);
    press({ key: 'Escape' });
    assert.equal(searchOverlayOpen(tree.container), false, 'Escape must close the search overlay');

    // Closing the dialog put focus back in the header search field; leave the
    // field so the next shortcut is not treated as typing (same guard the app
    // applies to a focused input).
    inAct(() => (document.activeElement as HTMLElement | null)?.blur());

    // Drawer first, search on top of it: the dialog goes, the drawer stays.
    inAct(() => buttonByTitle(tree.container, 'Notifications')!.click());
    assert.ok(text(tree.container).includes('Notification Center'));
    press({ key: 'k', ctrlKey: true });
    assert.equal(searchOverlayOpen(tree.container), true);
    press({ key: 'Escape' });
    assert.equal(searchOverlayOpen(tree.container), false, 'Escape closes the top overlay first');
    assert.ok(
      text(tree.container).includes('Notification Center'),
      'the drawer underneath must stay open'
    );
    press({ key: 'Escape' });
    assert.equal(
      text(tree.container).includes('Notification Center'),
      false,
      'the next Escape closes the drawer'
    );

    // The header's account menu is a dropdown, not a modal: Escape closes it
    // too (the cheat sheet promises "Active Modal or Dropdown").
    inAct(() => query(tree.container, 'button[title^="Click to expand switch user menu"]').click());
    assert.ok(
      text(tree.container).includes('Switch User Account'),
      'precondition: the account dropdown is open'
    );
    press({ key: 'Escape' });
    assert.equal(
      text(tree.container).includes('Switch User Account'),
      false,
      'Escape must close the header account dropdown'
    );

    // Profile modal, opened from the header's account menu.
    inAct(() => query(tree.container, 'button[title^="Click to expand switch user menu"]').click());
    inAct(() => buttonByText(tree.container, 'Account Settings').click());
    assert.ok(text(tree.container).includes('Switch Profile'), 'the profile modal must open');
    press({ key: 'Escape' });
    assert.equal(
      text(tree.container).includes('Switch Profile'),
      false,
      'Escape must close the profile modal'
    );

    // Barcode scanner (Alt+B).
    inAct(() => (document.activeElement as HTMLElement | null)?.blur());
    press({ key: 'b', altKey: true });
    assert.ok(text(tree.container).includes('Barcode & Serial Scanner'));
    press({ key: 'Escape' });
    assert.equal(
      text(tree.container).includes('Barcode & Serial Scanner'),
      false,
      'Escape must close the barcode scanner'
    );

    // Account menu open UNDER a shell overlay: one Escape closes the overlay
    // only; the menu waits for the next press.
    inAct(() => query(tree.container, '[data-shell-trigger="profile"]').click());
    assert.ok(text(tree.container).includes('Switch User Account'));
    press({ key: 'k', ctrlKey: true });
    assert.equal(searchOverlayOpen(tree.container), true, 'precondition: search over the menu');
    press({ key: 'Escape' });
    assert.equal(searchOverlayOpen(tree.container), false, 'the overlay on top goes first');
    assert.ok(
      text(tree.container).includes('Switch User Account'),
      'the account menu underneath must stay open'
    );
    press({ key: 'Escape' });
    assert.equal(
      text(tree.container).includes('Switch User Account'),
      false,
      'the next Escape closes the account menu'
    );

    assert.equal(handles.tabRenders, 1, 'closing overlays must not re-render the tab tree');
    tree.unmount();
  });

  test('closing an overlay hands focus back to the control that opened it', () => {
    const handles = createShellHandles();
    const tree = mountTree(h(ShellProbe, { handles }));
    const press = (init: KeyboardEventInit) =>
      inAct(() => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', init));
      });
    /** Never `assert.equal(activeElement, node)`: a DOM node in the failure diff
     *  carries React's circular fiber pointer and exhausts the heap. */
    const activeIs = (element: HTMLElement | null) => document.activeElement === element;

    // Search, opened from the header search box: focus returns to the field the
    // user was in, not to <body>.
    const searchInput = query(tree.container, 'input[data-shell-trigger="search"]');
    inAct(() => searchInput.focus());
    inAct(() => (searchInput.parentElement as HTMLElement).click());
    assert.equal(searchOverlayOpen(tree.container), true, 'precondition: search is open');
    press({ key: 'Escape' });
    assert.equal(searchOverlayOpen(tree.container), false);
    assert.equal(activeIs(searchInput), true, 'Escape returns focus to the header search field');

    // Notification drawer, opened from the bell: focus returns to the bell even
    // when it is closed by something other than Escape.
    const bell = buttonByTitle(tree.container, 'Notifications');
    assert.ok(bell, 'the header notification bell must be rendered');
    inAct(() => bell.focus());
    inAct(() => bell.click());
    assert.ok(text(tree.container).includes('Notification Center'));
    inAct(() => window.dispatchEvent(new Event(NAVIGATE_TAB_EVENT)));
    assert.equal(text(tree.container).includes('Notification Center'), false);
    assert.equal(activeIs(bell), true, 'closing the drawer returns focus to the bell');

    // Profile modal, opened from a menu item that unmounts with the menu: the
    // recorded origin is gone, so focus falls back to the profile chip.
    const chip = query(tree.container, '[data-shell-trigger="profile"]');
    inAct(() => chip.focus());
    inAct(() => chip.click());
    inAct(() => (document.activeElement as HTMLElement | null)?.blur());
    inAct(() => buttonByText(tree.container, 'Account Settings').click());
    assert.ok(text(tree.container).includes('Switch Profile'), 'precondition: profile modal open');
    press({ key: 'Escape' });
    assert.equal(text(tree.container).includes('Switch Profile'), false);
    assert.equal(activeIs(chip), true, 'the profile chip takes focus back');

    // Barcode scanner from Alt+B while nothing is focused: the header's camera
    // button is the standing trigger, so that is where focus goes.
    inAct(() => (document.activeElement as HTMLElement | null)?.blur());
    press({ key: 'b', altKey: true });
    assert.ok(text(tree.container).includes('Barcode & Serial Scanner'));
    press({ key: 'Escape' });
    assert.equal(
      activeIs(query(tree.container, '[data-shell-trigger="barcode"]')),
      true,
      'the barcode trigger takes focus back'
    );

    assert.equal(handles.tabRenders, 1, 'focus restoration must not re-render the tab tree');
    tree.unmount();
  });

  test('a data change still reaches the workspace (the tree is not frozen)', () => {
    const handles = createShellHandles();
    const tree = mountTree(h(ShellProbe, { handles }));
    assert.equal(handles.tabRenders, 1);
    assert.equal(query(tree.container, '[data-tab-tree]').textContent, 'tabs:2');

    // This is App re-rendering because DATA changed, not the shell.
    inAct(() => handles.api!.setRows([1, 2, 3]));
    assert.equal(handles.tabRenders, 2, 'a data change must re-render the tab tree');
    assert.equal(query(tree.container, '[data-tab-tree]').textContent, 'tabs:3');
    assert.equal(query(tree.container, '[data-banners]').getAttribute('data-banners'), '3');

    tree.unmount();
  });
});

describe('A2 — the root does not grow the shell state back', () => {
  test('App owns no shell flag and renders the workspace inside AppShell', () => {
    // The measurement above proves the behaviour; this pins the shape that
    // makes it true, so a later change cannot quietly move the state back into
    // the root (where every toggle would re-render the tab tree again).
    const appSource = fs.readFileSync(path.resolve(process.cwd(), 'client/src/App.tsx'), 'utf8');
    for (const flag of [
      'isSidebarOpen',
      'isBarcodeModalOpen',
      'isGlobalSearchOpen',
      'isNotificationOpen',
      'isProfileModalOpen',
      'dismissedNotificationIds',
    ]) {
      assert.equal(
        appSource.includes(flag),
        false,
        `App.tsx must not own ${flag} — that is shell state (AppShell)`
      );
    }
    assert.ok(appSource.includes('<AppShell'), 'App must render the shell');

    const shellSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client/src/components/layout/AppShell.tsx'),
      'utf8'
    );
    assert.ok(shellSource.includes('useState'), 'AppShell must own the shell state');
  });
});
