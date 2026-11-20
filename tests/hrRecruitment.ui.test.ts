/**
 * People & HR → Recruitment UI.
 *
 * Direct mounts cover the real screen with all four recruitment families:
 * summary counts, the pipeline rows, the empty scope and the no-permission
 * refusal without any read. Static checks pin the route/nav/path/permission
 * and saved-tab preload wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { Recruitment } from '../client/src/features/hr/Recruitment';
import type {
  HrRecruitmentCandidateRecord,
  HrRecruitmentInterviewRecord,
  HrRecruitmentOfferRecord,
  HrRecruitmentRequisitionRecord,
} from '../client/src/services/api/hr';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
import { inAct, mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  settleUntil,
  smokeUser,
} from './harness/appRouteTreeProbe';
import { BootstrapDataProvider } from '../client/src/contexts/AppProviders';

const branches = bootstrapFixture.branches as any;

const requisition: HrRecruitmentRequisitionRecord = {
  id: 'hr-req-ui-1',
  requisitionNo: 'REQ-2026-UI1',
  branchId: 'WH001',
  branchName: 'Warehouse',
  title: 'Network Engineer',
  department: 'Operations',
  designation: 'Network Engineer',
  employmentType: 'FULL_TIME',
  openings: 2,
  status: 'OPEN',
  openedOnAD: '2026-11-01',
  openedOnBS: '2083-07-16 BS',
  closesOnAD: '2026-12-31',
  closesOnBS: '2083-09-16 BS',
  description: 'Branch network support.',
  candidateCount: 2,
  hiredCount: 0,
  createdBy: 'hr@example.com',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const candidates: HrRecruitmentCandidateRecord[] = [
  {
    id: 'hr-cand-ui-1',
    candidateNo: 'CAND-2026-UI1',
    requisitionId: requisition.id,
    requisitionNo: requisition.requisitionNo,
    requisitionTitle: requisition.title,
    branchId: 'WH001',
    branchName: 'Warehouse',
    name: 'Recruitment UI Candidate',
    email: 'candidate-ui@example.com',
    phone: '9800000002',
    source: 'Referral',
    currentEmployer: 'Previous Network',
    status: 'INTERVIEW',
    notes: null,
    resumeFileName: 'resume.pdf',
    resumeMimeType: 'application/pdf',
    resumeByteSize: 128,
    resumeUploadedAt: '2026-11-10T00:00:00Z',
    hasResume: true,
    hiredEmployeeId: null,
    hiredEmployeeCode: null,
    interviewCount: 1,
    lastInterviewOnAD: '2026-11-15',
    offerId: 'hr-offer-ui-1',
    offerNo: 'OFF-2026-UI1',
    offerStatus: 'SENT',
    offerPositionTitle: 'Network Engineer',
    offerMonthlySalary: 50_000,
    offerStartDateAD: '2026-12-01',
    createdBy: 'hr@example.com',
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
  },
  {
    id: 'hr-cand-ui-2',
    candidateNo: 'CAND-2026-UI2',
    requisitionId: requisition.id,
    requisitionNo: requisition.requisitionNo,
    requisitionTitle: requisition.title,
    branchId: 'WH001',
    branchName: 'Warehouse',
    name: 'Recruitment Accepted Candidate',
    email: 'accepted-ui@example.com',
    phone: '9800000003',
    source: 'Walk-in',
    currentEmployer: null,
    status: 'OFFER',
    notes: 'Ready to start.',
    resumeFileName: null,
    resumeMimeType: null,
    resumeByteSize: null,
    resumeUploadedAt: null,
    hasResume: false,
    hiredEmployeeId: null,
    hiredEmployeeCode: null,
    interviewCount: 1,
    lastInterviewOnAD: '2026-11-14',
    offerId: 'hr-offer-ui-2',
    offerNo: 'OFF-2026-UI2',
    offerStatus: 'ACCEPTED',
    offerPositionTitle: 'Network Engineer',
    offerMonthlySalary: 55_000,
    offerStartDateAD: '2026-12-01',
    createdBy: 'hr@example.com',
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:00:00Z',
  },
];

const interviews: HrRecruitmentInterviewRecord[] = [
  {
    id: 'hr-int-ui-1',
    candidateId: candidates[0].id,
    candidateNo: candidates[0].candidateNo,
    candidateName: candidates[0].name,
    branchId: 'WH001',
    branchName: 'Warehouse',
    roundName: 'Technical',
    scheduledOnAD: '2026-11-15',
    scheduledOnBS: '2083-07-30 BS',
    interviewer: 'Technical Lead',
    mode: 'VIDEO',
    status: 'SCHEDULED',
    rating: 4,
    notes: null,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  },
];

const offers: HrRecruitmentOfferRecord[] = [
  {
    id: 'hr-offer-ui-1',
    offerNo: 'OFF-2026-UI1',
    candidateId: candidates[0].id,
    candidateNo: candidates[0].candidateNo,
    candidateName: candidates[0].name,
    branchId: 'WH001',
    branchName: 'Warehouse',
    positionTitle: 'Network Engineer',
    monthlySalary: 50_000,
    startDateAD: '2026-12-01',
    startDateBS: '2083-08-16 BS',
    offeredOnAD: '2026-11-16',
    offeredOnBS: '2083-07-31 BS',
    status: 'SENT',
    respondedOnAD: null,
    notes: null,
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
  },
  {
    id: 'hr-offer-ui-2',
    offerNo: 'OFF-2026-UI2',
    candidateId: candidates[1].id,
    candidateNo: candidates[1].candidateNo,
    candidateName: candidates[1].name,
    branchId: 'WH001',
    branchName: 'Warehouse',
    positionTitle: 'Network Engineer',
    monthlySalary: 55_000,
    startDateAD: '2026-12-01',
    startDateBS: '2083-08-16 BS',
    offeredOnAD: '2026-11-15',
    offeredOnBS: '2083-07-30 BS',
    status: 'ACCEPTED',
    respondedOnAD: '2026-11-17',
    notes: null,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  },
];

const fixture = {
  getHrRecruitmentRequisitions: async () => [requisition],
  getHrRecruitmentCandidates: async () => candidates,
  getHrRecruitmentInterviews: async () => interviews,
  getHrRecruitmentOffers: async () => offers,
};

test('recruitment is route, nav, path, permission and preload wired', () => {
  const screen = readFileSync('client/src/features/hr/Recruitment.tsx', 'utf8');
  assert.match(screen, /useActivationKey\('hr-recruitment'\)/);
  assert.match(screen, /getHrRecruitmentRequisitions/);
  assert.match(screen, /hireHrRecruitmentCandidate/);
  assert.match(screen, /uploadHrRecruitmentResume/);
  assert.match(screen, /isOperationAllowed\('hr-employee-view'/);

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-recruitment'/);
  assert.match(app, /<Recruitment\s+currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-recruitment': '\/people\/recruitment'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /const HR_VIEW = \['hr-employee-view', 'gl-payroll-manage'\]/);
  assert.match(tabs, /'hr-recruitment': HR_VIEW/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-recruitment': \(\) => import\('\.\/features\/hr\/Recruitment'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'Recruitment'/);
});

test('the screen renders every family, summary counts and refetches all four on Refresh', async () => {
  const calls = {
    requisitions: 0,
    candidates: 0,
    interviews: 0,
    offers: 0,
  };
  const scopes: any[] = [];
  const restore = installApiStubs({
    getHrRecruitmentRequisitions: async (options: any) => {
      calls.requisitions += 1;
      scopes.push(options);
      return [requisition];
    },
    getHrRecruitmentCandidates: async () => {
      calls.candidates += 1;
      return candidates;
    },
    getHrRecruitmentInterviews: async () => {
      calls.interviews += 1;
      return interviews;
    },
    getHrRecruitmentOffers: async () => {
      calls.offers += 1;
      return offers;
    },
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Recruitment, {
        currentUser: smokeUser,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Network Engineer')),
      'the requisition and candidate pipeline must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /Recruitment/);
    assert.match(text, /Requisitions/);
    assert.match(text, /Candidate pipeline/);
    assert.match(text, /Interviews/);
    assert.match(text, /Offers/);
    assert.match(text, /Recruitment UI Candidate/);
    assert.match(text, /Recruitment Accepted Candidate/);
    assert.match(text, /Technical/);
    assert.match(text, /Accepted/);
    assert.equal(
      tree.container.querySelector('[data-testid="recruitment-open-requisitions"]')?.textContent,
      '1'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="recruitment-active-candidates"]')?.textContent,
      '2'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="recruitment-scheduled-interviews"]')?.textContent,
      '1'
    );
    assert.equal(
      tree.container.querySelector('[data-testid="recruitment-accepted-offers"]')?.textContent,
      '1'
    );
    assert.deepEqual(scopes, [{ branchId: 'WH001' }]);

    const refresh = tree.container.querySelector(
      'button[aria-label="Refresh recruitment"]'
    ) as HTMLButtonElement | null;
    assert.ok(refresh, 'the screen must expose Refresh');
    inAct(() => refresh!.click());
    assert.ok(
      await settleUntil(
        () =>
          calls.requisitions === 2 &&
          calls.candidates === 2 &&
          calls.interviews === 2 &&
          calls.offers === 2
      ),
      'Refresh must re-read all four recruitment collections'
    );
  } finally {
    tree.unmount();
    restore();
  }
});

test('an empty branch scope renders an explicit empty state for every section', async () => {
  const restore = installApiStubs({
    getHrRecruitmentRequisitions: async () => [],
    getHrRecruitmentCandidates: async () => [],
    getHrRecruitmentInterviews: async () => [],
    getHrRecruitmentOffers: async () => [],
  });
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Recruitment, {
        currentUser: smokeUser,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.ok(
      await settleUntil(() =>
        (tree.container.textContent || '').includes('No requisitions in this branch scope')
      ),
      'the empty requisition state must render'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /No requisitions in this branch scope/);
    assert.match(text, /No candidates in this branch scope/);
    assert.match(text, /No interviews scheduled/);
    assert.match(text, /No offers created/);
  } finally {
    tree.unmount();
    restore();
  }
});

test('a role without the HR read grant is refused without calling any endpoint', async () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  const restore = installApiStubs({
    getHrRecruitmentRequisitions: async () => {
      reads += 1;
      return [];
    },
    getHrRecruitmentCandidates: async () => {
      reads += 1;
      return [];
    },
    getHrRecruitmentInterviews: async () => {
      reads += 1;
      return [];
    },
    getHrRecruitmentOffers: async () => {
      reads += 1;
      return [];
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-recruitment-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as any;
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(Recruitment, {
        currentUser: frontDesk,
        selectedBranchId: 'WH001',
      }))
    )
  );
  try {
    assert.match(
      tree.container.textContent || '',
      /do not have permission to view the recruitment pipeline/i
    );
    assert.equal(reads, 0, 'the refusal must not call any recruitment endpoint');
  } finally {
    tree.unmount();
    restore();
    applyEffectivePermissions(null);
  }
});
