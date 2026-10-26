/**
 * Unit tests for the SSE domain → paged-register refresh mapping
 * (node:test). Pins which self-fetching paged registers (Serial Log,
 * Purchase Orders, Purchase Invoices, the consumable register inside
 * StockOperations, the shared Returns Register and Sales Invoices)
 * re-run their fetch for each SSE domain, so a
 * register can never silently miss a mutation the bootstrap slices
 * don't cover.
 *
 * Also source-guards the components themselves: the tabs that render
 * bootstrap props only are pinned to ZERO api calls, and every
 * self-fetching register (Purchase Orders, Purchase Invoices, Serial Log,
 * the Returns Register, Sales Invoices, plus the two StockOperations
 * hosts) has its allowed api surface AND its
 * refresh-key wiring pinned, so a new fetch that is not wired to a
 * register key fails the suite instead of shipping a stale tab.
 *
 * The feature-screen coverage guard then pins EVERY screen under
 * client/src/features to its exact server-call surface (api.* methods AND
 * named services/api imports), proves raw fetch cannot bypass the pins,
 * and proves server-paged fetches exist only in the six wired registers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DOMAIN_REGISTER_KEYS,
  SERIAL_REGISTER_DOMAINS,
  bumpAllRegisterRefresh,
  domainsTouchSerialRegister,
  SseDomainBurst,
  type RegisterRefreshKey,
} from '../client/src/utils/registerRefreshDomains';
import { DOMAIN_BY_MODULE, resolveDomain } from '../server/src/syncDomains';
import { DOCS_FILES, checkScreenClaims } from '../scripts/docsTestCounts';

// The complete register vocabulary kept in App.tsx's registerRefresh state.
const REGISTER_KEYS = ['serialLog', 'purchaseOrders', 'purchaseInvoices', 'consumableRegister', 'returnsRegister', 'salesInvoices', 'customerDevices', 'transactionLog'];

// Server domains whose mutations never touch any of the paged
// registers: they refresh bootstrap slices only. Kept in sync by the
// "declared no-register" test below — a new server domain must either
// gain a DOMAIN_REGISTER_KEYS entry or be listed here.
const NO_REGISTER_DOMAINS = [
  'MASTER_DATA', 'CATEGORIES', 'PRODUCTS', 'FISCAL', 'USERS',
  'APPROVALS', 'COMPANY_PROFILE',
  'PERMISSIONS', 'SETTINGS', 'AUDIT',
  // BS_CALENDAR mutates no paged register: a seed/repair changes the
  // AD<->BS mapping every screen converts with, so App.tsx re-reads the
  // calendar mirror instead (DOMAIN_STATE_KEYS.BS_CALENDAR is deliberately
  // empty for the same reason — there is no bootstrap slice to re-fetch).
  'BS_CALENDAR',
];

// ---------------------------------------------------------------------------
// Source-guard helpers, shared by both guard describes below. Every helper
// reads the real files, so an added fetch or a dropped refresh-key wiring
// in App.tsx fails the suite.
// ---------------------------------------------------------------------------

/** A client feature component's source, path relative to client/src/features. */
const readFeatureSource = (relPath: string) =>
  fs.readFileSync(
    path.resolve(process.cwd(), 'client', 'src', 'features', relPath),
    'utf8'
  );

/** App.tsx's source — where every register render site and its wiring lives. */
const readAppSource = () =>
  fs.readFileSync(path.resolve(process.cwd(), 'client', 'src', 'App.tsx'), 'utf8');

/** Every distinct api.<method> referenced in a source file. */
const apiCallsIn = (source: string) =>
  [...new Set([...source.matchAll(/api\.[A-Za-z][A-Za-z0-9]*/g)].map((m) => m[0]))]
    .map((call) => call.slice('api.'.length))
    .sort();

