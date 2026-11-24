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
import {
  HR_BRANCH_PLAN,
  HR_CLUSTERS,
  HR_DEPARTMENTS,
  HR_DESIGNATIONS,
  HR_GRADES,
  HR_WORK_STATIONS,
} from './hrOrgCatalogue';

const SEED = 'seed:verify';

const EMPLOYEES = [
  {
    id: 'demo-emp-001', code: 'EMP-001', name: 'Aarav Sharma', branchId: 'BR-KTM',
    department: 'Executive Management', designation: 'Chief Executive Officer', designationCode: 'DES-01',
    userId: 'usr-super', salary: 100_000, basic: 60_000, allowance: 40_000,
    ssf: true, joining: '2025-07-17', dob: '1994-05-12', pan: '100100101',
    ssfNo: 'SSF-1001', bank: 'Nabil Bank', account: '012345678901',
    phone: '9801000001', email: 'aarav.sharma@example.com',
  },
  {
    id: 'demo-emp-002', code: 'EMP-002', name: 'Nisha Karki', branchId: 'BR-KTM',
    department: 'Customer Experience & Branches', designation: 'Customer Support Associate', designationCode: 'DES-39',
    userId: 'usr-frontdesk', salary: 60_000, basic: 40_000, allowance: 20_000,
    ssf: false, joining: '2026-04-01', dob: '1997-09-23', pan: '100100102',
    ssfNo: '', bank: 'Nabil Bank', account: '012345678902',
    phone: '9801000002', email: 'nisha.karki@example.com',
  },
  {
    id: 'demo-emp-003', code: 'EMP-003', name: 'Bikash Thapa', branchId: 'BR-PKR',
    department: 'Commercial, Sales & Recovery', designation: 'Sales & Marketing Associate', designationCode: 'DES-22',
    userId: 'usr-pkr-manager', salary: 70_000, basic: 45_000, allowance: 25_000,
    ssf: true, joining: '2025-09-01', dob: '1992-03-18', pan: '100100103',
    ssfNo: 'SSF-1003', bank: 'Global IME Bank', account: '012345678903',
    phone: '9801000003', email: 'bikash.thapa@example.com',
  },
  {
    id: 'demo-emp-004', code: 'EMP-004', name: 'Sita Gurung', branchId: 'BR-BTL',
    department: 'Finance, Admin & Procurement', designation: 'Accountant', designationCode: 'DES-27',
    userId: 'usr-btl-manager', salary: 65_000, basic: 40_000, allowance: 25_000,
    ssf: true, joining: '2025-10-01', dob: '1995-11-07', pan: '100100104',
    ssfNo: 'SSF-1004', bank: 'Nabil Bank', account: '012345678904',
    phone: '9801000004', email: 'sita.gurung@example.com',
  },
  {
    id: 'demo-emp-005', code: 'EMP-005', name: 'Rajan Rai', branchId: 'BR-DHN',
    department: 'Field Fiber Operations', designation: 'Fiber Technician', designationCode: 'DES-14',
    userId: 'usr-dhn-manager', salary: 55_000, basic: 35_000, allowance: 20_000,
    ssf: false, joining: '2026-01-15', dob: '1998-06-30', pan: '100100105',
    ssfNo: '', bank: 'Global IME Bank', account: '012345678905',
    phone: '9801000005', email: 'rajan.rai@example.com',
  },
  {
    // The auditor login (`usr-auditor`) used to hold no employee record at all,
    // so `/api/v1/payslips` answered 404 for it and the audit persona could not
    // open the payroll screens the mission requires it to verify.
    id: 'demo-emp-020', code: 'EMP-020', name: 'Sabina Shrestha', branchId: 'BR-KTM',
    department: 'Executive Management', designation: 'Internal Auditor & Compliance Officer', designationCode: 'DES-41',
    userId: 'usr-auditor', salary: 75_000, basic: 48_000, allowance: 27_000,
    ssf: true, joining: '2025-08-01', dob: '1991-02-14', pan: '100100120',
    ssfNo: 'SSF-1020', bank: 'Nabil Bank', account: '012345678920',
    phone: '9801000020', email: 'sabina.shrestha@example.com',
  },
];

