/**
 * Finance dual-date write guard (2026-11-07).
 *
 * Every finance/accounting write stores a BS (Nepali) date beside its AD
 * business date. The service layer derives that BS half with bsDateOrThrow so a
 * client cannot supply it, and scripts/schema.sql constrains the columns — but
 * a future write path can still add an `INSERT INTO ... (...)` whose column list
 * carries the AD date and forgets the BS column, silently reintroducing the
 * bypass this hardening removed.
 *
 * PROVES (source scans + pure parser, no DB needed):
 *   - findUnpairedBusinessDates() flags an INSERT column list that carries a
 *     *_date / *_date_ad column without the matching *_bs column.
 *   - The live server tree is clean today, so every existing finance write
 *     persists both halves.
 *   - Finance write paths still derive BS server-side via bsDateOrThrow().
 *   - scripts/schema.sql keeps the NOT NULL / conditional CHECK constraints
 *     that reject an AD business date without its BS half.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export interface UnpairedBsDate {
  file: string;
  table: string;
  line: number;
  adColumn: string;
  expectedBsColumn: string;
}

/** An AD business-date column: `journal_date`, `entry_date`, `start_date_ad`. */
const BUSINESS_DATE_COLUMN = /_date(_ad)?$/;

/**
 * Tables whose date columns are deliberately outside the finance dual-date
 * rule. Each entry states why, so a future finance table cannot hide here.
 */
export const TABLE_EXEMPTIONS = new Map<string, string>([
  ['bs_day_records', 'the BS calendar source itself: ad_date/bs_date ARE the mapping'],
  ['bs_months', 'the derived BS month/quarter reference: ad_date/bs_date and their month-end twins ARE the mapping'],
  ['document_sequence_daily', 'daily document-number counter keyed by date; not a business-date record'],
  ['gl_recurring_templates', 'recurring schedule metadata: start/end/next/last run are AD planning dates; the generated journal carries the posted dual date'],
  ['gl_recurring_runs', 'idempotency log keyed by the posted journal date; the journal itself carries the business dual date'],
  ['gl_journals_registry', 'non-partitioned identity registry for external journal FKs; the ledger journal carries the dual date'],
  ['gl_journal_line_registry', 'non-partitioned identity registry for external line FKs; the ledger line carries the dual date'],
]);

/**
 * Columns whose date is intentionally AD-only. Employee master dates predate
 * or fall outside the seeded BS calendar, so forcing a BS half would reject a
 * valid joining date (and is not a finance posting date). The exemption is
 * per column, so a new date on the same table is still guarded.
 */
export const COLUMN_EXEMPTIONS = new Map<string, string>([
  ['employees.joining_date_ad', 'employee master joining date is intentionally AD-only'],
  ['employees.date_of_birth_ad', 'employee master date of birth is intentionally AD-only'],
  ['employees.contract_expiry_ad', 'employee master contract expiry is intentionally AD-only'],
  ['employees.separation_date_ad', 'employee master separation date is intentionally AD-only'],
  ['employees.declaration_date_ad', 'employee master declaration date is intentionally AD-only'],
]);

/**
 * Pure detection core: scan TS sources for INSERT column lists and report every
 * AD business date that is not paired with `<column>_bs` (or `_ad` → `_bs`) in
 * the same list. Absolute paths are not rewritten: callers pass repo-relative
 * paths and the output keeps them for a readable failure message.
 */
