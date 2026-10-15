/**
 * BS-seeding guidance (2026-10-15) — guards.
 *
 * Before this change an unseeded BS date produced ONE sentence — "please
 * contact your system administrator for BS month seeding" — and the only two
 * screens that named a destination pointed at "System Settings -> BS Calendar
 * Utility", a menu that does not exist in this app (the real group is
 * Administration & Governance). Nothing warned that calendar coverage was
 * about to end, so the first sign of a missing BS year was a refused invoice on
 * the day the last mapped BS day passed.
 *
 * PROVES (pure functions + source pins, no database needed):
 *   - the 400 tells the two cases apart and names the real screen:
 *     DAY_NOT_SEEDED (a gap inside the span) vs AFTER/BEFORE_CALENDAR_COVERAGE
 *     (the next/previous BS year was never seeded);
 *   - the message carries the exact coverage span, and the payload carries
 *     bsDateReason + calendarCoverage so the UI can act on it;
 *   - coverage status + daysRemaining, including both thresholds;
 *   - every derive-or-400 site routes through the shared resolver, so no caller
 *     can report an unseeded date without the reason;
 *   - the client attaches a navigate-to-screen action for the roles that can
 *     seed, the toast renders it, and App validates it before switching;
 *   - the dashboard and the notification bell both surface the countdown;
 *   - no seeding message anywhere still points at the non-existent
 *     "System Settings" menu.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyBsDateFailure,
  bsDateFailureMessage,
  BS_SEEDING_SCREEN_PATH,
} from '../server/src/utils/bsDate';
import {
  getBsCalendarCoverage,
  BS_SEEDING_MENU_PATH,
  BS_COVERAGE_WARNING_DAYS,
  BS_COVERAGE_CRITICAL_DAYS,
} from '../client/src/utils/nepaliCalendar';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

/** A coverage span used as a fixture: BS 2078-01-01 … 2085-12-31. */
const COVERAGE = {
  minAD: '2021-04-14',
  maxAD: '2029-04-13',
  minBS: '2078-01-01',
  maxBS: '2085-12-31',
  totalDays: 2922,
};

const EMPTY_COVERAGE = { minAD: null, maxAD: null, minBS: null, maxBS: null, totalDays: 0 };

describe('BS-seeding guidance — server failure classification', () => {
  test('a date inside the span with no row is a GAP, not a coverage problem', () => {
    assert.equal(classifyBsDateFailure('2025-06-01', COVERAGE), 'DAY_NOT_SEEDED');
    assert.equal(classifyBsDateFailure('2021-04-14', COVERAGE), 'DAY_NOT_SEEDED');
    assert.equal(classifyBsDateFailure('2029-04-13', COVERAGE), 'DAY_NOT_SEEDED');
  });

  test('a date past the last mapped day is AFTER_CALENDAR_COVERAGE', () => {
    // The case that matters operationally: the next BS year was never seeded.
    assert.equal(classifyBsDateFailure('2029-04-14', COVERAGE), 'AFTER_CALENDAR_COVERAGE');
    assert.equal(classifyBsDateFailure('2030-01-01', COVERAGE), 'AFTER_CALENDAR_COVERAGE');
  });

  test('a date before the first mapped day is BEFORE_CALENDAR_COVERAGE', () => {
    assert.equal(classifyBsDateFailure('2021-04-13', COVERAGE), 'BEFORE_CALENDAR_COVERAGE');
  });

  test('an empty calendar is reported as a gap, never as a range problem', () => {
    assert.equal(classifyBsDateFailure('2026-10-15', EMPTY_COVERAGE), 'DAY_NOT_SEEDED');
    assert.equal(classifyBsDateFailure('', EMPTY_COVERAGE), 'DAY_NOT_SEEDED');
  });

  test('the message names the real screen and the exact coverage span', () => {
    assert.equal(BS_SEEDING_SCREEN_PATH, 'Administration & Governance → BS Calendar Utility (Super Admin)');

    const gap = bsDateFailureMessage('2025-06-01', 'DAY_NOT_SEEDED', COVERAGE);
    assert.match(gap, /BS date is not available for 2025-06-01/);
    assert.match(gap, /inside the seeded range/);
    assert.ok(gap.includes(BS_SEEDING_SCREEN_PATH), 'the gap message must name the seeding screen');

    const after = bsDateFailureMessage('2029-04-14', 'AFTER_CALENDAR_COVERAGE', COVERAGE);
    assert.match(after, /past the end of the seeded BS calendar/);
    assert.match(after, /Seed the next BS year/);
    assert.ok(after.includes('2085-12-31'), 'the message must quote where coverage currently ends');
    assert.ok(after.includes(BS_SEEDING_SCREEN_PATH));

    const before = bsDateFailureMessage('2021-04-13', 'BEFORE_CALENDAR_COVERAGE', COVERAGE);
    assert.match(before, /before the start of the seeded BS calendar/);

    const unseeded = bsDateFailureMessage('2026-10-15', 'DAY_NOT_SEEDED', EMPTY_COVERAGE);
    assert.match(unseeded, /No BS calendar days are seeded yet/);
  });

  test('no 400 site reports an unseeded date without the reason + coverage', () => {
    const bsDate = read('server/src/utils/bsDate.ts');
    for (const field of ['bsDateReason', 'calendarCoverage', 'getBsCalendarCoverage']) {
      assert.ok(bsDate.includes(field), `the 400 payload must carry ${field}`);
    }
    // Every derive-or-400 site routes through the shared resolver (the two
    // inline gates that dropped the context are gone), and the tracked
    // invocation counts from bsDateMandatory.test.ts still hold.
    const sites: Array<[string, number]> = [
      ['server/src/controllers/shipments.controller.ts', 2],   // dispatch + receive
      ['server/src/controllers/inventory.controller.ts', 4],   // 3 + the stock-op gate
    ];
    for (const [file, minUses] of sites) {
      const uses = read(file).split('bsDateOr400(').length - 1;
      assert.ok(uses >= minUses, `${file} must call bsDateOr400 at least ${minUses} time(s) (found ${uses})`);
      assert.ok(
        !read(file).includes('contact your system administrator for BS month seeding'),
        `${file} must not hand-roll the seeding message (it loses the reason + coverage)`
      );
    }
  });
});

