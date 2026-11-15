import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatPartyBalance } from '../client/src/utils/nprFormat';

test('party balances use the accountant Dr/Cr convention', () => {
  assert.equal(formatPartyBalance(500).text, '500.00 Dr');
  assert.equal(formatPartyBalance(-1000).text, '1,000.00 Cr');
  assert.equal(formatPartyBalance(0).text, '0.00');
  assert.equal(formatPartyBalance(0).side, 'ZERO');
  assert.equal(formatPartyBalance(-0.004).side, 'ZERO');
  assert.equal(formatPartyBalance(1234.5).text, '1,234.50 Dr');
});