/**
 * Draft-seeding guard — a per-row draft may not start from blank fields.
 *
 * Regression class (fixed in OPENSTOCK): the opening-stock register created a
 * row's draft from empty strings on the first keystroke, so editing quantity
 * blanked the damaged count and unit cost that were on screen, and Save then
 * failed validation on fields the operator never touched.
 *
 * PROVES, by parsing the client sources:
 *   1. A multi-field per-row draft entry is seeded from something — a spread
 *      of the previous draft / row, or explicit `row.` reads. Rebuilding the
 *      literal field-by-field from scratch fails.
 *   2. No per-row draft entry falls back to `''` for a field, so an untouched
 *      value can never become blank.
 *   3. The live `client/src` tree is clean, and the scanner still recognises
 *      the map shapes it is meant to guard (so a regex break cannot make this
 *      test pass vacuously).
 *
 * Rule 1 intentionally exempts single-field drafts (VendorOpeningBalances
 * holds only `openingBalance`): with no sibling field on screen there is
 * nothing to blank, and its accessor already falls back to the row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_SRC = path.resolve(process.cwd(), 'client', 'src');

export interface DraftMap {
  state: string;
  setter: string;
  fields: string[];
}

export interface DraftViolation {
  file: string;
  line: number;
  state: string;
  reason: string;
}

const useStateMap = () =>
  /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState<Record<\s*string\s*,\s*([^>]+?)\s*>>\s*\(\s*\{\s*\}\s*\)/g;

const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;

/** Field names of an object type body (`{ a: string; b?: number }`). */
function parseFields(body: string): string[] {
  return body
    .split(/[;\n]/)
    .map((entry) => entry.trim().match(/^(\w+)\s*\??\s*:/)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Resolve the map's value type to its field list, inline or from a local type. */
function resolveFields(source: string, typeRef: string): string[] | null {
  if (typeRef.startsWith('{')) {
    return parseFields(typeRef.replace(/^\{/, '').replace(/\}$/, ''));
  }
  const name = typeRef.trim();
  const declaration = new RegExp(
    `(?:type|interface)\\s+${name}\\s*(?:=\\s*)?\\{([^}]*)\\}`,
    'm'
  ).exec(source);
  return declaration ? parseFields(declaration[1]) : null;
}

/** Extract `(`…`)` or `{`…`}` starting at the opener position, quote-naively. */
function balanced(source: string, start: number): { body: string; end: number } {
  const open = source[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { body: source.slice(start + 1, i), end: i };
    }
  }
  return { body: source.slice(start + 1), end: source.length };
}

/** Every `[key]: { … }` entry literal inside a setter call. */
function entryLiterals(setterBody: string): { body: string; index: number }[] {
  const entries: { body: string; index: number }[] = [];
  const re = /\[\s*[^\]]+\s*\]\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(setterBody)) !== null) {
    const openAt = setterBody.indexOf('{', match.index);
    const { body } = balanced(setterBody, openAt);
    entries.push({ body, index: match.index });
  }
  return entries;
}

const BLANK_FALLBACK = /(?:\?\?|\|\|)\s*(?:''|"")\s*(?=[,;)\]}]|$)/;

