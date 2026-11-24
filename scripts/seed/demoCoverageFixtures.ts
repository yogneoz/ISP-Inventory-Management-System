/**
 * Coverage fixtures: the operational histories a handful of registers still had
 * nothing to show after the module fixtures were applied.
 *
 * Everything here follows the demo dataset's rule: rows are records, never
 * postings. No journal is written and `inventory_stock` is not touched, so the
 * verified figures (AR 10,000, inventory 20,000, five units per product per
 * branch, a balanced branch ledger) stay exactly where `verifySeededDatabase`
 * expects them.
 *
 * Three gaps this closes, each observed on the running app against the seed:
 *
 *  1. `stock_operations` had no `STOCK_OUT` rows even though the dataset sells
 *     two of every seven purchased units. The Company Overview's trading card
 *     and the trading reports read revenue/COGS from those rows, so they
 *     reported "No sales recorded" while the P&L showed the posted 6010/7000
 *     balances. The sale rows below mirror those balances line for line
 *     (14,400 revenue / 8,000 COGS) so the two screens agree.
 *  2. The consumables register opens on the first branch it is allowed to
 *     see; the only seeded issue was in Pokhara, so Butwal opened empty.
 *  3. No fixed asset was ever deployed and no employee had ever left, so the
 *     Asset Deployments, Assign Fixed Asset and the HR attrition report had no
 *     rows at all.
 */
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

/** The dataset's own unit economics (verificationDataset: UNIT_COST/SELL_PRICE). */
const UNIT_COST = 50;
const SELL_PRICE = 90;
/** Two of the seven purchased units per product per branch are sold. */
const SOLD_PER_PRODUCT = 2;
/** The verified ledger's sales books exactly this many product lines per branch. */
const SOLD_PRODUCTS_PER_BRANCH = 20;

export interface DemoAssetDeployment {
  assetId: string;
  assignedType: 'LOCATION' | 'CUSTOMER';
  assignedLocationId: string | null;
  assignedLocationName: string | null;
  assignedCustomerId: string | null;
  assignedCustomerName: string | null;
  assignmentDateAD: string;
  note: string;
  branchId: string;
  productId: string | null;
  tagNumber: string;
  assetName: string;
}

export interface DemoCoverageFixtures {
  salesOperations: Row[];
  consumableIssues: Row[];
  assetIssues: Row[];
  deployments: DemoAssetDeployment[];
  mobileAttendance: Row[];
  mobileLeaveBalances: Row[];
  mobileWorkOrder: Row;
  mobileClaim: Row;
  mobileLeaveRequest: Row;
}

/**
 * Two demo employees who have no payroll line (so payroll stays untouched) are
 * marked as leavers; the attrition report reads `separation_date_ad`.
 */
export const DEMO_SEPARATION_SQL = `WITH leavers AS (
  SELECT e.id
    FROM employees e
   WHERE e.is_demo = TRUE
     AND e.is_active = TRUE
     AND e.separation_date_ad IS NULL
     AND NOT EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.employee_id = e.id)
   ORDER BY e.employee_code DESC
   LIMIT 2
)
UPDATE employees e
   SET separation_date_ad = $1::date,
       is_active = FALSE
  FROM leavers
 WHERE e.id = leavers.id
RETURNING e.id`;

/**
 * The Expo client signs in as a person, so an account without an employee row
 * cannot use it at all: the login answers 404 "No employee record is linked to
 * this account". Three demo logins (`ktm.manager`, `accountant`, `inventory`)
 * were in that state while their employees sat unlinked, so the phone was
 * usable only by the four accounts that happened to be joined.
 *
 * The mapping is to a real, unlinked employee of the same branch and job — no
 * employee is invented, so the payroll run and the HR headcount do not move.
 */
/** The three links as data, so the pure fixture checks can resolve an account. */
export const DEMO_MOBILE_ACCOUNT_LINKS = [
  { employeeId: 'demo-emp-014', userId: 'usr-ktm-manager' },
  { employeeId: 'demo-emp-011', userId: 'usr-accountant' },
  { employeeId: 'demo-emp-007', userId: 'usr-inventory' },
] as const;

export const DEMO_MOBILE_ACCOUNT_LINK_SQL = `UPDATE employees e
   SET user_id = m.user_id
  FROM (VALUES ${DEMO_MOBILE_ACCOUNT_LINKS.map((link) => `('${link.employeeId}', '${link.userId}')`).join(',\n               ')}) AS m(id, user_id)
 WHERE e.id = m.id
   AND e.user_id IS NULL
RETURNING e.id`;

