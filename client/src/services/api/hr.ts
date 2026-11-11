import { API_BASE, apiHeaders, fetchJson } from './http';

/** One employee row from the HR master. Numeric amounts arrive as pg strings. */
export interface EmployeeRecord {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  userId: string | null;
  department: string | null;
  designation: string | null;
  designationCode: string | null;
  employmentType: string | null;
  joiningDateAD: string | null;
  dateOfBirthAD: string | null;
  contractExpiryAD: string | null;
  separationDateAD: string | null;
  workStation: string | null;
  address: string | null;
  personalContact: string | null;
  emergencyContactPerson: string | null;
  emergencyContactNumber: string | null;
  internalEmail: string | null;
  personalEmail: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  ssfEligible: boolean;
  bankName: string | null;
  bankAccount: string | null;
  monthlySalary: string | number | null;
  isActive: boolean;
  /** Square JPEG data URL from self-service; null when the employee has none. */
  profilePhoto: string | null;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The signed-in employee's own profile. The server derives the row from the
 * account's `employees.user_id`; there is no employee id on the request.
 */
export interface HrSelfProfile {
  id: string;
  employeeCode: string;
  name: string;
  branchId: string;
  branchName: string | null;
  department: string | null;
  designation: string | null;
  designationCode: string | null;
  employmentType: string | null;
  workStation: string | null;
  joiningDateAD: string | null;
  contractExpiryAD: string | null;
  dateOfBirthAD: string | null;
  internalEmail: string | null;
  personalEmail: string | null;
  personalContact: string | null;
  emergencyContactPerson: string | null;
  emergencyContactNumber: string | null;
  address: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  ssfEligible: boolean;
  bankName: string | null;
  bankAccount: string | null;
  monthlySalary: string | number | null;
  isActive: boolean;
  /** Square JPEG data URL written by self-service; null when none is set. */
  profilePhoto: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeInput {
  employeeCode: string;
  name: string;
  branchId: string;
  userId?: string | null;
  /** Creates a login for this employee in the same save (create or first link). */
  createLogin?: boolean;
  /** Role the new login starts with. Defaults to FRONT_DESK on the server. */
  loginRole?: string | null;
  department?: string | null;
  designation?: string | null;
  designationCode?: string | null;
  employmentType?: string | null;
  joiningDateAD?: string | null;
  dateOfBirthAD?: string | null;
  contractExpiryAD?: string | null;
  separationDateAD?: string | null;
  workStation?: string | null;
  address?: string | null;
  personalContact?: string | null;
  emergencyContactPerson?: string | null;
  emergencyContactNumber?: string | null;
  internalEmail?: string | null;
  personalEmail?: string | null;
  panNumber?: string | null;
  ssfNumber?: string | null;
  ssfEligible?: boolean;
  bankName?: string | null;
  bankAccount?: string | null;
  monthlySalary?: number | null;
  isActive?: boolean;
  /** Square JPEG data URL; null clears the picture. HR sets it for any employee. */
  profilePhoto?: string | null;
}

/** The one-time credential handed back when a login is created from HR. */
export interface EmployeeLoginHandoff {
  email: string;
  role: string;
  temporaryPassword: string;
}

/** Roles a login created from the employee record may take. */
export const HR_LOGIN_ROLES: string[] = [
  'FRONT_DESK',
  'FIELD_TECHNICIAN',
  'INVENTORY_MANAGER',
  'PROCUREMENT_OFFICER',
  'ACCOUNTANT',
  'BRANCH_MANAGER',
  'HR_OFFICER',
  'HR_MANAGER',
  'HEAD_OFFICE_ADMIN',
  'AUDITOR',
  'SUPER_ADMIN',
];

export interface EmployeeQuery {
  branchId?: string;
  query?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface EmployeeUserOption {
  id: string;
  name: string;
  email: string;
  role: string;
  linked: boolean;
}

export type HrOrgMasterKind = 'DEPARTMENT' | 'DESIGNATION' | 'WORK_STATION';

export interface HrOrgMasterRecord {
  id: string;
  kind: HrOrgMasterKind;
  name: string;
  code: string | null;
  isActive: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrOrgMasterInput {
  kind: HrOrgMasterKind;
  name: string;
  code?: string | null;
  isActive?: boolean;
}

export interface HrOrgMasterPatch {
  name?: string;
  code?: string | null;
  isActive?: boolean;
}

export type HrDocumentType =
  | 'CITIZENSHIP'
  | 'PAN_CARD'
  | 'PASSPORT'
  | 'DRIVING_LICENSE'
  | 'QUALIFICATION'
  | 'CONTRACT'
  | 'APPOINTMENT_LETTER'
  | 'BANK_DETAILS'
  | 'MEDICAL'
  | 'OTHER';

/** Metadata only — the file bytes are fetched by the download endpoint. */
export interface HrEmployeeDocument {
  id: string;
  employeeId: string;
  docType: HrDocumentType;
  originalName: string;
  mimeType: string;
  byteSize: number;
  expiresOnAD: string | null;
  notes: string | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface HrEmployeeDocumentInput {
  type: HrDocumentType;
  expiresOnAD?: string | null;
  notes?: string | null;
}

/** Mirrors the server's 5 MiB ceiling; the input is checked before upload. */
export const HR_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export async function getEmployees(options: EmployeeQuery = {}): Promise<EmployeeRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.query?.trim()) params.set('query', options.query.trim());
  if (options.activeOnly) params.set('activeOnly', '1');
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return fetchJson(`/api/employees${query ? `?${query}` : ''}`);
}

export async function getEmployeeUserOptions(): Promise<EmployeeUserOption[]> {
  return fetchJson('/api/employees/user-options');
}

/**
 * The one self-service read. No query is sent: the endpoint refuses employee,
 * user and branch selectors and always returns the caller's own record.
 */
export async function getMyHrProfile(): Promise<HrSelfProfile> {
  return fetchJson('/api/hr/self-service/profile');
}

/**
 * The fields self-service may change. The server refuses every other column by
 * name, so this interface is the client half of the same allow-list — salary,
 * statutory ids, bank details and employment terms are deliberately absent.
 */
export interface HrSelfProfileInput {
  personalContact: string | null;
  personalEmail: string | null;
  address: string | null;
  emergencyContactPerson: string | null;
  emergencyContactNumber: string | null;
  profilePhoto: string | null;
}

/** Writes the caller's own contact card/photo and returns the stored row. */
export async function saveMyHrProfile(input: HrSelfProfileInput): Promise<HrSelfProfile> {
  return fetchJson('/api/hr/self-service/profile', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * The signed-in employee's own posted/paid payslips. Like the profile read,
 * this sends no employee, user or branch selector; the server derives the
 * employee from the session and excludes DRAFT/APPROVED runs.
 */
export async function getMyHrPayslips(): Promise<HrSelfPayslipsResponse> {
  return fetchJson('/api/hr/self-service/payslips');
}

/** One own leave balance. Used/remaining are derived from approved requests. */
export interface HrSelfLeaveBalance {
  id: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  leaveTypePaid: boolean;
  balanceYear: number;
  entitlementDays: number;
  adjustmentDays: number;
  usedDays: number;
  remainingDays: number;
  notes: string | null;
  updatedAt: string;
}

/** One own leave request, including pending/rejected/cancelled history. */
export interface HrSelfLeaveRequest {
  id: string;
  requestNo: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  startDateAD: string;
  endDateAD: string;
  startDateBS: string | null;
  endDateBS: string | null;
  daysCount: number;
  reason: string | null;
  status: HrLeaveRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrSelfLeaveResponse {
  balances: HrSelfLeaveBalance[];
  requests: HrSelfLeaveRequest[];
}

/** Own balances and request history; read-only, no selector and no write. */
export async function getMyHrLeave(): Promise<HrSelfLeaveResponse> {
  return fetchJson('/api/hr/self-service/leave');
}

/** One own attendance day in the server's rolling 90-day recent window. */
export interface HrSelfAttendanceRecord {
  id: string;
  attendanceDateAD: string;
  attendanceDateBS: string | null;
  shiftId: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  status: HrAttendanceStatus;
  checkInTime: string | null;
  checkOutTime: string | null;
  overtimeHours: number;
  notes: string | null;
  source: 'MANUAL' | 'IMPORT';
  updatedAt: string;
}

export interface HrSelfAttendanceSummary {
  totalDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  halfDays: number;
  holidayDays: number;
  weekendDays: number;
  overtimeHours: number;
}

export interface HrSelfAttendanceResponse {
  windowStartAD: string;
  windowEndAD: string;
  windowDays: number;
  summary: HrSelfAttendanceSummary;
  records: HrSelfAttendanceRecord[];
}

/** Own recent attendance; no selector, no paging and no write path. */
export async function getMyHrAttendance(): Promise<HrSelfAttendanceResponse> {
  return fetchJson('/api/hr/self-service/attendance');
}

export type HrSelfDocumentExpiryStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NO_EXPIRY';

/** One own vault document. `issuedOnAD` is null because the vault stores none. */
export interface HrSelfDocument {
  id: string;
  docType: HrDocumentType;
  title: string;
  mimeType: string;
  byteSize: number;
  issuedOnAD: string | null;
  expiresOnAD: string | null;
  expiryStatus: HrSelfDocumentExpiryStatus;
  uploadedAt: string;
  notes: string | null;
  uploadedBy: string | null;
  contentUrl: string;
}

export interface HrSelfDocumentSummary {
  totalDocuments: number;
  expiringSoon: number;
  expiredDocuments: number;
}

export interface HrSelfDocumentsResponse {
  expirySoonDays: number;
  summary: HrSelfDocumentSummary;
  documents: HrSelfDocument[];
}

/** Own document metadata; no employee/document selector and no write path. */
export async function getMyHrDocuments(): Promise<HrSelfDocumentsResponse> {
  return fetchJson('/api/hr/self-service/documents');
}

/** Downloads through the existing authenticated content route returned by the API. */
export async function downloadMyHrDocument(document: HrSelfDocument): Promise<void> {
  const res = await fetch(`${API_BASE}${document.contentUrl}`, { headers: apiHeaders() });
  if (!res.ok) throw await documentError(res);
  const href = URL.createObjectURL(await res.blob());
  const anchor = window.document.createElement('a');
  anchor.href = href;
  anchor.download = document.title;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export interface HrWorkforceReportPeriod {
  fromAD: string;
  toAD: string;
}

export interface HrReportHeadcountRow {
  branchId: string;
  branchName: string;
  count: number;
}

export interface HrReportDepartmentRow {
  department: string;
  count: number;
}

export interface HrReportHeadcount {
  total: number;
  byBranch: HrReportHeadcountRow[];
  byDepartment: HrReportDepartmentRow[];
}

export interface HrReportAttritionBranchRow {
  branchId: string;
  branchName: string;
  separations: number;
  headcountAtStart: number;
  unknownJoiningCount: number;
  ratePercent: number | null;
}

export interface HrReportAttrition {
  available: boolean;
  separations: number;
  ratePercent: number | null;
  rateBasis: 'PERIOD_START_HEADCOUNT';
  headcountAtStart: number;
  unknownJoiningCount: number;
  reason: string | null;
  byBranch: HrReportAttritionBranchRow[];
}

export interface HrReportLeaveTypeRow {
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  leaveTypePaid: boolean;
  employeeCount: number;
  entitlementDays: number;
  adjustmentDays: number;
  usedDays: number;
  remainingDays: number;
}

export interface HrReportLeaveLiability {
  balanceYear: number;
  totalEntitlementDays: number;
  totalAdjustmentDays: number;
  totalUsedDays: number;
  totalRemainingDays: number;
  byLeaveType: HrReportLeaveTypeRow[];
}

export interface HrWorkforceReport {
  period: HrWorkforceReportPeriod;
  asOf: string;
  scope: { branchId: string | null };
  headcount: HrReportHeadcount;
  attrition: HrReportAttrition;
  leaveLiability: HrReportLeaveLiability;
}

export interface HrWorkforceReportQuery {
  dateFrom?: string;
  dateTo?: string;
  branchId?: string;
}

export interface HrReportPayrollCostAmounts {
  runCount: number;
  lineCount: number;
  gross: number;
  /** Employer SSF share: a company cost, not withheld from the employee. */
  employerSsf: number;
  /** Gross wages plus employer SSF — what the run costs the company. */
  totalCost: number;
  basic: number;
  allowances: number;
  overtime: number;
  incentive: number;
  arrears: number;
  lopDeduction: number;
  deductions: number;
  net: number;
}

export interface HrReportPayrollCostBranchRow extends HrReportPayrollCostAmounts {
  branchId: string;
  branchName: string;
}

export interface HrReportPayrollCostPeriodRow extends HrReportPayrollCostAmounts {
  periodKey: string;
}

export interface HrReportPayrollCost {
  available: boolean;
  totals: HrReportPayrollCostAmounts;
  byBranch: HrReportPayrollCostBranchRow[];
  byPeriod: HrReportPayrollCostPeriodRow[];
}

export interface HrReportOvertimeBranchRow {
  branchId: string;
  branchName: string;
  employeeCount: number;
  overtimeHours: number;
  overtimeAmount: number;
}

export interface HrReportOvertimeDepartmentRow {
  department: string;
  employeeCount: number;
  overtimeHours: number;
  overtimeAmount: number;
}

export interface HrReportOvertimeEmployeeRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  department: string;
  runCount: number;
  overtimeHours: number;
  overtimeAmount: number;
}

export interface HrReportOvertime {
  available: boolean;
  totals: {
    employeeCount: number;
    overtimeHours: number;
    overtimeAmount: number;
  };
  byBranch: HrReportOvertimeBranchRow[];
  byDepartment: HrReportOvertimeDepartmentRow[];
  byEmployee: HrReportOvertimeEmployeeRow[];
}

export interface HrReportStatutoryPeriodRow {
  periodKey: string;
  payslipCount: number;
  employeeSsf: number;
  employerSsf: number;
  totalSsf: number;
  tds: number;
}

export interface HrReportStatutory {
  available: boolean;
  totals: {
    payslipCount: number;
    employeeSsf: number;
    employerSsf: number;
    totalSsf: number;
    tds: number;
  };
  byPeriod: HrReportStatutoryPeriodRow[];
}

/** One employee's share of the SSF payable tie-out. */
export interface HrReportSsfEmployeeRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  lineCount: number;
  employeeSsf: number;
  employerSsf: number;
  payable: number;
  configuredEmployeeSsf: number;
  configuredEmployerSsf: number;
  configured: number;
  controlBalance: number;
  difference: number;
  rateMismatchLines: number;
  unconfiguredLines: number;
  matches: boolean;
  ratesMatch: boolean;
}

/**
 * SSF payable tie-out: posted contributions (employee + employer) against the
 * rates configured for each run and the SSF payable control account balance.
 * `matches` is null when the chart has no SSF_PAYABLE posting default.
 */
export interface HrReportSsfReconciliation {
  available: boolean;
  employeeSsf: number;
  employerSsf: number;
  payable: number;
  configuredEmployeeSsf: number;
  configuredEmployerSsf: number;
  configured: number;
  controlAccount: { code: string; name: string } | null;
  controlBalance: number | null;
  controlLineCount: number;
  difference: number | null;
  rateMismatchLines: number;
  unconfiguredLines: number;
  /** Per-employee rows, largest absolute difference first. */
  byEmployee: HrReportSsfEmployeeRow[];
  /** Control balance no employee row claims; null when the account is unmapped. */
  unattributedControl: number | null;
  /** Does the control account carry exactly the posted payable? */
  matches: boolean | null;
  /** Do the posted snapshots still agree with the run's current configured rates? */
  ratesMatch: boolean;
  /** Why the control account does not tie, or null when it does. */
  reason: string | null;
  /** Why the configured comparison differs, or null when it agrees. */
  rateNote: string | null;
}

export interface HrPayrollReport {
  period: HrWorkforceReportPeriod;
  asOf: string;
  scope: { branchId: string | null };
  basis: {
    source: string;
    runStatuses: string[];
  };
  payrollCost: HrReportPayrollCost;
  overtime: HrReportOvertime;
  statutory: HrReportStatutory;
  ssf: HrReportSsfReconciliation;
}

/** Session-scoped workforce headings; no client employee or tenant selector. */
export async function getHrWorkforceReport(
  options: HrWorkforceReportQuery = {}
): Promise<HrWorkforceReport> {
  const params = new URLSearchParams();
  if (options.dateFrom) params.set('dateFrom', options.dateFrom);
  if (options.dateTo) params.set('dateTo', options.dateTo);
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  const query = params.toString();
  return fetchJson(`/api/hr/reports/workforce${query ? `?${query}` : ''}`);
}

/** Session-scoped payroll cost, overtime and SSF/TDS filing aggregates. */
export async function getHrPayrollReport(
  options: HrWorkforceReportQuery = {}
): Promise<HrPayrollReport> {
  const params = new URLSearchParams();
  if (options.dateFrom) params.set('dateFrom', options.dateFrom);
  if (options.dateTo) params.set('dateTo', options.dateTo);
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  const query = params.toString();
  return fetchJson(`/api/hr/reports/payroll${query ? `?${query}` : ''}`);
}

export async function getHrOrgMasters(
  options: { kind?: HrOrgMasterKind; activeOnly?: boolean } = {}
): Promise<HrOrgMasterRecord[]> {
  const params = new URLSearchParams();
  if (options.kind) params.set('kind', options.kind);
  if (options.activeOnly) params.set('activeOnly', '1');
  const query = params.toString();
  return fetchJson(`/api/hr/org-masters${query ? `?${query}` : ''}`);
}

export async function createHrOrgMaster(input: HrOrgMasterInput): Promise<HrOrgMasterRecord> {
  return fetchJson('/api/hr/org-masters', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrOrgMaster(
  id: string,
  patch: HrOrgMasterPatch
): Promise<HrOrgMasterRecord> {
  return fetchJson(`/api/hr/org-masters/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

function documentQuery(branchId?: string | null): string {
  return branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
}

async function documentError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => null);
  const error = new Error(body?.message || `Request failed with status ${res.status}`);
  (error as any).status = res.status;
  return error;
}

export async function getEmployeeDocuments(
  employeeId: string,
  branchId?: string | null
): Promise<HrEmployeeDocument[]> {
  return fetchJson(
    `/api/employees/${encodeURIComponent(employeeId)}/documents${documentQuery(branchId)}`
  );
}

/** Uploads the file as the raw request body; metadata travels in the query. */
export async function uploadEmployeeDocument(
  employeeId: string,
  file: File,
  input: HrEmployeeDocumentInput,
  branchId?: string | null
): Promise<HrEmployeeDocument> {
  const params = new URLSearchParams({ type: input.type, fileName: file.name });
  if (branchId) params.set('branchId', branchId);
  if (input.expiresOnAD) params.set('expiresOn', input.expiresOnAD);
  if (input.notes?.trim()) params.set('notes', input.notes.trim());
  const res = await fetch(
    `${API_BASE}/api/employees/${encodeURIComponent(employeeId)}/documents?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(),
        // An unknown browser type is sent as octet-stream and the server
        // rejects it with a clear message instead of guessing.
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    }
  );
  if (!res.ok) throw await documentError(res);
  return res.json();
}

export async function downloadEmployeeDocument(
  employeeId: string,
  doc: HrEmployeeDocument,
  branchId?: string | null
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/employees/${encodeURIComponent(employeeId)}/documents/${encodeURIComponent(
      doc.id
    )}/content${documentQuery(branchId)}`,
    { headers: apiHeaders() }
  );
  if (!res.ok) throw await documentError(res);
  const href = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = doc.originalName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function deleteEmployeeDocument(
  employeeId: string,
  documentId: string,
  branchId?: string | null
): Promise<void> {
  return fetchJson(
    `/api/employees/${encodeURIComponent(employeeId)}/documents/${encodeURIComponent(
      documentId
    )}${documentQuery(branchId)}`,
    { method: 'DELETE' }
  );
}

/** F1 Employee Profile — personal, family, experience, qualification, medical
 * and reference sections. The server replaces the whole profile on PUT, so the
 * client always sends every section back. */
export interface HrEmployeeFamilyMember {
  id: string;
  sortOrder: number;
  name: string;
  age: number | null;
  occupation: string | null;
  relation: string | null;
}

export interface HrEmployeeExperienceRow {
  id: string;
  sortOrder: number;
  organization: string;
  fromAD: string | null;
  toAD: string | null;
  designation: string | null;
}

export interface HrEmployeeQualificationRow {
  id: string;
  sortOrder: number;
  examPassed: string;
  boardUniversity: string | null;
  percentage: string | number | null;
}

export interface HrEmployeeReferenceRow {
  id: string;
  sortOrder: number;
  name: string;
  organization: string | null;
  contact: string | null;
  relation: string | null;
}

/** Mirrors the server ceilings checked before the request is sent. */
export const HR_PROFILE_MAX_ROWS = {
  familyMembers: 20,
  experience: 20,
  qualifications: 20,
  references: 10,
} as const;

/** Mirrors the server's accepted blood groups. */
export const HR_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

export interface HrEmployeeProfileFields {
  fatherName: string | null;
  grandfatherName: string | null;
  permanentAddress: string | null;
  localAddress: string | null;
  emergencyContactAddress: string | null;
  emergencyContactRelation: string | null;
  bloodGroup: string | null;
  medicalConditions: string | null;
  medicalDetails: string | null;
  accidentDetails: string | null;
  caseDetails: string | null;
  declarationDateAD: string | null;
  declarationName: string | null;
}

export interface HrEmployeeProfileResponse {
  employeeId: string;
  employeeCode: string;
  name: string;
  branchId: string;
  /** True when the caller may read the employee master but not its PII. */
  masked: boolean;
  profile: HrEmployeeProfileFields;
  familyMembers: HrEmployeeFamilyMember[];
  experience: HrEmployeeExperienceRow[];
  qualifications: HrEmployeeQualificationRow[];
  references: HrEmployeeReferenceRow[];
}

export type HrEmployeeProfileInput = HrEmployeeProfileFields & {
  familyMembers: Array<Omit<HrEmployeeFamilyMember, 'id' | 'sortOrder'>>;
  experience: Array<Omit<HrEmployeeExperienceRow, 'id' | 'sortOrder'>>;
  qualifications: Array<Omit<HrEmployeeQualificationRow, 'id' | 'sortOrder'>>;
  references: Array<Omit<HrEmployeeReferenceRow, 'id' | 'sortOrder'>>;
};

export async function getEmployeeProfile(
  employeeId: string,
  branchId?: string | null
): Promise<HrEmployeeProfileResponse> {
  return fetchJson(
    `/api/employees/${encodeURIComponent(employeeId)}/profile${documentQuery(branchId)}`
  );
}

export async function saveEmployeeProfile(
  employeeId: string,
  input: HrEmployeeProfileInput,
  branchId?: string | null
): Promise<HrEmployeeProfileResponse> {
  return fetchJson(
    `/api/employees/${encodeURIComponent(employeeId)}/profile${documentQuery(branchId)}`,
    { method: 'PUT', body: JSON.stringify(input) }
  );
}

export async function createEmployee(
  input: EmployeeInput
): Promise<EmployeeRecord & { login?: EmployeeLoginHandoff | null }> {
  return fetchJson('/api/employees', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** PATCH keeps every field the request does not send. */
export async function updateEmployee(
  id: string,
  patch: Partial<Omit<EmployeeInput, 'employeeCode' | 'branchId'>>
): Promise<EmployeeRecord & { login?: EmployeeLoginHandoff | null }> {
  return fetchJson(`/api/employees/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export type EmployeeImportMode = 'DRY_RUN' | 'COMMIT';

export interface EmployeeImportRowResult {
  rowNumber: number;
  employeeCode: string | null;
  name: string | null;
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  errors: string[];
}

export interface EmployeeImportResult {
  mode: EmployeeImportMode;
  totalRows: number;
  validRows: number;
  created: number;
  updated: number;
  skipped: number;
  rows: EmployeeImportRowResult[];
}

export interface EmployeeImportInput {
  mode: EmployeeImportMode;
  csv: string;
  branchMap?: Record<string, string>;
  workStationMap?: Record<string, string>;
}

/** Dry run validates only; commit writes every valid row in one transaction. */
export async function importEmployees(
  input: EmployeeImportInput
): Promise<EmployeeImportResult> {
  return fetchJson('/api/hr/employees/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type HrAttendanceStatus =
  | 'PRESENT'
  | 'ABSENT'
  | 'LEAVE'
  | 'HALF_DAY'
  | 'HOLIDAY'
  | 'WEEKEND';

export interface HrShiftRecord {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  isActive: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrShiftInput {
  code?: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes?: number;
  isActive?: boolean;
}

export interface HrLeaveTypeRecord {
  id: string;
  code: string;
  name: string;
  annualQuotaDays: string | number;
  isPaid: boolean;
  isActive: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrLeaveTypeInput {
  code?: string;
  name: string;
  annualQuotaDays?: number;
  isPaid?: boolean;
  isActive?: boolean;
}

export interface HrHolidayRecord {
  id: string;
  branchId: string;
  branchName: string;
  holidayDateAD: string;
  holidayDateBS: string | null;
  name: string;
  isPaid: boolean;
  notes: string | null;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HrHolidayInput {
  branchId?: string;
  holidayDateAD: string;
  name: string;
  isPaid?: boolean;
  notes?: string | null;
}

export interface HrAttendanceRecord {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  attendanceDateAD: string;
  attendanceDateBS: string | null;
  shiftId: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  status: HrAttendanceStatus;
  checkInTime: string | null;
  checkOutTime: string | null;
  overtimeHours: string | number;
  notes: string | null;
  source: 'MANUAL' | 'IMPORT';
  recordedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrAttendanceInput {
  employeeId: string;
  attendanceDateAD: string;
  status: HrAttendanceStatus;
  shiftId?: string | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  overtimeHours?: number;
  notes?: string | null;
}

export interface HrAttendanceQuery {
  branchId?: string;
  from?: string;
  to?: string;
  employeeId?: string;
  status?: HrAttendanceStatus;
}

export interface HrAttendanceImportRow {
  rowNumber: number;
  employeeCode: string | null;
  employeeName: string | null;
  attendanceDateAD: string | null;
  action: 'CREATE' | 'UPDATE' | 'SKIP';
  errors: string[];
}

export interface HrAttendanceImportResult {
  totalRows: number;
  validRows: number;
  created: number;
  updated: number;
  skipped: number;
  rows: HrAttendanceImportRow[];
}

export async function getHrShifts(activeOnly = false): Promise<HrShiftRecord[]> {
  return fetchJson(`/api/hr/shifts${activeOnly ? '?activeOnly=1' : ''}`);
}

export async function createHrShift(input: HrShiftInput): Promise<HrShiftRecord> {
  return fetchJson('/api/hr/shifts', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateHrShift(
  id: string,
  patch: Partial<HrShiftInput>
): Promise<HrShiftRecord> {
  return fetchJson(`/api/hr/shifts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrLeaveTypes(activeOnly = false): Promise<HrLeaveTypeRecord[]> {
  return fetchJson(`/api/hr/leave-types${activeOnly ? '?activeOnly=1' : ''}`);
}

export async function createHrLeaveType(
  input: HrLeaveTypeInput
): Promise<HrLeaveTypeRecord> {
  return fetchJson('/api/hr/leave-types', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateHrLeaveType(
  id: string,
  patch: Partial<HrLeaveTypeInput>
): Promise<HrLeaveTypeRecord> {
  return fetchJson(`/api/hr/leave-types/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrHolidays(
  options: { branchId?: string; from?: string; to?: string } = {}
): Promise<HrHolidayRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  const query = params.toString();
  return fetchJson(`/api/hr/holidays${query ? `?${query}` : ''}`);
}

export async function createHrHoliday(input: HrHolidayInput): Promise<HrHolidayRecord> {
  return fetchJson('/api/hr/holidays', { method: 'POST', body: JSON.stringify(input) });
}

export async function deleteHrHoliday(id: string): Promise<void> {
  return fetchJson(`/api/hr/holidays/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getHrAttendance(
  options: HrAttendanceQuery = {}
): Promise<HrAttendanceRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.employeeId) params.set('employeeId', options.employeeId);
  if (options.status) params.set('status', options.status);
  const query = params.toString();
  return fetchJson(`/api/hr/attendance${query ? `?${query}` : ''}`);
}

export async function saveHrAttendance(
  input: HrAttendanceInput
): Promise<HrAttendanceRecord> {
  return fetchJson('/api/hr/attendance', { method: 'POST', body: JSON.stringify(input) });
}

export async function importHrAttendance(csv: string): Promise<HrAttendanceImportResult> {
  return fetchJson('/api/hr/attendance/import', {
    method: 'POST',
    body: JSON.stringify({ csv }),
  });
}

export async function deleteHrAttendance(id: string): Promise<void> {
  return fetchJson(`/api/hr/attendance/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type HrLeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** Usage is derived server-side from APPROVED requests; only the first four
 *  numbers are stored (entitlement/adjustment), the rest are computed. */
export interface HrLeaveBalanceRecord {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  leaveTypePaid: boolean;
  balanceYear: number;
  entitlementDays: string | number;
  adjustmentDays: string | number;
  usedDays: string | number;
  remainingDays: string | number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrLeaveBalanceInput {
  employeeId: string;
  leaveTypeId: string;
  balanceYear: number;
  entitlementDays?: number;
  adjustmentDays?: number;
  notes?: string | null;
}

export interface HrLeaveBalanceQuery {
  branchId?: string;
  year?: number;
  employeeId?: string;
  leaveTypeId?: string;
}

export interface HrLeaveRequestRecord {
  id: string;
  requestNo: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  startDateAD: string;
  endDateAD: string;
  startDateBS: string | null;
  endDateBS: string | null;
  daysCount: string | number;
  reason: string | null;
  status: HrLeaveRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrLeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDateAD: string;
  endDateAD: string;
  reason?: string | null;
}

export interface HrLeaveRequestQuery {
  branchId?: string;
  status?: HrLeaveRequestStatus;
  employeeId?: string;
  from?: string;
  to?: string;
}

export async function getHrLeaveBalances(
  options: HrLeaveBalanceQuery = {}
): Promise<HrLeaveBalanceRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.year) params.set('year', String(options.year));
  if (options.employeeId) params.set('employeeId', options.employeeId);
  if (options.leaveTypeId) params.set('leaveTypeId', options.leaveTypeId);
  const query = params.toString();
  return fetchJson(`/api/hr/leave-balances${query ? `?${query}` : ''}`);
}

export async function createHrLeaveBalance(
  input: HrLeaveBalanceInput
): Promise<HrLeaveBalanceRecord> {
  return fetchJson('/api/hr/leave-balances', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrLeaveBalance(
  id: string,
  patch: Partial<Pick<HrLeaveBalanceInput, 'entitlementDays' | 'adjustmentDays' | 'notes'>>
): Promise<HrLeaveBalanceRecord> {
  return fetchJson(`/api/hr/leave-balances/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrLeaveRequests(
  options: HrLeaveRequestQuery = {}
): Promise<HrLeaveRequestRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.status) params.set('status', options.status);
  if (options.employeeId) params.set('employeeId', options.employeeId);
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  const query = params.toString();
  return fetchJson(`/api/hr/leave-requests${query ? `?${query}` : ''}`);
}

export async function createHrLeaveRequest(
  input: HrLeaveRequestInput
): Promise<HrLeaveRequestRecord> {
  return fetchJson('/api/hr/leave-requests', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function decideHrLeaveRequest(
  id: string,
  action: 'approve' | 'reject' | 'cancel',
  note?: string | null
): Promise<HrLeaveRequestRecord> {
  return fetchJson(`/api/hr/leave-requests/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(note ? { note } : {}),
  });
}

export async function approveHrLeaveRequest(
  id: string,
  note?: string | null
): Promise<HrLeaveRequestRecord> {
  return decideHrLeaveRequest(id, 'approve', note);
}

export async function rejectHrLeaveRequest(
  id: string,
  note?: string | null
): Promise<HrLeaveRequestRecord> {
  return decideHrLeaveRequest(id, 'reject', note);
}

export async function cancelHrLeaveRequest(
  id: string,
  note?: string | null
): Promise<HrLeaveRequestRecord> {
  return decideHrLeaveRequest(id, 'cancel', note);
}

/** Derived on read from attendance + approved leave; one row per employee. */
export interface HrPayrollInputRecord {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  attendanceLeaveDays: number;
  holidayDays: number;
  weekendDays: number;
  overtimeHours: number;
  adjustmentId: string | null;
  adjustmentPeriodKey: string | null;
  incentiveAmount: number;
  arrearsAmount: number;
  advanceAmount: number;
  loanAmount: number;
  adjustmentNotes: string | null;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  payableDays: number;
  lopDays: number;
}

export interface HrPayrollInputQuery {
  branchId?: string;
  from: string;
  to: string;
  employeeId?: string;
}

export async function getHrPayrollInputs(
  options: HrPayrollInputQuery
): Promise<HrPayrollInputRecord[]> {
  const params = new URLSearchParams({ from: options.from, to: options.to });
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.employeeId) params.set('employeeId', options.employeeId);
  return fetchJson(`/api/hr/payroll-inputs?${params.toString()}`);
}

export interface HrPayrollInputSave {
  employeeId: string;
  periodKey: string;
  incentiveAmount?: number;
  arrearsAmount?: number;
  advanceAmount?: number;
  loanAmount?: number;
  notes?: string | null;
}

/** Upserts the one-off incentive/arrears/recovery row for an employee-month. */
export async function saveHrPayrollInput(
  input: HrPayrollInputSave
): Promise<HrPayrollInputRecord> {
  return fetchJson('/api/hr/payroll-inputs', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export type HrSalaryComponentKind = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';

/** One amount line of an effective-dated salary structure. */
export interface HrSalaryComponentRecord {
  id: string;
  salaryId: string;
  componentCode: string;
  componentName: string;
  kind: HrSalaryComponentKind;
  amount: number;
  isTaxable: boolean;
  isSsfApplicable: boolean;
  sortOrder: number;
}

export type HrPayrollRunStatus = 'DRAFT' | 'APPROVED' | 'POSTED' | 'PAID';

export interface HrPayrollRunLine {
  id: string;
  runId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodKey: string;
  salaryId: string | null;
  basicAmount: number | string;
  payableDays: number | string;
  lopDays: number | string;
  lopDeduction: number | string;
  overtimeHours: number | string;
  overtimeAmount: number | string;
  incentive: number | string;
  arrears: number | string;
  gross: number | string;
  tds: number | string;
  ssf: number | string;
  employerSsf: number | string;
  advance: number | string;
  loan: number | string;
  net: number | string;
}

export interface HrPayrollRunRecord {
  id: string;
  runNo: string;
  branchId: string;
  periodKey: string;
  runDateAD: string;
  runDateBS: string | null;
  grossTotal: number | string;
  tdsTotal: number | string;
  ssfTotal: number | string;
  advanceTotal: number | string;
  loanTotal: number | string;
  incentiveTotal: number | string;
  arrearsTotal: number | string;
  netTotal: number | string;
  status: HrPayrollRunStatus;
  journalId: string | null;
  paidJournalId: string | null;
  paidDateAD: string | null;
  paidDateBS: string | null;
  paymentMethod: string | null;
  preparedBy: string | null;
  preparedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  postedBy: string | null;
  statutoryConfigId: string | null;
  paidAt: string | null;
  fiscalYearCode?: string | null;
  lines?: HrPayrollRunLine[];
  createdAt: string;
  updatedAt: string;
}

export type HrPayrollOutputView = 'REGISTER' | 'PAYSLIPS';

/** One posted-run payslip derived from the immutable payroll_run_lines row. */
export interface HrPayrollPayslip {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  panNumber: string | null;
  ssfNumber: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankStatus: 'READY' | 'MISSING';
  detailsRestricted: boolean;
  branchId: string;
  branchName: string;
  fiscalYearCode: string | null;
  runNo: string;
  periodKey: string;
  runDateAD: string;
  runDateBS: string | null;
  paidDateAD: string | null;
  paymentMethod: string | null;
  status: HrPayrollRunStatus;
  basicAmount: number;
  allowances: number;
  payableDays: number;
  lopDays: number;
  lopDeduction: number;
  overtimeHours: number;
  overtimeAmount: number;
  incentive: number;
  arrears: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  totalDeductions: number;
  employerCost: number;
  net: number;
}

export interface HrPayrollRegisterRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankStatus: 'READY' | 'MISSING';
  detailsRestricted: boolean;
  paymentMethod: string | null;
  incentive: number;
  arrears: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  totalDeductions: number;
  net: number;
}

export interface HrPayrollOutputTotals {
  employees: number;
  basic: number;
  allowances: number;
  overtime: number;
  incentive: number;
  arrears: number;
  lop: number;
  gross: number;
  tds: number;
  ssf: number;
  employerSsf: number;
  advance: number;
  loan: number;
  deductions: number;
  employerCost: number;
  net: number;
}

export interface HrPayrollStatutoryTotals {
  gross: number;
  tds: number;
  employeeSsf: number;
  employerSsf: number;
  net: number;
}

export interface HrPayrollJournalSummary {
  id: string;
  journalNo: string;
  status: string;
  journalDateAD: string | null;
  totalDebit: number;
  totalCredit: number;
}

export interface HrPayrollReconciliation {
  matchesRun: boolean;
  matchesJournal: boolean;
  paymentMatchesRun: boolean | null;
  runGross: number;
  runTds: number;
  runSsf: number;
  runIncentive: number;
  runArrears: number;
  runNet: number;
  registerGross: number;
  registerTds: number;
  registerSsf: number;
  registerIncentive: number;
  registerArrears: number;
  registerNet: number;
  journalDebit: number | null;
  journalCredit: number | null;
  paymentDebit: number | null;
  paymentCredit: number | null;
}

export interface HrPayrollOutputMeta {
  branchName: string;
  totals: HrPayrollOutputTotals;
  statutory: HrPayrollStatutoryTotals;
  journal: HrPayrollJournalSummary | null;
  paymentJournal: HrPayrollJournalSummary | null;
  reconciliation: HrPayrollReconciliation;
  generatedAt: string;
}

export interface HrPayrollPayslipsResponse extends HrPayrollRunRecord, HrPayrollOutputMeta {
  payslips: HrPayrollPayslip[];
}

export interface HrPayrollPayslipResponse extends HrPayrollRunRecord, HrPayrollOutputMeta {
  payslip: HrPayrollPayslip;
}

/** The ESS payslip list: only the signed-in employee's own posted/paid rows. */
export interface HrSelfPayslipsResponse {
  payslips: HrPayrollPayslip[];
}

export interface HrPayrollRegisterResponse extends HrPayrollRunRecord, HrPayrollOutputMeta {
  rows: HrPayrollRegisterRow[];
}

export interface HrPayrollRunQuery {
  branchId?: string;
  periodKey?: string;
  status?: HrPayrollRunStatus | '';
}

/** One POSTED/PAID run in the Finance payroll-postings register. */
export interface HrPayrollPostingRow {
  id: string;
  runNo: string;
  branchId: string;
  branchName: string | null;
  periodKey: string;
  runDateAD: string;
  runDateBS: string | null;
  grossTotal: number | string;
  tdsTotal: number | string;
  ssfTotal: number | string;
  advanceTotal: number | string;
  loanTotal: number | string;
  incentiveTotal: number | string;
  arrearsTotal: number | string;
  netTotal: number | string;
  status: 'POSTED' | 'PAID';
  journalId: string | null;
  journalNo: string | null;
  journalDateAD: string | null;
  journalStatus: string | null;
  journalDebit: number | string;
  journalCredit: number | string;
  paidJournalId: string | null;
  paymentJournalNo: string | null;
  paymentJournalDateAD: string | null;
  paymentJournalStatus: string | null;
  paymentDebit: number | string;
  paymentCredit: number | string;
  paidDateAD: string | null;
  paidDateBS: string | null;
  paymentMethod: string | null;
  postedBy: string | null;
  approvedBy: string | null;
  paidAt: string | null;
  employeeCount: number;
}

export interface HrPayrollPostingsQuery {
  branchId?: string;
  from?: string;
  to?: string;
  query?: string;
}

export interface HrPayrollDraftInput {
  branchId: string;
  periodKey: string;
}

export interface HrPayrollPaymentInput {
  paymentMethod?: string;
  dateAD?: string;
}

/**
 * A salary structure as the server resolves it: the header plus BASIC/HRA
 * convenience totals and the full component list.
 */
export interface HrSalaryStructureRecord {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  branchName: string;
  effectiveFrom: string;
  ssfEligible: boolean;
  overtimeRate: number;
  tdsMonthly: number;
  notes: string | null;
  basicAmount: number;
  hraAmount: number;
  monthlyGross: number;
  components: HrSalaryComponentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface HrSalaryComponentInput {
  code: string;
  name?: string;
  kind?: HrSalaryComponentKind;
  amount: number;
  taxable?: boolean;
  ssfApplicable?: boolean;
  sortOrder?: number;
}

export interface HrSalaryStructureInput {
  employeeId: string;
  effectiveFrom: string;
  monthlyGross?: number;
  basicAmount?: number;
  hraAmount?: number;
  components?: HrSalaryComponentInput[];
  ssfEligible?: boolean;
  overtimeRate?: number;
  tdsMonthly?: number;
  notes?: string | null;
}

export interface HrSalaryStructurePatch {
  ssfEligible?: boolean;
  overtimeRate?: number;
  tdsMonthly?: number;
  notes?: string | null;
  components?: HrSalaryComponentInput[];
}

export interface HrSalaryStructureQuery {
  branchId?: string;
  employeeId?: string;
  /** Resolve the newest structure effective on or before this date. */
  asOf?: string;
}

export async function getHrSalaryStructures(
  options: HrSalaryStructureQuery = {}
): Promise<HrSalaryStructureRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.employeeId) params.set('employeeId', options.employeeId);
  if (options.asOf) params.set('asOf', options.asOf);
  const query = params.toString();
  return fetchJson(`/api/hr/employee-salaries${query ? `?${query}` : ''}`);
}

export async function getHrSalaryStructure(id: string): Promise<HrSalaryStructureRecord> {
  return fetchJson(`/api/hr/employee-salaries/${encodeURIComponent(id)}`);
}

export async function createHrSalaryStructure(
  input: HrSalaryStructureInput
): Promise<HrSalaryStructureRecord> {
  return fetchJson('/api/hr/employee-salaries', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrSalaryStructure(
  id: string,
  patch: HrSalaryStructurePatch
): Promise<HrSalaryStructureRecord> {
  return fetchJson(`/api/hr/employee-salaries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrPayrollRuns(
  options: HrPayrollRunQuery = {}
): Promise<HrPayrollRunRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.periodKey) params.set('periodKey', options.periodKey);
  if (options.status) params.set('status', options.status);
  const query = params.toString();
  return fetchJson(`/api/payroll-runs${query ? `?${query}` : ''}`);
}

/** Finance ledger-view only: POSTED/PAID runs, no draft or approved rows. */
export async function getHrPayrollPostings(
  options: HrPayrollPostingsQuery = {}
): Promise<HrPayrollPostingRow[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  if (options.query) params.set('query', options.query);
  const query = params.toString();
  return fetchJson(`/api/payroll-runs/postings${query ? `?${query}` : ''}`);
}

export async function getHrPayrollRun(id: string): Promise<HrPayrollRunRecord> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}`);
}

/** Generates a DRAFT from effective structures, payroll inputs and statutory rules. */
export async function createHrPayrollRunDraft(
  input: HrPayrollDraftInput
): Promise<HrPayrollRunRecord> {
  return fetchJson('/api/payroll-runs/draft', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function approveHrPayrollRun(id: string): Promise<HrPayrollRunRecord> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function postHrPayrollRun(id: string): Promise<HrPayrollRunRecord> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}/post`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function payHrPayrollRun(
  id: string,
  input: HrPayrollPaymentInput = {}
): Promise<HrPayrollRunRecord> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}/pay`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function discardHrPayrollRunDraft(id: string): Promise<void> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Posted/paid runs only; drafts and approved runs return a 409. */
export async function getHrPayrollPayslips(id: string): Promise<HrPayrollPayslipsResponse> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}/payslips`);
}

export async function getHrPayrollPayslip(
  id: string,
  employeeId: string
): Promise<HrPayrollPayslipResponse> {
  return fetchJson(
    `/api/payroll-runs/${encodeURIComponent(id)}/payslips/${encodeURIComponent(employeeId)}`
  );
}

export async function getHrPayrollRegister(id: string): Promise<HrPayrollRegisterResponse> {
  return fetchJson(`/api/payroll-runs/${encodeURIComponent(id)}/register`);
}

/**
 * Downloads the manage-only bank transfer CSV. The server names the file; the
 * client uses that header so the downloaded name matches the posted run.
 */
export async function downloadHrPayrollBankFile(id: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/payroll-runs/${encodeURIComponent(id)}/bank-file`,
    { headers: apiHeaders() }
  );
  if (!res.ok) throw await documentError(res);
  const disposition = res.headers.get('content-disposition') || '';
  const filename =
    /filename="?([^";]+)"?/i.exec(disposition)?.[1] ||
    `payroll-bank-file-${id}.csv`;
  const href = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return filename;
}

/** One progressive monthly TDS band, versioned by its parent fiscal year. */
export interface HrTdsSlabRecord {
  id: string;
  configId: string;
  slabOrder: number;
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
}

export interface HrTdsSlabInput {
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
}

export interface HrStatutoryConfigRecord {
  id: string;
  fiscalYearId: string;
  fiscalYearCode: string;
  startDateAD: string;
  endDateAD: string;
  employeeSsfPercent: number;
  employerSsfPercent: number;
  notes: string | null;
  slabs: HrTdsSlabRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface HrStatutoryConfigInput {
  fiscalYearId: string;
  employeeSsfPercent?: number;
  employerSsfPercent?: number;
  slabs: HrTdsSlabInput[];
  notes?: string | null;
}

export interface HrStatutoryConfigPatch {
  employeeSsfPercent?: number;
  employerSsfPercent?: number;
  slabs?: HrTdsSlabInput[];
  notes?: string | null;
}

export interface HrStatutoryLineItem {
  label: string;
  code: string;
  kind: HrSalaryComponentKind | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
  amount: number;
}

export interface HrStatutorySlabResult {
  lowerBound: number;
  upperBound: number | null;
  ratePercent: number;
  taxableAmount: number;
  tdsAmount: number;
}

/** The computed TDS/SSF breakdown for one salary structure and as-of date. */
export interface HrStatutoryBreakdown {
  structureId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  branchId: string;
  effectiveFrom: string;
  asOf: string;
  fiscalYear: { id: string; code: string; startDateAD: string; endDateAD: string };
  configId: string;
  basicAmount: number;
  monthlyGross: number;
  ssfEligible: boolean;
  employeeSsfPercent: number;
  employerSsfPercent: number;
  employeeSsf: number;
  employerSsf: number;
  totalSsf: number;
  taxableGross: number;
  monthlyTds: number;
  annualTds: number;
  netAfterStatutory: number;
  slabs: HrStatutorySlabResult[];
  lineItems: HrStatutoryLineItem[];
}

export async function getHrStatutoryConfigs(
  options: { fiscalYearId?: string } = {}
): Promise<HrStatutoryConfigRecord[]> {
  const params = new URLSearchParams();
  if (options.fiscalYearId) params.set('fiscalYearId', options.fiscalYearId);
  const query = params.toString();
  return fetchJson(`/api/hr/statutory-configs${query ? `?${query}` : ''}`);
}

export async function getHrStatutoryConfig(id: string): Promise<HrStatutoryConfigRecord> {
  return fetchJson(`/api/hr/statutory-configs/${encodeURIComponent(id)}`);
}

export async function createHrStatutoryConfig(
  input: HrStatutoryConfigInput
): Promise<HrStatutoryConfigRecord> {
  return fetchJson('/api/hr/statutory-configs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrStatutoryConfig(
  id: string,
  patch: HrStatutoryConfigPatch
): Promise<HrStatutoryConfigRecord> {
  return fetchJson(`/api/hr/statutory-configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Computes the statutory breakdown for a structure at an AD as-of date. */
export async function getHrSalaryStatutory(
  salaryId: string,
  asOf: string
): Promise<HrStatutoryBreakdown> {
  return fetchJson(
    `/api/hr/employee-salaries/${encodeURIComponent(salaryId)}/statutory?asOf=${encodeURIComponent(asOf)}`
  );
}

// ---------------------------------------------------------------------------
// Phase 4 recruitment
// ---------------------------------------------------------------------------

export type HrRecruitmentRequisitionStatus = 'DRAFT' | 'OPEN' | 'ON_HOLD' | 'CLOSED';
export type HrRecruitmentCandidateStatus =
  | 'NEW'
  | 'SCREENING'
  | 'INTERVIEW'
  | 'OFFER'
  | 'HIRED'
  | 'REJECTED'
  | 'WITHDRAWN';
export type HrRecruitmentInterviewStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
export type HrRecruitmentInterviewMode = 'IN_PERSON' | 'PHONE' | 'VIDEO';
export type HrRecruitmentOfferStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN';

export interface HrRecruitmentRequisitionRecord {
  id: string;
  requisitionNo: string;
  branchId: string;
  branchName: string;
  title: string;
  department: string | null;
  designation: string | null;
  employmentType: string | null;
  openings: number;
  status: HrRecruitmentRequisitionStatus;
  openedOnAD: string | null;
  openedOnBS: string | null;
  closesOnAD: string | null;
  closesOnBS: string | null;
  description: string | null;
  candidateCount: number;
  hiredCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrRecruitmentRequisitionInput {
  branchId: string;
  title: string;
  department?: string | null;
  designation?: string | null;
  employmentType?: string | null;
  openings?: number;
  status?: HrRecruitmentRequisitionStatus;
  openedOnAD?: string | null;
  closesOnAD?: string | null;
  description?: string | null;
}

export interface HrRecruitmentCandidateRecord {
  id: string;
  candidateNo: string;
  requisitionId: string;
  requisitionNo: string;
  requisitionTitle: string;
  branchId: string;
  branchName: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  currentEmployer: string | null;
  status: HrRecruitmentCandidateStatus;
  notes: string | null;
  resumeFileName: string | null;
  resumeMimeType: string | null;
  resumeByteSize: number | null;
  resumeUploadedAt: string | null;
  hasResume: boolean;
  hiredEmployeeId: string | null;
  hiredEmployeeCode: string | null;
  interviewCount: number;
  lastInterviewOnAD: string | null;
  offerId: string | null;
  offerNo: string | null;
  offerStatus: HrRecruitmentOfferStatus | null;
  offerPositionTitle: string | null;
  offerMonthlySalary: number | null;
  offerStartDateAD: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrRecruitmentCandidateInput {
  requisitionId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  currentEmployer?: string | null;
  notes?: string | null;
}

export interface HrRecruitmentCandidatePatch {
  name?: string;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  currentEmployer?: string | null;
  status?: Exclude<HrRecruitmentCandidateStatus, 'HIRED'>;
  notes?: string | null;
}

export interface HrRecruitmentInterviewRecord {
  id: string;
  candidateId: string;
  candidateNo: string;
  candidateName: string;
  branchId: string;
  branchName: string;
  roundName: string;
  scheduledOnAD: string;
  scheduledOnBS: string | null;
  interviewer: string | null;
  mode: HrRecruitmentInterviewMode;
  status: HrRecruitmentInterviewStatus;
  rating: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrRecruitmentInterviewInput {
  candidateId: string;
  roundName: string;
  scheduledOnAD: string;
  interviewer?: string | null;
  mode?: HrRecruitmentInterviewMode;
  status?: HrRecruitmentInterviewStatus;
  rating?: number | null;
  notes?: string | null;
}

export interface HrRecruitmentInterviewPatch {
  roundName?: string;
  scheduledOnAD?: string;
  interviewer?: string | null;
  mode?: HrRecruitmentInterviewMode;
  status?: HrRecruitmentInterviewStatus;
  rating?: number | null;
  notes?: string | null;
}

export interface HrRecruitmentOfferRecord {
  id: string;
  offerNo: string;
  candidateId: string;
  candidateNo: string;
  candidateName: string;
  branchId: string;
  branchName: string;
  positionTitle: string;
  monthlySalary: number;
  startDateAD: string;
  startDateBS: string | null;
  offeredOnAD: string;
  offeredOnBS: string | null;
  status: HrRecruitmentOfferStatus;
  respondedOnAD: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrRecruitmentOfferInput {
  candidateId: string;
  positionTitle: string;
  monthlySalary: number;
  startDateAD: string;
  offeredOnAD?: string;
  status?: Extract<HrRecruitmentOfferStatus, 'DRAFT' | 'SENT'>;
  notes?: string | null;
}

export interface HrRecruitmentOfferPatch {
  positionTitle?: string;
  monthlySalary?: number;
  startDateAD?: string;
  offeredOnAD?: string;
  status?: HrRecruitmentOfferStatus;
  notes?: string | null;
}

export interface HrRecruitmentHireResult {
  candidateId: string;
  candidateNo: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  branchId: string;
  joiningDateAD: string;
  monthlySalary: number;
}

export interface HrRecruitmentQuery {
  branchId?: string | null;
  status?: string;
}

function recruitmentQuery(options: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' && value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function getHrRecruitmentRequisitions(
  options: HrRecruitmentQuery = {}
): Promise<HrRecruitmentRequisitionRecord[]> {
  return fetchJson(`/api/hr/recruitment/requisitions${recruitmentQuery(options)}`);
}

export async function createHrRecruitmentRequisition(
  input: HrRecruitmentRequisitionInput
): Promise<HrRecruitmentRequisitionRecord> {
  return fetchJson('/api/hr/recruitment/requisitions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrRecruitmentRequisition(
  id: string,
  patch: Partial<Omit<HrRecruitmentRequisitionInput, 'branchId'>>
): Promise<HrRecruitmentRequisitionRecord> {
  return fetchJson(`/api/hr/recruitment/requisitions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrRecruitmentCandidates(
  options: HrRecruitmentQuery & { requisitionId?: string | null } = {}
): Promise<HrRecruitmentCandidateRecord[]> {
  return fetchJson(`/api/hr/recruitment/candidates${recruitmentQuery(options)}`);
}

export async function createHrRecruitmentCandidate(
  input: HrRecruitmentCandidateInput
): Promise<HrRecruitmentCandidateRecord> {
  return fetchJson('/api/hr/recruitment/candidates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrRecruitmentCandidate(
  id: string,
  patch: HrRecruitmentCandidatePatch
): Promise<HrRecruitmentCandidateRecord> {
  return fetchJson(`/api/hr/recruitment/candidates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function uploadHrRecruitmentResume(
  candidateId: string,
  file: File
): Promise<HrRecruitmentCandidateRecord> {
  const params = new URLSearchParams({ fileName: file.name });
  const res = await fetch(
    `${API_BASE}/api/hr/recruitment/candidates/${encodeURIComponent(candidateId)}/resume?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(),
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    }
  );
  if (!res.ok) throw await documentError(res);
  return res.json();
}

export async function downloadHrRecruitmentResume(
  candidate: HrRecruitmentCandidateRecord
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/hr/recruitment/candidates/${encodeURIComponent(candidate.id)}/resume/content`,
    { headers: apiHeaders() }
  );
  if (!res.ok) throw await documentError(res);
  const href = URL.createObjectURL(await res.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = candidate.resumeFileName || 'resume';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function getHrRecruitmentInterviews(
  options: HrRecruitmentQuery & { candidateId?: string | null } = {}
): Promise<HrRecruitmentInterviewRecord[]> {
  return fetchJson(`/api/hr/recruitment/interviews${recruitmentQuery(options)}`);
}

export async function createHrRecruitmentInterview(
  input: HrRecruitmentInterviewInput
): Promise<HrRecruitmentInterviewRecord> {
  return fetchJson('/api/hr/recruitment/interviews', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrRecruitmentInterview(
  id: string,
  patch: HrRecruitmentInterviewPatch
): Promise<HrRecruitmentInterviewRecord> {
  return fetchJson(`/api/hr/recruitment/interviews/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrRecruitmentOffers(
  options: HrRecruitmentQuery & { candidateId?: string | null } = {}
): Promise<HrRecruitmentOfferRecord[]> {
  return fetchJson(`/api/hr/recruitment/offers${recruitmentQuery(options)}`);
}

export async function createHrRecruitmentOffer(
  input: HrRecruitmentOfferInput
): Promise<HrRecruitmentOfferRecord> {
  return fetchJson('/api/hr/recruitment/offers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrRecruitmentOffer(
  id: string,
  patch: HrRecruitmentOfferPatch
): Promise<HrRecruitmentOfferRecord> {
  return fetchJson(`/api/hr/recruitment/offers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function hireHrRecruitmentCandidate(
  candidateId: string,
  employeeCode: string
): Promise<HrRecruitmentHireResult> {
  return fetchJson(`/api/hr/recruitment/candidates/${encodeURIComponent(candidateId)}/hire`, {
    method: 'POST',
    body: JSON.stringify({ employeeCode }),
  });
}

// ---------------------------------------------------------------------------
// Phase 4 performance — appraisal cycles, goals and 360 feedback
// ---------------------------------------------------------------------------

export type HrReviewCycleStatus = 'DRAFT' | 'OPEN' | 'SIGNED_OFF';
export type HrGoalStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type HrFeedbackRelationship = 'SELF' | 'MANAGER' | 'PEER' | 'REPORT';

export interface HrReviewCycleRecord {
  id: string;
  cycleNo: string;
  branchId: string;
  branchName: string;
  name: string;
  periodStartAD: string;
  periodStartBS: string | null;
  periodEndAD: string;
  periodEndBS: string | null;
  status: HrReviewCycleStatus;
  instructions: string | null;
  signedOffBy: string | null;
  signedOffAt: string | null;
  isDemo: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  goalCount: number;
  employeeCount: number;
  feedbackCount: number;
}

export interface HrReviewCycleInput {
  branchId: string;
  name: string;
  periodStartAD: string;
  periodEndAD: string;
  status?: Exclude<HrReviewCycleStatus, 'SIGNED_OFF'>;
  instructions?: string | null;
}

export type HrReviewCyclePatch = Partial<Omit<HrReviewCycleInput, 'branchId'>>;

export interface HrReviewCycleQuery {
  branchId?: string;
  status?: HrReviewCycleStatus;
}

export interface HrGoalRecord {
  id: string;
  goalNo: string;
  cycleId: string;
  cycleNo: string;
  cycleName: string;
  cycleStatus: HrReviewCycleStatus;
  branchId: string;
  branchName: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  title: string;
  description: string | null;
  weight: number;
  targetValue: string | null;
  achievement: string | null;
  status: HrGoalStatus;
  selfRating: number | null;
  managerRating: number | null;
  finalRating: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrGoalInput {
  cycleId: string;
  employeeId: string;
  title: string;
  description?: string | null;
  weight?: number;
  targetValue?: string | null;
  achievement?: string | null;
  status?: HrGoalStatus;
  selfRating?: number | null;
  managerRating?: number | null;
  finalRating?: number | null;
}

export type HrGoalPatch = Partial<Omit<HrGoalInput, 'cycleId' | 'employeeId'>>;

export interface HrGoalQuery {
  branchId?: string;
  cycleId?: string;
  employeeId?: string;
  status?: HrGoalStatus;
}

export interface HrPerformanceFeedbackRecord {
  id: string;
  cycleId: string;
  cycleNo: string;
  cycleName: string;
  cycleStatus: HrReviewCycleStatus;
  branchId: string;
  branchName: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  reviewerEmployeeId: string;
  reviewerEmployeeCode: string;
  reviewerEmployeeName: string;
  relationship: HrFeedbackRelationship;
  rating: number;
  strengths: string | null;
  improvements: string | null;
  comments: string | null;
  submittedBy: string | null;
  submittedAt: string;
}

export interface HrPerformanceFeedbackInput {
  cycleId: string;
  employeeId: string;
  reviewerEmployeeId: string;
  relationship: HrFeedbackRelationship;
  rating: number;
  strengths?: string | null;
  improvements?: string | null;
  comments?: string | null;
}

export interface HrPerformanceFeedbackQuery {
  branchId?: string;
  cycleId?: string;
  employeeId?: string;
  reviewerEmployeeId?: string;
}

function performanceQuery(options: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value && value !== 'ALL') params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function getHrReviewCycles(
  options: HrReviewCycleQuery = {}
): Promise<HrReviewCycleRecord[]> {
  return fetchJson(
    `/api/hr/performance/cycles${performanceQuery({
      branchId: options.branchId,
      status: options.status,
    })}`
  );
}

export async function createHrReviewCycle(
  input: HrReviewCycleInput
): Promise<HrReviewCycleRecord> {
  return fetchJson('/api/hr/performance/cycles', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrReviewCycle(
  id: string,
  patch: HrReviewCyclePatch
): Promise<HrReviewCycleRecord> {
  return fetchJson(`/api/hr/performance/cycles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function signOffHrReviewCycle(id: string): Promise<HrReviewCycleRecord> {
  return fetchJson(`/api/hr/performance/cycles/${encodeURIComponent(id)}/sign-off`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getHrGoals(options: HrGoalQuery = {}): Promise<HrGoalRecord[]> {
  return fetchJson(
    `/api/hr/performance/goals${performanceQuery({
      branchId: options.branchId,
      cycleId: options.cycleId,
      employeeId: options.employeeId,
      status: options.status,
    })}`
  );
}

export async function createHrGoal(input: HrGoalInput): Promise<HrGoalRecord> {
  return fetchJson('/api/hr/performance/goals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrGoal(id: string, patch: HrGoalPatch): Promise<HrGoalRecord> {
  return fetchJson(`/api/hr/performance/goals/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getHrPerformanceFeedback(
  options: HrPerformanceFeedbackQuery = {}
): Promise<HrPerformanceFeedbackRecord[]> {
  return fetchJson(
    `/api/hr/performance/feedback${performanceQuery({
      branchId: options.branchId,
      cycleId: options.cycleId,
      employeeId: options.employeeId,
      reviewerEmployeeId: options.reviewerEmployeeId,
    })}`
  );
}

export async function createHrPerformanceFeedback(
  input: HrPerformanceFeedbackInput
): Promise<HrPerformanceFeedbackRecord> {
  return fetchJson('/api/hr/performance/feedback', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getHrLifecycleChecklists(
  options: HrLifecycleChecklistQuery = {}
): Promise<HrLifecycleChecklistRecord[]> {
  const params = new URLSearchParams();
  if (options.branchId && options.branchId !== 'ALL') params.set('branchId', options.branchId);
  if (options.type) params.set('type', options.type);
  if (options.status) params.set('status', options.status);
  if (options.employeeId) params.set('employeeId', options.employeeId);
  const query = params.toString();
  return fetchJson(`/api/hr/lifecycle-checklists${query ? `?${query}` : ''}`);
}

export async function getHrLifecycleChecklist(id: string): Promise<HrLifecycleChecklistDetail> {
  return fetchJson(`/api/hr/lifecycle-checklists/${encodeURIComponent(id)}`);
}

export async function createHrLifecycleChecklist(
  input: HrLifecycleChecklistInput
): Promise<HrLifecycleChecklistDetail> {
  return fetchJson('/api/hr/lifecycle-checklists', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateHrLifecycleChecklist(
  id: string,
  patch: HrLifecycleChecklistPatch
): Promise<HrLifecycleChecklistRecord> {
  return fetchJson(`/api/hr/lifecycle-checklists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function completeHrLifecycleChecklist(
  id: string
): Promise<HrLifecycleChecklistRecord> {
  return fetchJson(`/api/hr/lifecycle-checklists/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function addHrLifecycleChecklistItem(
  id: string,
  input: HrLifecycleItemInput
): Promise<HrLifecycleChecklistItem> {
  return fetchJson(`/api/hr/lifecycle-checklists/${encodeURIComponent(id)}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function completeHrLifecycleChecklistItem(
  id: string,
  itemId: string
): Promise<HrLifecycleChecklistItem> {
  return fetchJson(
    `/api/hr/lifecycle-checklists/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/complete`,
    { method: 'POST', body: JSON.stringify({}) }
  );
}

export type HrLifecycleType = 'ONBOARDING' | 'OFFBOARDING';
export type HrLifecycleStatus = 'DRAFT' | 'OPEN' | 'COMPLETED';
export type HrLifecycleCategory = 'DOCUMENT' | 'ASSET' | 'ACCOUNT' | 'ACCESS' | 'OTHER';
export type HrLifecycleAction =
  | 'NONE'
  | 'ISSUE_ASSET'
  | 'RETURN_ASSET'
  | 'ACTIVATE_ACCOUNT'
  | 'DEACTIVATE_ACCOUNT';

export interface HrLifecycleAccount {
  userId: string;
  email: string | null;
  name: string | null;
  status: string | null;
  role: string | null;
}

export interface HrLifecycleAsset {
  id: string;
  tagNumber: string;
  name: string;
  category: string;
  status: string;
  branchId: string;
  assignedEmployeeId: string | null;
  assignedEmployeeName?: string | null;
}

export interface HrLifecycleChecklistItem {
  id: string;
  checklistId: string;
  category: HrLifecycleCategory;
  title: string;
  description: string | null;
  required: boolean;
  status: 'PENDING' | 'DONE';
  action: HrLifecycleAction;
  assetId: string | null;
  assetTagNumber: string | null;
  assetName: string | null;
  assetCategory: string | null;
  assetStatus: string | null;
  assetBranchId: string | null;
  assetAssignedEmployeeId: string | null;
  sortOrder: number;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrLifecycleChecklistRecord {
  id: string;
  checklistNo: string;
  employeeId: string;
  branchId: string;
  branchName: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  checklistType: HrLifecycleType;
  status: HrLifecycleStatus;
  effectiveDateAD: string;
  effectiveDateBS: string | null;
  notes: string | null;
  completedBy: string | null;
  completedAt: string | null;
  isDemo: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string | null;
  accountEmail: string | null;
  accountName: string | null;
  accountStatus: string | null;
  accountRole: string | null;
  itemCount: number;
  doneCount: number;
  requiredPendingCount: number;
  assetCount: number;
  pendingAssetCount: number;
}

export interface HrLifecycleChecklistDetail extends HrLifecycleChecklistRecord {
  account: HrLifecycleAccount | null;
  items: HrLifecycleChecklistItem[];
  availableAssets: HrLifecycleAsset[];
}

export interface HrLifecycleChecklistInput {
  employeeId: string;
  type: HrLifecycleType;
  effectiveDateAD: string;
  notes?: string | null;
}

export interface HrLifecycleChecklistPatch {
  status?: Exclude<HrLifecycleStatus, 'COMPLETED'>;
  effectiveDateAD?: string;
  notes?: string | null;
}

export interface HrLifecycleChecklistQuery {
  branchId?: string;
  type?: HrLifecycleType;
  status?: HrLifecycleStatus;
  employeeId?: string;
}

export interface HrLifecycleItemInput {
  category: HrLifecycleCategory;
  title: string;
  description?: string | null;
  required?: boolean;
  assetId?: string | null;
}