export function findDraftSeedingViolations(source: string, file: string): DraftViolation[] {
  const violations: DraftViolation[] = [];
  const maps = useStateMap();
  let map: RegExpExecArray | null;

  while ((map = maps.exec(source)) !== null) {
    const [, state, setter, typeRef] = map;
    const fields = resolveFields(source, typeRef);
    if (!fields || fields.length === 0) continue;

    const setterRe = new RegExp(`\\b${setter}\\s*\\(`, 'g');
    let call: RegExpExecArray | null;
    setterRe.lastIndex = 0;
    while ((call = setterRe.exec(source)) !== null) {
      const openAt = call.index + call[0].length - 1;
      const { body } = balanced(source, openAt);

      for (const entry of entryLiterals(body)) {
        const line = lineOf(source, openAt + entry.index);
        if (BLANK_FALLBACK.test(entry.body)) {
          violations.push({
            file,
            line,
            state,
            reason: 'draft entry falls back to an empty string for a field',
          });
        } else if (fields.length >= 2 && !entry.body.includes('...') && !/\brow\.\w+/.test(entry.body)) {
          violations.push({
            file,
            line,
            state,
            reason: 'multi-field draft entry is rebuilt without seeding from the row or previous draft',
          });
        }
      }
    }
  }

  return violations;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('per-row draft seeding guard', () => {
  describe('scanner on synthetic sources', () => {
    test('flags the opening-stock first-edit regression', () => {
      const source = [
        'type Draft = { quantityOnHand: string; damagedQty: string; unitCost: string };',
        'const [drafts, setDrafts] = useState<Record<string, Draft>>({});',
        'const updateDraft = (rowId: string, field: keyof Draft, value: string) => {',
        '  setDrafts((prev) => ({',
        '    ...prev,',
        '    [rowId]: {',
        "      quantityOnHand: prev[rowId]?.quantityOnHand ?? '',",
        "      damagedQty: prev[rowId]?.damagedQty ?? '',",
        "      unitCost: prev[rowId]?.unitCost ?? '',",
        '      [field]: value,',
        '    },',
        '  }));',
        '};',
      ].join('\n');

      const violations = findDraftSeedingViolations(source, 'OpeningStockManager.tsx');
      assert.ok(violations.length >= 1, 'the blank-seeded literal must be flagged');
      assert.match(violations[0].reason, /empty string|without seeding/);
    });

    test('flags a spread entry whose untouched field still falls back to blank', () => {
      const source = [
        'type Draft = { a: string; b: string };',
        'const [drafts, setDrafts] = useState<Record<string, Draft>>({});',
        'const update = (row: Row, a: string) => {',
        "  setDrafts((prev) => ({ ...prev, [row.id]: { ...prev[row.id], a, b: prev[row.id]?.b ?? '' } }));",
        '};',
      ].join('\n');

      const violations = findDraftSeedingViolations(source, 'SomeRegister.tsx');
      assert.equal(violations.length, 1);
      assert.match(violations[0].reason, /empty string/);
    });

    test('accepts the fixed literal and an explicit row-seeded literal', () => {
      const fixed = [
        'type Draft = { a: string; b: string };',
        'const [drafts, setDrafts] = useState<Record<string, Draft>>({});',
        'const update = (row: Row, a: string) => {',
        '  setDrafts((prev) => {',
        '    const base = prev[row.id] || { a: String(row.a), b: String(row.b) };',
        '    return { ...prev, [row.id]: { ...base, a } };',
        '  });',
        '};',
      ].join('\n');
      const explicit = [
        'type Draft = { a: string; b: string };',
        'const [drafts, setDrafts] = useState<Record<string, Draft>>({});',
        'const update = (row: Row, a: string) => {',
        '  setDrafts((prev) => ({ ...prev, [row.id]: { a, b: row.b } }));',
        '};',
      ].join('\n');

      assert.deepEqual(findDraftSeedingViolations(fixed, 'OpeningStockManager.tsx'), []);
      assert.deepEqual(findDraftSeedingViolations(explicit, 'OtherRegister.tsx'), []);
    });

    test('leaves single-field drafts alone (nothing on screen to blank)', () => {
      const source = [
        "const [vendorDrafts, setVendorDrafts] = useState<Record<string, { openingBalance: string }>>({});",
        'const updateVendorDraft = (rowId: string, value: string) => {',
        '  setVendorDrafts((prev) => ({ ...prev, [rowId]: { openingBalance: value } }));',
        '};',
      ].join('\n');

      assert.deepEqual(findDraftSeedingViolations(source, 'VendorOpeningBalances.tsx'), []);
    });
  });

  describe('live client tree', () => {
    test('every multi-field per-row draft seeds from the row and none blanks a field', () => {
      const files = walk(CLIENT_SRC);
      const violations = files.flatMap((file) =>
        findDraftSeedingViolations(fs.readFileSync(file, 'utf8'), path.relative(process.cwd(), file))
      );

      assert.deepEqual(
        violations,
        [],
        'a per-row draft must start from the row values already on screen'
      );
    });

    test('the scanner still finds the draft maps it is meant to guard', () => {
      const multiField: string[] = [];
      const singleField: string[] = [];

      for (const file of walk(CLIENT_SRC)) {
        const source = fs.readFileSync(file, 'utf8');
        const maps = useStateMap();
        let map: RegExpExecArray | null;
        while ((map = maps.exec(source)) !== null) {
          const fields = resolveFields(source, map[3]);
          if (!fields || fields.length === 0) continue;
          const relative = path.relative(process.cwd(), file).replace(/\\/g, '/');
          (fields.length >= 2 ? multiField : singleField).push(relative);
        }
      }

      assert.ok(
        multiField.includes('client/src/features/finance/OpeningStockManager.tsx'),
        'the opening-stock draft map must stay visible to the scanner'
      );
      assert.ok(
        singleField.includes('client/src/features/finance/VendorOpeningBalances.tsx'),
        'the vendor-opening draft map must stay visible to the scanner'
      );
    });
  });
});
