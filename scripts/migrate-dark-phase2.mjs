#!/usr/bin/env node
/**
 * Phase 2: Convert remaining value-dependent isDarkMode ternaries to dark:
 * classes. These are nested ternaries where isDarkMode is NOT the outermost
 * condition, e.g.:
 *
 *   isLow ? (isDarkMode ? 'A' : 'B') : (isDarkMode ? 'C' : 'D')
 *                                     → isLow ? 'B dark:A' : 'D dark:C'
 *
 *   (isDarkMode ? 'A' : 'B')           → 'B dark:A'
 *
 * Run:  node scripts/migrate-dark-phase2.mjs
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

function darkify(c) {
  return c.trim().split(/\s+/).map((x) => (x.startsWith('dark:') ? x : `dark:${x}`)).join(' ');
}

const files = findTsxFiles(SRC);
let total = 0;
let mod = 0;

for (const filePath of files) {
  if (filePath.includes('DarkModeContext')) continue;
  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  let count = 0;

  // ─── Pattern A: (isDarkMode ? 'DARK' : 'LIGHT') inside a ternary branch ──
  // cond ? (isDarkMode ? 'A' : 'B') : (isDarkMode ? 'C' : 'D')
  //      → cond ? 'B dark:A' : 'D dark:C'
  content = content.replace(
    /(\w[\w\s<>=!&|.()]*\s*\?\s*)\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8\s*\)/g,
    (_m, cond, _q1, darkA, _q2, lightA, _q3, darkC, _q4, lightC) => {
      count++;
      return `${cond}'${lightA.trim()} ${darkify(darkA)}' : '${lightC.trim()} ${darkify(darkC)}'`;
    }
  );

  // ─── Pattern B: cond ? (isDarkMode ? 'A' : 'B') : '' ───
  content = content.replace(
    /(\w[\w\s<>=!&|.()]*\s*\?\s*)\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*(['"])([^'"]*)\6\s*\)/g,
    (_m, cond, _q1, darkA, _q2, lightA, _q3, elseCls) => {
      count++;
      return `${cond}'${lightA.trim()} ${darkify(darkA)}' : '${elseCls.trim()}'`;
    }
  );

  // ─── Pattern C: cond ? (isDarkMode ? 'A' : 'B') : isDarkMode ? 'C' : 'D' ──
  content = content.replace(
    /(\w[\w\s<>=!&|.()]*\s*\?\s*)\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*isDarkMode\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8/g,
    (_m, cond, _q1, darkA, _q2, lightA, _q3, darkC, _q4, lightC) => {
      count++;
      return `${cond}'${lightA.trim()} ${darkify(darkA)}' : '${lightC.trim()} ${darkify(darkC)}'`;
    }
  );

  // ─── Pattern D: Multi-line:  cond ? (isDarkMode ? 'A' : 'B') : (isDarkMode ? 'C' : 'D') ──
  content = content.replace(
    /(\w[\w\s<>=!&|.()]*\s*\?\s*)\(isDarkMode\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*\(isDarkMode\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8\s*\)/g,
    (_m, cond, _q1, darkA, _q2, lightA, _q3, darkC, _q4, lightC) => {
      count++;
      return `${cond}'${lightA.trim()} ${darkify(darkA)}' : '${lightC.trim()} ${darkify(darkC)}'`;
    }
  );

  // ─── Pattern E: isDarkMode ? (delta < 0 ? 'A' : 'B') : (delta < 0 ? 'C' : 'D') ──
  content = content.replace(
    /isDarkMode\s*\?\s*\(([^)]+?)\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*\(([^)]+?)\s*\?\s*(['"])([^'"]*)\7\s*:\s*(['"])([^'"]*)\9\s*\)/g,
    (_m, c1, _q1, darkA, _q2, lightA, c2, _q3, darkB, _q4, lightB) => {
      count++;
      // cond ? 'LIGHT_A dark:DARK_A' : 'LIGHT_B dark:DARK_B'
      return `(${c1} ? '${lightA.trim()} ${darkify(darkA)}' : '${lightB.trim()} ${darkify(darkB)}')`;
    }
  );

  // ─── Pattern F: isDarkMode ? (delta < 0 ? 'A' : 'B') : (delta < 0 ? 'C' : 'D') ──
  // simple version where both branches share the same condition
  content = content.replace(
    /isDarkMode\s*\?\s*\(([^)]+?)\s*\?\s*(['"])([^'"]*)\2\s*:\s*(['"])([^'"]*)\4\s*\)\s*:\s*\(\1\s*\?\s*(['"])([^'"]*)\6\s*:\s*(['"])([^'"]*)\8\s*\)/g,
    (_m, cond, _q1, darkA, _q2, lightA, _q3, darkB, _q4, lightB) => {
      count++;
      return `(${cond} ? '${lightA.trim()} ${darkify(darkA)}' : '${lightB.trim()} ${darkify(darkB)}')`;
    }
  );

  // ─── Pattern G: ternary chain ending in isDarkMode ? 'A' : 'B' ──
  // x < 0 ? (isDarkMode ? 'A' : 'B') : x > 0 ? (isDarkMode ? 'C' : 'D') : isDarkMode ? 'E' : 'F'
  content = content.replace(
    /(!?[\w.]+)\s*([<>=]+)\s*(\d+)\s*\?\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\4\s*:\s*(['"])([^'"]*)\6\s*\)\s*:\s*\1\s*([<>=]+)\s*(\d+)\s*\?\s*\(\s*isDarkMode\s*\?\s*(['"])([^'"]*)\10\s*:\s*(['"])([^'"]*)\12\s*\)\s*:\s*isDarkMode\s*\?\s*(['"])([^'"]*)\14\s*:\s*(['"])([^'"]*)\16/g,
    (_m, v1, op1, n1, _q1, d1, _q2, l1, _q3, _op2, _n2, _q4, d2, _q5, l2, _q6, d3, _q7, l3) => {
      count++;
      return `${v1} ${op1} ${n1} ? '${l1.trim()} ${darkify(d1)}' : ${v1} ${_op2} ${_n2} ? '${l2.trim()} ${darkify(d2)}' : '${l3.trim()} ${darkify(d3)}'`;
    }
  );

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    total += count;
    mod++;
    console.log(`✅ ${filePath.replace(ROOT, '.').split(sep()).join('/')}  (${count} replacements)`);
  }
}

function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

console.log(`\n🎉 Phase 2 done! ${mod} files modified, ${total} replacements.`);