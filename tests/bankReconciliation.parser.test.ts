/**
 * Bank statement parsers. These are pure functions, so the aliases, signed
 * amounts, duplicate fingerprint and malformed-row handling are pinned without
 * a database. The API suite then proves the same rows persist and match.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bankStatementFingerprint,
  parseBankStatement,
  parseStatementDate,
} from '../server/src/services/bankReconciliation.service';

describe('bank statement parsing', () => {
  test('parses CSV aliases, debit/credit columns and signed amounts', () => {
    const csv = [
      'Transaction Date,Narration,Cheque No,Withdrawal,Deposit',
      '2026-10-02,Customer deposit,,,5000',
      '05/10/2026,Supplier payment,CHQ-1,"1,200.50",',
      '2026-10-06,Bank charge,,25,',
    ].join('\n');

    const parsed = parseBankStatement(csv);
    assert.equal(parsed.source, 'CSV');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(
      parsed.rows.map((row) => ({
        date: row.statementDate,
        reference: row.reference,
        amount: row.amount,
      })),
      [
        { date: '2026-10-02', reference: null, amount: 5000 },
        { date: '2026-10-05', reference: 'CHQ-1', amount: -1200.5 },
        { date: '2026-10-06', reference: null, amount: -25 },
      ]
    );
  });

  test('honours a type column when the amount itself is unsigned', () => {
    const csv = [
      'date,description,reference,amount,type',
      '2026-10-07,Card settlement,CARD-1,250,DEPOSIT',
      '2026-10-08,Cheque paid,CHQ-2,100,DEBIT',
    ].join('\n');

    const parsed = parseBankStatement(csv);
    assert.equal(parsed.rows[0].amount, 250);
    assert.equal(parsed.rows[1].amount, -100);
  });

  test('parses OFX STMTTRN records and OFX-style dates', () => {
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261009120000[0:GMT]
<TRNAMT>750.25
<FITID>FIT-1
<NAME>Online transfer
<MEMO>Customer ref 9
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261010
<TRNAMT>-80
<FITID>FIT-2
<NAME>ATM withdrawal
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const parsed = parseBankStatement(ofx, 'OFX');
    assert.equal(parsed.source, 'OFX');
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].statementDate, '2026-10-09');
    assert.equal(parsed.rows[0].amount, 750.25);
    assert.match(parsed.rows[0].description, /Online transfer/);
    assert.equal(parsed.rows[0].reference, 'FIT-1');
    assert.equal(parsed.rows[1].amount, -80);
  });

  test('collects bad rows without discarding valid ones', () => {
    const csv = [
      'date,description,amount',
      'not-a-date,Bad date,10',
      '2026-10-11,Good line,20',
      '2026-10-12,Zero amount,0',
    ].join('\n');

    const parsed = parseBankStatement(csv);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].amount, 20);
    assert.equal(parsed.errors.length, 2);
    assert.match(parsed.errors[0].message, /valid statement date/i);
    assert.match(parsed.errors[1].message, /non-zero amount/i);
  });

  test('rejects a CSV with no recognisable amount columns', () => {
    assert.throws(
      () => parseBankStatement('date,description\n2026-10-01,Nothing'),
      /date, description and amount/i
    );
  });

  test('fingerprints are stable across a duplicate import and differ by reference', () => {
    const row = {
      statementDate: '2026-10-02',
      description: 'Customer deposit',
      reference: ' DEP-1 ',
      amount: 5000,
    };
    const first = bankStatementFingerprint('acct-1', row);
    const duplicate = bankStatementFingerprint('acct-1', { ...row, reference: 'dep-1' });
    const different = bankStatementFingerprint('acct-1', { ...row, reference: 'DEP-2' });
    assert.equal(first, duplicate);
    assert.notEqual(first, different);
    assert.equal(first.length, 64);
  });

  test('accepts the common statement date forms', () => {
    assert.equal(parseStatementDate('2026-10-05'), '2026-10-05');
    assert.equal(parseStatementDate('05/10/2026'), '2026-10-05');
    assert.equal(parseStatementDate('20261005'), '2026-10-05');
    assert.equal(parseStatementDate('31/02/2026'), null);
  });
});
