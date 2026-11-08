/**
 * Serial log CSV projection — pure, no DOM, no database.
 *
 * The register is paged and exported through the unpaged read. This test pins
 * the resulting file's date pair: Last Updated must travel as explicit AD and
 * BS columns, so a spreadsheet reader never has to convert the Nepali date —
 * or silently lose it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SerialLog } from '../client/src/types';
import {
  buildSerialLogExportRows,
  serialLogExportColumns,
} from '../client/src/utils/serialLogExport';
import { buildExportCsv } from '../client/src/utils/exportUtils';
import { formatBSDate } from '../client/src/utils/nepaliCalendar';

function serialLog(overrides: Partial<SerialLog> = {}): SerialLog {
  return {
    id: 'sl-1',
    deviceSerial: 'SN-1',
    productName: 'Router X',
    branchId: 'WH001',
    status: 'IN_STOCK',
    sourceType: 'PURCHASE',
    history: [],
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-20T10:30:00.000Z',
    ...overrides,
  };
}

describe('serial log CSV projection', () => {
  test('Last Updated ships as an explicit AD/BS pair in the CSV', () => {
    const columns = serialLogExportColumns();
    assert.deepEqual(
      columns.slice(-2).map((column) => `${String(column.key)}:${column.label}`),
      ['lastUpdatedAD:Last Updated (AD)', 'lastUpdatedBS:Last Updated (BS)']
    );

    const rows = buildSerialLogExportRows([serialLog()]);
    const { content } = buildExportCsv({
      filename: 'Serial_Log_Register',
      includeMetadataHeader: false,
      data: rows,
      columns,
    });

    assert.match(content, /"Last Updated \(AD\)","Last Updated \(BS\)"/);
    assert.ok(content.includes('2026-11-20T10:30:00.000Z'), 'the AD timestamp must reach the file');
    const bs = formatBSDate('2026-11-20');
    assert.ok(bs && bs !== '-', 'the fixture date must resolve in the seeded BS calendar');
    assert.ok(content.includes(bs), `expected the BS half ${bs} in the CSV`);
    assert.notEqual(rows[0].lastUpdatedBS, rows[0].lastUpdatedAD, 'BS must not repeat the AD value');
  });
});
