/**
 * The HR organisation catalogue from `Corporate_Designations_Salaries_JDs_v2`.
 *
 * This is the single source the demo seed writes from: seven departments, the
 * G1-G10 grading matrix, 51 designations with their reporting line and job
 * description, the four regional clusters and the 24-branch operating plan.
 * Designation salary bands are not stored per row — the workbook derives them
 * from the grade, so the profile only carries the grade and the grade carries
 * the band. Keeping the band in one place is what stops the two drifting.
 *
 * Reporting lines point at designation names, not at employees: an employee
 * inherits the line of the designation they hold, and a designation with no
 * holder still appears on the org chart as a vacant post.
 */

export interface HrGradeSeed {
  grade: string;
  careerBand: string;
  roleTier: string;
  min: number;
  step1: number;
  step2: number;
  step3: number;
  max: number;
  promotionRule: string;
}

export interface HrDepartmentSeed {
  code: string;
  name: string;
  head: string;
  mandate: string;
}

export interface HrDesignationSeed {
  code: string;
  name: string;
  department: string;
  grade: string;
  /** Designation this post reports to; null means the root (Board). */
  reportsTo: string | null;
  /** Shown instead of a post when the reporting line leaves the company. */
  reportsToLabel?: string;
  dottedLineTo?: string;
  branchScope: string;
  systemRole: string;
  responsibilities: string;
  phase?: string;
  roleStatus: string;
  changeNote?: string;
}

export interface HrClusterSeed {
  id: string;
  name: string;
  hub: string;
  province: string;
  notes: string;
}

export interface HrBranchPlanSeed {
  code: string;
  name: string;
  clusterId: string;
  clusterHub: string;
  province: string;
  tier: string;
  headDesignation: string;
}

export const HR_GRADES: HrGradeSeed[] = [
  {
    grade: 'G10', careerBand: 'Executive', roleTier: 'Chief Executive Officer (CEO)',
    min: 200000, step1: 225000, step2: 255000, step3: 285000, max: 320000,
    promotionRule: 'Annual Board KPI & EBITDA evaluation',
  },
  {
    grade: 'G9', careerBand: 'Executive', roleTier: 'Chief Operating Officer (COO)',
    min: 140000, step1: 158000, step2: 178000, step3: 200000, max: 225000,
    promotionRule: '3+ years executive tenure & Board review',
  },
  {
    grade: 'G8', careerBand: 'Senior Management',
    roleTier: 'Department Heads / Area Cluster Managers / Consultant',
    min: 90000, step1: 102000, step2: 115000, step3: 130000, max: 145000,
    promotionRule: '3 annual appraisals before C-Suite track',
  },
  {
    grade: 'G7', careerBand: 'Middle Management',
    roleTier: 'Branch Managers (Tier 1-2) / Regional Fiber Supervisors / Senior Accountant / Customer Care & Retention Manager',
    min: 65000, step1: 73000, step2: 82000, step3: 92000, max: 102000,
    promotionRule: '2-3 annual appraisals + regional/domain KPI',
  },
  {
    grade: 'G6', careerBand: 'Supervisory / Lead',
    roleTier: 'Branch In-charge / Asst. Branch Manager / Fiber Team Coordinator / Sr. Network Engineer / Finance Officer / Internal Auditor / IT & Billing Admin / FTTH Planning Engineer / Branch Ops Coordinator / Sr. Marketing',
    min: 48000, step1: 54000, step2: 60000, step3: 67000, max: 75000,
    promotionRule: '2-3 annual appraisals before G7 promotion',
  },
  {
    grade: 'G5', careerBand: 'Senior Officer / Coordinator',
    roleTier: 'Coordinators / Sr. Fiber & Electrical Techs / MIS / Network Admin / HR, Procurement & Safety Officers / Corporate Sales / Sr. Front Desk',
    min: 37000, step1: 41500, step2: 46500, step3: 52000, max: 58000,
    promotionRule: '2-3 annual appraisals before G6 supervisory role',
  },
  {
    grade: 'G4', careerBand: 'Officer / Certified Tech',
    roleTier: 'Accountant / Fiber, Wireless Techs / NOC Eng / Network Ops Coordinator / Inventory Mgr / Marketing Exec',
    min: 29000, step1: 32500, step2: 36000, step3: 40000, max: 44500,
    promotionRule: '2-3 annual appraisals + skill certification before G5',
  },
  {
    grade: 'G3', careerBand: 'Operational Associate',
    roleTier: 'Sales, Support, Front Desk, Recovery, Accounting, HR & Marketing Associates',
    min: 23500, step1: 26000, step2: 28800, step3: 31800, max: 35000,
    promotionRule: '2-3 annual appraisals before Officer/Senior track (G4/G5)',
  },
  {
    grade: 'G2', careerBand: 'Junior / Trainee',
    roleTier: 'Junior Fiber Technician / Junior Support / Probationary Technical Trainees',
    min: 20000, step1: 22000, step2: 24000, step3: 26200, max: 28500,
    promotionRule: '1-2 appraisals before confirmation to G3/G4',
  },
  {
    grade: 'G1', careerBand: 'Entry / Field Support',
    roleTier: 'Assistant Fiber Technician / Office Assistant',
    min: 19550, step1: 20000, step2: 21000, step3: 22500, max: 24000,
    promotionRule: '2-3 annual appraisals + technical skill test to move to G2/G3/G4',
  },
];

