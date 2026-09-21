import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateParkTag,
  validateDualEditPayload,
  buildDualEditSteps,
  applyDualEdit,
  type DualEditStepResult,
  type SerialEditBody,
  type SerialEditExecutor,
} from '../server/src/services/serialEditCapture.service';

// ---------------------------------------------------------------------------
// generateParkTag — temp-value tag format
// ---------------------------------------------------------------------------
describe('generateParkTag', () => {
  it('returns two base36 segments separated by a dash', () => {
    const tag = generateParkTag();
    assert.match(tag, /^[0-9A-Z]+-[0-9A-Z]+$/);
  });

  it('generates distinct tags across calls (practically)', () => {
    const tags = new Set(Array.from({ length: 50 }, () => generateParkTag()));
    assert.ok(tags.size > 1, 'expected more than one distinct tag in 50 calls');
  });
});

// ---------------------------------------------------------------------------
// validateDualEditPayload — payload + combined final-state validation
// ---------------------------------------------------------------------------
describe('validateDualEditPayload', () => {
  const validA: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-A',
    deviceSerial: 'SN-NEW-A',
    ponSerial: 'PON-NEW-A',
    macAddress: 'AA:BB:CC:DD:EE:01',
    branchId: 'WH001',
  };
  const validB: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-B',
    deviceSerial: 'SN-NEW-B',
    ponSerial: 'PON-NEW-B',
    macAddress: 'AA:BB:CC:DD:EE:02',
    branchId: 'WH001',
  };

  it('rejects a missing edit "a" with 400', () => {
    const err = validateDualEditPayload(undefined, validB);
    assert.equal(err?.status, 400);
    assert.equal(err?.message, 'Edit "a" is required.');
  });

  it('rejects a non-object edit "a" with 400', () => {
    const err = validateDualEditPayload('nope', validB);
    assert.equal(err?.status, 400);
    assert.equal(err?.message, 'Edit "a" is required.');
  });

  it('rejects edit "a" without deviceSerial with 400', () => {
    const err = validateDualEditPayload({ ...validA, deviceSerial: undefined }, validB);
    assert.equal(err?.status, 400);
    assert.equal(err?.message, 'Device serial and PON serial are required for both devices.');
  });

  it('rejects edit "a" without ponSerial with 400', () => {
    const err = validateDualEditPayload({ ...validA, ponSerial: '' }, validB);
    assert.equal(err?.status, 400);
    assert.equal(err?.message, 'Device serial and PON serial are required for both devices.');
  });

  it('rejects edit "b" without deviceSerial with 400', () => {
    const err = validateDualEditPayload(validA, { ...validB, deviceSerial: undefined });
    assert.equal(err?.status, 400);
    assert.equal(err?.message, 'Device serial and PON serial are required for both devices.');
  });

  it('accepts a single edit (no b) with no error', () => {
    assert.equal(validateDualEditPayload(validA, undefined), null);
  });

  it('accepts a valid dual edit with no error', () => {
    assert.equal(validateDualEditPayload(validA, validB), null);
  });

  it('rejects when both devices end with the same device serial (409, singular)', () => {
    const err = validateDualEditPayload({ ...validA, deviceSerial: 'SN-SHARED' }, { ...validB, deviceSerial: 'SN-SHARED' });
    assert.equal(err?.status, 409);
    assert.match(err?.message || '', /same value: SN-SHARED/);
  });

  it('rejects when both devices end with the same PON serial (409, singular)', () => {
    const err = validateDualEditPayload({ ...validA, ponSerial: 'PON-SHARED' }, { ...validB, ponSerial: 'PON-SHARED' });
    assert.equal(err?.status, 409);
    assert.match(err?.message || '', /same value: PON-SHARED/);
  });

  it('rejects when both devices end with the same MAC (409, singular)', () => {
    const err = validateDualEditPayload({ ...validA, macAddress: 'AA:BB:CC:DD:EE:FF' }, { ...validB, macAddress: 'AA:BB:CC:DD:EE:FF' });
    assert.equal(err?.status, 409);
    assert.match(err?.message || '', /same value: AA:BB:CC:DD:EE:FF/);
  });

  it('uses plural wording when multiple values are shared', () => {
    const err = validateDualEditPayload(
      { ...validA, deviceSerial: 'SN-SHARED', ponSerial: 'PON-SHARED' },
      { ...validB, deviceSerial: 'SN-SHARED', ponSerial: 'PON-SHARED' }
    );
    assert.equal(err?.status, 409);
    assert.match(err?.message || '', /same values: SN-SHARED, PON-SHARED/);
  });

  it('detects shared values case-insensitively', () => {
    const err = validateDualEditPayload(validA, { ...validB, deviceSerial: 'sn-new-a' });
    assert.equal(err?.status, 409);
    assert.match(err?.message || '', /SN-NEW-A/);
  });

  it('ignores empty/whitespace identifiers when checking overlaps', () => {
    const err = validateDualEditPayload(
      { ...validA, macAddress: '   ' },
      { ...validB, macAddress: undefined }
    );
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// buildDualEditSteps — park-then-apply step planning
// ---------------------------------------------------------------------------
describe('buildDualEditSteps', () => {
  const a: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-A',
    oldPonSerial: 'PON-OLD-A',
    oldMacAddress: 'MAC-OLD-A',
    deviceSerial: 'SN-NEW-A',
    ponSerial: 'PON-NEW-A',
    macAddress: 'MAC-NEW-A',
    branchId: 'WH001',
  };
  const b: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-B',
    oldPonSerial: 'PON-OLD-B',
    oldMacAddress: 'MAC-OLD-B',
    deviceSerial: 'SN-OLD-A', // full A↔B swap: B takes A's old serial
    ponSerial: 'PON-OLD-A',
    macAddress: 'MAC-OLD-A',
    branchId: 'BRH01',
  };

  it('returns a single verbatim apply-a step for a single edit', () => {
    const steps = buildDualEditSteps(a, undefined, 'TAG1');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].label, 'apply-a');
    assert.deepEqual(steps[0].body, a); // spread copy — verbatim values
  });

  it('preserves extra body properties on the single-edit step', () => {
    const a2 = { ...a, someExtra: 'keep-me' };
    const steps = buildDualEditSteps(a2, undefined, 'TAG1');
    assert.equal((steps[0].body as any).someExtra, 'keep-me');
  });

  it('returns four steps in park-a → park-b → apply-a → apply-b order for a dual edit', () => {
    const steps = buildDualEditSteps(a, b, 'TAG1');
    assert.deepEqual(
      steps.map((s) => s.label),
      ['park-a', 'park-b', 'apply-a', 'apply-b']
    );
  });

  it('parks device A on temp values derived from the tag', () => {
    const steps = buildDualEditSteps(a, b, 'TAG1');
    const parkA = steps[0].body;
    assert.equal(parkA.oldDeviceSerial, 'SN-OLD-A');
    assert.equal(parkA.oldPonSerial, 'PON-OLD-A');
    assert.equal(parkA.oldMacAddress, 'MAC-OLD-A');
    assert.equal(parkA.deviceSerial, 'TMP-SWAP-TAG1-AD');
    assert.equal(parkA.ponSerial, 'TMP-SWAP-TAG1-AP');
    assert.equal(parkA.macAddress, undefined);
    assert.equal(parkA.branchId, 'WH001');
  });

  it('parks device B on temp values derived from the tag', () => {
    const steps = buildDualEditSteps(a, b, 'TAG1');
    const parkB = steps[1].body;
    assert.equal(parkB.oldDeviceSerial, 'SN-OLD-B');
    assert.equal(parkB.oldPonSerial, 'PON-OLD-B');
    assert.equal(parkB.oldMacAddress, 'MAC-OLD-B');
    assert.equal(parkB.deviceSerial, 'TMP-SWAP-TAG1-BD');
    assert.equal(parkB.ponSerial, 'TMP-SWAP-TAG1-BP');
    assert.equal(parkB.macAddress, undefined);
    assert.equal(parkB.branchId, 'BRH01');
  });

  it('applies A from its temp values to its final values', () => {
    const steps = buildDualEditSteps(a, b, 'TAG1');
    const applyA = steps[2].body;
    assert.equal(applyA.oldDeviceSerial, 'TMP-SWAP-TAG1-AD');
    assert.equal(applyA.oldPonSerial, 'TMP-SWAP-TAG1-AP');
    assert.equal(applyA.oldMacAddress, '');
    assert.equal(applyA.deviceSerial, 'SN-NEW-A');
    assert.equal(applyA.ponSerial, 'PON-NEW-A');
    assert.equal(applyA.macAddress, 'MAC-NEW-A');
    assert.equal(applyA.branchId, 'WH001');
  });

  it('applies B from its temp values to its final values', () => {
    const steps = buildDualEditSteps(a, b, 'TAG1');
    const applyB = steps[3].body;
    assert.equal(applyB.oldDeviceSerial, 'TMP-SWAP-TAG1-BD');
    assert.equal(applyB.oldPonSerial, 'TMP-SWAP-TAG1-BP');
    assert.equal(applyB.oldMacAddress, '');
    assert.equal(applyB.deviceSerial, 'SN-OLD-A');
    assert.equal(applyB.ponSerial, 'PON-OLD-A');
    assert.equal(applyB.macAddress, 'MAC-OLD-A');
    assert.equal(applyB.branchId, 'BRH01');
  });

  it('does not mutate the input edits (pure)', () => {
    const aCopy = JSON.parse(JSON.stringify(a));
    const bCopy = JSON.parse(JSON.stringify(b));
    buildDualEditSteps(a, b, 'TAG1');
    assert.deepEqual(a, aCopy);
    assert.deepEqual(b, bCopy);
  });
});

