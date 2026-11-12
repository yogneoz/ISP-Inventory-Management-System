/**
 * Branch view of the Organizational Chart.
 *
 * PROVES:
 *   1. The view keeps the full catalogue (Board → CEO → COO → departments) so a
 *      branch still shows its top-level chain, and places the head-office core
 *      team plus the selected branch's own team on it.
 *   2. A branch employee who holds a company-wide post is counted once, in the
 *      core team — never duplicated into the branch team.
 *   3. Other branches' people stay out, and every visible person is tagged CORE
 *      or BRANCH for the avatar badge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBranchHierarchy } from '../client/src/utils/hrOrgBranchView';
import type { HrOrgCatalogue, HrOrgChartEmployee } from '../client/src/services/api';

const post = (
  id: string,
  name: string,
  code: string,
  departmentId: string,
  reportsToId: string | null,
  branchScope: string
) => ({
  id,
  name,
  code,
  departmentId,
  department: departmentId,
  grade: 'G6',
  careerBand: 'Supervisory / Lead',
  bandMin: 48000,
  bandMax: 75000,
  reportsToId,
  reportsTo: null,
  reportsToLabel: null,
  dottedLineTo: null,
  branchScope,
  systemRole: 'HEAD_OFFICE_ADMIN',
  responsibilities: `${name} duties.`,
  phase: 'Phase 1',
  roleStatus: 'Refactored',
  changeNote: null,
});

const catalogue: HrOrgCatalogue = {
  grades: [],
  clusters: [],
  branchPlan: [],
  departments: [
    { id: 'exe', name: 'Executive Management', code: 'DEPT-EXE', headId: 'ceo', head: 'Chief Executive Officer', mandate: 'Executive.' },
    { id: 'net', name: 'Core Network & IT', code: 'DEPT-NET', headId: 'headnet', head: 'Head of Network & IT', mandate: 'Network.' },
    { id: 'cxb', name: 'Customer Experience & Branches', code: 'DEPT-CXB', headId: 'hbc', head: 'Head of Branch & Customer Operations', mandate: 'Branches.' },
  ],
  designations: [
    post('ceo', 'Chief Executive Officer', 'DES-01', 'exe', null, 'All Branches (24)'),
    post('coo', 'Chief Operations Officer', 'DES-02', 'exe', 'ceo', 'All Branches (24)'),
    post('headnet', 'Head of Network & IT', 'DES-04', 'net', 'coo', 'All Branches (24)'),
    post('sre', 'Senior Network Engineer', 'DES-47', 'net', 'headnet', 'Head Office / Core'),
    post('hbc', 'Head of Branch & Customer Operations', 'DES-44', 'cxb', 'coo', 'All Branches (24)'),
    post('branchmgr', 'Branch Manager', 'DES-34', 'cxb', 'hbc', 'Tier 1-2 Branches (8)'),
    post('assistant', 'Assistant Branch Manager', 'DES-36', 'cxb', 'branchmgr', 'High-Volume Branches'),
    post('frontdesk', 'Front Desk Associate', 'DES-40', 'cxb', 'branchmgr', 'Assigned Branch'),
    post('network', 'Network Administrator', 'DES-05', 'net', 'sre', 'Head Office / Core'),
  ],
};

const employee = (
  id: string,
  code: string,
  name: string,
  branchId: string,
  branchName: string,
  designationId: string,
  profilePhoto: string | null = null
): HrOrgChartEmployee => ({
  id,
  employeeCode: code,
  name,
  branchId,
  branchName,
  department: null,
  designation: null,
  designationCode: null,
  workStation: null,
  profilePhoto,
  designationId,
  catalogueDesignation: null,
  grade: null,
  reportsToId: null,
  reportsTo: null,
  departmentId: null,
});

const employees: HrOrgChartEmployee[] = [
  // Head-office core
  employee('e1', 'EMP-001', 'Aarav Sharma', 'BR-HO', 'Kathmandu (Head Office)', 'ceo'),
  employee('e2', 'EMP-002', 'Prakash Adhikari', 'BR-HO', 'Kathmandu (Head Office)', 'coo', 'data:image/png;base64,AAA'),
  employee('e3', 'EMP-003', 'Sandesh Bhandari', 'BR-HO', 'Kathmandu (Head Office)', 'headnet'),
  employee('e4', 'EMP-004', 'Aayush Shrestha', 'BR-HO', 'Kathmandu (Head Office)', 'sre'),
  employee('e5', 'EMP-005', 'Kiran Magar', 'BR-HO', 'Kathmandu (Head Office)', 'network'),
  // Pokhara branch team
  employee('e6', 'EMP-006', 'Deepak Basnet', 'BR-PKR', 'Pokhara Branch', 'branchmgr'),
  employee('e7', 'EMP-007', 'Bikash Thapa', 'BR-PKR', 'Pokhara Branch', 'frontdesk'),
  // A branch person in a company-wide post: core team, not branch team.
  employee('e8', 'EMP-008', 'Nisha Karki', 'BR-PKR', 'Pokhara Branch', 'hbc'),
  // Dharan must stay out of the Pokhara view.
  employee('e9', 'EMP-009', 'Sujan Limbu', 'BR-DHN', 'Dharan Branch', 'assistant'),
];

describe('branch hierarchy', () => {
  test('keeps the full catalogue and both teams for the selected branch', () => {
    const view = buildBranchHierarchy(catalogue, employees, 'BR-PKR');
    assert.equal(view.catalogue.designations.length, catalogue.designations.length, 'top-level chain stays');
    assert.equal(view.catalogue.departments.length, catalogue.departments.length);
    assert.equal(view.branchName, 'Pokhara Branch');

    const ids = [...view.employeesByDesignation.values()].flat().map((person) => person.id);
    assert.deepEqual(ids.sort(), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'].sort());
    assert.equal(view.headOfficeEmployees.length, 6, 'all-branch posts count in the core team');
    assert.equal(view.branchEmployees.length, 2, 'Deepak + Bikash are branch team');
    assert.equal(view.coreFromBranch.length, 1, 'Nisha holds an all-branch post');
    assert.equal(view.employeeCount, 8);
    assert.equal(ids.includes('e9'), false, 'other branches stay out');
  });

  test('tags core and branch people, and never duplicates a branch person into both', () => {
    const view = buildBranchHierarchy(catalogue, employees, 'BR-PKR');
    const byId = new Map(employees.map((person) => [person.id, person]));
    assert.equal(view.teamOf(byId.get('e1')!), 'CORE');
    assert.equal(view.teamOf(byId.get('e6')!), 'BRANCH');
    assert.equal(view.teamOf(byId.get('e8')!), 'CORE');

    assert.deepEqual(
      view.employeesByDesignation.get('hbc')?.map((person) => person.name),
      ['Nisha Karki'],
      'a company-wide post is filled from the core team'
    );
    assert.deepEqual(
      view.employeesByDesignation.get('branchmgr')?.map((person) => person.name),
      ['Deepak Basnet']
    );
    assert.equal(view.employeesByDesignation.get('assistant'), undefined);
  });
});
