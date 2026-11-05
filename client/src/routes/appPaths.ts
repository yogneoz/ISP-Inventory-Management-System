/**
 * Canonical workspace paths.
 *
 * The app used to keep the active screen only in React state and mirror it as
 * `?tab=<id>`. That made every screen reachable from one URL shape and left the
 * path meaningless. This table is the single, typed mapping from a `NavTab` to
 * the path that screen owns.
 *
 * Rules (keep them when a screen is added):
 *   1. One path per rendered screen. Screen segments are stable and lowercase
 *      with no trailing slash; record ids keep their stored case. A copied URL
 *      is the same URL after a refresh.
 *   2. A path names the work, not the component file: `/purchasing/invoices/new`
 *      rather than `/create-purchase`.
 *   3. Authentication and permissions are NOT encoded here. The root still
 *      resolves the path to a tab, then runs the same `isTabAccessible` rule
 *      before the screen is allowed to render. A URL never grants access.
 *   4. `?tab=` stays supported as a legacy input and is redirected to the
 *      canonical path. New links must use the path.
 *   5. A record screen may add one child segment (`/sales/invoices/INV-1`) or
 *      an edit child (`/purchasing/orders/PO-1/edit`). Static child screens
 *      (for example `/inventory/assets/assign`) always win over a record id.
 */
import type { NavTab } from '../components/layout/Sidebar';

/** Legacy query parameter. Read and removed; never written by new navigation. */
export const TAB_URL_PARAM = 'tab';
/** The two Users-register filter params, owned by that screen. */
export const ACCESS_FILTER_URL_PARAM = 'access';
export const OPERATION_FILTER_URL_PARAM = 'operation';

/**
 * Canonical path for every `NavTab`.
 *
 * `workflow-approval` is a retired tab id still emitted by older notification
 * actions and saved preferences. It aliases the live Approval Center below.
 */
export const APP_PATHS: Record<NavTab, string> = {
  dashboard: '/dashboard',
  approvals: '/approvals',
  'workflow-approval': '/approvals',

  'all-stock': '/inventory/stock',
  'branch-stock': '/inventory/stock/branches',
  'reorder-stock': '/inventory/stock/reorder',
  'damaged-stock': '/inventory/stock/damaged',
  'stock-valuation': '/inventory/stock/valuation',
  'stock-ledger': '/inventory/stock/ledger',
  'physical-stock-audit': '/inventory/stock/audits',
  'fixed-assets': '/inventory/assets',
  'product-master': '/inventory/products',
  'opening-stock': '/inventory/opening-stock',
  'category-management': '/inventory/categories',
  'product-group-management': '/inventory/product-groups',
  'uom-management': '/inventory/uom',
  'import-stock': '/inventory/stock/import',
  'export-stock': '/inventory/stock/export',
  'create-transfer': '/inventory/transfers/new',
  'receive-branch-transfer': '/inventory/transfers/receive',
  pullout: '/inventory/pullouts/new',
  'pullout-report': '/inventory/pullouts',
  damage: '/inventory/damage/new',
  'damage-report': '/inventory/damage',
  'assign-asset': '/inventory/assets/assign',
  'asset-deployments': '/inventory/assets/deployments',
  'consumable-issue': '/inventory/consumables/issue',
  'consumables-register': '/inventory/consumables',
  'device-exchange': '/inventory/exchange',

  'create-po': '/purchasing/orders/new',
  'po-list': '/purchasing/orders',
  'create-purchase': '/purchasing/invoices/new',
  'purchase-list': '/purchasing/invoices',
  'purchase-returns': '/purchasing/returns',
  'create-purchase-return': '/purchasing/returns/new',
  'create-shipment': '/purchasing/shipments/new',
  'receive-shipment': '/purchasing/shipments/receive',
  'shipment-list': '/purchasing/shipments',
  suppliers: '/purchasing/suppliers',

  'create-sale': '/sales/invoices/new',
  'sales-list': '/sales/invoices',
  'sales-returns': '/sales/returns',
  'create-sales-return': '/sales/returns/new',
  customers: '/sales/customers',
  'sales-agents-areas': '/sales/agents-areas',
  'import-customers': '/sales/customers/import',
  'customer-devices': '/sales/customer-devices',
  'complete-serial-inventory': '/serial-register',

  accounting: '/finance/accounting',
  'accounting-profit-loss': '/finance/accounting/profit-loss',
  'accounting-balance-sheet': '/finance/accounting/balance-sheet',
  'accounting-cash-book': '/finance/accounting/cash-book',
  'accounting-aging': '/finance/accounting/aging',
  'journal-entry': '/finance/accounting/journal-entry',
  'cash-bank-entry': '/finance/accounting/cash-bank-entry',
  'accounting-chart': '/finance/accounting/chart',
  'general-ledger': '/finance/accounting/general-ledger',
  subledgers: '/finance/accounting/subledgers',
  'bill-terms': '/finance/accounting/bill-terms',
  'cost-centers': '/finance/accounting/cost-centers',
  'narration-templates': '/finance/accounting/narrations',
  'cash-position': '/finance/cash-close',
  'financial-statements': '/finance/overview',
  'customer-ledger': '/finance/ledger/customers',
  'vendor-ledger': '/finance/ledger/vendors',
  'vendor-opening-balances': '/finance/opening-balances',
  'vat-register': '/finance/vat',
  'depreciation-register': '/finance/depreciation',
  audit: '/finance/audit',
  'fiscal-year-management': '/fiscal/document-numbering',
  'fiscal-year-closing': '/fiscal/closing',
  'nepali-fiscal': '/fiscal',
  'bs-calendar': '/fiscal/calendar',

  'supplier-warranty': '/warranties/supplier',
  'seller-warranty': '/warranties/seller',

  users: '/settings/users',
  permissions: '/settings/permissions',
  'user-permissions': '/settings/user-permissions',
  branches: '/settings/branches',
  locations: '/settings/locations',
  'company-setup': '/settings/company',
  'data-recalculation': '/settings/maintenance',
  'clear-demo-data': '/settings/demo-data',

  'help-documentation': '/help',
  'dev-statcard': '/dev/statcards',
};

