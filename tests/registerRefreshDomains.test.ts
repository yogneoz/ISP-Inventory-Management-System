/**
 * Unit tests for the SSE domain → paged-register refresh mapping
 * (node:test). Pins which self-fetching paged registers (Serial Log,
 * Purchase Orders, Purchase Invoices, the consumable register inside
 * StockOperations) re-run their fetch for each SSE domain, so a
 * register can never silently miss a mutation the bootstrap slices
 * don't cover.
 *
 * Also source-guards the components themselves: the tabs that render
 * bootstrap props only are pinned to ZERO api calls, and every
 * self-fetching register (Purchase Orders, Purchase Invoices, Serial Log,
 * plus the two StockOperations hosts) has its allowed api surface AND its
 * refresh-key wiring pinned, so a new fetch that is not wired to a
 * register key fails the suite instead of shipping a stale tab.
 *
 * The feature-screen coverage guard then pins EVERY screen under
 * client/src/features to its exact server-call surface (api.* methods AND
 * named services/api imports), proves raw fetch cannot bypass the pins,
 * and proves server-paged fetches exist only in the four wired registers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DOMAIN_REGISTER_KEYS,
  bumpAllRegisterRefresh,
  SseDomainBurst,
  type RegisterRefreshKey,
} from '../client/src/utils/registerRefreshDomains';
import { DOMAIN_BY_MODULE, resolveDomain } from '../server/src/syncDomains';

// The complete register vocabulary kept in App.tsx's registerRefresh state.
const REGISTER_KEYS = ['serialLog', 'purchaseOrders', 'purchaseInvoices', 'consumableRegister'];

// Server domains whose mutations never touch any of the four paged
// registers: they refresh bootstrap slices only. Kept in sync by the
// "declared no-register" test below — a new server domain must either
// gain a DOMAIN_REGISTER_KEYS entry or be listed here.
const NO_REGISTER_DOMAINS = [
  'MASTER_DATA', 'CATEGORIES', 'PRODUCTS', 'FISCAL', 'USERS',
  'APPROVALS', 'RECALC', 'COMPANY_PROFILE',
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
 * Every App.tsx render site of `tag` must pass `prop`, and the prop must
 * never appear outside a render site — a newly added unwired mount (or a
 * counter attached to the wrong component) fails here.
 */
const assertEveryRenderSiteWired = (tag: string, prop: RegExp) => {
  const appSource = readAppSource();
  const blocks = jsxBlocks(appSource, tag);
  assert.ok(blocks.length > 0, `no <${tag} render sites found in App.tsx`);
  for (const block of blocks) {
    assert.match(block, prop, `a <${tag} render site in App.tsx is missing ${prop.source}`);
  }
  const propCount = [...appSource.matchAll(new RegExp(prop.source, 'g'))].length;
  assert.equal(
    propCount,
    blocks.length,
    `${prop.source} appears ${propCount} time(s) but App.tsx renders <${tag} ${blocks.length} time(s) — every render site must be wired`
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
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.STOCK_OPERATIONS, ['serialLog', 'consumableRegister']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SERIALS, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.PROCUREMENT, ['serialLog', 'purchaseOrders', 'purchaseInvoices']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SALES, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.SHIPMENTS, ['purchaseOrders']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.CUSTOMER_DEVICES, ['serialLog']);
    assert.deepEqual(DOMAIN_REGISTER_KEYS.ASSETS, ['serialLog']);
  });

  test('consumableRegister is refreshed only by stock-operation events', () => {
    // Only STOCK_OPERATIONS create or reverse CONSUMABLE_ISSUE rows
    // (CREATE_STOCK_CONSUMABLE_ISSUE, REVERSE_CONSUMABLE_ISSUE, ...).
    const sources = Object.entries(DOMAIN_REGISTER_KEYS)
      .filter(([, regs]) => regs.includes('consumableRegister'))
      .map(([domain]) => domain);
    assert.deepEqual(sources, ['STOCK_OPERATIONS']);
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
  test('increments all four register counters', () => {
    assert.deepEqual(
      bumpAllRegisterRefresh({ serialLog: 0, purchaseOrders: 0, purchaseInvoices: 0, consumableRegister: 0 }),
      { serialLog: 1, purchaseOrders: 1, purchaseInvoices: 1, consumableRegister: 1 }
    );
  });

  test('increments from any counter values', () => {
    assert.deepEqual(
      bumpAllRegisterRefresh({ serialLog: 7, purchaseOrders: 3, purchaseInvoices: 11, consumableRegister: 42 }),
      { serialLog: 8, purchaseOrders: 4, purchaseInvoices: 12, consumableRegister: 43 }
    );
  });

  test('is pure: returns a new record and never mutates its input', () => {
    const prev = { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4 };
    const next = bumpAllRegisterRefresh(prev);
    assert.notEqual(next, prev);
    assert.deepEqual(prev, { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4 });
  });

  test('covers exactly the four register keys', () => {
    const next = bumpAllRegisterRefresh({ serialLog: 0, purchaseOrders: 0, purchaseInvoices: 0, consumableRegister: 0 });
    assert.deepEqual(Object.keys(next).sort(), [...REGISTER_KEYS].sort());
  });
});

