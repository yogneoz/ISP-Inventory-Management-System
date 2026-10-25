/**
 * A4 probe: renders a small stub route table through the real `AppRoutes`, so
 * the registry's own semantics (enabled routes, never-active tabs, keep-mounted
 * switching) can be tested without the app's data props.
 */
import './dom';
import React from 'react';
import { mountTree, type MountedTree } from './mount';
import { AppRoutes, screenRoute, type AppRoute } from '../../client/src/routes/appRoutes';
import type { NavTab } from '../../client/src/components/layout/Sidebar';

const STUB_ROUTES: AppRoute[] = [
  screenRoute('dashboard', <span data-testid="dash">dashboard-body</span>),
  screenRoute('customers', <span data-testid="customers">customers-body</span>),
  // An `enabled: false` route stands in for the DEV-only gallery in production.
  screenRoute('dev-statcard', <span data-testid="dev">dev-body</span>, { enabled: false }),
];

export function stubRoutesElement(activeTab: NavTab): React.ReactElement {
  return <AppRoutes activeTab={activeTab} routes={STUB_ROUTES} />;
}

export function mountStubRoutes(activeTab: NavTab): MountedTree {
  return mountTree(stubRoutesElement(activeTab));
}
