/**
 * CSV exports for the refactored HR catalogue.
 *
 * PROVES:
 *   1. The master sheet prints the workbook's columns, and a role's salary
 *      band is taken from its grade (min / midpoint / max) rather than a
 *      second stored copy.
 *   2. Commas and quotes in a job description survive CSV escaping.
 *   3. The grading, department and branch sheets use their workbook headers,
 *      and each export has its own file name.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HR_CATALOGUE_SHEETS,
  buildBranchPlanCsv,
  buildDepartmentsSheetCsv,
  buildDesignationSheetCsv,
  buildGradingMatrixCsv,
  toCsv,
} from '../client/src/utils/hrOrgCatalogueExport';
import type { HrOrgCatalogue } from '../client/src/services/api';

const catalogue: HrOrgCatalogue = {
  grades: [
    {
      grade: 'G6',
      careerBand: 'Supervisory / Lead',
      roleTier: 'Branch In-charge / Senior Network Engineer',
      min: 48000,
      step1: 54000,
      step2: 60000,
      step3: 67000,
      max: 75000,
      bandSpread: 0.5625,
      promotionRule: '2-3 annual appraisals before G7 promotion',
    },
  ],
  departments: [
    {
      id: 'dept-net',
      name: 'Core Network & IT',
      code: 'DEPT-NET',
      headId: 'des-47',
      head: 'Senior Network Engineer',
      mandate: 'Core routing, NOC and IT systems.',
    },
  ],
  designations: [
    {
      id: 'des-47',
      name: 'Senior Network Engineer',
      code: 'DES-47',
      departmentId: 'dept-net',
      department: 'Core Network & IT',
      grade: 'G6',
      careerBand: 'Supervisory / Lead',
      bandMin: 48000,
      bandMax: 75000,
      reportsToId: null,
      reportsTo: null,
      reportsToLabel: 'Head of Network & IT (vacant)',
      dottedLineTo: null,
      branchScope: 'Head Office / Core',
      systemRole: 'NETWORK_ADMIN',
      responsibilities: 'Leads L3 troubleshooting, change control, "design reviews", and capacity planning.',
      phase: 'Phase 1',
      roleStatus: 'NEW (v2)',
      changeNote: 'NEW. Closes the gap.',
    },
  ],
  clusters: [
    {
      id: 'CL-KC',
      name: 'Koshi Central',
      hub: 'Itahari Hub',
      province: 'Koshi',
      notes: null,
      branchCount: 1,
    },
  ],
  branchPlan: [
    {
      code: 'BR-01',
      name: 'Itahari Branch',
      clusterId: 'CL-KC',
      clusterName: 'Koshi Central',
      clusterHub: 'Itahari Hub',
      province: 'Koshi',
      tier: 'Regional Hub (Tier 1)',
      headDesignation: 'Branch Manager',
      branchId: null,
    },
  ],
};

describe('HR catalogue CSV exports', () => {
  test('master sheet uses the workbook columns and the grade-derived salary band', () => {
    const csv = buildDesignationSheetCsv(catalogue);
    const [header, row] = csv.split('\r\n');
    assert.equal(
      header,
      'Role Code,Department,Refactored Designation,Status,Grade,Min Salary (NPR),Midpoint Salary (NPR),Max Salary (NPR),Reports To,Branch Scope,System UserRole,Key Job Responsibilities & Duties,Dotted Line To,Phase,v2 Change vs Previous Version'
    );
    assert.match(row, /^DES-47,Core Network & IT,Senior Network Engineer,NEW \(v2\),G6,48000,60000,75000,/);
    assert.match(row, /"Leads L3 troubleshooting, change control, ""design reviews"", and capacity planning\."/);
    assert.match(row, /Head of Network & IT \(vacant\)/);
    assert.match(row, /Phase 1/);
  });

  test('grading, department and branch sheets keep their workbook headers', () => {
    const grading = buildGradingMatrixCsv(catalogue).split('\r\n');
    assert.equal(
      grading[0],
      'Grade,Career Band,Role Tier Description,Min Salary (NPR),Appraisal Step 1 (Yr 1),Appraisal Step 2 / Midpoint (Yr 2),Appraisal Step 3 (Yr 3),Max Salary (NPR),Band Spread %,Promotion & Appraisal Rule'
    );
    assert.match(grading[1], /^G6,Supervisory \/ Lead,.*,48000,54000,60000,67000,75000,0\.5625,/);

    const departments = buildDepartmentsSheetCsv(catalogue).split('\r\n');
    assert.equal(
      departments[0],
      'Dept Code,Department Name,Department Head,Head Grade,Total Roles,Core Mandate & Governance Separation'
    );
    assert.equal(
      departments[1],
      'DEPT-NET,Core Network & IT,Senior Network Engineer,G6,1,"Core routing, NOC and IT systems."'
    );

    const branches = buildBranchPlanCsv(catalogue).split('\r\n');
    assert.equal(
      branches[0],
      'Branch ID,Branch Name,Assigned Cluster,Cluster Hub,Province,Branch Tier,Branch Head Post'
    );
    assert.equal(branches[1], 'BR-01,Itahari Branch,Koshi Central,Itahari Hub,Koshi,Regional Hub (Tier 1),Branch Manager');
  });

  test('every export has its own file, and cells escape quotes and commas', () => {
    assert.equal(HR_CATALOGUE_SHEETS.length, 4);
    assert.equal(new Set(HR_CATALOGUE_SHEETS.map((sheet) => sheet.file)).size, 4, 'one file per sheet');
    assert.equal(new Set(HR_CATALOGUE_SHEETS.map((sheet) => sheet.id)).size, 4, 'one id per sheet');
    for (const sheet of HR_CATALOGUE_SHEETS) {
      assert.match(sheet.file, /\.csv$/, `${sheet.id}: must be a .csv`);
      assert.ok(sheet.build(catalogue).length > 0, `${sheet.id}: builds content`);
    }
    assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"']]), 'a,b\r\n"x,y","say ""hi"""');
    assert.equal(toCsv(['a'], [[null]]), 'a\r\n');
  });
});
