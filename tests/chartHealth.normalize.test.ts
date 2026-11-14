/**
 * Chart-health payload compatibility.
 *
 * `unlinkedSubledgerRows` arrived with ACC-6. A newer client can meet an older
 * server during a rolling upgrade, so the normalizer must turn every missing or
 * malformed part into a safe empty value without inventing findings, while
 * preserving the real payload exactly enough for the health section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChartHealth } from '../client/src/utils/chartHealth';

const legacyPayload = {
  missingPostingRoles: ['AR_CONTROL'],
  controlAccountsWithoutSubledger: [{
    accountId: 'gla-1100', code: '1100', name: 'Accounts Receivable',
    subledgerType: 'CUSTOMER', isActive: true,
  }],
  inactiveAccountsHoldingRole: [],
  totals: {
    accounts: 12,
    controlAccounts: 2,
    subledgers: 3,
    activeSubledgers: 2,
  },
};

test('normalizes both chart-health generations without losing real findings', () => {
  const legacy = normalizeChartHealth(legacyPayload);
  assert.deepEqual(legacy.missingPostingRoles, ['AR_CONTROL']);
  assert.equal(legacy.controlAccountsWithoutSubledger.length, 1);
  assert.deepEqual(legacy.inactiveAccountsHoldingRole, []);
  assert.equal(legacy.unlinkedSubledgerRows.available, false);
  assert.equal(legacy.unlinkedSubledgerRows.count, 0);
  assert.equal(legacy.unlinkedSubledgerRows.amount, 0);
  assert.deepEqual(legacy.unlinkedSubledgerRows.rows, []);
  assert.deepEqual(normalizeChartHealth(legacy), legacy, 'normalization is idempotent');
  assert.equal(legacy.totals.unlinkedSubledgerRows, 0);
  assert.equal(legacy.totals.accounts, 12);

  const current = normalizeChartHealth({
    ...legacyPayload,
    unlinkedSubledgerRows: {
      count: 1,
      amount: 50,
      rows: [{
        id: 'se-1', journalId: 'j-1', accountId: 'gla-1100',
        accountCode: '1100', accountName: 'Accounts Receivable',
        subledgerType: 'CUSTOMER', partyId: 'CUST-1',
        partyName: 'Legacy Customer', branchId: 'BR-KTM',
        entryDateAD: '2026-11-01', debit: 50, credit: 0,
      }],
    },
    totals: { ...legacyPayload.totals, unlinkedSubledgerRows: 1 },
  });
  assert.equal(current.unlinkedSubledgerRows.available, true);
  assert.equal(current.unlinkedSubledgerRows.count, 1);
  assert.equal(current.unlinkedSubledgerRows.amount, 50);
  assert.equal(current.unlinkedSubledgerRows.rows[0].partyName, 'Legacy Customer');
  assert.equal(current.totals.unlinkedSubledgerRows, 1);

  const malformed = normalizeChartHealth({
    missingPostingRoles: 'AR_CONTROL',
    controlAccountsWithoutSubledger: null,
    inactiveAccountsHoldingRole: {},
    unlinkedSubledgerRows: { count: '1', amount: null, rows: {} },
    totals: null,
  });
  assert.deepEqual(malformed.missingPostingRoles, []);
  assert.deepEqual(malformed.controlAccountsWithoutSubledger, []);
  assert.deepEqual(malformed.inactiveAccountsHoldingRole, []);
  assert.equal(malformed.unlinkedSubledgerRows.available, true);
  assert.equal(malformed.unlinkedSubledgerRows.count, 1);
  assert.equal(malformed.unlinkedSubledgerRows.amount, 0);
  assert.deepEqual(malformed.unlinkedSubledgerRows.rows, []);
});