/** useEffect call sites only (the hook import does not count). */
const useEffectCount = (source: string) =>
  [...source.matchAll(/^\s*useEffect\(/gm)].length;

/** Every JSX render site of `tag` in App.tsx, as a block of its props. */
const jsxBlocks = (appSource: string, tag: string) =>
  appSource.match(new RegExp(`<${tag}\\b[\\s\\S]*?/>`, 'g')) ?? [];

/**
 * The api.* allowlists only hold if a component cannot fetch around them:
 * no raw fetch(), no axios, no second EventSource. None appear in the
 * pinned files today, so any occurrence is a new (unpinned) data path.
 */
const assertNoRawFetch = (source: string, label: string) => {
  const bypass = source.match(/\bfetch\s*\(|\baxios\b|\bEventSource\s*\(/g) ?? [];
  assert.deepEqual(bypass, [], `${label} must fetch only through its pinned api.* surface`);
};

/**
 * Every App.tsx render site of `tag` must pass `prop` exactly once — a newly
 * added unwired mount (or a counter attached to the wrong component) fails
 * here. Counted per render site, not app-wide: since DF-14 a counter can
 * legitimately feed two different components (the purchase-invoice counter
 * also refreshes the vendor ledger), so a global tally would flag the shared
 * expression instead of a missing one.
 */
const assertEveryRenderSiteWired = (tag: string, prop: RegExp) => {
  const appSource = readAppSource();
  const blocks = jsxBlocks(appSource, tag);
  assert.ok(blocks.length > 0, `no <${tag} render sites found in App.tsx`);
  for (const block of blocks) {
    assert.match(block, prop, `a <${tag} render site in App.tsx is missing ${prop.source}`);
  }
  const propCount = blocks.reduce(
    (sum, block) => sum + [...block.matchAll(new RegExp(prop.source, 'g'))].length,
    0
  );
  assert.equal(
    propCount,
    blocks.length,
    `${prop.source} appears ${propCount} time(s) across the <${tag} render sites — every render site must be wired exactly once`
  );
};

/** Every .tsx screen under client/src/features, as a '/'-relative path. */
const listFeatureScreens = (): string[] => {
  const root = path.resolve(process.cwd(), 'client', 'src', 'features');
  const screens: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) {
        screens.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return screens.sort();
};

/**
 * Named fetch helpers imported straight from services/api — the bypass a
 * bare api.* scan misses (FinancialStatements.tsx imports getFinancialSummary
 * instead of calling api.getFinancialSummary). The `api` namespace import
 * itself is not a call.
 */
const namedApiImportsIn = (source: string) => {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*services\/api[^']*'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/\/\*[\s\S]*?\*\//g, '').split(/\s+as\s+/)[0].trim();
      if (name && name !== 'api') names.push(name);
    }
  }
  return [...new Set(names)].sort();
};

/** Every server call a screen may make: api.* methods AND named api imports. */
const serverCallsIn = (source: string) =>
  [...new Set([...apiCallsIn(source), ...namedApiImportsIn(source)])].sort();

describe('SSE domain → register refresh mapping', () => {
  test('each domain refreshes exactly the registers its mutations touch', () => {
    // Serial Log: every domain that writes serial_log rows (stock
    // mutations, stock operations incl. quarantine + reversals, serial
    // edits, purchase-return and sales-return serial flips, CPE flows,
    // asset moves).
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK, ['serialLog', 'transactionLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK_OPERATIONS, ['serialLog', 'consumableRegister', 'transactionLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SERIALS, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.PROCUREMENT, ['serialLog', 'purchaseOrders', 'purchaseInvoices', 'returnsRegister', 'transactionLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SALES, ['serialLog', 'salesInvoices', 'returnsRegister', 'transactionLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SHIPMENTS, ['purchaseOrders', 'serialLog', 'transactionLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.CUSTOMER_DEVICES, ['serialLog', 'customerDevices', 'transactionLog']);
    // ASSETS also moves the customer-device register: the deploy-from-stock
    // endpoint writes the rental-CPE row in the same transaction as the asset,
    // and reversing a deployment closes it. Both asset and CPE flows can write
    // movement-ledger rows, so they also bump the transactionLog read.
    assert.deepEqual(DOMAIN_REGISTER_KEYS.ASSETS, ['serialLog', 'customerDevices', 'transactionLog']);
    // Recalculation rewrites ledger before/after balances, so the three
    // self-fetching movement screens must re-read; no paged document register
    // is involved.
    assert.deepEqual(DOMAIN_REGISTER_KEYS.RECALC, ['transactionLog']);
  });

  test('consumableRegister is refreshed only by stock-operation events', () => {
    // Only STOCK_OPERATIONS create or reverse CONSUMABLE_ISSUE rows
    // (CREATE_STOCK_CONSUMABLE_ISSUE, REVERSE_CONSUMABLE_ISSUE, ...).
    const sources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('consumableRegister'))
      .map(([domain]) => domain);
    assert.deepEqual(sources, ['STOCK_OPERATIONS']);
  });

  test('shipment receipts and recalculation jobs refresh every surface they rewrite', () => {
    // Receiving a transfer writes TRANSFER_IN movement-ledger rows and flips
    // serial_log rows; the admin recalculation jobs rebuild live stock and
    // fixed assets and backfill the ledger's before/after balances. The
    // movement screens self-fetch, so each domain must bump the transactionLog
    // register counter rather than a bootstrap slice.
    for (const domain of ['SHIPMENTS', 'RECALC']) {
      assert.ok(
        DOMAIN_REGISTER_KEYS[domain]?.includes('transactionLog'),
        `${domain} writes movement-ledger rows, so it must bump the transactionLog read`
      );
    }
    const app = readAppSource();
    assert.ok(!app.includes("'transactionLogs'"), 'App.tsx must not target the retired transactionLogs bootstrap slice');
    // "Rebuild BS Calendar Days" runs under RECALC and regenerates the server's
    // day-by-day calendar rows, so the burst must also re-read the mirror.
    assert.match(
      app,
      /domains\.includes\('BS_CALENDAR'\)\s*\|\|\s*domains\.includes\('RECALC'\)[\s\S]{0,160}syncBsCalendarMirrorRef\.current\(\)/,
      'a RECALC burst must re-read the BS calendar mirror'
    );
  });

  test('purchase document registers are refreshed only by procurement and shipment events', () => {
    const poSources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('purchaseOrders'))
      .map(([domain]) => domain);
    assert.deepEqual(poSources, ['PROCUREMENT', 'SHIPMENTS']);
    const piSources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('purchaseInvoices'))
      .map(([domain]) => domain);
    assert.deepEqual(piSources, ['PROCUREMENT']);
  });

  test('every mapped value is a known register key', () => {
    for (const [domain, regs] of Object.entries(DOMAIN_REGISTER_KEYS)) {
      assert.ok(regs.length > 0, `domain ${domain} maps to no registers`);
      for (const reg of regs) {
        assert.ok(REGISTER_KEYS.includes(reg), `domain ${domain} maps to unknown register ${reg}`);
      }
    }
  });

  test('domains that never touch the paged registers are deliberately absent', () => {
    for (const domain of NO_REGISTER_DOMAINS) {
      assert.equal(DOMAIN_REGISTER_KEYS[domain], undefined, `domain ${domain} should not refresh any paged register`);
    }
  });

  test('every domain the server can broadcast is either register-mapped or declared no-register', () => {
    // The full broadcast vocabulary resolveDomain can produce. Adding a
    // new server domain without a decision here fails the test.
    for (const domain of Object.values(DOMAIN_BY_MODULE)) {
      if (DOMAIN_REGISTER_KEYS[domain] === undefined) {
        assert.ok(NO_REGISTER_DOMAINS.includes(domain), `domain ${domain} needs a DOMAIN_REGISTER_KEYS entry (or an explicit no-register decision in this test)`);
      }
    }
  });
});

describe('bumpAllRegisterRefresh (manual full refresh)', () => {
  test('increments all eight register counters', () => {
    assert.deepEqual(
      bumpAllRegisterRefresh({ serialLog: 0, purchaseOrders: 0, purchaseInvoices: 0, consumableRegister: 0, returnsRegister: 0, salesInvoices: 0, customerDevices: 0, transactionLog: 0 }),
      { serialLog: 1, purchaseOrders: 1, purchaseInvoices: 1, consumableRegister: 1, returnsRegister: 1, salesInvoices: 1, customerDevices: 1, transactionLog: 1 }
    );
  });

  test('increments from any counter values', () => {
    assert.deepEqual(
      bumpAllRegisterRefresh({ serialLog: 7, purchaseOrders: 3, purchaseInvoices: 11, consumableRegister: 42, returnsRegister: 5, salesInvoices: 9, customerDevices: 42, transactionLog: 4 }),
      { serialLog: 8, purchaseOrders: 4, purchaseInvoices: 12, consumableRegister: 43, returnsRegister: 6, salesInvoices: 10, customerDevices: 43, transactionLog: 5 }
    );
  });

  test('is pure: returns a new record and never mutates its input', () => {
    const prev = { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 5, salesInvoices: 6, customerDevices: 6, transactionLog: 0 };
    const next = bumpAllRegisterRefresh(prev);
    assert.notEqual(next, prev);
    assert.deepEqual(prev, { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 5, salesInvoices: 6, customerDevices: 6, transactionLog: 0 });
  });

  test('covers exactly the eight register keys', () => {
    const next = bumpAllRegisterRefresh({ serialLog: 0, purchaseOrders: 0, purchaseInvoices: 0, consumableRegister: 0, returnsRegister: 0, salesInvoices: 0, customerDevices: 0, transactionLog: 0 });
    assert.deepEqual(Object.keys(next).sort(), [...REGISTER_KEYS].sort());
  });
});

describe('SSE burst → full-bootstrap fallback (App.tsx SSE handler path)', () => {
  // App.tsx's DOMAIN_STATE_KEYS vocabulary: every domain the client
  // recognizes. Derived from the two real vocabularies above (the
  // register-mapped domains plus the declared no-register domains),
  // so it tracks the server's broadcast vocabulary without copying
  // it. PERMISSIONS, SETTINGS and AUDIT refresh bootstrap slices only;
  // AUDIT is additionally re-emitted by logAuditEvent itself (alongside
  // the business event's own domain) so the Audit Trail stays live.
  const isKnownStateDomain = (d: string) =>
    DOMAIN_REGISTER_KEYS[d] !== undefined || NO_REGISTER_DOMAINS.includes(d);

  // App.tsx's full-bootstrap action: refreshAllData opens with
  // setRegisterRefresh(bumpAllRegisterRefresh), which is what the
  // SSE handler's fallback path runs.
  const runFullRefresh = (prev: Record<RegisterRefreshKey, number>) =>
    bumpAllRegisterRefresh(prev);

  test('unknown-domain event burst falls back to full refresh and bumps all eight register counters', () => {
    // A broadcast whose type AND entity are both unmapped
    // (resolveDomain → undefined), e.g. a new audit module the
    // client has not learned yet.
    const domain = resolveDomain('TOTALLY_NEW_EVENT', 'SOMETHING_ELSE');
    assert.equal(domain, undefined);

    const burst = new SseDomainBurst();
    burst.observe(domain);
    const plan = burst.flush(isKnownStateDomain);

    assert.deepEqual(plan, { mode: 'full' });
    // The fallback runs refreshAllData(), whose first line bumps
    // every paged-register counter — from any starting values.
    assert.deepEqual(
      runFullRefresh({ serialLog: 2, purchaseOrders: 5, purchaseInvoices: 1, consumableRegister: 0, returnsRegister: 7, salesInvoices: 4, customerDevices: 9, transactionLog: 3 }),
      { serialLog: 3, purchaseOrders: 6, purchaseInvoices: 2, consumableRegister: 1, returnsRegister: 8, salesInvoices: 5, customerDevices: 10, transactionLog: 4 }
    );
  });

  test('multi-domain burst resolves to a targeted plan covering every domain', () => {
    const burst = new SseDomainBurst();
    // Real server broadcasts: a stock mutation, then a sales invoice.
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY')); // STOCK
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES')); // SALES
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['STOCK', 'SALES'] });
  });

  test('a repeated domain inside a multi-domain burst is deduplicated in the plan', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY')); // STOCK
    burst.observe(resolveDomain('STOCK_OPERATIONS_REVERSED', 'STOCK_OPERATIONS')); // STOCK_OPERATIONS
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY')); // STOCK again
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['STOCK', 'STOCK_OPERATIONS'] });
  });

  test('burst mixing a known and an unknown domain falls back to full refresh', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('RECEIVE_SHIPMENT', 'LOGISTICS')); // SHIPMENTS
    burst.observe(resolveDomain('TOTALLY_NEW_EVENT', 'SOMETHING_ELSE')); // undefined
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'full' });
  });

  test('event with no domain at all (legacy/malformed broadcast) falls back to full refresh', () => {
    const burst = new SseDomainBurst();
    burst.observe(undefined);
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'full' });
  });

  test('a multi-domain burst bumps ONLY the registers its domains map to', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES')); // SALES
    burst.observe(resolveDomain('RECEIVE_SHIPMENT', 'LOGISTICS')); // SHIPMENTS
    const plan = burst.flush(isKnownStateDomain);
    assert.deepEqual(plan, { mode: 'targeted', domains: ['SALES', 'SHIPMENTS'] });
    // The targeted branch bumps DOMAIN_REGISTER_KEYS[domain] only —
    // the bump-everything increment is exclusive to the fallback path.
    const prev = { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 5, salesInvoices: 6, customerDevices: 6, transactionLog: 0 };
    const next = { ...prev };
    for (const d of plan.mode === 'targeted' ? plan.domains : []) {
      for (const reg of DOMAIN_REGISTER_KEYS[d]) next[reg] = prev[reg] + 1;
    }
    // SALES and SHIPMENTS both write serial_log and transaction_log rows. The
    // counter is a refresh trigger, not a tally: a register mapped by two
    // domains in one burst is bumped once, which is enough to re-run its fetch.
    assert.deepEqual(next, { serialLog: 2, purchaseOrders: 3, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 6, salesInvoices: 7, customerDevices: 6, transactionLog: 1 });
  });

  test('a repeated same-domain burst coalesces to a targeted plan', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY'));
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY'));
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY'));
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['STOCK'] });
  });

  test('flush resets the accumulator — the next debounce window starts clean', () => {
    const burst = new SseDomainBurst();
    burst.observe('STOCK');
    burst.observe('SALES');
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['STOCK', 'SALES'] });
    // A fresh window with a single known domain must be targeted,
    // not poisoned by the previous window's state.
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES'));
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['SALES'] });
  });

  test('contrast: a single-domain burst is targeted and bumps ONLY its mapped registers', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES'));
    const plan = burst.flush(isKnownStateDomain);
    assert.deepEqual(plan, { mode: 'targeted', domains: ['SALES'] });
    // The targeted branch bumps DOMAIN_REGISTER_KEYS[domain] only —
    // the bump-everything increment is exclusive to the fallback path.
    const prev = { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 5, salesInvoices: 6, customerDevices: 6, transactionLog: 0 };
    const next = { ...prev };
    for (const reg of DOMAIN_REGISTER_KEYS.SALES) next[reg] = prev[reg] + 1;
    assert.deepEqual(next, { serialLog: 2, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4, returnsRegister: 6, salesInvoices: 7, customerDevices: 6, transactionLog: 1 });
  });

  test('App.tsx wiring: the SSE effect uses the burst accumulator and its fallback runs refreshAllData', () => {
    // Source guard: the extracted logic must be the code App.tsx
    // actually runs, and refreshAllData must still bump the six
    // register counters (the fallback's only refresh path).
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client', 'src', 'App.tsx'),
      'utf8'
    );
    assert.match(appSource, /new SseDomainBurst\(\)/);
    assert.match(appSource, /burst\.observe\(event\?\.domain\)/);
    assert.match(appSource, /burst\.flush\(/);
    // Fallback branch of the debounced handler.
    assert.match(appSource, /refreshAllDataRef\.current\(\);/);
    // refreshAllData's register bump — the six-counter effect under test.
    assert.match(appSource, /setRegisterRefresh\(bumpAllRegisterRefresh\)/);
  });

  test('a BS_CALENDAR / RECALC burst broadcasts one app-wide calendar signal (DF-10)', () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), 'client', 'src', 'App.tsx'),
      'utf8'
    );
    // App already re-read its own calendar mirror on these domains; the
    // broadcast is what lets mounted BS screens and the stock gate re-read
    // without a reload. Dropping it re-opens DF-10 (stale gate after seeding).
    assert.match(
      appSource,
      /if \(domains\.includes\('BS_CALENDAR'\) \|\| domains\.includes\('RECALC'\)\) \{[\s\S]*?syncBsCalendarMirrorRef\.current\(\);[\s\S]*?broadcastBsCalendarUpdated\(\);[\s\S]*?\}/
    );

    for (const screen of ['finance/BsCalendarUtility.tsx', 'finance/NepaliFiscalManagement.tsx']) {
      const source = readFeatureSource(screen);
      assert.match(
        source,
        /const calendarVersion = useBsCalendarRefresh\(\)/,
        `client/src/features/${screen} must subscribe to the app-wide calendar signal`
      );
      assert.match(
        source,
        /refreshCalendarData\(\);\s*\}, \[activationKey, calendarVersion\]\);/,
        `client/src/features/${screen} must refetch when the calendar signal arrives`
      );
      // The fallback must be labelled: a failed read must never look like
      // server data (the tables would otherwise show bundled defaults).
      assert.match(
        source,
        /setCalendarLoadError\(e\?\.message \|\| 'The calendar database could not be read\.'\)/,
        `client/src/features/${screen} must surface a failed calendar read`
      );
      assert.match(
        source,
        /calendarLoadError && \(/,
        `client/src/features/${screen} must render the failed-read notice`
      );
      assert.match(
        source,
        /bundled defaults, not server data/,
        `client/src/features/${screen} must say the values are bundled defaults`
      );
    }
  });
});