/**
 * The five working days every mobile demo persona has an attendance row for.
 * The attendance screen reads a 90-day window, so this is the recent history a
 * technician opens it for — the earlier fixtures only covered the two payroll
 * employees.
 */
const MOBILE_ATTENDANCE_DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

/** The field personas the phone app is signed in as, and their branch. */
const MOBILE_PERSONAS = [
  { employeeId: 'demo-emp-003', branchId: 'BR-PKR' },
  { employeeId: 'demo-emp-004', branchId: 'BR-BTL' },
  { employeeId: 'demo-emp-005', branchId: 'BR-DHN' },
  { employeeId: 'demo-emp-007', branchId: 'BR-KTM' },
  { employeeId: 'demo-emp-011', branchId: 'BR-KTM' },
  { employeeId: 'demo-emp-014', branchId: 'BR-KTM' },
  // The auditor persona signs in on the same client; without a seeded week its
  // Attendance and Leave tabs would open on their empty branch.
  { employeeId: 'demo-emp-020', branchId: 'BR-KTM' },
] as const;

/**
 * The two office personas (`inventory`, `accountant`) reached the phone with a
 * linked employee but no leave entitlement, so their Leave tab had no leave
 * type to choose. The entitles match the field personas exactly.
 */
const MOBILE_BALANCE_PERSONAS = [
  { employeeId: 'demo-emp-007', branchId: 'BR-KTM' },
  { employeeId: 'demo-emp-011', branchId: 'BR-KTM' },
  // The Kathmandu manager files the pending request below, so he needs the
  // leave types the request form offers.
  { employeeId: 'demo-emp-014', branchId: 'BR-KTM' },
  { employeeId: 'demo-emp-020', branchId: 'BR-KTM' },
] as const;

const MOBILE_LEAVE_TYPES = [
  { id: 'demo-leave-annual', code: 'ANNUAL', entitlement: 12 },
  { id: 'demo-leave-casual', code: 'CASUAL', entitlement: 6 },
  { id: 'demo-leave-sick', code: 'SICK', entitlement: 10 },
] as const;

