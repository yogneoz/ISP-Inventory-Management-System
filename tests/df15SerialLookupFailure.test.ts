/**
 * DF-15 — a failed serial lookup is not "not in the register".
 *
 * `DeviceSerialInput` mapped every rejected lookup to `not-found`, and both
 * exchange dialogs pre-mapped the rejection to `null` (`.catch(() => null)`),
 * so a 500/503/dropped request read exactly like the register's definitive
 * "no such unit": "Not in the serial register for this branch", with no Retry.
 * The operator re-scans a valid serial, or escalates for the wrong reason.
 *
 * PROVES:
 *   1. PURE — only a 404 counts as "not found"; 500/503/403 and a rejection
 *      with no status do not.
 *   2. RENDER — a rejected lookup shows the amber "Could not check the
 *      register" state and a Retry that re-issues the lookup.
 *   3. RENDER — a real 404 still says "Not in the serial register for this
 *      branch" and offers no Retry.
 *   4. RENDER — a resolved row still fills PON/MAC (and the register's
 *      canonical MAC form) through onChange.
 *   5. SOURCE — neither exchange dialog swallows the rejection any more; its
 *      submit path stops with the retry copy on a non-404 instead of inventing
 *      a refusal (and never reports that guess to the audit trail).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { DeviceSerialInput } from '../client/src/components/common/DeviceSerialInput';
import type { DeviceSerialValue } from '../client/src/components/common/DeviceSerialInput';
import {
  apiErrorStatus,
  isSerialLookupNotFound,
  SERIAL_LOOKUP_FAILED_MESSAGE,
} from '../client/src/utils/serialRefusal';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

const refused = (status?: number) =>
  Object.assign(new Error(status ? `HTTP ${status}` : 'network dropped'), status ? { status } : {});

/** Resolve the field the way a scanner does: Enter, not the 400 ms pause. */
async function scan(container: HTMLElement, serial: string): Promise<HTMLInputElement> {
  const input = container.querySelector('input') as HTMLInputElement | null;
  assert.ok(input, 'the field must render an input');
  input!.value = serial;
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return input!;
}

const retryButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry') ?? null;

describe('DF-15 — only a 404 means "not found"', () => {
  test('the status carried by the rejection decides', () => {
    assert.equal(apiErrorStatus(refused(404)), 404);
    assert.equal(apiErrorStatus(refused(503)), 503);
    assert.equal(apiErrorStatus(refused()), 0, 'no status is a transport failure, not a 404');
    assert.equal(apiErrorStatus(null), 0);
    assert.equal(apiErrorStatus(new TypeError('Failed to fetch')), 0);

    assert.equal(isSerialLookupNotFound(refused(404)), true);
    for (const error of [refused(500), refused(503), refused(403), refused(), null, undefined]) {
      assert.equal(isSerialLookupNotFound(error), false, 'only 404 may read as "not found"');
    }
  });
});

