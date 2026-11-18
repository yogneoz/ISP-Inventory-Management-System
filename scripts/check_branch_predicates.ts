/**
 * CI guard: branch isolation on the partitioned tables (SCALE-3).
 *
 * The worklist's review checklist ("every query on a partitioned table carries a
 * `branch_id` predicate") was prose. A partitioned table is exactly where a
 * missing branch predicate is most expensive: without it the planner cannot
 * prune *and* the statement spans every tenant in the table at once. This guard
 * makes the checklist mechanical for the statements where it is a correctness
 * risk — mutations (`INSERT`, `UPDATE`, `DELETE`) against a branch-scoped
 * partitioned table — and requires every exception to be written down with a
 * reason.
 *
 *   npm run check:branch-predicates          # report; exit 1 on a violation
 *   npm run check:branch-predicates -- --json
 *
 * A statement passes when it either names `branch_id` or addresses rows by their
 * own unique `id` (one row, so no cross-branch blast radius). What it rejects is
 * the dangerous shape: a new mutation with neither — a status-only or
 * predicate-less UPDATE/DELETE over every branch.
 *
 * What it is not: a runtime substitute. The repository layer already scopes
 * reads through the session; this only fails CI when new SQL arrives that
 * writes to a partitioned table without saying which branch.
 *
 * In-scope tables are **derived from `scripts/schema.sql`**, not hard-coded: a
 * table that is `PARTITION BY RANGE` and has a `branch_id` column is in scope, so
 * adding a new partitioned table cannot silently escape the guard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BranchPredicateViolation {
  file: string;
  line: number;
  table: string;
  statement: string;
}

export interface BranchPredicateExemption {
  /** Path suffix, e.g. `server/src/boot/journalPartitionRepair.ts`. */
  file: string;
  /** Matched against the statement's first words, whitespace-collapsed. */
  startsWith: string;
  /** Why this statement deliberately covers every branch. */
  reason: string;
}

/**
 * Statements that legitimately span branches: single-tenant boot repairs and
 * operator-level maintenance. Each one carries the reason it is allowed.
 */
export const BRANCH_PREDICATE_EXEMPTIONS: BranchPredicateExemption[] = [
  {
    file: 'server/src/boot/journalPartitionRepair.ts',
    startsWith: 'INSERT INTO gl_journals SELECT * FROM repair_journals_stage',
    reason:
      'Boot repair: moves rows out of the DEFAULT partition of a single-tenant install, whatever branch they belong to. Refusing to move a row because it names a different branch would lose ledger data.',
  },
  {
    file: 'server/src/boot/journalPartitionRepair.ts',
    startsWith: 'INSERT INTO gl_journal_lines SELECT * FROM repair_lines_stage',
    reason:
      'Same boot repair for the journal lines: the rows were copied verbatim from the DEFAULT partition and are reinserted through the parent so each lands in its own month.',
  },
];

/** A table is branch-scoped when the schema gives it `branch_id` and partitions it. */
export function partitionedBranchTables(schemaSql: string): string[] {
  const tables: string[] = [];
  const createRe = /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\)\s*([^;]*);/gi;
  let match: RegExpExecArray | null;
  while ((match = createRe.exec(schemaSql))) {
    const [, name, body, tail] = match;
    if (!body.includes('branch_id')) continue;
    if (!/PARTITION BY RANGE/i.test(tail)) continue;
    tables.push(name);
  }
  return tables.sort();
}

interface SqlLiteral {
  text: string;
  line: number;
}

const SQL_KEYWORD = /(INSERT|UPDATE|DELETE|SELECT)/i;
const FROM_OR_INTO = /(FROM|JOIN|INTO|UPDATE)/i;

/**
 * Collect SQL-looking string literals with their starting line. A small state
 * machine rather than a TS parser: it skips comments, understands escapes, and
 * keeps `${...}` interpolations as a placeholder so a template stays one
 * statement.
 */