export function buildDemoCoverageFixtures(dataset: VerificationDataset): DemoCoverageFixtures {
  const branchById = new Map(dataset.branches.map((branch: any) => [branch.id, branch]));
  const soldProducts = dataset.products.slice(0, SOLD_PRODUCTS_PER_BRANCH);

  const saleItem = (product: any) => ({
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    quantity: SOLD_PER_PRODUCT,
    unitCost: Number(product.costPrice) || UNIT_COST,
    totalValue: SOLD_PER_PRODUCT * (Number(product.sellingPrice) || SELL_PRICE),
  });

  const salesDates: Record<string, string> = {
    'BR-KTM': '2026-09-12',
    'BR-PKR': '2026-09-18',
    'BR-BTL': '2026-10-05',
    'BR-DHN': '2026-10-08',
  };

  const salesOperations: Row[] = dataset.branches.map((branch: any, index: number) => {
    const date = salesDates[branch.id] ?? '2026-09-12';
    const items = soldProducts.map(saleItem);
    const revenue = items.reduce((sum, item) => sum + item.totalValue, 0);
    return {
      id: `demo-stockop-sale-${branch.code.toLowerCase()}`,
      reference_number: `SO-DEMO-SALE-${String(index + 1).padStart(3, '0')}`,
      type: 'STOCK_OUT',
      technician_name: 'Counter Sale',
      work_order_ref: null,
      branch_id: branch.id,
      branch_name: branch.name,
      destination_warehouse_id: null,
      destination_warehouse_name: null,
      product_id: null,
      quantity_changed: -(items.length * SOLD_PER_PRODUCT),
      cost_per_unit: UNIT_COST,
      total_value: revenue,
      reason: `Counter sales posted for ${branch.name}: ${items.length} product line(s).`,
      date_ad: date,
      date_bs: bsOn(date),
      fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083',
      status: 'LOGGED',
      items: JSON.stringify(items),
      is_demo: true,
      created_by: SEED,
    };
  });

  const consumable = dataset.products.find((product: any) => /con-fast/i.test(product.id)) ?? dataset.products[0];
  const consumableLine = (quantity: number) => [{
    productId: consumable?.id,
    productName: consumable?.name,
    quantity,
    unitCost: Number(consumable?.costPrice) || UNIT_COST,
    totalValue: quantity * (Number(consumable?.costPrice) || UNIT_COST),
  }];
  const issuePlan: Array<{ branchId: string; date: string; quantity: number; technician: string; workOrder: string }> = [
    { branchId: 'BR-BTL', date: '2026-10-16', quantity: 2, technician: 'Sita Gurung', workOrder: 'WO-2083-011' },
    { branchId: 'BR-KTM', date: '2026-10-19', quantity: 4, technician: 'Aarav Sharma', workOrder: 'WO-2083-012' },
    { branchId: 'BR-DHN', date: '2026-10-24', quantity: 3, technician: 'Rajan Rai', workOrder: 'WO-2083-013' },
  ];
  const consumableIssues: Row[] = issuePlan.map((plan, index) => {
    const branch = branchById.get(plan.branchId) as any;
    const items = consumableLine(plan.quantity);
    return {
      id: `demo-stockop-consumable-${index + 2}`,
      reference_number: `SO-DEMO-CONSUMABLE-${String(index + 2).padStart(3, '0')}`,
      type: 'CONSUMABLE_ISSUE',
      technician_name: plan.technician,
      work_order_ref: plan.workOrder,
      branch_id: plan.branchId,
      branch_name: branch?.name ?? plan.branchId,
      destination_warehouse_id: null,
      destination_warehouse_name: null,
      product_id: consumable?.id ?? null,
      quantity_changed: -plan.quantity,
      cost_per_unit: Number(consumable?.costPrice) || UNIT_COST,
      total_value: items[0].totalValue,
      reason: 'Fast connectors issued to the field installation team.',
      date_ad: plan.date,
      date_bs: bsOn(plan.date),
      fiscal_year: '2083-84',
      fiscal_year_id: 'fy-2083',
      status: 'LOGGED',
      items: JSON.stringify(items),
      is_demo: true,
      created_by: SEED,
    };
  });

  // Deployments are the two shapes the register filters on: a POP/network site
  // and a customer site. Assets come from the verified fixed-asset register, so
  // the deployment board and the depreciation schedule describe the same units.
  //
  // One asset per branch, leaving the branch's other unit available: the Assign
  // Fixed Asset bin lists unassigned assets *of the branch being assigned*, so
  // deploying every unit of a branch would leave that branch's form empty.
  // Kathmandu and Butwal go to their POP room, Pokhara and Dharan rent to a
  // customer, so both register filters have rows in more than one branch.
  const deployments: DemoAssetDeployment[] = dataset.branches
    .map((branch: any) => {
      const asset = dataset.fixedAssets.find((row: any) => row.branchId === branch.id);
      if (!asset) return null;
      const isLocation = branch.id === 'BR-KTM' || branch.id === 'BR-BTL';
      const date = isLocation ? '2026-09-25' : '2026-10-02';
      const location = dataset.locations.find((row: any) => row.branchId === branch.id) ?? null;
      const customer = dataset.customers.find((row: any) => row.branchId === branch.id) ?? null;
      return {
        assetId: asset.id,
        assignedType: isLocation ? 'LOCATION' : 'CUSTOMER',
        assignedLocationId: isLocation ? location?.id ?? null : null,
        assignedLocationName: isLocation ? location?.name ?? null : null,
        assignedCustomerId: isLocation ? null : customer?.id ?? null,
        assignedCustomerName: isLocation ? null : customer?.customerName ?? null,
        assignmentDateAD: date,
        note: isLocation
          ? 'Installed at the pop / network site for subscriber backhaul.'
          : 'Rented CPE handed to the customer at install.',
        branchId: asset.branchId,
        productId: asset.productId ?? null,
        tagNumber: asset.tagNumber,
        assetName: asset.name,
      } as DemoAssetDeployment;
    })
    .filter(Boolean) as DemoAssetDeployment[];

  // The assign flow reads the asset's STOCK_OUT row when it is reversed, so the
  // deployment ships with the issue record. `items` stays empty: an asset issue
  // carries no priced sale lines and the trading totals skip it.
  const assetIssues: Row[] = deployments.map((deployment, index) => ({
    id: `demo-stockop-asset-${index + 1}`,
    reference_number: `SO-DEMO-ASSET-${String(index + 1).padStart(3, '0')}`,
    type: 'STOCK_OUT',
    technician_name: 'Fixed Asset Custodian',
    work_order_ref: null,
    branch_id: deployment.branchId,
    branch_name: branchById.get(deployment.branchId)?.name ?? deployment.branchId,
    destination_warehouse_id: null,
    destination_warehouse_name: null,
    product_id: deployment.productId,
    quantity_changed: -1,
    cost_per_unit: 0,
    total_value: 0,
    reason: `Fixed asset ${deployment.tagNumber} issued to ${deployment.assignedLocationName ?? deployment.assignedCustomerName}.`,
    date_ad: deployment.assignmentDateAD,
    date_bs: bsOn(deployment.assignmentDateAD),
    fiscal_year: '2083-84',
    fiscal_year_id: 'fy-2083',
    status: 'LOGGED',
    items: JSON.stringify([]),
    is_demo: true,
    created_by: SEED,
  }));

  // --- the phone app's own rows ----------------------------------------------
  //
  // The Expo/Kotlin clients read a person's day: their attendance, their job,
  // the claim their supervisor owes them a decision on and the leave they are
  // waiting for. Only the two payroll employees had attendance, no account was
  // linked to an employee, and the one submitted claim belonged to the person
  // reading the approvals screen (the API refuses self-approval), so every
  // mobile surface past the job list opened empty.
  const mobileAttendance: Row[] = MOBILE_PERSONAS.flatMap((persona) =>
    MOBILE_ATTENDANCE_DAYS.map((date, index) => ({
      id: `demo-attendance-${persona.employeeId.replace('demo-emp-', 'EMP-')}-${date}`,
      employee_id: persona.employeeId,
      branch_id: persona.branchId,
      attendance_date_ad: date,
      attendance_date_bs: bsOn(date),
      shift_id: 'demo-shift-morning',
      status: 'PRESENT',
      check_in_time: index === 2 ? '09:18' : '09:02',
      check_out_time: '17:10',
      overtime_hours: 0,
      notes: 'Demo attendance record.',
      source: 'MANUAL',
      is_demo: true,
      recorded_by: SEED,
      updated_by: SEED,
    }))
  );

  const mobileLeaveBalances: Row[] = MOBILE_BALANCE_PERSONAS.flatMap((persona) =>
    MOBILE_LEAVE_TYPES.map((type) => ({
      id: `demo-leave-balance-${persona.employeeId.replace('demo-emp-', 'EMP-')}-${type.code}`,
      employee_id: persona.employeeId,
      branch_id: persona.branchId,
      leave_type_id: type.id,
      balance_year: 2026,
      entitlement_days: type.entitlement,
      adjustment_days: 0,
      notes: 'Canonical demo leave entitlement.',
      is_demo: true,
      created_by: SEED,
    }))
  );

  // An install still open on the Kathmandu manager's phone: the job list, the
  // "complete this visit" action and the proof-of-work gallery all need a visit
  // that belongs to the account signing in.
  const ktmCustomer = dataset.customers.find((customer: any) => customer.branchId === 'BR-KTM');
  const mobileWorkOrder: Row = {
    id: 'aaaaaaaa-0000-4000-8000-000000000007',
    work_order_no: 'WO-DEMO-007',
    branch_id: 'BR-KTM',
    customer_id: ktmCustomer?.id ?? null,
    kind: 'INSTALL',
    status: 'ASSIGNED',
    technician_id: 'demo-emp-014',
    technician_name: 'Rohit Karki',
    scheduled_date_ad: '2026-11-25',
    scheduled_date_bs: bsOn('2026-11-25'),
    plan_name: 'Home Fibre 300 Mbps',
    notes: 'Corporate apartment install; the building has the duct plan at reception.',
    completion_notes: null,
    completed_at: null,
    created_by: SEED,
  };

  // Somebody else's claim, so the supervisor's queue is not empty and the
  // self-approval refusal is what the caller would hit, not a missing row.
  const mobileClaim: Row = {
    id: 'demo-expense-004',
    employee_id: 'demo-emp-014',
    branch_id: 'BR-KTM',
    category: 'MATERIALS',
    amount: 2200,
    currency: 'NPR',
    ticket_code: null,
    description: 'Drop cable and connectors bought for the WO-DEMO-007 install.',
    receipt_attached: true,
    status: 'SUBMITTED',
    submitted_at: '2026-11-22T06:15:00Z',
    is_demo: true,
  };

  const mobileLeaveRequest: Row = {
    id: 'demo-leave-request-4',
    request_no: 'LR-2083-DEMO-004',
    employee_id: 'demo-emp-014',
    branch_id: 'BR-KTM',
    leave_type_id: 'demo-leave-annual',
    start_date_ad: '2026-12-01',
    end_date_ad: '2026-12-02',
    start_date_bs: bsOn('2026-12-01'),
    end_date_bs: bsOn('2026-12-02'),
    days_count: 2,
    reason: 'Family function in Pokhara.',
    status: 'PENDING',
    is_demo: true,
    created_by: SEED,
  };

  return {
    salesOperations,
    consumableIssues,
    assetIssues,
    deployments,
    mobileAttendance,
    mobileLeaveBalances,
    mobileWorkOrder,
    mobileClaim,
    mobileLeaveRequest,
  };
}

