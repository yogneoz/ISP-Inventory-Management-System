/**
 * Report/export dual-date guard (2026-11-07).
 *
 * Persisting BS beside AD is only half of the Nepal dual-date rule: every CSV
 * report must print both calendars too. This guard scans every client file that
 * builds export columns — every exportToCSV(...) call site plus reusable
 * CSVColumn builders — and reports an AD date column (key ending in `AD`, or a
 * label carrying `(AD)`) that has no matching BS column, a BS-only column with
 * no AD half, and a bare date-like label that does not say which calendar it
 * prints.
 *
 * A future report can therefore no longer silently export one calendar. PDF
 * statements are covered by tests/financeBsDateReports.test.ts; this is the
 * equivalent net across the CSV/report surfaces.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ledgerExportColumns } from '../client/src/components/common/LedgerView';
import { warrantyExportColumns } from '../client/src/utils/warrantyExport';

export interface UnpairedExportDate {
  file: string;
  line: number;
  column: string;
  expected: string;
}

const AD_KEY = /AD$/;
const AD_LABEL = /\(AD\)/;
const BS_KEY = /BS$/;
const BS_LABEL = /\(BS\)/;
/** A key whose value is a date, even when it never says AD or BS. */
const DATE_LIKE_KEY =
  /(?:Date|Timestamp|Updated|Expiry|Expires|Delivery)$|^(?:date|timestamp|updated|expiry|expires|delivery)(?:$|[A-Z])/;
/** A label whose value is a date, even when it never says AD or BS. */
const DATE_LIKE_LABEL = /\b(date|timestamp|updated|expiry|expires|delivery)\b/i;

/**
 * Pure detection core. Sources are scanned as text because most columns are
 * declared inline at their export call site; comparing the key/label sets of
 * one builder catches a missing BS half without depending on runtime data.
 */
