/**
 * Classic double-entry posting engine — pure unit tests.
 *
 * The engine's whole job is one translation: an account plus `increase` (a
 * business statement) plus an amount becomes a debit or a credit, decided only
 * by that account's permanent `normal_balance`. These tests pin the four
 * combinations directly, then replay the journal shapes the operational
 * documents post, so a posting service cannot quietly go back to stating a
 * column of its own.
 *
 * No database is involved: `buildJournalLines` is pure and `journalLineTotals`
 * is integer-cent arithmetic, which is why a one-cent imbalance is provable
 * here rather than at the SQL layer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJournalLines,
  journalLineTotals,
  postJournalLegs,
  type JournalLeg,
  type JournalLegAccount,
} from '../server/src/services/accounting.service';
import {
  NORMAL_BALANCE_BY_POSTING_ROLE,
  POSTING_ROLES,
} from '../server/src/models/accounting.repo';

/**
 * The chart the replay runs against: only the accounts these journals touch.
 * `D`/`C` are the permanent sides a fresh seed gives them, including the two
 * contra accounts (1525 accumulated depreciation, 4090 sales returns).
 */
const CHART: Record<string, { code: string; side: 'D' | 'C' }> = {
  '2310': { code: '2310', side: 'D' }, // Cash
  '2320': { code: '2320', side: 'D' }, // Bank
  '9050': { code: '9050', side: 'D' }, // Wallet clearing
  '2110': { code: '2110', side: 'D' }, // Accounts receivable
  '2030': { code: '2030', side: 'D' }, // Inventory
  '2210': { code: '2210', side: 'D' }, // VAT input
  '1030': { code: '1030', side: 'D' }, // Deployed CPE assets
  '1000': { code: '1000', side: 'D' }, // Fixed assets at cost
  '1090': { code: '1090', side: 'C' }, // Accumulated depreciation
  '9000': { code: '9000', side: 'D' }, // Due from head office
  '2140': { code: '2140', side: 'D' }, // Employee advances
  '5010': { code: '5010', side: 'C' }, // Accounts payable
  '5210': { code: '5210', side: 'C' }, // VAT output
  '9010': { code: '9010', side: 'C' }, // Due to head office
  '5270': { code: '5270', side: 'C' }, // Salary payable
  '5220': { code: '5220', side: 'C' }, // TDS payable
  '5250': { code: '5250', side: 'C' }, // SSF payable
  '3100': { code: '3100', side: 'C' }, // Retained earnings
  '6010': { code: '6010', side: 'C' }, // Sales revenue
  '6090': { code: '6090', side: 'D' }, // Sales returns (contra-income)
  '7000': { code: '7000', side: 'D' }, // Cost of goods sold
  '7050': { code: '7050', side: 'D' }, // Stock expense
  '7210': { code: '7210', side: 'D' }, // Depreciation expense
  '7110': { code: '7110', side: 'D' }, // Salary expense
  '7430': { code: '7430', side: 'D' }, // Payment processing fees
};

const ACCOUNTS = new Map<string, JournalLegAccount>(
  Object.entries(CHART).map(([code, account]) => [
    `gla-${code}`,
    { id: `gla-${code}`, code: account.code, accountNormalBalance: account.side },
  ])
);

/** One journal line as the tests state it: account, debit, credit. */
type ExpectedLine = [code: string, debit: number, credit: number];

function build(code: string, increase: boolean, amount: number | string): JournalLeg {
  return { accountId: `gla-${code}`, increase, amount };
}

/** Build the lines for a leg set and prove they are cent-exactly balanced. */
function buildBalanced(legs: JournalLeg[]) {
  const lines = buildJournalLines(legs, ACCOUNTS);
  const totals = journalLineTotals(lines);
  assert.ok(
    totals.balanced,
    `expected a balanced journal, got debit ${totals.debitCents} and credit ${totals.creditCents}`
  );
  return lines;
}

function asExpected(lines: ReturnType<typeof buildJournalLines>): ExpectedLine[] {
  return lines.map((line) => {
    const account = ACCOUNTS.get(String(line.accountId));
    return [String(account?.code), Number(line.debit), Number(line.credit)] as ExpectedLine;
  });
}

