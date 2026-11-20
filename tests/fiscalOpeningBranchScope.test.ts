/**
 * Fiscal opening registers — the client offers and submits only branches the
 * signed-in account is scoped to.
 *
 * The server's branch registry refuses records outside the actor's branches
 * (AUTHZ-1/12/13 in tests/authorization.audit.test.ts), but both fiscal screens
 * used to build their branch pickers from every branch in bootstrap. A branch
 * Inventory Manager was therefore offered branches whose writes the server
 * would reject — and an older payload/cache could even put another branch's row
 * on screen and into a save.
 *
 * PROVES:
 *   1. `getScopedBranches` mirrors the server: Super Admin / Head Office Admin /
 *      `branchId: 'ALL'` are global, everyone else is branchId + allowedBranchIds
 *      (an INVENTORY_MANAGER with one branch is NOT global).
 *   2. OpeningStockManager's filter and add-row pickers list only the account's
 *      branches, its table hides foreign rows, and Save submits only scoped rows
 *      even when the payload contains one from another branch.
 *   3. VendorOpeningBalances behaves the same for its filter and Save.
 *   4. An HQ-wide account still sees everything — the scoping is not over-blocking.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, createElement } from 'react';
import { mountTree, inAct } from './harness/mount';
import { OpeningStockManager } from '../client/src/features/finance/OpeningStockManager';
import { VendorOpeningBalances } from '../client/src/features/finance/VendorOpeningBalances';
import { api } from '../client/src/services/api';
import { getScopedBranches } from '../client/src/utils/permissions';
import { BootstrapDataProvider } from '../client/src/contexts/AppProviders';

const branches = [
  { id: 'br-a', code: 'BRA', name: 'Branch A', location: 'L' },
  { id: 'br-b', code: 'BRB', name: 'Branch B', location: 'L' },
] as any[];

const fiscalYears = [
  {
    id: 'fy-1',
    code: '2083/84',
    startDateAD: '2026-07-16',
    endDateAD: '2027-07-15',
    startDateBS: '2083-04-01',
    endDateBS: '2084-03-31',
    isCurrent: true,
    isClosed: false,
  },
] as any[];

const products = [{ id: 'p1', name: 'Router', sku: 'RTR-1' }] as any[];
const suppliers = [
  { id: 'sup-1', name: 'Supplier One', supplierCode: 'SUP-1', status: 'ACTIVE' },
  { id: 'sup-2', name: 'Supplier Two', supplierCode: 'SUP-2', status: 'ACTIVE' },
] as any[];

const branchUser = (over: Record<string, unknown> = {}) => ({
  id: 'u-branch',
  email: 'branch@example.com',
  name: 'Branch Manager',
  role: 'INVENTORY_MANAGER',
  branchId: 'br-a',
  allowedBranchIds: ['br-a'],
  ...over,
} as any);

const hqUser = branchUser({ id: 'u-hq', email: 'hq@example.com', branchId: 'ALL', allowedBranchIds: [] });
const superUser = branchUser({ id: 'u-super', email: 'super@example.com', role: 'SUPER_ADMIN' });
const accountantUser = branchUser({ id: 'u-accountant', email: 'accountant@example.com', role: 'ACCOUNTANT' });

const openingRow = (id: string, branchId: string, branchName: string, quantityOnHand: number) => ({
  id,
  productId: 'p1',
  productName: 'Router',
  productSku: 'RTR-1',
  branchId,
  branchName,
  quantityOnHand,
  damagedQty: 0,
  unitCost: 10,
  sourceType: 'FISCAL_CLOSE',
  sourceReference: null,
  postedAt: null,
  postedBy: null,
  liveQty: quantityOnHand,
  liveDamagedQty: 0,
});

const vendorRow = (id: string, branchId: string, branchName: string, openingBalance: number) => ({
  id,
  supplierId: 'sup-1',
  supplierName: 'Supplier One',
  supplierCode: 'SUP-1',
  branchId,
  branchName,
  openingBalance,
  sourceType: 'FISCAL_CLOSE',
  sourceReference: null,
  postedAt: null,
  postedBy: null,
});

const openingPayload = {
  fiscalYear: fiscalYears[0],
  rows: [openingRow('r-a', 'br-a', 'Branch A', 5), openingRow('r-b', 'br-b', 'Branch B', 7)],
  stats: { totalRows: 2, manualAdjustments: 0, zeroQtyRows: 0, totalUnits: 12, totalValue: 120 },
};

const vendorPayload = {
  fiscalYear: fiscalYears[0],
  rows: [vendorRow('v-a', 'br-a', 'Branch A', 100), vendorRow('v-b', 'br-b', 'Branch B', 200)],
  stats: { totalRows: 2, manualAdjustments: 0, zeroRows: 0, totalDebitOpening: 300, totalCreditOpening: 0 },
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** React's controlled-input change, via the native setter the tracker watches. */
function setTextInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function setNumberInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
  inAct(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function findButton(container: HTMLElement, pattern: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    pattern.test((button.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
}

/** Option values across every select currently rendered (filter + add form). */
function optionValues(container: HTMLElement): string[] {
  return [...container.querySelectorAll('option')].map((option) => option.getAttribute('value') || '');
}

describe('fiscal opening registers — branch scope', () => {
  const real = {
    getOpening: api.getFiscalYearOpeningStock,
    adjustOpening: api.adjustFiscalYearOpeningStock,
    getVendor: api.getVendorOpeningBalances,
    adjustVendor: api.adjustVendorOpeningBalances,
    getAccounts: api.getAccountingAccounts,
    postOpening: api.postOpeningBalances,
    getPostingDefaults: api.getPostingDefaults,
    searchCustomers: api.searchCustomers,
  };

  afterEach(() => {
    api.getFiscalYearOpeningStock = real.getOpening;
    api.adjustFiscalYearOpeningStock = real.adjustOpening;
    api.getVendorOpeningBalances = real.getVendor;
    api.adjustVendorOpeningBalances = real.adjustVendor;
    api.getAccountingAccounts = real.getAccounts;
    api.postOpeningBalances = real.postOpening;
    api.getPostingDefaults = real.getPostingDefaults;
    api.searchCustomers = real.searchCustomers;
  });

  test('getScopedBranches mirrors the server: only ALL/HQ roles are global', () => {
    assert.deepEqual(getScopedBranches(branchUser(), branches).map((b) => b.id), ['br-a']);
    assert.deepEqual(
      getScopedBranches(branchUser({ allowedBranchIds: ['br-a', 'br-b'] }), branches).map((b) => b.id),
      ['br-a', 'br-b']
    );
    assert.deepEqual(getScopedBranches(hqUser, branches).map((b) => b.id), ['br-a', 'br-b']);
    assert.deepEqual(
      getScopedBranches(branchUser({ role: 'HEAD_OFFICE_ADMIN', branchId: 'br-a', allowedBranchIds: [] }), branches).map((b) => b.id),
      ['br-a', 'br-b']
    );
    assert.deepEqual(getScopedBranches(null, branches), []);
  });

  test('OpeningStockManager offers only scoped branches and submits only scoped rows', async () => {
    const submitted: any[] = [];
    api.getFiscalYearOpeningStock = async () => openingPayload as any;
    api.adjustFiscalYearOpeningStock = async (_id: string, rows: any[]) => {
      submitted.push(...rows);
      return { applied: rows.length, created: 0, message: 'saved' };
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, products } }, createElement(OpeningStockManager, {
        currentUser: branchUser(),
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a'), 'the account’s own branch is offered');
      assert.ok(!values.includes('br-b'), 'another branch must not be offered in the filter');
      assert.ok(!(tree.container.textContent || '').includes('Branch B'), 'another branch’s row must not render');

      const addRow = findButton(tree.container, /^Add Row$/);
      assert.ok(addRow, 'an editable register exposes Add Row');
      inAct(() => addRow!.click());
      assert.ok(
        !optionValues(tree.container).includes('br-b'),
        'the add-row branch picker must not offer another branch either'
      );

      const rowInputs = [...tree.container.querySelectorAll('tbody input[type="number"]')] as HTMLInputElement[];
      assert.equal(rowInputs.length, 3, 'the own-branch row renders qty, damaged and cost inputs');
      setNumberInput(rowInputs[0], '9');
      setNumberInput(rowInputs[1], '0');
      setNumberInput(rowInputs[2], '10');

      const save = findButton(tree.container, /^Save \d+ Adjustment/);
      assert.ok(save, 'a changed scoped row exposes Save');
      inAct(() => save!.click());
      await settle();

      assert.equal(submitted.length, 1, 'only the changed scoped row is submitted');
      assert.deepEqual(
        submitted.map((row) => ({ branchId: row.branchId, quantityOnHand: row.quantityOnHand })),
        [{ branchId: 'br-a', quantityOnHand: 9 }],
        'the payload never carries the foreign-branch row that was in the response'
      );
    } finally {
      tree.unmount();
    }
  });

  test('OpeningStockManager offers every branch to an HQ-wide account', async () => {
    api.getFiscalYearOpeningStock = async () => openingPayload as any;

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, products } }, createElement(OpeningStockManager, {
        currentUser: hqUser,
        fiscalYears,
      } as any))
    );
    try {
      await settle();
      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a') && values.includes('br-b'), 'HQ offers both branches');
      assert.match(tree.container.textContent || '', /Branch B/, 'HQ sees both branches’ rows');
    } finally {
      tree.unmount();
    }
  });

  test('VendorOpeningBalances offers only scoped branches and posts scoped add/remove rows', async () => {
    const submissions: Array<{ rows: any[]; offset?: string; removed: any[] }> = [];
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.getAccountingAccounts = async () =>
      [
        {
          id: 'acct-equity',
          code: '3000',
          name: 'Retained Earnings',
          isActive: true,
          isControl: false,
          accountType: 'EQUITY',
          postingRole: 'RETAINED_EARNINGS',
        },
      ] as any;
    api.getPostingDefaults = async () =>
      ({
        defaults: {
          AP_CONTROL: {
            accountId: 'acct-ap',
            accountCode: '2100',
            accountName: 'Accounts Payable',
            accountType: 'LIABILITY',
            isControl: true,
          },
        },
      }) as any;
    api.adjustVendorOpeningBalances = async (
      _id: string,
      rows: any[],
      offset?: string,
      removed: any[] = []
    ) => {
      submissions.push({ rows, offset, removed });
      return {
        applied: rows.length + removed.length,
        created: 0,
        message: `${rows.length + removed.length} vendor opening-balance row(s) saved for fiscal year 2083/84.`,
        journals: [{ branchId: 'br-a', journalNo: 'JV-VENDOR-1', periodKey: '2026-07', totalValue: 200 }],
      } as any;
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, suppliers } }, createElement(VendorOpeningBalances, {
        currentUser: branchUser(),
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      const values = optionValues(tree.container);
      assert.ok(values.includes('br-a'), 'the account’s own branch is offered');
      assert.ok(!values.includes('br-b'), 'another branch must not be offered');
      assert.ok(!(tree.container.textContent || '').includes('Branch B'), 'another branch’s row must not render');

      const balanceInput = tree.container.querySelector('tbody input[type="number"]') as HTMLInputElement | null;
      assert.ok(balanceInput, 'the own-branch row renders an editable balance');
      setNumberInput(balanceInput!, '150');

      // Add a second supplier in the same scoped branch.
      const supplierSelect = tree.container.querySelector(
        'select[aria-label="Vendor opening supplier"]'
      ) as HTMLSelectElement;
      const addBranchSelect = tree.container.querySelector(
        'select[aria-label="Vendor opening add branch"]'
      ) as HTMLSelectElement;
      const addAmount = tree.container.querySelector(
        'input[aria-label="Vendor opening new amount"]'
      ) as HTMLInputElement;
      setSelectValue(supplierSelect, 'sup-2');
      setSelectValue(addBranchSelect, 'br-a');
      setNumberInput(addAmount, '50');
      inAct(() => findButton(tree.container, /^Add supplier$/)!.click());

      const save = findButton(tree.container, /^Save & Post 2/);
      assert.ok(save, 'changed and added rows expose Save & Post');
      inAct(() => save!.click());
      await settle();

      assert.equal(submissions.length, 1);
      assert.deepEqual(
        submissions[0].rows.map((row) => ({
          supplierId: row.supplierId,
          branchId: row.branchId,
          openingBalance: row.openingBalance,
        })),
        [
          { supplierId: 'sup-1', branchId: 'br-a', openingBalance: 150 },
          { supplierId: 'sup-2', branchId: 'br-a', openingBalance: 50 },
        ],
        'the payload carries the changed row and the new scoped row, never the foreign row'
      );
      assert.equal(submissions[0].offset, 'acct-equity', 'the selected equity offset is submitted');
      assert.deepEqual(submissions[0].removed, []);
      assert.match(
        tree.container.textContent || '',
        /Posted opening journal JV-VENDOR-1 in 2026-07/,
        'the success message names the posted journal'
      );

      // Remove the existing supplier row and save that removal.
      const remove = tree.container.querySelector(
        'button[aria-label="Remove vendor opening Supplier One"]'
      ) as HTMLButtonElement;
      assert.ok(remove, 'each register row exposes a remove action');
      inAct(() => remove.click());
      const removeSave = findButton(tree.container, /^Save & Post 1/);
      assert.ok(removeSave, 'a staged removal exposes Save & Post');
      inAct(() => removeSave!.click());
      await settle();

      assert.equal(submissions.length, 2);
      assert.deepEqual(submissions[1].rows, [], 'a removal-only save carries no upsert rows');
      assert.deepEqual(submissions[1].removed, [{ supplierId: 'sup-1', branchId: 'br-a' }]);
    } finally {
      tree.unmount();
    }
  });

  test('VendorOpeningBalances renders a closed year read-only with no save action', async () => {
    api.getVendorOpeningBalances = async () =>
      ({ ...vendorPayload, fiscalYear: { ...fiscalYears[0], isClosed: true } }) as any;
    api.getAccountingAccounts = async () =>
      [
        {
          id: 'acct-equity',
          code: '3000',
          name: 'Retained Earnings',
          isActive: true,
          isControl: false,
          accountType: 'EQUITY',
          postingRole: 'RETAINED_EARNINGS',
        },
      ] as any;
    api.getPostingDefaults = async () =>
      ({
        defaults: {
          AP_CONTROL: {
            accountId: 'acct-ap',
            accountCode: '2100',
            accountName: 'Accounts Payable',
            accountType: 'LIABILITY',
            isControl: true,
          },
        },
      }) as any;

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, suppliers } }, createElement(VendorOpeningBalances, {
        currentUser: branchUser(),
        fiscalYears,
      } as any))
    );
    try {
      await settle();
      const text = tree.container.textContent || '';
      assert.match(text, /Period locked/);
      assert.match(text, /read-only/);
      const balanceInput = tree.container.querySelector('tbody input[type="number"]') as HTMLInputElement;
      assert.equal(balanceInput.disabled, true, 'a closed year cannot edit an opening balance');
      const addAmount = tree.container.querySelector(
        'input[aria-label="Vendor opening new amount"]'
      ) as HTMLInputElement;
      assert.equal(addAmount.disabled, true, 'a closed year cannot stage a new supplier row');
      assert.equal(findButton(tree.container, /^Save & Post/), undefined, 'a closed year exposes no save action');
    } finally {
      tree.unmount();
    }
  });

  test('Customers tab posts only branch-scoped customer lines through the opening route', async () => {
    const posted: any[] = [];
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.getAccountingAccounts = async () =>
      [
        { id: 'acct-cash', code: '1000', name: 'Cash', isActive: true, isControl: false, accountType: 'ASSET' },
        {
          id: 'acct-equity',
          code: '3000',
          name: 'Retained Earnings',
          isActive: true,
          isControl: false,
          accountType: 'EQUITY',
          postingRole: 'RETAINED_EARNINGS',
        },
      ] as any;
    api.getPostingDefaults = async () =>
      ({
        defaults: {
          AR_CONTROL: {
            accountId: 'acct-ar',
            accountCode: '1100',
            accountName: 'Accounts Receivable',
            accountType: 'ASSET',
            statementGroup: 'CURRENT_ASSET',
            isControl: true,
            subledgerType: 'CUSTOMER',
          },
        },
      }) as any;
    api.searchCustomers = async () =>
      [
        {
          id: 'cust-record-1',
          customerId: 'CUST-1',
          customerName: 'Acme Customer',
          username: 'acme',
          contactNumber: '9800000001',
          branchId: 'br-a',
          address: 'Kathmandu',
          status: 'ACTIVE',
        },
      ] as any;
    api.postOpeningBalances = async (input) => {
      posted.push(input);
      return { journalNo: 'JV-CUST-1', periodKey: '2026-07' } as any;
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(VendorOpeningBalances, {
        currentUser: accountantUser,
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      const tab = findButton(tree.container, /Customers/);
      assert.ok(tab, 'the hub exposes the Customers tab');
      inAct(() => tab!.click());
      await settle();

      const customerInput = tree.container.querySelector(
        'input[aria-label="Customer opening customer"]'
      ) as HTMLInputElement | null;
      assert.ok(customerInput, 'the customer picker renders');
      setTextInput(customerInput!, 'Acme');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });

      const customerOption = findButton(tree.container, /Acme Customer/);
      assert.ok(customerOption, 'the branch-scoped customer appears in the picker');
      inAct(() => customerOption!.click());
      await settle();

      const amountInput = tree.container.querySelector(
        'input[aria-label="Customer opening amount"]'
      ) as HTMLInputElement | null;
      assert.ok(amountInput, 'the customer opening amount renders');
      setNumberInput(amountInput!, '0');

      const add = findButton(tree.container, /Add customer/);
      assert.ok(add, 'the draft can be added');
      inAct(() => add!.click());
      await settle();
      assert.match(tree.container.textContent || '', /must be a positive amount/);
      assert.equal(posted.length, 0, 'an invalid draft must not reach the route');

      setNumberInput(amountInput!, '750');
      inAct(() => add!.click());
      await settle();

      const post = findButton(tree.container, /Post Customer Openings/);
      assert.ok(post, 'a customer opening draft exposes the post action');
      inAct(() => post!.click());
      await settle();

      assert.equal(posted.length, 1);
      assert.equal(posted[0].branchId, 'br-a');
      assert.deepEqual(posted[0].lines[0], {
        accountId: 'acct-ar',
        debit: 750,
        credit: 0,
        memo: 'Opening receivable — Acme Customer (CUST-1)',
        subledgerType: 'CUSTOMER',
        partyId: 'CUST-1',
        partyName: 'Acme Customer',
      });
      assert.deepEqual(posted[0].lines[1], {
        accountId: 'acct-equity',
        debit: 0,
        credit: 750,
        memo: 'Opening balance equity offset',
      });
      assert.match(tree.container.textContent || '', /posted as journal JV-CUST-1/);
    } finally {
      tree.unmount();
    }
  });

  test('Stock tab saves only scoped rows and reports the posted opening journal', async () => {
    const saved: Array<{ id: string; rows: any[]; offsetAccountId?: string }> = [];
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.getFiscalYearOpeningStock = async () => openingPayload as any;
    api.getAccountingAccounts = async () =>
      [
        {
          id: 'acct-equity',
          code: '3000',
          name: 'Retained Earnings',
          isActive: true,
          isControl: false,
          accountType: 'EQUITY',
          postingRole: 'RETAINED_EARNINGS',
        },
      ] as any;
    api.getPostingDefaults = async () =>
      ({
        defaults: {
          INVENTORY: {
            accountId: 'acct-inventory',
            accountCode: '1200',
            accountName: 'Inventory',
            accountType: 'ASSET',
            statementGroup: 'CURRENT_ASSET',
            isControl: false,
            subledgerType: 'NONE',
          },
        },
      }) as any;
    api.adjustFiscalYearOpeningStock = async (id: string, rows: any[], offsetAccountId?: string) => {
      saved.push({ id, rows, offsetAccountId });
      return {
        applied: rows.length,
        created: 0,
        message: `${rows.length} opening-stock row(s) saved`,
        journals: [
          {
            branchId: 'br-a',
            journalNo: 'MJ-STOCK-1',
            periodKey: '2026-07',
            totalValue: rows[0].quantityOnHand * rows[0].unitCost,
          },
        ],
      } as any;
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, products } }, createElement(VendorOpeningBalances, {
        currentUser: branchUser(),
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      const tab = findButton(tree.container, /^Stock$/);
      assert.ok(tab, 'the hub exposes the Stock tab');
      inAct(() => tab!.click());
      await settle();

      assert.match(tree.container.textContent || '', /Inventory debit account/);
      assert.match(tree.container.textContent || '', /1200 · Inventory/);
      assert.ok(!(tree.container.textContent || '').includes('Branch B'), 'a foreign branch row must not render');

      const branchSelect = tree.container.querySelector(
        'select[aria-label="Stock opening branch"]'
      ) as HTMLSelectElement | null;
      assert.ok(branchSelect, 'the stock form exposes its branch picker');
      assert.deepEqual(
        [...branchSelect!.querySelectorAll('option')].map((option) => option.value),
        ['br-a'],
        'a branch account can only save its own branch'
      );

      const qtyInput = tree.container.querySelector(
        'input[aria-label="Stock opening quantity for Router"]'
      ) as HTMLInputElement | null;
      assert.ok(qtyInput, 'the own-branch stock row renders an editable quantity');
      assert.equal(qtyInput!.disabled, false, 'the quantity input is editable');
      setNumberInput(qtyInput!, '8');
      inAct(() => qtyInput!.dispatchEvent(new window.Event('change', { bubbles: true })));
      await settle();
      assert.equal(qtyInput!.value, '8', 'the quantity input keeps the typed value');

      const offsetSelect = tree.container.querySelector(
        'select[aria-label="Stock opening offset account"]'
      ) as HTMLSelectElement | null;
      assert.equal(offsetSelect?.value, 'acct-equity', 'the retained-earnings offset is selected');
      assert.match(tree.container.textContent || '', /1 row changed/, 'the edited row is staged');
      const save = findButton(tree.container, /^Save & Post/);
      assert.ok(save, 'a changed stock row exposes Save & Post');
      assert.equal(save!.disabled, false, 'the save action is enabled for a scoped, priced row');
      inAct(() => save!.click());
      await settle();

      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, 'fy-1');
      assert.equal(saved[0].offsetAccountId, 'acct-equity');
      assert.deepEqual(
        saved[0].rows.map((row) => ({
          productId: row.productId,
          branchId: row.branchId,
          quantityOnHand: row.quantityOnHand,
          unitCost: row.unitCost,
        })),
        [{ productId: 'p1', branchId: 'br-a', quantityOnHand: 8, unitCost: 10 }],
        'the payload never carries the foreign-branch row that was in the response'
      );
      assert.match(tree.container.textContent || '', /Posted journal MJ-STOCK-1/);
      assert.match(tree.container.textContent || '', /Dr Inventory \/ Cr opening equity/);
    } finally {
      tree.unmount();
    }
  });

  test('a failed vendor save leaves the GL opening confirmation untouched', async () => {
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.getAccountingAccounts = async () =>
      [
        { id: 'acct-cash', code: '1000', name: 'Cash', isActive: true, isControl: false },
        {
          id: 'acct-equity',
          code: '3000',
          name: 'Retained Earnings',
          isActive: true,
          isControl: false,
          accountType: 'EQUITY',
          postingRole: 'RETAINED_EARNINGS',
        },
      ] as any;
    api.getPostingDefaults = async () =>
      ({
        defaults: {
          AP_CONTROL: {
            accountId: 'acct-ap',
            accountCode: '2100',
            accountName: 'Accounts Payable',
            accountType: 'LIABILITY',
            isControl: true,
          },
        },
      }) as any;
    api.postOpeningBalances = async () => ({ journalNo: 'JV-GL-STAY', periodKey: '2026-07' }) as any;
    api.adjustVendorOpeningBalances = async () => {
      throw new Error('AP control account is unavailable.');
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches, suppliers } }, createElement(VendorOpeningBalances, {
        currentUser: superUser,
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      inAct(() => findButton(tree.container, /General Ledger/)!.click());
      await settle();
      const accountSelects = [
        ...tree.container.querySelectorAll('select[aria-label="Opening balance account"]'),
      ] as HTMLSelectElement[];
      setSelectValue(accountSelects[0], 'acct-cash');
      setSelectValue(accountSelects[1], 'acct-equity');
      const debitInputs = [
        ...tree.container.querySelectorAll('input[aria-label="Opening balance debit"]'),
      ] as HTMLInputElement[];
      const creditInputs = [
        ...tree.container.querySelectorAll('input[aria-label="Opening balance credit"]'),
      ] as HTMLInputElement[];
      setNumberInput(debitInputs[0], '500');
      setNumberInput(creditInputs[1], '500');
      inAct(() => findButton(tree.container, /Post Opening Balances/)!.click());
      await settle();
      assert.match(tree.container.textContent || '', /posted as journal JV-GL-STAY/);

      inAct(() => findButton(tree.container, /^Vendors$/)!.click());
      await settle();
      const vendorTable = [...tree.container.querySelectorAll('table')].find((table) =>
        (table.textContent || '').includes('Supplier One')
      );
      const balanceInput = vendorTable?.querySelector('input[type="number"]') as HTMLInputElement | undefined;
      assert.ok(balanceInput, 'the vendor register renders its editable balance');
      setNumberInput(balanceInput!, '150');
      inAct(() => findButton(tree.container, /^Save & Post 1/)!.click());
      await settle();
      assert.match(tree.container.textContent || '', /AP control account is unavailable/);

      inAct(() => findButton(tree.container, /General Ledger/)!.click());
      await settle();
      assert.match(
        tree.container.textContent || '',
        /posted as journal JV-GL-STAY/,
        'the GL confirmation survives a failure in the vendor register'
      );
    } finally {
      tree.unmount();
    }
  });

  test('General Ledger tab posts balanced opening lines for a scoped branch', async () => {
    const posted: any[] = [];
    api.getVendorOpeningBalances = async () => vendorPayload as any;
    api.getAccountingAccounts = async () =>
      [
        { id: 'acct-cash', code: '1000', name: 'Cash', isActive: true, isControl: false },
        { id: 'acct-equity', code: '3100', name: 'Opening Equity', isActive: true, isControl: false },
      ] as any;
    api.postOpeningBalances = async (input) => {
      posted.push(input);
      return { journalNo: 'JV-OPEN-1', periodKey: '2026-07' } as any;
    };

    const tree = mountTree(
      createElement(BootstrapDataProvider, { initial: { branches } }, createElement(VendorOpeningBalances, {
        currentUser: accountantUser,
        fiscalYears,
      } as any))
    );
    try {
      await settle();

      const tab = findButton(tree.container, /General Ledger/);
      assert.ok(tab, 'the hub exposes the General Ledger tab');
      inAct(() => tab!.click());
      await settle();

      const branchSelect = tree.container.querySelector(
        'select[aria-label="Opening balance branch"]'
      ) as HTMLSelectElement | null;
      assert.ok(branchSelect, 'the GL form exposes its branch picker');
      assert.deepEqual(
        [...branchSelect!.querySelectorAll('option')].map((option) => option.value),
        ['br-a'],
        'a branch account can only post to its own branch'
      );

      const accountSelects = [
        ...tree.container.querySelectorAll('select[aria-label="Opening balance account"]'),
      ] as HTMLSelectElement[];
      assert.equal(accountSelects.length, 2, 'the form starts with two lines');
      setSelectValue(accountSelects[0], 'acct-cash');
      setSelectValue(accountSelects[1], 'acct-equity');

      const debitInputs = [
        ...tree.container.querySelectorAll('input[aria-label="Opening balance debit"]'),
      ] as HTMLInputElement[];
      const creditInputs = [
        ...tree.container.querySelectorAll('input[aria-label="Opening balance credit"]'),
      ] as HTMLInputElement[];
      setNumberInput(debitInputs[0], '500');
      setNumberInput(creditInputs[1], '500');

      const post = findButton(tree.container, /Post Opening Balances/);
      assert.ok(post, 'a balanced draft exposes the post action');
      inAct(() => post!.click());
      await settle();

      assert.deepEqual(posted, [
        {
          branchId: 'br-a',
          register: 'GL',
          lines: [
            { accountId: 'acct-cash', debit: 500, credit: 0 },
            { accountId: 'acct-equity', debit: 0, credit: 500 },
          ],
        },
      ]);
      assert.match(tree.container.textContent || '', /posted as journal JV-OPEN-1/);
    } finally {
      tree.unmount();
    }
  });
});
