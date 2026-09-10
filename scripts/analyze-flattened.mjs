#!/usr/bin/env node
/**
 * Diagnostic: find className template literals that contain a LITERAL ` ? `
 * (space-question-space) / ` : ` (space-colon-space) — these are migration
 * artifacts where a real ternary was flattened into dead text, so BOTH
 * branches' classes are always applied. Cards lose conditional shadows,
 * borders appear/disappear inconsistently, and hover states look wrong.
 *
 * Run:  node scripts/analyze-flattened.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs';
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
let total = 0;
let filesAffected = 0;
const problems = [];

for (const filePath of files) {
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only template literals that do NOT contain real ${...} interpolation on the broken span
    if (!line.includes('`')) continue;
    // Count literal ` ? ` occurrences (space-question-space) in the line
    const qCount = (line.match(/ \? /g) || []).length;
    if (qCount > 0) {
      hits.push({ lineNo: i + 1, qCount, content: line.trim() });
    }
  }
  if (hits.length) {
    filesAffected++;
    total += hits.reduce((a, h) => a + h.qCount, 0);
    problems.push({ filePath, hits });
  }
}

console.log(`\nFiles with flattened ternaries: ${filesAffected}`);
console.log(`Total literal ' ? ' occurrences: ${total}\n`);

for (const p of problems) {
  console.log(`\n===== ${p.filePath.replace(ROOT, '.')} =====`);
  for (const h of p.hits) {
    console.log(`  L${h.lineNo} (${h.qCount}x): ${h.content.slice(0, 400)}`);
  }
}