export function findUnpairedExportDates(
  sources: Array<{ file: string; source: string }>
): UnpairedExportDate[] {
  const violations: UnpairedExportDate[] = [];

  for (const { file, source } of sources) {
    const keys = [...source.matchAll(/key:\s*['"]([^'"]+)['"]/g)];
    const labels = [...source.matchAll(/label:\s*['"]([^'"]+)['"]/g)];
    const keySet = new Set(keys.map((match) => match[1]));
    const labelSet = new Set(labels.map((match) => match[1]));
    const lineOf = (index: number) => source.slice(0, index).split(/\r?\n/).length;

    for (const match of keys) {
      const key = match[1];
      if (AD_KEY.test(key)) {
        const expected = `${key.slice(0, -2)}BS`;
        if (!keySet.has(expected)) {
          violations.push({ file, line: lineOf(match.index ?? 0), column: key, expected });
        }
      }
      if (BS_KEY.test(key)) {
        const expected = `${key.slice(0, -2)}AD`;
        if (!keySet.has(expected)) {
          violations.push({ file, line: lineOf(match.index ?? 0), column: key, expected });
        }
      }
      if (!AD_KEY.test(key) && !BS_KEY.test(key) && DATE_LIKE_KEY.test(key)) {
        violations.push({
          file,
          line: lineOf(match.index ?? 0),
          column: key,
          expected: `${key}AD / ${key}BS`,
        });
      }
    }

    for (const match of labels) {
      const label = match[1];
      const line = lineOf(match.index ?? 0);
      // A bare "Last Updated" / "Date" column silently prints one calendar
      // even when no AD suffix admits it. Make the pair explicit.
      if (!label.includes('(AD)') && !label.includes('(BS)') && DATE_LIKE_LABEL.test(label)) {
        violations.push({
          file,
          line,
          column: label,
          expected: `${label} (AD) and ${label} (BS)`,
        });
        continue;
      }
      if (!AD_LABEL.test(label)) continue;
      // A key ending in AD on the same line is already covered above; checking
      // the label again would double-report one column.
      const coveredByKey = keys.some(
        (keyMatch) => lineOf(keyMatch.index ?? 0) === line && AD_KEY.test(keyMatch[1])
      );
      if (coveredByKey) continue;
      const expected = label.replace('(AD)', '(BS)');
      if (!labelSet.has(expected)) {
        violations.push({ file, line, column: label, expected });
      }
    }

    for (const match of labels) {
      const label = match[1];
      if (!BS_LABEL.test(label)) continue;
      const line = lineOf(match.index ?? 0);
      // A key ending in BS on the same line is already covered above.
      const coveredByKey = keys.some(
        (keyMatch) => lineOf(keyMatch.index ?? 0) === line && BS_KEY.test(keyMatch[1])
      );
      if (coveredByKey) continue;
      const expected = label.replace('(BS)', '(AD)');
      if (!labelSet.has(expected)) {
        violations.push({ file, line, column: label, expected });
      }
    }
  }

  return violations;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

/** A CSV builder: a call site or a shared column-array factory. */
function isReportBuilder(source: string): boolean {
  return source.includes('exportToCSV(') || source.includes('CSVColumn<');
}

function liveBuilders(): Array<{ file: string; source: string }> {
  const root = path.resolve(process.cwd(), 'client', 'src');
  return collectSourceFiles(root)
    .map((file) => ({
      file: path.relative(process.cwd(), file).split(path.sep).join('/'),
      source: fs.readFileSync(file, 'utf8'),
    }))
    .filter(({ source }) => isReportBuilder(source));
}

function scanColumns(file: string, columns: Array<{ key: string | number | symbol; label: string }>) {
  const source = columns
    .map((column) => `{ key: '${String(column.key)}', label: '${column.label}' }`)
    .join('\n');
  return findUnpairedExportDates([{ file, source }]);
}

describe('report/export guard: every AD date column has a BS half', () => {
  test('flags an export column that prints only the AD date', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source:
          "columns: [\n  { key: 'invoiceDateAD', label: 'Invoice Date (AD)' },\n  { key: 'totalAmount', label: 'Total' },\n]",
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => `${violation.column} -> ${violation.expected}`),
      ['invoiceDateAD -> invoiceDateBS']
    );
  });

  test('flags a label-only AD date even when its key has no AD suffix', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source: "{ key: 'period', label: 'Period (AD)' }",
      },
    ]);
    assert.deepEqual(violations.map((violation) => violation.expected), ['Period (BS)']);
  });

  test('flags a bare date-like label that names neither calendar', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source: "{ key: 'changed', label: 'Last Updated' }",
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => `${violation.column} -> ${violation.expected}`),
      ['Last Updated -> Last Updated (AD) and Last Updated (BS)']
    );
  });

  test('flags a BS-only export column without its AD half', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source: "{ key: 'expiryBS', label: 'Expiry (BS)' }",
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => `${violation.column} -> ${violation.expected}`),
      ['expiryBS -> expiryAD']
    );
  });

  test('flags a date-like key with neither AD nor BS suffix', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source: "{ key: 'lastUpdated', label: 'Changed' }",
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => `${violation.column} -> ${violation.expected}`),
      ['lastUpdated -> lastUpdatedAD / lastUpdatedBS']
    );
  });

  test('accepts paired key and label columns, and columns with no AD half', () => {
    const violations = findUnpairedExportDates([
      {
        file: 'client/src/features/example/Register.tsx',
        source: [
          "{ key: 'startAD', label: 'Coverage Start (AD)' },",
          "{ key: 'startBS', label: 'Coverage Start (BS)' },",
          "{ key: 'expiryAD', label: 'Warranty Expiry (AD)' },",
          "{ key: 'expiryBS', label: 'Warranty Expiry (BS)' },",
          "{ key: 'totalAmount', label: 'Total' },",
          "{ key: 'createdAt', label: 'Created' },",
        ].join('\n'),
      },
    ]);
    assert.deepEqual(violations, []);
  });

  test('live tree: every CSV/report builder pairs its AD date columns', () => {
    const builders = liveBuilders();
    assert.ok(
      builders.length >= 20,
      `expected to scan real report builders, got ${builders.length} files`
    );
    const violations = findUnpairedExportDates(builders);
    assert.deepEqual(
      violations,
      [],
      'A report exports an AD date without its BS half. Add the matching BS column to the same ' +
        'export (and read the stored BS field where the server provides one):\n' +
        violations
          .map((violation) => `  ${violation.file}:${violation.line} → ${violation.column} needs ${violation.expected}`)
          .join('\n')
    );
  });

  test('shared ledger and warranty builders ship both calendars', () => {
    const ledger = scanColumns('ledgerExportColumns', ledgerExportColumns({ date: 'Posting Date' }, 'AD'));
    const warranty = scanColumns('warrantyExportColumns', warrantyExportColumns(true));
    assert.deepEqual([...ledger, ...warranty], []);
  });

  test('purchase-order print and export show explicit AD and BS labels', () => {
    const source = read('client/src/features/procurement/PurchaseOrders.tsx');
    assert.ok(
      source.includes("key: 'expectedDeliveryDateBS'"),
      'the PO export must carry the stored expected-delivery BS column'
    );
    assert.ok(
      source.includes('Order Date (AD): {viewingPO.orderDateAD}') &&
        source.includes('Order Date (BS): {viewingPO.orderDateBS}'),
      'the printable PO header must label both order-date calendars'
    );
    assert.ok(
      source.includes('Expected Delivery (AD): {viewingPO.expectedDeliveryDateAD') &&
        source.includes('Expected Delivery (BS): {viewingPO.expectedDeliveryDateBS'),
      'the printable PO header must label both expected-delivery calendars'
    );
    assert.ok(
      source.includes('printable-document'),
      'the dual-date header must live inside the printable document container'
    );
  });
});
