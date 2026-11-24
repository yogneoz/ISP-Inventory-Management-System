/**
 * Canonical demo workplace fixtures: the dispatch board, proof of work, van
 * custody, shift roster, field tracking and branch presence.
 *
 * These are the screens the earlier fixture modules left empty, because their
 * tables did not exist when those modules were written. They are deliberately
 * non-posting and non-consuming:
 *
 *   * no journal is written, so the seven verified trial-balance figures
 *     (AR 10,000 / AP 15,000 / Inventory 20,000 / Cash + Bank 10,000 /
 *     Equity 50,000 / Fixed assets 24,000 / Prepaid 5,000) stay exact;
 *   * `inventory_stock` is not touched, so "5 pieces per product per branch"
 *     stays exact too. The custody holdings below are the units *within* that
 *     5 that are sitting in a technician's van — the real service decrements
 *     branch stock on ISSUE, and seeding it that way would leave the verified
 *     count at 2–4 pieces and fail the seed's own gate.
 *
 * The movement rows still add up to the holdings rows exactly, because the
 * custody register derives its balance by summing movements
 * (server/src/models/employeeStock.repo.ts `appendMovement`), not by reading
 * `employee_stock_holdings`. A fixture that wrote only the holdings row would
 * show a quantity the register itself would call impossible.
 */
import crypto from 'node:crypto';
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

/** A 1×1 PNG: small, valid, and byte-identical on every seed. */
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A second, different 1×1 PNG for signatures. `uq_field_work_order_evidence_capture`
 * is unique on (work_order_id, sha256) — that index is what makes a re-sent
 * capture answer "already on file" — so a photo and a signature on the same job
 * must not be byte-identical, or the second insert is (correctly) refused.
 */
