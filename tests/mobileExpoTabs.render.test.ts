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
import { buildDemoHrFixtures } from '../scripts/seed/demoHrFixtures';
import { buildDemoWorkplaceFixtures } from '../scripts/seed/demoWorkplaceFixtures';
import { buildDemoCoverageFixtures } from '../scripts/seed/demoCoverageFixtures';
// The payslip payload is built by the server's own projection from the seed
// fixture rows, so this test asserts the shape the controller really returns.
import { buildPayrollOutput } from '../server/src/services/payrollOutput.service';
import { buildDemoSelfServiceFixtures } from '../scripts/seed/demoSelfServiceFixtures';
import { HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS } from '../server/src/models/hrSelfService.repo';

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
const hr = buildDemoHrFixtures(dataset);
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
  /** Optional verb: the evidence route answers GET and POST on one path. */
  method?: string;
  body: unknown;
}

let requested: string[] = [];

function mockApi(routes: Route[]): void {
  requested = [];
  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = String(init?.method || 'GET').toUpperCase();
    requested.push(`${method} ${path}`);
    const hit = routes.find(
      (route) => path.startsWith(route.match) && (!route.method || route.method === method)
    );
    if (!hit) return jsonResponse({ message: `the render check has no fixture for ${method} ${path}` }, 404);
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

/**
 * The accountant (`demo-emp-011`) used to open Payslips on the unlock state and
 * then "No payslips on file": the persona had an employee record but no payroll
 * run line. The November run now carries one, so the payload below is the
 * server's own projection of that seeded line rather than a hand-written card.
 */
const PAYSLIP_PERSONA = 'demo-emp-011';
const slipLine = hr.payrollLines.find((row: any) => row.employee_id === PAYSLIP_PERSONA) as any;
const slipRun = hr.payrollRuns.find((row: any) => row.id === slipLine.run_id) as any;
const slipEmployee = hr.employees.find((row: any) => row.id === PAYSLIP_PERSONA) as any;
const slipBranch = dataset.branches.find((row: any) => row.id === slipRun.branch_id) as any;

const payslipsPayload = {
  payslips: buildPayrollOutput(
    {
      branchId: slipRun.branch_id,
      branchName: slipBranch.name,
      fiscalYearCode: '2083-84',
      runNo: slipRun.run_no,
      periodKey: slipRun.period_key,
      runDateAD: slipRun.run_date_ad,
      runDateBS: slipRun.run_date_bs,
      paidDateAD: null,
      paymentMethod: null,
      status: slipRun.status,
    },
    [
      {
        id: slipLine.id,
        employeeId: slipLine.employee_id,
        employeeCode: slipLine.employee_code,
        employeeName: slipLine.employee_name,
        periodKey: slipLine.period_key,
        basicAmount: slipLine.basic_amount,
        payableDays: slipLine.payable_days,
        lopDays: slipLine.lop_days,
        lopDeduction: slipLine.lop_deduction,
        overtimeHours: slipLine.overtime_hours,
        overtimeAmount: slipLine.overtime_amount,
        incentive: slipLine.incentive_amount,
        arrears: slipLine.arrears_amount,
        gross: slipLine.gross_amount,
        tds: slipLine.tds_amount,
        ssf: slipLine.ssf_amount,
        employerSsf: slipLine.employer_ssf_amount,
        advance: slipLine.advance_deduction,
        loan: slipLine.loan_deduction,
        net: slipLine.net_amount,
        bankName: slipLine.bank_name,
        bankAccount: slipLine.bank_account,
      },
    ],
    [
      {
        id: slipEmployee.id,
        name: slipEmployee.name,
        department: slipEmployee.department,
        designation: slipEmployee.designation,
        panNumber: slipEmployee.pan_number,
        ssfNumber: slipEmployee.ssf_number,
      },
    ],
    true
  ).payslips,
};

const reAuthPayload = { reAuthToken: 'render-check-reauth', expiresInSeconds: 300 };

/** The screen's own formatter (`money()` in screens.tsx), spelled out. */
const moneyText = (value: unknown) => `NPR ${Number(value).toLocaleString()}`;

/** Types into the first text field the way the device keyboard does. */
function typeInto(container: HTMLElement, value: string): void {
  const input = container.querySelector('input') as HTMLInputElement | null;
  assert.ok(input, 'the unlock form must render its password field');
  // jsdom's constructors live on the window, not on the test global; the native
  // setter is what keeps React's value tracker from swallowing the change.
  const view = container.ownerDocument.defaultView as any;
  const setValue = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input!, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Presses the control whose label matches, as the user would. */
function clickText(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('[data-rn="Pressable"]')].find(
    (element) => (element.textContent || '').trim() === label
  ) as HTMLElement | undefined;
  assert.ok(button, `expected a "${label}" control on screen`);
  act(() => {
    button!.click();
  });
}

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

  test('Payslips — the accountant unlocks the posted November payslip instead of the empty state', async () => {
    mockApi([
      { match: '/api/v1/auth/re-auth', body: reAuthPayload },
      { match: '/api/v1/payslips', body: payslipsPayload },
    ]);
    const tree = mountTree(createElement(screens.PayslipsScreen, { token: TOKEN }));
    await settle(2);
    // Locked before the password is typed, as the contract requires.
    expectOnScreen(tree.container, ['My payslips', 'Unlock payslips']);

    typeInto(tree.container, 'Demo@123');
    clickText(tree.container, 'Unlock payslips');
    await settle();

    const slip = payslipsPayload.payslips[0];
    assert.ok(Number(slip.net) > 0, 'the seeded payslip this persona reads must pay a nonzero net');
    expectOnScreen(tree.container, [
      `${slip.periodKey} · ${slip.status}`,
      moneyText(slip.gross),
      moneyText(slip.totalDeductions),
      moneyText(slip.net),
      slip.branchName,
    ]);
    expectNoEmptyBranch(tree.container, ['No payslips on file.']);
    assert.deepEqual(requested, ['POST /api/v1/auth/re-auth', 'GET /api/v1/payslips']);
    tree.unmount();
  });

  test('the API the tabs read is the documented mobile surface, not a stub path', async () => {
    mockApi([{ match: '/api/v1/workplace/bootstrap', body: bootstrapPayload }]);
    const tree = mountTree(
      createElement(screens.HomeScreen, { token: TOKEN, capabilities: CAPABILITIES, onOpen: () => undefined })
    );
    await settle();
    assert.deepEqual(requested, ['GET /api/v1/workplace/bootstrap']);
    tree.unmount();
  });
});