describe('BS-seeding guidance — client coverage countdown', () => {
  test('coverage math: healthy, warning, critical, expired', () => {
    // The bundled/client-synced calendar maps up to BS 2085-12-31 (AD 2029-04-13).
    const healthy = getBsCalendarCoverage('2028-01-01');
    assert.equal(healthy.status, 'OK');
    assert.ok(healthy.daysRemaining > BS_COVERAGE_WARNING_DAYS, `expected > ${BS_COVERAGE_WARNING_DAYS} days, got ${healthy.daysRemaining}`);

    const warning = getBsCalendarCoverage('2029-01-01');
    assert.equal(warning.status, 'WARNING');
    assert.ok(warning.daysRemaining > BS_COVERAGE_CRITICAL_DAYS && warning.daysRemaining <= BS_COVERAGE_WARNING_DAYS);

    const critical = getBsCalendarCoverage('2029-04-01');
    assert.equal(critical.status, 'CRITICAL');
    assert.ok(critical.daysRemaining >= 0 && critical.daysRemaining <= BS_COVERAGE_CRITICAL_DAYS);

    // The last mapped day itself still resolves (0 days left), and the day
    // after is expired — which is exactly when every dated operation refuses.
    assert.equal(getBsCalendarCoverage('2029-04-13').status, 'CRITICAL');
    assert.equal(getBsCalendarCoverage('2029-04-13').daysRemaining, 0);
    const expired = getBsCalendarCoverage('2029-05-01');
    assert.equal(expired.status, 'EXPIRED');
    assert.ok(expired.daysRemaining < 0);
    assert.equal(expired.maxBS, '2085-12-31', 'an expired calendar still reports where it ends');
  });

  test('the countdown names the real menu, not a menu that does not exist', () => {
    assert.equal(BS_SEEDING_MENU_PATH, 'Administration & Governance → BS Calendar Utility');
    assert.ok(!BS_SEEDING_MENU_PATH.includes('System Settings'));
  });

  test('every client seeding message points at the real menu path', () => {
    const screens = [
      'client/src/features/procurement/PurchaseOrderForm.tsx',
      'client/src/features/procurement/PurchaseInvoiceForm.tsx',
      'client/src/features/procurement/CreateShipmentForm.tsx',
      'client/src/features/inventory/stockops/AssignAssetPanel.tsx',
      'client/src/features/finance/FixedAssetRegister.tsx',
      'client/src/features/inventory/DamagedStockTracking.tsx',
      'client/src/features/inventory/StockOperations.tsx',
    ];
    for (const file of screens) {
      const src = read(file);
      // The blocking message itself (pinned by bsDateMandatory.test.ts) stays...
      assert.ok(src.includes('BS month seeding'), `${file} must still block with the BS-seeding message`);
      // ...and now tells the operator which screen to open.
      assert.ok(src.includes('BS_SEEDING_MENU_PATH'), `${file} must name the seeding screen via the shared constant`);
    }
  });

  test('the seeded calendar lasts beyond today, so the warning is not noise', () => {
    // Guards the operational assumption the whole feature rests on: the shipped
    // calendar must not already be expired when the app ships.
    const now = getBsCalendarCoverage();
    assert.ok(now.status !== 'EXPIRED', `shipped calendar already expired: ${JSON.stringify(now)}`);
    assert.ok(now.totalDaysMapped > 0);
  });
});

