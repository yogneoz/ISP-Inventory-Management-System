/**
 * Branch view of the Organizational Chart.
 *
 * A branch does not float on its own: it reports into the company structure.
 * So this view keeps the full catalogue (Board → CEO → COO → departments) and
 * puts two kinds of people on it:
 *
 *   * the **head-office core team** — employees whose designation scope is
 *     company-wide (All Branches / Head Office / Central). These are the
 *     departments that support every branch, and they never become part of a
 *     branch's own team.
 *   * the **selected branch's team** — employees who work in that branch and
 *     hold a branch-scoped post (Assigned Branch / Cluster / Hub).
 *
 * A branch employee whose post is company-wide is not duplicated into the
 * branch team; they are already counted in the head-office core.
 */
import type {
  HrOrgCatalogue,
  HrOrgChartEmployee,
  HrOrgDesignationCatalogueRow,
} from '../services/api';

export type EmployeeTeam = 'CORE' | 'BRANCH';

export interface BranchHierarchy {
  /** The full catalogue, so the governance chain and departments stay visible. */
  catalogue: HrOrgCatalogue;
  employeesByDesignation: Map<string, HrOrgChartEmployee[]>;
  branchId: string | null;
  branchName: string;
  headOfficeBranchId: string | null;
  headOfficeEmployees: HrOrgChartEmployee[];
  branchEmployees: HrOrgChartEmployee[];
  /** Branch people whose post is company-wide; shown in the core team instead. */
  coreFromBranch: HrOrgChartEmployee[];
  /** Active employees with no catalogue designation — cannot be placed. */
  unlinkedEmployees: HrOrgChartEmployee[];
  employeeCount: number;
  postCount: number;
  teamOf: (employee: HrOrgChartEmployee) => EmployeeTeam;
}

/** Scope strings that describe a company-wide / head-office function. */
export const CORE_SCOPE = /^(all branches|head office|central|company-wide)/i;

export const isCoreScope = (scope: string | null | undefined): boolean =>
  Boolean(scope && CORE_SCOPE.test(scope));

export function buildBranchHierarchy(
  catalogue: HrOrgCatalogue,
  employees: HrOrgChartEmployee[],
  branchId: string | null
): BranchHierarchy {
  const byId = new Map<string, HrOrgDesignationCatalogueRow>(
    catalogue.designations.map((row) => [row.id, row])
  );
  const scopeOf = (employee: HrOrgChartEmployee): string | null =>
    employee.designationId ? byId.get(employee.designationId)?.branchScope ?? null : null;

  const headOfficeBranchId =
    employees.find((employee) => /head office/i.test(employee.branchName || ''))?.branchId ?? null;

  const coreEmployees = employees.filter((employee) => isCoreScope(scopeOf(employee)));
  // Core people belong in the view when they sit at head office or in the
  // branch being viewed; a core-post person in another branch is not this
  // branch's team and would only blur the two groups.
  const headOfficeCore = coreEmployees.filter(
    (employee) =>
      !headOfficeBranchId ||
      employee.branchId === headOfficeBranchId ||
      employee.branchId === branchId
  );
  const branchAll = branchId
    ? employees.filter((employee) => employee.branchId === branchId)
    : [];
  const branchTeam = branchAll.filter((employee) => !isCoreScope(scopeOf(employee)));
  const coreFromBranch = branchAll.filter((employee) => isCoreScope(scopeOf(employee)));

  const seen = new Set<string>();
  const visible: HrOrgChartEmployee[] = [];
  for (const employee of [...headOfficeCore, ...branchTeam]) {
    if (seen.has(employee.id)) continue;
    seen.add(employee.id);
    visible.push(employee);
  }

  const employeesByDesignation = new Map<string, HrOrgChartEmployee[]>();
  for (const employee of visible) {
    if (!employee.designationId) continue;
    const bucket = employeesByDesignation.get(employee.designationId) ?? [];
    bucket.push(employee);
    employeesByDesignation.set(employee.designationId, bucket);
  }

  const unlinkedEmployees = employees.filter((employee) => !employee.designationId);
  const branchName =
    branchAll[0]?.branchName || employees.find((employee) => employee.branchId === branchId)?.branchName || 'Selected branch';

  return {
    catalogue,
    employeesByDesignation,
    branchId,
    branchName,
    headOfficeBranchId,
    headOfficeEmployees: headOfficeCore,
    branchEmployees: branchTeam,
    coreFromBranch,
    unlinkedEmployees,
    employeeCount: visible.length,
    postCount: employeesByDesignation.size,
    teamOf: (employee) => (isCoreScope(scopeOf(employee)) ? 'CORE' : 'BRANCH'),
  };
}
