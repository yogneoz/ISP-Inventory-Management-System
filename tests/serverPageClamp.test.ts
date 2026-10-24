/**
 * DF-09 — a server-paged register must never keep requesting a page the
 * filtered row set no longer has.
 *
 * PROVES:
 *  1. `clampPage`: an out-of-range page falls back to the last page, and an
 *     empty row set is page 1 (never page 0).
 *  2. `useServerPageClamp`, through a real React render: a total that shrinks
 *     under the current page snaps the STATE back to the new last page (not
 *     just the displayed number), a total that shrinks to zero lands on page 1,
 *     and a total that still covers the page leaves it alone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useState } from 'react';
import { inAct, mountTree } from './harness/mount';
import { clampPage, useServerPageClamp } from '../client/src/components/common/TablePagination';

const PAGE_SIZE = 15;

interface ProbeHandles {
  page: number;
  safePage: number;
  setTotal: (total: number) => void;
}

function PageProbe({
  handles,
  initialPage,
  initialTotal,
}: {
  handles: ProbeHandles;
  initialPage: number;
  initialTotal: number;
}) {
  const [page, setPage] = useState(initialPage);
  const [total, setTotal] = useState(initialTotal);
  const safePage = useServerPageClamp(page, PAGE_SIZE, total, setPage);
  handles.page = page;
  handles.safePage = safePage;
  handles.setTotal = setTotal;
  return h('div', { 'data-page': String(page), 'data-safe': String(safePage) });
}

function mountProbe(initialPage: number, initialTotal: number) {
  const handles = {} as ProbeHandles;
  const tree = mountTree(h(PageProbe, { handles, initialPage, initialTotal }));
  const read = () => {
    const node = tree.container.querySelector('div')!;
    return {
      page: Number(node.getAttribute('data-page')),
      safe: Number(node.getAttribute('data-safe')),
    };
  };
  return { handles, tree, read };
}

describe('clampPage (DF-09)', () => {
  test('an out-of-range page falls back to the last page', () => {
    assert.equal(clampPage(5, 4), 4);
    assert.equal(clampPage(3, 3), 3);
    assert.equal(clampPage(1, 4), 1);
  });

  test('an empty row set is page 1, never page 0', () => {
    assert.equal(clampPage(1, 0), 1);
    assert.equal(clampPage(0, 4), 1);
  });
});

describe('useServerPageClamp (DF-09)', () => {
  test('a shrinking total snaps the page state to the new last page', () => {
    const { handles, tree, read } = mountProbe(5, 61); // 5 pages
    assert.deepEqual(read(), { page: 5, safe: 5 });

    inAct(() => handles.setTotal(60)); // 4 pages: page 5 no longer exists
    assert.deepEqual(
      read(),
      { page: 4, safe: 4 },
      'the state must clamp, not only the displayed page'
    );
    tree.unmount();
  });

  test('an empty total lands on page 1', () => {
    const { handles, tree, read } = mountProbe(3, 31); // 3 pages
    inAct(() => handles.setTotal(0));
    assert.deepEqual(read(), { page: 1, safe: 1 });
    tree.unmount();
  });

  test('a total that still covers the page leaves it alone', () => {
    const { handles, tree, read } = mountProbe(2, 31);
    inAct(() => handles.setTotal(45)); // still 3 pages
    assert.deepEqual(read(), { page: 2, safe: 2 });
    tree.unmount();
  });
});