/**
 * The rest of the More hub: Expense claim, My documents, PAN/SSF/bank,
 * Approvals and Profile.
 *
 * Each screen is mounted for a seeded persona with `fetch` answering from the
 * same server projection the controller uses (`HR_SELF_PROFILE_MOBILE_SQL`,
 * `HR_SELF_SENSITIVE_SQL`, `HR_SELF_DOCUMENTS_SQL`, `MOBILE_CLAIM_BY_ID_SQL`,
 * `APPROVAL_CLAIMS_PENDING_SQL`), applied to the fixture rows that seed the
 * database — so the screen is proven against the shape the API really returns.
 */
describe('the More-hub screens reach their loaded state', () => {
  const selfService = buildDemoSelfServiceFixtures(dataset);

  const branchNameOf = (branchId: string) =>
    (dataset.branches.find((row: any) => row.id === branchId) as any)?.name ?? branchId;

  const employeeRow = (employeeId: string) =>
    hr.employees.find((row: any) => row.id === employeeId) as any;

  /** HR_SELF_PROFILE_MOBILE_SQL, field for field. */
  const profilePayload = (employeeId: string) => {
    const row = employeeRow(employeeId);
    return {
      id: row.id,
      employeeCode: row.employee_code,
      name: row.name,
      branchId: row.branch_id,
      branchName: branchNameOf(row.branch_id),
      department: row.department,
      designation: row.designation,
      employmentType: row.employment_type,
      workStation: row.work_station,
      joiningDateAD: row.joining_date_ad,
      contractExpiryAD: row.contract_expiry_ad,
      internalEmail: row.internal_email,
      personalEmail: row.personal_email,
      personalContact: row.personal_contact,
      emergencyContactPerson: row.emergency_contact_person,
      emergencyContactNumber: row.emergency_contact_number,
      address: row.address,
      isActive: row.is_active,
      profilePhoto: null,
    };
  };

  /** HR_SELF_SENSITIVE_SQL plus the controller's `viewedAt`. */
  const sensitivePayload = (employeeId: string) => {
    const row = employeeRow(employeeId);
    return {
      id: row.id,
      employeeCode: row.employee_code,
      panNumber: row.pan_number,
      ssfNumber: row.ssf_number,
      ssfEligible: row.ssf_eligible,
      bankName: row.bank_name,
      bankAccount: row.bank_account,
      monthlySalary: Number(row.monthly_salary),
      viewedAt: '2026-11-24T08:00:00Z',
    };
  };

  /** HR_SELF_DOCUMENTS_SQL, including its expiry CASE, plus `contentUrl`. */
  const documentsPayload = (employeeId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const documents = hr.documents
      .filter((row: any) => row.employee_id === employeeId)
      .map((row: any) => {
        const expiresOnAD = row.expires_on_ad ? String(row.expires_on_ad).slice(0, 10) : null;
        const expiryStatus = !expiresOnAD
          ? 'NO_EXPIRY'
          : expiresOnAD < today
            ? 'EXPIRED'
            : expiresOnAD <= soon
              ? 'EXPIRING'
              : 'VALID';
        return {
          id: row.id,
          docType: row.doc_type,
          title: row.original_name,
          mimeType: row.mime_type,
          byteSize: Number(row.byte_size),
          issuedOnAD: null,
          expiresOnAD,
          expiryStatus,
          uploadedAt: null,
          notes: row.notes,
          uploadedBy: row.uploaded_by,
          contentUrl: `/api/employees/${employeeId}/documents/${row.id}/content`,
        };
      });
    return {
      expirySoonDays: HR_SELF_DOCUMENT_EXPIRY_SOON_DAYS,
      summary: {
        totalDocuments: documents.length,
        expiringSoon: documents.filter((doc) => doc.expiryStatus === 'EXPIRING').length,
        expiredDocuments: documents.filter((doc) => doc.expiryStatus === 'EXPIRED').length,
      },
      documents,
    };
  };

  /** MOBILE_CLAIM_BY_ID_SQL. */
  const claimPayload = (claimId: string) => {
    const claim = [...selfService.expenseClaims, coverage.mobileClaim].find(
      (row: any) => row.id === claimId
    ) as any;
    return {
      id: claim.id,
      status: claim.status,
      submitted_at: claim.submitted_at,
      amount: Number(claim.amount),
      category: claim.category,
    };
  };

  /** APPROVAL_CLAIMS_PENDING_SQL, for the approver's own branch. */
  const approvalsPayload = (approverEmployeeId: string) => {
    const approver = employeeRow(approverEmployeeId);
    const claims = [...selfService.expenseClaims, coverage.mobileClaim]
      .filter(
        (row: any) =>
          row.branch_id === approver.branch_id &&
          row.status === 'SUBMITTED' &&
          row.employee_id !== approver.id
      )
      .map((row: any) => ({
        id: row.id,
        employeeId: row.employee_id,
        employeeName: employeeRow(row.employee_id).name,
        category: row.category,
        amount: Number(row.amount),
        currency: row.currency,
        ticketCode: row.ticket_code ?? null,
        description: row.description,
        receiptAttached: row.receipt_attached,
        status: row.status,
        submittedAt: row.submitted_at,
      }))
      .sort((left, right) => String(left.submittedAt).localeCompare(String(right.submittedAt)));
    // APPROVAL_PUNCHES_PENDING_SQL needs an unreviewed HELD/FLAGGED proof inside
    // the 14-day review window; every seeded proof is ACCEPTED, so the queue is
    // empty by fixture and the screen's punch section is honestly empty.
    const punches: any[] = [];
    return {
      claims,
      punches,
      delegations: [],
      counts: { claims: claims.length, punches: punches.length },
    };
  };

  /** Types into the nth text field, as the device keyboard does. */
  function typeIntoField(container: HTMLElement, index: number, value: string): void {
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const input = inputs[index];
    assert.ok(input, `expected a field at index ${index}, saw ${inputs.length}`);
    const view = container.ownerDocument.defaultView as any;
    const setValue = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  test('Expense claim — the accountant finds a seeded claim by its id', async () => {
    const claim = claimPayload('demo-expense-008');
    mockApi([{ match: '/api/v1/workplace/claims/', body: claim }]);
    const tree = mountTree(createElement(screens.ClaimsScreen, { token: TOKEN }));
    await settle(2);
    expectOnScreen(tree.container, ['Expense claim', 'Submit claim', 'Find a claim']);
    assert.ok(
      !textOf(tree.container).includes('Claim not found.'),
      'the lookup must not start on an error'
    );

    // Amount, description, then the "Find a claim" field.
    typeIntoField(tree.container, 2, claim.id);
    clickText(tree.container, 'Look it up');
    await settle();

    // The card shows the id, the status and the ledger outbox state the API
    // returns; the amount is carried in the payload but not printed by this screen.
    expectOnScreen(tree.container, [claim.id, claim.status, 'Accounting']);
    assert.match(textOf(tree.container), /submitted/);
    assert.ok(Number(claim.amount) > 0, 'the seeded claim must carry a nonzero amount');
    assert.deepEqual(requested, [`GET /api/v1/workplace/claims/${claim.id}`]);
    tree.unmount();
  });

  test('My documents — the Kathmandu manager unlocks the seeded contract', async () => {
    const documents = documentsPayload(PERSONA);
    mockApi([
      { match: '/api/v1/auth/re-auth', body: reAuthPayload },
      { match: '/api/v1/documents', body: documents },
    ]);
    const tree = mountTree(
      createElement(screens.SensitiveScreen, { token: TOKEN, mode: 'documents' })
    );
    const first = documents.documents[0];
    assert.ok(first, 'the persona must have a seeded document');
    expectOnScreen(tree.container, ['My documents', 'Unlock']);
    typeInto(tree.container, 'Demo@123');
    clickText(tree.container, 'Unlock');
    await settle();

    expectOnScreen(tree.container, [
      first.title,
      first.docType,
      first.expiryStatus,
      String(first.expiresOnAD),
    ]);
    expectNoEmptyBranch(tree.container, ['No documents on file.']);
    tree.unmount();
  });

  test('PAN, SSF, bank — the auditor unlocks their statutory detail', async () => {
    const detail = sensitivePayload('demo-emp-020');
    mockApi([
      { match: '/api/v1/auth/re-auth', body: reAuthPayload },
      { match: '/api/v1/hr/me/sensitive', body: detail },
    ]);
    const tree = mountTree(
      createElement(screens.SensitiveScreen, { token: TOKEN, mode: 'sensitive' })
    );
    await settle(2);
    expectOnScreen(tree.container, ['PAN, SSF and bank', 'Unlock']);
    typeInto(tree.container, 'Demo@123');
    clickText(tree.container, 'Unlock');
    await settle();

    expectOnScreen(tree.container, [
      'PAN',
      String(detail.panNumber),
      'SSF',
      String(detail.ssfNumber),
      String(detail.bankName),
      String(detail.bankAccount),
      moneyText(detail.monthlySalary),
    ]);
    tree.unmount();
  });

  test('Approvals — the superadmin sees the branch claims waiting on a decision', async () => {
    const approvals = approvalsPayload('demo-emp-001');
    assert.ok(approvals.claims.length > 0, 'the approver branch must hold a pending claim');
    mockApi([{ match: '/api/v1/workplace/approvals', body: approvals }]);
    const tree = mountTree(
      createElement(screens.ApprovalsScreen, { token: TOKEN, capabilities: CAPABILITIES })
    );
    await settle();

    const first = approvals.claims[0];
    expectOnScreen(tree.container, [
      `Expense claims (${approvals.claims.length})`,
      first.employeeName,
      first.category,
      moneyText(first.amount),
      'Approve',
      'Reject',
      'Flagged punches (0)',
    ]);
    expectNoEmptyBranch(tree.container, ['No claims are waiting in this branch.']);
    tree.unmount();
  });

  test('Profile — the inventory manager sees their own card, without salary or PAN', async () => {
    const profile = profilePayload('demo-emp-007');
    mockApi([{ match: '/api/v1/profile', body: profile }]);
    const tree = mountTree(createElement(screens.ProfileScreen, { token: TOKEN }));
    await settle();

    expectOnScreen(tree.container, [
      profile.name,
      `${profile.employeeCode} · ${profile.designation}`,
      profile.branchName,
      String(profile.joiningDateAD),
      String(profile.internalEmail),
    ]);
    // The same employee's sensitive half exists; the everyday projection must
    // not carry any of it (HR_SELF_PROFILE_MOBILE_SQL has no PAN/salary column).
    const secret = sensitivePayload('demo-emp-007');
    const rendered = textOf(tree.container);
    assert.ok(!rendered.includes(String(secret.panNumber)), 'the everyday card must not show PAN');
    assert.ok(!rendered.includes(String(secret.bankAccount)), 'the everyday card must not show the bank account');
    assert.ok(
      !rendered.includes(moneyText(secret.monthlySalary)),
      'the everyday card must not show salary'
    );
    tree.unmount();
  });
});

/**
 * Job detail and completion — the last mobile screen without a render check.
 *
 * The seeded Kathmandu front desk (`demo-emp-002`) holds the open install
 * WO-DEMO-001, which carries one proof capture in the fixtures. The test opens
 * it from the derived Jobs list, checks the detail and its evidence against the
 * same projections the server uses (`MOBILE_JOB_QUEUE_SQL`, the evidence list in
 * `listWorkOrderEvidence`), then completes the visit and asserts the payload the
 * `completeWorkOrder` service returns.
 */
describe('job detail and completion', () => {
  const FIELD_EMPLOYEE = 'demo-emp-002';
  const QUEUE_SQL_STATUSES = ['OPEN', 'ASSIGNED'];

  /** MOBILE_JOB_QUEUE_SQL, field for field — the same shape mobileExpoTabs uses. */
  const queueFor = (employeeId: string) => {
    const employee = hr.employees.find((row: any) => row.id === employeeId) as any;
    const jobs = workplace.workOrders
      .filter(
        (row: any) =>
          row.technician_id === employeeId &&
          row.branch_id === employee.branch_id &&
          QUEUE_SQL_STATUSES.includes(String(row.status))
      )
      .map((row: any) => {
        const customer = dataset.customers.find((entry: any) => entry.id === row.customer_id) as any;
        return {
          id: row.id,
          workOrderNo: row.work_order_no,
          kind: row.kind,
          status: row.status,
          customerId: row.customer_id,
          customerName: customer?.customerName ?? null,
          scheduledDateAD: row.scheduled_date_ad,
          notes: row.notes,
          rowVersion: 1,
        };
      });
    return { jobs, count: jobs.length };
  };

  const queue = queueFor(FIELD_EMPLOYEE);
  const job = queue.jobs.find((row: any) => row.status === 'ASSIGNED') as any;
  const jobRow = workplace.workOrders.find((row: any) => row.id === job.id) as any;

  /** listWorkOrderEvidence's projection for this order. */
  const evidenceFor = (workOrderId: string) => {
    const rows = workplace.evidence.filter((row: any) => row.work_order_id === workOrderId);
    return {
      workOrderId,
      evidence: rows.map((row: any) => ({
        id: row.id,
        kind: row.kind,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        capturedAt: row.captured_at,
        caption: row.caption,
      })),
      count: rows.length,
    };
  };

  /** completeWorkOrder's response: the row reopened at the next version. */
  const completionFor = (workOrderId: string) => ({
    workOrderId,
    resultStatus: 'CLOSED',
    message: 'Operational close committed.',
    baseVersion: Number(jobRow.row_version) + 1,
  });

  /** clicks the card whose text contains the label, as a finger would. */
  function clickContaining(container: HTMLElement, label: string): void {
    const card = [...container.querySelectorAll('[data-rn="Pressable"]')].find((element) =>
      (element.textContent || '').includes(label)
    ) as HTMLElement | undefined;
    assert.ok(card, `expected a card containing "${label}"`);
    act(() => {
      card!.click();
    });
  }

  test('the open visit is opened from the Jobs list, shows its proof, and closes', async () => {
    assert.ok(job, 'the seeded queue must hold an assigned visit');
    const opened: any[] = [];
    mockApi([{ match: '/api/v1/workplace/jobs', body: queue }]);
    const list = mountTree(
      createElement(screens.JobsScreen, {
        token: TOKEN,
        onOpenJob: (next: any) => opened.push(next),
      })
    );
    await settle();
    expectOnScreen(list.container, [job.workOrderNo, job.customerName, 'ASSIGNED']);
    clickContaining(list.container, job.workOrderNo);
    assert.equal(opened.length, 1, 'tapping the seeded card must open that visit');
    assert.equal(opened[0].id, job.id);
    list.unmount();
  });

  test('the detail renders the seeded visit and its proof, then completes the job', async () => {
    const evidence = evidenceFor(job.id);
    const completion = completionFor(job.id);
    assert.ok(evidence.count > 0, 'the seeded visit must carry a proof capture');

    const completed: string[] = [];
    mockApi([
      { match: `/api/v1/workplace/jobs/${job.id}/evidence`, body: evidence },
      {
        match: `/api/v1/workplace/jobs/${job.id}/complete`,
        method: 'POST',
        body: completion,
      },
    ]);
    const tree = mountTree(
      createElement(screens.JobScreen, {
        token: TOKEN,
        job,
        onBack: () => undefined,
        onCompleted: () => completed.push(job.id),
      })
    );
    await settle();

    const proof = evidence.evidence[0];
    // formatBytes in screens.tsx: below one MiB it prints whole KB, minimum 1.
    const proofSize = `${Math.max(1, Math.round(Number(proof.byteSize) / 1024))} KB`;
    expectOnScreen(tree.container, [
      job.workOrderNo,
      `v${job.rowVersion}`,
      job.customerName,
      String(job.scheduledDateAD),
      job.status,
      jobRow.notes,
      `Captures on this job (${evidence.count})`,
      proof.kind === 'PHOTO' ? 'Photo' : 'Signature',
      proofSize,
      String(proof.sha256).slice(0, 12),
      proof.caption,
      'Close the visit',
      'Complete job',
    ]);
    expectNoEmptyBranch(tree.container, ['No proof stored yet.']);

    // The completion note is the only text field on this screen.
    typeInto(tree.container, 'ONT mounted, drop cable run, 100 Mbps verified on site.');
    clickText(tree.container, 'Complete job');
    await settle();

    expectOnScreen(tree.container, [
      `${completion.resultStatus}: ${completion.message}`,
    ]);
    assert.deepEqual(completed, [job.id], 'the screen must report the completion to the app shell');
    assert.deepEqual(requested, [
      `GET /api/v1/workplace/jobs/${job.id}/evidence`,
      `POST /api/v1/workplace/jobs/${job.id}/complete`,
    ]);
    tree.unmount();
  });
});
