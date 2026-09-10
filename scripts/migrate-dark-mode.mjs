#!/usr/bin/env node
/**
 * Dark Mode Migration — converts `isDarkMode` ternary patterns to Tailwind
 * `dark:` variant classes.
 *
 * Strategy: instead of trying to rewild raw regexes, we transform only
 * JSX attribute expressions and template-literal interpolations that live
 * INSIDE `className=...` or template literals, and we always emit properly
 * quoted string literals.
 *
 * Run:  node scripts/migrate-dark-mode.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

function findTsxFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...findTsxFiles(full));
    else if (extname(full) === '.tsx') results.push(full);
  }
  return results;
}

/** Prefix each class (that isn't already dark:) with `dark:` */
function darkify(classStr) {
  return classStr
    .trim()
    .split(/\s+/)
    .map((c) => (c.startsWith('dark:') ? c : `dark:${c}`))
    .join(' ');
}

/**
 * Matches a string literal (single/double/backtick non-nested) and returns
 * its content plus the quote char.
 */
const STR = `(['"\`])((?:\\\\.|(?!\\1).)*?)\\1`;

/**
 * Converts a JS ternary of the shape:
 *   cond ? <DARK> : <LIGHT>
 * where <DARK>/<LIGHT> are string literals
 * into:  'LIGHT dark:DARK'  (a single quoted string)
 *
 * Returns the replacement string, or undefined if not matched.
 */
function convertTernary(str, base) {
  // Try: cond ? 'DARK' : 'LIGHT'
  const re = new RegExp(
    `^(.+?)\\s*\\?\\s*${STR.replace(/\\1/g, '$1')}\\s*:\\s*${STR.replace(/\\1/g, '$2')}\\s*$`
  );
  const m = str.match(re);
  if (m) {
    const dark = m[3];
    const light = m[6];
    return `${m[1]} ? '${light.trim()} ${darkify(dark)}'`;
  }
  return undefined;
}

/** Convert isDarkMode ? 'A' : 'B' → 'B dark:A' */
function simpleTernary(str) {
  const m = str.match(/^isDarkMode\s*\?\s*(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3$/);
  if (m) {
    return `'${m[4].trim()} ${darkify(m[2])}'`;
  }
  return undefined;
}

/**
 * Handle the full set of patterns present in this codebase:
 * 1. className={isDarkMode ? 'a' : 'b'}
 * 2. className={`...${isDarkMode ? 'a' : 'b'}...`}
 * 3. className={`${cond ? ... : ...}${...}`} and nested variants
 * 4. variable = isDarkMode ? 'a' : 'b';
 * 5. isDarkMode ? 'x' : '' used inside template literal
 */
function transformContent(content) {
  let output = content;
  let count = 0;

  // ─── CASE 1: className={isDarkMode ? 'A' : 'B'}  ─────────────────
  output = output.replace(
    /className=\{\s*isDarkMode\s*\?\s*(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3\s*\}/g,
    (_m, _q1, dark, _q2, light) => {
      count++;
      return `className="${light.trim()} ${darkify(dark)}"`;
    }
  );

  // ─── CASE 2: simple ternaries inside template literals ───────────
  // ${isDarkMode ? 'A' : 'B'}  →  'B dark:A'
  output = output.replace(
    /\$\{\s*isDarkMode\s*\?\s*(['"])([^'"]*)\1\s*:\s*(['"])([^'"]*)\3\s*\}/g,
    (_m, _q1, dark, _q2, light) => {
      count++;
      return `'${light.trim()} ${darkify(dark)}'`;
    }
  );

  // ─── CASE 3: function call / variable ternaries (non-JSX) ────────
  // const x = isDarkMode ? 'A' : 'B';
  output = output.replace(
    /(const|let|var)\s+(\w+)\s*=\s*isDarkMode\s*\?\s*(['"])([^'"]*)\3\s*:\s*(['"])([^'"]*)\5\s*;/g,
    (_m, kw, name, _q1, dark, _q2, light) => {
      count++;
      return `${kw} ${name} = '${light.trim()} ${darkify(dark)}';`;
    }
  );

  // ─── CASE 4: complex nested ternaries inside template literal ────
  // `${cond ? (isDarkMode ? 'A' : 'B') : (isDarkMode ? 'C' : 'D')}`
  // ─ first:  cond ? (isDarkMode ? 'A' : 'B') : (isDarkMode ? 'C' : 'D')
  output = output.replace(
    /\$\{\s*([^}]+?)\s*\?\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8\s*\)\s*\}/g,
    (_m, cond, _q1, dark1, _q2, light1, _q3, dark2, _q4, light2) => {
      count++;
      return `'${cond.trim()} ? ${light1.trim()} ${darkify(dark1)} : ${light2.trim()} ${darkify(dark2)}'`;
    }
  );

  // ─── CASE 5: nested ternary where isDarkMode is inner, simpler form ──
  // `${cond ? (isDarkMode ? 'A' : 'B') : ''}`
  output = output.replace(
    /\$\{\s*([^}]+?)\s*\?\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*(['"])([^'"]*)\6\s*\}/g,
    (_m, cond, _q1, dark, _q2, light, _q3, elseCls) => {
      count++;
      return `'${cond.trim()} ? ${light.trim()} ${darkify(dark)} : ${elseCls}'`;
    }
  );

  // ─── CASE 6: nested without inner parens ──────────────────────────
  // `${cond ? isDarkMode ? 'A' : 'B' : isDarkMode ? 'C' : 'D'}`
  output = output.replace(
    /\$\{\s*([^}]+?)\s*\?\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*:\s*isDarkMode\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8\s*\}/g,
    (_m, cond, _q1, dark1, _q2, light1, _q3, dark2, _q4, light2) => {
      count++;
      return `'${cond.trim()} ? ${light1.trim()} ${darkify(dark1)} : ${light2.trim()} ${darkify(dark2)}'`;
    }
  );

  // ─── CASE 7: ternary after : inside template literal ──────────────
  // someCondition ? 'DEFAULT' : isDarkMode ? 'A' : 'B'
  output = output.replace(
    /\$\{\s*(.+?)\s*\?\s*(['"])([^'"]*)\2\s*:\s*isDarkMode\s*\?\s*(['"])([^'"]*)\4\s*:\s*(['"])([^'"]*)\6\s*\}/g,
    (_m, cond, _q1, def, _q2, dark, _q3, light) => {
      count++;
      return `'${cond.trim()} ? ${def.trim()} : ${light.trim()} ${darkify(dark)}'`;
    }
  );

  // ─── CASE 8: remaining raw `isDarkMode ? 'A' : 'B'` (should only be
  //     inside template literal interpolations or standalone expressions) ──
  // Sanity: any remaining in className={} or ${} contexts are likely errors.
  // We'll leave them for manual review after the run.

  return { output, count };
}

const files = findTsxFiles(SRC);
let totalReplacements = 0;
let filesModified = 0;

for (const filePath of files) {
  // Skip the DarkModeContext itself
  if (filePath.includes('DarkModeContext')) continue;

  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  const { output, count } = transformContent(content);

  if (output !== original) {
    writeFileSync(filePath, output, 'utf-8');
    totalReplacements += count;
    filesModified++;
    console.log(`✅ ${filePath.replace(ROOT, '.')}  (${count} replacements)`);
  }
}

console.log(`\n🎉 Migration complete! ${filesModified} files modified, ${totalReplacements} total replacements.`);
console.log(`\n⚠️ Remaining isDarkMode references (if any) need manual review.`);