export function sqlLiterals(source: string): SqlLiteral[] {
  const literals: SqlLiteral[] = [];
  let line = 1;
  let i = 0;
  const n = source.length;
  const push = (startLine: number, text: string) => {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (SQL_KEYWORD.test(collapsed) && FROM_OR_INTO.test(collapsed)) {
      literals.push({ text: collapsed, line: startLine });
    }
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const startLine = line;
      let text = '';
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\') {
          if (source[i + 1] === '\n') line += 1;
          text += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        if (c === '\n') line += 1;
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            else if (source[i] === '\n') line += 1;
            i += 1;
          }
          text += ' $__param__ ';
          continue;
        }
        text += c;
        i += 1;
      }
      push(startLine, text);
      continue;
    }
    i += 1;
  }
  return literals;
}

/** The mutation verb a statement starts with (after wrapping parentheses). */
export function mutationKind(statement: string): 'INSERT' | 'UPDATE' | 'DELETE' | null {
  const head = statement.replace(/^[\s(]+/, '').slice(0, 20).toUpperCase();
  for (const verb of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    if (head.startsWith(verb)) return verb;
  }
  return null;
}

/**
 * Row-addressed mutations: the row's own unique key, either the surrogate `id`
 * or the unique natural key the domain gives it. One row means no cross-branch
 * blast radius, which is what this guard exists to prevent.
 */
const ROW_KEY_PREDICATE =
  /\bid\s*(=|IN\s*\()|\b(serial_number|device_serial|invoice_number|journal_no|reference_number|source_id)\b\s*(=|IN\s*\()|lower\s*\(\s*trim\s*\(/i;

/**
 * Pure detection core. Returns one violation per mutation that touches an
 * in-scope table without a `branch_id` predicate, without addressing rows by
 * their unique id, and without an exemption.
 */
export function findBranchPredicateViolations(
  source: string,
  fileLabel: string,
  tables: string[],
  exemptions: BranchPredicateExemption[] = BRANCH_PREDICATE_EXEMPTIONS
): BranchPredicateViolation[] {
  const violations: BranchPredicateViolation[] = [];
  const tableRe = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${tables.join('|')})\\b`, 'gi');
  for (const literal of sqlLiterals(source)) {
    if (!mutationKind(literal.text)) continue;
    tableRe.lastIndex = 0;
    const hit = tableRe.exec(literal.text);
    if (!hit) continue;
    const table = hit[2].toLowerCase();
    if (literal.text.toLowerCase().includes('branch_id')) continue;
    if (ROW_KEY_PREDICATE.test(literal.text)) continue;
    const exempt = exemptions.some(
      (entry) => fileLabel.endsWith(entry.file) && literal.text.startsWith(entry.startsWith)
    );
    if (exempt) continue;
    violations.push({ file: fileLabel, line: literal.line, table, statement: literal.text.slice(0, 140) });
  }
  return violations;
}

export function repoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

export function scanProject(
  root = '.',
  exemptions: BranchPredicateExemption[] = BRANCH_PREDICATE_EXEMPTIONS
): { tables: string[]; violations: BranchPredicateViolation[] } {
  const schemaSql = fs.readFileSync(path.join(root, 'scripts/schema.sql'), 'utf8');
  const tables = partitionedBranchTables(schemaSql);
  const violations: BranchPredicateViolation[] = [];
  for (const file of repoFiles(path.join(root, 'server/src'))) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    violations.push(...findBranchPredicateViolations(fs.readFileSync(file, 'utf8'), rel, tables, exemptions));
  }
  return { tables, violations };
}

function main(): void {
  const json = process.argv.includes('--json');
  const { tables, violations } = scanProject();
  if (json) {
    console.log(JSON.stringify({ tables, violations }, null, 2));
    if (violations.length > 0) process.exit(1);
    return;
  }
  if (violations.length === 0) {
    console.log(
      `✅ branch predicates — every mutation against ${tables.length} branch-scoped partitioned table(s) names a branch or a row key: ${tables.join(', ')}.`
    );
    return;
  }
  console.error(`✖ branch-predicate violation: ${violations.length} mutation(s) without a branch key:\n`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} (${violation.table})`);
    console.error(`    ${violation.statement}`);
  }
  console.error(
    '\nAdd the branch predicate (or the row key), or record the statement in BRANCH_PREDICATE_EXEMPTIONS with the reason it must span branches.'
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
