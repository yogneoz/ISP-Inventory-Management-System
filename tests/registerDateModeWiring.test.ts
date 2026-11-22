/**
 * Every register's card date filter is wired to the session calendar.
 *
 * The pickers themselves are covered behaviourally by
 * tests/periodRangeBsMode.test.ts, but that only proves the field CAN render
 * BS. A screen can still be wired to a constant, or its `dateMode` prop can
 * fail to arrive from the router, and the header switch would silently do
 * nothing. This guard pins the whole chain instead:
 *
 *   1. CARD — every `<PeriodRangeField>` in a feature screen passes
 *      `mode={dateMode}`, never a literal 'BS'/'AD'.
 *   2. DELIVERY — each of those screens is handed `dateMode={dateMode}` by
 *      screenRoutes (directly, through a wrapper that forwards props, or from
 *      the context a routed screen provides).
 *   3. SOURCE — the mode in `routeProps` is the session's `dateMode`.
 *
 * Source pins only: no DB, no browser.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FEATURES = path.resolve('client/src/features');
const ACCOUNTING = path.resolve('client/src/components/accounting');
const APP = path.resolve('client/src/App.tsx');
const ROUTES = path.resolve('client/src/routes/screenRoutes.tsx');

/** How the card gets the prop once the routed screen has it. */
type Delivery =
  /** The routed screen passes its own `dateMode` prop straight down. */
  | { kind: 'prop' }
  /** The register is the body of routed wrappers that forward `{...props}`. */
  | { kind: 'spread'; wrappers: string[] }
  /** The card reads the mode from the context its routed screen provides. */
  | { kind: 'context'; provider: string };

interface CardScreen {
  /** Path under client/src/features. */
  file: string;
  /** The component screenRoutes renders for it (it owns `dateMode` there). */
  component: string;
  delivery: Delivery;
}

/**
 * Every feature screen that renders the shared card date field. A new one must
 * be added here, which is the point: the list is the audit.
 */
const CARDS: CardScreen[] = [
  { file: 'inventory/SerialLogRegister.tsx', component: 'SerialLogRegister', delivery: { kind: 'prop' } },
  { file: 'inventory/StockValuation.tsx', component: 'StockValuation', delivery: { kind: 'prop' } },
  { file: 'inventory/DamagedStockTracking.tsx', component: 'DamagedStockTracking', delivery: { kind: 'prop' } },
  { file: 'inventory/PhysicalStockAudit.tsx', component: 'PhysicalStockAudit', delivery: { kind: 'prop' } },
  { file: 'inventory/StockMovementLedger.tsx', component: 'StockMovementLedger', delivery: { kind: 'prop' } },
  {
    file: 'inventory/warranty/WarrantyRegister.tsx',
    component: 'WarrantyRegister',
    delivery: {
      kind: 'spread',
      wrappers: ['inventory/SupplierWarrantyRegister.tsx', 'inventory/SellerWarrantyRegister.tsx'],
    },
  },
  { file: 'sales/ReturnsRegister.tsx', component: 'ReturnsRegister', delivery: { kind: 'prop' } },
  { file: 'sales/SalesInvoices.tsx', component: 'SalesInvoices', delivery: { kind: 'prop' } },
  {
    file: 'inventory/stockops/ConsumablesRegisterPanel.tsx',
    component: 'ConsumablesRegisterPanel',
    delivery: { kind: 'context', provider: 'inventory/StockOperations.tsx' },
  },
];

const readFeature = (rel: string) => fs.readFileSync(path.join(FEATURES, rel), 'utf8');
const componentOf = (rel: string) => path.basename(rel, '.tsx');

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const relativeFeature = (abs: string) => path.relative(FEATURES, abs).split(path.sep).join('/');

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

/**
 * The attributes of one `<Tag ... />` usage. These elements carry plain
 * identifiers and arrows, so the first `/>` closes the tag.
 */