describe('normal balance × increase decides the side', () => {
  test('a debit-normal account increases with a debit and decreases with a credit', () => {
    const [increase] = buildJournalLines([build('2030', true, 100), build('6010', true, 100)], ACCOUNTS);
    assert.deepEqual(asExpected([increase]), [['2030', 100, 0]]);

    const [decrease] = buildJournalLines([build('2030', false, 100), build('6010', false, 100)], ACCOUNTS);
    assert.deepEqual(asExpected([decrease]), [['2030', 0, 100]]);
  });

  test('a credit-normal account increases with a credit and decreases with a debit', () => {
    const [increase] = buildJournalLines([build('6010', true, 100), build('2030', false, 100)], ACCOUNTS);
    assert.deepEqual(asExpected([increase]), [['6010', 0, 100]]);

    const [decrease] = buildJournalLines([build('6010', false, 100), build('2030', true, 100)], ACCOUNTS);
    assert.deepEqual(asExpected([decrease]), [['6010', 100, 0]]);
  });

  test('all four combinations in one journal balance to the same amount', () => {
    const lines = buildBalanced([
      build('2030', true, 250), // D increase → debit
      build('6010', false, 250), // C decrease → debit
      build('2030', false, 250), // D decrease → credit
      build('6010', true, 250), // C increase → credit
    ]);
    assert.deepEqual(asExpected(lines), [
      ['2030', 250, 0],
      ['6010', 250, 0],
      ['2030', 0, 250],
      ['6010', 0, 250],
    ]);
  });

  test('the side comes from the account, never from the role name or position', () => {
    // 4090 is an INCOME-group account with a debit-normal side. A "revenue
    // account is always credited" rule would get this wrong.
    const [line] = buildJournalLines([build('6090', true, 75), build('6010', true, 75)], ACCOUNTS);
    assert.deepEqual(asExpected([line]), [['6090', 75, 0]]);
    // 1525 is an ASSET-group account with a credit-normal side.
    const [accumulated] = buildJournalLines([build('1090', true, 75), build('7210', true, 75)], ACCOUNTS);
    assert.deepEqual(asExpected([accumulated]), [['1090', 0, 75]]);
  });
});

