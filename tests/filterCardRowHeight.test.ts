/**
 * Every control inside a FilterCard's filter rows keeps the compact h-8 height.
 *
 * The card lays its search box, its Filter/Clear buttons and the register's own
 * inline controls on ONE baseline. That only holds while each control is h-8:
 * a field that carries its own vertical padding (py-1.5, py-2, pb-*) renders
 * taller than its neighbours and the row goes uneven again — the exact defect
 * fixed across the registers in the compact-search-card pass.
 *
 * PROVES:
 *   1. HEIGHT — every input/select/button/textarea in a `filterChildren` or
 *      `rightChildren` block is h-8 (or h-full inside an h-8 segmented wrapper),
 *      or takes the shared `filterControlClass`. Checkbox/radio boxes and
 *      text-link buttons are the documented exceptions.
 *   2. PADDING — none of them carries an h-8-overriding vertical padding.
 *   3. COMPONENTS — DateField is `compact`, SearchSelect's input is h-8, and an
 *      unknown control component is a failure rather than something the scan
 *      silently skips.
 *
 * Source pin only: no DB, no browser. Behaviour (commit-only search, preview
 * dropdown) is covered by tests/filterCardDebounce.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = path.resolve('client/src');

/** Components whose own control is already h-8 by contract. */
const FIXED_HEIGHT_COMPONENTS = new Set(['PeriodRangeField']);

/** Icons rendered inside the row's buttons — no height of their own to check. */
const ICONS = new Set([
  'RefreshCw',
  'Download',
  'FileSpreadsheet',
  'Plus',
  'RotateCcw',
  'X',
  'Search',
]);

const PRIMITIVES = new Set(['input', 'select', 'button', 'textarea']);

interface Control {
  file: string;
  line: number;
  slot: 'filterChildren' | 'rightChildren';
  tag: string;
  attrs: string;
}

interface Block {
  file: string;
  line: number;
  slot: 'filterChildren' | 'rightChildren';
  body: string;
}

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/**
 * `prop={<…>}` with balanced braces and ignored string/comment bodies, so a
 * JSX arrow function inside the block cannot end the extraction early.
 */
function extractPropBlocks(src: string, prop: string, file: string, lineBase = 0): Block[] {
  const blocks: Block[] = [];
  let index = src.indexOf(`${prop}={`);
  while (index !== -1) {
    let cursor = index + prop.length + 2;
    let depth = 1;
    let quote: string | null = null;
    while (cursor < src.length && depth > 0) {
      const char = src[cursor];
      if (quote) {
        if (char === '\\') {
          cursor += 2;
          continue;
        }
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      }
      cursor += 1;
    }
    const body = src.slice(index, cursor);
    const line = lineBase + src.slice(0, index).split('\n').length;
    blocks.push({ file, line, slot: prop as Block['slot'], body });
    index = src.indexOf(`${prop}={`, cursor);
  }
  return blocks;
}

/** Opening tags inside a block: tag name plus its raw attribute text. */
function tagsOf(body: string): Array<{ tag: string; attrs: string }> {
  const tags: Array<{ tag: string; attrs: string }> = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '<') continue;
    if (body[index + 1] === '/' || body[index + 1] === '>') continue;
    const name = /^<([A-Za-z][\w.]*)/.exec(body.slice(index));
    if (!name) continue;
    let cursor = index + name[0].length;
    let depth = 0;
    let quote: string | null = null;
    while (cursor < body.length) {
      const char = body[cursor];
      if (quote) {
        if (char === '\\') {
          cursor += 2;
          continue;
        }
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === '>' && depth === 0) {
        break;
      }
      cursor += 1;
    }
    tags.push({ tag: name[1], attrs: body.slice(index + name[0].length, cursor) });
    index = cursor;
  }
  return tags;
}

const collectBlocks = (): Block[] => {
  const blocks: Block[] = [];
  for (const abs of tsxFiles(CLIENT)) {
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes('<FilterCard')) continue;
    const file = path.relative(CLIENT, abs).split(path.sep).join('/');
    blocks.push(...extractPropBlocks(src, 'filterChildren', file));
    blocks.push(...extractPropBlocks(src, 'rightChildren', file));
  }
  return blocks;
};