function jsxBlock(src: string, tag: string): string | null {
  const start = src.indexOf(`<${tag}`);
  if (start === -1) return null;
  return src.slice(start, src.indexOf('/>', start) + 2);
}

describe('card date filters follow the session BS/AD choice', () => {
  test('every card date field passes mode={dateMode}, never a literal calendar', () => {
    const problems: string[] = [];
    const found = new Set<string>();

    for (const abs of tsxFiles(FEATURES)) {
      const rel = relativeFeature(abs);
      const src = fs.readFileSync(abs, 'utf8');
      let index = src.indexOf('<PeriodRangeField');
      while (index !== -1) {
        const where = `${rel}:${lineOf(src, index)}`;
        const block = src.slice(index, src.indexOf('/>', index) + 2);
        found.add(rel);
        if (!/mode=\{dateMode\}/.test(block)) {
          problems.push(`${where}: card date field does not take mode={dateMode}`);
        }
        if (/mode=["'](?:BS|AD)["']/.test(block)) {
          problems.push(`${where}: card date field hard-codes a calendar`);
        }
        index = src.indexOf('<PeriodRangeField', index + block.length);
      }
    }

    for (const card of CARDS) {
      assert.ok(
        found.has(card.file),
        `${card.file} no longer renders <PeriodRangeField> — update CARDS in this guard`
      );
    }
    assert.deepEqual(
      problems,
      [],
      `card date fields are not wired to the session calendar:\n${problems.join('\n')}`
    );
  });

  test('each of those screens is handed the session mode', () => {
    const routes = fs.readFileSync(ROUTES, 'utf8');
    const problems: string[] = [];

    const routedWithMode = (tag: string) => {
      const block = jsxBlock(routes, tag);
      if (!block) {
        problems.push(`screenRoutes no longer renders <${tag}> — the register is unreachable`);
      } else if (!/dateMode=\{dateMode\}/.test(block)) {
        problems.push(`screenRoutes renders <${tag}> without dateMode={dateMode}`);
      }
    };

    for (const card of CARDS) {
      const { delivery } = card;
      if (delivery.kind === 'prop') {
        routedWithMode(card.component);
      } else if (delivery.kind === 'spread') {
        // Two hops: the routed wrapper accepts dateMode, forwards its props, and
        // is itself handed the session mode.
        for (const wrapperFile of delivery.wrappers) {
          const wrapper = readFeature(wrapperFile);
          const block = jsxBlock(wrapper, card.component);
          if (!block) {
            problems.push(`${wrapperFile} no longer renders <${card.component}>`);
            continue;
          }
          if (!/\{\.\.\.props\}/.test(block)) {
            problems.push(`${wrapperFile} renders <${card.component}> without forwarding {...props}`);
          }
          if (!/\bdateMode: 'BS' \| 'AD';/.test(wrapper)) {
            problems.push(`${wrapperFile} does not accept dateMode to forward`);
          }
          routedWithMode(componentOf(wrapperFile));
        }
      } else {
        const panel = readFeature(card.file);
        const context = /const \{([\s\S]*?)\} = useStockOperationsCtx\(\);/.exec(panel);
        if (!context || !/\bdateMode\b/.test(context[1])) {
          problems.push(`${card.file} does not read dateMode from its screen context`);
        }
        if (!/\bdateMode,/.test(readFeature(delivery.provider))) {
          problems.push(`${delivery.provider} does not put dateMode into the panel's context`);
        }
        routedWithMode(componentOf(delivery.provider));
      }
    }

    assert.deepEqual(problems, [], `registers never receive the session calendar:\n${problems.join('\n')}`);
  });

  test('the mode handed to the router is the session dateMode', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(
      app,
      /const \{[\s\S]*?\bdateMode,[\s\S]*?\} = useSession\(\);/,
      'App must read dateMode from the session context'
    );

    const start = app.indexOf('const routeProps: ScreenRouteProps = [');
    assert.notEqual(start, -1, 'App must build the route props bundle');
    assert.match(
      app.slice(start, app.indexOf('];', start)),
      /\bdateMode,/,
      'routeProps must carry the session dateMode'
    );
  });

  test('accounting panels take their date pickers from the session calendar', () => {
    const panels = tsxFiles(ACCOUNTING);
    assert.ok(panels.length > 10, 'the accounting panel scan found no files');

    // The date fields these panels must still show, by accessible name.
    const PANEL_DATES: Record<string, string[]> = {
      'BankReconciliationPanel.tsx': ['Bank reconciliation period start'],
      'WalletReconciliationPanel.tsx': ['Wallet reconciliation period start', 'Wallet settlement date'],
      'CashFlowForecastSources.tsx': ['Manual forecast date'],
    };

    const problems: string[] = [];
    for (const abs of panels) {
      const name = path.basename(abs);
      const src = fs.readFileSync(abs, 'utf8');

      // Every picker in an accounting panel follows the header calendar.
      let at = src.indexOf('<DateField');
      while (at !== -1) {
        const block = src.slice(at, src.indexOf('/>', at) + 2);
        if (!/mode=\{dateMode\}/.test(block)) {
          problems.push(`${name}: <DateField> does not take mode={dateMode}`);
        }
        at = src.indexOf('<DateField', at + block.length);
      }

      if (/type="date"/.test(src)) {
        problems.push(`${name} renders a raw AD date input — wire it to DateField mode={dateMode}`);
      }

      for (const label of PANEL_DATES[name] || []) {
        if (!src.includes(`ariaLabel="${label}"`)) {
          problems.push(`${name}: no date field labelled "${label}" — was the picker dropped?`);
        }
      }
    }

    assert.deepEqual(problems, [], `accounting date pickers ignore the header calendar:\n${problems.join('\n')}`);
  });
});