export const HR_DEPARTMENTS: HrDepartmentSeed[] = [
  {
    code: 'DEPT-EXEC',
    name: 'Executive Management',
    head: 'Chief Executive Officer',
    mandate: 'Corporate strategy, NTA regulatory compliance, P&L governance, internal audit and compliance, MIS reporting and executive oversight.',
  },
  {
    code: 'DEPT-NET',
    name: 'Core Network & IT',
    head: 'Head of Network & IT',
    mandate: 'Core routing, BGP upstream, NOC 24/7 monitoring, OLT/BRAS infrastructure, IT systems, billing/ERP and user roles.',
  },
  {
    code: 'DEPT-FLD',
    name: 'Field Fiber Operations',
    head: 'Operations Manager (Field & SLA)',
    mandate: 'Last-mile FTTH deployment, backbone splicing, POP power/electrical maintenance, wireless links, project planning and field safety.',
  },
  {
    code: 'DEPT-COM',
    name: 'Commercial, Sales & Recovery',
    head: 'Sales & Recovery Manager',
    mandate: 'Residential and B2B corporate sales, brand marketing and overdue billing recovery; judged on net adds after churn plus collections.',
  },
  {
    code: 'DEPT-FIN',
    name: 'Finance, Admin & Procurement',
    head: 'Admin & Finance Manager',
    mandate: 'General ledger, tax and audit, vendor procurement, central warehouse/ONU inventory, and facility administration.',
  },
  {
    code: 'DEPT-HR',
    name: 'Human Resources',
    head: 'HR Manager',
    mandate: 'Independent employee PII management, recruitment, attendance and leave, payroll preparation, SSF/CIT and training coordination.',
  },
  {
    code: 'DEPT-CXB',
    name: 'Customer Experience & Branches',
    head: 'Head of Branch & Customer Operations',
    mandate: 'Regional cluster supervision across 24 branches, branch operations monitoring, front desk, cash collection, call centre and customer retention.',
  },
];

