#!/usr/bin/env node
/**
 * Input readiness for browser-driven checks — worklist A10.
 *
 * THE FAILURE THIS EXISTS TO PREVENT
 * A rendered page is not an interactive page. Every one of these produced a
 * green check and a silent no-op in this repo's history:
 *
 *   - the document is `visibilityState: "hidden"`, so the browser never
 *     delivers the pointer event and a coordinate click is swallowed;
 *   - the page does not hold focus, so the click merely activates the window;
 *   - the element is in the DOM at the right selector but a backdrop, modal or
 *     toast covers it, so `elementFromPoint` resolves to something else;
 *   - the input is disabled or read-only, so typing legitimately changes
 *     nothing;
 *   - the input cannot take focus, or accepts keystrokes that never reach its
 *     value;
 *   - the app never leaves its loading/disabled shell, so there is nothing to
 *     type into at all.
 *
 * The decision function `diagnoseInputReadiness()` is pure and takes a plain
 * snapshot, so every one of those states is unit-testable without a browser.
 * The in-page probe collects the snapshot; `runInputReadiness()` drives the
 * typing through the DevTools Protocol and folds both into one verdict.
 *
 * The probe asserts facts, not intentions: `elementFromPoint` is the same
 * hit-test the browser uses for a real click, and the value comparison is read
 * back after `Input.insertText` has run through the real event path.
 */

/** Where a fault can be injected, named by the state it produces. */
export const INPUT_FAULTS = ['overlay', 'disabled', 'readonly', 'unfocusable', 'nontyping', 'shell'];

/**
 * Turn a collected snapshot into problems, each naming the offending element.
 * Pure: no DOM, no CDP, so the tests can pin every failure mode.
 */
