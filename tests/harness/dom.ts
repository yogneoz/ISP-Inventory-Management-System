/**
 * A real DOM for the client render tests (A1 measurement harness).
 *
 * Node's test runner gives every test FILE its own child process, so the globals
 * installed here never reach the server-side suites. The DOM must exist before
 * `react-dom` is evaluated (its `canUseDOM` probe runs at module load), so any
 * harness module that imports react-dom imports this one first — ESM evaluates
 * dependencies in import order.
 *
 * `IS_REACT_ACT_ENVIRONMENT` is what makes React's `act()` authoritative for
 * flushing effects and state updates; without it React logs a warning and the
 * assertions race the scheduler.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});

const win = dom.window as unknown as Record<string, unknown>;
const globals: Record<string, unknown> = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  DocumentFragment: win.DocumentFragment,
  Text: win.Text,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  getComputedStyle: win.getComputedStyle,
  requestAnimationFrame: win.requestAnimationFrame,
  cancelAnimationFrame: win.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: true,
};

for (const [name, value] of Object.entries(globals)) {
  // `navigator` is a getter on Node 21+, so define rather than assign.
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