const DEMO_SIGNATURE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function sha256OfBase64(base64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

const DEMO_PNG_BYTES = Buffer.from(DEMO_PNG_BASE64, 'base64').length;
const DEMO_PNG_SHA256 = sha256OfBase64(DEMO_PNG_BASE64);
const DEMO_SIGNATURE_BYTES = Buffer.from(DEMO_SIGNATURE_BASE64, 'base64').length;
const DEMO_SIGNATURE_SHA256 = sha256OfBase64(DEMO_SIGNATURE_BASE64);

function uuid(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export interface DemoWorkplaceFixtures {
  workOrders: Row[];
  evidence: Row[];
  holdings: Row[];
  movements: Row[];
  roster: Row[];
  breadcrumbs: Row[];
  attendanceProofs: Row[];
  announcements: Row[];
  geofences: Row[];
}

/**
 * The five technicians the dispatch board needs. Every one of them is also a
 * demo login, so whoever signs in finds work assigned to their own account.
 */
const TECHNICIANS = [
  { employeeId: 'demo-emp-002', name: 'Nisha Karki', branchId: 'BR-KTM' },
  { employeeId: 'demo-emp-003', name: 'Bikash Thapa', branchId: 'BR-PKR' },
  { employeeId: 'demo-emp-004', name: 'Sita Gurung', branchId: 'BR-BTL' },
  { employeeId: 'demo-emp-005', name: 'Rajan Rai', branchId: 'BR-DHN' },
  { employeeId: 'demo-emp-014', name: 'Rohit Karki', branchId: 'BR-KTM' },
] as const;

export function buildDemoWorkplaceFixtures(dataset: VerificationDataset): DemoWorkplaceFixtures {
  const customerFor = (branchId: string, index: number): any => {
    const branchCustomers = dataset.customers.filter((customer: any) => customer.branchId === branchId);
    return branchCustomers[index % branchCustomers.length];
  };
  const tech = (employeeId: string) => TECHNICIANS.find((entry) => entry.employeeId === employeeId) as any;

  const workOrder = (input: {
    index: number;
    no: string;
    branchId: string;
    customerIndex: number;
    kind: 'INSTALL' | 'SERVICE' | 'DISCONNECT';
    status: 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
    technicianId?: string;
    scheduledDate: string;
    completedDate?: string;
    plan: string | null;
    notes: string;
    completionNotes?: string;
  }): Row => {
    const employee = input.technicianId ? tech(input.technicianId) : null;
    const customer = customerFor(input.branchId, input.customerIndex);
    return {
      id: uuid(input.index),
      work_order_no: input.no,
      branch_id: input.branchId,
      customer_id: customer.id,
      kind: input.kind,
      status: input.status,
      technician_id: employee?.employeeId ?? null,
      technician_name: employee?.name ?? null,
      scheduled_date_ad: input.scheduledDate,
      scheduled_date_bs: bsOn(input.scheduledDate),
      plan_name: input.plan,
      notes: input.notes,
      completion_notes: input.completionNotes ?? null,
      // The table's own CHECK: COMPLETED and completed_at are set together.
      completed_at: input.completedDate ? `${input.completedDate}T09:30:00Z` : null,
      created_by: SEED,
    };
  };

  const workOrders: Row[] = [
    workOrder({
      index: 1, no: 'WO-DEMO-001', branchId: 'BR-KTM', customerIndex: 0, kind: 'INSTALL',
      status: 'ASSIGNED', technicianId: 'demo-emp-002', scheduledDate: '2026-11-24',
      plan: 'Home Fibre 100 Mbps', notes: 'New connection; drop cable to the second floor.',
    }),
    workOrder({
      index: 2, no: 'WO-DEMO-002', branchId: 'BR-KTM', customerIndex: 1, kind: 'SERVICE',
      status: 'COMPLETED', technicianId: 'demo-emp-002', scheduledDate: '2026-11-20',
      completedDate: '2026-11-20', plan: 'Home Fibre 100 Mbps',
      notes: 'No sync after the pole work; replace the ONU if the PON LED stays red.',
      completionNotes: 'ONU replaced, 100 Mbps verified, customer signature captured.',
    }),
    workOrder({
      index: 3, no: 'WO-DEMO-003', branchId: 'BR-PKR', customerIndex: 2, kind: 'INSTALL',
      status: 'ASSIGNED', technicianId: 'demo-emp-003', scheduledDate: '2026-11-25',
      plan: 'Home Fibre 200 Mbps', notes: 'Lakeside apartment; building owner has the duct plan.',
    }),
    workOrder({
      index: 4, no: 'WO-DEMO-004', branchId: 'BR-DHN', customerIndex: 0, kind: 'SERVICE',
      status: 'COMPLETED', technicianId: 'demo-emp-005', scheduledDate: '2026-11-19',
      completedDate: '2026-11-19', plan: 'Business Fibre 300 Mbps',
      notes: 'Intermittent loss reported at the shop; check the splitter port.',
      completionNotes: 'Splitter port re-terminated; loss tests clean. Signed by the shop owner.',
    }),
    workOrder({
      index: 5, no: 'WO-DEMO-005', branchId: 'BR-BTL', customerIndex: 3, kind: 'INSTALL',
      status: 'OPEN', scheduledDate: '2026-11-26', plan: null,
      notes: 'Awaiting technician assignment; the customer confirmed the address.',
    }),
    workOrder({
      index: 6, no: 'WO-DEMO-006', branchId: 'BR-KTM', customerIndex: 4, kind: 'DISCONNECT',
      status: 'CANCELLED', scheduledDate: '2026-11-18', plan: 'Home Fibre 50 Mbps',
      notes: 'Customer withdrew the disconnection request and renewed the plan.',
    }),
  ];

  const evidenceRow = (input: {
    index: number;
    workOrderIndex: number;
    branchId: string;
    kind: 'PHOTO' | 'SIGNATURE';
    caption: string;
    capturedAt: string;
    capturedBy: string;
    latitude: number;
    longitude: number;
  }): Row => ({
    id: uuid(100 + input.index),
    work_order_id: uuid(input.workOrderIndex),
    branch_id: input.branchId,
    kind: input.kind,
    content_type: 'image/png',
    byte_size: input.kind === 'SIGNATURE' ? DEMO_SIGNATURE_BYTES : DEMO_PNG_BYTES,
    sha256: input.kind === 'SIGNATURE' ? DEMO_SIGNATURE_SHA256 : DEMO_PNG_SHA256,
    data_base64: input.kind === 'SIGNATURE' ? DEMO_SIGNATURE_BASE64 : DEMO_PNG_BASE64,
    caption: input.caption,
    captured_at: input.capturedAt,
    captured_by: input.capturedBy,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: 8.5,
  });

  const evidence: Row[] = [
    evidenceRow({
      index: 1, workOrderIndex: 2, branchId: 'BR-KTM', kind: 'PHOTO',
      caption: 'New ONU installed and synced', capturedAt: '2026-11-20T06:15:00Z',
      capturedBy: 'Nisha Karki', latitude: 27.717245, longitude: 85.323959,
    }),
    evidenceRow({
      index: 2, workOrderIndex: 2, branchId: 'BR-KTM', kind: 'SIGNATURE',
      caption: 'Customer sign-off', capturedAt: '2026-11-20T06:22:00Z',
      capturedBy: 'Nisha Karki', latitude: 27.717245, longitude: 85.323959,
    }),
    evidenceRow({
      index: 3, workOrderIndex: 4, branchId: 'BR-DHN', kind: 'PHOTO',
      caption: 'Re-terminated splitter port', capturedAt: '2026-11-19T07:05:00Z',
      capturedBy: 'Rajan Rai', latitude: 26.812345, longitude: 87.283333,
    }),
    evidenceRow({
      index: 4, workOrderIndex: 4, branchId: 'BR-DHN', kind: 'SIGNATURE',
      caption: 'Shop owner sign-off', capturedAt: '2026-11-19T07:12:00Z',
      capturedBy: 'Rajan Rai', latitude: 26.812345, longitude: 87.283333,
    }),
  ];

  const movement = (input: {
    employeeId: string;
    productId: string;
    branchId: string;
    type: 'ISSUE' | 'RETURN' | 'CONSUME' | 'TRANSFER_OUT' | 'TRANSFER_IN';
    quantity: number;
    workOrderId?: string | null;
    reason: string;
    counterpartyEmployeeId?: string | null;
    transferGroupId?: string | null;
    createdAt: string;
  }): Row => ({
    employee_id: input.employeeId,
    product_id: input.productId,
    branch_id: input.branchId,
    movement_type: input.type,
    quantity: input.quantity,
    work_order_id: input.workOrderId ?? null,
    reason: input.reason,
    actor: SEED,
    counterparty_employee_id: input.counterpartyEmployeeId ?? null,
    transfer_group_id: input.transferGroupId ?? null,
    created_at: input.createdAt,
  });

  const transferGroup = uuid(900);

  const movements: Row[] = [
    movement({
      employeeId: 'demo-emp-002', productId: 'prd-onu-200', branchId: 'BR-KTM', type: 'ISSUE',
      quantity: 4, reason: 'Van stock for the Kathmandu install queue.', createdAt: '2026-11-10T04:00:00Z',
    }),
    movement({
      employeeId: 'demo-emp-002', productId: 'prd-onu-200', branchId: 'BR-KTM', type: 'CONSUME',
      quantity: 1, workOrderId: uuid(2), reason: 'Faulty ONU replaced on WO-DEMO-002.',
      createdAt: '2026-11-20T06:20:00Z',
    }),
    movement({
      employeeId: 'demo-emp-002', productId: 'prd-cbl-drop', branchId: 'BR-KTM', type: 'ISSUE',
      quantity: 2, reason: 'Two drop-cable rolls for the week.', createdAt: '2026-11-17T04:10:00Z',
    }),
    movement({
      employeeId: 'demo-emp-002', productId: 'prd-cbl-drop', branchId: 'BR-KTM', type: 'TRANSFER_OUT',
      quantity: 2, reason: 'Handed both rolls to the Kathmandu branch manager.',
      counterpartyEmployeeId: 'demo-emp-014', transferGroupId: transferGroup, createdAt: '2026-11-18T05:00:00Z',
    }),
    movement({
      employeeId: 'demo-emp-014', productId: 'prd-cbl-drop', branchId: 'BR-KTM', type: 'TRANSFER_IN',
      quantity: 2, reason: 'Received both rolls from the front desk.',
      counterpartyEmployeeId: 'demo-emp-002', transferGroupId: transferGroup, createdAt: '2026-11-18T05:00:00Z',
    }),
    movement({
      employeeId: 'demo-emp-005', productId: 'prd-spl-108', branchId: 'BR-DHN', type: 'ISSUE',
      quantity: 2, reason: 'Splitter stock for Dharan service calls.', createdAt: '2026-11-15T04:30:00Z',
    }),
    movement({
      employeeId: 'demo-emp-005', productId: 'prd-spl-108', branchId: 'BR-DHN', type: 'RETURN',
      quantity: 1, reason: 'Unused splitter returned to the Dharan store.', createdAt: '2026-11-21T10:00:00Z',
    }),
  ];

  // Balance per (employee, product, branch) must equal the holdings rows below;
  // `tests/demoWorkplaceFixtures.test.ts` fails if the two ever drift.
  const holdings: Row[] = [
    { employee_id: 'demo-emp-002', product_id: 'prd-onu-200', branch_id: 'BR-KTM', quantity: 3, updated_at: '2026-11-20T06:20:00Z' },
    { employee_id: 'demo-emp-014', product_id: 'prd-cbl-drop', branch_id: 'BR-KTM', quantity: 2, updated_at: '2026-11-18T05:00:00Z' },
    { employee_id: 'demo-emp-005', product_id: 'prd-spl-108', branch_id: 'BR-DHN', quantity: 1, updated_at: '2026-11-21T10:00:00Z' },
  ];

  const roster: Row[] = [
    { id: 'demo-roster-001', employee_id: 'demo-emp-002', shift_id: 'demo-shift-morning', branch_id: 'BR-KTM', shift_date_ad: '2026-11-19', shift_date_bs: bsOn('2026-11-19'), source: 'ROSTER', is_demo: true },
    { id: 'demo-roster-002', employee_id: 'demo-emp-002', shift_id: 'demo-shift-morning', branch_id: 'BR-KTM', shift_date_ad: '2026-11-20', shift_date_bs: bsOn('2026-11-20'), source: 'ROSTER', is_demo: true },
    { id: 'demo-roster-003', employee_id: 'demo-emp-005', shift_id: 'demo-shift-morning', branch_id: 'BR-DHN', shift_date_ad: '2026-11-19', shift_date_bs: bsOn('2026-11-19'), source: 'ROSTER', is_demo: true },
    { id: 'demo-roster-004', employee_id: 'demo-emp-005', shift_id: 'demo-shift-evening', branch_id: 'BR-DHN', shift_date_ad: '2026-11-21', shift_date_bs: bsOn('2026-11-21'), source: 'ROSTER', is_demo: true },
    { id: 'demo-roster-005', employee_id: 'demo-emp-003', shift_id: 'demo-shift-morning', branch_id: 'BR-PKR', shift_date_ad: '2026-11-19', shift_date_bs: bsOn('2026-11-19'), source: 'ROSTER', is_demo: true },
  ];

  const routeSession = 'demo-route-dhn-2026-11-19';
  const breadcrumb = (index: number, input: {
    type: 'CHECK_IN' | 'WAYPOINT' | 'CHECK_OUT';
    latitude: number;
    longitude: number;
    label: string;
    distance: number;
    inside: boolean;
    at: string;
  }): Row => ({
    id: `demo-breadcrumb-${String(index).padStart(3, '0')}`,
    employee_id: 'demo-emp-005',
    device_id: 'demo-device-dhn-01',
    route_session_id: routeSession,
    event_type: input.type,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: 6.5,
    site_label: input.label,
    distance_from_branch_meters: input.distance,
    is_inside_geofence: input.inside,
    captured_at_epoch_ms: Date.parse(input.at),
    captured_at: input.at,
    branch_id: 'BR-DHN',
  });

  const breadcrumbs: Row[] = [
    breadcrumb(1, { type: 'CHECK_IN', latitude: 26.812345, longitude: 87.283333, label: 'Dharan Branch', distance: 0, inside: true, at: '2026-11-19T02:30:00Z' }),
    breadcrumb(2, { type: 'WAYPOINT', latitude: 26.814512, longitude: 87.286014, label: 'Bhanu Chowk cabinet', distance: 420.5, inside: false, at: '2026-11-19T03:10:00Z' }),
    breadcrumb(3, { type: 'WAYPOINT', latitude: 26.8179, longitude: 87.2811, label: 'Customer shop', distance: 910.2, inside: false, at: '2026-11-19T03:55:00Z' }),
    breadcrumb(4, { type: 'CHECK_OUT', latitude: 26.812345, longitude: 87.283333, label: 'Dharan Branch', distance: 0, inside: true, at: '2026-11-19T08:05:00Z' }),
  ];

  const attendanceProof = (index: number, attendanceId: string, latitude: number, longitude: number): Row => ({
    attendance_id: attendanceId,
    latitude,
    longitude,
    distance_meters: 42.5,
    gps_accuracy_meters: 7,
    device_id: 'demo-device-ktm-01',
    device_time_epoch_ms: Date.parse('2026-11-06T02:45:00Z') + index * 60_000,
    server_received_at: '2026-11-06T02:45:30Z',
    inside_geofence: true,
    integrity_status: 'VERIFIED',
    risk_score: 10,
    verdict: 'ACCEPTED',
  });

  const attendanceProofs: Row[] = [
    attendanceProof(1, 'demo-attendance-EMP-001-2026-11-06', 27.717245, 85.323959),
    attendanceProof(2, 'demo-attendance-EMP-002-2026-11-06', 27.71731, 85.324011),
    attendanceProof(3, 'demo-attendance-EMP-002-2026-11-05', 27.71728, 85.32398),
  ];

  const announcements: Row[] = [
    {
      id: 'demo-announcement-001',
      title: 'Dashain delivery schedule published',
      summary: 'Field teams work the morning shift through the festival week; the branch counters close at 2 PM.',
      category: 'OPERATIONS',
      branch_id: null,
      published_at: '2026-10-01T03:00:00Z',
      is_urgent: false,
      is_demo: true,
    },
    {
      id: 'demo-announcement-002',
      title: 'NEA maintenance window — Kathmandu ring',
      summary: 'Expect upstream outages between 11 PM and 3 AM on 26 November; log every affected customer.',
      category: 'NETWORK',
      branch_id: 'BR-KTM',
      published_at: '2026-11-18T05:30:00Z',
      is_urgent: true,
      is_demo: true,
    },
    {
      id: 'demo-announcement-003',
      title: 'Custody audit for van stock',
      summary: 'Technicians: reconcile van holdings against the custody register before the month close.',
      category: 'GENERAL',
      branch_id: null,
      published_at: '2026-11-22T02:00:00Z',
      is_urgent: false,
      is_demo: true,
    },
  ];

  const geofences: Row[] = [
    { branch_id: 'BR-KTM', latitude: 27.717245, longitude: 85.323959, radius_meters: 150 },
    { branch_id: 'BR-PKR', latitude: 28.209583, longitude: 83.985567, radius_meters: 150 },
    { branch_id: 'BR-BTL', latitude: 27.700769, longitude: 83.448929, radius_meters: 120 },
    { branch_id: 'BR-DHN', latitude: 26.812345, longitude: 87.283333, radius_meters: 120 },
  ];

  return { workOrders, evidence, holdings, movements, roster, breadcrumbs, attendanceProofs, announcements, geofences };
}

export async function applyDemoWorkplaceFixtures(
  client: any,
  dataset: VerificationDataset
): Promise<Record<string, number>> {
  const fixtures = buildDemoWorkplaceFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoWorkOrders', 'field_work_orders',
    ['id', 'work_order_no', 'branch_id', 'customer_id', 'kind', 'status', 'technician_id', 'technician_name',
      'scheduled_date_ad', 'scheduled_date_bs', 'plan_name', 'notes', 'completion_notes', 'completed_at', 'created_by'],
    fixtures.workOrders);
  await put('demoWorkOrderEvidence', 'field_work_order_evidence',
    ['id', 'work_order_id', 'branch_id', 'kind', 'content_type', 'byte_size', 'sha256', 'data_base64',
      'caption', 'captured_at', 'captured_by', 'latitude', 'longitude', 'accuracy_meters'],
    fixtures.evidence);
  await put('demoCustodyMovements', 'employee_stock_movements',
    ['employee_id', 'product_id', 'branch_id', 'movement_type', 'quantity', 'work_order_id', 'reason', 'actor',
      'counterparty_employee_id', 'transfer_group_id', 'created_at'],
    fixtures.movements);
  await put('demoCustodyHoldings', 'employee_stock_holdings',
    ['employee_id', 'product_id', 'branch_id', 'quantity', 'updated_at'],
    fixtures.holdings);
  await put('demoShiftRoster', 'employee_shift_roster',
    ['id', 'employee_id', 'shift_id', 'branch_id', 'shift_date_ad', 'shift_date_bs', 'source', 'is_demo'],
    fixtures.roster);
  await put('demoLocationBreadcrumbs', 'employee_location_breadcrumbs',
    ['id', 'employee_id', 'device_id', 'route_session_id', 'event_type', 'latitude', 'longitude', 'accuracy_meters',
      'site_label', 'distance_from_branch_meters', 'is_inside_geofence', 'captured_at_epoch_ms', 'captured_at', 'branch_id'],
    fixtures.breadcrumbs);
  await put('demoAttendanceProofs', 'hr_attendance_proofs',
    ['attendance_id', 'latitude', 'longitude', 'distance_meters', 'gps_accuracy_meters', 'device_id',
      'device_time_epoch_ms', 'server_received_at', 'inside_geofence', 'integrity_status', 'risk_score', 'verdict'],
    fixtures.attendanceProofs);
  await put('demoAnnouncements', 'company_announcements',
    ['id', 'title', 'summary', 'category', 'branch_id', 'published_at', 'is_urgent', 'is_demo'],
    fixtures.announcements);
  await put('demoBranchGeofences', 'branch_geofences',
    ['branch_id', 'latitude', 'longitude', 'radius_meters'],
    fixtures.geofences);

  return summary;
}
