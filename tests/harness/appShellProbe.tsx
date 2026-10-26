/**
 * A2 probe: the real AppShell, with a counting stand-in for the tab tree.
 *
 * `ShellProbe` is shaped like App: it owns the DATA (`rows`) and renders the
 * workspace as an element passed to AppShell. Everything shell-only — sidebar,
 * modals, notifications, dismissed ids — lives inside AppShell, exactly as it
 * does in the shipped app. Counting `TabTree` renders therefore measures what
 * App's tab tree would do.
 */
import { createElement as h, useState } from 'react';
import type { User } from '../../client/src/types';
import { AppShell } from '../../client/src/components/layout/AppShell';
import type { AppShellProps } from '../../client/src/components/layout/AppShell';
import { DarkModeProvider } from '../../client/src/contexts/DarkModeContext';

export interface ShellHandles {
  /** How many times the stand-in tab tree's body ran. */
  tabRenders: number;
  /** Tabs requested through the shell's onSelectTab. */
  selectedTabs: string[];
  /** Set on every host render so the test can change DATA (not shell) state. */
  api: { setRows: (rows: number[]) => void } | null;
}

export function createShellHandles(): ShellHandles {
  return { tabRenders: 0, selectedTabs: [], api: null };
}

const SUPER_ADMIN: User = {
  id: 'u-root',
  email: 'root@example.test',
  name: 'Root Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
};

const noop = () => undefined;
const asyncNoop = async () => undefined;

function shellProps(handles: ShellHandles): Omit<AppShellProps, 'banners' | 'children'> {
  return {
    companyProfile: null,
    currentUser: SUPER_ADMIN,
    rootUser: null,
    users: [SUPER_ADMIN],
    onSwitchBackToRoot: asyncNoop,
    onSwitchProfile: asyncNoop,
    onUpdateProfile: asyncNoop,
    onLogout: noop,
    onLogin: asyncNoop,
    refreshAllData: noop,
    permissionsVersion: 0,
    onToggleTheme: noop,
    branches: [],
    selectedBranchId: 'ALL',
    onSelectBranch: noop,
    dateMode: 'BS',
    onToggleDateMode: noop,
    currentFiscalYear: '2082/83',
    fiscalYears: [],
    selectedFiscalYearId: '',
    onSelectFiscalYear: noop,
    activeTab: 'dashboard',
    onSelectTab: (tab) => handles.selectedTabs.push(tab),
    searchQuery: '',
    onSearchChange: noop,
    products: [],
    stock: [],
    purchaseOrders: [],
    purchaseInvoices: [],
    pendingPurchaseOrders: [],
    unpaidBillCount: 0,
    shipments: [],
    stockOperations: [],
    approvalRequests: [],
    assets: [],
    suppliers: [],
    bsCalendarCoverage: null,
    bsCalendarSeedTab: 'bs-calendar',
  };
}

function TabTree({ rows, handles }: { rows: number[]; handles: ShellHandles }) {
  handles.tabRenders += 1;
  return h('div', { 'data-tab-tree': rows.length }, `tabs:${rows.length}`);
}

export function ShellProbe({ handles }: { handles: ShellHandles }) {
  const [rows, setRows] = useState<number[]>([1, 2]);
  handles.api = { setRows };

  return h(
    DarkModeProvider,
    null,
    h(AppShell, {
      ...shellProps(handles),
      banners: h('div', { 'data-banners': rows.length }),
      // The workspace element is built HERE (like App does), so AppShell's own
      // state changes can never rebuild it.
      children: h('main', { 'data-workspace': true }, h(TabTree, { rows, handles })),
    })
  );
}
