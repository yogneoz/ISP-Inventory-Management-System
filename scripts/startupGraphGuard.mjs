/**
 * Startup-graph guard helpers.
 *
 * The bundle budget catches a startup graph that is too big, but a shared
 * module can be folded into a lazy screen's chunk and still leave the total
 * under budget. An eager import of that shared module then pulls the whole
 * screen into startup even though `App.tsx` declared it with React.lazy.
 *
 * These helpers compare the production startup closure against the lazy route
 * declarations: any `feature-*`/`shared-*` chunk that manualChunks would name
 * after a lazy screen must not be in the startup set.
 */

const LAZY_IMPORT_RE = /React\.lazy\(\s*\(\s*\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every module path passed to React.lazy in an App source file.
 *
 * @param {string} appSource
 * @returns {string[]}
 */
export function lazyImportPaths(appSource) {
  return [...appSource.matchAll(LAZY_IMPORT_RE)].map((match) => match[1]);
}

/**
 * The manualChunks chunk-name prefix for a lazy import path.
 *
 * `./features/dashboard/CompanyOverview` becomes
 * `feature-dashboard-CompanyOverview`; a shared component becomes
 * `shared-common-ClearDemoDataView`. Returns null for a path the Vite
 * manualChunks rules do not name (the guard must not silently ignore it; the
 * test asserts every real lazy declaration classifies).
 *
 * @param {string} importPath
 * @returns {string | null}
 */
export function chunkPrefixForLazyImport(importPath) {
  const clean = importPath.replace(/^\.\//, '').replace(/\.(?:tsx?|jsx?)$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts[0] === 'features' && parts.length >= 3) {
    return `feature-${parts[1]}-${parts[parts.length - 1]}`;
  }
  if (['components', 'utils', 'hooks', 'contexts'].includes(parts[0]) && parts.length >= 2) {
    return `shared-${parts.slice(1).join('-')}`;
  }
  return null;
}

/**
 * @typedef {{ importPath: string, chunk: string }} LazyScreenInStartup
 */

/**
 * Lazy screen chunks that are statically reachable from the entry chunk.
 *
 * A Vite chunk is `<prefix>-<hash>.js`, so matching the prefix plus the hash
 * separator avoids confusing `.../PermissionManagement` with
 * `.../PermissionSetsPanel`.
 *
 * @param {{ appSource: string, startupChunks: string[] }} input
 * @returns {LazyScreenInStartup[]}
 */
export function findLazyScreenChunksInStartup({ appSource, startupChunks }) {
  const byPrefix = new Map();
  for (const importPath of lazyImportPaths(appSource)) {
    const prefix = chunkPrefixForLazyImport(importPath);
    if (prefix) byPrefix.set(prefix, importPath);
  }

  const leaks = [];
  const seen = new Set();
  for (const chunk of startupChunks) {
    for (const [prefix, importPath] of byPrefix) {
      if (chunk === `${prefix}.js` || chunk.startsWith(`${prefix}-`)) {
        if (!seen.has(chunk)) {
          leaks.push({ importPath, chunk });
          seen.add(chunk);
        }
        break;
      }
    }
  }
  return leaks;
}
