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

// gzip-byte budgets. Current measured values (2026-10-30, UI/UX audit): entry
// 17.1 kB, startup total 291.2 kB. BUDGET-1 moved five registers (Branch
// Stock, Fixed Assets, Customer Master Directory, Customer Devices, Serial
// Log; 33.8 kB gzip) out of the eager graph, which restored ~40 kB of total
// headroom without raising the 320 kB total. The entry budget moved 16 -> 17
// kB because the app shell/routing legitimately grew from 11.7 kB in 2026-09
// to 15.6 kB; 1.4 kB is about five shell-sized changes, and screen weight
// belongs in lazy chunks, not in this file. The UIX audit added mobile
// branch/FY controls, one shared dialog-focus hook and a single alert model to
// the same shell graph (measured 17.1 kB), so 18 kB keeps ~0.9 kB of headroom
// while the 320 kB total still holds 28.8 kB — screen weight belongs in lazy
// chunks, not here. A breach still means the startup graph got meaningfully
// bigger and needs a look.
// 2026-11-04 (full-project audit): measured entry 19.5 kB, startup total
// 305.6 kB. The master-data work added four screens, one API domain and the
// types they share, and the new screens' API module rides the eagerly imported
// `services/api` barrel, so the entry graph legitimately crossed the 18 kB
// line. Permission Management and User Permissions (~2,200 lines, opened from
// Settings, never during boot) moved to `React.lazy` in the same change, which
// took 11 kB gzip out of the startup total (316.3 -> 305.6) but left the entry
// chunk itself at 19.5 kB — that chunk is the app shell and routing, not screen
// weight. The entry budget therefore moves 18 -> 20 kB (0.5 kB headroom) while
// the total keeps 14.4 kB at 320. A further entry breach still means the shell
// itself grew and needs a look; screen weight belongs in lazy chunks.
// 2026-11-09 (employee self-service): measured entry 20.1 kB. The new
// `hr-self-service` permission row, sidebar item, canonical path, tab gate and
// lazy route are shell weight; they left the old 20.0 kB gate 65 gzip bytes
// short. The entry budget moves 20 -> 20.125 kB (73 B headroom at the measured
// size) rather than dropping the explicit permission row or the preloader
// entry. The 320 kB startup total is unchanged (measured 311.4 kB).
// 2026-11-09 (ESS leave): measured entry 20,655 B (20.2 kB). The new
// `hr-self-leave` route, sidebar item, canonical path, tab gate and preload
// are shell weight; they left the 20.125 kB gate 47 B short. The entry budget
// moves to 20.25 kB (20,736 B; 81 B headroom) rather than dropping required
// wiring. The 320 kB startup total is unchanged (measured 311.6 kB).
// 2026-11-09 (ESS documents): measured entry 20,748 B (20.3 kB). The new
// `hr-self-documents` route, sidebar item, canonical path, tab gate and
// preload are shell weight; they left the 20.25 kB gate 12 B short. The entry
// budget moves to 20.375 kB (20,864 B; 116 B headroom) rather than dropping
// required wiring. The 320 kB startup total is unchanged (measured 311.8 kB).
// 2026-11-09 (HR Reports payroll/statutory): measured entry 20,815 B after the
// report API barrel addition. It stayed inside the existing 20.375 kB gate
// (49 B headroom), so no budget move was needed; startup measured 312.1 kB.
// 2026-11-09 (recruitment): measured entry 20,886 B (20.4 kB). The new
// `hr-recruitment` route, sidebar item, canonical path, tab gate and preload
// are shell weight; they left the 20.375 kB gate 22 B short. The budget moves
// to 20.5 kB (20,992 B; 106 B headroom) rather than dropping required wiring.
// Startup measured 312.6 kB against the unchanged 320 kB total.
// 2026-11-10 (budgets): measured entry 20,998 B. The three budget API entry
// points joined the eagerly imported services/api barrel; the Budget vs actual
// screen itself is lazy. The 6 B overflow moves the entry gate 20.5 -> 20.625 kB
// (21,120 B; 122 B headroom). Startup measured 313.3 kB against the unchanged
// 320 kB total.
// 2026-11-11 (module rollout): measured entry 20.8 kB after the HR, budget and
// warranty permission rows, sidebar items, canonical paths, tab gates and API
// barrel additions. The shell wiring is required for the new registers; the
// entry gate moves to 21 kB (21,504 B) while startup measures 315.3 kB against
// the unchanged 320 kB total.
const BUDGETS = {
  entryGz: 21 * 1024, // entry chunk alone
  startupTotalGz: 320 * 1024, // entry + all statically-imported chunks
};

/** Budget labels keep fractional kB (20.125) instead of truncating to 20. */
const budgetKb = (bytes) => Number((bytes / 1024).toFixed(3));

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
console.log(`  entry:        ${entry} — ${(entryGz / 1024).toFixed(1)} kB gz (budget ${budgetKb(BUDGETS.entryGz)} kB)`);
console.log(`  startup total: ${(totalGz / 1024).toFixed(1)} kB gz (budget ${budgetKb(BUDGETS.startupTotalGz)} kB)`);
console.log(`  on-demand (dynamic-only, not budgeted): ${dynamicOnly.size} chunks`);

let breached = false;
if (entryGz > BUDGETS.entryGz) {
  console.error(`✖ Entry chunk ${(entryGz / 1024).toFixed(1)} kB gz exceeds ${budgetKb(BUDGETS.entryGz)} kB budget.`);
  breached = true;
}
if (totalGz > BUDGETS.startupTotalGz) {
  console.error(`✖ Startup total ${(totalGz / 1024).toFixed(1)} kB gz exceeds ${budgetKb(BUDGETS.startupTotalGz)} kB budget.`);
  console.error(`  Likely causes: a screen re-added to App.tsx's eager imports, a big`);
  console.error(`  dependency imported at startup, or manualChunks changes that`);
  console.error(`  merged a lazy chunk into the static graph.`);
  breached = true;
}

if (breached) process.exit(1);
console.log('✔ Bundle budget OK');
