/**
 * Canonical demo HR fixtures.
 *
 * Five employees span all four branches. Two Kathmandu employees have a posted
 * November payroll run; its journal is balanced and uses only 6400 / 2320 /
 * 2330 / 2340 so the verified balance-sheet targets do not move. Attendance,
 * leave, documents, recruitment, performance and lifecycle rows give every HR
 * screen coherent demo data.
 */
import type { VerificationDataset } from './verificationDataset';
import { bsOn, insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

const EMPLOYEES = [
  {
    id: 'demo-emp-001', code: 'EMP-001', name: 'Aarav Sharma', branchId: 'BR-KTM',
    department: 'Operations', designation: 'Network Engineer', designationCode: 'DES-NET',
    userId: 'usr-super', salary: 100_000, basic: 60_000, allowance: 40_000,
    ssf: true, joining: '2025-07-17', dob: '1994-05-12', pan: '100100101',
    ssfNo: 'SSF-1001', bank: 'Nabil Bank', account: '012345678901',
    phone: '9801000001', email: 'aarav.sharma@example.com',
  },
  {
    id: 'demo-emp-002', code: 'EMP-002', name: 'Nisha Karki', branchId: 'BR-KTM',
    department: 'Customer Support', designation: 'Customer Support Officer', designationCode: 'DES-CSO',
    userId: 'usr-frontdesk', salary: 60_000, basic: 40_000, allowance: 20_000,
    ssf: false, joining: '2026-04-01', dob: '1997-09-23', pan: '100100102',
    ssfNo: '', bank: 'Nabil Bank', account: '012345678902',
    phone: '9801000002', email: 'nisha.karki@example.com',
  },
  {
    id: 'demo-emp-003', code: 'EMP-003', name: 'Bikash Thapa', branchId: 'BR-PKR',
    department: 'Sales', designation: 'Sales Executive', designationCode: 'DES-SALES',
    userId: 'usr-pkr-manager', salary: 70_000, basic: 45_000, allowance: 25_000,
    ssf: true, joining: '2025-09-01', dob: '1992-03-18', pan: '100100103',
    ssfNo: 'SSF-1003', bank: 'Global IME Bank', account: '012345678903',
    phone: '9801000003', email: 'bikash.thapa@example.com',
  },
  {
    id: 'demo-emp-004', code: 'EMP-004', name: 'Sita Gurung', branchId: 'BR-BTL',
    department: 'Finance', designation: 'Accountant', designationCode: 'DES-ACC',
    userId: 'usr-btl-manager', salary: 65_000, basic: 40_000, allowance: 25_000,
    ssf: true, joining: '2025-10-01', dob: '1995-11-07', pan: '100100104',
    ssfNo: 'SSF-1004', bank: 'Nabil Bank', account: '012345678904',
    phone: '9801000004', email: 'sita.gurung@example.com',
  },
  {
    id: 'demo-emp-005', code: 'EMP-005', name: 'Rajan Rai', branchId: 'BR-DHN',
    department: 'Field Operations', designation: 'Field Technician', designationCode: 'DES-FIELD',
    userId: 'usr-dhn-manager', salary: 55_000, basic: 35_000, allowance: 20_000,
    ssf: false, joining: '2026-01-15', dob: '1998-06-30', pan: '100100105',
    ssfNo: '', bank: 'Global IME Bank', account: '012345678905',
    phone: '9801000005', email: 'rajan.rai@example.com',
  },
];

const DEPARTMENTS = ['Operations', 'Finance', 'Sales', 'Customer Support', 'Field Operations'];
const DESIGNATIONS = [
  { name: 'Network Engineer', code: 'DES-NET' },
  { name: 'Customer Support Officer', code: 'DES-CSO' },
  { name: 'Sales Executive', code: 'DES-SALES' },
  { name: 'Accountant', code: 'DES-ACC' },
  { name: 'Field Technician', code: 'DES-FIELD' },
];
const WORK_STATIONS = [
  { name: 'Kathmandu (Head Office)', code: 'WS-KTM' },
  { name: 'Pokhara Branch', code: 'WS-PKR' },
  { name: 'Butwal Branch', code: 'WS-BTL' },
  { name: 'Dharan Branch', code: 'WS-DHN' },
];
const LEAVE_TYPES = [
  { id: 'demo-leave-annual', code: 'ANNUAL', name: 'Annual Leave', quota: 12 },
  { id: 'demo-leave-sick', code: 'SICK', name: 'Sick Leave', quota: 10 },
  { id: 'demo-leave-casual', code: 'CASUAL', name: 'Casual Leave', quota: 6 },
];

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8'
);