describe('Paged-tab audit guard — no self-fetching data loads', () => {
  // Arc-4 staleness audit (2026-10-02): Stock Movement
  // Ledger, Asset Deployments and Damaged Stock Tracking
  // render exclusively from bootstrap-slice props and
  // paginate client-side (useClientPagination), so SSE
  // staleness cannot affect them — a targeted SSE refresh
  // re-fetches their slices and React re-renders them
  // with fresh props. No wiring needed.
  //
  // This guard pins that property: ANY new api.* call in
  // these files — in particular a data-loading effect in
  // the loadConsumableRegisterPage pattern (fetch on
  // mount / on sseRefreshKey) — fails the suite, forcing
  // an explicit SSE-wiring decision (route the data
  // through props, or gain a DOMAIN_REGISTER_KEYS entry)
  // instead of letting a silent staleness bug in.

  // The source-reading helpers (readFeatureSource, apiCallsIn,
  // useEffectCount, jsxBlocks, assertNoRawFetch, assertEveryRenderSiteWired)
  // are defined at module scope above so the wired-register guard can use
  // them too.

  test('StockMovementLedger reads its own bounded movement window and re-runs on the register key', () => {
    const source = readFeatureSource('inventory/StockMovementLedger.tsx');
    // The movement history is no longer a bootstrap prop. The screen reads a
    // bounded, fiscal-year/branch-scoped window and merges it with the
    // operation/damage arrays it still receives; that read is wired to the
    // transactionLog SSE counter.
    assert.deepEqual(serverCallsIn(source), ['getTransactionLogs']);
    assert.match(source, /sseRefreshKey\?: number;/);
    assert.match(
      source,
      /\[activeBranchId, fiscalYearStartAD, fiscalYearEndAD, sseRefreshKey, logsRetryKey\]/
    );
    assert.match(source, /all: true/);
    assertNoRawFetch(source, 'StockMovementLedger.tsx');
    assertEveryRenderSiteWired('StockMovementLedger', /sseRefreshKey=\{registerRefresh\.transactionLog\}/);
  });

  test('AssetDeployments fetches nothing — renders the assets prop only', () => {
    const source = readFeatureSource('inventory/AssetDeployments.tsx');
    // No api calls AND no effects at all: deployments
    // filter and paginate over the assets / branches /
    // locations / customers props; unassignment flows up
    // through the onUnassignAsset callback.
    assert.deepEqual(serverCallsIn(source), []);
    assert.equal(useEffectCount(source), 0);
  });

  test('DamagedStockTracking API surface is pinned to calendar gating + write flows', () => {
    const source = readFeatureSource('inventory/DamagedStockTracking.tsx');
    // The rendered grid (damageRecords, stock, products,
    // branches) comes from props. The ONLY api calls
    // allowed are the three below — none of them loads
    // the data the component renders:
    assert.deepEqual(serverCallsIn(source), [
      'createStockOperation', // disposal write-off mutation; fallback when the parent passes no onCreateOperation
      'getStockOperations', // damage-reversal flow: resolve the originating DAMAGE op id from a reference
      'reverseStockOperation', // the reversal mutation itself (guarded endpoint; the page reloads after)
    ]);
    // No data-loading effect may exist here. The BS-calendar check moved into
    // the shared gate hook (DF-10), which owns the single day-record read, the
    // local-date fix and the re-check on activation / BS_CALENDAR signal.
    assert.equal(useEffectCount(source), 0);
    assert.match(
      source,
      /useBsCalendarGate\(damagedStockActivationKey\)/,
      'the screen must gate through the shared BS-date hook, not its own mount-only check'
    );
    assert.match(
      source,
      /useActivationKey\('damaged-stock'\)/,
      're-activating the tab must re-run the gate'
    );
    assert.doesNotMatch(
      source,
      /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/,
      'the gate must use the local calendar day (DF-10), not the UTC slice'
    );
  });

  test('contrast: the self-fetch pattern this guard rejects, correctly wired in the StockOperations register panel', () => {
    // A paged tab that self-fetches MUST be wired to an
    // SSE register key — that wiring is the decision this
    // guard forces. The StockOperations consumable register
    // (stockops/ConsumablesRegisterPanel.tsx since §G commit 2,
    // when its state + fetch effect moved out of the host) is
    // the canonical wired example: it re-runs its
    // paged fetch whenever its sseRefreshKey bumps.
    const source = readFeatureSource('inventory/stockops/ConsumablesRegisterPanel.tsx');
    assert.match(source, /const loadConsumableRegisterPage = useCallback/);
    assert.match(source, /\[loadConsumableRegisterPage, sseRefreshKey\]/);
    // App.tsx feeds the SSE-driven counter into EVERY render site of the
    // tab (11 today) — a newly added unwired render site fails here, as
    // does a counter attached to any other component.
    assertEveryRenderSiteWired('StockOperations', /sseRefreshKey=\{registerRefresh\.consumableRegister\}/);
  });
});