describe('leg validation', () => {
  test('an amount is rounded to cents once, so fractional legs still balance', () => {
    const lines = buildBalanced([
      build('2110', true, 0.1),
      build('6010', true, 0.1),
      build('2110', true, 0.2),
      build('6010', true, 0.2),
    ]);
    const totals = journalLineTotals(lines);
    assert.equal(totals.debitCents, 30);
    assert.equal(totals.creditCents, 30);
  });

  test('a one-cent imbalance is detected exactly', () => {
    const lines = buildJournalLines([build('2110', true, 100), build('6010', true, 99.99)], ACCOUNTS);
    const totals = journalLineTotals(lines);
    assert.equal(totals.balanced, false);
    assert.equal(totals.debitCents - totals.creditCents, 1);
  });

  test('zero, negative and non-numeric amounts are refused', () => {
    for (const amount of [0, -1, 'abc', Number.NaN]) {
      assert.throws(
        () => buildJournalLines([build('2110', true, amount), build('6010', true, 100)], ACCOUNTS),
        /positive number/,
        `amount ${String(amount)} must be refused`
      );
    }
  });

  test('an unknown account is refused', () => {
    assert.throws(
      () => buildJournalLines([build('9999', true, 10), build('6010', true, 10)], ACCOUNTS),
      /account not found/
    );
  });

  test('an account with no permanent normal balance is refused, not guessed', () => {
    const chart = new Map<string, JournalLegAccount>([
      ['gla-2110', { id: 'gla-2110', code: '2110', accountNormalBalance: null }],
      ['gla-6010', { id: 'gla-6010', code: '6010', accountNormalBalance: 'C' }],
    ]);
    assert.throws(
      () =>
        buildJournalLines(
          [
            { accountId: 'gla-2110', increase: true, amount: 10 },
            { accountId: 'gla-6010', increase: true, amount: 10 },
          ],
          chart
        ),
      /has no normal balance/
    );
  });

  test('a single leg is not a journal', () => {
    assert.throws(() => buildJournalLines([build('2110', true, 10)], ACCOUNTS), /at least two legs/);
  });

  test('postJournalLegs refuses an unbalanced leg set before it writes anything', async () => {
    // The stub client proves the refusal happens after reading the accounts and
    // before any journal/lines insert: unbalanced legs never reach the writer.
    let queries = 0;
    const client = {
      query: async () => {
        queries += 1;
        return { rows: [...ACCOUNTS.values()] };
      },
    } as any;
    await assert.rejects(
      () =>
        postJournalLegs(client, {
          journalDateAD: '2026-11-15',
          branchId: 'BR-TEST',
          sourceType: 'TEST',
          legs: [build('2110', true, 100), build('6010', true, 99.99)],
        }),
      /not balanced/,
      'a one-cent imbalance must be refused'
    );
    assert.equal(queries, 1, 'only the account lookup ran; nothing was written');
  });

  test('a control leg keeps its subledger party, an ordinary leg carries none', () => {
    const lines = buildJournalLines(
      [
        {
          accountId: 'gla-2110',
          increase: true,
          amount: 50,
          memo: 'receivable',
          subledgerType: 'CUSTOMER',
          partyId: 'CUS-1',
          partyName: 'Test Customer',
          costCenterId: null,
        },
        {
          accountId: 'gla-6010',
          increase: true,
          amount: 50,
          memo: 'revenue',
        },
      ],
      ACCOUNTS
    );
    assert.equal(lines[0].subledgerType, 'CUSTOMER');
    assert.equal(lines[0].partyId, 'CUS-1');
    assert.equal(lines[0].partyName, 'Test Customer');
    assert.equal(lines[1].subledgerType, undefined);
    assert.equal(lines[1].partyId, undefined);
  });
});

