/**
 * A3 — session and scope contexts.
 *
 * Two things must stay true as the root is split up:
 *  1. the PROVIDERS own these values; App no longer declares them, and
 *  2. no feature screen reads them from a prop AND a context (A3 keeps the
 *     screen props; the guard fails the day a half-migration starts).
 * The behavioural test mounts the real provider composition and proves the
 * values move when a consumer changes them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { mountSessionScopeProbe } from './harness/sessionScopeProbe';
import { saveUserSession } from '../client/src/utils/sessionCache';
import type { User } from '../client/src/types';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

const SESSION_VALUES = [
  'currentUser',
  'rootUser',
  'permissionsMatrix',
  'appSettings',
  'dateMode',
] as const;

const SCOPE_VALUES = ['selectedBranchId', 'selectedFiscalYearId', 'fiscalYears'] as const;

test('A3: App reads session and scope from the contexts instead of owning them', () => {
  const app = read('client/src/App.tsx');

  assert.match(app, /import \{ useSession \} from '\.\/contexts\/SessionContext'/, 'App must read the session context');
  assert.match(app, /import \{ useScope \} from '\.\/contexts\/ScopeContext'/, 'App must read the scope context');
  assert.match(app, /useSession\(\)/, 'App must call useSession()');
  assert.match(app, /useScope\(\)/, 'App must call useScope()');

  for (const value of [...SESSION_VALUES, ...SCOPE_VALUES]) {
    assert.doesNotMatch(
      app,
      new RegExp(`const \\[${value}, set[A-Z]\\w*\\] = useState`),
      `App must not own ${value} in useState — the provider is the single source`
    );
  }
});

test('A3: the providers own every moved value', () => {
  const session = read('client/src/contexts/SessionContext.tsx');
  const scope = read('client/src/contexts/ScopeContext.tsx');

  for (const value of SESSION_VALUES) {
    assert.match(
      session,
      new RegExp(`const \\[${value}, set[A-Z]\\w*\\] = useState`),
      `SessionContext must own ${value}`
    );
  }
  for (const value of SCOPE_VALUES) {
    assert.match(
      scope,
      new RegExp(`const \\[${value}, set[A-Z]\\w*\\] = useState`),
      `ScopeContext must own ${value}`
    );
  }

  assert.match(session, /export function useSession/, 'the session hook must exist');
  assert.match(scope, /export function useScope/, 'the scope hook must exist');
  assert.match(session, /useSession must be used inside <SessionProvider>/, 'a missing provider must fail loudly');
  assert.match(scope, /useScope must be used inside <ScopeProvider>/, 'a missing provider must fail loudly');
});

test('A3: main.tsx and the route-tree harness share one provider composition', () => {
  const main = read('client/src/main.tsx');
  const providers = read('client/src/contexts/AppProviders.tsx');
  const harness = read('tests/harness/appRouteTreeProbe.tsx');

  assert.match(main, /<AppProviders>/, 'main must render the shared composition');
  assert.match(harness, /<AppProviders>/, 'the route-tree test must render the same composition');
  assert.doesNotMatch(main, /<DarkModeProvider|<DialogProvider|<SessionProvider|<ScopeProvider/, 'main must not keep a second provider list');

  for (const provider of ['DarkModeProvider', 'SessionProvider', 'ScopeProvider', 'DialogProvider']) {
    assert.match(providers, new RegExp(`<${provider}>`), `AppProviders must include ${provider}`);
  }
});

test('A3: no feature screen reads the contexts yet — screens keep their props this slice', () => {
  const featuresDir = path.join(process.cwd(), 'client/src/features');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(featuresDir);

  assert.ok(files.length > 50, 'the feature directory must actually have been scanned');
  const offenders = files.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /contexts\/(Session|Scope)Context/.test(source);
  });
  assert.deepEqual(
    offenders.map((file) => path.relative(process.cwd(), file)),
    [],
    'a feature screen mixing context reads with its existing props would be a half-migration'
  );
});

test('A3: the provider composition owns state that consumers can read and change', async () => {
  localStorage.clear();
  const user = {
    id: 'u-a3',
    name: 'A3 Probe',
    email: 'a3@example.com',
    role: 'SUPER_ADMIN',
    branchId: 'ALL',
  } as unknown as User;
  saveUserSession(user, user, 'a3-token');
  localStorage.setItem('inventory_date_mode', 'BS');

  const tree = mountSessionScopeProbe();

  try {
    const text = (id: string) => tree.container.querySelector(`[data-testid="${id}"]`)?.textContent;
    assert.equal(text('who'), 'a3@example.com', 'the session user must come from the seeded session');
    assert.equal(text('mode'), 'BS', 'date mode must start from the paint-time mirror');
    assert.equal(text('branch'), 'ALL', 'the scope must default to all branches');
    assert.equal(text('fys'), '0', 'no fiscal year is chosen before bootstrap');
    assert.equal(text('blind'), 'unset', 'app settings start empty');

    const button = tree.container.querySelector('[data-testid="change"]') as HTMLElement;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    assert.equal(text('mode'), 'AD', 'date mode changes must propagate from the provider');
    assert.equal(text('branch'), 'WH001', 'branch changes must propagate from the provider');
    assert.equal(text('fys'), '1', 'the fiscal-year list must live in the scope provider');
    assert.equal(text('blind'), 'true', 'app settings must live in the session provider');
  } finally {
    tree.unmount();
  }
});
