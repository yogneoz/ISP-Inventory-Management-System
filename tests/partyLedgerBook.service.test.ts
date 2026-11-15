import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ensurePartySubledgerBook } from '../server/src/services/partyLedgerBook.service';

const control = {
  id: 'acct-ar',
  code: '1100',
  name: 'Accounts Receivable',
  postingRole: 'AR_CONTROL',
  subledgerType: 'CUSTOMER',
  groupCode: 'CA',
  groupName: 'Current Assets',
  parentGroupCode: null,
  parentGroupName: null,
};

function fakeClient(options: { control?: boolean; existing?: boolean } = {}) {
  const state = {
    insertedId: '',
    insertedCode: '',
    inserts: 0,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('a.posting_role = $1 AND a.is_control')) {
      return { rows: options.control === false ? [] : [control] };
    }
    if (sql.includes('WHERE s.main_account_id = $1 AND s.party_id = $2')) {
      if (options.existing || state.insertedId) {
        return { rows: [{ id: state.insertedId || 'book-existing' }] };
      }
      return { rows: [] };
    }
    if (sql.includes('WHERE s.id = $1')) {
      return { rows: [{ id: params[0], code: state.insertedCode || 'CUS-ABC', name: 'Abc' }] };
    }
    if (sql.includes('SELECT s.id FROM gl_subledgers s WHERE s.code = $1')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO gl_subledgers')) {
      state.inserts += 1;
      state.insertedId = String(params[0]);
      state.insertedCode = String(params[1]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query, state };
}

test('a new customer gets one party book under the AR control', async () => {
  const client = fakeClient();
  const result = await ensurePartySubledgerBook(client, {
    type: 'CUSTOMER',
    partyId: 'CUS-ABC',
    partyName: 'Abc',
    partyCode: 'CUS-ABC',
  });
  assert.equal(client.state.inserts, 1);
  assert.equal(result.warning, null);
  assert.equal(result.book?.created, true);
  assert.equal(result.book?.code, 'CUS-ABC');
  assert.equal(result.book?.controlAccountCode, '1100');
  assert.equal(result.book?.groupName, 'Current Assets');
});

test('an existing party book is reused rather than duplicated', async () => {
  const client = fakeClient({ existing: true });
  const result = await ensurePartySubledgerBook(client, {
    type: 'CUSTOMER',
    partyId: 'CUS-ABC',
    partyName: 'Abc',
  });
  assert.equal(client.state.inserts, 0);
  assert.equal(result.book?.created, false);
  assert.equal(result.book?.bookId, 'book-existing');
});

test('a missing control account saves the party but returns a visible warning', async () => {
  const client = fakeClient({ control: false });
  const result = await ensurePartySubledgerBook(client, {
    type: 'SUPPLIER',
    partyId: 'sup-1',
    partyName: 'Supplier One',
  });
  assert.equal(result.book, null);
  assert.equal(client.state.inserts, 0);
  assert.match(result.warning || '', /Accounts Payable control account/);
});