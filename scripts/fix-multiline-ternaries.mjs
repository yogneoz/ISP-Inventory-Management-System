#!/usr/bin/env node
/**
 * Fix multi-line isDarkMode ternary patterns:
 *
 *   : isDarkMode
 *   ? 'A'
 *   : 'B'
 *
 * →   : 'B dark:A'
 *
 * Run:  node scripts/fix-multiline-ternaries.mjs
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

const files = findTsxFiles(SRC);
let totalFixes = 0;
let filesModified = 0;

for (const filePath of files) {
  if (filePath.includes('DarkModeContext')) continue;
  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  let fixes = 0;

  // Handle pattern:
  //   <indent>: isDarkMode
  //   <indent>? 'DARK'
  //   <indent>: 'LIGHT'
  // →
  //   <indent>: 'LIGHT dark:DARK'
  content = content.replace(
    /^(\s*):\s*isDarkMode\s*\n(\s*)\?\s*['"]([^'"]*)['"]\s*\n(\s*):\s*['"]([^'"]*)['"]/gm,
    (_m, indent1, indent2, dark, indent3, light) => {
      fixes++;
      return `${indent1}: '${light.trim()} ${darkify(dark)}'`;
    }
  );

  // Handle pattern:
  //   <indent>? isDarkMode
  //   ? 'DARK'
  //   : 'LIGHT'
  content = content.replace(
    /^(\s*)\?\s*isDarkMode\s*\n(\s*)\?\s*['"]([^'"]*)['"]\s*\n(\s*):\s*['"]([^'"]*)['"]/gm,
    (_m, indent1, indent2, dark, indent3, light) => {
      fixes++;
      return `${indent1}? '${light.trim()} ${darkify(dark)}'`;
    }
  );

  // Handle pattern with nested isDarkMode inside parens:
  //   : (isDarkMode
  //   ? 'DARK'
  //   : 'LIGHT')
  content = content.replace(
    /^(\s*):\s*\(\s*isDarkMode\s*\n(\s*)\?\s*['"]([^'"]*)['"]\s*\n(\s*):\s*['"]([^'"]*)['"]\s*\)/gm,
    (_m, indent1, indent2, dark, indent3, light) => {
      fixes++;
      return `${indent1}: '${light.trim()} ${darkify(dark)}'`;
    }
  );

  // Handle the pattern where isDarkMode is the last branch:
  //   : isDarkMode
  //   ? 'DARK'
  //   : 'LIGHT'
  // this regex overlaps with the first; but this version allows the next line to have other content
  content = content.replace(
    /^(\s*):\s*isDarkMode\s*\n(\s*)\?\s*['"]([^'"]*)['"]\s*\n(\s*):\s*['"]([^'"]*)['"]/gm,
    (_m, indent1, indent2, dark, indent3, light) => {
      fixes++;
      return `${indent1}: '${light.trim()} ${darkify(dark)}'`;
    }
  );

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    totalFixes += fixes;
    filesModified++;
    console.log(`✅ ${filePath.replace(ROOT, '.')}  (${fixes} fixes)`);
  }
}

function darkify(classStr) {
  return classStr
    .trim()
    .split(/\s+/)
    .map((c) => (c.startsWith('dark:') ? c : `dark:${c}`))
    .join(' ');
}

console.log(`\n🎉 Multiline ternary fix complete! ${filesModified} files fixed, ${totalFixes} total fixes.`);