/**
 * Employees that exist only to give the org chart depth. They hold refactored
 * designations from the master sheet; the five canonical payroll employees
 * above keep their payroll/attendance history intact.
 */
const ORG_CHART_EMPLOYEES = [
  { id: 'demo-emp-006', code: 'EMP-006', name: 'Prakash Adhikari', branch: 'BR-KTM', designation: 'Chief Operations Officer', code2: 'DES-02', salary: 178000 },
  { id: 'demo-emp-007', code: 'EMP-007', name: 'Sandesh Bhandari', branch: 'BR-KTM', designation: 'Head of Network & IT', code2: 'DES-04', salary: 115000 },
  { id: 'demo-emp-008', code: 'EMP-008', name: 'Aayush Shrestha', branch: 'BR-KTM', designation: 'Senior Network Engineer', code2: 'DES-47', salary: 60000 },
  { id: 'demo-emp-009', code: 'EMP-009', name: 'Kiran Magar', branch: 'BR-KTM', designation: 'Network Administrator', code2: 'DES-05', salary: 46500 },
  { id: 'demo-emp-010', code: 'EMP-010', name: 'Dipesh Tamang', branch: 'BR-KTM', designation: 'NOC Support Engineer', code2: 'DES-06', salary: 36000 },
  { id: 'demo-emp-011', code: 'EMP-011', name: 'Manisha Joshi', branch: 'BR-KTM', designation: 'Admin & Finance Manager', code2: 'DES-24', salary: 115000 },
  { id: 'demo-emp-012', code: 'EMP-012', name: 'Pooja Rana', branch: 'BR-KTM', designation: 'HR Manager', code2: 'DES-31', salary: 115000 },
  { id: 'demo-emp-013', code: 'EMP-013', name: 'Suman Bhattarai', branch: 'BR-KTM', designation: 'HR & Payroll Officer', code2: 'DES-32', salary: 46500 },
  { id: 'demo-emp-014', code: 'EMP-014', name: 'Rohit Karki', branch: 'BR-KTM', designation: 'Branch Manager', code2: 'DES-34', salary: 82000 },
  { id: 'demo-emp-015', code: 'EMP-015', name: 'Sujan Limbu', branch: 'BR-DHN', designation: 'Branch In-charge', code2: 'DES-50', salary: 60000 },
  { id: 'demo-emp-016', code: 'EMP-016', name: 'Nabin Chaudhary', branch: 'BR-DHN', designation: 'Regional Fiber Supervisor', code2: 'DES-10', salary: 82000 },
  { id: 'demo-emp-017', code: 'EMP-017', name: 'Anjali Pradhan', branch: 'BR-KTM', designation: 'Sales & Recovery Manager', code2: 'DES-17', salary: 115000 },
  { id: 'demo-emp-018', code: 'EMP-018', name: 'Rupa Shrestha', branch: 'BR-KTM', designation: 'Customer Care & Retention Manager', code2: 'DES-45', salary: 82000 },
  { id: 'demo-emp-019', code: 'EMP-019', name: 'Deepak Basnet', branch: 'BR-PKR', designation: 'Area / Cluster Manager', code2: 'DES-33', salary: 115000 },
];