describe('SSE burst → full-bootstrap fallback (App.tsx SSE handler path)', () => {
  // App.tsx's DOMAIN_STATE_KEYS vocabulary: every domain the client
  // recognizes. Derived from the two real vocabularies above (the
  // register-mapped domains plus the declared no-register domains),
  // so it tracks the server's broadcast vocabulary without copying
  // it — AUDIT is the one client-only domain, never broadcast.
  const isKnownStateDomain = (d: string) =>
    DOMAIN_REGISTER_KEYS[d] !== undefined || NO_REGISTER_DOMAINS.includes(d);

  // App.tsx's full-bootstrap action: refreshAllData opens with
  // setRegisterRefresh(bumpAllRegisterRefresh), which is what the
  // SSE handler's fallback path runs.
  const runFullRefresh = (prev: Record<RegisterRefreshKey, number>) =>
    bumpAllRegisterRefresh(prev);

  test('unknown-domain event burst falls back to full refresh and bumps all four register counters', () => {
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
      runFullRefresh({ serialLog: 2, purchaseOrders: 5, purchaseInvoices: 1, consumableRegister: 0 }),
      { serialLog: 3, purchaseOrders: 6, purchaseInvoices: 2, consumableRegister: 1 }
    );
  });

  test('mixed multi-domain burst (two known domains) falls back to full refresh and bumps all four counters', () => {
    const burst = new SseDomainBurst();
    // Real server broadcasts: a stock mutation, then a sales invoice.
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY')); // STOCK
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES')); // SALES
    const plan = burst.flush(isKnownStateDomain);

    assert.deepEqual(plan, { mode: 'full' });
    assert.deepEqual(
      runFullRefresh({ serialLog: 0, purchaseOrders: 0, purchaseInvoices: 0, consumableRegister: 0 }),
      { serialLog: 1, purchaseOrders: 1, purchaseInvoices: 1, consumableRegister: 1 }
    );
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

  test('three-domain burst still falls back — only single-domain bursts are targeted', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('CREATE_PURCHASE_ORDER', 'PROCUREMENT'));
    burst.observe(resolveDomain('STOCK_UPDATED', 'INVENTORY'));
    burst.observe(resolveDomain('RECEIVE_SHIPMENT', 'LOGISTICS'));
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'full' });
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
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'full' });
    // A fresh window with a single known domain must be targeted,
    // not poisoned by the previous window's mixed state.
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES'));
    assert.deepEqual(burst.flush(isKnownStateDomain), { mode: 'targeted', domains: ['SALES'] });
  });

  test('contrast: a single-domain burst is targeted and bumps ONLY its mapped registers', () => {
    const burst = new SseDomainBurst();
    burst.observe(resolveDomain('CREATE_SALES_INVOICE', 'SALES'));
    const plan = burst.flush(isKnownStateDomain);
    assert.deepEqual(plan, { mode: 'targeted', domains: ['SALES'] });
    // The targeted branch bumps DOMAIN_REGISTER_KEYS[domain] only —
    // the all-four increment is exclusive to the fallback path.
    const prev = { serialLog: 1, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4 };
    const next = { ...prev };
    for (const reg of DOMAIN_REGISTER_KEYS.SALES) next[reg] = prev[reg] + 1;
    assert.deepEqual(next, { serialLog: 2, purchaseOrders: 2, purchaseInvoices: 3, consumableRegister: 4 });
  });

  test('App.tsx wiring: the SSE effect uses the burst accumulator and its fallback runs refreshAllData', () => {
    // Source guard: the extracted logic must be the code App.tsx
    // actually runs, and refreshAllData must still bump the four
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
    // refreshAllData's register bump — the four-counter effect under test.
    assert.match(appSource, /setRegisterRefresh\(bumpAllRegisterRefresh\)/);
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

  test('StockMovementLedger fetches nothing — renders bootstrap-slice props only', () => {
    const source = readFeatureSource('inventory/StockMovementLedger.tsx');
    // All rendered data (transactionLogs, products,
    // branches, stock, damageRecords, stockOperations,
    // shipments, purchaseOrders) arrives as props from
    // App.tsx's bootstrap slices; the single useEffect
    // only mirrors the global branch context into local
    // filter state.
    assert.deepEqual(serverCallsIn(source), []);
    assert.equal(useEffectCount(source), 1);
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
    // allowed are the four below — none of them loads
    // the data the component renders:
    assert.deepEqual(serverCallsIn(source), [
      'createStockOperation', // disposal write-off mutation; fallback when the parent passes no onCreateOperation
      'getBsDayRecordByAdDate', // BS-calendar availability check on mount — UI gating, not business data
      'getStockOperations', // damage-reversal flow: resolve the originating DAMAGE op id from a reference
      'reverseStockOperation', // the reversal mutation itself (guarded endpoint; the page reloads after)
    ]);
    // The sole useEffect is the mount-only BS-calendar
    // check — no data-loading effect may exist here.
    assert.equal(useEffectCount(source), 1);
    assert.match(source, /useEffect\(\(\) => \{\s*checkBsDateAvailability\(\);/);
  });

  test('contrast: the self-fetch pattern this guard rejects, correctly wired in StockOperations', () => {
    // A paged tab that self-fetches MUST be wired to an
    // SSE register key — that wiring is the decision this
    // guard forces. StockOperations' consumable register
    // is the canonical wired example: it re-runs its
    // paged fetch whenever its sseRefreshKey bumps.
    const source = readFeatureSource('inventory/StockOperations.tsx');
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
      'PurchaseInvoiceForm must stay fetch-free — submit/payment flows are App callbacks'
    );
    assertNoRawFetch(form, 'PurchaseInvoiceForm.tsx');

    // Both render sites (create-purchase + purchase-list today) pass the counter.
    assertEveryRenderSiteWired('PurchaseInvoices', /sseRefreshKey=\{registerRefresh\.purchaseInvoices\}/);
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

  test('StockOperations: full api surface pinned; its serialLog fetch stays the mount-once validation cache', () => {
    const source = readFeatureSource('inventory/StockOperations.tsx');
    // 12 distinct methods across 15 call sites, each an explicit decision:
    assert.deepEqual(serverCallsIn(source), [
      'cancelApprovalRequest',
      'cancelShipment',
      'createApprovalRequest',
      'createAsset',
      'createCustomerDevice',
      'exchangeCustomerDevice',
      'getBsDayRecordByAdDate',
      'getCustomerDevices',
      'getSerialLogs',
      'getStockOperations',
      'reverseConsumableIssue',
      'reverseStockOperation',
    ]);
    assertNoRawFetch(source, 'StockOperations.tsx');

    // serialLog host: EXACTLY ONE getSerialLogs, and it must stay a
    // mount-once ([] deps) fetch behind the assignSerialLogLoaded guard.
    // Deliberately NOT sse-wired: the bootstrap payload excludes
    // serialLogs, so the IN_STOCK pair-validation cache fills when this
    // effect first runs and is refreshed by remount. Moving it out of the
    // guard, giving the effect deps, or adding a second serial-log fetch
    // here fails this assertion and forces an explicit wiring decision.
    const serialFetches = source.match(/api\.getSerialLogs/g) || [];
    assert.equal(serialFetches.length, 1, 'StockOperations must host exactly one serial-log fetch');
    assert.match(
      source,
      /useEffect\(\(\) => \{\s*if \(assignSerialLogLoaded\.current\) return;\s*assignSerialLogLoaded\.current = true;\s*api\.getSerialLogs\(\{ all: true \}\)[\s\S]*?\}, \[\]\);/,
      'the assignSerialLogCache fetch must stay mount-once ([] deps) behind assignSerialLogLoaded'
    );
  });
});

describe('Feature-screen coverage — every screen\'s server-call surface is pinned', () => {
  // Audit (2026-10-03) of all 50 screens under client/src/features:
  //
  //  · 9 are pinned by the guard tests above (the three prop-rendered
  //    inventory tabs, the two create forms, the four SSE-wired paged
  //    registers) — see PINNED_ELSEWHERE.
  //  · 11 GET their own whole-list data on mount / selection change and are
  //    deliberately NOT sse-wired: tabs remount on switch (fresh fetch) and
  //    none pages on the server — see MOUNT_REFETCH_NO_SSE_KEY.
  //  · 5 are write-only screens (mutations + validation reads); the grids
  //    they render come from bootstrap-slice props.
  //  · 25 render props/callbacks only — zero server calls of their own.
  //
  // SCREEN_SURFACE_PINS pins each of those 41 screens to the EXACT server
  // calls it makes today — api.* methods AND named services/api imports,
  // because FinancialStatements.tsx imports getFinancialSummary instead of
  // calling api.* — so ANY new fetch (paged or not, wired or not) fails
  // until it is pinned here with an explicit wiring decision. A new
  // SERVER-PAGED fetch additionally trips the paged-tripwire test below,
  // which allows it only in the four registers that carry a register key.

  const SCREEN_SURFACE_PINS: Record<string, string[]> = {
    // — mount/selection self-fetch: whole-list GETs, no SSE key by design —
    'finance/BsCalendarUtility.tsx': [
      'getBsCalendarYears',
      'getBsDayRecords',
      'seedBsCalendarYear',
      'seedBsCalendarYearsBulk',
      'syncBsDayRange',
      'updateBsCalendarYear',
    ],
    'finance/CustomerLedger.tsx': ['getCustomerLedger'],
    'finance/DocumentNumbering.tsx': ['getDocumentNumberConfigs'],
    'finance/FinancialStatements.tsx': ['getFinancialSummary'],
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
    'settings/LocationsManagement.tsx': ['createLocation', 'deleteLocation', 'getLocations'],

    // — write-only / auxiliary-read screens: grids render bootstrap props —
    'procurement/Shipments.tsx': ['cancelApprovalRequest', 'cancelReceiveShipment', 'createApprovalRequest'],
    'sales/CustomersManagement.tsx': ['cancelApprovalRequest', 'createApprovalRequest', 'exchangeCustomerDevice'],
    'settings/DataRecalculationMaintenance.tsx': [
      'initializeFiscalYearOpeningStock',
      'rebuildBsDayRecords',
      'recalculateFixedAssets',
      'recalculateLiveStock',
      'repairFiscalYearLinks',
      'rollForwardVendorOpenings',
    ],
    'settings/PermissionManagement.tsx': ['savePermissionsMatrix'],
    'settings/UsersManagement.tsx': ['resetUserPassword'],

    // — prop-rendered screens: zero server calls of their own —
    //   (mutations flow through App.tsx callbacks, list data through the
    //   bootstrap slices App re-fetches on SSE events)
    'dashboard/Dashboard.tsx': [],
    'dev/StatCardShowcase.tsx': [],
    'finance/AuditTrailReports.tsx': [],
    'finance/DepreciationRegister.tsx': [],
    'finance/FiscalYearClosingWizard.tsx': [],
    'finance/FixedAssetRegister.tsx': [],
    'finance/VatRegister.tsx': [],
    'inventory/BranchStockTracking.tsx': [],
    'inventory/ExportStock.tsx': [],
    'inventory/ImportStock.tsx': [],
    'inventory/PhysicalStockAudit.tsx': [],
    'inventory/ProductManagement.tsx': [],
    'inventory/ProductSearchBar.tsx': [],
    'inventory/ReorderStockTracking.tsx': [],
    'inventory/StockValuation.tsx': [],
    'inventory/WarrantyProducts.tsx': [],
    'procurement/ReceiveInboundWarehouse.tsx': [],
    'procurement/SuppliersManagement.tsx': [],
    'sales/CustomerMasterDirectory.tsx': [],
    'sales/ImportCustomers.tsx': [],
    'sales/ReturnsRegister.tsx': [],
    'sales/SalesInvoices.tsx': [],
    'settings/ApprovalWorkflowCenter.tsx': [],
    'settings/BranchesManagement.tsx': [],
    'settings/CompanySetupManagement.tsx': [],
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
  ]);

  // The 11 screens that fetch their own rendered list/report data. They are
  // unwired ON PURPOSE — remount-on-tab-switch refetches them — so they must
  // not grow register wiring casually: wiring one needs a full decision
  // (DOMAIN_REGISTER_KEYS entry + App.tsx counter + effect deps), not just a
  // prop. Surface pins below catch any new GET either way.
  const MOUNT_REFETCH_NO_SSE_KEY = [
    'finance/BsCalendarUtility.tsx',
    'finance/CustomerLedger.tsx',
    'finance/DocumentNumbering.tsx',
    'finance/FinancialStatements.tsx',
    'finance/NepaliFiscalManagement.tsx',
    'finance/OpeningStockManager.tsx',
    'finance/VendorLedger.tsx',
    'finance/VendorOpeningBalances.tsx',
    'inventory/CategoryManagement.tsx',
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

  test('no screen fetches around its pin — raw fetch/axios/EventSource banned everywhere', () => {
    for (const screen of listFeatureScreens()) {
      assertNoRawFetch(readFeatureSource(screen), screen);
    }
  });

  test('server-paged fetches exist only in the four SSE-wired registers', () => {
    // The paged-tripwire: a `pageSize:` request key is the one mechanical
    // signature of server-side pagination. Exactly the four registers that
    // carry a register refresh key may have it — a fifth means a register
    // is paging without its sseRefreshKey.
    const paged = listFeatureScreens().filter((screen) => /pageSize:/.test(readFeatureSource(screen)));
    assert.deepEqual(
      paged,
      [
        'inventory/SerialLogRegister.tsx',
        'inventory/StockOperations.tsx',
        'procurement/PurchaseInvoices.tsx',
        'procurement/PurchaseOrders.tsx',
      ],
      'a server-paged fetch outside the wired registers is a register missing its sseRefreshKey — wire it end to end (register key + DOMAIN_REGISTER_KEYS + App.tsx) before paging on the server'
    );
  });

  test('mount-refetch screens stay whole-list and carry no register wiring', () => {
    for (const screen of MOUNT_REFETCH_NO_SSE_KEY) {
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
      assert.ok(
        !/registerRefresh|sseRefreshKey|refreshKey=\{/.test(source),
        `client/src/features/${screen} carries register-refresh wiring but is not an SSE-wired register — finish the full wiring decision (DOMAIN_REGISTER_KEYS + App.tsx) or drop the prop`
      );
    }
  });
});
