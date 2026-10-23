/**
 * A1 — screen element memoisation contract.
 *
 * The rule the keep-mounted container depends on: the SAME element object must
 * come back while a screen's props are unchanged (React then skips that
 * subtree), and a NEW one as soon as anything the screen consumes changes.
 * Callbacks are the only prop allowed to change identity in place — they are
 * proxied to the newest closure, which these tests pin so memoisation can never
 * resurrect stale state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {
  createScreenSlotCache,
  memoizeTabElement,
} from '../client/src/utils/screenElementMemo';

const Screen = (_props: Record<string, unknown>) => null;
const OtherScreen = (_props: Record<string, unknown>) => null;
const fallback = React.createElement('span');

function memo(
  cache: ReturnType<typeof createScreenSlotCache>,
  element: React.ReactNode,
  key = 'tab'
) {
  return memoizeTabElement(cache, key, element) as React.ReactElement<Record<string, any>>;
}

describe('screenElementMemo — element identity is what React bails out on', () => {
  test('unchanged props (including a rebuilt inline handler) reuse the same element object', () => {
    const cache = createScreenSlotCache();
    const rows = [1, 2, 3];

    const freshFirst = React.createElement(Screen, { rows, onSave: () => 'first' });
    const freshSecond = React.createElement(Screen, { rows, onSave: () => 'second' });
    assert.notEqual(freshFirst, freshSecond, 'precondition: each render builds a new element');

    const first = memo(cache, freshFirst);
    const second = memo(cache, freshSecond);

    assert.equal(second, first, 'unchanged screen inputs must reuse the cached element');
    assert.notEqual(second, freshSecond);
  });

  test('a changed data prop produces a new element carrying the new value', () => {
    const cache = createScreenSlotCache();
    const onSave = () => undefined;
    const rows = [1];
    const nextRows = [1, 2];

    const first = memo(cache, React.createElement(Screen, { rows, onSave }));
    const sameProps = memo(cache, React.createElement(Screen, { rows, onSave }));
    const changed = memo(cache, React.createElement(Screen, { rows: nextRows, onSave }));

    assert.equal(sameProps, first);
    assert.notEqual(changed, first);
    assert.equal(changed.props.rows, nextRows);
  });

  test('the memoised callback always runs the newest closure (no stale state)', () => {
    const cache = createScreenSlotCache();
    const rows = [1];
    const calls: string[] = [];

    const first = memo(
      cache,
      React.createElement(Screen, { rows, onSave: () => calls.push('old') })
    );
    const second = memo(
      cache,
      React.createElement(Screen, { rows, onSave: () => calls.push('new') })
    );
    assert.equal(second, first, 'precondition: the element was reused');

    // The screen still holds the element from the FIRST render — and still
    // calls the handler from the SECOND one.
    (first.props.onSave as () => void)();
    assert.deepEqual(calls, ['new']);
  });

  test('callback arguments and return values pass through the proxy', () => {
    const cache = createScreenSlotCache();
    const element = memo(
      cache,
      React.createElement(Screen, {
        rows: [],
        onPick: (id: string, qty: number) => `${id}:${qty}`,
      })
    );
    assert.equal((element.props.onPick as (id: string, qty: number) => string)('p1', 4), 'p1:4');
  });

  test('a different component type never reuses the previous element', () => {
    const cache = createScreenSlotCache();
    const rows: number[] = [];
    const onSave = () => undefined;

    const first = memo(cache, React.createElement(Screen, { rows, onSave }));
    const second = memo(cache, React.createElement(OtherScreen, { rows, onSave }));

    assert.notEqual(first, second);
    assert.equal(second.type, OtherScreen);
  });

  test('added or removed props invalidate the cached element', () => {
    const cache = createScreenSlotCache();
    const rows: number[] = [];
    const onSave = () => undefined;

    const first = memo(cache, React.createElement(Screen, { rows, onSave }));
    const withQuery = memo(cache, React.createElement(Screen, { rows, onSave, query: 'abc' }));
    const dropped = memo(cache, React.createElement(Screen, { rows, onSave }));

    assert.notEqual(withQuery, first);
    assert.equal(withQuery.props.query, 'abc');
    assert.notEqual(dropped, withQuery);
    assert.equal('query' in dropped.props, false);
  });

  test('object and array props from state are compared by identity, not shape', () => {
    const cache = createScreenSlotCache();
    const first = memo(cache, React.createElement(Screen, { rows: [1] }));
    // A rebuilt array with identical contents is still a new value: the screen
    // must re-render rather than show rows it never received.
    const second = memo(cache, React.createElement(Screen, { rows: [1] }));
    assert.notEqual(first, second);
  });
});

describe('screenElementMemo — Suspense-wrapped (lazy) tabs', () => {
  const suspense = (child: React.ReactNode) =>
    React.createElement(React.Suspense, { fallback }, child);

  test('the wrapper is rebuilt but its screen child keeps its identity', () => {
    const cache = createScreenSlotCache();
    const rows = [{ id: 'r1' }];
    const onSave = () => undefined;

    const first = memo(cache, suspense(React.createElement(Screen, { rows, onSave }))) as any;
    const second = memo(cache, suspense(React.createElement(Screen, { rows, onSave }))) as any;

    assert.notEqual(first, second, 'the wrapper carries a fresh fallback element');
    assert.equal(first.props.children, second.props.children);
    assert.equal(second.props.children.type, Screen);
  });

  test('a data change inside the wrapper still produces a new screen element', () => {
    const cache = createScreenSlotCache();
    const onSave = () => undefined;

    const first = memo(cache, suspense(React.createElement(Screen, { rows: [1], onSave }))) as any;
    const second = memo(
      cache,
      suspense(React.createElement(Screen, { rows: [1, 2], onSave }))
    ) as any;

    assert.notEqual(first.props.children, second.props.children);
    assert.deepEqual(second.props.children.props.rows, [1, 2]);
  });
});

describe('screenElementMemo — passthrough', () => {
  test('null, text and boolean children are returned untouched', () => {
    const cache = createScreenSlotCache();
    assert.equal(memoizeTabElement(cache, 'tab', null), null);
    assert.equal(memoizeTabElement(cache, 'tab', 'plain text'), 'plain text');
    assert.equal(memoizeTabElement(cache, 'tab', false), false);
  });

  test('a Suspense with no element child is returned as built', () => {
    const cache = createScreenSlotCache();
    const wrapper = React.createElement(React.Suspense, { fallback }, 'text');
    assert.equal(memoizeTabElement(cache, 'tab', wrapper), wrapper);
  });

  test('separate slot keys never share a cached element', () => {
    const cache = createScreenSlotCache();
    const rows: number[] = [];
    const onSave = () => undefined;
    const a = memo(cache, React.createElement(Screen, { rows, onSave }), 'a');
    const b = memo(cache, React.createElement(Screen, { rows, onSave }), 'b');
    assert.notEqual(a, b);
  });
});

describe('A1 wiring — the container actually memoises, and every tab is a memo-shaped child', () => {
  const read = (file: string) =>
    fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

  test('KeepMounted hands its child to the slot cache', () => {
    const source = read('client/src/components/common/KeepMounted.tsx');
    assert.match(
      source,
      /memoizeTabElement\(\s*screenCache\.current,\s*'screen',\s*children\s*\)/,
      'KeepMounted must memoise the tab element, not render `children` directly'
    );
    assert.doesNotMatch(
      source,
      /\{everVisible\.current \? children : null\}/,
      'the pre-A1 direct children render must not come back'
    );
  });

  test('all 67 tabs wrap a screen element (directly or in one Suspense)', () => {
    const app = read('client/src/App.tsx').split('\n');
    const starts = app
      .map((line, index) => (line.includes('<KeepMounted ') ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(starts.length, 67, 'tab count changed — re-check the memo covers every slot');

    const offenders: string[] = [];
    for (const start of starts) {
      const firstChild = app
        .slice(start + 1)
        .find((line) => line.trim().length > 0)
        ?.trim();
      if (!firstChild || !firstChild.startsWith('<') || firstChild.startsWith('</')) {
        offenders.push(app[start].trim());
        continue;
      }
      if (firstChild.startsWith('<React.Suspense')) {
        const wrapperChild = app
          .slice(start + 2)
          .find((line) => line.trim().length > 0)
          ?.trim();
        if (!wrapperChild || !wrapperChild.startsWith('<')) {
          offenders.push(app[start].trim());
        }
      }
    }
    assert.deepEqual(offenders, [], 'a tab child that is not an element cannot be memoised');
  });
});