export interface DemoHrFixtures {
  orgMasters: Row[];
  shifts: Row[];
  leaveTypes: Row[];
  holidays: Row[];
  employees: Row[];
  salaries: Row[];
  salaryComponents: Row[];
  leaveBalances: Row[];
  leaveRequests: Row[];
  attendance: Row[];
  documents: Row[];
  statutoryConfigs: Row[];
  tdsSlabs: Row[];
  payrollAdjustments: Row[];
  journals: Row[];
  journalLines: Row[];
  payrollRuns: Row[];
  payrollLines: Row[];
  requisitions: Row[];
  candidates: Row[];
  interviews: Row[];
  offers: Row[];
  reviewCycles: Row[];
  goals: Row[];
  feedback: Row[];
  lifecycleChecklists: Row[];
  lifecycleItems: Row[];
}

export function buildDemoHrFixtures(dataset: VerificationDataset): DemoHrFixtures {
  const branchName = (id: string) => dataset.branches.find((branch: any) => branch.id === id)?.name ?? id;
  const ktmAsset = dataset.fixedAssets.find((asset: any) => asset.branchId === 'BR-KTM');
  const dhnAsset = dataset.fixedAssets.find((asset: any) => asset.branchId === 'BR-DHN');

  const orgMasters: Row[] = [
    ...DEPARTMENTS.map((name, index) => ({
      id: `demo-department-${index + 1}`,
      kind: 'DEPARTMENT',
      name,
      code: `DEP-${String(index + 1).padStart(2, '0')}`,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
    ...DESIGNATIONS.map((designation, index) => ({
      id: `demo-designation-${index + 1}`,
      kind: 'DESIGNATION',
      name: designation.name,
      code: designation.code,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
    ...WORK_STATIONS.map((station, index) => ({
      id: `demo-workstation-${index + 1}`,
      kind: 'WORK_STATION',
      name: station.name,
      code: station.code,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
  ];

  const shifts: Row[] = [
    { id: 'demo-shift-morning', code: 'MORNING', name: 'Morning Shift', start_time: '09:00:00', end_time: '17:00:00', grace_minutes: 10, is_active: true, is_demo: true, created_by: SEED },
    { id: 'demo-shift-evening', code: 'EVENING', name: 'Evening Shift', start_time: '13:00:00', end_time: '21:00:00', grace_minutes: 10, is_active: true, is_demo: true, created_by: SEED },
  ];

  const leaveTypes: Row[] = LEAVE_TYPES.map((type) => ({
    id: type.id,
    code: type.code,
    name: type.name,
    annual_quota_days: type.quota,
    is_paid: true,
    is_active: true,
    is_demo: true,
    created_by: SEED,
  }));

  const holidays: Row[] = [];
  for (const branch of dataset.branches) {
    holidays.push(
      { id: `demo-holiday-dashain-${branch.code}`, branch_id: branch.id, holiday_date_ad: '2026-10-20', holiday_date_bs: bsOn('2026-10-20'), name: 'Dashain Holiday', is_paid: true, notes: 'Demo public holiday.', is_demo: true, created_by: SEED },
      { id: `demo-holiday-tihar-${branch.code}`, branch_id: branch.id, holiday_date_ad: '2026-10-21', holiday_date_bs: bsOn('2026-10-21'), name: 'Tihar Holiday', is_paid: true, notes: 'Demo public holiday.', is_demo: true, created_by: SEED }
    );
  }

  const employees: Row[] = EMPLOYEES.map((employee) => ({
    id: employee.id,
    employee_code: employee.code,
    name: employee.name,
    branch_id: employee.branchId,
    department: employee.department,
    designation: employee.designation,
    designation_code: employee.designationCode,
    pan_number: employee.pan,
    ssf_number: employee.ssfNo || null,
    bank_account: employee.account,
    bank_name: employee.bank,
    is_active: true,
    is_demo: true,
    created_by: SEED,
    updated_by: SEED,
    employment_type: 'FULL_TIME',
    joining_date_ad: employee.joining,
    date_of_birth_ad: employee.dob,
    contract_expiry_ad: '2027-07-16',
    work_station: branchName(employee.branchId),
    address: 'Kathmandu, Nepal',
    personal_contact: employee.phone,
    emergency_contact_person: 'Demo Family Contact',
    emergency_contact_number: `9801${employee.code.slice(-3)}0000`,
    internal_email: employee.email,
    personal_email: employee.email,
    monthly_salary: employee.salary,
    ssf_eligible: employee.ssf,
    user_id: employee.userId,
  }));

  const salaries: Row[] = EMPLOYEES.map((employee) => ({
    id: `demo-salary-${employee.code.toLowerCase()}`,
    employee_id: employee.id,
    branch_id: employee.branchId,
    effective_from: '2026-07-17',
    ssf_eligible: employee.ssf,
    overtime_rate: 500,
    tds_monthly: 0,
    notes: 'Canonical demo salary structure.',
    is_demo: true,
    created_by: SEED,
  }));

  const salaryComponents: Row[] = EMPLOYEES.flatMap((employee) => [
    {
      id: `demo-salary-${employee.code.toLowerCase()}-basic`,
      salary_id: `demo-salary-${employee.code.toLowerCase()}`,
      component_code: 'BASIC',
      component_name: 'Basic Salary',
      kind: 'EARNING',
      amount: employee.basic,
      is_taxable: true,
      is_ssf_applicable: employee.ssf,
      sort_order: 1,
    },
    {
      id: `demo-salary-${employee.code.toLowerCase()}-allowance`,
      salary_id: `demo-salary-${employee.code.toLowerCase()}`,
      component_code: 'ALLOWANCE',
      component_name: 'Dearness Allowance',
      kind: 'EARNING',
      amount: employee.allowance,
      is_taxable: true,
      is_ssf_applicable: false,
      sort_order: 2,
    },
  ]);

  const leaveBalances: Row[] = EMPLOYEES.flatMap((employee) =>
    LEAVE_TYPES.map((type) => ({
      id: `demo-leave-balance-${employee.code}-${type.code}`,
      employee_id: employee.id,
      branch_id: employee.branchId,
      leave_type_id: type.id,
      balance_year: 2026,
      entitlement_days: type.quota,
      adjustment_days: 0,
      notes: 'Canonical demo leave entitlement.',
      is_demo: true,
      created_by: SEED,
    }))
  );

  const leaveRequests: Row[] = [
    {
      id: 'demo-leave-request-1', request_no: 'LR-2083-DEMO-001', employee_id: 'demo-emp-001',
      branch_id: 'BR-KTM', leave_type_id: 'demo-leave-annual', start_date_ad: '2026-11-07',
      end_date_ad: '2026-11-08', start_date_bs: bsOn('2026-11-07'), end_date_bs: bsOn('2026-11-08'),
      days_count: 2, reason: 'Family event in Kathmandu.', status: 'APPROVED',
      decided_by: 'superadmin@example.com', decided_at: '2026-11-06T09:00:00Z',
      decision_note: 'Approved by the branch manager.', is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-leave-request-2', request_no: 'LR-2083-DEMO-002', employee_id: 'demo-emp-002',
      branch_id: 'BR-KTM', leave_type_id: 'demo-leave-sick', start_date_ad: '2026-11-05',
      end_date_ad: '2026-11-06', start_date_bs: bsOn('2026-11-05'), end_date_bs: bsOn('2026-11-06'),
      days_count: 2, reason: 'Medical rest advised by the doctor.', status: 'PENDING',
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-leave-request-3', request_no: 'LR-2083-DEMO-003', employee_id: 'demo-emp-003',
      branch_id: 'BR-PKR', leave_type_id: 'demo-leave-casual', start_date_ad: '2026-10-27',
      end_date_ad: '2026-10-28', start_date_bs: bsOn('2026-10-27'), end_date_bs: bsOn('2026-10-28'),
      days_count: 2, reason: 'Personal errand.', status: 'APPROVED',
      decided_by: 'pkr.manager@example.com', decided_at: '2026-10-24T10:30:00Z',
      decision_note: 'Approved after handover.', is_demo: true, created_by: SEED,
    },
  ];

  const attendanceDates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const attendance: Row[] = [];
  for (const employee of EMPLOYEES.slice(0, 2)) {
    for (const date of attendanceDates) {
      attendance.push({
        id: `demo-attendance-${employee.code}-${date}`,
        employee_id: employee.id,
        branch_id: employee.branchId,
        attendance_date_ad: date,
        attendance_date_bs: bsOn(date),
        shift_id: 'demo-shift-morning',
        status: 'PRESENT',
        check_in_time: '09:02:00',
        check_out_time: '17:10:00',
        overtime_hours: 0,
        notes: 'Demo attendance record.',
        source: 'MANUAL',
        is_demo: true,
        recorded_by: 'superadmin@example.com',
      });
    }
  }

  const documents: Row[] = [
    {
      id: 'demo-document-emp-001-contract', employee_id: 'demo-emp-001', doc_type: 'CONTRACT',
      original_name: 'Aarav-Sharma-Employment-Contract.pdf', mime_type: 'application/pdf',
      byte_size: PDF_BYTES.length, storage_key: 'demo/hr/demo-emp-001/contract.pdf',
      expires_on_ad: '2027-07-16', notes: 'Demo employment contract.',
      content: PDF_BYTES, is_demo: true, uploaded_by: 'superadmin@example.com',
    },
    {
      id: 'demo-document-emp-002-id', employee_id: 'demo-emp-002', doc_type: 'ID_PROOF',
      original_name: 'Nisha-Karki-Citizenship.pdf', mime_type: 'application/pdf',
      byte_size: PDF_BYTES.length, storage_key: 'demo/hr/demo-emp-002/id-proof.pdf',
      expires_on_ad: null, notes: 'Demo identity proof.',
      content: PDF_BYTES, is_demo: true, uploaded_by: 'superadmin@example.com',
    },
  ];

  const statutoryConfigs: Row[] = [{
    id: 'demo-statutory-fy2083', fiscal_year_id: 'fy-2083', employee_ssf_percent: 11,
    employer_ssf_percent: 20, notes: 'Canonical demo SSF and TDS configuration.',
    is_demo: true, created_by: SEED,
  }];
  const tdsSlabs: Row[] = [
    { id: 'demo-tds-slab-1', config_id: 'demo-statutory-fy2083', slab_order: 1, lower_bound: 0, upper_bound: 500_000, rate_percent: 1 },
    { id: 'demo-tds-slab-2', config_id: 'demo-statutory-fy2083', slab_order: 2, lower_bound: 500_000, upper_bound: 1_000_000, rate_percent: 10 },
    { id: 'demo-tds-slab-3', config_id: 'demo-statutory-fy2083', slab_order: 3, lower_bound: 1_000_000, upper_bound: null, rate_percent: 20 },
  ];

  const payrollAdjustments: Row[] = [
    { id: 'demo-payroll-adjustment-1', employee_id: 'demo-emp-001', period_key: '2026-11', incentive_amount: 5_000, arrears_amount: 0, advance_amount: 0, loan_amount: 0, notes: 'Demo performance incentive.', is_demo: true, created_by: SEED },
    { id: 'demo-payroll-adjustment-2', employee_id: 'demo-emp-002', period_key: '2026-11', incentive_amount: 2_000, arrears_amount: 0, advance_amount: 0, loan_amount: 0, notes: 'Demo attendance incentive.', is_demo: true, created_by: SEED },
  ];

  const payrollPeriod = dataset.periods.find(
    (period: any) => period.fiscalYearId === 'fy-2083' && period.periodKey === '2026-11'
  );
  const journals: Row[] = [{
    id: 'demo-payroll-journal-2083-11', journal_no: 'PR-DEMO-2083-11',
    journal_date_ad: '2026-11-29', journal_date_bs: bsOn('2026-11-29'),
    fiscal_year_id: 'fy-2083', period_id: payrollPeriod?.id ?? 'vfy-period-fy-2083-2026-11',
    branch_id: 'BR-KTM', source_type: 'PAYROLL', source_id: 'demo-payroll-run-2083-11',
    memo: 'Demo November 2026 payroll posting', status: 'POSTED',
    posted_at: '2026-11-29T12:00:00Z', posted_by: 'superadmin@example.com',
    voucher_type: 'PAYROLL', currency: 'NPR', exchange_rate: 1, is_demo: true,
  }];
  const journalLines: Row[] = [
    { id: 'demo-payroll-journal-line-1', journal_id: 'demo-payroll-journal-2083-11', line_no: 1, account_id: 'gla-6400', branch_id: 'BR-KTM', debit: 167_000, credit: 0, memo: 'Salaries and wages' },
    { id: 'demo-payroll-journal-line-2', journal_id: 'demo-payroll-journal-2083-11', line_no: 2, account_id: 'gla-2330', branch_id: 'BR-KTM', debit: 0, credit: 8_000, memo: 'TDS payable' },
    { id: 'demo-payroll-journal-line-3', journal_id: 'demo-payroll-journal-2083-11', line_no: 3, account_id: 'gla-2340', branch_id: 'BR-KTM', debit: 0, credit: 6_600, memo: 'SSF payable' },
    { id: 'demo-payroll-journal-line-4', journal_id: 'demo-payroll-journal-2083-11', line_no: 4, account_id: 'gla-2320', branch_id: 'BR-KTM', debit: 0, credit: 152_400, memo: 'Net salaries payable' },
  ];

  const payrollRuns: Row[] = [{
    id: 'demo-payroll-run-2083-11', run_no: 'PR-2083-DEMO-11', branch_id: 'BR-KTM',
    period_key: '2026-11', run_date_ad: '2026-11-29', run_date_bs: bsOn('2026-11-29'),
    gross_total: 167_000, tds_total: 8_000, ssf_total: 6_600, advance_total: 0,
    loan_total: 0, net_total: 152_400, status: 'POSTED',
    journal_id: 'demo-payroll-journal-2083-11', posted_by: 'superadmin@example.com',
    is_demo: true, prepared_by: 'superadmin@example.com', prepared_at: '2026-11-28T10:00:00Z',
    approved_by: 'superadmin@example.com', approved_at: '2026-11-28T11:00:00Z',
    statutory_config_id: 'demo-statutory-fy2083', incentive_total: 7_000, arrears_total: 0,
  }];

  const payrollLines: Row[] = [
    {
      id: 'demo-payroll-line-emp-001', run_id: 'demo-payroll-run-2083-11', employee_id: 'demo-emp-001',
      employee_code: 'EMP-001', employee_name: 'Aarav Sharma', period_key: '2026-11',
      gross_amount: 105_000, tds_amount: 6_000, ssf_amount: 6_600, advance_deduction: 0,
      loan_deduction: 0, net_amount: 92_400, salary_id: 'demo-salary-emp-001',
      basic_amount: 60_000, payable_days: 30, lop_days: 0, lop_deduction: 0,
      overtime_hours: 0, overtime_amount: 0, employer_ssf_amount: 12_000,
      incentive_amount: 5_000, arrears_amount: 0, bank_name: 'Nabil Bank', bank_account: '012345678901',
    },
    {
      id: 'demo-payroll-line-emp-002', run_id: 'demo-payroll-run-2083-11', employee_id: 'demo-emp-002',
      employee_code: 'EMP-002', employee_name: 'Nisha Karki', period_key: '2026-11',
      gross_amount: 62_000, tds_amount: 2_000, ssf_amount: 0, advance_deduction: 0,
      loan_deduction: 0, net_amount: 60_000, salary_id: 'demo-salary-emp-002',
      basic_amount: 40_000, payable_days: 30, lop_days: 0, lop_deduction: 0,
      overtime_hours: 0, overtime_amount: 0, employer_ssf_amount: 0,
      incentive_amount: 2_000, arrears_amount: 0, bank_name: 'Nabil Bank', bank_account: '012345678902',
    },
  ];

  const requisitions: Row[] = [{
    id: 'demo-requisition-1', requisition_no: 'REQ-2083-DEMO-001', branch_id: 'BR-KTM',
    title: 'Field Technician', department: 'Field Operations', designation: 'Field Technician',
    employment_type: 'FULL_TIME', openings: 2, status: 'OPEN',
    opened_on_ad: '2026-09-01', opened_on_bs: bsOn('2026-09-01'),
    closes_on_ad: '2026-10-15', closes_on_bs: bsOn('2026-10-15'),
    description: 'Install and maintain demo customer fiber connections in Kathmandu.',
    is_demo: true, created_by: SEED,
  }];
  const candidates: Row[] = [
    {
      id: 'demo-candidate-1', candidate_no: 'CAND-2083-DEMO-001', requisition_id: 'demo-requisition-1',
      branch_id: 'BR-KTM', name: 'Prakash Adhikari', email: 'prakash.adhikari@example.com',
      phone: '9802000001', source: 'REFERRAL', current_employer: 'Demo Fiber Works',
      status: 'OFFER', notes: 'Strong field installation background.',
      resume_file_name: 'Prakash-Adhikari-CV.pdf', resume_mime_type: 'application/pdf',
      resume_byte_size: PDF_BYTES.length, resume_content: PDF_BYTES,
      resume_uploaded_at: '2026-09-05T09:00:00Z', hired_employee_id: null,
      is_demo: true, created_by: SEED,
    },
    {
      id: 'demo-candidate-2', candidate_no: 'CAND-2083-DEMO-002', requisition_id: 'demo-requisition-1',
      branch_id: 'BR-KTM', name: 'Mina Shrestha', email: 'mina.shrestha@example.com',
      phone: '9802000002', source: 'WALK_IN', current_employer: null,
      status: 'NEW', notes: 'Application received at the branch.',
      hired_employee_id: null, is_demo: true, created_by: SEED,
    },
  ];
  const interviews: Row[] = [{
    id: 'demo-interview-1', candidate_id: 'demo-candidate-1', branch_id: 'BR-KTM',
    round_name: 'Technical Round', scheduled_on_ad: '2026-09-18', scheduled_on_bs: bsOn('2026-09-18'),
    interviewer: 'Bikash Thapa', mode: 'VIDEO', status: 'COMPLETED', rating: 4,
    notes: 'Good troubleshooting and customer communication.', is_demo: true, created_by: SEED,
  }];
  const offers: Row[] = [{
    id: 'demo-offer-1', offer_no: 'OFFER-2083-DEMO-001', candidate_id: 'demo-candidate-1',
    branch_id: 'BR-KTM', position_title: 'Field Technician', monthly_salary: 55_000,
    start_date_ad: '2026-12-01', start_date_bs: bsOn('2026-12-01'),
    offered_on_ad: '2026-10-20', offered_on_bs: bsOn('2026-10-20'), status: 'SENT',
    notes: 'Offer sent; awaiting candidate response.', is_demo: true, created_by: SEED,
  }];

  const reviewCycles: Row[] = [{
    id: 'demo-review-cycle-1', cycle_no: 'CYCLE-2083-DEMO-01', branch_id: 'BR-KTM',
    name: 'FY 2083-84 Mid-Year Review', period_start_ad: '2026-07-17', period_start_bs: bsOn('2026-07-17'),
    period_end_ad: '2026-12-31', period_end_bs: bsOn('2026-12-31'), status: 'OPEN',
    instructions: 'Complete self-review, peer feedback and manager rating before sign-off.',
    is_demo: true, created_by: SEED,
  }];
  const goals: Row[] = [
    { id: 'demo-goal-1', goal_no: 'GOAL-DEMO-001', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-001', title: 'Reduce installation rework', description: 'Cut repeat customer visits by improving installation QA.', weight: 60, target_value: 'Under 3% rework', achievement: '2.4% in the review period', status: 'COMPLETED', self_rating: 4, manager_rating: 4, final_rating: 4, is_demo: true, created_by: SEED },
    { id: 'demo-goal-2', goal_no: 'GOAL-DEMO-002', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-001', title: 'Complete fiber safety certification', description: 'Finish the internal safety and splicing certification.', weight: 40, target_value: 'Certified', achievement: 'Certification completed', status: 'COMPLETED', self_rating: 5, manager_rating: 4, final_rating: 4, is_demo: true, created_by: SEED },
    { id: 'demo-goal-3', goal_no: 'GOAL-DEMO-003', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-002', title: 'Improve support first-response time', description: 'Keep first response within the service target.', weight: 70, target_value: 'Under 15 minutes', achievement: '18 minutes average', status: 'IN_PROGRESS', self_rating: 3, manager_rating: 3, final_rating: null, is_demo: true, created_by: SEED },
    { id: 'demo-goal-4', goal_no: 'GOAL-DEMO-004', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-002', title: 'Customer satisfaction score', description: 'Maintain a positive post-installation survey score.', weight: 30, target_value: '90% positive', achievement: '92% positive', status: 'COMPLETED', self_rating: 5, manager_rating: 5, final_rating: 5, is_demo: true, created_by: SEED },
  ];
  const feedback: Row[] = [
    { id: 'demo-feedback-1', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-001', reviewer_employee_id: 'demo-emp-001', relationship: 'SELF', rating: 4, strengths: 'Owns installation quality and mentors juniors.', improvements: 'Document field findings more consistently.', comments: 'Self-review submitted.', is_demo: true, submitted_by: 'aarav.sharma@example.com', submitted_at: '2026-11-05T09:00:00Z' },
    { id: 'demo-feedback-2', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-001', reviewer_employee_id: 'demo-emp-002', relationship: 'PEER', rating: 4, strengths: 'Calm with customers and quick to help support.', improvements: 'Share schedule changes earlier.', comments: 'Peer feedback submitted.', is_demo: true, submitted_by: 'nisha.karki@example.com', submitted_at: '2026-11-05T10:00:00Z' },
    { id: 'demo-feedback-3', cycle_id: 'demo-review-cycle-1', branch_id: 'BR-KTM', employee_id: 'demo-emp-002', reviewer_employee_id: 'demo-emp-001', relationship: 'MANAGER', rating: 5, strengths: 'Excellent customer empathy and follow-through.', improvements: 'Build confidence in technical troubleshooting.', comments: 'Manager feedback submitted.', is_demo: true, submitted_by: 'aarav.sharma@example.com', submitted_at: '2026-11-06T11:00:00Z' },
  ];

  const lifecycleChecklists: Row[] = [
    { id: 'demo-lifecycle-onboarding-1', checklist_no: 'ONB-2083-DEMO-001', employee_id: 'demo-emp-002', branch_id: 'BR-KTM', checklist_type: 'ONBOARDING', status: 'OPEN', effective_date_ad: '2026-08-01', effective_date_bs: bsOn('2026-08-01'), notes: 'Canonical demo onboarding checklist.', is_demo: true, created_by: SEED },
    { id: 'demo-lifecycle-offboarding-1', checklist_no: 'OFF-2083-DEMO-001', employee_id: 'demo-emp-005', branch_id: 'BR-DHN', checklist_type: 'OFFBOARDING', status: 'DRAFT', effective_date_ad: '2026-12-31', effective_date_bs: bsOn('2026-12-31'), notes: 'Canonical demo offboarding checklist.', is_demo: true, created_by: SEED },
  ];
  const lifecycleItems: Row[] = [
    { id: 'demo-lifecycle-item-1', checklist_id: 'demo-lifecycle-onboarding-1', category: 'DOCUMENT', title: 'Collect signed employment contract', description: 'Verify identity and signed contract.', required: true, status: 'DONE', action: 'NONE', asset_id: null, sort_order: 1, completed_by: 'superadmin@example.com', completed_at: '2026-08-01T09:00:00Z', is_demo: true },
    { id: 'demo-lifecycle-item-2', checklist_id: 'demo-lifecycle-onboarding-1', category: 'ASSET', title: 'Issue laptop and access card', description: 'Record the asset assignment in the register.', required: true, status: 'PENDING', action: 'ISSUE_ASSET', asset_id: ktmAsset?.id ?? null, sort_order: 2, is_demo: true },
    { id: 'demo-lifecycle-item-3', checklist_id: 'demo-lifecycle-onboarding-1', category: 'ACCOUNT', title: 'Activate email and HRIS account', description: 'Provision the employee user account.', required: true, status: 'PENDING', action: 'ACTIVATE_ACCOUNT', asset_id: null, sort_order: 3, is_demo: true },
    { id: 'demo-lifecycle-item-4', checklist_id: 'demo-lifecycle-onboarding-1', category: 'ACCESS', title: 'Add to customer support roster', description: 'Confirm the branch support rota.', required: false, status: 'DONE', action: 'NONE', asset_id: null, sort_order: 4, completed_by: 'superadmin@example.com', completed_at: '2026-08-02T10:00:00Z', is_demo: true },
    { id: 'demo-lifecycle-item-5', checklist_id: 'demo-lifecycle-offboarding-1', category: 'ASSET', title: 'Return field toolkit and test gear', description: 'Inspect and return assigned field equipment.', required: true, status: 'PENDING', action: 'RETURN_ASSET', asset_id: dhnAsset?.id ?? null, sort_order: 1, is_demo: true },
    { id: 'demo-lifecycle-item-6', checklist_id: 'demo-lifecycle-offboarding-1', category: 'ACCOUNT', title: 'Deactivate HRIS account', description: 'Disable access on the final working day.', required: true, status: 'PENDING', action: 'DEACTIVATE_ACCOUNT', asset_id: null, sort_order: 2, is_demo: true },
    { id: 'demo-lifecycle-item-7', checklist_id: 'demo-lifecycle-offboarding-1', category: 'DOCUMENT', title: 'Complete exit interview notes', description: 'File the signed exit interview.', required: false, status: 'PENDING', action: 'NONE', asset_id: null, sort_order: 3, is_demo: true },
  ];

  return {
    orgMasters, shifts, leaveTypes, holidays, employees, salaries, salaryComponents,
    leaveBalances, leaveRequests, attendance, documents, statutoryConfigs, tdsSlabs,
    payrollAdjustments, journals, journalLines, payrollRuns, payrollLines, requisitions,
    candidates, interviews, offers, reviewCycles, goals, feedback, lifecycleChecklists,
    lifecycleItems,
  };
}

export async function applyDemoHrFixtures(client: any, dataset: VerificationDataset): Promise<Record<string, number>> {
  const fixtures = buildDemoHrFixtures(dataset);
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoOrgMasters', 'hr_org_masters', ['id', 'kind', 'name', 'code', 'is_active', 'is_demo', 'created_by'], fixtures.orgMasters);
  await put('demoHRShifts', 'hr_shifts', ['id', 'code', 'name', 'start_time', 'end_time', 'grace_minutes', 'is_active', 'is_demo', 'created_by'], fixtures.shifts);
  await put('demoLeaveTypes', 'hr_leave_types', ['id', 'code', 'name', 'annual_quota_days', 'is_paid', 'is_active', 'is_demo', 'created_by'], fixtures.leaveTypes);
  await put('demoHolidays', 'hr_holidays', ['id', 'branch_id', 'holiday_date_ad', 'holiday_date_bs', 'name', 'is_paid', 'notes', 'is_demo', 'created_by'], fixtures.holidays);
  await put('demoEmployees', 'employees', ['id', 'employee_code', 'name', 'branch_id', 'department', 'designation', 'designation_code', 'pan_number', 'ssf_number', 'bank_account', 'bank_name', 'is_active', 'is_demo', 'created_by', 'updated_by', 'employment_type', 'joining_date_ad', 'date_of_birth_ad', 'contract_expiry_ad', 'work_station', 'address', 'personal_contact', 'emergency_contact_person', 'emergency_contact_number', 'internal_email', 'personal_email', 'monthly_salary', 'ssf_eligible', 'user_id'], fixtures.employees);
  await put('demoSalaries', 'hr_employee_salary', ['id', 'employee_id', 'branch_id', 'effective_from', 'ssf_eligible', 'overtime_rate', 'tds_monthly', 'notes', 'is_demo', 'created_by'], fixtures.salaries);
  await put('demoSalaryComponents', 'hr_salary_components', ['id', 'salary_id', 'component_code', 'component_name', 'kind', 'amount', 'is_taxable', 'is_ssf_applicable', 'sort_order'], fixtures.salaryComponents);
  await put('demoLeaveBalances', 'hr_leave_balances', ['id', 'employee_id', 'branch_id', 'leave_type_id', 'balance_year', 'entitlement_days', 'adjustment_days', 'notes', 'is_demo', 'created_by'], fixtures.leaveBalances);
  await put('demoLeaveRequests', 'hr_leave_requests', ['id', 'request_no', 'employee_id', 'branch_id', 'leave_type_id', 'start_date_ad', 'end_date_ad', 'start_date_bs', 'end_date_bs', 'days_count', 'reason', 'status', 'decided_by', 'decided_at', 'decision_note', 'is_demo', 'created_by'], fixtures.leaveRequests);
  await put('demoAttendance', 'hr_attendance', ['id', 'employee_id', 'branch_id', 'attendance_date_ad', 'attendance_date_bs', 'shift_id', 'status', 'check_in_time', 'check_out_time', 'overtime_hours', 'notes', 'source', 'is_demo', 'recorded_by'], fixtures.attendance);
  await put('demoEmployeeDocuments', 'hr_employee_documents', ['id', 'employee_id', 'doc_type', 'original_name', 'mime_type', 'byte_size', 'storage_key', 'expires_on_ad', 'notes', 'content', 'is_demo', 'uploaded_by'], fixtures.documents);
  await put('demoStatutoryConfigs', 'hr_statutory_configs', ['id', 'fiscal_year_id', 'employee_ssf_percent', 'employer_ssf_percent', 'notes', 'is_demo', 'created_by'], fixtures.statutoryConfigs);
  await put('demoTdsSlabs', 'hr_tds_slabs', ['id', 'config_id', 'slab_order', 'lower_bound', 'upper_bound', 'rate_percent'], fixtures.tdsSlabs);
  await put('demoPayrollAdjustments', 'hr_payroll_adjustments', ['id', 'employee_id', 'period_key', 'incentive_amount', 'arrears_amount', 'advance_amount', 'loan_amount', 'notes', 'is_demo', 'created_by'], fixtures.payrollAdjustments);
  await put('demoPayrollJournals', 'gl_journals', ['id', 'journal_no', 'journal_date_ad', 'journal_date_bs', 'fiscal_year_id', 'period_id', 'branch_id', 'source_type', 'source_id', 'memo', 'status', 'posted_at', 'posted_by', 'voucher_type', 'currency', 'exchange_rate', 'is_demo'], fixtures.journals);
  await put('demoPayrollJournalLines', 'gl_journal_lines', ['id', 'journal_id', 'line_no', 'account_id', 'branch_id', 'debit', 'credit', 'memo'], fixtures.journalLines);
  await put('demoPayrollRuns', 'payroll_runs', ['id', 'run_no', 'branch_id', 'period_key', 'run_date_ad', 'run_date_bs', 'gross_total', 'tds_total', 'ssf_total', 'advance_total', 'loan_total', 'net_total', 'status', 'journal_id', 'posted_by', 'is_demo', 'prepared_by', 'prepared_at', 'approved_by', 'approved_at', 'statutory_config_id', 'incentive_total', 'arrears_total'], fixtures.payrollRuns);
  await put('demoPayrollLines', 'payroll_run_lines', ['id', 'run_id', 'employee_id', 'employee_code', 'employee_name', 'period_key', 'gross_amount', 'tds_amount', 'ssf_amount', 'advance_deduction', 'loan_deduction', 'net_amount', 'salary_id', 'basic_amount', 'payable_days', 'lop_days', 'lop_deduction', 'overtime_hours', 'overtime_amount', 'employer_ssf_amount', 'incentive_amount', 'arrears_amount', 'bank_name', 'bank_account'], fixtures.payrollLines);
  await put('demoRequisitions', 'hr_recruitment_requisitions', ['id', 'requisition_no', 'branch_id', 'title', 'department', 'designation', 'employment_type', 'openings', 'status', 'opened_on_ad', 'opened_on_bs', 'closes_on_ad', 'closes_on_bs', 'description', 'is_demo', 'created_by'], fixtures.requisitions);
  await put('demoCandidates', 'hr_recruitment_candidates', ['id', 'candidate_no', 'requisition_id', 'branch_id', 'name', 'email', 'phone', 'source', 'current_employer', 'status', 'notes', 'resume_file_name', 'resume_mime_type', 'resume_byte_size', 'resume_content', 'resume_uploaded_at', 'hired_employee_id', 'is_demo', 'created_by'], fixtures.candidates);
  await put('demoInterviews', 'hr_recruitment_interviews', ['id', 'candidate_id', 'branch_id', 'round_name', 'scheduled_on_ad', 'scheduled_on_bs', 'interviewer', 'mode', 'status', 'rating', 'notes', 'is_demo', 'created_by'], fixtures.interviews);
  await put('demoOffers', 'hr_recruitment_offers', ['id', 'offer_no', 'candidate_id', 'branch_id', 'position_title', 'monthly_salary', 'start_date_ad', 'start_date_bs', 'offered_on_ad', 'offered_on_bs', 'status', 'notes', 'is_demo', 'created_by'], fixtures.offers);
  await put('demoReviewCycles', 'hr_review_cycles', ['id', 'cycle_no', 'branch_id', 'name', 'period_start_ad', 'period_start_bs', 'period_end_ad', 'period_end_bs', 'status', 'instructions', 'is_demo', 'created_by'], fixtures.reviewCycles);
  await put('demoGoals', 'hr_goals', ['id', 'goal_no', 'cycle_id', 'branch_id', 'employee_id', 'title', 'description', 'weight', 'target_value', 'achievement', 'status', 'self_rating', 'manager_rating', 'final_rating', 'is_demo', 'created_by'], fixtures.goals);
  await put('demoFeedback', 'hr_review_feedback', ['id', 'cycle_id', 'branch_id', 'employee_id', 'reviewer_employee_id', 'relationship', 'rating', 'strengths', 'improvements', 'comments', 'is_demo', 'submitted_by', 'submitted_at'], fixtures.feedback);
  await put('demoLifecycleChecklists', 'hr_lifecycle_checklists', ['id', 'checklist_no', 'employee_id', 'branch_id', 'checklist_type', 'status', 'effective_date_ad', 'effective_date_bs', 'notes', 'is_demo', 'created_by'], fixtures.lifecycleChecklists);
  await put('demoLifecycleItems', 'hr_lifecycle_checklist_items', ['id', 'checklist_id', 'category', 'title', 'description', 'required', 'status', 'action', 'asset_id', 'sort_order', 'completed_by', 'completed_at', 'is_demo'], fixtures.lifecycleItems);

  return summary;
}
