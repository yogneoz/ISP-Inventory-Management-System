#!/usr/bin/env node
/**
 * Dark Mode Cleanup — removes the isDarkMode prop from component interfaces,
 * switches components to the useDarkMode() hook, and removes prop drilling.
 *
 * Run:  node scripts/migrate-dark-mode.mjs  (first)
 *       node scripts/cleanup-dark-prop.mjs  (second)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative, sep } from 'path';

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
let totalChanges = 0;

for (const filePath of files) {
  const baseName = filePath.split(sep).pop();
  if (baseName === 'DarkModeContext.tsx' || baseName === 'main.tsx') continue;

  let content = readFileSync(filePath, 'utf-8');
  const original = content;
  let changes = 0;

  // ─── 1. Remove isDarkMode from interface declarations ───
  content = content.replace(/^\s*isDarkMode\??\s*:\s*boolean\s*;\s*\n/gm, () => { changes++; return ''; });

  // ─── 2. Remove isDarkMode from destructured props ───
  //    isDarkMode,            (no default)
  //    isDarkMode = false,    (with default)
  content = content.replace(/^\s*isDarkMode\s*(?:=\s*(?:true|false))?\s*,?\s*\n/gm, () => { changes++; return ''; });

  // ─── 3. Remove isDarkMode={isDarkMode} from JSX prop passing ───
  content = content.replace(/\s+isDarkMode=\{isDarkMode\}/g, () => { changes++; return ''; });

  // ─── 4. If the file still references isDarkMode, add the hook ───
  const stillUses = /\bisDarkMode\b/.test(content);
  if (stillUses && !content.includes('useDarkMode')) {
    // Compute relative path from file dir to src/contexts/DarkModeContext
    const fileDir = filePath.slice(0, filePath.lastIndexOf(sep));
    let rel = relative(fileDir, join(SRC, 'contexts', 'DarkModeContext'));
    rel = rel.split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    // Strip extension for import
    rel = rel.replace(/\.tsx$/, '');

    // Insert import after the last import statement
    const lines = content.split('\n');
    let lastImportIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import /.test(lines[i])) lastImportIdx = i;
    }
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, `import { useDarkMode } from '${rel}';`);
    } else {
      lines.unshift(`import { useDarkMode } from '${rel}';`);
    }
    content = lines.join('\n');
    changes++;

    // Insert `const { isDarkMode } = useDarkMode();` right after the
    // component's opening destructure — i.e., after the first `}) => {`
    const lines2 = content.split('\n');
    for (let i = 0; i < lines2.length; i++) {
      if (/^\s*\}\)\s*=>\s*\{/.test(lines2[i]) || /^\s*=>\s*\{/.test(lines2[i])) {
        const indent = lines2[i].match(/^\s*/)[0];
        lines2.splice(i + 1, 0, `${indent}  const { isDarkMode } = useDarkMode();`);
        changes++;
        break;
      }
    }
    content = lines2.join('\n');
  }

  if (content !== original) {
    writeFileSync(filePath, content, 'utf-8');
    totalChanges += changes;
    console.log(`✅ ${filePath.replace(ROOT, '.').split(sep).join('/')}  (${changes} changes)`);
  }
}

console.log(`\n🎉 Cleanup complete! ${totalChanges} total changes.`);