/**
 * Retired tab ids that still exist in saved preferences, notification payloads
 * or older links. Navigation normalises them to the live screen they name.
 */
export const TAB_ALIASES: Partial<Record<NavTab, NavTab>> = {
  'workflow-approval': 'approvals',
};

/** The live screen a tab id names. */
export function canonicalTab(tab: NavTab): NavTab {
  return TAB_ALIASES[tab] ?? tab;
}

/** Path owned by a tab (aliases return their live screen's path). */
export function pathForTab(tab: NavTab): string {
  return APP_PATHS[canonicalTab(tab)] || APP_PATHS.dashboard;
}

/** One open record below a register screen. */
export type RecordRoute =
  | { kind: 'create' }
  | { kind: 'detail'; id: string }
  | { kind: 'edit'; id: string };

export type RecordScreenTab =
  | 'sales-list'
  | 'purchase-list'
  | 'po-list'
  | 'sales-returns'
  | 'purchase-returns'
  | 'shipment-list'
  | 'receive-branch-transfer'
  | 'customers'
  | 'users'
  | 'fixed-assets';

interface RecordScreenSpec {
  base: string;
  kinds: readonly RecordRoute['kind'][];
}

/**
 * Registers that own a record child path. The tab's own `APP_PATHS` entry is
 * the register; a child segment addresses one record, never a second screen.
 */
export const RECORD_SCREENS: Record<RecordScreenTab, RecordScreenSpec> = {
  'sales-list': { base: '/sales/invoices', kinds: ['detail'] },
  'purchase-list': { base: '/purchasing/invoices', kinds: ['detail'] },
  'po-list': { base: '/purchasing/orders', kinds: ['detail', 'edit'] },
  'sales-returns': { base: '/sales/returns', kinds: ['detail'] },
  'purchase-returns': { base: '/purchasing/returns', kinds: ['detail'] },
  'shipment-list': { base: '/purchasing/shipments', kinds: ['detail'] },
  'receive-branch-transfer': { base: '/inventory/transfers/receive', kinds: ['detail'] },
  customers: { base: '/sales/customers', kinds: ['detail'] },
  users: { base: '/settings/users', kinds: ['create', 'edit'] },
  'fixed-assets': { base: '/inventory/assets', kinds: ['create', 'detail'] },
};

/** True when `record` is a child route this tab's screen can render. */
export function isRecordRouteForTab(tab: NavTab, record: RecordRoute | null): boolean {
  if (!record) return false;
  const spec = RECORD_SCREENS[tab as RecordScreenTab];
  return Boolean(spec && spec.kinds.includes(record.kind));
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** Canonical child path for a record, or the register path when it is invalid. */
export function recordPathFor(tab: NavTab, record: RecordRoute): string {
  const nextTab = canonicalTab(tab);
  const spec = RECORD_SCREENS[nextTab as RecordScreenTab];
  if (!spec || !spec.kinds.includes(record.kind)) return pathForTab(nextTab);
  if (record.kind === 'create') return `${spec.base}/new`;
  const id = encodeURIComponent(record.id);
  if (record.kind === 'edit') return `${spec.base}/${id}/edit`;
  return `${spec.base}/${id}`;
}

/**
 * The record a pathname addresses, preserving the id's case. Static child
 * paths (assign asset, deployments) are resolved by `tabFromPath` first.
 */
export function recordFromPath(
  pathname: string
): { tab: RecordScreenTab; record: RecordRoute } | null {
  const clean = stripTrailingSlash(pathname);
  const lower = clean.toLowerCase();

  for (const tab of Object.keys(RECORD_SCREENS) as RecordScreenTab[]) {
    const spec = RECORD_SCREENS[tab];
    const prefix = `${spec.base}/`;
    if (!lower.startsWith(prefix)) continue;

    const rest = clean.slice(prefix.length).split('/').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    if (rest.some((part) => !part)) return null;

    if (rest.length === 1 && rest[0].toLowerCase() === 'new') {
      return spec.kinds.includes('create') ? { tab, record: { kind: 'create' } } : null;
    }
    if (rest.length === 2 && rest[1].toLowerCase() === 'edit') {
      return spec.kinds.includes('edit')
        ? { tab, record: { kind: 'edit', id: rest[0] } }
        : null;
    }
    if (rest.length === 1 && spec.kinds.includes('detail')) {
      return { tab, record: { kind: 'detail', id: rest[0] } };
    }
    return null;
  }
  return null;
}

/**
 * Collapse case and trailing slashes before matching. The address bar is then
 * rewritten to the canonical spelling, so `/Dashboard/` and `/dashboard` do
 * not become two bookmarks for one screen.
 */
export function normalizePathname(pathname: string): string {
  return (stripTrailingSlash(pathname) || '/').toLowerCase();
}

const PATH_TO_TAB = new Map<string, NavTab>(
  (Object.keys(APP_PATHS) as NavTab[])
    .filter((tab) => canonicalTab(tab) === tab)
    .map((tab) => [APP_PATHS[tab], tab])
);

/** The live tab a pathname names, or null when it is not a workspace route. */
export function tabFromPath(pathname: string): NavTab | null {
  const exact = PATH_TO_TAB.get(normalizePathname(pathname));
  if (exact) return exact;
  return recordFromPath(pathname)?.tab ?? null;
}

export function isNavTab(value: string | null | undefined): value is NavTab {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_PATHS, value);
}

