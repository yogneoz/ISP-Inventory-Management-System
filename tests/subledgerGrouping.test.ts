/**
 * Subledger register grouping.
 *
 * The screen groups books by the type the server reports, keeps a stable
 * Unspecified bucket, and never turns a partial payload into NaN or a
 * misleading zero total.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountingSubledger } from '../client/src/services/api/accounting';
import {
  UNSPECIFIED_SUBLEDGER_GROUP,
  buildSubledgerGroups,
} from '../client/src/features/finance/subledgerGroups';

function book(overrides: Partial<AccountingSubledger> = {}): AccountingSubledger {
  return {
    id: 'sl-1',
    code: 'SL-1',
    name: 'Book 1',
    subledgerType: 'CUSTOMER',
    mainAccountId: 'gla-1100',
    partyId: 'CUST-1',
    description: null,
    isActive: true,
    isDemo: false,
    accountCode: '1100',
    accountName: 'Accounts Receivable',
    accountPostingRole: 'AR_CONTROL',
    groupCode: '1110',
    groupName: 'Trade Receivables',
    entryCount: 5,
    bookBalance: 150,
    subledgerBalance: 150,
    glBalance: 150,
    difference: 0,
    unlinkedCount: 0,
    ...overrides,
  };
}

test('groups mixed types with stable order, sorted books, counts and money totals', () => {
  const groups = buildSubledgerGroups([
    book({ id: 'c-2', code: 'SL-C2', name: 'Customer Two', subledgerType: 'CUSTOMER', entryCount: 7, bookBalance: 250 }),
    book({ id: 's-1', code: 'SL-S1', name: 'Supplier One', subledgerType: 'SUPPLIER', entryCount: 3, bookBalance: 80 }),
    book({ id: 'c-1', code: 'SL-C1', name: 'Customer One', subledgerType: ' customer ', entryCount: 5, bookBalance: 150 }),
  ]);

  assert.deepEqual(groups.map((group) => group.key), ['CUSTOMER', 'SUPPLIER']);
  assert.deepEqual(groups[0].books.map((row) => row.code), ['SL-C1', 'SL-C2']);
  assert.equal(groups[0].bookCount, 2);
  assert.equal(groups[0].entryCount, 12);
  assert.equal(groups[0].bookBalance, 400);
  assert.equal(groups[1].bookCount, 1);
  assert.equal(groups[1].entryCount, 3);
  assert.equal(groups[1].bookBalance, 80);
});

test('missing or blank types fall into one stable Unspecified group', () => {
  const groups = buildSubledgerGroups([
    book({ id: 'u-1', code: 'SL-U1', subledgerType: undefined as unknown as string, entryCount: 2, bookBalance: 20 }),
    book({ id: 'u-2', code: 'SL-U2', subledgerType: '   ', entryCount: 1, bookBalance: 10 }),
    book({ id: 'c-1', code: 'SL-C1', subledgerType: 'CUSTOMER' }),
  ]);
  assert.deepEqual(groups.map((group) => group.key), ['CUSTOMER', UNSPECIFIED_SUBLEDGER_GROUP]);
  assert.equal(groups[1].bookCount, 2);
  assert.equal(groups[1].entryCount, 3);
  assert.equal(groups[1].bookBalance, 30);
});

test('an empty register has no groups and partial money fields stay unreported', () => {
  assert.deepEqual(buildSubledgerGroups([]), []);

  const groups = buildSubledgerGroups([
    book({ id: 'p-1', code: 'SL-P1', entryCount: undefined as unknown as number, bookBalance: undefined as unknown as number }),
    book({ id: 'p-2', code: 'SL-P2', entryCount: 4, bookBalance: 40 }),
  ]);
  assert.equal(groups[0].bookCount, 2);
  assert.equal(groups[0].entryCount, null);
  assert.equal(groups[0].bookBalance, null);
});