// ---------------------------------------------------------------------------
// applyDualEdit — sequenced execution with stop-on-failure
// ---------------------------------------------------------------------------
describe('applyDualEdit', () => {
  const a: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-A',
    deviceSerial: 'SN-NEW-A',
    ponSerial: 'PON-NEW-A',
  };
  const b: SerialEditBody = {
    oldDeviceSerial: 'SN-OLD-B',
    deviceSerial: 'SN-NEW-B',
    ponSerial: 'PON-NEW-B',
  };

  /** Records every executed body, returns configurable statuses in order. */
  function recordingExecutor(statuses: number[]): { executor: SerialEditExecutor; executed: SerialEditBody[] } {
    const executed: SerialEditBody[] = [];
    const executor: SerialEditExecutor = async (_user, body) => {
      executed.push(body);
      return { status: statuses[Math.min(executed.length - 1, statuses.length - 1)], data: { ok: true } };
    };
    return { executor, executed };
  }

  it('runs a single edit through the executor exactly once', async () => {
    const { executor, executed } = recordingExecutor([200]);
    const result = await applyDualEdit(executor, { id: 'u1' }, a, undefined, 'TAG1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].step, 'apply-a');
      assert.equal(result.results[0].status, 200);
    }
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], a);
  });

  it('runs four steps in order for a dual edit', async () => {
    const { executor, executed } = recordingExecutor([200, 200, 200, 200]);
    const result = await applyDualEdit(executor, { id: 'u1' }, a, b, 'TAG1');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.results.length, 4);
    assert.equal(executed.length, 4);
    assert.equal(executed[0].deviceSerial, 'TMP-SWAP-TAG1-AD');
    assert.equal(executed[1].deviceSerial, 'TMP-SWAP-TAG1-BD');
    assert.equal(executed[2].deviceSerial, 'SN-NEW-A');
    assert.equal(executed[3].deviceSerial, 'SN-NEW-B');
  });

  it('stops at the first failing step and reports it', async () => {
    const executor: SerialEditExecutor = async (_user, body) => {
      if (String(body.deviceSerial).startsWith('TMP-SWAP-TAG1-B')) {
        return { status: 409, data: { message: 'duplicate serial' } };
      }
      return { status: 200, data: { ok: true } };
    };
    const result = await applyDualEdit(executor, { id: 'u1' }, a, b, 'TAG1');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.equal(result.payload.step, 'park-b');
      assert.equal(result.payload.message, "Step 'park-b' failed: duplicate serial");
      // park-a executed and is included; apply steps never ran
      assert.deepEqual(
        result.payload.results.map((r) => r.step),
        ['park-a', 'park-b']
      );
      assert.equal(result.payload.results[1].status, 409);
    }
  });

  it('reports an unknown error message when the failing step has none', async () => {
    const executor: SerialEditExecutor = async () => ({ status: 500, data: {} });
    const result = await applyDualEdit(executor, { id: 'u1' }, a, undefined, 'TAG1');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.payload.message, "Step 'apply-a' failed: unknown error");
    }
  });

  it('aggregates step results with statuses on the success path', async () => {
    const { executor } = recordingExecutor([200, 200, 200, 200]);
    const result = await applyDualEdit(executor, { id: 'u1' }, a, b, 'TAG1');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.results.map((r: DualEditStepResult) => r.step),
        ['park-a', 'park-b', 'apply-a', 'apply-b']
      );
      assert.ok(result.results.every((r) => r.status === 200));
    }
  });
});
