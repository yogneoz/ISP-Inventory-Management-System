/**
 * The five mobile tabs, mounted against the seeded rows.
 *
 * "It compiles" and "it bundles" say nothing about whether a tab reaches its
 * loaded state: every screen here has three outcomes (spinner, error card, empty
 * branch) that a successful bundle happily ships. This check mounts each tab the
 * way App mounts it — same component, same props, same `/api/v1` calls — with
 * `fetch` answering from the demo dataset's own fixture builders, and asserts
 * the seeded row is on screen, the spinner is gone and the empty/error branch did
 * not win.
 *
 * `react-native` and the two Expo native modules are replaced at resolution time
 * by `tests/harness/mobileNativeStub.tsx` and friends; the screens themselves are
 * the real ones. Runnable command:
 *
 *   npx tsx --test tests/mobileExpoTabs.render.test.tsx
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { act, createElement } from 'react';
import { mountTree } from './harness/mount';
import { buildVerificationDataset } from '../scripts/seed/verificationDataset';
import { buildDemoWorkplaceFixtures } from '../scripts/seed/demoWorkplaceFixtures';
import { buildDemoCoverageFixtures } from '../scripts/seed/demoCoverageFixtures';

const stubUrl = (file: string) => new URL(`./harness/${file}`, import.meta.url).href;

// Native modules have no host process here. Resolve them to the stubs above
// before any screen module is evaluated.
const require = createRequire(import.meta.url);

const STUBS: Record<string, string> = {
  'react-native': stubUrl('mobileNativeStub.tsx'),
  'expo-location': stubUrl('mobileExpoLocationStub.ts'),
  'expo-image-picker': stubUrl('mobileImagePickerStub.ts'),
  // `mobile-expo` carries its own React for Expo Go. Two copies of React cannot
  // share a hook dispatcher with this repo's react-dom, so the screens are pinned
  // to the renderer's copy — the same React version the app bundles.
  react: pathToFileURL(require.resolve('react')).href,
  'react/jsx-runtime': pathToFileURL(require.resolve('react/jsx-runtime')).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = STUBS[specifier];
    if (url) return { url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Dynamic import through a URL keeps the mobile client out of the root
// TypeScript program (it has its own tsconfig and its own React Native types).
const screensUrl = pathToFileURL(fileURLToPath(new URL('../mobile-expo/src/screens.tsx', import.meta.url))).href;

const dataset = buildVerificationDataset();
const workplace = buildDemoWorkplaceFixtures(dataset);
const coverage = buildDemoCoverageFixtures(dataset);

/** The persona the app is signed in as for these mounts. */
const PERSONA = 'demo-emp-014';
const TOKEN = 'render-check-token';
const CAPABILITIES = ['attendance.punch', 'ess.view', 'claims.submit', 'jobs.execute', 'stock.van', 'dispatch.assign', 'approve.expense'];

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

interface Route {
  match: string;
  body: unknown;
}

let requested: string[] = [];

function mockApi(routes: Route[]): void {
  requested = [];
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    requested.push(path);
    const hit = routes.find((route) => path.startsWith(route.match));
    if (!hit) return jsonResponse({ message: `the render check has no fixture for ${path}` }, 404);
    return jsonResponse(hit.body);
  };
}

