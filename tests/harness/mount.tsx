/**
 * Minimal `react-dom/client` mount helper for the render-count tests.
 *
 * Deliberately smaller than a testing-library setup: A1 only needs "mount this
 * tree, re-render it, tell me how many times each screen body ran". `act()`
 * flushes the render and its effects synchronously so counts are deterministic
 * (no scheduler-dependent sleeps).
 */
import './dom';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

export interface MountedTree {
  container: HTMLElement;
  rerender: (element: ReactElement) => void;
  unmount: () => void;
}

export function mountTree(element: ReactElement): MountedTree {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    rerender(next: ReactElement) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Runs `fn` inside act() so effects and state updates flush before assertions. */
export function inAct(fn: () => void): void {
  act(fn);
}