describe('golden document postings', () => {
  test('sales invoice: AR up, revenue and output VAT up, COGS up and inventory down', () => {
    const lines = buildBalanced([
      build('2110', true, 1130),
      build('6010', true, 1000),
      build('5210', true, 130),
      build('7000', true, 700),
      build('2030', false, 700),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['2110', 1130, 0],
      ['6010', 0, 1000],
      ['5210', 0, 130],
      ['7000', 700, 0],
      ['2030', 0, 700],
    ]);
  });

  test('purchase invoice: inventory and input VAT up, AP up', () => {
    const lines = buildBalanced([
      build('2030', true, 500),
      build('2210', true, 65),
      build('5010', true, 565),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['2030', 500, 0],
      ['2210', 65, 0],
      ['5010', 0, 565],
    ]);
  });

  test('sales return: contra-income ledger debited, AR and output VAT reduced, stock restored', () => {
    const lines = buildBalanced([
      build('2110', false, 226),
      build('6090', true, 200),
      build('5210', false, 26),
      build('2030', true, 140),
      build('7000', false, 140),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['2110', 0, 226],
      ['6090', 200, 0],
      ['5210', 26, 0],
      ['2030', 140, 0],
      ['7000', 0, 140],
    ]);
  });

  test('purchase return: AP reduced, inventory and input VAT reduced', () => {
    const lines = buildBalanced([
      build('5010', false, 113),
      build('2030', false, 100),
      build('2210', false, 13),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['5010', 113, 0],
      ['2030', 0, 100],
      ['2210', 0, 13],
    ]);
  });

  test('customer receipt: custody up, receivable down', () => {
    const lines = buildBalanced([build('2320', true, 600), build('2110', false, 600)]);
    assert.deepEqual(asExpected(lines), [
      ['2320', 600, 0],
      ['2110', 0, 600],
    ]);
  });

  test('vendor payment: payable down, custody down', () => {
    const lines = buildBalanced([build('5010', false, 400), build('2320', false, 400)]);
    assert.deepEqual(asExpected(lines), [
      ['5010', 400, 0],
      ['2320', 0, 400],
    ]);
  });

  test('payroll run: salary cost debited, every deduction and net payable credited', () => {
    // gross 1000 + employer SSF 150 = 1150 cost; employee SSF 50 + employer
    // 150 = 200 SSF payable; advance recovery reduces an asset.
    const lines = buildBalanced([
      build('7110', true, 1150),
      build('5220', true, 100),
      build('5250', true, 200),
      build('2140', false, 50),
      build('5270', true, 800),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['7110', 1150, 0],
      ['5220', 0, 100],
      ['5250', 0, 200],
      ['2140', 0, 50],
      ['5270', 0, 800],
    ]);
  });

  test('payroll payment: net payable down, till down', () => {
    const lines = buildBalanced([build('5270', false, 800), build('2310', false, 800)]);
    assert.deepEqual(asExpected(lines), [
      ['5270', 800, 0],
      ['2310', 0, 800],
    ]);
  });

  test('depreciation: expense up and the contra-asset increased on its credit side', () => {
    const lines = buildBalanced([build('7210', true, 125), build('1090', true, 125)]);
    assert.deepEqual(asExpected(lines), [
      ['7210', 125, 0],
      ['1090', 0, 125],
    ]);
  });

  test('disposal at book value: accumulated depreciation cleared, proceeds in, cost out', () => {
    const lines = buildBalanced([
      build('1090', false, 100),
      build('2310', true, 300),
      build('1000', false, 400),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['1090', 100, 0],
      ['2310', 300, 0],
      ['1000', 0, 400],
    ]);
  });

  test('wallet settlement: bank net in, provider fee expensed, clearing gross out', () => {
    const lines = buildBalanced([
      build('2320', true, 970),
      build('7430', true, 30),
      build('9050', false, 1000),
    ]);
    assert.deepEqual(asExpected(lines), [
      ['2320', 970, 0],
      ['7430', 30, 0],
      ['9050', 0, 1000],
    ]);
  });

  test('inter-branch movement: each branch carries its own custody side', () => {
    const dispatch = buildBalanced([build('9000', true, 700), build('2030', false, 700)]);
    assert.deepEqual(asExpected(dispatch), [
      ['9000', 700, 0],
      ['2030', 0, 700],
    ]);
    const receipt = buildBalanced([build('2030', true, 700), build('9010', true, 700)]);
    assert.deepEqual(asExpected(receipt), [
      ['2030', 700, 0],
      ['9010', 0, 700],
    ]);
  });

  test('year-end close zeroes P&L accounts by DECREASING them, whatever their side', () => {
    const lines = buildBalanced([
      build('6010', false, 1500), // credit-normal income → debit
      build('7000', false, 1000), // debit-normal expense → credit
      build('3100', true, 500), // retained earnings → credit
    ]);
    assert.deepEqual(asExpected(lines), [
      ['6010', 1500, 0],
      ['7000', 0, 1000],
      ['3100', 0, 500],
    ]);
  });
});

/**
 * The replay: twenty journals in posting order, each with its hand-written
 * golden lines. Every journal must reproduce its golden exactly, and the
 * accumulated trial balance must equal the golden one — which is why a single
 * wrong side anywhere in the engine shows up as both a line diff and a net
 * difference.
 */
