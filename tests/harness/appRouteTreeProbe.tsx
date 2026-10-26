/**
 * A6 route-tree smoke harness.
 *
 * Renders the REAL `App` through the same providers `main.tsx` uses, with the
 * `api` singleton's methods replaced by fixtures, so the tab tree is exercised
 * the way a browser mounts it — not as a synthetic probe tree. The test that
 * uses this proves the `KeepMounted` contract at the route level: switching
 * tabs hides the screen but must not unmount it (draft state and the DOM node
 * survive), and coming back must not remount it.
 *
 * Why the api object and not a module mock: every screen imports the same
 * `api` object and calls its methods at call time, so replacing the methods
 * keeps the real screens, real hooks and real route tree in the test while
 * making the run offline and deterministic. The stubs are restored afterwards.
 */
import './dom';
import React from 'react';
import { act } from 'react';
import App from '../../client/src/App';
import { AppProviders } from '../../client/src/contexts/AppProviders';
import { api } from '../../client/src/services/api';
import { NAVIGATE_TAB_EVENT } from '../../client/src/services/api/http';
import { saveUserSession } from '../../client/src/utils/sessionCache';
import type { User } from '../../client/src/types';
import { mountTree, type MountedTree } from './mount';

const companyProfile = {
  id: 'company-smoke',
  name: 'Smoke Test Networks',
  address: 'Kathmandu, Nepal',
  phone: '9800000000',
  email: 'smoke@example.com',
  panNumber: '000000000',
  currencyCode: 'NPR',
  currencySymbol: 'NPR',
  currencyLocale: 'en-IN',
  currencyPosition: 'before',
  currencyDecimals: 2,
  defaultTaxRate: 13,
};

const fiscalYears = [
  {
    id: 'fy-smoke',
    name: '2083/84',
    startDateBS: '2083-04-01',
    endDateBS: '2084-03-31',
    startDateAD: '2026-07-17',
    endDateAD: '2027-07-16',
    isCurrent: true,
  },
];

/** Deliberately empty operational arrays: the smoke test only needs the tree. */
export const bootstrapFixture = {
  dataVersion: 7,
  branches: [
    { id: 'ALL', code: 'ALL', name: 'All Branches (Consolidated)', address: '' },
    { id: 'WH001', code: 'WH001', name: 'Warehouse', address: 'Kathmandu' },
  ],
  suppliers: [],
  users: [],
  products: [],
  categories: [],
  stock: [],
  assets: [],
  customerDevices: [],
  customers: [],
  approvalRequests: [],
  purchaseOrders: [],
  purchaseInvoices: [],
  salesInvoices: [],
  purchaseReturns: [],
  salesReturns: [],
  shipments: [],
  stockOperations: [],
  fiscalYears,
  auditLogs: [],
  damageRecords: [],
  locations: [],
  financialSummary: {
    totalInventoryAssetValue: 0,
    totalFixedAssetValue: 0,
    totalAccountsPayable: 0,
    totalSalesRevenue: 0,
    totalCostOfGoodsSold: 0,
    totalDamageLossValue: 0,
    totalVatInputTax: 0,
    currentFiscalYear: '2083/84',
  },
  companyProfile,
  postgresDatabaseStatus: {
    isConnected: true,
    host: 'localhost',
    port: 5432,
    database: 'inventory_db',
    user: 'inventory_user',
  },
  permissionsMatrix: {},
  appSettings: {},
  userPreferences: { activeTab: 'assign-asset', dateMode: 'AD', theme: 'light' },
};

const smokeUser = {
  id: 'u-smoke',
  name: 'Smoke Admin',
  email: 'smoke@example.com',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  isActive: true,
} as unknown as User;

type AnyApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

const API_STUBS: AnyApi = {
  getBootstrapState: async () => bootstrapFixture,
  getLocalFor: async () => ({ slice: undefined }),
  getSettings: async () => ({ settings: {}, preferences: {} }),
  getBsCalendarYears: async () => [],
  getSerialLogs: async () => [],
  getStock: async () => [],
  getCustomerDevices: async () => [],
  getStockOperations: async () => [],
  searchCustomers: async () => ({ data: [], total: 0, page: 1, pageSize: 20 }),
  savePreferences: async () => ({}),
  saveAppSettings: async () => ({}),
};

/** Seeds the signed-in SUPER_ADMIN session and the last tab, as a browser would have. */
export function seedSession(tab = 'assign-asset'): void {
  saveUserSession(smokeUser, smokeUser, 'smoke-token');
  localStorage.setItem('inventory_active_tab', tab);
}

/** Replaces the api methods the mounted tree calls; returns the restore function. */
export function installApiStubs(): () => void {
  const target = api as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const [name, stub] of Object.entries(API_STUBS)) {
    originals.set(name, target[name]);
    target[name] = stub;
  }
  return () => {
    for (const [name, original] of originals) target[name] = original;
  };
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

/** jsdom has no EventSource; the shell subscribes on mount. */
export function installEventSource(): () => void {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const original = globalRecord.EventSource;
  globalRecord.EventSource = FakeEventSource;
  return () => {
    globalRecord.EventSource = original;
  };
}

export interface AppRouteTree {
  tree: MountedTree;
  unmount: () => void;
}

/**
 * Renders the real App inside the exact provider composition main.tsx uses
 * (no StrictMode, so effects run once and the render is deterministic).
 */
export function mountAppRouteTree(): MountedTree {
  return mountTree(
    <AppProviders>
      <App />
    </AppProviders>
  );
}

/** Flushes pending microtasks inside act() so mounted effects settle. */
export async function settle(ticks = 6): Promise<void> {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Settles until `predicate` holds (bounded), so lazy screens have time to load. */
export async function settleUntil(predicate: () => boolean, attempts = 12): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await settle();
    if (predicate()) return true;
  }
  return predicate();
}

/** The app's own navigation path (the toast "open tab" event), not a sidebar click. */
export function navigateTab(tab: string): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(NAVIGATE_TAB_EVENT, { detail: { tab } }));
  });
}

export function findInputByPlaceholder(
  container: HTMLElement,
  placeholder: string
): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
}

/** Sets a controlled input's value through the native setter + input event React listens for. */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * True when the node is inside a hidden keep-mounted tab.
 *
 * KeepMounted hides a tab with BOTH `display: none` and `aria-hidden`, so either
 * marker is enough. Deliberately does not consult `offsetParent`: jsdom has no
 * layout, so it is always null and the check would pass (or fail) vacuously.
 */
export function isHidden(node: HTMLElement): boolean {
  return Boolean(node.closest('[aria-hidden="true"], [style*="display: none"]'));
}