const DESIGNATION_ID_BY_NAME = new Map(
  HR_DESIGNATIONS.map((designation, index) => [designation.name, `demo-designation-${index + 1}`])
);
const DEPARTMENT_ID_BY_NAME = new Map(
  HR_DEPARTMENTS.map((department, index) => [department.name, `demo-department-${index + 1}`])
);
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
  salaryGrades: Row[];
  designationProfiles: Row[];
  departmentProfiles: Row[];
  orgClusters: Row[];
  branchPlan: Row[];
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
  payrollSubledgers: Row[];
  payrollSubledgerEntries: Row[];
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
    ...HR_DEPARTMENTS.map((department, index) => ({
      id: `demo-department-${index + 1}`,
      kind: 'DEPARTMENT',
      name: department.name,
      code: department.code,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
    ...HR_DESIGNATIONS.map((designation, index) => ({
      id: `demo-designation-${index + 1}`,
      kind: 'DESIGNATION',
      name: designation.name,
      code: designation.code,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
    ...HR_WORK_STATIONS.map((station, index) => ({
      id: `demo-workstation-${index + 1}`,
      kind: 'WORK_STATION',
      name: station.name,
      code: station.code,
      is_active: true,
      is_demo: true,
      created_by: SEED,
    })),
  ];

  const salaryGrades: Row[] = HR_GRADES.map((grade) => ({
    grade: grade.grade,
    career_band: grade.careerBand,
    role_tier: grade.roleTier,
    min_salary: grade.min,
    step1_salary: grade.step1,
    step2_salary: grade.step2,
    step3_salary: grade.step3,
    max_salary: grade.max,
    band_spread: Number(((grade.max - grade.min) / grade.min).toFixed(4)),
    promotion_rule: grade.promotionRule,
    is_demo: true,
  }));

  const designationProfiles: Row[] = HR_DESIGNATIONS.map((designation) => ({
    master_id: DESIGNATION_ID_BY_NAME.get(designation.name),
    department_master_id: DEPARTMENT_ID_BY_NAME.get(designation.department) ?? null,
    grade: designation.grade,
    reports_to_master_id: designation.reportsTo
      ? DESIGNATION_ID_BY_NAME.get(designation.reportsTo) ?? null
      : null,
    reports_to_label: designation.reportsToLabel ?? null,
    dotted_line_to: designation.dottedLineTo ?? null,
    branch_scope: designation.branchScope,
    system_role: designation.systemRole,
    responsibilities: designation.responsibilities,
    phase: designation.phase ?? null,
    role_status: designation.roleStatus,
    change_note: designation.changeNote ?? null,
    is_demo: true,
  }));

  const departmentProfiles: Row[] = HR_DEPARTMENTS.map((department, index) => ({
    master_id: `demo-department-${index + 1}`,
    head_designation_master_id: DESIGNATION_ID_BY_NAME.get(department.head) ?? null,
    mandate: department.mandate,
    is_demo: true,
  }));

  const orgClusters: Row[] = HR_CLUSTERS.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    hub: cluster.hub,
    province: cluster.province,
    notes: cluster.notes,
    is_demo: true,
  }));

  const branchPlan: Row[] = HR_BRANCH_PLAN.map((branch) => ({
    code: branch.code,
    name: branch.name,
    cluster_id: branch.clusterId,
    cluster_hub: branch.clusterHub,
    province: branch.province,
    tier: branch.tier,
    head_designation: branch.headDesignation,
    branch_id: null,
    notes: 'Reference plan from the v2 sheet; not an operational branch.',
    is_demo: true,
  }));

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

  // Chart-only employees: no payroll run, attendance or login, just a place in
  // the reporting tree so the refactored designations have holders.
  const orgChartEmployees: Row[] = ORG_CHART_EMPLOYEES.map((employee) => ({
    id: employee.id,
    employee_code: employee.code,
    name: employee.name,
    branch_id: employee.branch,
    department:
      HR_DESIGNATIONS.find((designation) => designation.name === employee.designation)
        ?.department ?? 'Executive Management',
    designation: employee.designation,
    designation_code: employee.code2,
    pan_number: null,
    ssf_number: null,
    bank_account: null,
    bank_name: 'Nabil Bank',
    is_active: true,
    is_demo: true,
    created_by: SEED,
    updated_by: SEED,
    employment_type: 'FULL_TIME',
    joining_date_ad: '2026-01-05',
    date_of_birth_ad: '1990-01-01',
    contract_expiry_ad: null,
    work_station: branchName(employee.branch),
    address: 'Kathmandu, Nepal',
    personal_contact: null,
    emergency_contact_person: 'Demo Family Contact',
    emergency_contact_number: null,
    internal_email: `${employee.code.toLowerCase()}@example.com`,
    personal_email: `${employee.code.toLowerCase()}@example.com`,
    monthly_salary: employee.salary,
    ssf_eligible: true,
    user_id: null,
  }));
  employees.push(...orgChartEmployees);

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
  const payrollPeriodId = payrollPeriod?.id ?? 'vfy-period-fy-2083-2026-11';
  const PAYROLL_DATE = '2026-11-29';
  const PAYROLL_PERIOD_KEY = '2026-11';

  // One November payslip per demo account. The first two were the only ones the
  // earlier fixtures wrote, so the mobile client's payslip screen — and the HR
  // payroll report behind it — answered "No payslips on file" for every other
  // persona the demo offers. Each persona's figures follow the run's own
  // arithmetic: gross = basic + allowance + incentive, SSF = 11% of basic for
  // an SSF-eligible employee, net = gross − TDS − SSF.
  interface PayrollPersona {
    id: string;
    code: string;
    name: string;
    branchId: string;
    basic: number;
    allowance: number;
    incentive: number;
    ssf: boolean;
    tds: number;
    salaryId: string | null;
    bank: string;
    account: string;
  }

  const PAYROLL_PEOPLE: PayrollPersona[] = [
    { id: 'demo-emp-001', code: 'EMP-001', name: 'Aarav Sharma', branchId: 'BR-KTM', basic: 60_000, allowance: 40_000, incentive: 5_000, ssf: true, tds: 6_000, salaryId: 'demo-salary-emp-001', bank: 'Nabil Bank', account: '012345678901' },
    { id: 'demo-emp-002', code: 'EMP-002', name: 'Nisha Karki', branchId: 'BR-KTM', basic: 40_000, allowance: 20_000, incentive: 2_000, ssf: false, tds: 2_000, salaryId: 'demo-salary-emp-002', bank: 'Nabil Bank', account: '012345678902' },
    { id: 'demo-emp-003', code: 'EMP-003', name: 'Bikash Thapa', branchId: 'BR-PKR', basic: 45_000, allowance: 25_000, incentive: 0, ssf: true, tds: 3_500, salaryId: 'demo-salary-emp-003', bank: 'Global IME Bank', account: '012345678903' },
    { id: 'demo-emp-004', code: 'EMP-004', name: 'Sita Gurung', branchId: 'BR-BTL', basic: 40_000, allowance: 25_000, incentive: 0, ssf: true, tds: 3_000, salaryId: 'demo-salary-emp-004', bank: 'Nabil Bank', account: '012345678904' },
    { id: 'demo-emp-005', code: 'EMP-005', name: 'Rajan Rai', branchId: 'BR-DHN', basic: 35_000, allowance: 20_000, incentive: 0, ssf: false, tds: 2_000, salaryId: 'demo-salary-emp-005', bank: 'Global IME Bank', account: '012345678905' },
    { id: 'demo-emp-007', code: 'EMP-007', name: 'Sandesh Bhandari', branchId: 'BR-KTM', basic: 69_000, allowance: 46_000, incentive: 0, ssf: true, tds: 10_000, salaryId: null, bank: 'Nabil Bank', account: '012345678907' },
    { id: 'demo-emp-011', code: 'EMP-011', name: 'Manisha Joshi', branchId: 'BR-KTM', basic: 69_000, allowance: 46_000, incentive: 0, ssf: true, tds: 10_000, salaryId: null, bank: 'Nabil Bank', account: '012345678911' },
    { id: 'demo-emp-014', code: 'EMP-014', name: 'Rohit Karki', branchId: 'BR-KTM', basic: 49_200, allowance: 32_800, incentive: 0, ssf: true, tds: 6_000, salaryId: null, bank: 'Nabil Bank', account: '012345678914' },
    // The auditor's own payslip rides the same posted Kathmandu run: a second
    // run would double-post the branch payroll, and a payslip outside a posted
    // run would not survive the immutable run-line snapshot the screen reads.
    { id: 'demo-emp-020', code: 'EMP-020', name: 'Sabina Shrestha', branchId: 'BR-KTM', basic: 48_000, allowance: 27_000, incentive: 0, ssf: true, tds: 4_000, salaryId: 'demo-salary-emp-020', bank: 'Nabil Bank', account: '012345678920' },
  ];

  const ssfOf = (person: PayrollPersona) => (person.ssf ? Math.round(person.basic * 0.11) : 0);
  const grossOf = (person: PayrollPersona) => person.basic + person.allowance + person.incentive;
  const netOf = (person: PayrollPersona) => grossOf(person) - person.tds - ssfOf(person);

  const payrollBranches = [...new Set(PAYROLL_PEOPLE.map((person) => person.branchId))];
  const branchSuffix = (branchId: string) => branchId.slice(3).toLowerCase();
  // KTM keeps the original ids so the already-posted run and its journal stay
  // the same rows; the three branch cycles are new postings of their own.
  const journalIdFor = (branchId: string) =>
    branchId === 'BR-KTM' ? 'demo-payroll-journal-2083-11' : `demo-payroll-journal-2083-11-${branchSuffix(branchId)}`;
  const runIdFor = (branchId: string) =>
    branchId === 'BR-KTM' ? 'demo-payroll-run-2083-11' : `demo-payroll-run-2083-11-${branchSuffix(branchId)}`;
  const journalNoFor = (branchId: string) =>
    branchId === 'BR-KTM' ? 'PR-DEMO-2083-11' : `PR-DEMO-2083-11-${branchId.slice(3)}`;
  const runNoFor = (branchId: string) =>
    branchId === 'BR-KTM' ? 'PR-2083-DEMO-11' : `PR-2083-DEMO-11-${branchId.slice(3)}`;

  const journals: Row[] = payrollBranches.map((branchId) => ({
    id: journalIdFor(branchId), journal_no: journalNoFor(branchId),
    journal_date_ad: PAYROLL_DATE, journal_date_bs: bsOn(PAYROLL_DATE),
    fiscal_year_id: 'fy-2083', period_id: payrollPeriodId,
    branch_id: branchId, source_type: 'PAYROLL', source_id: runIdFor(branchId),
    memo: `Demo November 2026 payroll posting — ${branchId}`,
    status: 'POSTED', posted_at: `${PAYROLL_DATE}T12:00:00Z`, posted_by: 'superadmin@example.com',
    voucher_type: 'PAYROLL', currency: 'NPR', exchange_rate: 1, is_demo: true,
  }));

  // The salary line is an expense, so it carries its operational cost centre,
  // exactly like the demo ledger lines (COST_CENTER_BY_EXPENSE_ACCOUNT['7110']
  // in verificationDataset.ts). Without it the branch's department preview
  // counts payroll as untagged actuals. The credit legs are liabilities and
  // stay untagged.
  const journalLines: Row[] = payrollBranches.flatMap((branchId) => {
    const people = PAYROLL_PEOPLE.filter((person) => person.branchId === branchId);
    const gross = people.reduce((sum, person) => sum + grossOf(person), 0);
    const tds = people.reduce((sum, person) => sum + person.tds, 0);
    const ssf = people.reduce((sum, person) => sum + ssfOf(person), 0);
    const net = people.reduce((sum, person) => sum + netOf(person), 0);
    const journalId = journalIdFor(branchId);
    const line = (lineNo: number, accountId: string, costCenterId: string | null, debit: number, credit: number, memo: string): Row => ({
      id: `${journalId}-line-${lineNo}`, journal_id: journalId,
      journal_date_ad: PAYROLL_DATE, journal_date_bs: bsOn(PAYROLL_DATE), line_no: lineNo,
      account_id: accountId, branch_id: branchId, cost_center_id: costCenterId,
      debit, credit, memo,
    });
    const rows: Row[] = [line(1, 'gla-7110', 'cc-demo-ops', gross, 0, 'Salaries and wages')];
    let lineNo = 1;
    if (tds > 0) {
      lineNo += 1;
      rows.push(line(lineNo, 'gla-5220', null, 0, tds, 'TDS payable'));
    }
    if (ssf > 0) {
      lineNo += 1;
      rows.push(line(lineNo, 'gla-5250', null, 0, ssf, 'SSF payable'));
    }
    lineNo += 1;
    rows.push(line(lineNo, 'gla-5270', null, 0, net, 'Net salaries payable'));
    return rows;
  });

  const lineIdFor = (branchId: string, accountId: string) =>
    String(
      journalLines.find((row) => row.journal_id === journalIdFor(branchId) && row.account_id === accountId)?.id
    );

  // The payroll journals are inserted directly (each run is already POSTED), so
  // their control lines need the same employee subledger rows the posting
  // service would have written. Without these the GL ties to the trial balance
  // but Salary Payable, TDS and SSF show a false control difference.
  const bookSuffix: Record<string, string> = { 'gla-5270': '20', 'gla-5220': '30', 'gla-5250': '40' };
  const payrollSubledgers: Row[] = PAYROLL_PEOPLE.flatMap((person) => {
    const books: Row[] = [
      { id: `gls-demo-2320-${person.code.toLowerCase()}`, code: `SL-5270-${person.code}`, name: `${person.name} — Salary Payable`, subledger_type: 'EMPLOYEE', main_account_id: 'gla-5270', party_id: person.id, description: `Demo payroll book for ${person.name}.`, is_active: true, is_demo: true },
      { id: `gls-demo-2330-${person.code.toLowerCase()}`, code: `SL-5220-${person.code}`, name: `${person.name} — TDS Payable`, subledger_type: 'EMPLOYEE', main_account_id: 'gla-5220', party_id: person.id, description: `Demo TDS book for ${person.name}.`, is_active: true, is_demo: true },
    ];
    if (person.ssf) {
      books.push({ id: `gls-demo-2340-${person.code.toLowerCase()}`, code: `SL-5250-${person.code}`, name: `${person.name} — SSF Payable`, subledger_type: 'EMPLOYEE', main_account_id: 'gla-5250', party_id: person.id, description: `Demo SSF book for ${person.name}.`, is_active: true, is_demo: true });
    }
    return books;
  });

  const payrollSubledgerEntries: Row[] = PAYROLL_PEOPLE.flatMap((person) => {
    const entry = (accountId: string, credit: number): Row => ({
      id: `gls-demo-payroll-${person.code}-${accountId}`,
      journal_id: journalIdFor(person.branchId), journal_line_id: lineIdFor(person.branchId, accountId),
      account_id: accountId, subledger_id: `gls-demo-${bookSuffix[accountId] === '20' ? '2320' : bookSuffix[accountId] === '30' ? '2330' : '2340'}-${person.code.toLowerCase()}`,
      subledger_type: 'EMPLOYEE', party_id: person.id, party_name: person.name, branch_id: person.branchId,
      entry_date_ad: PAYROLL_DATE, entry_date_bs: bsOn(PAYROLL_DATE), debit: 0, credit,
    });
    const rows: Row[] = [entry('gla-5270', netOf(person))];
    if (person.tds > 0) rows.push(entry('gla-5220', person.tds));
    if (ssfOf(person) > 0) rows.push(entry('gla-5250', ssfOf(person)));
    return rows;
  });

  const payrollRuns: Row[] = payrollBranches.map((branchId) => {
    const people = PAYROLL_PEOPLE.filter((person) => person.branchId === branchId);
    return {
      id: runIdFor(branchId), run_no: runNoFor(branchId), branch_id: branchId,
      period_key: PAYROLL_PERIOD_KEY, run_date_ad: PAYROLL_DATE, run_date_bs: bsOn(PAYROLL_DATE),
      gross_total: people.reduce((sum, person) => sum + grossOf(person), 0),
      tds_total: people.reduce((sum, person) => sum + person.tds, 0),
      ssf_total: people.reduce((sum, person) => sum + ssfOf(person), 0),
      advance_total: 0, loan_total: 0,
      net_total: people.reduce((sum, person) => sum + netOf(person), 0),
      status: 'POSTED', journal_id: journalIdFor(branchId), posted_by: 'superadmin@example.com',
      is_demo: true, prepared_by: 'superadmin@example.com', prepared_at: '2026-11-28T10:00:00Z',
      approved_by: 'superadmin@example.com', approved_at: '2026-11-28T11:00:00Z',
      statutory_config_id: 'demo-statutory-fy2083',
      incentive_total: people.reduce((sum, person) => sum + person.incentive, 0),
      arrears_total: 0,
    };
  });

  const payrollLines: Row[] = PAYROLL_PEOPLE.map((person) => ({
    id: `demo-payroll-line-${person.code.toLowerCase()}`,
    run_id: runIdFor(person.branchId), employee_id: person.id,
    employee_code: person.code, employee_name: person.name, period_key: PAYROLL_PERIOD_KEY,
    gross_amount: grossOf(person), tds_amount: person.tds, ssf_amount: ssfOf(person),
    advance_deduction: 0, loan_deduction: 0, net_amount: netOf(person), salary_id: person.salaryId,
    basic_amount: person.basic, payable_days: 30, lop_days: 0, lop_deduction: 0,
    overtime_hours: 0, overtime_amount: 0,
    employer_ssf_amount: person.ssf ? Math.round(person.basic * 0.2) : 0,
    incentive_amount: person.incentive, arrears_amount: 0,
    bank_name: person.bank, bank_account: person.account,
  }));

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
    orgMasters, salaryGrades, designationProfiles, departmentProfiles, orgClusters, branchPlan,
    shifts, leaveTypes, holidays, employees, salaries, salaryComponents,
    leaveBalances, leaveRequests, attendance, documents, statutoryConfigs, tdsSlabs,
    payrollAdjustments, journals, journalLines, payrollRuns, payrollLines, requisitions,
    candidates, interviews, offers, reviewCycles, goals, feedback, lifecycleChecklists,
    lifecycleItems, payrollSubledgers, payrollSubledgerEntries,
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
  await put('demoSalaryGrades', 'hr_salary_grades', ['grade', 'career_band', 'role_tier', 'min_salary', 'step1_salary', 'step2_salary', 'step3_salary', 'max_salary', 'band_spread', 'promotion_rule', 'is_demo'], fixtures.salaryGrades);
  await put('demoOrgClusters', 'hr_org_clusters', ['id', 'name', 'hub', 'province', 'notes', 'is_demo'], fixtures.orgClusters);
  await put('demoBranchPlan', 'hr_branch_plan', ['code', 'name', 'cluster_id', 'cluster_hub', 'province', 'tier', 'head_designation', 'branch_id', 'notes', 'is_demo'], fixtures.branchPlan);
  await put('demoDepartmentProfiles', 'hr_department_profiles', ['master_id', 'head_designation_master_id', 'mandate', 'is_demo'], fixtures.departmentProfiles);
  await put('demoDesignationProfiles', 'hr_designation_profiles', ['master_id', 'department_master_id', 'grade', 'reports_to_master_id', 'reports_to_label', 'dotted_line_to', 'branch_scope', 'system_role', 'responsibilities', 'phase', 'role_status', 'change_note', 'is_demo'], fixtures.designationProfiles);
  await put('demoHRShifts', 'hr_shifts', ['id', 'code', 'name', 'start_time', 'end_time', 'grace_minutes', 'is_active', 'is_demo', 'created_by'], fixtures.shifts);
  await put('demoLeaveTypes', 'hr_leave_types', ['id', 'code', 'name', 'annual_quota_days', 'is_paid', 'is_active', 'is_demo', 'created_by'], fixtures.leaveTypes);
  await put('demoHolidays', 'hr_holidays', ['id', 'branch_id', 'holiday_date_ad', 'holiday_date_bs', 'name', 'is_paid', 'notes', 'is_demo', 'created_by'], fixtures.holidays);
  await put('demoEmployees', 'employees', ['id', 'employee_code', 'name', 'branch_id', 'department', 'designation', 'designation_code', 'pan_number', 'ssf_number', 'bank_account', 'bank_name', 'is_active', 'is_demo', 'created_by', 'updated_by', 'employment_type', 'joining_date_ad', 'date_of_birth_ad', 'contract_expiry_ad', 'work_station', 'address', 'personal_contact', 'emergency_contact_person', 'emergency_contact_number', 'internal_email', 'personal_email', 'monthly_salary', 'ssf_eligible', 'user_id'], fixtures.employees);

  // Link the seeded rows to the catalogue they were written from. The schema
  // backfills existing employees, but a seed inserts after that pass, so the
  // same idempotent resolution runs here — the Org Masters employee panel and
  // headcounts count through these ids.
  await client.query(`UPDATE employees e SET department_id = (
    SELECT m.id FROM hr_org_masters m
    WHERE m.kind = 'DEPARTMENT' AND lower(btrim(m.name)) = lower(btrim(e.department))
    ORDER BY m.id LIMIT 1)
    WHERE e.department_id IS NULL AND e.department IS NOT NULL`);
  await client.query(`UPDATE employees e SET designation_id = (
    SELECT m.id FROM hr_org_masters m
    WHERE m.kind = 'DESIGNATION'
      AND (lower(btrim(m.name)) = lower(btrim(e.designation))
        OR (m.code IS NOT NULL AND e.designation_code IS NOT NULL
          AND lower(btrim(m.code)) = lower(btrim(e.designation_code))))
    ORDER BY (lower(btrim(m.name)) = lower(btrim(e.designation))) DESC, m.id LIMIT 1)
    WHERE e.designation_id IS NULL AND (e.designation IS NOT NULL OR e.designation_code IS NOT NULL)`);
  await client.query(`UPDATE employees e SET workstation_id = (
    SELECT m.id FROM hr_org_masters m
    WHERE m.kind = 'WORK_STATION' AND lower(btrim(m.name)) = lower(btrim(e.work_station))
    ORDER BY m.id LIMIT 1)
    WHERE e.workstation_id IS NULL AND e.work_station IS NOT NULL`);

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
  await put('demoPayrollJournalLines', 'gl_journal_lines', ['id', 'journal_id', 'journal_date_ad', 'journal_date_bs', 'line_no', 'account_id', 'branch_id', 'cost_center_id', 'debit', 'credit', 'memo'], fixtures.journalLines);
  await put('demoPayrollSubledgers', 'gl_subledgers', ['id', 'code', 'name', 'subledger_type', 'main_account_id', 'party_id', 'description', 'is_active', 'is_demo'], fixtures.payrollSubledgers);
  await put('demoPayrollSubledgerEntries', 'gl_subledger_entries', ['id', 'journal_id', 'journal_line_id', 'account_id', 'subledger_id', 'subledger_type', 'party_id', 'party_name', 'branch_id', 'entry_date_ad', 'entry_date_bs', 'debit', 'credit'], fixtures.payrollSubledgerEntries);
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