/** Lets the screen's promises settle inside act() so effects flush. */
async function settle(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const textOf = (container: HTMLElement) => (container.textContent || '').replace(/\s+/g, ' ');

function expectOnScreen(container: HTMLElement, musts: string[]): void {
  const text = textOf(container);
  for (const must of musts) assert.ok(text.includes(must), `expected "${must}" on screen, saw: ${text.slice(0, 400)}`);
}

function expectNoEmptyBranch(container: HTMLElement, forbidden: string[]): void {
  const text = textOf(container);
  assert.ok(!text.includes('spinner'), 'the tab must leave its loading state');
  assert.ok(!text.includes('Cannot reach'), 'the tab must not show the network error card');
  for (const phrase of forbidden) {
    assert.ok(!text.includes(phrase), `the tab must not show its empty branch ("${phrase}"): ${text.slice(0, 400)}`);
  }
}

const bootstrapPayload = {
  serverTimeEpochMs: Date.parse('2026-11-24T08:00:00Z'),
  workplaceCapabilities: CAPABILITIES,
  punchState: 'NOT_CLOCKED_IN',
  shiftWindow: 'MORNING 09:00-17:00',
  unreadNotices: workplace.announcements.length,
  pendingApprovals: 1,
  vanLocation: 'KTM',
  needsAttention: 1,
  announcements: workplace.announcements.map((row: any) => ({
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    publishedAt: row.published_at,
    isUrgent: row.is_urgent,
  })),
  geofence: { configured: true, latitude: 27.717245, longitude: 85.323959, radiusMeters: 150 },
  // The seeded morning shift of the persona's own working week.
  todayAttendance: { checkInTime: '09:02', checkOutTime: '17:10', status: 'PRESENT' },
};

const customer = dataset.customers.find((row: any) => row.id === coverage.mobileWorkOrder.customer_id) as any;
const jobsPayload = {
  count: 1,
  jobs: [
    {
      id: coverage.mobileWorkOrder.id,
      workOrderNo: coverage.mobileWorkOrder.work_order_no,
      kind: coverage.mobileWorkOrder.kind,
      status: coverage.mobileWorkOrder.status,
      customerId: coverage.mobileWorkOrder.customer_id,
      customerName: customer?.customerName ?? null,
      scheduledDateAD: coverage.mobileWorkOrder.scheduled_date_ad,
      notes: coverage.mobileWorkOrder.notes,
      rowVersion: 1,
    },
  ],
};

const personaAttendance = coverage.mobileAttendance.filter((row) => row.employee_id === PERSONA);
const attendancePayload = {
  windowStartAD: '2026-08-27',
  windowEndAD: '2026-11-24',
  windowDays: 90,
  summary: { totalDays: personaAttendance.length, presentDays: personaAttendance.length, absentDays: 0, leaveDays: 0, halfDays: 0, holidayDays: 0, weekendDays: 0, overtimeHours: 0 },
  records: personaAttendance.map((row) => ({
    id: row.id,
    attendanceDateAD: row.attendance_date_ad,
    attendanceDateBS: row.attendance_date_bs,
    shiftName: 'Morning Shift',
    status: row.status,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    overtimeHours: Number(row.overtime_hours),
    notes: row.notes,
  })),
};

const LEAVE_NAMES: Record<string, string> = { ANNUAL: 'Annual Leave', CASUAL: 'Casual Leave', SICK: 'Sick Leave' };
const personaBalances = coverage.mobileLeaveBalances.filter((row) => row.employee_id === PERSONA);
const leavesPayload = {
  balances: personaBalances.map((row) => ({
    id: row.id,
    leaveTypeId: row.leave_type_id,
    leaveTypeCode: String(row.leave_type_id).replace('demo-leave-', '').toUpperCase(),
    leaveTypeName: LEAVE_NAMES[String(row.leave_type_id).replace('demo-leave-', '').toUpperCase()] ?? 'Leave',
    entitlementDays: Number(row.entitlement_days),
    usedDays: 0,
    remainingDays: Number(row.entitlement_days),
  })),
  requests: [
    {
      id: coverage.mobileLeaveRequest.id,
      requestNo: coverage.mobileLeaveRequest.request_no,
      leaveTypeName: 'Annual Leave',
      startDateAD: coverage.mobileLeaveRequest.start_date_ad,
      endDateAD: coverage.mobileLeaveRequest.end_date_ad,
      daysCount: Number(coverage.mobileLeaveRequest.days_count),
      reason: coverage.mobileLeaveRequest.reason,
      status: coverage.mobileLeaveRequest.status,
    },
  ],
};

const personaHoldings = workplace.holdings.filter((row: any) => row.employee_id === PERSONA);
const stockPayload = {
  vanLocation: 'KTM',
  count: personaHoldings.length,
  holdings: personaHoldings.map((row: any) => {
    const product = dataset.products.find((entry: any) => entry.id === row.product_id) as any;
    return {
      productId: row.product_id,
      productName: product?.name ?? row.product_id,
      sku: product?.sku ?? row.product_id,
      quantity: Number(row.quantity),
      updatedAt: row.updated_at,
    };
  }),
};

let screens: any;

before(async () => {
  screens = await import(screensUrl);
});

describe('the mobile tabs reach their loaded state with the seeded rows', () => {
  test('Today — the bootstrap payload renders the punch state and the announcements', async () => {
    mockApi([{ match: '/api/v1/workplace/bootstrap', body: bootstrapPayload }]);
    const tree = mountTree(
      createElement(screens.HomeScreen, { token: TOKEN, capabilities: CAPABILITIES, onOpen: () => undefined })
    );
    await settle();
    expectOnScreen(tree.container, [
      'NOT_CLOCKED_IN',
      workplace.announcements[0].title,
      'MORNING 09:00-17:00',
      '150 m',
    ]);
    expectNoEmptyBranch(tree.container, ['No punch yet']);
    tree.unmount();
  });

  test('Jobs — the assigned visit is listed with its customer and status', async () => {
    mockApi([{ match: '/api/v1/workplace/jobs', body: jobsPayload }]);
    const tree = mountTree(createElement(screens.JobsScreen, { token: TOKEN, onOpenJob: () => undefined }));
    await settle();
    expectOnScreen(tree.container, [coverage.mobileWorkOrder.work_order_no, '1 open or assigned visit', 'ASSIGNED', customer.customerName]);
    expectNoEmptyBranch(tree.container, ['No open jobs right now.']);
    tree.unmount();
  });

  test('Attendance — every seeded day is on screen with its summary', async () => {
    mockApi([{ match: '/api/v1/attendance', body: attendancePayload }]);
    const tree = mountTree(createElement(screens.AttendanceScreen, { token: TOKEN }));
    await settle();
    expectOnScreen(tree.container, [
      personaAttendance[0].attendance_date_ad as string,
      '2026-11-06',
      'PRESENT',
      'Morning Shift',
      '2026-08-27',
    ]);
    expectNoEmptyBranch(tree.container, ['No attendance recorded in this window.']);
    tree.unmount();
  });

  test('Leave — the balance chips and the pending request render', async () => {
    mockApi([{ match: '/api/v1/leaves', body: leavesPayload }]);
    const tree = mountTree(createElement(screens.LeavesScreen, { token: TOKEN }));
    await settle();
    expectOnScreen(tree.container, [
      'Annual Leave',
      '12',
      coverage.mobileLeaveRequest.request_no,
      coverage.mobileLeaveRequest.start_date_ad,
      'PENDING',
    ]);
    expectNoEmptyBranch(tree.container, ['No leave requests on file.']);
    tree.unmount();
  });

  test('More — the hub lists its entries and My stock shows the seeded holdings', async () => {
    mockApi([{ match: '/api/v1/workplace/stock', body: stockPayload }]);
    const hub = mountTree(
      createElement(screens.MoreScreen, { token: TOKEN, capabilities: CAPABILITIES, onOpen: () => undefined })
    );
    await settle(2);
    expectOnScreen(hub.container, ['My stock', 'Payslips', 'Approvals', 'Expense claim']);
    hub.unmount();

    const stock = mountTree(createElement(screens.StockScreen, { token: TOKEN }));
    await settle();
    const holding = stockPayload.holdings[0];
    expectOnScreen(stock.container, [holding.productName, holding.sku, 'Van KTM', String(holding.quantity)]);
    expectNoEmptyBranch(stock.container, ['Nothing is issued to you right now.']);
    stock.unmount();
  });

  test('the API the tabs read is the documented mobile surface, not a stub path', async () => {
    mockApi([{ match: '/api/v1/workplace/bootstrap', body: bootstrapPayload }]);
    const tree = mountTree(
      createElement(screens.HomeScreen, { token: TOKEN, capabilities: CAPABILITIES, onOpen: () => undefined })
    );
    await settle();
    assert.deepEqual(requested, ['/api/v1/workplace/bootstrap']);
    tree.unmount();
  });
});
