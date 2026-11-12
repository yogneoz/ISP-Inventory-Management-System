/**
 * F1 Employee Profile dialog — rendered behaviour.
 *
 * Three things the API suite cannot see: a masked response opens the dialog
 * read-only (no save control at all), the repeating blocks really add and
 * remove rows, and the PUT payload carries the edited values with empty
 * scalars normalised to null.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { DialogProvider } from '../client/src/components/common/DialogProvider';
import { EmployeeProfileDialog } from '../client/src/features/hr/EmployeeProfileDialog';
import type {
  EmployeeRecord,
  HrEmployeeProfileFields,
  HrEmployeeProfileResponse,
} from '../client/src/services/api/hr';
import { mountTree } from './harness/mount';
import { installApiStubs } from './harness/appRouteTreeProbe';

const employee = {
  id: 'emp-f1-ui-1',
  employeeCode: 'F1-UI-1',
  name: 'Dialog Employee',
  branchId: 'WH001',
} as unknown as EmployeeRecord;

const emptyFields = (): HrEmployeeProfileFields => ({
  fatherName: null,
  grandfatherName: null,
  permanentAddress: null,
  localAddress: null,
  emergencyContactAddress: null,
  emergencyContactRelation: null,
  bloodGroup: null,
  medicalConditions: null,
  medicalDetails: null,
  accidentDetails: null,
  caseDetails: null,
  declarationDateAD: null,
  declarationName: null,
});

const profileResponse = (
  over: Partial<HrEmployeeProfileResponse> = {}
): HrEmployeeProfileResponse =>
  ({
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    name: employee.name,
    branchId: employee.branchId,
    masked: false,
    profile: emptyFields(),
    familyMembers: [],
    experience: [],
    qualifications: [],
    references: [],
    branchTransfers: [],
    ...over,
  }) as unknown as HrEmployeeProfileResponse;

const settle = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const bodyText = (): string => document.body.textContent || '';

const buttonByText = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find(
    (button) => (button.textContent || '').trim() === label
  ) as HTMLButtonElement | undefined;

const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

const typeInto = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const prototype = Object.getPrototypeOf(input) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const mountDialog = () =>
  mountTree(
    createElement(
      DialogProvider,
      null,
      createElement(EmployeeProfileDialog, { employee, canManage: true, onClose: () => undefined })
    )
  );

test('a masked profile opens read-only and cannot save', async () => {
  let saves = 0;
  const restore = installApiStubs({
    getEmployeeProfile: async () =>
      profileResponse({ masked: true, familyMembers: [], experience: [], qualifications: [], references: [] }),
    saveEmployeeProfile: async () => {
      saves += 1;
      return profileResponse();
    },
  });
  const tree = mountDialog();
  try {
    await settle();
    assert.match(bodyText(), /Ask an HR manager for the F1 details/);
    assert.equal(buttonByText('Save profile'), undefined, 'a masked profile must not offer Save');

    const fields = Array.from(
      document.querySelectorAll('input, select, textarea')
    ) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    assert.ok(fields.length > 0, 'the dialog still shows the form');
    assert.ok(
      fields.every((field) => field.disabled),
      'every field must be disabled for a view-only caller'
    );
    assert.equal(saves, 0);
  } finally {
    tree.unmount();
    restore();
  }
});

test('family rows can be added and removed', async () => {
  const restore = installApiStubs({
    getEmployeeProfile: async () =>
      profileResponse({
        familyMembers: [
          {
            id: 'fam-1',
            name: 'Gita',
            age: 40,
            occupation: 'Teacher',
            relation: 'Mother',
            sortOrder: 1,
          },
        ],
        branchTransfers: [
          {
            id: 'bt-ui-1',
            fromBranchId: 'WH001',
            fromBranchName: 'Kathmandu (Head Office)',
            toBranchId: 'WH002',
            toBranchName: 'Pokhara Branch',
            transferredBy: 'hr@example.com',
            effectiveDateAD: '2026-11-01',
            reason: 'Branch coverage',
            status: 'APPROVED',
            approvedBy: 'manager@example.com',
            approvedAt: '2026-11-02T09:00:00.000Z',
            decisionNote: null,
            createdAt: '2026-11-12T09:00:00.000Z',
          },
        ],
      }),
    saveEmployeeProfile: async () => profileResponse(),
  });
  const tree = mountDialog();
  try {
    await settle();
    const removeButtons = (): number =>
      document.querySelectorAll('button[title="Remove this family member"]').length;

    assert.equal(removeButtons(), 1, 'the stored row renders');
    assert.match(bodyText(), /Kathmandu \(Head Office\) → Pokhara Branch/);
    assert.match(bodyText(), /Branch coverage/);
    assert.match(bodyText(), /Requested by hr@example\.com/);
    await click(buttonByText('Add family member') as HTMLButtonElement);
    assert.equal(removeButtons(), 2, 'a new row is appended');

    await click(
      document.querySelectorAll('button[title="Remove this family member"]')[0] as HTMLElement
    );
    assert.equal(removeButtons(), 1, 'the removed row is gone');
    assert.equal(
      (document.querySelector('tbody tr input') as HTMLInputElement).value,
      '',
      'the remaining row is the blank one that was just added'
    );
  } finally {
    tree.unmount();
    restore();
  }
});

test('saving sends the edited rows and normalises empty scalars to null', async () => {
  let args: unknown[] = [];
  // The dialog owns the HR master fields too (the merged edit path), so Save
  // also patches the employee record.
  let masterArgs: unknown[] = [];
  const restore = installApiStubs({
    getEmployeeProfile: async () => profileResponse(),
    updateEmployee: async (...received: unknown[]) => {
      masterArgs = received;
      return employee;
    },
    saveEmployeeProfile: async (...received: unknown[]) => {
      args = received;
      return profileResponse({
        familyMembers: [
          { id: 'fam-9', name: 'Sita', age: 30, occupation: null, relation: null, sortOrder: 1 },
        ],
      });
    },
  });
  const tree = mountDialog();
  try {
    await settle();
    await click(buttonByText('Add family member') as HTMLButtonElement);

    const row = Array.from(document.querySelectorAll('tbody tr input')) as HTMLInputElement[];
    await typeInto(row[0], '  Sita  ');
    await typeInto(row[1], '30');

    await click(buttonByText('Save profile') as HTMLButtonElement);
    await settle();

    assert.equal(args.length, 3, 'saveEmployeeProfile(id, payload, branchId)');
    assert.equal(args[0], employee.id);
    assert.equal(args[2], employee.branchId);
    const payload = args[1] as Record<string, any>;
    assert.deepEqual(payload.familyMembers, [
      { name: 'Sita', age: 30, occupation: null, relation: null },
    ]);
    assert.equal(payload.fatherName, null, 'an empty scalar is sent as null');
    assert.deepEqual(payload.experience, []);
    assert.deepEqual(payload.references, []);
    assert.match(bodyText(), /Profile saved/);
    assert.equal(masterArgs[0], employee.id, 'the master update targets the same employee');
    const master = masterArgs[1] as Record<string, unknown>;
    assert.equal(master.monthlySalary, null, 'an empty salary is sent as null, not 0');
  } finally {
    tree.unmount();
    restore();
  }
});
