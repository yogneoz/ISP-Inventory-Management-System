/**
 * CustomerLedger CSV export failure path — render-level.
 *
 * The complete statement is fetched only when the operator asks for a file.
 * When that read fails, the screen must not fall back to the loaded page, must
 * not create a download, and must leave a visible retry control.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { mountTree } from './harness/mount';
import {
  LedgerView,
  ledgerExportColumns,
  type LedgerBadge,
  type SubLedgerData,
} from '../client/src/components/common/LedgerView';

const settle = async (rounds = 6): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

function icon() {
  return React.createElement('span', { 'aria-hidden': true });
}

const badge: LedgerBadge = { label: 'Invoice', className: '', Icon: icon };
const data: SubLedgerData = {
  partyName: 'CLC Customer',
  partyCode: 'clc-customer',
  openingBalance: 0,
  totalDebit: 100,
  totalCredit: 0,
  closingBalance: 100,
  ledger: [
    {
      id: 'line-1',
      documentNumber: 'JV-1',
      dateAD: '2026-11-17',
      dateBS: '2083-08-01 BS',
      type: 'INVOICE',
      notes: '',
      debit: 100,
      credit: 0,
      balance: 100,
    },
  ],
};

test('a failed complete-statement export writes no file and offers a retry', async () => {
  let calls = 0;
  let downloads = 0;
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = () => {
    downloads += 1;
    return 'blob:should-not-exist';
  };

  const tree = mountTree(
    React.createElement(LedgerView, {
      title: 'Customer Ledger',
      subtitle: 'Statement',
      partyLabel: 'Customer',
      selectedPartyId: 'clc-customer',
      onSelectParty: () => undefined,
      branches: [],
      filters: { fromAd: '', toAd: '', branchId: 'ALL' },
      onFilterChange: () => undefined,
      onLoad: () => undefined,
      loading: false,
      error: '',
      data,
      dateMode: 'AD',
      headerIcon: icon,
      partyIcon: icon,
      scoreCards: () => [],
      tones: {
        opening: { positive: 'emerald', negative: 'rose' },
        debit: 'emerald',
        credit: 'rose',
        closing: { positive: 'emerald', negative: 'rose' },
        debitCell: '',
        creditCell: '',
        balancePositive: '',
        balanceNeutral: '',
      },
      columns: { debit: 'Debit', credit: 'Credit' },
      badges: {
        INVOICE: badge,
        PAYMENT: badge,
        RETURN: badge,
        OPENING: badge,
        ADJUSTMENT: badge,
      },
      closingLabel: 'Closing',
      exportFilenamePrefix: 'Customer_Ledger_',
      exportColumns: ledgerExportColumns({}, 'AD'),
      fetchExport: async () => {
        calls += 1;
        throw new Error('The complete statement could not be loaded.');
      },
    })
  );

  try {
    const exportButton = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').includes('Export CSV')
    ) as HTMLButtonElement | undefined;
    assert.ok(exportButton, 'Export CSV must be available');
    act(() => exportButton.click());
    await settle();

    assert.equal(calls, 1);
    assert.equal(downloads, 0, 'a failed export must not create a partial download');
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, 'the failure must be visible');
    assert.match(alert.textContent || '', /No file was written/);

    const retry = [...document.querySelectorAll('button')].find(
      (button) => (button.textContent || '').includes('Retry export')
    ) as HTMLButtonElement | undefined;
    assert.ok(retry, 'the failure must offer a retry control');
    act(() => retry.click());
    await settle();
    assert.equal(calls, 2, 'Retry must re-run the complete-statement read');
    assert.equal(downloads, 0);
  } finally {
    tree.unmount();
    URL.createObjectURL = originalCreate;
  }
});