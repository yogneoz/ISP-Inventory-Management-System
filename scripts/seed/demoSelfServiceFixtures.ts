/**
 * Canonical demo self-service fixtures: the employee-file sections and requests
 * that My Workplace and the HR registers read but the payroll-ledger fixtures do
 * not produce — qualifications, experience, family, references, expense claims,
 * delegations and one approved branch transfer.
 *
 * None of these rows post a journal or move stock, so the verified trial balance
 * and the five-pieces-per-branch stock gate are untouched.
 */
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

export interface DemoSelfServiceFixtures {
  expenseClaims: Row[];
  delegations: Row[];
  qualifications: Row[];
  experience: Row[];
  familyMembers: Row[];
  references: Row[];
  branchTransfers: Row[];
}

export function buildDemoSelfServiceFixtures(_dataset: VerificationDataset): DemoSelfServiceFixtures {
  const expenseClaims: Row[] = [
    {
      id: 'demo-expense-001',
      employee_id: 'demo-emp-002',
      branch_id: 'BR-KTM',
      category: 'TRAVEL',
      amount: 1_250,
      currency: 'NPR',
      description: 'Taxi to the customer site for WO-DEMO-002 and back.',
      receipt_attached: true,
      status: 'SUBMITTED',
      submitted_at: '2026-11-21T05:30:00Z',
      is_demo: true,
    },
    {
      id: 'demo-expense-002',
      employee_id: 'demo-emp-004',
      branch_id: 'BR-BTL',
      category: 'MEALS',
      amount: 900,
      currency: 'NPR',
      description: 'Field lunch for the Butwal install crew.',
      receipt_attached: true,
      status: 'APPROVED',
      submitted_at: '2026-11-18T04:00:00Z',
      decided_at: '2026-11-19T03:15:00Z',
      decided_by: 'Manisha Joshi',
      decision_note: 'Approved within the field-allowance limit.',
      is_demo: true,
    },
    {
      id: 'demo-expense-003',
      employee_id: 'demo-emp-005',
      branch_id: 'BR-DHN',
      category: 'MATERIALS',
      amount: 3_400,
      currency: 'NPR',
      ticket_code: 'REQ-DHN-0112',
      description: 'Emergency cable clips bought locally for WO-DEMO-004.',
      receipt_attached: false,
      status: 'PAID',
      submitted_at: '2026-11-10T06:45:00Z',
      decided_at: '2026-11-11T02:20:00Z',
      decided_by: 'Manisha Joshi',
      decision_note: 'Reimbursed with the November payroll.',
      is_demo: true,
    },
    // Expense claim is a More entry gated only by `claims.submit`, which every
    // demo login holds, so each persona needs a claim of its own: the screen's
    // "Find a claim" answers 404 for an employee with no row.
    {
      id: 'demo-expense-005',
      employee_id: 'demo-emp-001',
      branch_id: 'BR-KTM',
      category: 'TRAVEL',
      amount: 4_800,
      currency: 'NPR',
      description: 'Airport transfer for the December board review.',
      receipt_attached: true,
      status: 'APPROVED',
      submitted_at: '2026-11-19T03:10:00Z',
      decided_at: '2026-11-20T02:05:00Z',
      decided_by: 'Board Secretariat',
      decision_note: 'Approved with the travel policy rate.',
      is_demo: true,
    },
    {
      id: 'demo-expense-006',
      employee_id: 'demo-emp-003',
      branch_id: 'BR-PKR',
      category: 'MEALS',
      amount: 1_100,
      currency: 'NPR',
      description: 'Lunch for the Pokhara pre-install survey crew.',
      receipt_attached: true,
      status: 'SUBMITTED',
      submitted_at: '2026-11-22T05:40:00Z',
      is_demo: true,
    },
    {
      id: 'demo-expense-007',
      employee_id: 'demo-emp-007',
      branch_id: 'BR-KTM',
      category: 'MATERIALS',
      amount: 2_600,
      currency: 'NPR',
      description: 'Optical power meter batteries and cleaning kit for the splitter check.',
      receipt_attached: true,
      status: 'SUBMITTED',
      submitted_at: '2026-11-23T04:15:00Z',
      is_demo: true,
    },
    {
      id: 'demo-expense-008',
      employee_id: 'demo-emp-011',
      branch_id: 'BR-KTM',
      category: 'GENERAL',
      amount: 1_500,
      currency: 'NPR',
      description: 'Courier of the signed metered-service verification file.',
      receipt_attached: true,
      status: 'PAID',
      submitted_at: '2026-11-13T06:20:00Z',
      decided_at: '2026-11-14T02:40:00Z',
      decided_by: 'Sandesh Bhandari',
      decision_note: 'Reimbursed in the November pay cycle.',
      is_demo: true,
    },
    {
      id: 'demo-expense-009',
      employee_id: 'demo-emp-020',
      branch_id: 'BR-KTM',
      category: 'TRAVEL',
      amount: 2_050,
      currency: 'NPR',
      description: 'Taxi to the branch for the Q4 assurance visit.',
      receipt_attached: true,
      status: 'SUBMITTED',
      submitted_at: '2026-11-24T03:30:00Z',
      is_demo: true,
    },
  ];

  const delegations: Row[] = [
    {
      id: 'demo-delegation-001',
      delegator_employee_id: 'demo-emp-001',
      delegate_employee_id: 'demo-emp-006',
      capabilities: ['APPROVE_LEAVE', 'APPROVE_EXPENSE'],
      start_date_ad: '2026-11-24',
      end_date_ad: '2026-11-28',
      start_date_bs: bsOn('2026-11-24'),
      end_date_bs: bsOn('2026-11-28'),
      is_active: true,
      created_by: SEED,
    },
  ];

  const qualifications: Row[] = [
    { id: 'demo-qual-001', employee_id: 'demo-emp-005', sort_order: 1, exam_passed: 'B.Sc. Computer Science', board_university: 'Tribhuvan University', percentage: 72.4, is_demo: true },
    { id: 'demo-qual-002', employee_id: 'demo-emp-002', sort_order: 1, exam_passed: 'Higher Secondary (Management)', board_university: 'NEB', percentage: 68, is_demo: true },
    { id: 'demo-qual-003', employee_id: 'demo-emp-002', sort_order: 2, exam_passed: 'Certificate in Customer Service', board_university: 'CTEVT', percentage: 81.5, is_demo: true },
  ];

  const experience: Row[] = [
    { id: 'demo-exp-row-001', employee_id: 'demo-emp-005', sort_order: 1, organization: 'Himalayan Broadband', from_ad: '2021-04-01', to_ad: '2025-12-31', designation: 'Fiber Technician', is_demo: true },
    { id: 'demo-exp-row-002', employee_id: 'demo-emp-004', sort_order: 1, organization: 'Lumbini Traders', from_ad: '2019-07-01', to_ad: '2025-09-30', designation: 'Accounts Assistant', is_demo: true },
  ];

  const familyMembers: Row[] = [
    { id: 'demo-family-001', employee_id: 'demo-emp-005', sort_order: 1, name: 'Kamala Rai', age: 54, occupation: 'Farmer', relation: 'Mother', is_demo: true },
    { id: 'demo-family-002', employee_id: 'demo-emp-002', sort_order: 1, name: 'Ramesh Karki', age: 58, occupation: 'Retired teacher', relation: 'Father', is_demo: true },
  ];

  const references: Row[] = [
    { id: 'demo-ref-001', employee_id: 'demo-emp-005', sort_order: 1, name: 'Nabin Chaudhary', organization: 'ISP Inventory Management System', contact: '9801000016', relation: 'Supervisor', is_demo: true },
    { id: 'demo-ref-002', employee_id: 'demo-emp-002', sort_order: 1, name: 'Rohit Karki', organization: 'ISP Inventory Management System', contact: '9801000014', relation: 'Branch manager', is_demo: true },
  ];

  const branchTransfers: Row[] = [
    {
      id: 'demo-transfer-001',
      employee_id: 'demo-emp-019',
      from_branch_id: 'BR-PKR',
      from_branch_name: 'Pokhara Branch',
      to_branch_id: 'BR-DHN',
      to_branch_name: 'Dharan Branch',
      transferred_by: 'Pooja Rana',
      effective_date_ad: '2026-12-01',
      effective_date_bs: bsOn('2026-12-01'),
      reason: 'Area cluster realignment for the eastern region.',
      status: 'APPROVED',
      approved_by: 'Aarav Sharma',
      approved_at: '2026-11-20T04:00:00Z',
      decision_note: 'Approved with the December roster.',
      is_demo: true,
    },
  ];

  return { expenseClaims, delegations, qualifications, experience, familyMembers, references, branchTransfers };
}