/** Repo-relative path, for a guard's failure message. */
const repoPath = (abs: string) => path.relative(process.cwd(), abs).split(path.sep).join('/');

/** The `<PeriodRangeField ... />` usages in one source file. */
function ranges(src: string): string[] {
  const found: string[] = [];
  let at = src.indexOf('<PeriodRangeField');
  while (at !== -1) {
    const block = src.slice(at, src.indexOf('/>', at) + 2);
    found.push(block);
    at = src.indexOf('<PeriodRangeField', at + block.length);
  }
  return found;
}

/**
 * The label that names a raw date input: its own `aria-label`, the `htmlFor`
 * label matching its `id`, or the <label> it is nested in.
 */
function labelOf(src: string, at: number): string | null {
  // The whole element, not just from `type="date"` on: `id` and `aria-label`
  // may sit on either side of the attribute that the sweep matched.
  const openTag = src.lastIndexOf('<input', at);
  const tag = src.slice(openTag === -1 ? at : openTag, src.indexOf('>', at) + 1);
  const strip = (text: string) => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const ariaLabel = /aria-label="([^"]*)"/.exec(tag)?.[1];
  if (ariaLabel) return ariaLabel;

  const id = /\bid="([^"]*)"/.exec(tag)?.[1];
  if (id) {
    const htmlFor = src.indexOf(`htmlFor="${id}"`);
    if (htmlFor !== -1) {
      const open = src.lastIndexOf('<label', htmlFor);
      return strip(src.slice(src.indexOf('>', open) + 1, src.indexOf('</label>', htmlFor)));
    }
  }

  const open = src.lastIndexOf('<label', at);
  if (open !== -1 && src.slice(open, at).indexOf('</label>') === -1) {
    return strip(src.slice(src.indexOf('>', open) + 1, at));
  }
  return null;
}

/**
 * Finance screens and the shared party ledger own their own period filters, so
 * the accounting sweep above cannot see them. Two rules, no exemption list:
 *
 *   1. every range filter is ONE shared <PeriodRangeField> (never a separate
 *      From box and To box), on mode={dateMode};
 *   2. a native <input type="date"> whose own label says From/To fails — the
 *      label is read from that input's `aria-label`, from the `htmlFor` that
 *      matches its `id`, or from the <label> that encloses it, never from a
 *      window of surrounding text, so document dates never trip it.
 */