describe('BS-seeding guidance — the toast can reach the screen', () => {
  test('a bsDateMissing failure carries a navigate-to-screen action by role', () => {
    const http = read('client/src/services/api/http.ts');
    assert.ok(http.includes('bsDateMissing === true'), 'the client must detect the bsDateMissing 400');
    assert.ok(http.includes('BS_SEEDING_TAB_BY_ROLE'), 'the seeding tab must be role-derived');
    // Super Admin gets the BS Calendar Utility; a Head Office Admin reaches the
    // same seeder on Nepali Fiscal Management (the utility tab is hidden for them).
    assert.match(http, /SUPER_ADMIN:\s*'bs-calendar'/);
    assert.match(http, /HEAD_OFFICE_ADMIN:\s*'nepali-fiscal'/);
    assert.ok(http.includes('NAVIGATE_TAB_EVENT'), 'toast actions need a navigation channel');
  });

  test('the toast renders the action button and keeps it up long enough', () => {
    const toast = read('client/src/components/common/ToastHost.tsx');
    assert.ok(toast.includes('toast.action'), 'the toast must render the action when present');
    assert.ok(toast.includes('requestTabNavigation(toast.action!.tab)'), 'the button must request navigation');
    assert.ok(toast.includes('toast.dismissAfterMs ?? DEFAULT_DISMISS_MS'), 'actionable toasts must stay up longer');
  });

  test('App validates the target tab before switching to it', () => {
    const app = read('client/src/App.tsx');
    assert.ok(app.includes('NAVIGATE_TAB_EVENT'), 'App must listen for navigation requests');
    assert.ok(
      app.includes('canAccessTabRef.current(tab as NavTab)'),
      'navigation requests must be validated against the user permissions'
    );
  });
});

describe('BS-seeding guidance — the countdown is visible before it bites', () => {
  test('the dashboard shows the coverage card for the roles that can seed', () => {
    const dashboard = read('client/src/features/dashboard/Dashboard.tsx');
    assert.ok(dashboard.includes('bsCalendarCoverage'), 'the dashboard must take the coverage prop');
    assert.ok(dashboard.includes('BS calendar coverage ends in'), 'the dashboard must count the days down');
    assert.ok(dashboard.includes('onNavigateTab(bsCalendarSeedTab)'), 'the card must link to the seeding screen');
    assert.ok(dashboard.includes('BS_SEEDING_MENU_PATH'), 'the card must name where to seed');
  });

  test('the notification bell carries the same alert and can dismiss it', () => {
    const center = read('client/src/components/common/NotificationCenter.tsx');
    assert.ok(center.includes('bsCalendarCoverage'), 'the bell must take the coverage prop');
    assert.ok(center.includes("id: 'bs-calendar-coverage'"), 'the alert needs a stable dismissible id');
    assert.ok(center.includes('calendarAlerts'), 'the alert must be part of the notification list');

    const app = read('client/src/App.tsx');
    assert.ok(
      app.includes("'bs-calendar-coverage'"),
      'Clear All must dismiss the coverage alert too, or it reappears immediately'
    );
    assert.ok(
      app.includes("getBsCalendarCoverage().status === 'OK' ? [] : ['bs-calendar-coverage']"),
      'App must only dismiss the alert while coverage is unhealthy'
    );
  });

  test('no seeding message anywhere still points at the non-existent menu', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const offenders = [...walk('client/src'), ...walk('server/src')]
      .filter((file) => fs.readFileSync(file, 'utf8').includes('System Settings'))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join('/'));
    assert.deepEqual(
      offenders,
      [],
      `these files still route the operator to a menu that does not exist:\n  ${offenders.join('\n  ')}`
    );
  });
});
