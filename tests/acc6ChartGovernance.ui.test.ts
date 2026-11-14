/**
 * ACC-6 — chart governance and the reporting surface, rendered.
 *
 * The chart must expose its five working sections, and an aging row must open
 * that party's posted statement with the control tie-out attached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { ChartView, type ChartState } from '../client/src/components/accounting/ChartView';
import { AgingView } from '../client/src/components/accounting/AgingView';
import type { AgingResponse } from '../client/src/services/api/accounting';
import { mountTree } from './harness/mount';
import { installApiStubs } from './harness/appRouteTreeProbe';

const settle = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const chartState: ChartState = {
  groups: [
    {
      id: 'glg-1000', parentId: null, code: '1000', name: 'Current Assets',
      accountType: 'ASSET', statementGroup: 'CURRENT_ASSET', normalBalance: 'DEBIT',
      sortOrder: 10, isActive: true, isDemo: false,
    },
    {
      id: 'glg-1110', parentId: 'glg-1000', code: '1110', name: 'Trade Receivables',
      accountType: 'ASSET', statementGroup: 'CURRENT_ASSET', normalBalance: 'DEBIT',
      sortOrder: 15, isActive: true, isDemo: false,
    },
  ],
  accounts: [
    {
      id: 'gla-1100', code: '1100', name: 'Accounts Receivable', groupId: 'glg-1110',
      groupCode: '1110', groupName: 'Trade Receivables', description: null,
      isControl: true, subledgerType: 'CUSTOMER', postingRole: 'AR_CONTROL',
      isActive: true, isDemo: false, accountType: 'ASSET',
      statementGroup: 'CURRENT_ASSET', normalBalance: 'DEBIT', branchId: null,
    },
    {
      id: 'gla-1010', code: '1010', name: 'Cash on Hand', groupId: 'glg-1000',
      groupCode: '1000', groupName: 'Current Assets', description: null,
      isControl: false, subledgerType: 'NONE', postingRole: 'CASH',
      isActive: true, isDemo: false, accountType: 'ASSET',
      statementGroup: 'CURRENT_ASSET', normalBalance: 'DEBIT', branchId: null,
    },
  ],
  defaults: {
    AR_CONTROL: {
      accountId: 'gla-1100', accountCode: '1100', accountName: 'Accounts Receivable',
      accountType: 'ASSET', statementGroup: 'CURRENT_ASSET', isControl: true,
      subledgerType: 'CUSTOMER',
    },
  },
  reconciliations: [],
  reconciliationErrors: {},
  health: {
    missingPostingRoles: [],
    controlAccountsWithoutSubledger: [],
    inactiveAccountsHoldingRole: [],
    unlinkedSubledgerRows: {
      count: 1,
      amount: 50,
      rows: [{
        id: 'se-1', journalId: 'j-1', accountId: 'gla-1100', accountCode: '1100',
        accountName: 'Accounts Receivable', subledgerType: 'CUSTOMER',
        partyId: 'CUST-1', partyName: 'Legacy Customer', branchId: 'BR-KTM',
        entryDateAD: '2026-11-01', debit: 50, credit: 0,
      }],
    },
    totals: {
      accounts: 2, controlAccounts: 1, subledgers: 1, activeSubledgers: 1,
      unlinkedSubledgerRows: 1,
    },
  },
};

const aging: AgingResponse = {
  report: 'AR_AGING',
  type: 'AR',
  asOf: '2026-11-02',
  branchId: null,
  account: {
    accountId: 'gla-1100', code: '1100', name: 'Accounts Receivable',
    postingRole: 'AR_CONTROL', subledgerType: 'CUSTOMER', isActive: true,
  },
  buckets: [
    { key: 'CURRENT', label: 'Not yet due', minDays: null, maxDays: 0, amount: 0 },
    { key: 'DAYS_1_30', label: '1–30 days', minDays: 1, maxDays: 30, amount: 900 },
    { key: 'DAYS_31_60', label: '31–60 days', minDays: 31, maxDays: 60, amount: 0 },
    { key: 'DAYS_61_90', label: '61–90 days', minDays: 61, maxDays: 90, amount: 0 },
    { key: 'DAYS_90_PLUS', label: '90+ days', minDays: 91, maxDays: null, amount: 0 },
  ],
  parties: [{
    partyId: 'CUST-A',
    partyName: 'Ada Customer',
    buckets: { CURRENT: 0, DAYS_1_30: 900, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0 },
    grossTotal: 900,
    unappliedCredit: 0,
    total: 900,
    rows: [],
  }],
  totals: {
    CURRENT: 0, DAYS_1_30: 900, DAYS_31_60: 0, DAYS_61_90: 0, DAYS_90_PLUS: 0,
    grossTotal: 900, unappliedCredit: 0, total: 900, controlBalance: 900,
    difference: 0, reconciled: true,
  },
};

test('the chart register exposes ledgers, groups, controls, defaults and health', async () => {
  const tree = mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(ChartView, {
        state: chartState,
        branchId: 'ALL',
        branches: [],
        loading: false,
        canManage: true,
        onChanged: () => undefined,
      })
    )
  );
  try {
    await settle();
    const click = async (label: string) => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        (candidate.textContent || '').includes(label)
      ) as HTMLButtonElement | undefined;
      assert.ok(button, `${label} tab must exist`);
      await act(async () => {
        button!.click();
        await Promise.resolve();
      });
    };

    assert.match(document.body.textContent || '', /Trade Receivables/);
    await click('Groups & Sub-Groups');
    assert.match(document.body.textContent || '', /Groups and sub-groups/);
    assert.match(document.body.textContent || '', /SUB-GROUP/);

    await click('Control Accounts');
    assert.match(document.body.textContent || '', /Control accounts/);
    assert.match(document.body.textContent || '', /NO BOOK/);

    await click('Posting Defaults');
    assert.match(document.body.textContent || '', /AR_CONTROL/);

    await click('Reconciliation Health');
    assert.match(document.body.textContent || '', /Setup gaps/);
    assert.match(document.body.textContent || '', /Legacy Customer/);
    assert.match(document.body.textContent || '', /UNLINKED SUBLEDGER ROWS/);
  } finally {
    tree.unmount();
  }
});

test('an aging row opens the party statement and its control tie-out', async () => {
  const calls: Array<{ id: string; params: any }> = [];
  const restore = installApiStubs({
    getCustomerLedger: async (...args: unknown[]) => {
      const id = String(args[0]);
      const params = args[1] as any;
      calls.push({ id, params });
      return {
        customer: { id, name: 'Ada Customer' },
        openingBalance: 0,
        openingSource: 'posted',
        fiscalYearStartAD: '2026-07-17',
        totalDebit: 900,
        totalCredit: 0,
        closingBalance: 900,
        ledger: [{
          id: 'line-1', documentNumber: 'AG-AR-1', dateAD: '2026-10-20',
          dateBS: '2083-07-03', amount: 900, type: 'INVOICE',
          debit: 900, credit: 0, balance: 900,
        }],
        tieOut: {
          partyBalance: 900,
          controlBalance: 900,
          subledgerBalance: 900,
          difference: 0,
          status: 'RECONCILED',
          controlAccountCode: '1100',
          controlAccountName: 'Accounts Receivable',
        },
      };
    },
  });
  const tree = mountTree(
    createElement(AgingView, {
      data: aging,
      type: 'AR' as const,
      onTypeChange: () => undefined,
      dateMode: 'AD' as const,
      branchId: 'BR-KTM',
    })
  );
  try {
    await settle();
    const statement = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').trim() === 'Statement'
    ) as HTMLButtonElement | undefined;
    assert.ok(statement, 'the aging row must expose its party statement');
    await act(async () => {
      statement!.click();
      await Promise.resolve();
    });
    await settle();

    assert.match(document.body.textContent || '', /Ada Customer · Customer statement/);
    assert.match(document.body.textContent || '', /Control tie-out/);
    assert.match(document.body.textContent || '', /AG-AR-1/);
    assert.deepEqual(calls, [{ id: 'CUST-A', params: { toAd: '2026-11-02', branchId: 'BR-KTM' } }]);
  } finally {
    tree.unmount();
    restore();
  }
});