describe('finance date filters follow the session BS/AD choice', () => {
  const FINANCE = path.resolve('client/src/features/finance');
  const LEDGER_VIEW = path.resolve('client/src/components/common/LedgerView.tsx');

  /** Every finance range filter, by the two accessible names its ends carry. */
  const FILTERS: Array<{ file: string; component: string; start: string; end: string }> = [
    {
      file: 'finance/EmployeeLedger.tsx',
      component: 'EmployeeLedger',
      start: 'Employee ledger from',
      end: 'Employee ledger to',
    },
    {
      file: 'finance/LendersManagement.tsx',
      component: 'LendersManagement',
      start: 'Lender statement from',
      end: 'Lender statement to',
    },
    {
      file: 'finance/PostedVouchers.tsx',
      component: 'PostedVouchers',
      start: 'Posted vouchers from',
      end: 'Posted vouchers to',
    },
    {
      file: 'finance/PayrollPostingsRegister.tsx',
      component: 'PayrollPostingsRegister',
      start: 'Payroll postings from',
      end: 'Payroll postings to',
    },
    {
      file: 'finance/SubledgersManagement.tsx',
      component: 'SubledgersManagement',
      start: 'Book ledger from',
      end: 'Book ledger to',
    },
  ];

  test('every finance range filter is one PeriodRangeField on mode={dateMode}', () => {
    const problems: string[] = [];
    const routes = fs.readFileSync(ROUTES, 'utf8');

    // No finance range field may pick its own calendar.
    for (const abs of [...tsxFiles(FINANCE), LEDGER_VIEW]) {
      for (const block of ranges(fs.readFileSync(abs, 'utf8'))) {
        if (!/mode=\{dateMode\}/.test(block)) {
          problems.push(`${repoPath(abs)}: a <PeriodRangeField> does not take mode={dateMode}`);
        }
      }
    }

    for (const filter of FILTERS) {
      const src = readFeature(filter.file);
      if (!/\bdateMode\b/.test(src)) {
        problems.push(`${filter.file} does not take dateMode`);
      }
      const [block] = ranges(src);
      if (!block) {
        problems.push(`${filter.file}: no <PeriodRangeField> — the From/To pair is not merged`);
      } else {
        if (!block.includes(`startAriaLabel="${filter.start}"`)) {
          problems.push(`${filter.file}: range start is not "${filter.start}"`);
        }
        if (!block.includes(`endAriaLabel="${filter.end}"`)) {
          problems.push(`${filter.file}: range end is not "${filter.end}"`);
        }
      }

      const at = routes.indexOf(`<${filter.component}`);
      if (at === -1) {
        problems.push(`screenRoutes no longer renders <${filter.component}>`);
      } else if (!/dateMode=\{dateMode\}/.test(routes.slice(at, routes.indexOf('/>', at) + 2))) {
        problems.push(`screenRoutes does not hand ${filter.component} the session dateMode`);
      }
    }

    const view = fs.readFileSync(LEDGER_VIEW, 'utf8');
    const [viewRange] = ranges(view);
    if (!viewRange) {
      problems.push('LedgerView: no <PeriodRangeField> — the From/To pair is not merged');
    } else {
      if (!viewRange.includes('startAriaLabel="Ledger from"')) {
        problems.push('LedgerView: range start is not "Ledger from"');
      }
      if (!viewRange.includes('endAriaLabel="Ledger to"')) {
        problems.push('LedgerView: range end is not "Ledger to"');
      }
    }
    if (!/\bdateMode,/.test(view)) {
      problems.push('LedgerView does not destructure dateMode');
    }

    assert.deepEqual(
      problems,
      [],
      `finance range filters ignore the header calendar:\n${problems.join('\n')}`
    );
  });

  test('no native AD date input carries a From/To label', () => {
    // Document dates (voucher, cheque, start/maturity, fiscal year) stay native
    // on purpose — they describe the document, not the range being viewed.
    const problems: string[] = [];

    for (const abs of [...tsxFiles(FINANCE), LEDGER_VIEW]) {
      const src = fs.readFileSync(abs, 'utf8');
      let at = src.indexOf('type="date"');
      while (at !== -1) {
        const label = labelOf(src, at);
        if (label && /^(from|to)\b/i.test(label)) {
          problems.push(
            `${repoPath(abs)}:${lineOf(src, at)} — "${label}" is still a native AD filter input; use <PeriodRangeField mode={dateMode}>`
          );
        }
        at = src.indexOf('type="date"', at + 1);
      }
    }

    assert.deepEqual(
      problems,
      [],
      `finance range filters are still fixed to AD:\n${problems.join('\n')}`
    );
  });
});