describe('DF-15 — the serial field distinguishes the three outcomes', () => {
  test('a failed lookup shows the retryable state and Retry re-issues the lookup', async () => {
    const lookups: string[] = [];
    const changes: DeviceSerialValue[] = [];
    const tree = mountTree(
      h(DeviceSerialInput, {
        value: { deviceSerial: 'SN-1' },
        onChange: (next: DeviceSerialValue) => changes.push(next),
        lookup: async (serial: string) => {
          lookups.push(serial);
          throw refused(503);
        },
      })
    );

    await scan(tree.container, 'SN-1');
    assert.ok(lookups.length >= 1, 'Enter must ask the register');
    assert.match(tree.container.textContent || '', /Could not check the register/);
    assert.doesNotMatch(
      tree.container.textContent || '',
      /Not in the serial register/,
      'a failed read must never be rendered as a definitive "not in the register"'
    );

    const retry = retryButton(tree.container);
    assert.ok(retry, 'the failure state must offer Retry');

    const before = lookups.length;
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(lookups.length, before + 1, 'Retry must re-run the lookup');
    assert.deepEqual(changes, [], 'a failed lookup must not fabricate PON/MAC');

    tree.unmount();
  });

  test('a real 404 still reads as "not in the register", with no Retry', async () => {
    const tree = mountTree(
      h(DeviceSerialInput, {
        value: { deviceSerial: 'SN-404' },
        onChange: () => {},
        lookup: async () => {
          throw refused(404);
        },
      })
    );

    await scan(tree.container, 'SN-404');
    assert.match(tree.container.textContent || '', /Not in the serial register for this branch/);
    assert.equal(retryButton(tree.container), null, 'a definitive 404 has nothing to retry');

    tree.unmount();
  });

  test('a resolved row still reports its real status and branch', async () => {
    const assigned = mountTree(
      h(DeviceSerialInput, {
        value: { deviceSerial: 'SN-4' },
        onChange: () => {},
        branchId: 'WH001',
        lookup: async () => ({ deviceSerial: 'SN-4', status: 'CUSTOMER_ASSIGNED', branchId: 'WH001' }),
      })
    );
    await scan(assigned.container, 'SN-4');
    assert.match(assigned.container.textContent || '', /CUSTOMER ASSIGNED — not IN_STOCK/);
    assigned.unmount();

    const elsewhere = mountTree(
      h(DeviceSerialInput, {
        value: { deviceSerial: 'SN-5' },
        onChange: () => {},
        branchId: 'WH001',
        lookup: async () => ({ deviceSerial: 'SN-5', status: 'IN_STOCK', branchId: 'BRH02' }),
      })
    );
    await scan(elsewhere.container, 'SN-5');
    assert.match(elsewhere.container.textContent || '', /Held at branch BRH02/);
    elsewhere.unmount();
  });

  test('a resolved row still fills PON and MAC in the register’s canonical form', async () => {
    const changes: DeviceSerialValue[] = [];
    const tree = mountTree(
      h(DeviceSerialInput, {
        value: { deviceSerial: 'SN-3' },
        onChange: (next: DeviceSerialValue) => changes.push(next),
        lookup: async () => ({
          deviceSerial: 'SN-3',
          ponSerial: 'PON-3',
          macAddress: 'a4c3f0b1d2e3',
          status: 'IN_STOCK',
          branchId: 'WH001',
        }),
      })
    );

    await scan(tree.container, 'SN-3');
    assert.deepEqual(changes.at(-1), {
      deviceSerial: 'SN-3',
      ponSerial: 'PON-3',
      macAddress: 'A4:C3:F0:B1:D2:E3',
    });
    assert.match(tree.container.textContent || '', /PON PON-3/);
    assert.match(tree.container.textContent || '', /MAC A4:C3:F0:B1:D2:E3/);

    tree.unmount();
  });
});

describe('DF-15 — the exchange dialogs stop swallowing the rejection', () => {
  const DIALOGS = [
    'client/src/features/inventory/stockops/DeviceExchangePanel.tsx',
    'client/src/features/sales/CustomersManagement.tsx',
  ] as const;

  for (const file of DIALOGS) {
    test(`${file}: inline lookup propagates, submit fails closed with retry copy`, () => {
      const source = read(file);

      assert.ok(
        source.includes('isSerialLookupNotFound'),
        'the dialog must tell a real 404 from a failure to consult the register'
      );
      assert.match(
        source,
        /if \(!isSerialLookupNotFound\(err\)\) \{\s*alertDialog\(SERIAL_LOOKUP_FAILED_MESSAGE\);\s*return;/,
        'a non-404 lookup failure must stop the submission with the retry copy, not invent a refusal'
      );
      assert.ok(
        source.includes('SERIAL_LOOKUP_FAILED_MESSAGE'),
        'the failure copy must be the shared one'
      );
      assert.doesNotMatch(
        source,
        /lookupExchangeSerial\([^)]*\)\.catch\(\(\) => null\)/,
        'the inline lookup must not pre-map a rejection to "no row" — the field needs the error'
      );
      assert.doesNotMatch(
        source,
        /catch \{\s*(registerRow|replacementRow) = null;\s*\}/,
        'the submit lookup must not swallow every rejection as "no row"'
      );
      assert.ok(
        source.includes('describeReplacementRefusal({'),
        'a real 404 still goes through the shared refusal wording'
      );
      assert.ok(
        source.includes('reportExchangeRefusal({'),
        'a real 404 still reports the refused attempt to the audit trail'
      );
    });
  }

  test('the shared failure copy says the register could not be checked', () => {
    assert.match(SERIAL_LOOKUP_FAILED_MESSAGE, /Could not check the serial register/);
    assert.match(SERIAL_LOOKUP_FAILED_MESSAGE, /Try again/);
  });
});
