/**
 * Regression guard for the startup chunk graph.
 *
 * The budget check can stay green while a shared module is folded into a lazy
 * screen's chunk: an eager import of that shared module then pulls the entire
 * screen into startup. These tests pin the detector that compares App.tsx's
 * React.lazy declarations with the built startup set.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  chunkPrefixForLazyImport,
  findLazyScreenChunksInStartup,
  lazyImportPaths,
} from '../scripts/startupGraphGuard.mjs';

describe('startup graph guard — lazy screens stay off the startup graph', () => {
  test('maps lazy feature and shared-component imports to their manualChunks names', () => {
    assert.equal(
      chunkPrefixForLazyImport('./features/dashboard/CompanyOverview'),
      'feature-dashboard-CompanyOverview'
    );
    assert.equal(
      chunkPrefixForLazyImport('./features/settings/PermissionManagement'),
      'feature-settings-PermissionManagement'
    );
    assert.equal(
      chunkPrefixForLazyImport('./components/common/ClearDemoDataView'),
      'shared-common-ClearDemoDataView'
    );
    assert.equal(chunkPrefixForLazyImport('./somewhere/Elsewhere'), null);
  });

  test('flags a lazy screen chunk that an eager import pulled into startup', () => {
    const appSource = `
      const CompanyOverview = React.lazy(() =>
        import('./features/dashboard/CompanyOverview').then((m) => ({ default: m.CompanyOverview }))
      );
    `;
    const leaks = findLazyScreenChunksInStartup({
      appSource,
      startupChunks: [
        'index-aaaa.js',
        'vendor-react-bbbb.js',
        'feature-dashboard-CompanyOverview-cccc.js',
      ],
    });

    assert.deepEqual(leaks, [
      {
        importPath: './features/dashboard/CompanyOverview',
        chunk: 'feature-dashboard-CompanyOverview-cccc.js',
      },
    ]);
  });

  test('ignores dynamic-only lazy chunks and eager screens that are not lazy', () => {
    const appSource = `
      const CompanyOverview = React.lazy(() => import('./features/dashboard/CompanyOverview'));
    `;
    const leaks = findLazyScreenChunksInStartup({
      appSource,
      startupChunks: [
        'index-aaaa.js',
        'feature-dashboard-Dashboard-bbbb.js',
        'feature-settings-PermissionSetsPanel-cccc.js',
      ],
    });

    assert.deepEqual(leaks, []);
  });

  test('every real App.tsx lazy declaration classifies to a chunk prefix', () => {
    const appSource = fs.readFileSync(path.resolve('client/src/routes/lazyScreens.ts'), 'utf8');
    // lazyScreens sits beside the features, so its specifiers are '../features/…';
    // normalise to the './features/…' form the chunk-prefix mapper speaks.
    const paths = lazyImportPaths(appSource).map((p) => p.replace(/^\.\.\//, './'));
    assert.ok(paths.length > 0, 'expected App.tsx to declare lazy screens');
    for (const importPath of paths) {
      assert.ok(
        chunkPrefixForLazyImport(importPath),
        `${importPath} does not map to a Vite manualChunks prefix, so the guard cannot see it`
      );
    }
    assert.ok(paths.includes('./features/dashboard/CompanyOverview'));
    assert.ok(paths.includes('./features/settings/PermissionManagement'));
  });
});