/** Reads the retired `?tab=` parameter, normalising an alias to its live tab. */
export function tabFromLegacyTabParam(search: string): NavTab | null {
  const requested = new URLSearchParams(search).get(TAB_URL_PARAM);
  return isNavTab(requested) ? canonicalTab(requested) : null;
}

function isRootPath(pathname: string): boolean {
  return normalizePathname(pathname) === '/';
}

export type InitialTabSource =
  | 'path'
  | 'legacy-tab'
  | 'legacy-filters'
  | 'saved'
  | 'default';

export interface InitialTabRoute {
  tab: NavTab;
  /** True when the URL named a screen; server preferences must not override it. */
  fromUrl: boolean;
  source: InitialTabSource;
  /** A record child path, when the URL addressed one. */
  record?: RecordRoute;
}

/**
 * Resolve the first screen for a page load.
 *
 * Priority: canonical path, then a legacy `?tab=`, then an old Users filter
 * link on `/`, then the saved tab, then Dashboard. `fromUrl` lets the root
 * protect a deep link from the one-shot preference hydration.
 */
export function resolveInitialTab(
  pathname: string,
  search: string,
  savedTab: string | null | undefined
): InitialTabRoute {
  const pathTab = tabFromPath(pathname);
  if (pathTab) {
    // A static child screen (assign, receive, import, new) wins over record
    // parsing, so it must not inherit a record that belongs to the register
    // sharing its path prefix.
    const parsed = recordFromPath(pathname);
    const record = parsed && parsed.tab === pathTab ? parsed.record : null;
    return record
      ? { tab: pathTab, fromUrl: true, source: 'path', record }
      : { tab: pathTab, fromUrl: true, source: 'path' };
  }

  const legacyTab = tabFromLegacyTabParam(search);
  if (legacyTab) return { tab: legacyTab, fromUrl: true, source: 'legacy-tab' };

  const params = new URLSearchParams(search);
  if (
    isRootPath(pathname) &&
    (params.has(ACCESS_FILTER_URL_PARAM) || params.has(OPERATION_FILTER_URL_PARAM))
  ) {
    return { tab: 'users', fromUrl: true, source: 'legacy-filters' };
  }

  if (isNavTab(savedTab)) return { tab: canonicalTab(savedTab), fromUrl: false, source: 'saved' };
  return { tab: 'dashboard', fromUrl: false, source: 'default' };
}

/** The tab a browser Back/Forward entry names, including a legacy `?tab=`. */
export function tabFromLocation(pathname: string, search: string): NavTab | null {
  return tabFromPath(pathname) ?? tabFromLegacyTabParam(search);
}

/**
 * Build the canonical URL for a tab (or one of its records), preserving
 * unrelated query state and the hash. The Users register keeps its own
 * `access`/`operation` filters; every other screen drops them so a copied link
 * cannot describe filters that are not on screen. `?tab=` is always removed.
 */
export function canonicalLocationUrl(
  tab: NavTab,
  record: RecordRoute | null,
  href: string
): string {
  const url = new URL(href, 'http://localhost');
  const nextTab = canonicalTab(tab);
  url.pathname =
    record && isRecordRouteForTab(nextTab, record)
      ? recordPathFor(nextTab, record)
      : pathForTab(nextTab);
  url.searchParams.delete(TAB_URL_PARAM);
  if (nextTab !== 'users') {
    url.searchParams.delete(ACCESS_FILTER_URL_PARAM);
    url.searchParams.delete(OPERATION_FILTER_URL_PARAM);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Tab-only canonical URL. */
export function canonicalTabUrl(tab: NavTab, href: string): string {
  return canonicalLocationUrl(tab, null, href);
}
