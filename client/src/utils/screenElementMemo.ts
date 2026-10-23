import React from 'react';

/**
 * A1 — stable tab elements for the keep-mounted container.
 *
 * Before this module, `KeepMounted` rendered whatever element App had just
 * built. App rebuilds every tab element on every render (a keystroke in the
 * global search box is enough), so React re-rendered **every screen the user
 * had ever opened**, even the hidden ones, on each root state change.
 *
 * React already has the fix for that: if a parent re-renders but hands a child
 * the *identical* element object (`prevChild === nextChild`), React reuses the
 * current fiber and bails out of rendering that subtree. This module decides
 * when that is safe: a slot caches the element it last produced, and returns
 * that same object again when the new element has the same type and
 * shallow-equal props. Any real data change produces a new element, so the
 * screen re-renders exactly as before.
 *
 * The one thing a shallow comparison gets wrong on its own is callbacks: App
 * defines its handlers inline, so `onCreateProduct` etc. are new function
 * objects on every render. Comparing them would defeat the whole cache. Each
 * function prop is therefore replaced with a **stable proxy** that forwards to
 * the newest handler — the screen keeps a fixed identity, and a click always
 * runs the latest closure (no stale state). Measured before/after in
 * [screenElementMemo.test.ts](../../../tests/screenElementMemo.test.ts) and
 * [keepMountedRenderCount.test.ts](../../../tests/keepMountedRenderCount.test.ts).
 */

type Handler = (...args: any[]) => any;
/** Elements here are always component elements; their props are read one level deep. */
type AnyElement = React.ReactElement<Record<string, any>>;

interface ScreenSlot {
  /** Element type last memoised, so a changed component can never reuse a stale element. */
  type: AnyElement['type'] | null;
  /** Normalised props of the cached element (function props replaced by proxies). */
  props: Record<string, unknown> | null;
  /** The element object handed to React — identical across no-op renders. */
  element: AnyElement | null;
  /** Newest element built by App; the proxies call their handlers from here. */
  latest: AnyElement | null;
  /** One stable proxy per function prop name. */
  proxies: Map<string, Handler>;
}

export interface ScreenSlotCache {
  slots: Map<string, ScreenSlot>;
}

export function createScreenSlotCache(): ScreenSlotCache {
  return { slots: new Map() };
}

function sameProps(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Memoises one screen element in `slot` and returns the element to render.
 *
 * Returned identity is the contract: the same object as the previous call means
 * "nothing this screen consumes changed", so React skips the subtree; a new
 * object means at least one prop did change.
 */
function memoizeScreenElement(
  slot: ScreenSlot,
  element: AnyElement
): AnyElement {
  slot.latest = element;

  const props = element.props ?? {};
  const normalized: Record<string, unknown> = {};
  for (const name of Object.keys(props)) {
    const value = props[name];
    if (typeof value !== 'function') {
      normalized[name] = value;
      continue;
    }
    let proxy = slot.proxies.get(name);
    if (!proxy) {
      proxy = (...args: any[]) => {
        const live = slot.latest?.props?.[name];
        if (typeof live !== 'function') {
          throw new Error(
            `Screen prop "${name}" was a function but the latest render passed ${live === undefined ? 'undefined' : typeof live}`
          );
        }
        return live(...args);
      };
      slot.proxies.set(name, proxy);
    }
    normalized[name] = proxy;
  }

  if (slot.element && slot.type === element.type && slot.props && sameProps(slot.props, normalized)) {
    return slot.element;
  }

  slot.type = element.type;
  slot.props = normalized;
  slot.element = React.cloneElement(element, normalized);
  return slot.element;
}

/**
 * Memoises a keep-mounted tab's child tree under one slot key.
 *
 * A tab is either a screen element or a `<React.Suspense>` (lazy chunk) wrapping
 * one screen element. The Suspense wrapper itself is cheap and carries a fresh
 * `fallback` element, so it is rebuilt every render — but its child is the
 * memoised screen, which is what lets React bail out of the screen subtree.
 */
export function memoizeTabElement(
  cache: ScreenSlotCache,
  key: string,
  node: React.ReactNode
): React.ReactNode {
  if (!React.isValidElement(node)) return node;
  const element = node as AnyElement;

  if ((element.type as unknown) === React.Suspense) {
    const child = element.props?.children;
    if (!React.isValidElement(child)) return element;
    const stableChild = memoizeTabElement(cache, key, child);
    return stableChild === child ? element : React.cloneElement(element, undefined, stableChild);
  }

  let slot = cache.slots.get(key);
  if (!slot) {
    slot = { type: null, props: null, element: null, latest: null, proxies: new Map() };
    cache.slots.set(key, slot);
  }
  return memoizeScreenElement(slot, element);
}
