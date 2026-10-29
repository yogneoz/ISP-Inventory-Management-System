/**
 * WTY-4 asset modal — the supplier expiry is prefilled but belongs to the
 * operator.
 *
 * The asset register is where an unlinked or purchased-direct asset first gets
 * its supplier warranty. The field must follow the acquisition date while it is
 * untouched, then stop following it the moment the operator types the contract
 * date. A regression here would silently rewrite a negotiated expiry every time
 * someone corrects the acquisition date.
 */
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree } from './harness/mount';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { FixedAssetRegister } from '../client/src/features/finance/FixedAssetRegister';
import { api } from '../client/src/services/api';
import { todayAd } from './fixtures/referenceData';
import { warrantyEndFor } from '../client/src/utils/warrantyCapture';

const user = {
  id: 'u-w4',
  email: 'w4@example.com',
  name: 'W4 Admin',
  role: 'SUPER_ADMIN',
  branchId: 'b1',
} as any;

const branches = [{ id: 'b1', code: 'B1', name: 'Main Branch' }] as any[];

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function setDateInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('fixed-asset supplier warranty field', () => {
  const real = {
    page: api.getFixedAssetPage,
    overview: api.getFixedAssetOverview,
  };

  beforeEach(() => {
    api.getFixedAssetPage = async () => ({ data: [], totalItems: 0, page: 1, pageSize: 15 }) as any;
    api.getFixedAssetOverview = async () =>
      ({ totals: { acquisitionCost: 0, accumulatedDepreciation: 0, netBookValue: 0 } }) as any;
  });

  afterEach(() => {
    api.getFixedAssetPage = real.page;
    api.getFixedAssetOverview = real.overview;
  });

  test('a new asset prefills 12 months and an untouched expiry follows the acquisition date', async () => {
    const tree = mountTree(
      createElement(
        DialogProvider as any,
        null,
        createElement(FixedAssetRegister, {
          branches,
          selectedBranchId: 'b1',
          dateMode: 'AD',
          currentUser: user,
          onCreateAsset: async () => {},
          onUpdateAssetStatus: async () => {},
        } as any)
      )
    );
    try {
      await settle();
      const open = [...tree.container.querySelectorAll('button')].find((button) =>
        /Register Fixed Asset/.test(button.textContent || '')
      ) as HTMLButtonElement | undefined;
      assert.ok(open, 'the register must offer the create action');
      act(() => open!.click());
      await settle();

      const warranty = tree.container.querySelector('#asset-supplier-warranty-expiry') as HTMLInputElement | null;
      assert.ok(warranty, 'the modal must capture the supplier expiry');
      assert.equal(warranty!.value, warrantyEndFor(todayAd(), 12), 'a new asset prefills 12 months');

      const dates = [...tree.container.querySelectorAll('input[type="date"]')] as HTMLInputElement[];
      const acquisition = dates.find((input) => input.id !== 'asset-supplier-warranty-expiry');
      assert.ok(acquisition, 'the acquisition date field must exist');

      setDateInput(acquisition!, '2027-01-31');
      await settle();
      assert.equal(warranty!.value, '2028-01-31', 'an untouched expiry follows the acquisition date');

      // The operator types the negotiated contract date; a later acquisition
      // correction must not rewrite it.
      setDateInput(warranty!, '2035-05-05');
      await settle();
      setDateInput(acquisition!, '2027-02-01');
      await settle();
      assert.equal(warranty!.value, '2035-05-05', 'a typed expiry is never clobbered');
    } finally {
      tree.unmount();
    }
  });
});