export function diagnoseInputReadiness(snapshot) {
  const problems = [];
  const {
    visibilityState,
    hasFocus,
    interactiveCount = 0,
    controls = [],
    targetSelector = null,
    mainText = '',
    typing = null,
  } = snapshot || {};

  if (visibilityState !== 'visible') {
    problems.push(
      `the page is "${visibilityState}", not "visible" — input cannot reach this page: ` +
        'the browser does not deliver pointer or keyboard events to a hidden document'
    );
  }
  if (hasFocus === false) {
    problems.push(
      'the page does not hold focus — a coordinate click is consumed activating the window, ' +
        'so input cannot reach this page'
    );
  }
  if (!interactiveCount && !snapshot.targetPinned) {
    const shown = String(mainText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    problems.push(
      'no interactive control is on screen' +
        (shown ? ` (main shows: "${shown}")` : '') +
        ' — the page is still a loading/disabled shell, so it cannot receive input'
    );
  }

  const target = controls.find((control) => control.selector === targetSelector) || null;
  if ((interactiveCount || snapshot.targetPinned) && !target) {
    problems.push('no control could be selected to receive input on this screen');
  }
  if (target) {
    if (!target.visible) {
      problems.push(`"${target.selector}" is in the DOM but not visible, so it cannot receive input`);
    }
    if (target.coveredBy) {
      problems.push(
        `"${target.selector}" is covered by "${target.coveredBy}" — a click at its centre lands on ` +
          'that element instead, so it cannot receive input'
      );
    }
    if (target.disabled) {
      problems.push(`"${target.selector}" is disabled, so it refuses input`);
    }
    if (target.readOnly) {
      problems.push(`"${target.selector}" is read-only, so typing cannot change it`);
    }
    if (target.focusable === false) {
      problems.push(`"${target.selector}" cannot take focus, so keystrokes never reach it`);
    }
    if (typing && typing.attempted && !typing.changed) {
      problems.push(
        `typing into "${target.selector}" did not change its value ` +
          `(still "${typing.before ?? ''}") — the input is not accepting text`
      );
    }
  }

  return { ok: problems.length === 0, problems, target: targetSelector };
}

/**
 * The in-page half: measure the page and every candidate control. Stringified
 * into `Runtime.evaluate`, so it must not close over anything in this module.
 */
export function inputReadinessProbe() {
  const MAX_CONTROLS = 40;

  function describe(el) {
    if (!el) return 'nothing';
    const tag = el.tagName ? el.tagName.toLowerCase() : String(el);
    let out = tag;
    if (el.id) out += `#${el.id}`;
    const name = el.getAttribute && el.getAttribute('name');
    const type = el.getAttribute && el.getAttribute('type');
    if (name) out += `[name="${name}"]`;
    else if (type) out += `[type="${type}"]`;
    const placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder) out += `[placeholder="${String(placeholder).slice(0, 30)}"]`;
    const cls = el.getAttribute && el.getAttribute('class');
    if (cls && !el.id) out += `.${String(cls).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`;
    return out;
  }

  function painted(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return false;
    }
    return true;
  }

  const main = document.querySelector('main') || document.body;
  const all = Array.from(
    main.querySelectorAll('input, textarea, select, button, [contenteditable="true"]')
  ).filter((el) => el.type !== 'hidden');

  const controls = [];
  const elements = [];
  for (const el of all.slice(0, MAX_CONTROLS)) {
    const rect = el.getBoundingClientRect();
    const visible = painted(el);
    let coveredBy = null;
    if (rect.width >= 1 && rect.height >= 1) {
      const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      if (top && top !== el && !el.contains(top)) coveredBy = describe(top);
    }
    const tag = el.tagName.toLowerCase();
    controls.push({
      selector: describe(el),
      tag,
      type: el.type || null,
      visible,
      coveredBy,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      readOnly: !!el.readOnly || el.getAttribute('contenteditable') === 'false',
      textEditable: tag === 'textarea' || el.isContentEditable || (tag === 'input' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file' && el.type !== 'submit' && el.type !== 'button' && el.type !== 'reset'),
      value: typeof el.value === 'string' ? el.value.slice(0, 60) : null,
    });
    elements.push(el);
  }

  const interactive = controls
    .map((control, index) => ({ control, index }))
    .filter(({ control }) => control.visible && !control.disabled && !control.readOnly);

  // Once a target has been chosen, it stays the target even when it becomes
  // disabled, read-only or unfocusable: re-picking a healthy neighbour would
  // report the wrong element and let a broken form pass on its second control.
  const pinned = main.querySelector('[data-input-readiness-target="1"]');
  const pinnedIndex = pinned ? elements.indexOf(pinned) : -1;
  const textFirst = interactive.filter(({ control }) => control.textEditable);
  const chosen = pinnedIndex >= 0 ? { control: controls[pinnedIndex], index: pinnedIndex } : textFirst[0] || interactive[0] || null;

  let targetSelector = null;
  let focusable = null;
  if (chosen) {
    targetSelector = chosen.control.selector;
    const el = elements[chosen.index];
    if (!el.hasAttribute('data-input-readiness-target')) {
      el.setAttribute('data-input-readiness-target', '1');
    }
    // Start from a known state: an earlier probe (or the app itself) may have
    // left this element focused, and "was already focused" is not proof that it
    // can take focus now.
    try {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    } catch {
      // A blur that refuses is harmless; the focus attempt below is the verdict.
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      // A throwing focus() is the same verdict as a focus that did not stick.
    }
    focusable =
      document.activeElement === el ||
      (!!document.activeElement && el.contains(document.activeElement));
    chosen.control.focusable = focusable;
  }

  return {
    url: location.href,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    readyState: document.readyState,
    mainText: (main.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    interactiveCount: interactive.length,
    targetSelector,
    targetPinned: pinnedIndex >= 0,
    targetUsable: !!(
      chosen &&
      chosen.control.visible &&
      !chosen.control.disabled &&
      !chosen.control.readOnly &&
      focusable
    ),
    textEditable: !!(chosen && chosen.control.textEditable),
    before: chosen ? (elements[chosen.index].value ?? '') : null,
    controls,
  };
}

/** JS applied after the page settles, to reproduce a state the check must reject. */
export function faultInjectionSource(fault, selector) {
  const pick = `(() => {
    const main = document.querySelector('main') || document.body;
    const pinned = main.querySelector('[data-input-readiness-target="1"]');
    if (pinned) return pinned;
    const all = Array.from(main.querySelectorAll('input, textarea, select, button, [contenteditable="true"]'))
      .filter((el) => el.type !== 'hidden');
    return all.find((el) => window.__describeControl(el) === ${JSON.stringify(selector)}) || all[0] || null;
  })()`;
  const describeHelper = `window.__describeControl = (el) => {
    const tag = el.tagName.toLowerCase();
    let out = tag;
    if (el.id) out += '#' + el.id;
    const name = el.getAttribute('name');
    const type = el.getAttribute('type');
    if (name) out += '[name="' + name + '"]';
    else if (type) out += '[type="' + type + '"]';
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) out += '[placeholder="' + String(placeholder).slice(0, 30) + '"]';
    const cls = el.getAttribute('class');
    if (cls && !el.id) out += '.' + String(cls).split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return out;
  };`;

  switch (fault) {
    case 'overlay':
      return `${describeHelper}
        (() => {
          const el = ${pick};
          const layer = document.createElement('div');
          layer.id = 'input-readiness-overlay';
          layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.02)';
          document.body.appendChild(layer);
          return !!el;
        })()`;
    case 'disabled':
      return `${describeHelper} (() => { const el = ${pick}; if (!el) return false; el.disabled = true; el.setAttribute('disabled', ''); return true; })()`;
    case 'readonly':
      return `${describeHelper} (() => { const el = ${pick}; if (!el) return false; if ('readOnly' in el) el.readOnly = true; else el.setAttribute('contenteditable', 'false'); return true; })()`;
    case 'unfocusable':
      return `${describeHelper} (() => {
        const el = ${pick};
        if (!el) return false;
        el.focus = () => {};
        el.setAttribute('tabindex', '-1');
        return true;
      })()`;
    case 'nontyping':
      return `${describeHelper} (() => {
        const el = ${pick};
        if (!el) return false;
        const frozen = el.value;
        Object.defineProperty(el, 'value', { configurable: true, get: () => frozen, set: () => {} });
        el.addEventListener('input', (event) => { el.__typed = true; void event; });
        return true;
      })()`;
    case 'shell':
      return `(() => {
        const main = document.querySelector('main') || document.body;
        main.innerHTML = '<div class="boot-shell" aria-busy="true"><span>Loading…</span></div>';
        return true;
      })()`;
    default:
      throw new Error(`unknown fault "${fault}" — expected one of ${INPUT_FAULTS.join(', ')}`);
  }
}

const PROBE_SOURCE = `(${inputReadinessProbe.toString()})();`;

/**
 * Collect the snapshot, type into the chosen control through the real event
 * path, and return the diagnosis for both halves.
 *
 * `cdp` is the minimal client the boot check already has (`send(method, params)`).
 */
export async function runInputReadiness(cdp, { faults = null, log = () => {} } = {}) {
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`input readiness probe threw: ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  };

  // A background tab reports `hasFocus() === false` and swallows the first
  // click, which is exactly the failure this probe exists to catch — but the
  // check owns this browser, so it must first activate its own tab the way a
  // user's click on the window would. Focus is then re-measured: if it still
  // has not arrived, the page genuinely cannot receive input and the verdict
  // says so.
  try {
    await cdp.send('Page.bringToFront');
  } catch {
    // Older targets may not implement it; the measurement below is the verdict.
  }
  const focusDeadline = Date.now() + 2000;
  while (Date.now() < focusDeadline) {
    if (await evaluate('document.hasFocus()')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const snapshot = await evaluate(PROBE_SOURCE);
  if (!snapshot) throw new Error('input readiness probe returned no snapshot');

  if (faults) {
    const applied = await evaluate(faultInjectionSource(faults, snapshot.targetSelector));
    if (!applied) throw new Error(`fault "${faults}" could not be injected: no control to target`);
    const faulted = await evaluate(PROBE_SOURCE);
    const typing = await typeInto(cdp, faulted);
    return { snapshot: faulted, ...diagnoseInputReadiness({ ...faulted, typing }) };
  }

  const typing = await typeInto(cdp, snapshot);
  if (typing.attempted && typing.changed) {
    // Leave the form as it was found: the typed marker is ours, not the app's.
    await evaluate(`(() => {
      const main = document.querySelector('main') || document.body;
      const all = Array.from(main.querySelectorAll('input, textarea, [contenteditable="true"]'));
      for (const el of all) {
        if (typeof el.value === 'string' && el.value.includes('__input_readiness__')) {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(snapshot.before ?? '')});
          else el.value = ${JSON.stringify(snapshot.before ?? '')};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return true;
    })()`);
  }
  return { snapshot, ...diagnoseInputReadiness({ ...snapshot, typing }) };
}

/** Type through `Input.insertText` and read the value back. */
async function typeInto(cdp, snapshot) {
  // Only a usable target is typed into: a disabled, read-only, covered or
  // unfocusable one already has its own precise problem, and a typing failure
  // on top would just restate it.
  if (!snapshot?.targetSelector || !snapshot.textEditable || !snapshot.targetUsable) {
    return { attempted: false, changed: false, before: snapshot?.before ?? null };
  }
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(`typing probe threw: ${result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const before = snapshot.before ?? '';
  const marker = `__input_readiness__${Date.now()}`;
  await cdp.send('Input.insertText', { text: marker });
  const after = await evaluate(`(() => {
    const main = document.querySelector('main') || document.body;
    const all = Array.from(main.querySelectorAll('input, textarea, [contenteditable="true"]'));
    const el = all.find((node) => (typeof node.value === 'string' ? node.value : node.textContent || '').includes('__input_readiness__'));
    if (!el) return null;
    return typeof el.value === 'string' ? el.value : (el.textContent || '');
  })()`);
  return { attempted: true, changed: typeof after === 'string' && after !== before, before, after };
}

/** One readable line for the gate's success output. */
export function describeReadiness(snapshot, verdict) {
  if (!verdict.ok) return null;
  const control = snapshot.controls.find((entry) => entry.selector === verdict.target);
  const typed = control && control.textEditable ? 'typed into it' : 'focused it (not a text field)';
  return (
    `✔ Input readiness — page visible and focused; ${snapshot.interactiveCount} interactive control(s) in <main>; ` +
    `${typed} "${verdict.target}" and the value ${control && control.textEditable ? 'changed' : 'was retained'}.`
  );
}
