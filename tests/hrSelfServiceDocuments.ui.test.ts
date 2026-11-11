/**
 * Employee self-service documents UI.
 *
 * A mounted real-App happy path proves the lazy route reads the own document
 * list and refreshes it. The download action is exercised through the API
 * helper; the API suite proves the bytes come from the existing authenticated
 * route and another employee is refused. Direct mounts cover the empty state
 * and the no-permission refusal without a read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import type { User } from '../client/src/types';
import type { HrSelfDocument, HrSelfDocumentsResponse } from '../client/src/services/api/hr';
import { EmployeeDocuments } from '../client/src/features/hr/EmployeeDocuments';
import { applyEffectivePermissions } from '../client/src/utils/permissions';
import { clearRecentBootstrapCache } from '../client/src/utils/sessionCache';
import { inAct, mountTree } from './harness/mount';
import {
  bootstrapFixture,
  installApiStubs,
  installEventSource,
  mountAppRouteTree,
  seedSession,
  settleUntil,
  smokeUser,
} from './harness/appRouteTreeProbe';

const expired: HrSelfDocument = {
  id: 'ess-doc-row-a-expired',
  docType: 'PAN_CARD',
  title: 'Expired PAN.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  issuedOnAD: null,
  expiresOnAD: '2099-03-01',
  expiryStatus: 'EXPIRED',
  uploadedAt: '2099-03-28T10:00:00.000Z',
  notes: 'Fixture note',
  uploadedBy: 'HR Officer',
  contentUrl: '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-expired/content',
};

const expiring: HrSelfDocument = {
  ...expired,
  id: 'ess-doc-row-a-expiring',
  docType: 'CONTRACT',
  title: 'Expiring contract.pdf',
  expiresOnAD: '2099-05-01',
  expiryStatus: 'EXPIRING',
  uploadedAt: '2099-03-27T10:00:00.000Z',
  notes: null,
  contentUrl: '/api/employees/ess-doc-emp-a/documents/ess-doc-row-a-expiring/content',
};

const response: HrSelfDocumentsResponse = {
  expirySoonDays: 30,
  summary: { totalDocuments: 2, expiringSoon: 1, expiredDocuments: 1 },
  documents: [expired, expiring],
};

test('My Documents is route/nav/preload wired, read-only and gated by hr-self-service', () => {
  const screen = readFileSync('client/src/features/hr/EmployeeDocuments.tsx', 'utf8');
  assert.match(screen, /getMyHrDocuments/);
  assert.match(screen, /downloadMyHrDocument/);
  assert.match(screen, /isOperationAllowed\('hr-self-service'/);
  assert.match(screen, /useActivationKey\('hr-self-documents'\)/);
  assert.doesNotMatch(
    screen,
    /(uploadEmployeeDocument|deleteEmployeeDocument|downloadEmployeeDocument|getEmployeeDocuments|post_hrEmployeeDocument)/,
    'the self-service documents screen must not expose a management document action'
  );
  assert.doesNotMatch(screen, /useDialog|text-\[9px\]/, 'no raw dialog or micro-label scale');

  const app = readFileSync('client/src/App.tsx', 'utf8');
  assert.match(app, /screenRoute\('hr-self-documents'/);
  assert.match(app, /EmployeeDocuments currentUser=\{currentUser\}/);
  const paths = readFileSync('client/src/routes/appPaths.ts', 'utf8');
  assert.match(paths, /'hr-self-documents': '\/people\/documents'/);
  assert.match(paths, /'hr-self-attendance': '\/people\/attendance'/);
  assert.match(paths, /'hr-attendance': '\/people\/attendance-register'/);
  const tabs = readFileSync('client/src/routes/tabPermissions.ts', 'utf8');
  assert.match(tabs, /'hr-self-documents': 'hr-self-service'/);
  const preload = readFileSync('client/src/screenPreload.ts', 'utf8');
  assert.match(
    preload,
    /'hr-self-documents': \(\) => import\('\.\/features\/hr\/EmployeeDocuments'\)/
  );
  const sidebar = readFileSync('client/src/components/layout/Sidebar.tsx', 'utf8');
  assert.match(sidebar, /label: 'My Documents'/);
});

test('the real route renders the signed-in employee documents and refreshes', async () => {
  const filled = {
    ...bootstrapFixture,
    userPreferences: { ...bootstrapFixture.userPreferences, activeTab: 'hr-self-documents' },
  };
  let reads = 0;
  const downloads: string[] = [];
  clearRecentBootstrapCache();
  window.history.replaceState({}, '', '/');
  seedSession('hr-self-documents');
  const restoreEventSource = installEventSource();
  const restoreApi = installApiStubs({
    getBootstrapState: async () => filled,
    getMyHrDocuments: async () => {
      reads += 1;
      return response;
    },
    downloadMyHrDocument: async (...args: unknown[]) => {
      downloads.push((args[0] as HrSelfDocument).id);
    },
  });
  const tree = mountAppRouteTree();

  try {
    assert.ok(
      await settleUntil(() => (tree.container.textContent || '').includes('Expired PAN.pdf')),
      'the own documents must render'
    );
    assert.equal(window.location.pathname, '/people/documents');
    const text = tree.container.textContent || '';
    assert.match(text, /My Documents/);
    assert.match(text, /Document summary/);
    assert.match(text, /Total documents/);
    assert.match(text, /Expiring soon/);
    assert.match(text, /Within 30 days/);
    assert.match(text, /Expired PAN\.pdf/);
    assert.match(text, /Expiring contract\.pdf/);
    assert.match(text, /PAN card/);
    assert.match(text, /Contract/);
    assert.match(text, /2099-03-01/);
    assert.match(text, /2099-05-01/);
    assert.match(text, /Expired/);
    assert.match(text, /Expiring soon/);
    assert.match(text, /Fixture note/);
    assert.match(text, /vault does not store a separate issue date/i);
    assert.equal(reads, 1, 'the screen must read the own document list exactly once');
    const actionLabels = Array.from(tree.container.querySelectorAll('button'))
      .map((button) => `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`)
      .join(' | ');
    assert.doesNotMatch(
      actionLabels,
      /Upload|Replace|Delete document|Submit|Approve/i,
      'no management document action may be offered'
    );

    const downloadButton = tree.container.querySelector(
      'button[aria-label="Download Expired PAN.pdf"]'
    );
    assert.ok(downloadButton, 'each own document needs its download control');
    inAct(() => (downloadButton as HTMLButtonElement).click());
    assert.ok(
      await settleUntil(() => downloads.length === 1),
      'download must use the authenticated client helper'
    );
    assert.deepEqual(downloads, ['ess-doc-row-a-expired']);

    const refresh = tree.container.querySelector('button[aria-label*="refresh" i]');
    assert.ok(refresh, 'the screen needs its refresh control');
    inAct(() => (refresh as HTMLButtonElement).click());
    assert.ok(await settleUntil(() => reads === 2), 'Refresh must re-read the list');
  } finally {
    tree.unmount();
    restoreApi();
    restoreEventSource();
    applyEffectivePermissions(null);
  }
});

test('an empty vault shows its empty state rather than a management action', async () => {
  const restoreApi = installApiStubs({
    getMyHrDocuments: async () => ({
      expirySoonDays: 30,
      summary: { totalDocuments: 0, expiringSoon: 0, expiredDocuments: 0 },
      documents: [],
    }),
  });
  const tree = mountTree(
    createElement(EmployeeDocuments, { currentUser: smokeUser })
  );
  try {
    assert.ok(
      await settleUntil(() =>
        (tree.container.textContent || '').includes('No documents have been uploaded')
      ),
      'the empty state must render after the successful read'
    );
    const text = tree.container.textContent || '';
    assert.match(text, /No documents have been uploaded for your employee record yet/);
    const actionLabels = Array.from(tree.container.querySelectorAll('button'))
      .map((button) => `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`)
      .join(' | ');
    assert.doesNotMatch(actionLabels, /Upload|Replace|Delete document/i);
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});

test('a role without hr-self-service gets the refusal without calling the endpoint', () => {
  applyEffectivePermissions([], 'FRONT_DESK');
  let reads = 0;
  const restoreApi = installApiStubs({
    getMyHrDocuments: async () => {
      reads += 1;
      return response;
    },
  });
  const frontDesk = {
    ...bootstrapFixture,
    id: 'u-front-desk',
    role: 'FRONT_DESK',
    branchId: 'WH001',
  } as unknown as User;
  const tree = mountTree(createElement(EmployeeDocuments, { currentUser: frontDesk }));
  try {
    assert.match(
      tree.container.textContent || '',
      /do not have permission to view your documents/i
    );
    assert.equal(reads, 0, 'the refusal must not call the documents endpoint');
  } finally {
    tree.unmount();
    restoreApi();
    applyEffectivePermissions(null);
  }
});
