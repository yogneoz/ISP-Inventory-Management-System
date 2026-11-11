/**
 * Warranty claims tab — mounted UI proof.
 *
 * The API suite owns the lifecycle and stock effects; this test proves the
 * shared Claims / RMA tab is actually reachable from the warranty register,
 * asks for the correct coverage side, renders SLA, and opens the timeline.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement as h } from 'react';
import { mountTree } from './harness/mount';
import { WarrantyRegister } from '../client/src/features/inventory/warranty/WarrantyRegister';
import { api } from '../client/src/services/api';

const user = {
  id: 'u-claims',
  email: 'claims@example.com',
  name: 'Claims Admin',
  role: 'SUPER_ADMIN',
  branchId: 'ALL',
  allowedBranchIds: ['ALL'],
} as any;

const claim = {
  id: 'wcl-ui-1',
  claimNo: 'WC-2026-0001',
  branchId: 'BR-A',
  branchName: 'Main Branch',
  coverageType: 'VENDOR',
  customerName: 'Customer UI',
  serialNumber: 'SER-UI-1',
  productName: 'UI Router',
  reportedDateAD: '2026-11-02',
  symptom: 'No link light after a power cycle',
  status: 'REPORTED',
  expectedCredit: 500,
  receivedCredit: 0,
  slaDays: 9,
  open: true,
  createdAt: '2026-11-02T00:00:00.000Z',
} as any;

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find(
    (candidate) => (candidate.textContent || '').trim() === text
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `expected a "${text}" button`);
  return button;
}

describe('warranty claims tab', () => {
  const originals = {
    vendor: api.fetchVendorWarranties,
    seller: api.fetchSellerWarranties,
    claims: api.fetchWarrantyClaims,
    claim: api.fetchWarrantyClaim,
    recovery: api.fetchWarrantyRecovery,
  };
  let seenQuery: any = null;
  let seenRecoveryQuery: any = null;

  beforeEach(() => {
    const empty = async () => ({
      data: [],
      totalItems: 0,
      counts: { total: 0, valid: 0, expiring: 0, expired: 0 },
    });
    api.fetchVendorWarranties = empty as any;
    api.fetchSellerWarranties = empty as any;
    api.fetchWarrantyClaims = (async (query: any) => {
      seenQuery = query;
      return {
        data: [claim],
        page: 1,
        pageSize: 15,
        totalItems: 1,
        counts: { total: 1, open: 1, reported: 1, withVendor: 0, resolved: 0, closed: 0, rejected: 0 },
      };
    }) as any;
    api.fetchWarrantyClaim = (async () => ({
      ...claim,
      events: [
        {
          id: 'wce-ui-1',
          claimId: claim.id,
          fromStatus: null,
          status: 'REPORTED',
          note: 'No link light after a power cycle',
          actor: 'Claims Admin',
          createdAt: '2026-11-02T00:00:00.000Z',
        },
      ],
    })) as any;
    api.fetchWarrantyRecovery = (async (query: any) => {
      seenRecoveryQuery = query;
      return {
        data: [{
          ...claim,
          expectedCredit: 500,
          receivedCredit: 200,
          postedCredit: 200,
          shortfall: 300,
          rmaAgeDays: 9,
          agingBucket: '8-14',
          creditState: 'PARTIAL',
        }],
        page: 1,
        pageSize: 15,
        totalItems: 1,
        summary: {
          claims: 1, openClaims: 1, outstandingRmas: 1,
          expectedCredit: 500, receivedCredit: 200, postedCredit: 200,
          shortfall: 300, shortfallClaims: 1, postingExceptions: 0,
          reconciled: false,
        },
        aging: [
          { bucket: '0-7', label: '0–7 days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
          { bucket: '8-14', label: '8–14 days', claims: 1, expectedCredit: 500, receivedCredit: 200, shortfall: 300 },
          { bucket: '15-30', label: '15–30 days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
          { bucket: '31+', label: '31+ days', claims: 0, expectedCredit: 0, receivedCredit: 0, shortfall: 0 },
        ],
        vendors: [{ vendorName: 'Acme Vendor', claims: 1, expectedCredit: 500, receivedCredit: 200, postedCredit: 200, shortfall: 300 }],
      };
    }) as any;
  });

  afterEach(() => {
    api.fetchVendorWarranties = originals.vendor;
    api.fetchSellerWarranties = originals.seller;
    api.fetchWarrantyClaims = originals.claims;
    api.fetchWarrantyClaim = originals.claim;
    api.fetchWarrantyRecovery = originals.recovery;
    seenQuery = null;
    seenRecoveryQuery = null;
  });

  test('opens the vendor-side claims register with SLA, detail and transitions', async () => {
    const tree = mountTree(
      h(WarrantyRegister, {
        coverageType: 'VENDOR',
        selectedBranchId: 'ALL',
        dateMode: 'AD',
        currentUser: user,
      } as any)
    );

    try {
      await settle();
      act(() => buttonByText(tree.container, 'Claims / RMA').click());
      await settle();

      assert.equal(seenQuery?.coverageType, 'VENDOR');
      assert.equal(seenQuery?.branchId, 'ALL');
      assert.match(tree.container.textContent || '', /Open claims/);
      assert.match(tree.container.textContent || '', /WC-2026-0001/);
      assert.match(tree.container.textContent || '', /9d/);

      const open = tree.container.querySelector(
        '[aria-label="Open claim WC-2026-0001"]'
      ) as HTMLButtonElement | null;
      assert.ok(open, 'the claim row must expose its detail control');
      act(() => open!.click());
      await settle();

      const text = tree.container.textContent || '';
      assert.match(text, /SLA 9 days/);
      assert.match(text, /No link light after a power cycle/);
      assert.ok(buttonByText(tree.container, 'Approved'));
      assert.ok(buttonByText(tree.container, 'Rejected'));
    } finally {
      tree.unmount();
    }
  });

  test('opens the recovery tab with aging, vendor credit and shortfall', async () => {
    const tree = mountTree(
      h(WarrantyRegister, {
        coverageType: 'VENDOR',
        selectedBranchId: 'ALL',
        dateMode: 'AD',
        currentUser: user,
      } as any)
    );

    try {
      await settle();
      act(() => buttonByText(tree.container, 'Recovery').click());
      await settle();

      assert.equal(seenRecoveryQuery?.coverageType, 'VENDOR');
      assert.equal(seenRecoveryQuery?.branchId, 'ALL');
      const text = tree.container.textContent || '';
      assert.match(text, /Outstanding RMA aging/);
      assert.match(text, /Vendor recovery/);
      assert.match(text, /Recovery queue/);
      assert.match(text, /WC-2026-0001/);
      assert.match(text, /Partial credit/);
    } finally {
      tree.unmount();
    }
  });
});