export async function applyDemoSelfServiceFixtures(
  client: any,
  dataset: VerificationDataset
): Promise<Record<string, number>> {
  const fixtures = buildDemoSelfServiceFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoExpenseClaims', 'hr_expense_claims',
    ['id', 'employee_id', 'branch_id', 'category', 'amount', 'currency', 'ticket_code', 'description',
      'receipt_attached', 'status', 'submitted_at', 'decided_at', 'decided_by', 'decision_note', 'is_demo'],
    fixtures.expenseClaims);
  await put('demoDelegations', 'hr_delegations',
    ['id', 'delegator_employee_id', 'delegate_employee_id', 'capabilities', 'start_date_ad', 'end_date_ad',
      'start_date_bs', 'end_date_bs', 'is_active', 'created_by'],
    fixtures.delegations);
  await put('demoQualifications', 'hr_employee_qualifications',
    ['id', 'employee_id', 'sort_order', 'exam_passed', 'board_university', 'percentage', 'is_demo'],
    fixtures.qualifications);
  await put('demoEmployeeExperience', 'hr_employee_experience',
    ['id', 'employee_id', 'sort_order', 'organization', 'from_ad', 'to_ad', 'designation', 'is_demo'],
    fixtures.experience);
  await put('demoEmployeeFamily', 'hr_employee_family_members',
    ['id', 'employee_id', 'sort_order', 'name', 'age', 'occupation', 'relation', 'is_demo'],
    fixtures.familyMembers);
  await put('demoEmployeeReferences', 'hr_employee_references',
    ['id', 'employee_id', 'sort_order', 'name', 'organization', 'contact', 'relation', 'is_demo'],
    fixtures.references);
  await put('demoBranchTransfers', 'hr_employee_branch_transfers',
    ['id', 'employee_id', 'from_branch_id', 'from_branch_name', 'to_branch_id', 'to_branch_name',
      'transferred_by', 'effective_date_ad', 'effective_date_bs', 'reason', 'status', 'approved_by',
      'approved_at', 'decision_note', 'is_demo'],
    fixtures.branchTransfers);

  return summary;
}
