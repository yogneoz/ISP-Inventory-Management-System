#!/usr/bin/env node
/**
 * Startup bundle budget guard (CI gate after `npm run build`).
 *
 * The "startup chunk set" is index.html's entry chunk PLUS every chunk it
 * statically imports (`from"./X.js"`), transitively. Chunks reached ONLY via
 * dynamic `import("...")` (React.lazy screens, vendor-excel) are on-demand and
 * do NOT count. Gzip sizes are checked because that is what the network
 * actually transfers.
 *
 * Why static-graph and not just the entry file: a chunk can shrink while
 * getting wrongly wired into everything (a shared module merged into a feature
 * chunk dragged a finance screen into every inventory screen's graph once).
 * Transitive closure catches that: 40 kB appearing in 15 import chains shows up
 * as budget pressure immediately.
 *
 * Budgets (gzip bytes) are enforced with a small tolerance rather than exact
 * equality: the goal is to catch REGRESSIONS (a screen accidentally re-added to
 * the eager graph, a big dependency imported at startup), not to block cosmetic
 * churn. Update BUDGETS deliberately when the app legitimately grows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = path.resolve(process.cwd(), 'dist');
const ASSETS = path.join(DIST, 'assets');

// gzip-byte budgets. Current measured values (2026-09): entry 11.7 kB,
// startup total ~262 kB. Headroom exists for legitimate growth; a breach
// means the startup graph got meaningfully bigger and needs a look.
const BUDGETS = {
  entryGz: 16 * 1024, // entry chunk alone
  startupTotalGz: 320 * 1024, // entry + all statically-imported chunks
};

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(ASSETS)) {
  fail(`dist/assets not found — run "npm run build" before this check.`);
}

function gzipSize(file) {
  return gzipSync(fs.readFileSync(file)).length;
}

// Static imports are `from"./name.js"`; dynamic ones `import("./name.js")`.
// Hashes contain only [A-Za-z0-9_-], so the patterns below are exact.
const STATIC_RE = /from"\.\/([A-Za-z0-9_-]+\.js)"/g;
const DYNAMIC_RE = /import\("\.\/([A-Za-z0-9_-]+\.js)"\)/g;

const entryHtml = fs
  .readFileSync(path.join(DIST, 'index.html'), 'utf8')
  .match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
if (!entryHtml) fail('Could not find the entry script in dist/index.html.');
const entry = entryHtml[1];

// Transitive closure over static imports, starting from the entry chunk.
const startup = new Set([entry]);
let frontier = [entry];
let dynamicOnly = new Set();
while (frontier.length) {
  const next = [];
  for (const chunk of frontier) {
    const src = fs.readFileSync(path.join(ASSETS, chunk), 'utf8');
    for (const m of src.matchAll(STATIC_RE)) {
      const dep = m[1];
      if (!startup.has(dep)) {
        startup.add(dep);
        next.push(dep);
      }
    }
    for (const m of src.matchAll(DYNAMIC_RE)) dynamicOnly.add(m[1]);
  }
  frontier = next;
}
// A chunk reached dynamically is NOT part of startup even if some module also
// mentions it statically in a lazy branch; intersection check below reports it.
dynamicOnly = new Set([...dynamicOnly].filter((c) => !startup.has(c)));

const entryGz = gzipSize(path.join(ASSETS, entry));
let totalGz = 0;
for (const chunk of startup) totalGz += gzipSize(path.join(ASSETS, chunk));

console.log(`Startup chunk set: ${startup.size} chunks`);
console.log(`  entry:        ${entry} — ${(entryGz / 1024).toFixed(1)} kB gz (budget ${(BUDGETS.entryGz / 1024) | 0} kB)`);
console.log(`  startup total: ${(totalGz / 1024).toFixed(1)} kB gz (budget ${(BUDGETS.startupTotalGz / 1024) | 0} kB)`);
console.log(`  on-demand (dynamic-only, not budgeted): ${dynamicOnly.size} chunks`);

let breached = false;
if (entryGz > BUDGETS.entryGz) {
  console.error(`✖ Entry chunk ${(entryGz / 1024).toFixed(1)} kB gz exceeds ${(BUDGETS.entryGz / 1024) | 0} kB budget.`);
  breached = true;
}
if (totalGz > BUDGETS.startupTotalGz) {
  console.error(`✖ Startup total ${(totalGz / 1024).toFixed(1)} kB gz exceeds ${(BUDGETS.startupTotalGz / 1024) | 0} kB budget.`);
  console.error(`  Likely causes: a screen re-added to App.tsx's eager imports, a big`);
  console.error(`  dependency imported at startup, or manualChunks changes that`);
  console.error(`  merged a lazy chunk into the static graph.`);
  breached = true;
}

if (breached) process.exit(1);
console.log('✔ Bundle budget OK');