/**
 * The same range rule outside finance: the purchase-order and bill date
 * filters and HR's attendance / branch-transfer history were a From box and a
 * To box each. They are one shared period field now, so a failure in this
 * suite names procurement or HR instead of finance.
 */
describe('procurement and HR range filters follow the session BS/AD choice', () => {
  /** Those filters, by the two accessible names their ends carry. */
  const OUTSIDE: Array<{ file: string; component?: string; start: string; end: string }> = [
    {
      file: 'procurement/PurchaseOrders.tsx',
      start: 'Purchase orders date from',
      end: 'Purchase orders date to',
    },
    {
      file: 'procurement/PurchaseInvoices.tsx',
      start: 'Purchase bills date from',
      end: 'Purchase bills date to',
    },
    {
      file: 'hr/AttendanceLeave.tsx',
      component: 'AttendanceLeave',
      start: 'Attendance range from',
      end: 'Attendance range to',
    },
    {
      file: 'hr/EmployeeBranchTransfersDialog.tsx',
      start: 'Transfer history from',
      end: 'Transfer history to',
    },
  ];

  test('procurement and HR range filters are one PeriodRangeField on mode={dateMode}', () => {
    const problems: string[] = [];
    const routes = fs.readFileSync(ROUTES, 'utf8');

    for (const range of OUTSIDE) {
      const src = readFeature(range.file);
      const block = ranges(src).find((b) => b.includes(`startAriaLabel="${range.start}"`));
      if (!block) {
        problems.push(
          `${range.file}: no <PeriodRangeField> starting at "${range.start}" — the From/To pair is not merged`
        );
        continue;
      }
      if (!block.includes(`endAriaLabel="${range.end}"`)) {
        problems.push(`${range.file}: range end is not "${range.end}"`);
      }
      if (!/mode=\{dateMode\}/.test(block)) {
        problems.push(`${range.file}: range field does not take mode={dateMode}`);
      }
      if (!/\bdateMode\b/.test(src)) {
        problems.push(`${range.file} does not take dateMode`);
      }

      if (range.component) {
        const at = routes.indexOf(`<${range.component}`);
        if (at === -1) {
          problems.push(`screenRoutes no longer renders <${range.component}>`);
        } else if (!/dateMode=\{dateMode\}/.test(routes.slice(at, routes.indexOf('/>', at) + 2))) {
          problems.push(`screenRoutes does not hand ${range.component} the session dateMode`);
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      `range filters outside finance are still two boxes:\n${problems.join('\n')}`
    );
  });

  test('one of those screens cannot go back to a native From/To box', () => {
    const problems: string[] = [];

    for (const range of OUTSIDE) {
      const src = readFeature(range.file);
      let at = src.indexOf('type="date"');
      while (at !== -1) {
        const label = labelOf(src, at);
        if (label && /^(from|to)\b/i.test(label)) {
          problems.push(
            `${range.file}:${lineOf(src, at)} — "${label}" is a native AD filter input; use <PeriodRangeField mode={dateMode}>`
          );
        }
        at = src.indexOf('type="date"', at + 1);
      }
    }

    assert.deepEqual(problems, [], `outside-finance range filters are still native AD:\n${problems.join('\n')}`);
  });
});