const REPLAY: Array<{ label: string; legs: JournalLeg[]; expect: ExpectedLine[] }> = [
  {
    label: 'sales invoice 1',
    legs: [
      build('2110', true, 1130),
      build('6010', true, 1000),
      build('5210', true, 130),
      build('7000', true, 700),
      build('2030', false, 700),
    ],
    expect: [
      ['2110', 1130, 0],
      ['6010', 0, 1000],
      ['5210', 0, 130],
      ['7000', 700, 0],
      ['2030', 0, 700],
    ],
  },
  {
    label: 'purchase invoice 1',
    legs: [build('2030', true, 500), build('2210', true, 65), build('5010', true, 565)],
    expect: [
      ['2030', 500, 0],
      ['2210', 65, 0],
      ['5010', 0, 565],
    ],
  },
  {
    label: 'customer receipt 1',
    legs: [build('2320', true, 600), build('2110', false, 600)],
    expect: [
      ['2320', 600, 0],
      ['2110', 0, 600],
    ],
  },
  {
    label: 'vendor payment 1',
    legs: [build('5010', false, 400), build('2320', false, 400)],
    expect: [
      ['5010', 400, 0],
      ['2320', 0, 400],
    ],
  },
  {
    label: 'sales return 1',
    legs: [
      build('2110', false, 226),
      build('6090', true, 200),
      build('5210', false, 26),
      build('2030', true, 140),
      build('7000', false, 140),
    ],
    expect: [
      ['2110', 0, 226],
      ['6090', 200, 0],
      ['5210', 26, 0],
      ['2030', 140, 0],
      ['7000', 0, 140],
    ],
  },
  {
    label: 'purchase return 1',
    legs: [build('5010', false, 113), build('2030', false, 100), build('2210', false, 13)],
    expect: [
      ['5010', 113, 0],
      ['2030', 0, 100],
      ['2210', 0, 13],
    ],
  },
  {
    label: 'payroll run 1',
    legs: [
      build('7110', true, 1150),
      build('5220', true, 100),
      build('5250', true, 200),
      build('2140', false, 50),
      build('5270', true, 800),
    ],
    expect: [
      ['7110', 1150, 0],
      ['5220', 0, 100],
      ['5250', 0, 200],
      ['2140', 0, 50],
      ['5270', 0, 800],
    ],
  },
  {
    label: 'payroll payment 1',
    legs: [build('5270', false, 800), build('2310', false, 800)],
    expect: [
      ['5270', 800, 0],
      ['2310', 0, 800],
    ],
  },
  {
    label: 'depreciation 1',
    legs: [build('7210', true, 125), build('1090', true, 125)],
    expect: [
      ['7210', 125, 0],
      ['1090', 0, 125],
    ],
  },
  {
    label: 'asset disposal at book value',
    legs: [build('1090', false, 100), build('2310', true, 300), build('1000', false, 400)],
    expect: [
      ['1090', 100, 0],
      ['2310', 300, 0],
      ['1000', 0, 400],
    ],
  },
  {
    label: 'transfer dispatch',
    legs: [build('9000', true, 700), build('2030', false, 700)],
    expect: [
      ['9000', 700, 0],
      ['2030', 0, 700],
    ],
  },
  {
    label: 'transfer receipt',
    legs: [build('2030', true, 700), build('9010', true, 700)],
    expect: [
      ['2030', 700, 0],
      ['9010', 0, 700],
    ],
  },
  {
    label: 'wallet settlement 1',
    legs: [build('2320', true, 970), build('7430', true, 30), build('9050', false, 1000)],
    expect: [
      ['2320', 970, 0],
      ['7430', 30, 0],
      ['9050', 0, 1000],
    ],
  },
  {
    label: 'stock write-off',
    legs: [build('7050', true, 250), build('2030', false, 250)],
    expect: [
      ['7050', 250, 0],
      ['2030', 0, 250],
    ],
  },
  {
    label: 'found stock',
    legs: [build('2030', true, 80), build('7050', false, 80)],
    expect: [
      ['2030', 80, 0],
      ['7050', 0, 80],
    ],
  },
  {
    label: 'CPE issue',
    legs: [build('1030', true, 350), build('2030', false, 350)],
    expect: [
      ['1030', 350, 0],
      ['2030', 0, 350],
    ],
  },
  {
    label: 'CPE release',
    legs: [build('2030', true, 350), build('1030', false, 350)],
    expect: [
      ['2030', 350, 0],
      ['1030', 0, 350],
    ],
  },
  {
    label: 'sales invoice 2',
    legs: [
      build('2110', true, 565),
      build('6010', true, 500),
      build('5210', true, 65),
      build('7000', true, 300),
      build('2030', false, 300),
    ],
    expect: [
      ['2110', 565, 0],
      ['6010', 0, 500],
      ['5210', 0, 65],
      ['7000', 300, 0],
      ['2030', 0, 300],
    ],
  },
  {
    label: 'wallet receipt with settlement',
    legs: [build('9050', true, 226), build('2110', false, 226)],
    expect: [
      ['9050', 226, 0],
      ['2110', 0, 226],
    ],
  },
  {
    label: 'year-end close',
    legs: [build('6010', false, 1500), build('7000', false, 1000), build('3100', true, 500)],
    expect: [
      ['6010', 1500, 0],
      ['7000', 0, 1000],
      ['3100', 0, 500],
    ],
  },
];