export const HR_DESIGNATIONS: HrDesignationSeed[] = [
  {
    code: 'DES-01', name: 'Chief Executive Officer', department: 'Executive Management', grade: 'G10',
    reportsTo: null, reportsToLabel: 'Board of Directors', branchScope: 'All Branches (24)', systemRole: 'SUPER_ADMIN',
    roleStatus: 'Refactored',
    responsibilities: 'Sets overall corporate vision, strategic growth across provinces, P&L ownership, board reporting and key regulatory partnerships.',
    changeNote: 'No change. Board of Directors now shown on the chart.',
  },
  {
    code: 'DES-02', name: 'Chief Operations Officer', department: 'Executive Management', grade: 'G9',
    reportsTo: 'Chief Executive Officer', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN', phase: 'Phase 2',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Directs daily company-wide operations through four department heads (Network & IT, Field & SLA, Commercial, Branch & Customer Operations) covering all 24 branches.',
    changeNote: 'Direct reports cut from about 10 to 4 by adding a Head of Branch & Customer Operations.',
  },
  {
    code: 'DES-03', name: 'Legal & Strategic Consultant', department: 'Executive Management', grade: 'G8',
    reportsTo: null, reportsToLabel: 'Chief Executive Officer (Dotted)', branchScope: 'Head Office', systemRole: 'AUDITOR_VIEWER',
    roleStatus: 'Refactored',
    responsibilities: 'Advises executive leadership on NTA telecom licensing, corporate law, taxation, labour compliance and contract governance.',
    changeNote: 'Band kept for reference. Use a retainer contract if not a full-time employee (confirm).',
  },
  {
    code: 'DES-41', name: 'Internal Auditor & Compliance Officer', department: 'Executive Management', grade: 'G6',
    reportsTo: null, reportsToLabel: 'Board Audit Committee (admin: CEO)', branchScope: 'All Branches (24)', systemRole: 'AUDITOR_VIEWER', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Independently audits branch cash, deposits, inventory and billing adjustments; tests internal controls; tracks NTA, tax, SSF and labour-law compliance; reports findings to the Board Audit Committee.',
    changeNote: 'NEW. Independent control function. Consider G7 as the team grows.',
  },
  {
    code: 'DES-08', name: 'MIS & Data Analyst', department: 'Executive Management', grade: 'G5',
    reportsTo: 'Chief Executive Officer', dottedLineTo: 'Chief Operations Officer', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Builds operational KPI dashboards tracking subscriber churn, ARPU, outage MTTR and branch sales performance.',
    changeNote: 'Moved to the CEO office (was under the COO) and added to the chart.',
  },
  {
    code: 'DES-04', name: 'Head of Network & IT', department: 'Core Network & IT', grade: 'G8',
    reportsTo: 'Chief Operations Officer', branchScope: 'All Branches (24)', systemRole: 'NETWORK_ADMIN', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Heads the Network & IT department: architects core BGP routing, upstream peering, BRAS/OLT core servers, cybersecurity policy and 99.9% backbone uptime; manages the NOC and IT systems teams.',
    changeNote: 'G7 to G8 to match every other department head. Title shortened.',
  },
  {
    code: 'DES-47', name: 'Senior Network Engineer', department: 'Core Network & IT', grade: 'G6',
    reportsTo: 'Head of Network & IT', branchScope: 'Head Office / Core', systemRole: 'NETWORK_ADMIN', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Leads L3 troubleshooting, change control, backbone/POP design reviews and capacity planning; deputises for the Head of Network & IT; supervises Network Administrators and the NOC.',
    changeNote: 'NEW. Closes the G5 to G7 gap and removes the single point of failure.',
  },
  {
    code: 'DES-05', name: 'Network Administrator', department: 'Core Network & IT', grade: 'G5',
    reportsTo: 'Senior Network Engineer', branchScope: 'Head Office / Core', systemRole: 'NETWORK_ADMIN', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Configures OLTs, VLANs, IP pools, radius authentication and core routers; handles L3 network escalations.',
    changeNote: 'Now reports to the new Senior Network Engineer (G6), closing the G5 to G7 gap.',
  },
  {
    code: 'DES-06', name: 'NOC Support Engineer', department: 'Core Network & IT', grade: 'G4',
    reportsTo: 'Network Administrator', branchScope: 'Head Office (24/7 Shift)', systemRole: 'NETWORK_ADMIN',
    roleStatus: 'NEW (Recommended)',
    responsibilities: 'Monitors 24/7 network health dashboards, isolates fiber cuts vs. router faults, performs L2 remote OLT checks and dispatches field alerts.',
    changeNote: 'Plan 5 or more engineers to cover 24/7 shifts (headcount to confirm).',
  },
  {
    code: 'DES-07', name: 'Network Operations Coordinator', department: 'Core Network & IT', grade: 'G4',
    reportsTo: 'Network Administrator', branchScope: 'All Branches (24)', systemRole: 'NETWORK_ADMIN', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Schedules planned maintenance windows, sends outage SMS/notifications to customers and tracks SLA resolution times.',
    changeNote: 'Reports to Network Administrator, matching the "NOC Coordinator" box on the v1 chart.',
  },
  {
    code: 'DES-42', name: 'IT Systems & Billing (ERP) Administrator', department: 'Core Network & IT', grade: 'G6',
    reportsTo: 'Head of Network & IT', branchScope: 'All Branches (24)', systemRole: 'SYSTEM_ADMIN', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Owns the billing/ERP platform, RADIUS and user-role administration, data backups, branch software access and vendor support; integrates provisioning with the Network team.',
    changeNote: 'NEW. Nobody owned billing, ERP or user roles.',
  },
  {
    code: 'DES-09', name: 'Operations Manager (Field & SLA)', department: 'Field Fiber Operations', grade: 'G8',
    reportsTo: 'Chief Operations Officer', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN',
    roleStatus: 'Refactored',
    responsibilities: 'Leads nationwide FTTH expansion, backbone fiber rollouts, field SLA adherence and regional technical resource allocation; manages Planning and Safety roles.',
    changeNote: 'No grade change. Now manages the Planning and Safety roles.',
  },
  {
    code: 'DES-43', name: 'FTTH Planning & Project Engineer', department: 'Field Fiber Operations', grade: 'G6',
    reportsTo: 'Operations Manager (Field & SLA)', branchScope: 'All Branches (project-based)', systemRole: 'PROJECT_PLANNER', phase: 'Phase 2',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Surveys and designs FTTH/backbone routes, prepares BOQs and rollout schedules, manages contractors and keeps as-built records for expansion projects.',
    changeNote: 'NEW. Expansion rested on the Operations Manager alone.',
  },
  {
    code: 'DES-46', name: 'Field Safety & Training Officer', department: 'Field Fiber Operations', grade: 'G5',
    reportsTo: 'Operations Manager (Field & SLA)', dottedLineTo: 'HR Manager', branchScope: 'All Branches (24)', systemRole: 'FIELD_STAFF', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Runs pole-climbing, working-at-height, electrical and trenching safety training; audits crews and PPE; investigates incidents; keeps technician certification records used for G4 to G5 skill tests.',
    changeNote: 'NEW. Field work carries real injury risk.',
  },
  {
    code: 'DES-10', name: 'Regional Fiber Supervisor', department: 'Field Fiber Operations', grade: 'G7',
    reportsTo: 'Operations Manager (Field & SLA)', dottedLineTo: 'Area / Cluster Manager', branchScope: 'Assigned Cluster (5-7 Branches)', systemRole: 'REGIONAL_SUPERVISOR', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Supervises backbone splicing, POP site audits and technical quality across one regional cluster (one supervisor per cluster); takes local priorities from the Area Manager through a dotted line.',
    changeNote: 'G6 to G7. Title now matches the chart.',
  },
  {
    code: 'DES-11', name: 'Fiber Team Coordinator', department: 'Field Fiber Operations', grade: 'G6',
    reportsTo: 'Regional Fiber Supervisor', dottedLineTo: 'Branch Manager', branchScope: 'Hub / Cluster Branches', systemRole: 'BRANCH_SUPERVISOR', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Assigns daily installation and maintenance tickets to fiber crews, tracks optical power loss metrics and verifies job completion.',
    changeNote: 'G5 to G6 so a coordinator no longer shares a grade with the Sr. Fiber Technicians they supervise.',
  },
  {
    code: 'DES-12', name: 'Senior Fiber Technician', department: 'Field Fiber Operations', grade: 'G5',
    reportsTo: 'Fiber Team Coordinator', dottedLineTo: 'Branch Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Performs complex core/distribution splicing, OTDR fault tracing, splitter box installations and mentors junior technicians.',
    changeNote: 'Dotted line to the branch added.',
  },
  {
    code: 'DES-13', name: 'Senior Electrical Technician', department: 'Field Fiber Operations', grade: 'G5',
    reportsTo: 'Regional Fiber Supervisor', branchScope: 'Assigned Cluster', systemRole: 'FIELD_STAFF', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Maintains POP site rectifiers, lithium/lead-acid battery banks, earthing systems, generators and surge protection.',
    changeNote: 'G4 to G5 so "Senior" means G5 across fiber and electrical. Reports to the cluster supervisor.',
  },
  {
    code: 'DES-14', name: 'Fiber Technician', department: 'Field Fiber Operations', grade: 'G4',
    reportsTo: 'Fiber Team Coordinator', dottedLineTo: 'Branch Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Installs FTTH drop cables, splices customer termination boxes, configures home ONU/Wi-Fi routers and resolves physical line drops.',
    changeNote: 'Dotted line to the branch added.',
  },
  {
    code: 'DES-15', name: 'Wireless Technician', department: 'Field Fiber Operations', grade: 'G4',
    reportsTo: 'Fiber Team Coordinator', dottedLineTo: 'Branch Manager', branchScope: 'Assigned Cluster', systemRole: 'FIELD_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Installs and aligns P2P/P2MP wireless radios, towers and mast earthing for corporate or remote rural links.',
    changeNote: 'Dotted line to the branch added.',
  },
  {
    code: 'DES-49', name: 'Junior Fiber Technician', department: 'Field Fiber Operations', grade: 'G2',
    reportsTo: 'Senior Fiber Technician', dottedLineTo: 'Branch Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF', phase: 'Phase 2',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Trainee technician: drop-cable installs and ONU set-up under supervision while completing the skill test required for Fiber Technician.',
    changeNote: 'NEW. First use of G2; closes the G1 to G4 gap.',
  },
  {
    code: 'DES-16', name: 'Assistant Fiber Technician', department: 'Field Fiber Operations', grade: 'G1',
    reportsTo: 'Senior Fiber Technician', dottedLineTo: 'Branch Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Assists senior technicians with ladder safety, pole cabling, cable pulling, trenching and basic tool handling.',
    changeNote: 'Reporting line made explicit (mentor Sr. Fiber Tech).',
  },
  {
    code: 'DES-17', name: 'Sales & Recovery Manager', department: 'Commercial, Sales & Recovery', grade: 'G8',
    reportsTo: 'Chief Operations Officer', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN',
    roleStatus: 'Refactored',
    responsibilities: 'Drives company-wide subscriber acquisition, corporate B2B deals, brand campaigns and overdue receivables recovery; sales is judged on net adds after churn plus collection rate.',
    changeNote: 'KPI wording added: net adds after churn plus collections.',
  },
  {
    code: 'DES-18', name: 'Senior Marketing Executive', department: 'Commercial, Sales & Recovery', grade: 'G6',
    reportsTo: 'Sales & Recovery Manager', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN',
    roleStatus: 'Refactored',
    responsibilities: 'Leads digital marketing, seasonal festival offers, brand positioning and regional promotional budgets.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-19', name: 'Corporate / SME Sales Executive', department: 'Commercial, Sales & Recovery', grade: 'G5',
    reportsTo: 'Sales & Recovery Manager', branchScope: 'Major Hubs (Itahari, KTM, PKR, BTM)', systemRole: 'BRANCH_SUPERVISOR',
    roleStatus: 'NEW (Recommended)',
    responsibilities: 'Acquires high-value B2B clients (banks, schools, hospitals, offices) for dedicated leased lines (ILL) and enterprise packages.',
  },
  {
    code: 'DES-20', name: 'Marketing Executive', department: 'Commercial, Sales & Recovery', grade: 'G4',
    reportsTo: 'Senior Marketing Executive', branchScope: 'Assigned Cluster', systemRole: 'FIELD_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Executes local canopy activations, dealer branding, school/community sponsorships and competitor benchmarking.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-21', name: 'Marketing Coordinator', department: 'Commercial, Sales & Recovery', grade: 'G3',
    reportsTo: 'Senior Marketing Executive', branchScope: 'Head Office', systemRole: 'HEAD_OFFICE_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Manages social media calendars, graphic design vendor coordination, promotional leaflet distribution and campaign lead tracking.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-22', name: 'Sales & Marketing Associate', department: 'Commercial, Sales & Recovery', grade: 'G3',
    reportsTo: 'Branch Manager', dottedLineTo: 'Sales & Recovery Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Conducts door-to-door residential FTTH sales, local shop signups, package upgrades and new connection form collection.',
    changeNote: 'Solid line to the branch head; dotted line to Sales & Recovery Manager for KPIs.',
  },
  {
    code: 'DES-23', name: 'Recovery Associate', department: 'Commercial, Sales & Recovery', grade: 'G3',
    reportsTo: 'Branch Manager', dottedLineTo: 'Sales & Recovery Manager', branchScope: 'Assigned Branch', systemRole: 'FIELD_STAFF', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Follows up on overdue subscriber invoices via calls and field visits, collects renewals and recovers ONU devices from churned users.',
    changeNote: 'Solid line to the branch head; dotted line to Sales & Recovery Manager for KPIs.',
  },
  {
    code: 'DES-24', name: 'Admin & Finance Manager', department: 'Finance, Admin & Procurement', grade: 'G8',
    reportsTo: 'Chief Executive Officer', branchScope: 'All Branches (24)', systemRole: 'FINANCE_MANAGER',
    roleStatus: 'Refactored',
    responsibilities: 'Owns financial statements, budgeting, tax filings (VAT/TDS), banking facilities, payroll GL posting and corporate administration.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-25', name: 'Senior Accountant', department: 'Finance, Admin & Procurement', grade: 'G7',
    reportsTo: 'Admin & Finance Manager', branchScope: 'Head Office', systemRole: 'FINANCE_MANAGER',
    roleStatus: 'Refactored',
    responsibilities: 'Reviews general ledger entries, prepares statutory audit schedules, reconciles inter-branch accounts and oversees tax compliance.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-48', name: 'Finance Officer (Accounts & Tax)', department: 'Finance, Admin & Procurement', grade: 'G6',
    reportsTo: 'Senior Accountant', branchScope: 'Head Office', systemRole: 'FINANCE_STAFF', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Prepares VAT/TDS returns, month-end close and statutory schedules, reviews bank reconciliations and supervises Accountants and Accounting Associates.',
    changeNote: 'NEW. Closes the G4 to G7 gap in Finance.',
  },
  {
    code: 'DES-27', name: 'Accountant', department: 'Finance, Admin & Procurement', grade: 'G4',
    reportsTo: 'Finance Officer (Accounts & Tax)', branchScope: 'Head Office / Cluster', systemRole: 'FINANCE_STAFF', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Records daily vouchers, verifies branch cash deposits against billing software, processes vendor payouts and reconciles bank statements.',
    changeNote: 'Reports to the new Finance Officer (G6), closing the G4 to G7 gap.',
  },
  {
    code: 'DES-29', name: 'Accounting Associate', department: 'Finance, Admin & Procurement', grade: 'G3',
    reportsTo: 'Accountant', branchScope: 'Head Office', systemRole: 'FINANCE_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Assists with invoice filing, petty cash verification, TDS certificate generation and daily receipt entry.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-26', name: 'Procurement & Logistics Officer', department: 'Finance, Admin & Procurement', grade: 'G5',
    reportsTo: 'Admin & Finance Manager', branchScope: 'Head Office / Central Store', systemRole: 'FINANCE_STAFF',
    roleStatus: 'NEW (Recommended)',
    responsibilities: 'Sources optical fiber, ONUs, routers and office supplies; negotiates vendor quotes, issues Purchase Orders and tracks imports.',
  },
  {
    code: 'DES-28', name: 'Inventory & Warehouse Manager', department: 'Finance, Admin & Procurement', grade: 'G4',
    reportsTo: 'Admin & Finance Manager', branchScope: 'Central Warehouse & Branches', systemRole: 'INVENTORY_MANAGER',
    roleStatus: 'Refactored',
    responsibilities: 'Manages central stock issuance, serial-number tracking of ONUs/routers, minimum stock alerts and physical audits across 24 branches.',
    changeNote: 'Kept separate from Procurement for segregation of duties.',
  },
  {
    code: 'DES-30', name: 'Office Assistant', department: 'Finance, Admin & Procurement', grade: 'G1',
    reportsTo: 'Admin & Finance Manager', branchScope: 'Head Office / Branches', systemRole: 'GENERAL_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Handles office cleanliness, guest hospitality, bank/courier runs, document filing and local utility errands.',
    changeNote: 'Grade unchanged. G1 pay floor raised in the Grading Matrix.',
  },
  {
    code: 'DES-31', name: 'HR Manager', department: 'Human Resources', grade: 'G8',
    reportsTo: 'Chief Executive Officer', branchScope: 'All Branches (24)', systemRole: 'HR_MANAGER',
    roleStatus: 'Refactored',
    responsibilities: 'Leads talent acquisition, compensation grading, annual appraisal cycles, labour law compliance and employee relations across all branches.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-32', name: 'HR & Payroll Officer', department: 'Human Resources', grade: 'G5',
    reportsTo: 'HR Manager', branchScope: 'All Branches (24)', systemRole: 'HR_STAFF',
    roleStatus: 'NEW (Recommended)',
    responsibilities: 'Maintains employee PII records, tracks biometric attendance/leave across 24 branches, prepares monthly payroll sheets and files SSF/CIT.',
  },
  {
    code: 'DES-51', name: 'HR Associate', department: 'Human Resources', grade: 'G3',
    reportsTo: 'HR & Payroll Officer', branchScope: 'Head Office', systemRole: 'HR_STAFF', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Maintains attendance and leave records, employee files and onboarding documents; assists payroll data entry and SSF/CIT filings.',
    changeNote: 'NEW. Was on the v1 chart but missing from the 40 designations.',
  },
  {
    code: 'DES-44', name: 'Head of Branch & Customer Operations', department: 'Customer Experience & Branches', grade: 'G8',
    reportsTo: 'Chief Operations Officer', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN', phase: 'Phase 2',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Leads the four Area Managers, branch operations monitoring and the Customer Care function; owns branch revenue, service quality, churn and customer-experience KPIs.',
    changeNote: 'NEW. Gives the Customer Experience & Branches department a single head and reduces the COO span.',
  },
  {
    code: 'DES-33', name: 'Area / Cluster Manager', department: 'Customer Experience & Branches', grade: 'G8',
    reportsTo: 'Head of Branch & Customer Operations', branchScope: 'Assigned Cluster (5-7 Branches)', systemRole: 'REGIONAL_SUPERVISOR', phase: 'Phase 2',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Supervises 5-7 Branch Managers / In-charges in a regional cluster; drives regional revenue targets, branch audits and local escalation resolution.',
    changeNote: 'Reports to the new Head of Branch & Customer Operations. Clusters rebalanced to 5-7 branches each.',
  },
  {
    code: 'DES-34', name: 'Branch Manager', department: 'Customer Experience & Branches', grade: 'G7',
    reportsTo: 'Area / Cluster Manager', branchScope: 'Tier 1-2 Branches (8)', systemRole: 'BRANCH_MANAGER', phase: 'Phase 1',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Owns branch P&L for Tier 1-2 branches, supervises local sales, recovery, front desk and the branch dotted line to field crews, safeguards branch inventory/cash and ensures local customer retention.',
    changeNote: 'Now only for the 8 Tier 1-2 branches. Tier 3 branches get a Branch In-charge (G6).',
  },
  {
    code: 'DES-50', name: 'Branch In-charge', department: 'Customer Experience & Branches', grade: 'G6',
    reportsTo: 'Area / Cluster Manager', branchScope: 'Tier 3 Branches (16)', systemRole: 'BRANCH_MANAGER', phase: 'Phase 1',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Runs a Tier 3 branch: daily sales, front desk, cash and stock control, rostering and customer retention; escalates to the Area Manager.',
    changeNote: 'NEW. Replaces a G7 Branch Manager at the 16 Tier 3 branches.',
  },
  {
    code: 'DES-36', name: 'Assistant Branch Manager', department: 'Customer Experience & Branches', grade: 'G6',
    reportsTo: 'Branch Manager', branchScope: 'High-Volume Branches', systemRole: 'BRANCH_SUPERVISOR',
    roleStatus: 'Refactored',
    responsibilities: 'Supports daily branch administration, ticket queue clearance and staff rostering, and acts as OIC in the Branch Manager absence.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-35', name: 'Branch Operations Coordinator', department: 'Customer Experience & Branches', grade: 'G6',
    reportsTo: 'Head of Branch & Customer Operations', branchScope: 'All Branches (24)', systemRole: 'HEAD_OFFICE_ADMIN', phase: 'Phase 2',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Monitors daily branch compliance checklists, petty cash/deposit delays, stock requests and inter-branch coordination for management. Independent assurance comes from Internal Audit.',
    changeNote: 'Reports to the Head of Branch & Customer Operations; Internal Audit added for independent assurance.',
  },
  {
    code: 'DES-45', name: 'Customer Care & Retention Manager', department: 'Customer Experience & Branches', grade: 'G7',
    reportsTo: 'Head of Branch & Customer Operations', branchScope: 'Central Call Center / All Branches', systemRole: 'SUPPORT_SUPERVISOR', phase: 'Phase 2',
    roleStatus: 'NEW (v2)',
    responsibilities: 'Owns call-centre performance (FCR, CSAT), complaint escalation, churn prevention and win-back; coordinates L1 to NOC handover and SLA reporting for corporate clients.',
    changeNote: 'NEW. Retention was in the mandate but nobody owned it.',
  },
  {
    code: 'DES-37', name: 'Customer Support Coordinator', department: 'Customer Experience & Branches', grade: 'G5',
    reportsTo: 'Customer Care & Retention Manager', branchScope: 'Central Call Center / Branches', systemRole: 'SUPPORT_SUPERVISOR', phase: 'Phase 2',
    roleStatus: 'Revised (v2)',
    responsibilities: 'Leads call center agents, monitors First Contact Resolution (FCR), manages peak outage call volumes and handles VIP complaints.',
    changeNote: 'Reports to the new Customer Care & Retention Manager (call centre no longer hangs under a branch).',
  },
  {
    code: 'DES-38', name: 'Senior Front Desk Associate', department: 'Customer Experience & Branches', grade: 'G5',
    reportsTo: 'Branch Manager', branchScope: 'Hub Branches', systemRole: 'BRANCH_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Supervises walk-in reception counter, reconciles daily branch cash/QR collections and handles complex billing adjustments.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-39', name: 'Customer Support Associate', department: 'Customer Experience & Branches', grade: 'G3',
    reportsTo: 'Customer Support Coordinator', branchScope: 'Call Center / Branches', systemRole: 'SUPPORT_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Answers inbound support calls/chats, logs trouble tickets, guides customers through router restarts/Wi-Fi settings and verifies resolution.',
    changeNote: 'No change.',
  },
  {
    code: 'DES-40', name: 'Front Desk Associate', department: 'Customer Experience & Branches', grade: 'G3',
    reportsTo: 'Senior Front Desk Associate', branchScope: 'Assigned Branch', systemRole: 'BRANCH_STAFF',
    roleStatus: 'Refactored',
    responsibilities: 'Greets walk-in customers, processes new connection applications, collects monthly subscription payments and issues receipts.',
    changeNote: 'No change.',
  },
];

