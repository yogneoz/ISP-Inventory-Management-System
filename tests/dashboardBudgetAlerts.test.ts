/**
 * Dashboard budget overspend alerts — mounted UI path.
 *
 * Mounts the real Dashboard, stubs only its reads, and proves the finance-only
 * alert panel renders the server's exact account/amount rows, shows the
 * pre-limit tie-out badge, requests the active fiscal-year/branch window, and
 * opens the existing Budget vs actual surface.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { Dashboard } from '../client/src/features/dashboard/Dashboard';
import { api } from '../client/src/services/api';
import { formatNPR } from '../client/src/utils/nprFormat';
import { BootstrapDataProvider } from '../client/src/contexts/AppProviders';

const user = {
  id: 'u-dashboard-budget',
  email: 'dashboard-budget@example.com',
  name: 'Dashboard Budget Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const branches = [
  { id: 'ALL', code: 'ALL', name: 'All Branches (Consolidated)', location: 'Kathmandu' },
  { id: 'b1', code: 'B1', name: 'Main Branch', location: 'Kathmandu' },
] as any[];

const alertResponse = {
  fiscalYearId: 'fy-dashboard',
  fiscalYearCode: '2083-84',
  branchId: 'ALL',
  from: '2026-07-17',
  to: '2027-07-16',
  alerts: [
    {
      accountId: 'a-network',
      code: '6100',
      name: 'Network Operations',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 1000,
      actual: 1200,
      variance: -200,
      variancePercent: -20,
      overBy: 200,
      overPercent: 20,
      utilisationPercent: 120,
    },
    {
      accountId: 'a-field',
      code: '6200',
      name: 'Field Maintenance',
      accountType: 'EXPENSE',
      statementGroup: 'OPERATING_EXPENSE',
      budget: 500,
      actual: 650,
      variance: -150,
      variancePercent: -30,
      overBy: 150,
      overPercent: 30,
      utilisationPercent: 130,
    },
  ],
  totals: { alertCount: 2, budget: 1500, actual: 1850, overBy: 350 },
  tieOut: {
    sourceBudget: 1500,
    sourceActual: 1850,
    alertBudget: 1500,
    alertActual: 1850,
    budgetDifference: 0,
    actualDifference: 0,
    reconciled: true,
  },
  truncated: false,
  limit: 5,
};

const settle = async () => {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('dashboard budget overspend alerts', () => {
  const originalLogs = api.getTransactionLogs;
  const originalAssets = api.getFixedAssetOverview;
  const originalShipments = api.getShipmentOverview;
  const originalBudgetAlerts = api.getAccountingBudgetAlerts;

  beforeEach(() => {
    api.getTransactionLogs = (async () => ({ data: [], totalItems: 0 })) as any;
    api.getFixedAssetOverview = (async () => ({
      total: 0,
      counts: {},
      totals: { acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 },
      closing: {
        activeCount: 0,
        annualDepreciation: 0,
        missingRateCount: 0,
        missingRateTags: [],
      },
    })) as any;
    api.getShipmentOverview = (async () => ({
      counts: {},
      total: 0,
      pending: [],
      recent: [],
      pendingCapped: false,
      scope: 'ALL',
    })) as any;
  });

  afterEach(() => {
    api.getTransactionLogs = originalLogs;
    api.getFixedAssetOverview = originalAssets;
    api.getShipmentOverview = originalShipments;
    api.getAccountingBudgetAlerts = originalBudgetAlerts;
  });

  test('renders exact alert rows, request scope and tie-out, then opens Budget vs actual', async () => {
    let requested: any = null;
    api.getAccountingBudgetAlerts = (async (query: any) => {
      requested = query;
      return alertResponse;
    }) as any;

    let navigatedTo = '';
    const tree = mountTree(
      h(BootstrapDataProvider, { initial: { products: [], stock: [], branches, financialSummary: {} as any, categories: [] } }, h(Dashboard, {
        currentUser: user,
        pendingPurchaseOrders: [],
        selectedBranchId: 'ALL',
        fiscalYearId: 'fy-dashboard',
        fiscalYearStartAD: '2026-07-17',
        fiscalYearEndAD: '2027-07-16',
        dateMode: 'AD',
        onNavigateTab: (tab: string) => {
          navigatedTo = tab;
        },
      } as any))
    );

    try {
      await settle();
      const text = tree.container.textContent || '';

      assert.match(text, /Budget Overspend Alerts/);
      assert.match(text, /2 expense accounts/);
      assert.match(text, /Network Operations/);
      assert.match(text, /Field Maintenance/);
      assert.match(text, /120\.0% of budget/);
      assert.match(text, /130\.0% of budget/);
      assert.match(text, /Ties to variance total/);
      assert.ok(text.includes(formatNPR(350)), 'the over-budget total must be the server total');
      assert.ok(text.includes(formatNPR(1850)), 'the posted actual must be the server total');
      assert.ok(text.includes(formatNPR(200)), 'the first alert overage must be visible');
      assert.ok(text.includes(formatNPR(150)), 'the second alert overage must be visible');

      assert.deepEqual(requested, {
        fiscalYearId: 'fy-dashboard',
        branchId: 'ALL',
        from: '2026-07-17',
        to: '2027-07-16',
        limit: 5,
      });

      const open = [...tree.container.querySelectorAll('button')].find((button) =>
        (button.textContent || '').includes('Open Budget vs Actual')
      ) as HTMLButtonElement | undefined;
      assert.ok(open, 'the alert panel must link to the existing budget surface');
      act(() => open!.click());
      assert.equal(navigatedTo, 'financial-statements');
    } finally {
      tree.unmount();
    }
  });
});
