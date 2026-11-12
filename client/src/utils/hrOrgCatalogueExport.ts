/**
 * CSV exports for the refactored HR catalogue.
 *
 * The workbook has four sheets and each CSV mirrors one of them, so the file a
 * manager downloads opens with the same columns and the same order as
 * `Corporate_Designations_Salaries_JDs_v2`:
 *
 *   Master Designations, Salary Slabs & Job Descriptions  -> master sheet
 *   Corporate Salary Grading Matrix                       -> grading matrix
 *   Refactored 7-Department Corporate Architecture        -> departments
 *   24 Branches Organized into 4 Regional Clusters        -> branch plan
 *
 * A designation's min/mid/max is derived from its grade, exactly as the
 * workbook's formulas do, so the master CSV prints the grade's numbers rather
 * than a second stored copy.
 */
import type { HrOrgCatalogue } from '../services/api';

export type HrCatalogueSheetId = 'DESIGNATIONS' | 'GRADES' | 'DEPARTMENTS' | 'BRANCHES';

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (headers: string[], rows: unknown[][]): string =>
  [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');

const gradeMap = (catalogue: HrOrgCatalogue) =>
  new Map(catalogue.grades.map((grade) => [grade.grade, grade]));

/** Sheet 1 — Master Designations, Salary Slabs & Job Descriptions. */
export function buildDesignationSheetCsv(catalogue: HrOrgCatalogue): string {
  const grades = gradeMap(catalogue);
  return toCsv(
    [
      'Role Code',
      'Department',
      'Refactored Designation',
      'Status',
      'Grade',
      'Min Salary (NPR)',
      'Midpoint Salary (NPR)',
      'Max Salary (NPR)',
      'Reports To',
      'Branch Scope',
      'System UserRole',
      'Key Job Responsibilities & Duties',
      'Dotted Line To',
      'Phase',
      'v2 Change vs Previous Version',
    ],
    catalogue.designations.map((row) => {
      const grade = row.grade ? grades.get(row.grade) : undefined;
      return [
        row.code,
        row.department,
        row.name,
        row.roleStatus,
        row.grade,
        row.bandMin ?? grade?.min ?? '',
        grade?.step2 ?? '',
        row.bandMax ?? grade?.max ?? '',
        row.reportsTo || row.reportsToLabel || '—',
        row.branchScope,
        row.systemRole,
        row.responsibilities,
        row.dottedLineTo || '—',
        row.phase || '—',
        row.changeNote || '—',
      ];
    })
  );
}

/** Sheet 2 — Corporate Salary Grading Matrix (G1-G10 with appraisal steps). */
export function buildGradingMatrixCsv(catalogue: HrOrgCatalogue): string {
  return toCsv(
    [
      'Grade',
      'Career Band',
      'Role Tier Description',
      'Min Salary (NPR)',
      'Appraisal Step 1 (Yr 1)',
      'Appraisal Step 2 / Midpoint (Yr 2)',
      'Appraisal Step 3 (Yr 3)',
      'Max Salary (NPR)',
      'Band Spread %',
      'Promotion & Appraisal Rule',
    ],
    catalogue.grades.map((grade) => [
      grade.grade,
      grade.careerBand,
      grade.roleTier,
      grade.min,
      grade.step1,
      grade.step2,
      grade.step3,
      grade.max,
      grade.bandSpread ?? '',
      grade.promotionRule || '',
    ])
  );
}

/** Sheet 3 — Refactored 7-Department Corporate Architecture. */
export function buildDepartmentsSheetCsv(catalogue: HrOrgCatalogue): string {
  return toCsv(
    [
      'Dept Code',
      'Department Name',
      'Department Head',
      'Head Grade',
      'Total Roles',
      'Core Mandate & Governance Separation',
    ],
    catalogue.departments.map((department) => {
      const roles = catalogue.designations.filter((row) => row.departmentId === department.id);
      const head = department.headId
        ? catalogue.designations.find((row) => row.id === department.headId)
        : undefined;
      return [
        department.code,
        department.name,
        department.head || '',
        head?.grade ?? '',
        roles.length,
        department.mandate || '',
      ];
    })
  );
}

/** Sheet 4 — 24 Branches Organized into 4 Regional Clusters. */
export function buildBranchPlanCsv(catalogue: HrOrgCatalogue): string {
  return toCsv(
    [
      'Branch ID',
      'Branch Name',
      'Assigned Cluster',
      'Cluster Hub',
      'Province',
      'Branch Tier',
      'Branch Head Post',
    ],
    catalogue.branchPlan.map((branch) => [
      branch.code,
      branch.name,
      branch.clusterName,
      branch.clusterHub,
      branch.province,
      branch.tier,
      branch.headDesignation,
    ])
  );
}

export const HR_CATALOGUE_SHEETS: Array<{
  id: HrCatalogueSheetId;
  label: string;
  file: string;
  build: (catalogue: HrOrgCatalogue) => string;
}> = [
  { id: 'DESIGNATIONS', label: 'Master sheet', file: 'hr-master-designations.csv', build: buildDesignationSheetCsv },
  { id: 'GRADES', label: 'Grading matrix', file: 'hr-salary-grading-matrix.csv', build: buildGradingMatrixCsv },
  { id: 'DEPARTMENTS', label: 'Departments', file: 'hr-departments.csv', build: buildDepartmentsSheetCsv },
  { id: 'BRANCHES', label: 'Branches', file: 'hr-branch-plan.csv', build: buildBranchPlanCsv },
];

/**
 * Browser download. The BOM keeps Nepali text and the en-IN number grouping
 * readable when the CSV opens in Excel instead of a text editor.
 */
export function downloadCsv(file: string, csv: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