export const HR_CLUSTERS: HrClusterSeed[] = [
  {
    id: 'CL-KC', name: 'Koshi Central', hub: 'Itahari Hub', province: 'Koshi',
    notes: 'Branches BR-01 to BR-06 plus Rajbiraj. Validate the BR-07 to BR-09 hills assignment against road distance.',
  },
  {
    id: 'CL-KN', name: 'Koshi North & Hills', hub: 'Itahari Hub (satellite office TBC)', province: 'Koshi',
    notes: 'Hill and northern branches. Satellite office for the hub is still to be confirmed.',
  },
  {
    id: 'CL-KE', name: 'Koshi East', hub: 'Birtamode Hub', province: 'Koshi',
    notes: 'Birtamode hub with the Damak, Dudhe, Shivasatashi, Chulachuli and Phidim branches.',
  },
  {
    id: 'CL-CG', name: 'Central & Gandaki', hub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Bagmati / Gandaki',
    notes: 'Kathmandu hub with a Pokhara sub-hub; Central and Gandaki merged in v2.',
  },
];

export const HR_BRANCH_PLAN: HrBranchPlanSeed[] = [
  { code: 'BR-01', name: 'Itahari Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Regional Hub (Tier 1)', headDesignation: 'Branch Manager' },
  { code: 'BR-02', name: 'Urlabari Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Major Branch (Tier 2)', headDesignation: 'Branch Manager' },
  { code: 'BR-03', name: 'Inaruwa Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-04', name: 'Pathari Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-05', name: 'Biratchowk Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-06', name: 'Madhumalla Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-07', name: 'Ratuwamai Branch', clusterId: 'CL-KN', clusterHub: 'Itahari Hub (satellite office TBC)', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-08', name: 'Letang Branch', clusterId: 'CL-KN', clusterHub: 'Itahari Hub (satellite office TBC)', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-09', name: 'Ramailo Branch', clusterId: 'CL-KN', clusterHub: 'Itahari Hub (satellite office TBC)', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-10', name: 'Dhankuta Branch', clusterId: 'CL-KN', clusterHub: 'Itahari Hub (satellite office TBC)', province: 'Koshi', tier: 'Hill Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-11', name: 'Hile Branch', clusterId: 'CL-KN', clusterHub: 'Itahari Hub (satellite office TBC)', province: 'Koshi', tier: 'Hill Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-12', name: 'Birtamode Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Regional Hub (Tier 1)', headDesignation: 'Branch Manager' },
  { code: 'BR-13', name: 'Damak Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Major Branch (Tier 2)', headDesignation: 'Branch Manager' },
  { code: 'BR-14', name: 'Dudhe Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-15', name: 'Shivasatashi Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-16', name: 'Chulachuli Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-17', name: 'Phidim Branch', clusterId: 'CL-KE', clusterHub: 'Birtamode Hub', province: 'Koshi', tier: 'Hill Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-18', name: 'Kathmandu Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Bagmati', tier: 'Corporate / Regional Hub (Tier 1)', headDesignation: 'Branch Manager' },
  { code: 'BR-19', name: 'Tandi Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Bagmati', tier: 'Major Branch (Tier 2)', headDesignation: 'Branch Manager' },
  { code: 'BR-20', name: 'Rajbiraj Branch', clusterId: 'CL-KC', clusterHub: 'Itahari Hub', province: 'Madhesh', tier: 'Major Branch (Tier 2)', headDesignation: 'Branch Manager' },
  { code: 'BR-21', name: 'Jitpur Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Madhesh', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-22', name: 'Pokhara Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Gandaki', tier: 'Regional Hub (Tier 1)', headDesignation: 'Branch Manager' },
  { code: 'BR-23', name: 'Waling Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Gandaki', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
  { code: 'BR-24', name: 'Galyang Branch', clusterId: 'CL-CG', clusterHub: 'Kathmandu Hub (Pokhara sub-hub)', province: 'Gandaki', tier: 'Standard Branch (Tier 3)', headDesignation: 'Branch In-charge' },
];

/** Work stations the employee form offers: head office teams and the four hubs. */
export const HR_WORK_STATIONS = [
  { name: 'Head Office / Core', code: 'WS-HO' },
  { name: 'Central Call Center', code: 'WS-CC' },
  { name: 'Central Warehouse', code: 'WS-CW' },
  { name: 'Itahari Hub', code: 'WS-ITH' },
  { name: 'Birtamode Hub', code: 'WS-BTM' },
  { name: 'Kathmandu Hub', code: 'WS-KTMH' },
  { name: 'Pokhara Sub-hub', code: 'WS-PKRH' },
];
