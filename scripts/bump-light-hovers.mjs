#!/usr/bin/env node
/**
 * Bump light-mode hover backgrounds one shade darker for visibility:
 *   hover:bg-slate-50   → hover:bg-slate-100
 *   hover:bg-slate-50/N → hover:bg-slate-100/N   (opacity variants)
 *   hover:bg-slate-100  → hover:bg-slate-200     (plain only, NOT /N)
 *
 * Dark-mode hovers (dark:hover:*) and all other colors are untouched.
 * Run:  node scripts/bump-light-hovers.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const ROOT = join(import.meta.dirname, '..');

function findFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...findFiles(full));
    else if (extname(full) === '.tsx') results.push(full);
  }
  return results;
}

const files = findFiles(join(ROOT, 'src'));
let total = 0;
let filesChanged = 0;

for (const filePath of files) {
  if (filePath.includes('DarkModeContext')) continue;
  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  let count = 0;

  // 1. slate-50/N → slate-100/N (must be done BEFORE plain slate-50)
  content = content.replace(/hover:bg-slate-50\/(\d+)/g, (_m, n) => {
    count++;
    return `hover:bg-slate-100/${n}`;
  });

  // 2. plain slate-50 → slate-100 (now safe, /N already converted)
  content = content.replace(/hover:bg-slate-50(?!\d)/g, () => {
    count++;
    return 'hover:bg-slate-100';
  });

  // 3. plain slate-100 → slate-200 (exclude any /N created above or existing)
  content = content.replace(/hover:bg-slate-100(?!\/\d)/g, () => {
    count++;
    return 'hover:bg-slate-200';
  });

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    total += count;
    filesChanged++;
    console.log(`✅ ${filePath.replace(ROOT, '.')} (${count} replacements)`);
  }
}

console.log(`\n🎉 Hover bump complete: ${total} replacements across ${filesChanged} files`);