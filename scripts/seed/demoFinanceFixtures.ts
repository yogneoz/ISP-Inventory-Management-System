/**
 * Canonical demo finance fixtures.
 *
 * These rows sit around the verification ledger rather than changing it:
 * budgets are planning data, opening registers are prior-year/zero balances,
 * narrations are templates, cash closes are operational records, and approvals
 * and audit rows describe the demo workflow. The one payroll journal lives in
 * the HR fixture file and is balanced without touching AR/AP/cash/equity.
 */
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

const BUDGET_ACCOUNTS = [
  { code: '4000', id: 'gla-4000', name: 'Sales Revenue', accountType: 'INCOME' as const, amount: 250_000 },
  { code: '6100', id: 'gla-6100', name: 'General Operating Expense', accountType: 'EXPENSE' as const, amount: 30_000 },
  { code: '6400', id: 'gla-6400', name: 'Salaries & Wages', accountType: 'EXPENSE' as const, amount: 50_000 },
];

/**
 * Demo-only branch defaults. The splits intentionally differ so the screen
 * demonstrates that cost-centre allocation is branch-scoped. Basis points keep
 * every profile exactly 10,000 (100.00%).
 */
const ALLOCATION_SPLITS: Record<string, Array<[string, number]>> = {
  KTM: [
    ['CC-01-EXEC', 1000],
    ['CC-02-FIN', 2000],
    ['CC-03-OPS', 4000],
    ['CC-04-COMM', 1500],
    ['CC-05-CX', 1500],
  ],
  PKR: [
    ['CC-01-EXEC', 1000],
    ['CC-02-FIN', 1500],
    ['CC-03-OPS', 4500],
    ['CC-04-COMM', 1500],
    ['CC-05-CX', 1500],
  ],
  BTL: [
    ['CC-01-EXEC', 500],
    ['CC-02-FIN', 1500],
    ['CC-03-OPS', 5000],
    ['CC-04-COMM', 1500],
    ['CC-05-CX', 1500],
  ],
  DHN: [
    ['CC-01-EXEC', 500],
    ['CC-02-FIN', 1500],
    ['CC-03-OPS', 5500],
    ['CC-04-COMM', 1000],
    ['CC-05-CX', 1500],
  ],
};

export interface DemoFinanceFixtures {
  budgets: Row[];
  budgetLines: Row[];
  budgetVersions: Row[];
  allocationProfiles: Row[];
  allocationLines: Row[];
  openingStock: Row[];
  vendorOpenings: Row[];
  narrations: Row[];
  cashCloses: Row[];
  approvals: Row[];
  auditLogs: Row[];
}

