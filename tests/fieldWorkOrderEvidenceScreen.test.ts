/**
 * Proof-of-work gallery inside the field work-order screen.
 *
 * A work order's captures must be visible, readable back, and attachable from
 * the web app — and every server outcome the phone already sees (stored,
 * replayed duplicate, over the byte ceiling) has to arrive as a readable
 * sentence here too, not a raw error or a silent no-op.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { mountTree } from './harness/mount';
import { FieldWorkOrders } from '../client/src/features/sales/FieldWorkOrders';
import { api } from '../client/src/services/api';

// The render harness installs a jsdom window but not the file/URL globals this
// screen needs to read a chosen file and preview stored bytes.
for (const name of ['File', 'FileReader', 'Blob'] as const) {
  Object.defineProperty(globalThis, name, {
    value: (window as any)[name],
    configurable: true,
    writable: true,
  });
}
// jsdom has no blob URL registry; the panel only needs a stable src to show.
(URL as any).createObjectURL = () => 'blob:test-capture';
(URL as any).revokeObjectURL = () => {};

const user = { id: 'w1-user', email: 'wo@example.com', name: 'Branch Manager', role: 'BRANCH_MANAGER', branchId: 'b1' } as any;

const ORDER = {
  id: 'w1',
  work_order_no: 'WO-1001',
  branch_id: 'b1',
  customer_id: 'c1',
  customer_name: 'Ram Shrestha',
  kind: 'INSTALL',
  status: 'OPEN',
  scheduled_date_ad: '2026-11-20',
  technician_name: null,
};

const CAPTURE = {
  id: 'ev1',
  work_order_id: 'w1',
  branch_id: 'b1',
  kind: 'PHOTO',
  content_type: 'image/png',
  byte_size: 2048,
  sha256: 'a1b2c3d4e5f6a7b8c9d0',
  caption: 'ONT mounted on the wall',
  captured_at: '2026-11-20T11:00:00.000Z',
  captured_by: 'w1-user',
  latitude: null,
  longitude: null,
  accuracy_meters: null,
  created_at: '2026-11-20T11:00:01.000Z',
};

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const clickButton = (root: HTMLElement, text: string) => {
  const button = [...root.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  assert.ok(button, `expected a "${text}" button`);
  act(() => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
};

const chooseFile = (root: HTMLElement, file: File | null) => {
  const input = root.querySelector('input[type="file"]') as HTMLInputElement | null;
  assert.ok(input, 'expected the capture file input');
  Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true });
  act(() => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
};

describe('proof-of-work gallery on a work order', () => {
  let mounted: ReturnType<typeof mountTree> | null = null;
  const real = {
    list: api.getFieldWorkOrders,
    customers: api.getCustomers,
    evidence: api.getFieldWorkOrderEvidence,
    upload: api.postFieldWorkOrderEvidence,
    content: api.fetchFieldWorkOrderEvidenceContent,
  };

  beforeEach(() => {
    api.getFieldWorkOrders = (async () => [ORDER]) as any;
    api.getCustomers = (async () => []) as any;
    api.getFieldWorkOrderEvidence = (async () => ({ evidence: [CAPTURE], count: 1 })) as any;
    api.postFieldWorkOrderEvidence = (async () => ({
      id: 'ev2',
      kind: 'PHOTO',
      contentType: 'image/png',
      byteSize: 3,
      sha256: 'f'.repeat(64),
      capturedAt: '2026-11-20T12:00:00.000Z',
      inserted: true,
      count: 2,
    })) as any;
    api.fetchFieldWorkOrderEvidenceContent = (async () => new Blob(['x'], { type: 'image/png' })) as any;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    api.getFieldWorkOrders = real.list;
    api.getCustomers = real.customers;
    api.getFieldWorkOrderEvidence = real.evidence;
    api.postFieldWorkOrderEvidence = real.upload;
    api.fetchFieldWorkOrderEvidenceContent = real.content;
  });

  const open = async () => {
    mounted = mountTree(
      createElement(FieldWorkOrders, { selectedBranchId: 'b1', dateMode: 'AD', currentUser: user })
    );
    await settle();
    clickButton(mounted.container, 'Proof');
    await settle();
    return mounted;
  };

  test('the gallery lists the stored capture and reads its bytes back', async () => {
    const tree = await open();
    const text = tree.container.textContent || '';
    assert.match(text, /ONT mounted on the wall/);
    assert.match(text, /2 KB/);
    assert.match(text, /a1b2c3d4e5f6/);

    clickButton(tree.container, 'View');
    await settle();
    const image = tree.container.querySelector('img');
    assert.ok(image, 'the stored bytes must render back in the panel');
    assert.equal(image.getAttribute('alt'), 'Photo · a1b2c3d4e5f6…');
  });

  test('a replayed capture says nothing was duplicated', async () => {
    api.postFieldWorkOrderEvidence = (async () => ({
      id: 'ev1',
      kind: 'PHOTO',
      contentType: 'image/png',
      byteSize: 3,
      sha256: 'a'.repeat(64),
      capturedAt: '2026-11-20T11:00:00.000Z',
      inserted: false,
      count: 1,
    })) as any;

    const tree = await open();
    chooseFile(tree.container, new window.File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' }));
    clickButton(tree.container, 'Attach capture');
    await settle();

    const status = tree.container.querySelector('[role="status"]');
    assert.ok(status, 'a stored outcome must be reported');
    assert.match(status.textContent || '', /Already on file/);
    assert.match(status.textContent || '', /nothing was duplicated/);
  });

  test('a capture over the ceiling is named as such before it is sent', async () => {
    let uploads = 0;
    api.postFieldWorkOrderEvidence = (async () => {
      uploads += 1;
      throw new Error('should not be reached');
    }) as any;

    const tree = await open();
    const file = new window.File([new Uint8Array([1, 2, 3])], 'huge.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 3 * 1024 * 1024 });
    chooseFile(tree.container, file);
    clickButton(tree.container, 'Attach capture');
    await settle();

    const alert = tree.container.querySelector('[role="alert"]');
    assert.ok(alert, 'the refusal must surface as an alert');
    assert.match(alert.textContent || '', /2 MiB \(2,097,152 bytes\)/);
    assert.equal(uploads, 0, 'an over-ceiling file is not posted');
  });
});
