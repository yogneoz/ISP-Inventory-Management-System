/**
 * The route table and its renderer.
 *
 * A4: every tab is now declared exactly once, as an `AppRoute` entry created by
 * `screenRoute(key, element)`, and `AppRoutes` is the only place the route-level
 * `KeepMountedRoot` / `KeepMounted` wiring exists. The root hands over the table
 * and the active tab; it no longer contains the tab tree itself.
 *
 * The semantics are deliberately identical to the inline tree this replaced:
 *  - a tab that has never been active renders nothing (no chunk fetch, no
 *    screen mount),
 *  - after its first activation it stays mounted and is only hidden, so drafts
 *    and scroll positions survive (pinned by tests/appRouteTree.test.ts),
 *  - permission metadata rides on the entry (`permission` / `superAdminOnly`)
 *    from the same tables the navigation guard reads, so access and declaration
 *    cannot drift,
 *  - `enabled` covers the one non-permission condition (the DEV-only gallery),
 *    without teaching AppRoutes about Vite.
 */
import React from 'react';
import { KeepMounted, KeepMountedRoot } from '../components/common/KeepMounted';
import type { NavTab } from '../components/layout/Sidebar';
import { SUPER_ADMIN_ONLY_TABS, TAB_PERMISSIONS } from './tabPermissions';

export interface AppRoute {
  key: NavTab;
  /** The screen element, created by the root from its data props. */
  element: React.ReactNode;
  /** RBAC operation(s) the tab requires, mirrored from TAB_PERMISSIONS. */
  permission?: string | string[];
  /** True when the tab is in SUPER_ADMIN_ONLY_TABS. */
  superAdminOnly: boolean;
  /** False for a route that must not render in this build (DEV-only gallery). */
  enabled: boolean;
}

export function screenRoute(
  key: NavTab,
  element: React.ReactNode,
  options: { enabled?: boolean } = {}
): AppRoute {
  return {
    key,
    element,
    permission: TAB_PERMISSIONS[key],
    superAdminOnly: SUPER_ADMIN_ONLY_TABS.includes(key),
    enabled: options.enabled !== false,
  };
}

/**
 * Renders the declared routes through the keep-mounted container.
 *
 * Note: permission metadata is declarative here, not a render gate — the app
 * has always mounted a tab that was once visible regardless of a later matrix
 * change, and gating the render would silently change that (a permission edit
 * would unmount a form mid-edit). Navigation is gated in App before the tab is
 * ever activated.
 */
export const AppRoutes: React.FC<{ activeTab: NavTab; routes: readonly AppRoute[] }> = ({
  activeTab,
  routes,
}) => (
  <KeepMountedRoot activeTab={activeTab}>
    {(visible) => (
      <>
        {routes.map((route) => (
          <KeepMounted
            key={route.key}
            visible={visible[route.key] === true && route.enabled}
          >
            {route.element}
          </KeepMounted>
        ))}
      </>
    )}
  </KeepMountedRoot>
);
