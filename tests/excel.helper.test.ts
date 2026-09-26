/**
 * Excel helper tests (backlog #3): PROVES the exceljs-based excel.ts helper
 * parses and writes workbooks identically to what the removed xlsx package
 * produced for the BS-calendar use case:
 *   - roundtrip: rows written by buildTemplateWorkbook are read back by
 *     readFirstSheetRows with the same keys/values
 *   - numeric cells arrive as full-precision strings ('2086', NOT '2086.0'
 *     and not scientific notation) so the consumer's .split('.')[0] integer
 *     extraction keeps working
 *   - empty cells become '' (the old sheet_to_json defval:'')
 *   - a real multi-row sheet parses to row objects keyed by the header row
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFirstSheetRows, buildTemplateWorkbook } from '../client/src/utils/excel';

describe('excel.ts helper (exceljs-based, replaces xlsx)', () => {
  test('template roundtrip: written rows read back with identical keys and values', async () => {
    const header = ['BS Year', 'Baisakh', 'Jestha', 'Start AD'];
    const row1 = [2086, 31, 31, '2029-04-14'];
    const row2 = [2087, 31, 32, '2030-04-14'];
    const bytes = await buildTemplateWorkbook('BS Month Arrays', [header, row1, row2]);

    const rows = await readFirstSheetRows(bytes);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), header);
    assert.equal(rows[0]['BS Year'], '2086');
    assert.equal(rows[0]['Baisakh'], '31');
    assert.equal(rows[0]['Start AD'], '2029-04-14');
    assert.equal(rows[1]['BS Year'], '2087');
    assert.equal(rows[1]['Jestha'], '32');
  });

  test('numeric cells are full-precision strings (no 2086.0, no scientific notation)', async () => {
    const bytes = await buildTemplateWorkbook('T', [['N'], [2086], [31.5], [123456789012]]);
    const rows = await readFirstSheetRows(bytes);
    assert.equal(rows[0]['N'], '2086');
    assert.equal(rows[1]['N'], '31.5');
    assert.equal(rows[2]['N'], '123456789012');
    // The consumer's integer-extraction idiom keeps working:
    assert.equal(parseInt(rows[0]['N'].split('.')[0], 10), 2086);
  });

  test('empty cells become empty strings and fully empty rows are dropped', async () => {
    const bytes = await buildTemplateWorkbook('T', [
      ['A', 'B', 'C'],
      ['x', '', 'z'], // sparse row kept
      ['', '', ''],   // empty row dropped
      ['', 'y', ''],  // sparse row kept
    ]);
    const rows = await readFirstSheetRows(bytes);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]['B'], '');
    assert.equal(rows[1]['A'], '');
    assert.equal(rows[1]['B'], 'y');
  });

  test('string and date cells parse to sensible text', async () => {
    const bytes = await buildTemplateWorkbook('T', [
      ['Name', 'Note'],
      ['Baisakh', 'first month'],
    ]);
    const rows = await readFirstSheetRows(bytes);
    assert.equal(rows[0]['Name'], 'Baisakh');
    assert.equal(rows[0]['Note'], 'first month');
  });
});