describe('Wired self-fetching registers — pinned api surface + refresh wiring', () => {
  // The complement of the guard above: these registers DO fetch their own
  // server-paged rows — that is exactly what leaves them stale if the SSE
  // counter is not threaded through. So the rule here is not "no api.*"
  // but "EXACTLY this api.*, and only with the refresh key in the paged
  // fetch effect and at every App.tsx render site". Any new api.* reference
  // (or raw fetch/axios/EventSource) in a pinned file fails the suite until
  // it is either routed through an App callback or wired to its register
  // key — the same explicit-decision forcing the no-fetch guard applies.

  test('PurchaseOrders: api surface pinned to the PO paged fetch; wired at every render site', () => {
    const source = readFeatureSource('procurement/PurchaseOrders.tsx');
    // The ONLY data load is /api/purchase-orders: once as the paged
    // register fetch (loadPoPage) and once with all:true behind the CSV
    // export. Create / update / status / delete mutations all arrive as
    // App callbacks (onCreatePO, onUpdatePO, onUpdatePOStatus,
    // onDeletePO), so no other api.* method may appear here.
    assert.deepEqual(serverCallsIn(source), ['getPurchaseOrders']);
    // Declares the SSE counter prop App feeds...
    assert.match(source, /sseRefreshKey\?: number;/);
    // ...and the paged-fetch effect re-runs when it bumps.
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*loadPoPage\(\);\s*\}, \[loadPoPage, poRefreshKey, sseRefreshKey\]\);/,
      'the PO paged fetch effect must depend on sseRefreshKey'
    );
    assertNoRawFetch(source, 'PurchaseOrders.tsx');

    // The create-form half of the register renders props/callbacks only —
    // a fetch added there would bypass both the App callbacks and this
    // file's surface pin.
    const form = readFeatureSource('procurement/PurchaseOrderForm.tsx');
    assert.deepEqual(
      serverCallsIn(form),
      [],
      'PurchaseOrderForm must stay fetch-free — mutations flow through its onSaved/App callbacks'
    );
    assertNoRawFetch(form, 'PurchaseOrderForm.tsx');

    // Both render sites (create-po + po-list today) pass the counter.
    assertEveryRenderSiteWired('PurchaseOrders', /sseRefreshKey=\{registerRefresh\.purchaseOrders\}/);
  });

  test('PurchaseInvoices: api surface pinned to the PI paged fetch + payment-modal flows; wired at every render site', () => {
    const source = readFeatureSource('procurement/PurchaseInvoices.tsx');
    // Rendered grid rows come from exactly one load: getPurchaseInvoices
    // (loadPiPage + the all:true CSV export). The other three are the
    // invoice-detail modal's payment history and the two reversal write
    // flows — none of them supplies the grid, all are user-initiated.
    assert.deepEqual(serverCallsIn(source), [
      'getInvoicePayments',
      'getPurchaseInvoices',
      'reverseInvoicePayments',
      'reverseVendorPayment',
    ]);
    assert.match(source, /sseRefreshKey\?: number;/);
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*loadPiPage\(\);\s*\}, \[loadPiPage, piRefreshKey, sseRefreshKey\]\);/,
      'the PI paged fetch effect must depend on sseRefreshKey'
    );
    assertNoRawFetch(source, 'PurchaseInvoices.tsx');

    const form = readFeatureSource('procurement/PurchaseInvoiceForm.tsx');
    assert.deepEqual(
      serverCallsIn(form),
      [],
      'PurchaseInvoiceForm must not call services/api directly — its open-PO list comes from the scoped pending-procurement cache'
    );
    assert.match(
      form,
      /useOpenPurchaseOrders\(\{\s*branchId,/,
      'the vendor-bill PO picker must scope to the bill\'s destination branch, not the header branch'
    );
    assert.doesNotMatch(
      form,
      /useProcurementPending\(/,
      'the picker must not reuse the header-scoped KPI store: its destination branch may differ'
    );
    assertNoRawFetch(form, 'PurchaseInvoiceForm.tsx');

    // Both render sites (create-purchase + purchase-list today) pass the counter.
    assertEveryRenderSiteWired('PurchaseInvoices', /sseRefreshKey=\{registerRefresh\.purchaseInvoices\}/);
  });

  test('FiscalYearClosingWizard: scoped close-document reads wired to the PO/PI counters', () => {
    const source = readFeatureSource('finance/FiscalYearClosingWizard.tsx');
    assert.deepEqual(serverCallsIn(source), [
      'getPurchaseInvoices',
      'getPurchaseOrders',
      'getShipments',
    ]);
    assert.match(source, /useActivationKey\('fiscal-year-closing'\)/);
    assert.match(source, /useTabActive\('fiscal-year-closing'\)/);
    assert.match(
      source,
      /\[isTabActive,[^\]]*activationKey[^\]]*sseRefreshKey[^\]]*documentsRetryKey\]/,
      'the close-document fetch must re-run on activation, an SSE bump and Retry'
    );
    assertNoRawFetch(source, 'FiscalYearClosingWizard.tsx');
    assertEveryRenderSiteWired(
      'FiscalYearClosingWizard',
      /sseRefreshKey=\{registerRefresh\.purchaseOrders \+ registerRefresh\.purchaseInvoices\}/
    );
  });

  test('ReturnsRegister: api surface pinned to the two return paged fetches; wired at every render site', () => {
    const source = readFeatureSource('sales/ReturnsRegister.tsx');
    // The LIST tab loads exactly one page of returns — purchase returns on
    // the DN host, sales returns on the CN host — switched by kind in
    // loadRetPage. The sales create form no longer reads a bootstrap array:
    // it searches invoices through the paged endpoint. Create/cancel/approve
    // mutations are all App callbacks, so no other api.* method may appear.
    assert.deepEqual(serverCallsIn(source), [
      'getPurchaseReturns',
      'getSalesInvoices',
      'getSalesReturns',
    ]);
    assert.match(source, /sseRefreshKey\?: number;/);
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*loadRetPage\(\);\s*\}, \[loadRetPage, retRefreshKey, sseRefreshKey\]\);/,
      'the returns paged fetch effect must depend on sseRefreshKey'
    );
    assert.match(
      source,
      /refreshToken=\{sseRefreshKey\}/,
      'the sales-invoice picker must re-search when a sales event bumps the counter'
    );
    assert.doesNotMatch(
      source,
      /salesInvoices: SalesInvoice\[\]/,
      'the sales invoice array must not return as a ReturnsRegister prop'
    );
    assertNoRawFetch(source, 'ReturnsRegister.tsx');

    // All four render sites (purchase-returns, create-purchase-return,
    // sales-returns, create-sales-return) pass the counter.
    assertEveryRenderSiteWired('ReturnsRegister', /sseRefreshKey=\{registerRefresh\.returnsRegister\}/);
  });

  test('SalesInvoices: api surface pinned to the SI paged fetch + customer search; wired at every render site', () => {
    const source = readFeatureSource('sales/SalesInvoices.tsx');
    // The LIST tab's only data load is /api/sales-invoices (loadSiPage).
    // The create form's customer picker searches the directory server-side;
    // create and record-payment mutations flow through App callbacks.
    assert.deepEqual(serverCallsIn(source), ['getSalesInvoices', 'searchCustomers']);
    assert.match(source, /sseRefreshKey\?: number;/);
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*loadSiPage\(\);\s*\}, \[loadSiPage, siRefreshKey, sseRefreshKey\]\);/,
      'the sales-invoices paged fetch effect must depend on sseRefreshKey'
    );
    assertNoRawFetch(source, 'SalesInvoices.tsx');

    // Both render sites (create-sale + sales-list) pass the counter.
    assertEveryRenderSiteWired('SalesInvoices', /sseRefreshKey=\{registerRefresh\.salesInvoices\}/);
  });

  test('SerialLogRegister: api surface pinned; refreshKey wiring on the paged fetch and its render site', () => {
    const source = readFeatureSource('inventory/SerialLogRegister.tsx');
    // getSerialLogs supplies the grid (paged load + all:true CSV export);
    // the rest are the edit modal's duplicate-serial lookup and the two
    // serial-edit mutations. No other data load may appear.
    assert.deepEqual(serverCallsIn(source), [
      'getSerialLogs',
      'lookupSerial',
      'updateDeviceSerials',
      'updateDeviceSerialsDual',
    ]);
    // This register's wiring prop is named refreshKey, NOT sseRefreshKey —
    // the historical name App.tsx's call site uses, pinned here so a
    // rename has to update App.tsx and this test together.
    assert.match(source, /refreshKey\?: number;/);
    // The paged fetch effect re-runs when the counter bumps.
    assert.match(
      source,
      /loadPage\(\);[\s\S]{0,200}?\}, \[scopeBranch, filterStatus, appliedSearch, dateFromAD, dateToAD, serverPage, serverPageSize, refreshKey\]\);/,
      'the serial-log paged fetch effect must depend on refreshKey'
    );
    assertNoRawFetch(source, 'SerialLogRegister.tsx');

    assertEveryRenderSiteWired('SerialLogRegister', /refreshKey=\{registerRefresh\.serialLog\}/);
  });

  test('customer-device registers: the CDR refresh key reaches both consumers of the device list', () => {
    // Two screens read GET /api/customer-devices: the device register
    // (CustomersManagement) owns the rows, and the customer master directory
    // derives its per-customer counts from the same endpoint. Both are wired
    // to registerRefresh.customerDevices — the counter DOMAIN_REGISTER_KEYS
    // bumps on the CUSTOMER_DEVICES domain and bumpAllRegisterRefresh bumps on
    // every full refresh. Before this wiring, approving a Disconnect Request
    // in the Approval Center executed the status change server-side while the
    // register row kept rendering its pre-approval RENTAL badge (and the
    // "N Rental / N Collected" cards kept their old counts) until a full page
    // reload — the drift the CDR↔serial_log audit exists to prevent.
    const register = readFeatureSource('sales/CustomersManagement.tsx');
    assert.match(register, /sseRefreshKey\?: number;/);
    // The device fetch effect re-runs when the counter bumps.
    assert.match(
      register,
      /\}, \[selectedBranchId, searchQuery, sseRefreshKey, devicesRetryKey\]\);/,
      'the customer-device fetch effect must depend on sseRefreshKey'
    );
    assertNoRawFetch(register, 'CustomersManagement.tsx');
    assertEveryRenderSiteWired(
      'CustomersManagement',
      /sseRefreshKey=\{registerRefresh\.customerDevices\}/
    );

    const directory = readFeatureSource('sales/CustomerMasterDirectory.tsx');
    // This one names its prop refreshKey (the historical App.tsx prop) and
    // falls back to sseRefreshKey, so either prop name stays wired.
    assert.match(directory, /refreshKey\?: number;/);
    assert.match(directory, /sseRefreshKey\?: number;/);
    assert.match(
      directory,
      /\}, \[selectedBranchFilter, searchQuery, sseRefreshKey, devicesRetryKey\]\);/,
      'the directory device fetch effect must depend on its refresh key'
    );
    assertEveryRenderSiteWired(
      'CustomerMasterDirectory',
      /refreshKey=\{registerRefresh\.customerDevices\}/
    );
  });

  test('StockOperations: host makes no server call; it reads the shared caches', () => {
    const source = readFeatureSource('inventory/StockOperations.tsx');
    // §G commit 2 relocated every submit handler — and with it 10 of the
    // original 12 methods — into the owning stockops/*Panel.tsx. The remaining
    // reads moved into shared caches: the BS-calendar gate into bsCalendarGate
    // (DF-10) and the exchange tab's device list into exchangeDeviceCache
    // (DF-16), so 11 mounted hosts share one per-branch read. The host itself
    // must not fetch.
    assert.deepEqual(serverCallsIn(source), []);
    assertNoRawFetch(source, 'StockOperations.tsx');
    assert.match(
      source,
      /useBsCalendarGate\(\)/,
      'the host must keep the BS-date gate wired through the shared hook'
    );

    // The serial register itself moved to the app-wide cache (DF-03): the
    // host's stock-out gate validates serials against `serial_log`, but it no
    // longer fetches its own copy — all 11 mounted hosts + the dispatch form
    // share one snapshot (serialRegisterCache.ts) that App invalidates on
    // every serial_log-writing SSE domain and every full refresh. A
    // per-screen fetch reappearing here would reintroduce the session-old
    // snapshot the cache exists to remove.
    const hostSerialFetches = source.match(/api\.getSerialLogs/g) || [];
    assert.equal(hostSerialFetches.length, 0, 'StockOperations must read the shared register cache, not fetch its own copy');
    assert.match(source, /useSerialRegister\(\)/, 'the host must subscribe to the shared serial-register cache');
    assert.match(
      source,
      /serialRegisterError && \(/,
      'the host must surface a failed register refresh instead of silently gating on stale rows'
    );
    const assignSource = readFeatureSource('inventory/stockops/AssignAssetPanel.tsx');
    const serialFetches = assignSource.match(/api\.getSerialLogs/g) || [];
    assert.equal(serialFetches.length, 0, 'AssignAssetPanel must read the context cache, not fetch its own copy');
    assert.match(
      assignSource,
      /serialRegister\.some\(/,
      'the assign panel must validate its serial pair against the context register cache'
    );
  });

  test('shared serial-register cache: every serial_log writer invalidates it, and App wires both paths', () => {
    assert.deepEqual([...SERIAL_REGISTER_DOMAINS].sort(), [
      'ASSETS',
      'CUSTOMER_DEVICES',
      'PROCUREMENT',
      'SALES',
      'SERIALS',
      'SHIPMENTS',
      'STOCK',
      'STOCK_OPERATIONS',
    ]);
    for (const domain of SERIAL_REGISTER_DOMAINS) {
      assert.equal(
        domainsTouchSerialRegister([domain]),
        true,
        `${domain} writes serial_log but would not invalidate the shared cache`
      );
    }
    assert.equal(domainsTouchSerialRegister(['PRODUCTS', 'FISCAL']), false);
    assert.equal(domainsTouchSerialRegister([]), false);

    const app = readAppSource();
    const invalidations = app.match(/invalidateSerialRegister\(\)/g) || [];
    assert.ok(
      invalidations.length >= 2,
      'App must invalidate the shared register from both the SSE burst and refreshAllData'
    );
    assert.match(
      app,
      /domainsTouchSerialRegister\(domains\)[\s\S]{0,120}invalidateSerialRegister\(\)/,
      'the SSE handler must invalidate the cache for a serial_log-writing burst'
    );
  });

  test('serial-gated stock screens read the shared cache instead of fetching their own register', () => {
    for (const screen of ['inventory/StockOperations.tsx', 'procurement/CreateShipmentForm.tsx']) {
      const source = readFeatureSource(screen);
      assert.match(source, /useSerialRegister\(\)/, `${screen} must read the shared serial-register cache`);
      assert.equal(
        (source.match(/api\.getSerialLogs/g) || []).length,
        0,
        `${screen} must not fetch its own serial register`
      );
    }
  });
});

