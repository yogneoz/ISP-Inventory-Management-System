/**
 * Worklist A10 — a browser check must fail when the page cannot receive input.
 *
 * The decision function is pure, so every state that used to pass silently is
 * pinned here without a browser: a hidden or unfocused document, an element
 * covered by an overlay, a disabled or read-only input, an input that cannot
 * take focus, an input whose value does not change when text is typed, and a
 * shell that never becomes interactive. The wiring pins then make sure the
 * boot-timing gate actually consults the verdict and injects every fault it
 * claims to detect.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  INPUT_FAULTS,
  diagnoseInputReadiness,
  faultInjectionSource,
} from '../scripts/inputReadiness.mjs';

const HEALTHY_CONTROL = {
  selector: 'input#customer-search[type="text"]',
  tag: 'input',
  type: 'text',
  visible: true,
  coveredBy: null as string | null,
  disabled: false,
  readOnly: false,
  focusable: true,
  textEditable: true,
  value: '',
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    visibilityState: 'visible',
    hasFocus: true,
    interactiveCount: 1,
    targetSelector: HEALTHY_CONTROL.selector,
    controls: [HEALTHY_CONTROL],
    mainText: 'Create Sales Invoice',
    typing: { attempted: true, changed: true, before: '' },
    ...overrides,
  };
}

describe('input readiness diagnosis (A10)', () => {
  test('a visible, focused page with a typable control passes', () => {
    const verdict = diagnoseInputReadiness(snapshot());
    assert.equal(verdict.ok, true, verdict.problems.join('; '));
    assert.equal(verdict.target, HEALTHY_CONTROL.selector);
  });

  test('a hidden document fails and says input cannot reach the page', () => {
    const verdict = diagnoseInputReadiness(snapshot({ visibilityState: 'hidden' }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /"hidden", not "visible" — input cannot reach this page/);
  });

  test('an unfocused page fails: a click would only activate the window', () => {
    const verdict = diagnoseInputReadiness(snapshot({ hasFocus: false }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /does not hold focus/);
    assert.match(verdict.problems[0], /input cannot reach this page/);
  });

  test('an element covered by an overlay fails and names the covering element', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({ controls: [{ ...HEALTHY_CONTROL, coveredBy: 'div#input-readiness-overlay' }] })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /"input#customer-search\[type="text"\]" is covered by "div#input-readiness-overlay"/);
    assert.match(verdict.problems[0], /a click at its centre lands on that element instead/);
  });

  test('a disabled input fails', () => {
    const verdict = diagnoseInputReadiness(snapshot({ controls: [{ ...HEALTHY_CONTROL, disabled: true }] }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /is disabled, so it refuses input/);
  });

  test('a read-only input fails: typing cannot change it', () => {
    const verdict = diagnoseInputReadiness(snapshot({ controls: [{ ...HEALTHY_CONTROL, readOnly: true }] }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /is read-only/);
  });

  test('an input that cannot take focus fails', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({ controls: [{ ...HEALTHY_CONTROL, focusable: false }] })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /cannot take focus/);
  });

  test('an input whose value does not change when typed into fails', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({ typing: { attempted: true, changed: false, before: 'unchanged' } })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /did not change its value \(still "unchanged"\)/);
  });

  test('a never-interactive shell fails even with a clean page state', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({ interactiveCount: 0, targetSelector: null, controls: [], mainText: 'Loading…' })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /no interactive control is on screen \(main shows: "Loading…"\)/);
    assert.match(verdict.problems[0], /loading\/disabled shell/);
  });

  test('a pinned target that becomes disabled is reported as disabled, not as a shell', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({
        interactiveCount: 0,
        targetPinned: true,
        controls: [{ ...HEALTHY_CONTROL, disabled: true }],
        typing: { attempted: false, changed: false, before: '' },
      })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /"input#customer-search\[type="text"\]" is disabled/);
    assert.ok(
      !verdict.problems.some((problem) => /loading\/disabled shell/.test(problem)),
      'the shell message must not mask the element that actually refused input'
    );
  });

  test('a pinned target that cannot take focus is reported as focus, not as coverage', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({
        targetPinned: true,
        controls: [{ ...HEALTHY_CONTROL, focusable: false }],
        typing: { attempted: false, changed: false, before: '' },
      })
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.problems[0], /cannot take focus/);
    assert.ok(!verdict.problems.some((problem) => /covered by/.test(problem)));
  });

  test('a page with no hidden or unfocused controls but no control at all reports every cause', () => {
    const verdict = diagnoseInputReadiness(
      snapshot({
        visibilityState: 'hidden',
        hasFocus: false,
        interactiveCount: 0,
        targetSelector: null,
        controls: [],
      })
    );
    assert.equal(verdict.problems.length, 3, verdict.problems.join(' | '));
  });
});

describe('input readiness wiring (A10)', () => {
  const check = fs.readFileSync('scripts/check_boot_timing.mjs', 'utf8');

  test('the boot-timing gate imports the readiness probe and folds its problems into the failure list', () => {
    assert.match(check, /from '\.\/inputReadiness\.mjs'/);
    assert.match(check, /runInputReadiness\(cdp, \{ faults: injectFault, log \}\)/);
    assert.match(check, /problems\.push\(\.\.\.readiness\.problems\.map/);
  });

  test('the gate can reproduce every fault it claims to detect', () => {
    assert.deepEqual(INPUT_FAULTS, ['overlay', 'disabled', 'readonly', 'unfocusable', 'nontyping', 'shell']);
    assert.match(check, /--self-test/);
    for (const fault of INPUT_FAULTS) {
      const source = faultInjectionSource(fault, 'input#x');
      assert.ok(source.length > 20, `${fault} must produce an injection script`);
    }
  });

  test('an unknown fault is refused instead of silently doing nothing', () => {
    assert.throws(() => faultInjectionSource('nonsense', 'input#x'), /unknown fault "nonsense"/);
  });

  test('the overlay fault paints a full-viewport layer above everything', () => {
    const source = faultInjectionSource('overlay', 'input#x');
    assert.match(source, /position:fixed;inset:0;z-index:2147483647/);
  });

  test('the shell fault replaces the screen with a loading shell', () => {
    const source = faultInjectionSource('shell', 'input#x');
    assert.match(source, /Loading…/);
    assert.match(source, /aria-busy="true"/);
  });
});
