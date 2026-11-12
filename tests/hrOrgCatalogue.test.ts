/**
 * The refactored HR organisation catalogue.
 *
 * PROVES:
 *   1. The seeded master sheet has the workbook's shape: 51 graded
 *      designations, 7 departments, G1-G10, 4 clusters and 24 planned branches,
 *      with no duplicate code or name.
 *   2. Every reporting line and department head points at a real designation,
 *      so the org chart can never build a dangling edge.
 *   3. The salary bands are monotonic per grade and keep the statutory G1 floor.
 *   4. The schema, the API and the navigation agree on where this lives: the
 *      profile tables, the two read endpoints, the /people/org-chart tab and
 *      the "HR Org Master" group with Organization + NOC sections.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  HR_BRANCH_PLAN,
  HR_CLUSTERS,
  HR_DEPARTMENTS,
  HR_DESIGNATIONS,
  HR_GRADES,
  HR_WORK_STATIONS,
} from '../scripts/seed/hrOrgCatalogue';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const names = new Set(HR_DESIGNATIONS.map((row) => row.name));

describe('HR organisation catalogue (master sheet v2)', () => {
  test('51 graded designations across 7 departments, without duplicate identity', () => {
    assert.equal(HR_DESIGNATIONS.length, 51, 'the master sheet has 51 roles');
    assert.equal(HR_DEPARTMENTS.length, 7, 'the corporate architecture has 7 departments');
    assert.equal(HR_GRADES.length, 10, 'the grading matrix is G1-G10');
    assert.equal(HR_CLUSTERS.length, 4, 'four regional clusters');
    assert.equal(HR_BRANCH_PLAN.length, 24, 'the branch plan covers 24 branches');
    assert.ok(HR_WORK_STATIONS.length >= 4, 'head office, the call centre and the hubs are work stations');

    assert.equal(new Set(HR_DESIGNATIONS.map((row) => row.code)).size, 51, 'role codes are unique');
    assert.equal(names.size, 51, 'designation names are unique');
    for (const row of HR_DESIGNATIONS) {
      assert.match(row.code, /^DES-\d{2}$/, `${row.name}: role code format`);
      assert.ok(row.grade in Object.fromEntries(HR_GRADES.map((grade) => [grade.grade, true])), `${row.name}: known grade`);
      assert.ok(
        HR_DEPARTMENTS.some((department) => department.name === row.department),
        `${row.name}: department "${row.department}" must exist`
      );
      assert.ok(row.responsibilities.length > 40, `${row.name}: job description must be meaningful`);
    }
  });

  test('every reporting line and department head resolves to a real post', () => {
    for (const row of HR_DESIGNATIONS) {
      if (row.reportsTo) {
        assert.ok(names.has(row.reportsTo), `${row.name} reports to unknown post "${row.reportsTo}"`);
        assert.notEqual(row.reportsTo, row.name, `${row.name} cannot report to itself`);
      } else {
        assert.ok(row.reportsToLabel, `${row.name}: a root post needs a descriptive label`);
      }
    }
    for (const department of HR_DEPARTMENTS) {
      assert.ok(names.has(department.head), `${department.name}: head "${department.head}" must be a designation`);
    }

    const roots = HR_DESIGNATIONS.filter((row) => !row.reportsTo).map((row) => row.name);
    assert.ok(roots.includes('Chief Executive Officer'), 'the CEO is the internal root');
    const managers = HR_BRANCH_PLAN.filter((branch) => branch.headDesignation === 'Branch Manager');
    const inCharges = HR_BRANCH_PLAN.filter((branch) => branch.headDesignation === 'Branch In-charge');
    assert.equal(managers.length, 8, '8 Tier 1-2 branches keep a Branch Manager');
    assert.equal(inCharges.length, 16, '16 Tier 3 branches get a Branch In-charge');
    for (const branch of HR_BRANCH_PLAN) {
      assert.ok(
        HR_CLUSTERS.some((cluster) => cluster.id === branch.clusterId),
        `${branch.code}: unknown cluster "${branch.clusterId}"`
      );
      assert.ok(names.has(branch.headDesignation), `${branch.code}: head post must exist`);
    }
  });

  test('salary bands are monotonic and keep the statutory G1 floor', () => {
    const byGrade = new Map(HR_GRADES.map((grade) => [grade.grade, grade]));
    for (const grade of HR_GRADES) {
      assert.ok(
        grade.min <= grade.step1 &&
          grade.step1 <= grade.step2 &&
          grade.step2 <= grade.step3 &&
          grade.step3 <= grade.max,
        `${grade.grade}: steps must run min -> max`
      );
      assert.ok(grade.promotionRule.length > 10, `${grade.grade}: promotion rule must be stated`);
    }
    assert.equal(byGrade.get('G1')?.min, 19550, 'G1 starts at the statutory minimum');
    assert.equal(byGrade.get('G10')?.max, 320000, 'the CEO band tops out at 3,20,000');

    // The workbook derives each role's band from its grade; no designation may
    // carry a grade the matrix does not define.
    for (const row of HR_DESIGNATIONS) {
      assert.ok(byGrade.has(row.grade), `${row.name}: grade ${row.grade} is not in the matrix`);
    }
  });

  test('schema, API and navigation agree on the catalogue and the chart', () => {
    const schema = read('scripts/schema.sql');
    for (const table of [
      'hr_salary_grades',
      'hr_designation_profiles',
      'hr_department_profiles',
      'hr_org_clusters',
      'hr_branch_plan',
    ]) {
      assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must exist`);
    }
    assert.match(schema, /department_master_id VARCHAR\(50\)/, 'a profile names its department');
    assert.match(schema, /reports_to_master_id VARCHAR\(50\)/, 'a profile names its solid line');

    const routes = read('server/src/routes/hr.routes.ts');
    assert.match(routes, /'\/api\/hr\/org-catalogue'/, 'the catalogue endpoint is mounted');
    assert.match(routes, /'\/api\/hr\/org-chart'/, 'the chart endpoint is mounted');
    const controller = read('server/src/controllers/hrOrg.controller.ts');
    assert.match(controller, /buildHrOrgChartQuery\(/, 'the chart reads the scoped employee query');

    const paths = read('client/src/routes/appPaths.ts');
    assert.match(paths, /'org-chart': '\/people\/org-chart'/, 'the chart has a canonical path');
    const permissions = read('client/src/routes/tabPermissions.ts');
    assert.match(permissions, /'org-chart': HR_VIEW/, 'the chart reads with the HR view grant');

    const sidebar = read('client/src/components/layout/Sidebar.tsx');
    assert.match(sidebar, /title: 'Master Data & Setup'/, 'one setup group owns the masters');
    assert.equal(sidebar.includes("title: 'HR Org Master'"), false, 'HR Org Master is not a top-level group');
    assert.match(sidebar, /section: 'HR Org Master'/, 'Org Masters and Branch Management sit under HR Org Master');
    assert.match(sidebar, /section: 'NOC'/, 'Location Management sits under NOC');
    assert.match(sidebar, /id: 'org-chart' as NavTab/, 'the chart is a People & HR item');
  });
});