export function buildDemoFinanceFixtures(dataset: VerificationDataset): DemoFinanceFixtures {
  const periods = dataset.periods
    .filter((period: any) => period.fiscalYearId === 'fy-2083' && period.periodKey < '2027-07')
    .map((period: any) => period.periodKey as string);

  const budgets: Row[] = [];
  const budgetLines: Row[] = [];
  const budgetVersions: Row[] = [];
  const allocationProfiles: Row[] = [];
  const allocationLines: Row[] = [];

  for (const branch of dataset.branches) {
    const budgetId = `demo-budget-${branch.code.toLowerCase()}-2083`;
    budgets.push({
      id: budgetId,
      fiscal_year_id: 'fy-2083',
      branch_id: branch.id,
      created_by: SEED,
      updated_by: SEED,
    });

    const lines: Row[] = [];
    for (const periodKey of periods) {
      for (const account of BUDGET_ACCOUNTS) {
        lines.push({
          id: `demo-budget-line-${branch.code}-${periodKey}-${account.code}`,
          budget_id: budgetId,
          period_key: periodKey,
          account_id: account.id,
          amount: account.amount,
        });
      }
    }
    budgetLines.push(...lines);
    const profileId = `demo-allocation-${branch.code.toLowerCase()}-2083`;
    const split = ALLOCATION_SPLITS[branch.code];
    if (!split || split.reduce((sum, [, percentageBp]) => sum + percentageBp, 0) !== 10_000) {
      throw new Error(`Demo allocation for ${branch.code} must total exactly 100.00%`);
    }
    allocationProfiles.push({
      id: profileId,
      fiscal_year_id: 'fy-2083',
      branch_id: branch.id,
      created_by: SEED,
      updated_by: SEED,
    });
    for (const [costCenterCode, percentageBp] of split) {
      const centre = dataset.costCenters.find((candidate: any) => candidate.code === costCenterCode);
      if (!centre) throw new Error(`Demo cost centre ${costCenterCode} is missing`);
      allocationLines.push({
        id: `demo-allocation-line-${branch.code}-${costCenterCode}`,
        profile_id: profileId,
        account_group: 'DEFAULT',
        cost_center_id: centre.id,
        percentage_bp: percentageBp,
      });
    }
    budgetVersions.push({
      id: `demo-budget-version-${branch.code.toLowerCase()}-2083-1`,
      budget_id: budgetId,
      version_no: 1,
      actor: SEED,
      source: 'SAVE',
      source_detail: 'Canonical demo budget',
      created_at: '2026-11-02T10:10:00Z',
      lines: JSON.stringify(
        lines.map((line) => ({
          periodKey: line.period_key,
          accountId: line.account_id,
          amount: line.amount,
          code: BUDGET_ACCOUNTS.find((account) => account.id === line.account_id)!.code,
          name: BUDGET_ACCOUNTS.find((account) => account.id === line.account_id)!.name,
          accountType: BUDGET_ACCOUNTS.find((account) => account.id === line.account_id)!.accountType,
        }))
      ),
    });
  }

  const openingStock: Row[] = [];
  const stockedProducts = dataset.products.filter((product: any) => product.productGroup !== 'Service Item');
  for (const branch of dataset.branches) {
    for (const product of stockedProducts) {
      openingStock.push({
        id: `demo-opening-${branch.code}-${product.id}`,
        fiscal_year_id: 'fy-2083',
        product_id: product.id,
        branch_id: branch.id,
        quantity_on_hand: 5,
        damaged_qty: 0,
        unit_cost: product.costPrice ?? 50,
        source_type: 'FISCAL_CLOSE',
        source_reference: '2082-83 closing stock',
        posted_by: SEED,
        is_demo: true,
        created_by: SEED,
      });
    }
  }

  const vendorOpenings: Row[] = dataset.branches
    .map((branch: any) => {
      const supplier = dataset.suppliers.find((candidate: any) => candidate.branchId === branch.id);
      if (!supplier) return null;
      return {
        id: `demo-vendor-opening-${branch.code}`,
        fiscal_year_id: 'fy-2083',
        supplier_id: supplier.id,
        branch_id: branch.id,
        // Zero is deliberate: the verified AP target is driven by the ledger,
        // and this register demonstrates an already-reconciled opening.
        opening_balance: 0,
        source_type: 'FISCAL_CLOSE',
        source_reference: '2082-83 closing balance',
        posted_by: SEED,
        is_demo: true,
        created_by: SEED,
      };
    })
    .filter(Boolean) as Row[];

  const narrations: Row[] = [
    { id: 'demo-narration-sale', code: 'SALE', text: 'Sales invoice {invoice} for {customer}', transaction_type: 'SALE', active: true, is_demo: true },
    { id: 'demo-narration-purchase', code: 'PURCHASE', text: 'Purchase invoice {invoice} from {supplier}', transaction_type: 'PURCHASE', active: true, is_demo: true },
    { id: 'demo-narration-payroll', code: 'PAYROLL', text: 'Payroll posting for {period}', transaction_type: 'PAYROLL', active: true, is_demo: true },
    { id: 'demo-narration-cash', code: 'CASH_CLOSE', text: 'Daily cash close for {branch} on {date}', transaction_type: 'CASH', active: true, is_demo: true },
    { id: 'demo-narration-transfer', code: 'TRANSFER', text: 'Stock transfer {tracking} from {source} to {destination}', transaction_type: 'TRANSFER', active: true, is_demo: true },
  ];

  const cashCloses: Row[] = dataset.branches.map((branch: any) => ({
    id: `demo-cash-close-${branch.code}-20261109`,
    branch_id: branch.id,
    business_date_ad: '2026-11-09',
    business_date_bs: bsOn('2026-11-09'),
    opening_cash: 10_000,
    cash_in: 2_500,
    cash_out: 1_000,
    expected_closing: 11_500,
    counted_closing: 11_500,
    variance: 0,
    status: 'CLOSED',
    closed_by: 'superadmin@example.com',
    closed_at: '2026-11-09T12:00:00Z',
    is_demo: true,
  }));

  const ktmSerial = dataset.serialLogs.find(
    (serial: any) => serial.branchId === 'BR-KTM' && serial.status === 'SOLD' && serial.customerId
  );
  const pkrInvoice = dataset.salesInvoices.find((invoice: any) => invoice.branchId === 'BR-PKR');

  const approvals: Row[] = [
    {
      id: 'demo-approval-device-1', request_number: 'APR-2083-0001', type: 'CUSTOMER_DEVICE_STATUS',
      target_id: 'demo-cdr-1', customer_name: ktmSerial?.customerName ?? 'Kathmandu Customer 01',
      customer_code: ktmSerial?.customerId ?? 'CUS-KTM-01', device_serial: ktmSerial?.deviceSerial ?? 'SN-DEMO-01',
      pon_serial: ktmSerial?.ponSerial ?? 'PON-DEMO-01', product_name: ktmSerial?.productName ?? 'ONU Router',
      current_status: 'ACTIVE', requested_status: 'SUSPENDED', requested_by_role: 'FRONT_DESK',
      requested_by_email: 'frontdesk@example.com', requested_by_name: 'Front Desk',
      branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
      reason: 'Customer requested a temporary service suspension.', status: 'PENDING',
      requested_at_ad: '2026-11-08T10:00:00Z', requested_at_bs: bsOn('2026-11-08'),
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-approval-transfer-1', request_number: 'APR-2083-0002', type: 'CANCEL_TRANSFER',
      target_id: 'demo-shipment-1', customer_name: null, customer_code: null,
      device_serial: null, pon_serial: null, product_name: null,
      current_status: 'IN_TRANSIT', requested_status: 'CANCELLED', requested_by_role: 'BRANCH_MANAGER',
      requested_by_email: 'pkr.manager@example.com', requested_by_name: 'Pokhara Branch Manager',
      branch_id: 'BR-PKR', branch_name: 'Pokhara Branch',
      reason: 'Destination asked to hold the branch replenishment until next week.', status: 'PENDING',
      requested_at_ad: '2026-11-09T09:15:00Z', requested_at_bs: bsOn('2026-11-09'),
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-approval-audit-1', request_number: 'APR-2083-0003', type: 'STOCK_AUDIT_RECONCILIATION',
      target_id: 'demo-stock-audit-1', customer_name: null, customer_code: null,
      device_serial: null, pon_serial: null, product_name: null,
      current_status: 'OPEN', requested_status: 'APPROVED', requested_by_role: 'INVENTORY_MANAGER',
      requested_by_email: 'inventory@example.com', requested_by_name: 'Inventory Manager',
      branch_id: 'BR-KTM', branch_name: 'Kathmandu (Head Office)',
      reason: 'Reconcile the cycle count variance recorded by the branch team.', status: 'APPROVED',
      requested_at_ad: '2026-11-04T11:00:00Z', requested_at_bs: bsOn('2026-11-04'),
      processed_by_email: 'superadmin@example.com', processed_by_name: 'Super Admin',
      processed_by_role: 'SUPER_ADMIN', processed_at_ad: '2026-11-05T08:30:00Z',
      processed_at_bs: bsOn('2026-11-05'), rejection_reason: null,
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-approval-adjust-1', request_number: 'APR-2083-0004', type: 'BULK_STOCK_ADJUSTMENT',
      target_id: 'demo-stock-adjust-1', customer_name: null, customer_code: null,
      device_serial: null, pon_serial: null, product_name: null,
      current_status: 'DRAFT', requested_status: 'APPROVED', requested_by_role: 'BRANCH_MANAGER',
      requested_by_email: 'btl.manager@example.com', requested_by_name: 'Butwal Branch Manager',
      branch_id: 'BR-BTL', branch_name: 'Butwal Branch',
      reason: 'Write off damaged drop cable identified during the stock audit.', status: 'REJECTED',
      requested_at_ad: '2026-11-03T13:20:00Z', requested_at_bs: bsOn('2026-11-03'),
      processed_by_email: 'superadmin@example.com', processed_by_name: 'Super Admin',
      processed_by_role: 'SUPER_ADMIN', processed_at_ad: '2026-11-04T07:45:00Z',
      processed_at_bs: bsOn('2026-11-04'),
      rejection_reason: 'Attach the damage photographs and resubmit as a line-level adjustment.',
      fiscal_year_id: 'fy-2083', is_demo: true, created_by: SEED,
    },
  ];

  const auditLogs: Row[] = [
    { id: 'demo-audit-001', user_email: 'superadmin@example.com', user_name: 'Super Admin', action: 'POST_JOURNAL', module: 'ACCOUNTING', details: 'Posted manual journal for monthly rent accrual.', timestamp_ad: '2026-11-01T09:00:00Z', timestamp_bs: bsOn('2026-11-01'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-002', user_email: 'accountant@example.com', user_name: 'Head Office Accountant', action: 'SAVE_GL_BUDGET', module: 'ACCOUNTING', details: 'Saved the four-branch demo budget grid for FY 2083-84.', timestamp_ad: '2026-11-02T10:10:00Z', timestamp_bs: bsOn('2026-11-02'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-003', user_email: 'inventory@example.com', user_name: 'Inventory Manager', action: 'CREATE_PURCHASE_ORDER', module: 'PROCUREMENT', details: 'Created purchase order PO-2083-DEMO-001.', timestamp_ad: '2026-11-03T08:40:00Z', timestamp_bs: bsOn('2026-11-03'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-004', user_email: 'frontdesk@example.com', user_name: 'Front Desk', action: 'CREATE_SALES_INVOICE', module: 'SALES', details: 'Issued a service invoice to a demo customer.', timestamp_ad: '2026-11-04T12:05:00Z', timestamp_bs: bsOn('2026-11-04'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-005', user_email: 'inventory@example.com', user_name: 'Inventory Manager', action: 'LOG_STOCK_OPERATION', module: 'STOCK_OPERATIONS', details: 'Logged a pullout for a customer installation.', timestamp_ad: '2026-11-05T14:15:00Z', timestamp_bs: bsOn('2026-11-05'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-006', user_email: 'superadmin@example.com', user_name: 'Super Admin', action: 'APPROVE_DEVICE_STATUS', module: 'CPE_MANAGEMENT', details: 'Approved a customer device status change.', timestamp_ad: '2026-11-06T09:30:00Z', timestamp_bs: bsOn('2026-11-06'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-007', user_email: 'superadmin@example.com', user_name: 'Super Admin', action: 'CREATE_EMPLOYEE', module: 'MASTER_DATA', details: 'Added a demo employee to the HR directory.', timestamp_ad: '2026-11-07T11:25:00Z', timestamp_bs: bsOn('2026-11-07'), branch_id: 'BR-PKR', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-008', user_email: 'superadmin@example.com', user_name: 'Super Admin', action: 'POST_PAYROLL_RUN', module: 'SYSTEM', details: 'Posted the November demo payroll run for Kathmandu.', timestamp_ad: '2026-11-08T16:00:00Z', timestamp_bs: bsOn('2026-11-08'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-009', user_email: 'auditor@example.com', user_name: 'Internal Auditor', action: 'EXPORT_AUDIT_REPORT', module: 'ACCOUNTING', details: 'Exported the demo audit trail for review.', timestamp_ad: '2026-11-09T10:45:00Z', timestamp_bs: bsOn('2026-11-09'), branch_id: 'BR-KTM', fiscal_year_id: 'fy-2083', is_demo: true },
    { id: 'demo-audit-010', user_email: 'pkr.manager@example.com', user_name: 'Pokhara Branch Manager', action: 'CREATE_SHIPMENT', module: 'LOGISTICS', details: 'Dispatched an inter-branch transfer to Butwal.', timestamp_ad: '2026-11-10T08:10:00Z', timestamp_bs: bsOn('2026-11-10'), branch_id: 'BR-PKR', fiscal_year_id: 'fy-2083', is_demo: true },
  ];

  void pkrInvoice;
  return {
    budgets,
    budgetLines,
    budgetVersions,
    allocationProfiles,
    allocationLines,
    openingStock,
    vendorOpenings,
    narrations,
    cashCloses,
    approvals,
    auditLogs,
  };
}

/**
 * Inserts demo allocation profiles only for branches that do not already have
 * one for FY 2083-84. This keeps a live operator's edited profile authoritative
 * while making a fresh seed complete and a repeat apply idempotent.
 */
export async function applyDemoAllocationFixtures(
  client: any,
  fixtures: DemoFinanceFixtures
): Promise<Record<string, number>> {
  const existing = await client.query(
    'SELECT branch_id FROM gl_budget_allocation_profiles WHERE fiscal_year_id = $1',
    ['fy-2083']
  );
  const existingBranches = new Set<string>(
    existing.rows.map((row: any) => String(row.branch_id))
  );
  const missingProfiles = fixtures.allocationProfiles.filter(
    (profile) => !existingBranches.has(String(profile.branch_id))
  );
  const missingIds = new Set(missingProfiles.map((profile) => String(profile.id)));
  const missingLines = fixtures.allocationLines.filter((line) =>
    missingIds.has(String(line.profile_id))
  );

  await insertRows(
    client,
    'gl_budget_allocation_profiles',
    ['id', 'fiscal_year_id', 'branch_id', 'created_by', 'updated_by'],
    missingProfiles
  );
  await insertRows(
    client,
    'gl_budget_allocation_lines',
    ['id', 'profile_id', 'account_group', 'cost_center_id', 'percentage_bp'],
    missingLines
  );
  return {
    demoBudgetAllocationProfiles: missingProfiles.length,
    demoBudgetAllocationLines: missingLines.length,
  };
}

export async function applyDemoFinanceFixtures(client: any, dataset: VerificationDataset): Promise<Record<string, number>> {
  const fixtures = buildDemoFinanceFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoBudgets', 'gl_budgets',
    ['id', 'fiscal_year_id', 'branch_id', 'created_by', 'updated_by'], fixtures.budgets);
  await put('demoBudgetLines', 'gl_budget_lines',
    ['id', 'budget_id', 'period_key', 'account_id', 'amount'], fixtures.budgetLines);
  await put('demoBudgetVersions', 'gl_budget_versions',
    ['id', 'budget_id', 'version_no', 'actor', 'source', 'source_detail', 'lines', 'created_at'], fixtures.budgetVersions);
  Object.assign(summary, await applyDemoAllocationFixtures(client, fixtures));
  await put('demoOpeningStock', 'fiscal_year_opening_stock',
    ['id', 'fiscal_year_id', 'product_id', 'branch_id', 'quantity_on_hand', 'damaged_qty', 'unit_cost', 'source_type', 'source_reference', 'posted_by', 'is_demo', 'created_by'], fixtures.openingStock);
  await put('demoVendorOpenings', 'vendor_opening_balances',
    ['id', 'fiscal_year_id', 'supplier_id', 'branch_id', 'opening_balance', 'source_type', 'source_reference', 'posted_by', 'is_demo', 'created_by'], fixtures.vendorOpenings);
  await put('demoNarrations', 'narration_templates',
    ['id', 'code', 'text', 'transaction_type', 'active', 'is_demo'], fixtures.narrations);
  await put('demoCashCloses', 'daily_cash_closes',
    ['id', 'branch_id', 'business_date_ad', 'business_date_bs', 'opening_cash', 'cash_in', 'cash_out', 'expected_closing', 'counted_closing', 'variance', 'status', 'closed_by', 'closed_at', 'is_demo'], fixtures.cashCloses);
  await put('demoApprovals', 'approval_requests',
    ['id', 'request_number', 'type', 'target_id', 'customer_name', 'customer_code', 'device_serial', 'pon_serial', 'product_name', 'current_status', 'requested_status', 'requested_by_role', 'requested_by_email', 'requested_by_name', 'branch_id', 'branch_name', 'reason', 'status', 'requested_at_ad', 'requested_at_bs', 'processed_by_email', 'processed_by_name', 'processed_by_role', 'processed_at_ad', 'processed_at_bs', 'rejection_reason', 'fiscal_year_id', 'is_demo', 'created_by'], fixtures.approvals);
  await put('demoAuditLogs', 'audit_logs',
    ['id', 'user_email', 'user_name', 'action', 'module', 'details', 'timestamp_ad', 'timestamp_bs', 'branch_id', 'fiscal_year_id', 'is_demo'], fixtures.auditLogs);

  return summary;
}