export function findUnpairedBusinessDates(
  sources: Array<{ file: string; source: string }>
): UnpairedBsDate[] {
  const violations: UnpairedBsDate[] = [];
  for (const { file, source } of sources) {
    const insert = /INSERT\s+INTO\s+([A-Za-z_][\w.]*)[^()]*\(([^()]*)\)/gi;
    let match: RegExpExecArray | null;
    while ((match = insert.exec(source))) {
      const table = match[1].toLowerCase().replace(/^.*\./, '');
      if (TABLE_EXEMPTIONS.has(table)) continue;
      const columns = match[2]
        .split(',')
        .map((column) => column.trim().toLowerCase())
        .filter(Boolean);
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      for (const column of columns) {
        if (!BUSINESS_DATE_COLUMN.test(column)) continue;
        if (COLUMN_EXEMPTIONS.has(`${table}.${column}`)) continue;
        const expectedBsColumn = `${column.replace(/_ad$/, '')}_bs`;
        if (columns.includes(expectedBsColumn)) continue;
        violations.push({ file, table, line, adColumn: column, expectedBsColumn });
      }
    }
  }
  return violations;
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTypeScriptFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('finance dual-date guard: INSERT columns must pair AD business dates with BS', () => {
  test('flags an INSERT that carries the AD business date without its BS half', () => {
    const violations = findUnpairedBusinessDates([
      {
        file: 'server/src/models/example.repo.ts',
        source: 'const SQL = `INSERT INTO gl_journals (id, journal_date, memo)\nVALUES ($1, $2, $3)`;',
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'server/src/models/example.repo.ts');
    assert.equal(violations[0].table, 'gl_journals');
    assert.equal(violations[0].adColumn, 'journal_date');
    assert.equal(violations[0].expectedBsColumn, 'journal_date_bs');
    assert.equal(violations[0].line, 1);
  });

  test('ignores paired date columns and non-date columns', () => {
    const violations = findUnpairedBusinessDates([
      {
        file: 'server/src/models/ok.repo.ts',
        source: `INSERT INTO gl_journals (
  id, journal_date, journal_date_bs, reference_date, reference_date_bs,
  created_at, posted_at
) VALUES ($1, $2, $3, $4, $5, now(), now())`,
      },
    ]);
    assert.deepEqual(violations, []);
  });

  test('pairs _date_ad columns with _date_bs and reports every unpaired column', () => {
    const violations = findUnpairedBusinessDates([
      {
        file: 'server/src/models/period.repo.ts',
        source:
          'INSERT INTO gl_periods (id, start_date_ad, start_date_bs, end_date_ad) VALUES ($1, $2, $3, $4)',
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => `${violation.adColumn} -> ${violation.expectedBsColumn}`),
      ['end_date_ad -> end_date_bs']
    );
  });

  test('exempts the calendar, numbering key and AD-only employee master dates', () => {
    const violations = findUnpairedBusinessDates([
      { file: 'a.ts', source: 'INSERT INTO bs_day_records (ad_date, bs_date) VALUES ($1, $2)' },
      { file: 'b.ts', source: 'INSERT INTO document_sequence_daily (date_ad) VALUES ($1)' },
      { file: 'c.ts', source: 'INSERT INTO payroll_runs (run_date_ad) VALUES ($1)' },
      {
        file: 'd.ts',
        source:
          'INSERT INTO employees (joining_date_ad, date_of_birth_ad, contract_expiry_ad, separation_date_ad) VALUES ($1, $2, $3, $4)',
      },
    ]);
    assert.deepEqual(
      violations.map((violation) => violation.table),
      ['payroll_runs']
    );
  });

  test('procurement and warranty business dates are guarded too', () => {
    const violations = findUnpairedBusinessDates([
      { file: 'a.ts', source: 'INSERT INTO purchase_orders (expected_delivery_date_ad) VALUES ($1)' },
      { file: 'b.ts', source: 'INSERT INTO warranty_coverages (start_date_ad) VALUES ($1)' },
    ]);
    assert.deepEqual(violations.map((violation) => violation.table).sort(), [
      'purchase_orders',
      'warranty_coverages',
    ]);
  });

  test('live tree: server/src never inserts a business date without its BS half', () => {
    const root = path.resolve(process.cwd(), 'server', 'src');
    const sources = collectTypeScriptFiles(root).map((file) => ({
      file: path.relative(process.cwd(), file).split(path.sep).join('/'),
      source: fs.readFileSync(file, 'utf8'),
    }));
    assert.ok(sources.length >= 20, `expected to scan a real tree, got ${sources.length} files`);
    const violations = findUnpairedBusinessDates(sources);
    assert.deepEqual(
      violations,
      [],
      `An INSERT stores an AD business date without its BS half. Derive it server-side\n` +
        `(bsDateOrThrow / resolveBsDateForLedger in server/src/utils/bsDate.ts) and add the\n` +
        `pairing column to the same INSERT:\n` +
        violations
          .map(
            (v) =>
              `  ${v.file}:${v.line} → ${v.table} ${v.adColumn} needs ${v.expectedBsColumn}`
          )
          .join('\n')
    );
  });

  test('finance write paths derive BS server-side instead of trusting the request', () => {
    const derives: Array<[string, string]> = [
      ['server/src/services/accounting.service.ts', 'journals and periods'],
      ['server/src/services/cashClose.service.ts', 'daily cash close'],
      ['server/src/controllers/inventory.controller.ts', 'fixed assets'],
      ['server/src/controllers/payroll.controller.ts', 'payroll runs and payments'],
      ['server/src/services/warranty.service.ts', 'warranty coverage boundaries'],
      ['server/src/controllers/procurement.controller.ts', 'purchase-order dates'],
    ];
    for (const [file, surface] of derives) {
      const source = read(file);
      assert.ok(
        source.includes('bsDateOrThrow(') ||
          source.includes('bsDateOr400(') ||
          source.includes('resolveBsDateForLedger('),
        `${file} must derive the ${surface} BS date server-side (bsDateOrThrow / bsDateOr400 / resolveBsDateForLedger)`
      );
    }
  });

  test('every operational schema table pairs each AD business date with a BS column', () => {
    const schema = read('scripts/schema.sql');
    const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\)(?: PARTITION BY [^;]+)?;/g;
    const violations: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(schema)) !== null) {
      const table = match[1].toLowerCase();
      if (TABLE_EXEMPTIONS.has(table)) continue;
      const body = match[2];
      const columns = new Set(
        [...body.matchAll(/^\s*([a-z][a-z0-9_]*)\s+/gim)].map((entry) => entry[1].toLowerCase())
      );
      for (const column of columns) {
        if (!BUSINESS_DATE_COLUMN.test(column)) continue;
        if (COLUMN_EXEMPTIONS.has(`${table}.${column}`)) continue;
        const expected = `${column.replace(/_ad$/, '')}_bs`;
        if (!columns.has(expected)) violations.push(`${table}.${column} -> ${expected}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test('schema keeps the NOT NULL / CHECK constraints behind every paired column', () => {
    const schema = read('scripts/schema.sql');
    const required = [
      'gl_journals ALTER COLUMN journal_date_bs SET NOT NULL',
      'gl_journal_lines ALTER COLUMN journal_date_bs SET NOT NULL',
      'gl_subledger_entries ALTER COLUMN entry_date_bs SET NOT NULL',
      'gl_periods ALTER COLUMN start_date_bs SET NOT NULL',
      'gl_periods ALTER COLUMN end_date_bs SET NOT NULL',
      'daily_cash_closes ALTER COLUMN business_date_bs SET NOT NULL',
      'payroll_runs ALTER COLUMN run_date_bs SET NOT NULL',
      'gl_journals_reference_bs_required',
      'gl_journals_cheque_bs_required',
      'payroll_runs_paid_bs_required',
      'fixed_assets_purchase_invoice_bs_required',
      'fixed_assets_capitalization_bs_required',
      'fixed_assets_placed_in_service_bs_required',
      'fixed_assets_assignment_bs_required',
      'purchase_orders_expected_delivery_bs_required',
      'warranty_coverages ALTER COLUMN start_date_bs SET NOT NULL',
      'warranty_coverages ALTER COLUMN end_date_bs SET NOT NULL',
    ];
    for (const fragment of required) {
      assert.ok(
        schema.includes(fragment),
        `scripts/schema.sql must keep the dual-date constraint: ${fragment}`
      );
    }
  });
});