export async function applyDemoCoverageFixtures(client: any, dataset: VerificationDataset): Promise<Record<string, number>> {
  const fixtures = buildDemoCoverageFixtures(dataset);
  const summary: Record<string, number> = {};

  await insertRows(client, 'stock_operations', [
    'id', 'reference_number', 'type', 'technician_name', 'work_order_ref', 'branch_id', 'branch_name',
    'destination_warehouse_id', 'destination_warehouse_name', 'product_id', 'quantity_changed',
    'cost_per_unit', 'total_value', 'reason', 'date_ad', 'date_bs', 'fiscal_year', 'fiscal_year_id',
    'status', 'items', 'is_demo', 'created_by',
  ], [...fixtures.salesOperations, ...fixtures.consumableIssues, ...fixtures.assetIssues]);
  summary.demoCoverageStockOperations = fixtures.salesOperations.length + fixtures.consumableIssues.length + fixtures.assetIssues.length;

  for (const deployment of fixtures.deployments) {
    await client.query(
      `UPDATE fixed_assets
          SET assigned_type = $2,
              assigned_location_id = $3,
              assigned_location_name = $4,
              assigned_customer_id = $5,
              assigned_customer_name = $6,
              assignment_date_ad = $7,
              assignment_date_bs = $8,
              assignment_notes = $9
        WHERE id = $1
          AND assigned_type IS NULL`,
      [
        deployment.assetId,
        deployment.assignedType,
        deployment.assignedLocationId,
        deployment.assignedLocationName,
        deployment.assignedCustomerId,
        deployment.assignedCustomerName,
        deployment.assignmentDateAD,
        bsOn(deployment.assignmentDateAD),
        deployment.note,
      ]
    );
  }
  summary.demoCoverageDeployments = fixtures.deployments.length;

  const leavers = await client.query(DEMO_SEPARATION_SQL, ['2026-10-31']);
  summary.demoCoverageSeparations = leavers.rows.length;

  const linked = await client.query(DEMO_MOBILE_ACCOUNT_LINK_SQL);
  summary.demoCoverageMobileAccounts = linked.rows.length;

  await insertRows(client, 'hr_attendance', [
    'id', 'employee_id', 'branch_id', 'attendance_date_ad', 'attendance_date_bs', 'shift_id', 'status',
    'check_in_time', 'check_out_time', 'overtime_hours', 'notes', 'source', 'is_demo', 'recorded_by', 'updated_by',
  ], fixtures.mobileAttendance);
  summary.demoCoverageMobileAttendance = fixtures.mobileAttendance.length;

  await insertRows(client, 'hr_leave_balances', [
    'id', 'employee_id', 'branch_id', 'leave_type_id', 'balance_year', 'entitlement_days', 'adjustment_days',
    'notes', 'is_demo', 'created_by',
  ], fixtures.mobileLeaveBalances);
  summary.demoCoverageMobileLeaveBalances = fixtures.mobileLeaveBalances.length;

  await insertRows(client, 'field_work_orders', [
    'id', 'work_order_no', 'branch_id', 'customer_id', 'kind', 'status', 'technician_id', 'technician_name',
    'scheduled_date_ad', 'scheduled_date_bs', 'plan_name', 'notes', 'completion_notes', 'completed_at', 'created_by',
  ], [fixtures.mobileWorkOrder]);
  summary.demoCoverageMobileWorkOrder = 1;

  await insertRows(client, 'hr_expense_claims', [
    'id', 'employee_id', 'branch_id', 'category', 'amount', 'currency', 'ticket_code', 'description',
    'receipt_attached', 'status', 'submitted_at', 'is_demo',
  ], [fixtures.mobileClaim]);
  summary.demoCoverageMobileClaim = 1;

  await insertRows(client, 'hr_leave_requests', [
    'id', 'request_no', 'employee_id', 'branch_id', 'leave_type_id', 'start_date_ad', 'end_date_ad',
    'start_date_bs', 'end_date_bs', 'days_count', 'reason', 'status', 'is_demo', 'created_by',
  ], [fixtures.mobileLeaveRequest]);
  summary.demoCoverageMobileLeave = 1;

  return summary;
}
