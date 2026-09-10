#!/usr/bin/env node
/**
 * Remove stray quoted class strings left inside template literals by the
 * migration. Pattern: `...'text-slate-900 dark:text-white'...` (inside a
 * backtick template, no `${}`) → `...text-slate-900 dark:text-white...`
 *
 * Run:  node scripts/cleanup-quoted-classes.mjs
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

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only touch lines that contain a template literal and no interpolation
    if (!line.includes('`')) continue;

    // Remove quoted strings containing dark: — these are migration artifacts
    // Pattern: '...dark:...'  (single-quoted class string with dark: inside)
    const fixed = line.replace(/'(?!')([^']*dark:[^']*)'/g, '$1');
    if (fixed !== line) {
      lines[i] = fixed;
      fixes++;
    }
  }

  content = lines.join('\n');

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    totalFixes += fixes;
    filesModified++;
    console.log(`✅ ${filePath.replace(ROOT, '.')}  (${fixes} fixes)`);
  }
}

console.log(`\n🧹 Quoted-class cleanup complete! ${filesModified} files, ${totalFixes} fixes.`);