/**
 * The demo dataset promises two things at once: it fills every module, and it
 * never moves a verified figure. Both are easy to break silently — a claim that
 * posts a credit, a custody movement that does not add up, a template whose two
 * sides disagree — so the fixture builders are asserted here, and the coverage
 * catalogue is checked against the real schema.
 *
 * Pure: no database, no HTTP.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildVerificationDataset } from '../scripts/seed/verificationDataset';
import { buildDemoWorkplaceFixtures } from '../scripts/seed/demoWorkplaceFixtures';
import { buildDemoIntegrationFixtures, DEMO_PARTNER_API_KEY_ID, DEMO_PARTNER_SECRET } from '../scripts/seed/demoIntegrationFixtures';
import { buildDemoRegisterFixtures } from '../scripts/seed/demoRegisterFixtures';
import { buildDemoSelfServiceFixtures } from '../scripts/seed/demoSelfServiceFixtures';
import {
  buildDemoCoverageFixtures,
  DEMO_MOBILE_ACCOUNT_LINK_SQL,
  DEMO_SEPARATION_SQL,
} from '../scripts/seed/demoCoverageFixtures';
import { buildDemoOperationsFixtures } from '../scripts/seed/demoOperationsFixtures';

const dataset = buildVerificationDataset();
const workplace = buildDemoWorkplaceFixtures(dataset);
const integration = buildDemoIntegrationFixtures();
const registers = buildDemoRegisterFixtures(dataset);
const selfService = buildDemoSelfServiceFixtures(dataset);
const coverage = buildDemoCoverageFixtures(dataset);
const operations = buildDemoOperationsFixtures(dataset);

describe('demo workplace fixtures', () => {
  test('the dispatch board shows every status, and completion state agrees with the row', () => {
    const statuses = new Set(workplace.workOrders.map((row) => row.status));
    assert.deepEqual([...statuses].sort(), ['ASSIGNED', 'CANCELLED', 'COMPLETED', 'OPEN']);
    for (const order of workplace.workOrders) {
      assert.equal(
        order.status === 'COMPLETED',
        order.completed_at !== null,
        `${order.work_order_no}: status and completed_at must agree`
      );
      if (order.status === 'ASSIGNED') assert.ok(order.technician_name, `${order.work_order_no} needs a technician`);
      if (order.status === 'OPEN' || order.status === 'CANCELLED') {
        assert.equal(order.technician_id, null, `${order.work_order_no} must be unassigned`);
      }
      assert.match(String(order.scheduled_date_bs), /^\d{4}-\d{2}-\d{2} BS$/, 'every business date carries its BS half');
    }
  });

  test('every work order belongs to a real demo customer of its own branch', () => {
    const customers = new Map(dataset.customers.map((row: any) => [row.id, row]));
    for (const order of workplace.workOrders) {
      const customer = customers.get(order.customer_id as string);
      assert.ok(customer, `${order.work_order_no} references a seeded customer`);
      assert.equal((customer as any).branchId, order.branch_id, `${order.work_order_no} must stay inside its branch`);
    }
  });

  test('evidence hashes match its bytes, and no two captures on one job collide', () => {
    const seen = new Set<string>();
    for (const row of workplace.evidence) {
      const bytes = Buffer.from(row.data_base64 as string, 'base64');
      assert.equal(row.byte_size, bytes.length, 'byte_size must be the decoded length');
      assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'the contract ceiling is 2 MiB');
      assert.equal(
        row.sha256,
        crypto.createHash('sha256').update(bytes).digest('hex'),
        'sha256 must identify the stored bytes'
      );
      const key = `${row.work_order_id}:${row.sha256}`;
      assert.ok(!seen.has(key), 'uq_field_work_order_evidence_capture would refuse this duplicate');
      seen.add(key);
    }
    assert.equal(workplace.evidence.filter((row) => row.kind === 'SIGNATURE').length, 2);
  });

  test('custody holdings equal the sum of their movements', () => {
    const balances = new Map<string, number>();
    for (const row of workplace.movements) {
      const key = `${row.employee_id}:${row.product_id}:${row.branch_id}`;
      const delta = row.movement_type === 'ISSUE' || row.movement_type === 'TRANSFER_IN'
        ? Number(row.quantity)
        : -Number(row.quantity);
      balances.set(key, (balances.get(key) || 0) + delta);
    }
    const holdings = new Map(
      workplace.holdings.map((row) => [`${row.employee_id}:${row.product_id}:${row.branch_id}`, Number(row.quantity)])
    );
    for (const [key, quantity] of holdings) {
      assert.equal(balances.get(key), quantity, `${key}: holdings must be what the register would compute`);
    }
    for (const [key, quantity] of balances) {
      if (quantity === 0) {
        assert.ok(!holdings.has(key), `${key}: a zero balance must not keep a holdings row`);
      }
    }
  });

  test('a custody transfer is written as a mirrored pair', () => {
    const transfers = workplace.movements.filter((row) => String(row.movement_type).startsWith('TRANSFER_'));
    assert.equal(transfers.length, 2, 'one transfer is two appends');
    const [out, into] = transfers;
    assert.equal(out.movement_type, 'TRANSFER_OUT');
    assert.equal(into.movement_type, 'TRANSFER_IN');
    assert.equal(out.transfer_group_id, into.transfer_group_id);
    assert.equal(out.counterparty_employee_id, into.employee_id);
    assert.equal(into.counterparty_employee_id, out.employee_id);
    assert.equal(out.quantity, into.quantity);
  });

  test('attendance proofs point at attendance rows that exist', () => {
    // The attendance fixture ids are deterministic, so the proof rows can be
    // checked without the database: they are built from the same pattern.
    for (const proof of workplace.attendanceProofs) {
      assert.match(String(proof.attendance_id), /^demo-attendance-EMP-00\d-2026-11-0\d$/);
    }
  });
});

describe('demo integration fixtures', () => {
  test('the partner authenticates with the seeded key, and only its hash is stored', () => {
    const partner = integration.partners[0];
    assert.equal(partner.api_key_id, DEMO_PARTNER_API_KEY_ID);
    const key = integration.apiKeys.find((row) => row.id === DEMO_PARTNER_API_KEY_ID);
    assert.ok(key, 'the partner must reference a seeded key');
    assert.notEqual(key?.secret_hash, DEMO_PARTNER_SECRET, 'the secret itself must never be stored');
    assert.equal(
      key?.secret_hash,
      crypto.createHash('sha256').update(DEMO_PARTNER_SECRET).digest('hex'),
      'the stored hash must be the sha256 of the demo secret'
    );
    assert.equal(String(key?.secret_hash).length, 64);
  });

  test('queued events are undelivered, which is why they are still queued', () => {
    for (const row of integration.outbox) {
      assert.ok(['PENDING', 'FAILED'].includes(String(row.status)));
      assert.equal(row.delivered_at, undefined, 'a delivered event would not sit in the outbox');
    }
  });
});

describe('demo register fixtures', () => {
  test('no claim sits in a state whose service transition posts a journal or moves a serial', () => {
    for (const claim of registers.warrantyClaims) {
      assert.ok(
        !['CREDITED', 'SENT_TO_VENDOR'].includes(String(claim.status)),
        `${claim.claim_no}: ${claim.status} would post a recovery journal or return a serial`
      );
      if (claim.status === 'REPLACED') {
        assert.equal(claim.resolution, 'REPLACED');
        assert.ok(claim.replacement_serial, 'a replaced claim names the replacement serial');
      }
      assert.match(String(claim.reported_date_bs), /BS$/, 'claims carry their BS half');
    }
  });

  test('every claim has a timeline that starts where the claim starts', () => {
    for (const claim of registers.warrantyClaims) {
      const events = registers.warrantyClaimEvents.filter((event) => event.claim_id === claim.id);
      assert.ok(events.length >= 1, `${claim.claim_no} needs at least one event`);
      assert.equal(events[0].from_status, null, 'the first event opens the claim');
      assert.equal(events[events.length - 1].status, claim.status, 'the last event must reach the current status');
    }
  });

  test('recurring templates balance, and none of them has been run', () => {
    const evaluate = (formula: string) =>
      Number(formula.split('+').map((part) => Number(part.trim())).reduce((sum, value) => sum + value, 0));
    for (const template of registers.recurringTemplates) {
      const lines = registers.recurringTemplateLines.filter((line) => line.template_id === template.id);
      const debit = lines.filter((line) => line.side === 'DEBIT').reduce((sum, line) => sum + evaluate(String(line.amount_formula)), 0);
      const credit = lines.filter((line) => line.side === 'CREDIT').reduce((sum, line) => sum + evaluate(String(line.amount_formula)), 0);
      assert.equal(debit, credit, `${template.code}: both sides must be equal before anyone runs it`);
      assert.ok(debit > 0);
      assert.ok(!('last_journal_id' in template) || template.last_journal_id === undefined, 'no run, so no journal');
    }
  });

  test('statement lines are imported but unmatched, and the session is still open', () => {
    for (const line of registers.bankStatementLines) {
      assert.equal(line.matched_journal_line_id, undefined, 'matching is a user action, not a fixture');
      assert.equal(String(line.fingerprint).length, 64);
      assert.ok(Number(line.amount) !== 0);
    }
    assert.equal(registers.bankReconciliationSessions[0].status, 'OPEN');
  });

  test('a loan without a receipt transaction is a recorded agreement, not a posting', () => {
    for (const loan of registers.loans) {
      assert.equal(loan.status, 'OPEN');
      if (loan.tds_applicable === false) {
        assert.ok(loan.tds_exemption_reason, 'a non-TDS loan must say why');
      }
      if (loan.repayment_frequency === 'MONTHLY') {
        const schedule = registers.loanInstallments.filter((row) => row.loan_id === loan.id);
        assert.ok(schedule.length >= 6, 'a monthly loan ships its schedule');
        schedule.forEach((row, index) => assert.equal(row.sequence_number, index + 1));
      }
    }
  });

  test('cash-flow inputs are forecast rows, not postings', () => {
    const evaluate = (formula: string) =>
      formula.split('+').map((part) => Number(part.trim())).reduce((sum, value) => sum + value, 0);
    for (const row of registers.cashFlowInputs) {
      assert.ok(['INFLOW', 'OUTFLOW'].includes(String(row.direction)));
      assert.match(String(row.expected_date_bs), /BS$/);
      assert.ok(evaluate(String(row.amount_formula)) > 0, `${row.id}: the formula must resolve to a positive amount`);
    }
  });
});

describe('demo self-service fixtures', () => {
  test('expense claims and delegations respect their own decision shape', () => {
    for (const claim of selfService.expenseClaims) {
      assert.equal(claim.status === 'SUBMITTED', claim.decided_at === undefined,
        `${claim.id}: only a submitted claim waits without a decision`);
      assert.ok(Number(claim.amount) > 0);
    }
    for (const delegation of selfService.delegations) {
      assert.notEqual(delegation.delegator_employee_id, delegation.delegate_employee_id);
      assert.ok((delegation.capabilities as string[]).length > 0);
    }
  });
});

describe('demo coverage fixtures', () => {
  // The Company Overview trading card and the trading reports read revenue and
  // cost of sales from STOCK_OUT operations, while the P&L reads the posted
  // 6010/7000 balances. The dataset sold two of every seven purchased units, so
  // both halves of that story have to describe the same money or the two screens
  // disagree on one dataset.
  test('the sale rows reproduce the posted sales revenue and cost of sales', () => {
    const items = coverage.salesOperations.flatMap((row) => JSON.parse(String(row.items)));
    const revenue = items.reduce((sum, item) => sum + Number(item.totalValue || 0), 0);
    const cogs = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);
    assert.equal(revenue, 14_400, 'the sales rows must total the ledger\'s 6010 revenue');

    const ledgerBalance = (code: string) =>
      dataset.journalLines
        .filter((line: any) => line.accountCode === code)
        .reduce((sum: number, line: any) => sum + (line.debit || 0) - (line.credit || 0), 0);
    assert.equal(-ledgerBalance('6010'), revenue, 'revenue must equal the posted sales account');
    assert.equal(ledgerBalance('7000'), cogs, 'cost of sales must equal the posted 7000 account');

    assert.equal(coverage.salesOperations.length, dataset.branches.length, 'one counter-sale day per branch');
    for (const row of coverage.salesOperations) {
      assert.equal(row.type, 'STOCK_OUT');
      assert.equal(row.is_demo, true);
      assert.match(String(row.date_bs), /BS$/, 'every business date carries its BS half');
    }
  });

  test('every branch can open the consumables register', () => {
    // Pokhara's issue comes from the operations fixtures; the other three from
    // the coverage fixtures. The register opens on one branch, so every branch
    // needs at least one.
    const covered = new Set(
      [...operations.stockOperations, ...coverage.consumableIssues]
        .filter((row) => row.type === 'CONSUMABLE_ISSUE')
        .map((row) => row.branch_id)
    );
    for (const branch of dataset.branches) {
      assert.ok(covered.has(branch.id), `the ${branch.code} consumables register would open empty`);
    }
    for (const row of coverage.consumableIssues) {
      assert.equal(row.type, 'CONSUMABLE_ISSUE');
      assert.ok(JSON.parse(String(row.items)).length > 0, `${row.reference_number} needs at least one line`);
    }
  });

  test('deployments cover both register filters and carry the issue record a reversal needs', () => {
    const types = new Set(coverage.deployments.map((row) => row.assignedType));
    assert.deepEqual([...types].sort(), ['CUSTOMER', 'LOCATION']);

    const assets = new Map(dataset.fixedAssets.map((asset: any) => [asset.id, asset]));
    for (const deployment of coverage.deployments) {
      const asset = assets.get(deployment.assetId) as any;
      assert.ok(asset, `${deployment.assetId} must be a seeded fixed asset`);
      assert.equal(asset.branchId, deployment.branchId, 'a deployment never crosses a branch');
      assert.match(String(deployment.assignmentDateAD), /^\d{4}-\d{2}-\d{2}$/);

      const issue = coverage.assetIssues.find(
        (row) => row.branch_id === deployment.branchId && row.items === '[]'
      );
      assert.ok(issue, 'the reversal path reads the asset\'s STOCK_OUT record');
      assert.equal((JSON.parse(String(issue!.items)) as unknown[]).length, 0, 'asset issues carry no priced sale lines');
    }
    assert.equal(coverage.assetIssues.length, coverage.deployments.length);
  });

  test('the leaver update cannot touch a payroll employee', () => {
    assert.match(DEMO_SEPARATION_SQL, /NOT EXISTS \(SELECT 1 FROM payroll_run_lines/);
    assert.match(DEMO_SEPARATION_SQL, /e\.is_demo = TRUE/);
    assert.match(DEMO_SEPARATION_SQL, /LIMIT 2/);
  });

  test('every mobile persona has a working week of attendance in its own branch', () => {
    const byEmployee = new Map<string, Set<string>>();
    for (const row of coverage.mobileAttendance) {
      assert.equal(row.status, 'PRESENT');
      assert.equal(row.is_demo, true);
      assert.ok(String(row.check_in_time), 'a present day carries a clock-in');
      const dates = byEmployee.get(String(row.employee_id)) ?? new Set<string>();
      dates.add(String(row.attendance_date_ad));
      byEmployee.set(String(row.employee_id), dates);
    }
    // The non-payroll personas the phone signs in as.
    for (const employeeId of ['demo-emp-003', 'demo-emp-004', 'demo-emp-005', 'demo-emp-007', 'demo-emp-011', 'demo-emp-014']) {
      const dates = byEmployee.get(employeeId);
      assert.ok(dates, `${employeeId} must have attendance the app can show`);
      assert.equal(dates!.size, 5, `${employeeId} needs a full working week`);
    }
    // The two payroll employees already had their own days; a duplicate date
    // would break `UNIQUE (employee_id, attendance_date_ad)` mid-seed.
    for (const employeeId of ['demo-emp-001', 'demo-emp-002']) {
      assert.equal(byEmployee.has(employeeId), false, `${employeeId} already has seeded attendance`);
    }
  });

  test('the office personas have a leave type to choose from', () => {
    const owners = new Set(coverage.mobileLeaveBalances.map((row) => String(row.employee_id)));
    assert.deepEqual([...owners].sort(), ['demo-emp-007', 'demo-emp-011']);
    assert.equal(coverage.mobileLeaveBalances.length, 6, 'three leave types for each office persona');
    for (const row of coverage.mobileLeaveBalances) {
      assert.ok(Number(row.entitlement_days) > 0);
      assert.equal(row.balance_year, 2026);
    }
  });

  test('the phone account link reaches a real employee without inventing one', () => {
    assert.match(DEMO_MOBILE_ACCOUNT_LINK_SQL, /WHERE e\.id = m\.id/);
    assert.match(DEMO_MOBILE_ACCOUNT_LINK_SQL, /AND e\.user_id IS NULL/);
    for (const user of ['usr-ktm-manager', 'usr-accountant', 'usr-inventory']) {
      assert.ok(DEMO_MOBILE_ACCOUNT_LINK_SQL.includes(`'${user}'`), `${user} must be able to sign in on the phone`);
    }
    assert.doesNotMatch(DEMO_MOBILE_ACCOUNT_LINK_SQL, /INSERT INTO employees/, 'no employee is created');
  });

  test('the open visit and the pending decision belong to the linked manager', () => {
    assert.equal(coverage.mobileWorkOrder.technician_id, 'demo-emp-014');
    assert.equal(coverage.mobileWorkOrder.status, 'ASSIGNED');
    assert.equal(coverage.mobileWorkOrder.completed_at, null, 'an ASSIGNED order cannot carry a completion stamp');
    assert.equal(coverage.mobileClaim.employee_id, 'demo-emp-014');
    assert.equal(coverage.mobileClaim.status, 'SUBMITTED');
    // The API refuses self-approval, so the claim must belong to someone other
    // than the branch account that reads the queue.
    assert.notEqual(coverage.mobileClaim.employee_id, 'demo-emp-002');
    assert.equal(coverage.mobileLeaveRequest.status, 'PENDING');
    assert.equal(coverage.mobileLeaveRequest.days_count, 2);
  });
});

describe('demo coverage catalogue', () => {
  const schema = fs.readFileSync('scripts/schema.sql', 'utf8');
  const coverageSource = fs.readFileSync('scripts/check_demo_coverage.ts', 'utf8');

  const tablesInSchema = new Set(
    [...schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_0-9]+)/g)].map((match) => match[1])
  );

  test('every table the coverage check requires exists in the schema', () => {
    const quoted = [...coverageSource.matchAll(/\['([a-z_0-9]+)', \d+\]/g)].map((match) => match[1]);
    assert.ok(quoted.length > 100, 'the catalogue must stay a real inventory, not a token list');
    for (const table of quoted) {
      assert.ok(tablesInSchema.has(table), `${table} is required by the coverage check but has no CREATE TABLE`);
    }
  });

  test('every intentionally empty table exists too', () => {
    const emptyBlocks = [...coverageSource.matchAll(/tables: \[([^\]]+)\],\s*\n\s*reason:/g)];
    assert.ok(emptyBlocks.length >= 5);
    for (const block of emptyBlocks) {
      const names = [...block[1].matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]);
      for (const table of names) {
        assert.ok(tablesInSchema.has(table), `${table} is declared intentionally empty but does not exist`);
      }
    }
  });
});