describe('Feature-screen coverage — every screen\'s server-call surface is pinned', () => {
  // Audit (2026-10-03) of all 50 screens under client/src/features — now 66
  // after the §G StockOperations decomposition added 12 tab panels (and
  // commit 2 the extracted tab-bar chrome) under inventory/stockops, plus
  // the BS-calendar integrity work's Calendar Health panel — each
  // pinned below; the hosts keep their dedicated register-guard pins above.
  //
  //  · 11 are pinned by the guard tests above (the three prop-rendered
  //    inventory tabs, the two create forms, the six SSE-wired paged
  //    registers) — see PINNED_ELSEWHERE.
  //  · 13 GET their own whole-list data on mount / selection change and are
  //    deliberately NOT paged: they re-fetch on tab re-activation and none
  //    pages on the server — see MOUNT_REFETCH_SCREENS (12 top-level tabs
  //    plus the nested Calendar Health panel under the bs-calendar tab).
  //    The two party ledgers are the only entries that also take live register
  //    counters (DF-14) — they re-read the selected party in place on a
  //    procurement/sales/return event; every other entry refreshes on
  //    re-activation (and its own Retry) only.
  //  · 6 are write-only / auxiliary-read screens (mutations + validation
  //    reads); the grids they render come from bootstrap-slice props.
  //  · the remaining 36 pins are the prop-rendered screens and the
  //    StockOperations panels, each listed with its exact calls; 30 of the 55
  //    table entries make no server call of their own.
  //
  // SCREEN_SURFACE_PINS pins every one of those screens to the EXACT server
  // calls it makes today — api.* methods AND named services/api imports,
  // because FinancialStatements.tsx imports getFinancialSummaries instead of
  // calling api.* — so ANY new fetch (paged or not, wired or not) fails
  // until it is pinned here with an explicit wiring decision. A new
  // SERVER-PAGED fetch additionally trips the paged-tripwire test below,
  // which allows it only in the six registers that carry a register key.

  const SCREEN_SURFACE_PINS: Record<string, string[]> = {
    // — mount/selection self-fetch: whole-list GETs, no SSE key by design —
    'finance/BsCalendarUtility.tsx': [
      'getBsCalendarYears',
      'getBsDayRecords',
      'seedBsCalendarYear',
      'seedBsCalendarYearsBulk',
      'updateBsCalendarYear',
    ],
    'finance/CustomerLedger.tsx': ['getCustomerLedger', 'searchCustomers'],
    'finance/DocumentNumbering.tsx': ['getDocumentNumberConfigs', 'updateDocumentNumberConfigs'],
    'finance/FinancialStatements.tsx': ['getFinancialSummaries'],
    // FY closing wizard: scoped reads for the selected closing year, not the
    // header-scoped purchase/shipment bootstrap slices.
    'finance/FiscalYearClosingWizard.tsx': ['getPurchaseInvoices', 'getPurchaseOrders', 'getShipments'],
    'finance/NepaliFiscalManagement.tsx': [
      'getBsCalendarYears',
      'getBsDayRecords',
      'seedBsCalendarYear',
      'seedBsCalendarYearsBulk',
      'syncBsDayRange',
      'updateBsCalendarYear',
    ],
    'finance/OpeningStockManager.tsx': [
      'adjustFiscalYearOpeningStock',
      'getFiscalYearOpeningStock',
      'initializeFiscalYearOpeningStock',
    ],
    'finance/VendorLedger.tsx': ['getVendorLedger'],
    'finance/VendorOpeningBalances.tsx': [
      'adjustVendorOpeningBalances',
      'getVendorOpeningBalances',
      'rollForwardVendorOpenings',
    ],
    'inventory/CategoryManagement.tsx': ['createCategory', 'deleteCategory', 'getCategories', 'updateCategory'],
    'inventory/UomManagement.tsx': ['createUom', 'deleteUom', 'getUoms', 'updateUom'],
    'settings/LocationsManagement.tsx': ['createLocation', 'getLocations'],
    // Nestled inside BsCalendarUtility under the bs-calendar tab: the
    // integrity engine's findings (GET) and its apply endpoint (POST) are
    // this panel's whole surface — it re-audits and hands the fresh report
    // back to its parent, which re-reads the year table through onRepaired.
    'finance/BsCalendarHealthPanel.tsx': ['applyBsCalendarIntegrity', 'getBsCalendarIntegrity'],

    // — write-only / auxiliary-read screens: grids render bootstrap props —
    //   Shipments decomposition (2026-10-09): the 2,186-line screen split
    //   into a thin host (header, tab bar, manifest viewer, toast — zero
    //   server calls) plus ShipmentRegister (the three cancel/receive
    //   fallbacks moved with their flows) and CreateShipmentForm (submits
    //   through App callbacks, and reads the SHARED serial-register cache to
    //   refuse a dispatch of a serial that is not an IN_STOCK unit of the
    //   source branch — serial-register audit, Slice 1 + DF-03; no GET of its
    //   own. PurchaseInvoiceForm reads its open-PO list from the shared
    //   scoped pending-procurement cache; PurchaseOrderForm stays fetch-free).
    'procurement/CreateShipmentForm.tsx': [],
    'procurement/Shipments.tsx': [],
    'procurement/ShipmentRegister.tsx': ['cancelApprovalRequest', 'cancelReceiveShipment', 'createApprovalRequest'],
    // lookupExchangeSerial: the exchange modal resolves a serial the cached
    // IN_STOCK register does not know, so its refusal can name the unit's real
    // state (assigned / damaged / other branch) instead of guessing.
    'sales/CustomersManagement.tsx': ['cancelApprovalRequest', 'createApprovalRequest', 'exchangeCustomerDevice', 'getCustomerDevices', 'lookupExchangeSerial', 'reportExchangeRefusal', 'searchCustomers'],
    'settings/DataRecalculationMaintenance.tsx': [
      'initializeFiscalYearOpeningStock',
      'rebuildBsDayRecords',
      'recalculateFixedAssets',
      'recalculateLedgerBalances',
      'recalculateLiveStock',
      // SER-2: boot no longer converges the register; the operator runs it here.
      'reconcileSerialRegister',
      'repairFiscalYearLinks',
      'rollForwardVendorOpenings',
    ],
    'settings/PermissionManagement.tsx': ['getPermissionsMatrix', 'savePermissionsMatrix'],
    'settings/UsersManagement.tsx': ['resetUserPassword'],

    // — prop-rendered screens: zero server calls of their own —
    //   (mutations flow through App.tsx callbacks, list data through the
    //   bootstrap slices App re-fetches on SSE events)
    // VOL-1a: the recent-activity strip reads its own eight rows from the
    // scoped transaction-log endpoint; the rest of the dashboard is props.
    'dashboard/Dashboard.tsx': ['getTransactionLogs'],
    'dev/StatCardShowcase.tsx': [],
    // getAuditTrail: the register lists bootstrap-slice rows, but the serial
    // focus is a deliberate server read — a unit's claim/refusal history can
    // predate the 200-row slice, and "every event for this serial" is the
    // whole point. It is a search, not a second copy of the list: clearing the
    // box drops straight back to the bootstrap prop.
    // VOL-1b: the serial focus is still the only audit read; the stock tab
    // now pages its own movement rows from /api/transaction-logs.
    'finance/AuditTrailReports.tsx': ['getAuditTrail', 'getTransactionLogs'],
    'finance/DepreciationRegister.tsx': [],
    'finance/FixedAssetRegister.tsx': [],
    'finance/VatRegister.tsx': [],
    'inventory/BranchStockTracking.tsx': [],
    'inventory/ExportStock.tsx': [],
    'inventory/ImportStock.tsx': [],
    'inventory/PhysicalStockAudit.tsx': [],
    'inventory/ProductManagement.tsx': ['getCategories', 'getProducts'],
    'inventory/ProductSearchBar.tsx': [],
    'inventory/ReorderStockTracking.tsx': [],
    'inventory/StockValuation.tsx': [],
    'inventory/WarrantyProducts.tsx': [],
    'procurement/ReceiveInboundWarehouse.tsx': [],
    'procurement/SuppliersManagement.tsx': [],
    'sales/CustomerMasterDirectory.tsx': ['createCustomer', 'deleteCustomer', 'getCustomerDevices', 'getCustomers', 'updateCustomer'],
    'sales/ImportCustomers.tsx': [],
    'settings/ApprovalWorkflowCenter.tsx': [],
    'settings/BranchesManagement.tsx': [],
    'settings/CompanySetupManagement.tsx': [],

    // — StockOperations tab panels (FRONTEND-AUDIT.md §G): §G commit 1
    //   moved the JSX verbatim; commit 2 relocated each panel's state and
    //   handlers with it, so the api surface below is each panel's own.
    //   The one non-obvious split: the register panel's export-all button
    //   and its paged fetch share getStockOperations, and the exchange
    //   panel refreshes the shared device cache after its mutation (DF-16)
    //   instead of reading the list itself.
    //   StockOperationsTabBar.tsx is the §G-commit-2 chrome extraction:
    //   the sub-tab strip, zero server calls of its own.
    // No getSerialLogs: the panel validates against the HOST's register cache
    // (serial-register audit, Slice 1) instead of fetching its own copy.
    'inventory/stockops/AssignAssetPanel.tsx': ['createAsset', 'createCustomerDevice', 'searchCustomers'],
    'inventory/stockops/ConsumableIssuePanel.tsx': ['searchCustomers'],
    'inventory/stockops/ConsumablesRegisterPanel.tsx': ['getStockOperations', 'reverseConsumableIssue'],
    'inventory/stockops/CreatePulloutPanel.tsx': [],
    'inventory/stockops/CreateTransferPanel.tsx': [],
    'inventory/stockops/DamageTrackingPanel.tsx': ['reverseStockOperation'],
    // lookupExchangeSerial: same stale-cache fallback as the customer modal — the
    // panel's mount-once register copy cannot name the state of a serial it has
    // not seen.
    'inventory/stockops/DeviceExchangePanel.tsx': ['exchangeCustomerDevice', 'lookupExchangeSerial', 'reportExchangeRefusal'],
    'inventory/stockops/LabelDamagePanel.tsx': [],
    // SER-1/D2: a product-sale stock-out can be reversed from the log; the
    // panel calls onRefreshData after the terminal reversal response.
    'inventory/stockops/LogsPanel.tsx': ['reverseStockOutOperation'],
    'inventory/stockops/ProductSalePanel.tsx': ['searchCustomers'],
    // SER-1/D2: reverse an unreceived dispatch; onRefreshData re-reads stock,
    // the register and the operation list after the response.
    'inventory/stockops/PulloutBinsPanel.tsx': ['reversePulloutOperation'],
    'inventory/stockops/ReceiveTransferPanel.tsx': ['cancelApprovalRequest', 'cancelShipment', 'createApprovalRequest'],
    'inventory/stockops/StockOperationsTabBar.tsx': [],
  };

  // Pinned by the dedicated guard tests above instead — surface AND wiring.
  const PINNED_ELSEWHERE = new Set([
    'inventory/AssetDeployments.tsx',
    'inventory/DamagedStockTracking.tsx',
    'inventory/SerialLogRegister.tsx',
    'inventory/StockMovementLedger.tsx',
    'inventory/StockOperations.tsx',
    'procurement/PurchaseInvoiceForm.tsx',
    'procurement/PurchaseInvoices.tsx',
    'procurement/PurchaseOrderForm.tsx',
    'procurement/PurchaseOrders.tsx',
    'sales/ReturnsRegister.tsx',
    'sales/SalesInvoices.tsx',
  ]);

  // The 14 screens that fetch their own rendered list/report data. They are
  // still whole-list (no server paging — see the guards below), but since
  // the keep-mounted tab container they no longer remount on a tab switch;
  // instead each one opts in to refetch-on-reactivation via
  // useActivationKey('<tabKey>') as a dependency of its fetch effect. The
  // keys are pinned below so neither half can be dropped silently. The
  // two party ledgers take register counters (DF-14) and the FY closing
  // wizard takes the PO/PI counters — see MOUNT_REFETCH_WITH_REFRESH_KEY and
  // tests/df14LedgerRefresh.test.ts. The Calendar Health panel is the one
  // non-tab entry: it is nested in BsCalendarUtility and keys off the same
  // 'bs-calendar' tab, so a seed or repair applied from the year table also
  // re-audits the findings. ProductManagement is the one two-tab screen
  // ('all-stock' and 'product-master'): it keys off its own mode prop and
  // refetches after its own saves as well as on re-activation.
  const MOUNT_REFETCH_SCREENS = [
    'finance/BsCalendarHealthPanel.tsx',
    'finance/BsCalendarUtility.tsx',
    'finance/CustomerLedger.tsx',
    'finance/DocumentNumbering.tsx',
    'finance/FinancialStatements.tsx',
    'finance/FiscalYearClosingWizard.tsx',
    'finance/NepaliFiscalManagement.tsx',
    'finance/OpeningStockManager.tsx',
    'finance/VendorLedger.tsx',
    'finance/VendorOpeningBalances.tsx',
    'inventory/CategoryManagement.tsx',
    'inventory/ProductManagement.tsx',
    'inventory/UomManagement.tsx',
    'settings/LocationsManagement.tsx',
  ];

  test('every feature screen is accounted for — a new screen must be pinned', () => {
    const screens = listFeatureScreens();
    assert.ok(screens.length > 0, 'found no feature screens — is the walk rooted at client/src/features?');
    for (const screen of screens) {
      assert.ok(
        Object.hasOwn(SCREEN_SURFACE_PINS, screen) || PINNED_ELSEWHERE.has(screen),
        `client/src/features/${screen} has no surface pin — add it to SCREEN_SURFACE_PINS (or pin it in the register-guard tests above)`
      );
    }
    for (const pinned of Object.keys(SCREEN_SURFACE_PINS)) {
      assert.ok(screens.includes(pinned), `stale pin: client/src/features/${pinned} no longer exists on disk`);
    }
    // The two lists must be disjoint: every screen pinned exactly once.
    assert.equal(
      Object.keys(SCREEN_SURFACE_PINS).length + PINNED_ELSEWHERE.size,
      screens.length,
      'a screen is listed both in SCREEN_SURFACE_PINS and in the dedicated register-guard tests'
    );
  });

  test('each screen makes exactly its pinned server calls (api.* + named imports)', () => {
    for (const [screen, expected] of Object.entries(SCREEN_SURFACE_PINS)) {
      const source = readFeatureSource(screen);
      assert.deepEqual(
        serverCallsIn(source),
        expected,
        `client/src/features/${screen} gained or lost a server call — pin the new surface deliberately, and wire any paged data to a register key first`
      );
    }
  });

  test('Shipments stays a thin host: both subcomponents keep-mounted, draft bin hoisted, zero server calls', () => {
    // Decomposition contract (2026-10-09): the host renders BOTH halves
    // inside KeepMounted wrappers keyed on internalTab — the state the old
    // monolith owned at component level (pagination page, open verification
    // modals, half-filled create form) survives sub-tab switches only while
    // the children stay mounted. An unwrapped child would remount (and reset)
    // on every switch; a conditional render would lose the draft entirely.
    const host = readFeatureSource('procurement/Shipments.tsx');
    assert.match(
      host,
      /<KeepMounted visible=\{internalTab === 'REGISTER'\}>[\s\S]*?<ShipmentRegister\b/,
      'the register must render inside a KeepMounted wrapper keyed on internalTab'
    );
    assert.match(
      host,
      /<KeepMounted visible=\{internalTab === 'CREATE_SHIPMENT'\}>[\s\S]*?<CreateShipmentForm\b/,
      'the create form must render inside a KeepMounted wrapper keyed on internalTab'
    );
    // The tab badges render in the host: the CREATE badge counts the draft
    // bin (so `lines` is hoisted out of the form) and the REGISTER badge
    // counts the host-filtered rows (so the filter primitives are too).
    assert.match(host, /const \[lines, setLines\] = useState<ShipmentFormLine\[\]>\(\[\]\);/);
    assert.match(host, /\{filteredShipments\.length\}/);
    assert.deepEqual(serverCallsIn(host), [], 'the host is chrome — header, tab bar, manifest viewer, toast');
  });

  test('no screen fetches around its pin — raw fetch/axios/EventSource banned everywhere', () => {
    for (const screen of listFeatureScreens()) {
      assertNoRawFetch(readFeatureSource(screen), screen);
    }
  });

  test('server-paged fetches exist only in SSE-wired screens', () => {
    // The paged-tripwire: a `pageSize:` request key is the one mechanical
    // signature of server-side pagination. Every screen that pages must carry
    // a register refresh key — the existing document registers plus the three
    // VOL-1 movement screens (transactionLog key) — so a new one cannot page
    // without wiring its SSE re-read.
    const paged = listFeatureScreens().filter((screen) => /pageSize:/.test(readFeatureSource(screen)));
    assert.deepEqual(
      paged,
      [
        'dashboard/Dashboard.tsx',
        'finance/AuditTrailReports.tsx',
        'inventory/SerialLogRegister.tsx',
        'inventory/stockops/ConsumablesRegisterPanel.tsx',
        'procurement/PurchaseInvoices.tsx',
        'procurement/PurchaseOrders.tsx',
        'sales/CustomerMasterDirectory.tsx',
        'sales/ReturnsRegister.tsx',
        'sales/SalesInvoices.tsx',
      ],
      'a server-paged fetch outside the wired screens is a register missing its sseRefreshKey — wire it end to end (register key + DOMAIN_REGISTER_KEYS + App.tsx) before paging on the server'
    );
  });

  // DF-14: the party ledgers are mount-refetch screens that now ALSO take the
  // register counters (a procurement/sales/return event re-reads the open
  // ledger in place). The FY closing wizard joined them with the scoped
  // close-document read: a PO/PI event refreshes an open wizard in place.
  // The positive pins live in tests/df14LedgerRefresh.test.ts and the wizard
  // wiring pin below.
  const MOUNT_REFETCH_WITH_REFRESH_KEY = new Set([
    'finance/CustomerLedger.tsx',
    'finance/VendorLedger.tsx',
    'finance/FiscalYearClosingWizard.tsx',
  ]);

  test('mount-refetch screens stay whole-list and refetch on tab re-activation', () => {
    for (const screen of MOUNT_REFETCH_SCREENS) {
      const source = readFeatureSource(screen);
      const surface = serverCallsIn(source);
      assert.ok(
        surface.some((call) => call.startsWith('get')),
        `client/src/features/${screen} is listed as a mount-refetch screen but GETs nothing — reclassify it`
      );
      assert.ok(
        !/pageSize:/.test(source),
        `client/src/features/${screen} started paging on the server — wire it as a register (see the paged-tripwire test) or keep it whole-list`
      );
      if (!MOUNT_REFETCH_WITH_REFRESH_KEY.has(screen)) {
        assert.ok(
          !/registerRefresh|sseRefreshKey|refreshKey=\{/.test(source),
          `client/src/features/${screen} carries register-refresh wiring but is not an SSE-wired register — finish the full wiring decision (DOMAIN_REGISTER_KEYS + App.tsx) or drop the prop`
        );
      }
    }
  });

  // Keep-mounted tab keys for the mount-refetch screens: the useActivationKey
  // argument must equal the App.tsx tab the screen renders under, or the
  // activation counter never ticks (and the refetch-on-reactivation never
  // happens). Pinned screen → tab key(s), checked against App.tsx itself. An
  // array means the screen renders under several tabs and keys off its own
  // mode prop (ProductManagement); every listed tab must still exist.
  const MOUNT_REFETCH_ACTIVATION_TABS: Record<string, string | string[]> = {
    'finance/BsCalendarHealthPanel.tsx': 'bs-calendar',
    'finance/BsCalendarUtility.tsx': 'bs-calendar',
    'finance/CustomerLedger.tsx': 'customer-ledger',
    'finance/DocumentNumbering.tsx': 'fiscal-year-management',
    'finance/FinancialStatements.tsx': 'financial-statements',
    'finance/FiscalYearClosingWizard.tsx': 'fiscal-year-closing',
    'finance/NepaliFiscalManagement.tsx': 'nepali-fiscal',
    'finance/OpeningStockManager.tsx': 'opening-stock',
    'finance/VendorLedger.tsx': 'vendor-ledger',
    'finance/VendorOpeningBalances.tsx': 'vendor-opening-balances',
    'inventory/CategoryManagement.tsx': 'category-management',
    'inventory/ProductManagement.tsx': ['all-stock', 'product-master'],
    'inventory/UomManagement.tsx': 'uom-management',
    'settings/LocationsManagement.tsx': 'locations',
  };

  test('each mount-refetch screen opts in to refetch-on-reactivation via useActivationKey', () => {
    const appSource = readAppSource();
    assert.deepEqual(
      Object.keys(MOUNT_REFETCH_ACTIVATION_TABS).sort(),
      [...MOUNT_REFETCH_SCREENS].sort(),
      'the activation-tab table and the mount-refetch list must cover the same screens — a screen that opts in (or stops) must be pinned in both'
    );
    for (const [screen, pinned] of Object.entries(MOUNT_REFETCH_ACTIVATION_TABS)) {
      const tabKeys = Array.isArray(pinned) ? pinned : [pinned];
      const source = readFeatureSource(screen);
      const call = Array.isArray(pinned) ? 'useActivationKey(mode)' : `useActivationKey('${pinned}')`;
      assert.ok(
        source.includes(call),
        `client/src/features/${screen} no longer opts in to refetch-on-reactivation via ${call} — tabs stay mounted, so without it the list is fetched once per session and goes stale`
      );
      assert.ok(
        /\[[^\]]*activationKey[^\]]*\]/.test(source),
        `client/src/features/${screen} calls useActivationKey but its fetch effect does not depend on activationKey — the key must be in the effect's dependency array or re-activations never refetch`
      );
      for (const tabKey of tabKeys) {
        assert.ok(
          appSource.includes(`screenRoute('${tabKey}'`),
          `App.tsx no longer declares a route '${tabKey}' in screenRoutes — client/src/features/${screen}'s useActivationKey argument must match the tab key it renders under, or the activation counter never ticks`
        );
      }
    }
  });

  test('docs screen-count claims match reality — total, table and pinned-elsewhere', () => {
    // The three docs quote these tallies (README, handoff, SESSION_NOTES:
    // "all 66 screens", "the 55 screens not covered", "the other 11").
    // Real values come from THIS code — the features walk and the two
    // tables above — so a screen added or reclassified without updating
    // the docs fails here: the screen-count twin of the docs-count gate
    // in run_tests.mjs.
    const real = {
      total: listFeatureScreens().length,
      table: Object.keys(SCREEN_SURFACE_PINS).length,
      pinnedElsewhere: PINNED_ELSEWHERE.size,
    };
    const docs = DOCS_FILES.map((file) => ({
      file,
      text: fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'),
    }));
    assert.deepEqual(checkScreenClaims(docs, real), []);
  });
});