/**
 * Height check for ONE primitive control. `undefined` means compliant;
 * otherwise the reason it breaks the row.
 */
function primitiveProblem(attrs: string, tag: string): string | undefined {
  const isCheckbox = /type=['"](?:checkbox|radio)['"]/.test(attrs);
  const verticalPadding = /(?:^|[\s"'`])(?:py|pb|pt)-[\d.]/.exec(attrs);
  if (tag === 'input' && isCheckbox) {
    // A checkbox is its own box; only stray padding would move the row.
    return verticalPadding ? `checkbox carries vertical padding (${verticalPadding[0].trim()})` : undefined;
  }
  if (/linkButton/.test(attrs)) return undefined; // text link, not a boxed control
  if (verticalPadding) return `carries vertical padding (${verticalPadding[0].trim()}) which grows it past h-8`;
  if (/\bfilterControlClass\b/.test(attrs)) return undefined;
  const named = /className=(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\{`([^`]*)`\})/.exec(attrs);
  const classes = named ? (named[1] ?? named[2] ?? named[3] ?? named[4] ?? '') : '';
  if (/\bh-8\b/.test(classes) || /\bh-full\b/.test(classes)) return undefined;
  if (!named) return 'has no literal className to check — give it h-8 or filterControlClass';
  return `is not h-8 ("${classes.trim() || 'no classes'}")`;
}

/** Height check for ONE component control. */
function componentProblem(tag: string, attrs: string): string | undefined {
  if (FIXED_HEIGHT_COMPONENTS.has(tag)) return undefined;
  if (tag === 'DateField') {
    return /\bcompact\b/.test(attrs) ? undefined : 'renders the tall py-2 shell — pass compact';
  }
  if (tag === 'SearchSelect') {
    const input = /inputClassName=(?:"([^"]*)"|`([^`]*)`)/.exec(attrs);
    const classes = input ? (input[1] ?? input[2] ?? '') : '';
    return /\bh-8\b/.test(classes) ? undefined : 'inputClassName must pin the input to h-8';
  }
  if (ICONS.has(tag)) return undefined;
  return `is an unrecognised control — add it here with its height contract`;
}

describe('FilterCard filter rows keep one h-8 height', () => {
  const blocks = collectBlocks();
  // A `rightChildren` slot may be a plain result counter (span/strong), so the
  // unit of the scan is the control, not the block.
  const controls: Array<Control> = blocks.flatMap((block) =>
    tagsOf(block.body)
      .filter(({ tag }) => PRIMITIVES.has(tag) || /^[A-Z]/.test(tag))
      .map(({ tag, attrs }) => ({
        file: block.file,
        line: block.line,
        slot: block.slot,
        tag,
        attrs,
      }))
  );

  test('every control in filterChildren/rightChildren is h-8 or filterControlClass', () => {
    const problems: string[] = [];

    for (const control of controls) {
      const { tag, attrs } = control;
      const reason = PRIMITIVES.has(tag)
        ? primitiveProblem(attrs, tag)
        : componentProblem(tag, attrs);
      if (reason) {
        problems.push(`${control.file}:${control.line} ${control.slot}: <${tag}> ${reason}`);
      }
    }

    assert.deepEqual(
      problems,
      [],
      `filter rows would render uneven:\n${problems.join('\n')}`
    );
  });

  test('the scan still reaches every FilterCard filter row', () => {
    const sources = tsxFiles(CLIENT)
      .map((abs) => fs.readFileSync(abs, 'utf8'))
      .filter((src) => src.includes('<FilterCard'));

    const declared = sources.reduce(
      (sum, src) => sum + (src.split('filterChildren={').length - 1),
      0
    );
    const extracted = blocks.filter((block) => block.slot === 'filterChildren').length;
    assert.equal(
      extracted,
      declared,
      'every filterChildren prop must be extracted — the scanner lost a block'
    );

    // A floor rather than an exact count: screens are added over time, but the
    // scan must never quietly match nothing.
    assert.ok(
      extracted >= 20,
      `only ${extracted} filter rows were found; expected at least 20`
    );
    assert.ok(
      controls.length >= 60,
      `only ${controls.length} controls were found across those rows — the tag scan went blind`
    );
  });
});