describe('twenty-journal golden replay', () => {
  test('the fixture is exactly twenty journals, each balanced', () => {
    assert.equal(REPLAY.length, 20);
    for (const journal of REPLAY) {
      const expectedDebit = journal.expect.reduce((sum, line) => sum + line[1], 0);
      const expectedCredit = journal.expect.reduce((sum, line) => sum + line[2], 0);
      assert.equal(expectedDebit, expectedCredit, `${journal.label}: golden lines must balance`);
    }
  });

  test('every replayed journal reproduces its golden lines', () => {
    for (const journal of REPLAY) {
      const lines = buildJournalLines(journal.legs, ACCOUNTS);
      assert.ok(journalLineTotals(lines).balanced, `${journal.label} must balance`);
      assert.deepEqual(asExpected(lines), journal.expect, `${journal.label} changed`);
    }
  });

  test('the replayed trial balance matches the golden balances', () => {
    const goldenNet = new Map<string, number>();
    let goldenDebitCents = 0;
    let goldenCreditCents = 0;
    for (const journal of REPLAY) {
      for (const [code, debit, credit] of journal.expect) {
        goldenDebitCents += Math.round(debit * 100);
        goldenCreditCents += Math.round(credit * 100);
        goldenNet.set(code, (goldenNet.get(code) || 0) + Math.round((debit - credit) * 100));
      }
    }
    assert.equal(goldenDebitCents, goldenCreditCents, 'the golden trial balance must be balanced');

    const replayedNet = new Map<string, number>();
    let replayedDebitCents = 0;
    let replayedCreditCents = 0;
    for (const journal of REPLAY) {
      const lines = buildJournalLines(journal.legs, ACCOUNTS);
      const totals = journalLineTotals(lines);
      replayedDebitCents += totals.debitCents;
      replayedCreditCents += totals.creditCents;
      for (const line of lines) {
        const code = String(ACCOUNTS.get(String(line.accountId))?.code);
        const net = Math.round(Number(line.debit) * 100) - Math.round(Number(line.credit) * 100);
        replayedNet.set(code, (replayedNet.get(code) || 0) + net);
      }
    }

    assert.equal(replayedDebitCents, goldenDebitCents);
    assert.equal(replayedCreditCents, goldenCreditCents);
    assert.deepEqual(
      Object.fromEntries([...replayedNet.entries()].sort()),
      Object.fromEntries([...goldenNet.entries()].sort())
    );

    // Hand-checked spot values, so the golden map itself is not the only claim.
    assert.equal(replayedNet.get('2110'), 64_300, 'AR nets to 643.00');
    assert.equal(replayedNet.get('2030'), -63_000, 'inventory nets to -630.00');
    assert.equal(replayedNet.get('6090'), 20_000, 'sales returns carries 200.00 debit');
  });
});

describe('role → permanent side map', () => {
  test('every posting role has exactly one side, and the contra roles are the exceptions', () => {
    assert.deepEqual(
      Object.keys(NORMAL_BALANCE_BY_POSTING_ROLE).sort(),
      [...POSTING_ROLES].sort(),
      'the map must cover every posting role'
    );
    assert.equal(NORMAL_BALANCE_BY_POSTING_ROLE.SALES, 'C');
    assert.equal(NORMAL_BALANCE_BY_POSTING_ROLE.SALES_RETURNS, 'D');
    assert.equal(NORMAL_BALANCE_BY_POSTING_ROLE.ACCUMULATED_DEPRECIATION, 'C');
    assert.equal(NORMAL_BALANCE_BY_POSTING_ROLE.AR_CONTROL, 'D');
    assert.equal(NORMAL_BALANCE_BY_POSTING_ROLE.AP_CONTROL, 'C');
  });
});
