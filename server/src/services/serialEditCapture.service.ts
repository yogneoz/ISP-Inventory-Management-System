/**
 * Dual serial correction service — the orchestration behind the dual-panel
 * serial edit endpoint (`POST /api/inventory/serials/dual`), previously
 * inline in server.ts. No HTTP, no global state: the single-edit executor is
 * injected, so the sequencing logic is unit-testable with a fake.
 *
 * Applies TWO device edits in one sequenced operation so a serial collision
 * between two devices can be resolved in a single save (including a full
 * A↔B swap). Swap cases need safe ordering: BOTH devices are parked on
 * temporary values first, then both final states are applied. This makes
 * every collision shape safe — including full swaps and partial overlaps —
 * because each apply step runs against a database where neither device
 * holds its original serials anymore, so no unique index can collide
 * mid-sequence. Every step runs the full single-edit cascade + validation
 * (all tables, all validations, audit trail) via the injected executor.
 */
import { normalizeSerial } from './serials.service';

/** One device edit request — the body shape `handleUpdateSerials` accepts. */
export interface SerialEditBody {
  oldDeviceSerial?: string;
  oldPonSerial?: string;
  oldMacAddress?: string;
  deviceSerial?: string;
  ponSerial?: string;
  macAddress?: string;
  branchId?: string;
  [key: string]: unknown;
}

/**
 * Executes one single-device serial correction and returns the would-be HTTP
 * response (status + JSON body) instead of writing to a real response. In
 * production this wraps `handleUpdateSerials` with a capture adapter.
 */
export type SerialEditExecutor = (
  user: any,
  body: SerialEditBody
) => Promise<{ status: number; data: any }>;

/** A sequenced dual-edit step: what it is and the body to run it with. */
export interface DualEditStep {
  label: string;
  body: SerialEditBody;
}

/** Result of one executed step. */
export interface DualEditStepResult {
  step: string;
  status: number;
  data: any;
}

/** Unique tag for temporary park values (base36 time + random suffix). */
export function generateParkTag(): string {
  return `${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6)
    .toString(36)
    .toUpperCase()}`;
}

/**
 * Payload validation for the dual endpoint — returns the error response to
 * send, or null when the payload is valid. Checks:
 *  - edit "a" is present and is an object
 *  - device serial + PON serial are required on "a" (and on "b" when given)
 *  - combined final-state rule: after both edits, no serial value may be
 *    shared between the two devices (each non-empty identifier unique).
 */
export function validateDualEditPayload(
  a: any,
  b: any
): { status: number; message: string } | null {
  if (!a || typeof a !== 'object') {
    return { status: 400, message: 'Edit "a" is required.' };
  }
  if (!a.deviceSerial || !a.ponSerial) {
    return {
      status: 400,
      message: 'Device serial and PON serial are required for both devices.',
    };
  }
  if (b && (!b.deviceSerial || !b.ponSerial)) {
    return {
      status: 400,
      message: 'Device serial and PON serial are required for both devices.',
    };
  }

  if (b) {
    const finalA = [
      normalizeSerial(a.deviceSerial),
      normalizeSerial(a.ponSerial),
      normalizeSerial(a.macAddress),
    ].filter(Boolean);
    const finalB = [
      normalizeSerial(b.deviceSerial),
      normalizeSerial(b.ponSerial),
      normalizeSerial(b.macAddress),
    ].filter(Boolean);
    const shared = finalA.filter((v) => finalB.includes(v));
    if (shared.length > 0) {
      return {
        status: 409,
        message: `Both devices cannot end up with the same ${
          shared.length > 1 ? 'values' : 'value'
        }: ${shared.join(', ')}. Correct one of the panels before saving.`,
      };
    }
  }
  return null;
}

/**
 * Builds the sequenced step plan for a dual/single edit.
 *
 * With `b` present: park-a (A on temp values) → park-b (B on temp values) →
 * apply-a (A on its final values) → apply-b (B on its final values). Park
 * steps clear the MAC (temp values never collide on MAC either); apply steps
 * restore the requested MAC. Without `b`: a single apply-a step with the
 * body passed through verbatim (spread preserves any extra properties).
 *
 * Pure: never mutates `a` or `b`.
 */
export function buildDualEditSteps(a: SerialEditBody, b: SerialEditBody | null | undefined, parkTag: string): DualEditStep[] {
  if (!b) {
    return [{ label: 'apply-a', body: { ...a } }];
  }
  return [
    {
      label: 'park-a',
      body: {
        oldDeviceSerial: a.oldDeviceSerial,
        oldPonSerial: a.oldPonSerial,
        oldMacAddress: a.oldMacAddress,
        deviceSerial: `TMP-SWAP-${parkTag}-AD`,
        ponSerial: `TMP-SWAP-${parkTag}-AP`,
        macAddress: undefined,
        branchId: a.branchId,
      },
    },
    {
      label: 'park-b',
      body: {
        oldDeviceSerial: b.oldDeviceSerial,
        oldPonSerial: b.oldPonSerial,
        oldMacAddress: b.oldMacAddress,
        deviceSerial: `TMP-SWAP-${parkTag}-BD`,
        ponSerial: `TMP-SWAP-${parkTag}-BP`,
        macAddress: undefined,
        branchId: b.branchId,
      },
    },
    {
      label: 'apply-a',
      body: {
        oldDeviceSerial: `TMP-SWAP-${parkTag}-AD`,
        oldPonSerial: `TMP-SWAP-${parkTag}-AP`,
        oldMacAddress: '',
        deviceSerial: a.deviceSerial,
        ponSerial: a.ponSerial,
        macAddress: a.macAddress,
        branchId: a.branchId,
      },
    },
    {
      label: 'apply-b',
      body: {
        oldDeviceSerial: `TMP-SWAP-${parkTag}-BD`,
        oldPonSerial: `TMP-SWAP-${parkTag}-BP`,
        oldMacAddress: '',
        deviceSerial: b.deviceSerial,
        ponSerial: b.ponSerial,
        macAddress: b.macAddress,
        branchId: b.branchId,
      },
    },
  ];
}

/** Successful orchestration outcome: every step applied (status 200). */
export interface DualEditSuccess {
  ok: true;
  results: DualEditStepResult[];
}

/**
 * Failed orchestration outcome: the step that failed, its status/data, and
 * the results of the steps that already ran. One transaction per edit — a
 * failed step leaves prior steps applied (each step is itself atomic); the
 * client gets the exact step + conflict so it can show which panel broke.
 */
export interface DualEditFailure {
  ok: false;
  status: number;
  payload: {
    message: string;
    step: string;
    results: DualEditStepResult[];
  };
}

/**
 * Runs the step plan in order through the injected executor, stopping at the
 * first non-200 step. The executor runs the REAL single-edit cascade for
 * every step — validations, all-table renames, audit trail — so the dual
 * endpoint and the single edit endpoint can never drift apart.
 */
export async function applyDualEdit(
  executor: SerialEditExecutor,
  user: any,
  a: SerialEditBody,
  b: SerialEditBody | null | undefined,
  parkTag: string
): Promise<DualEditSuccess | DualEditFailure> {
  const steps = buildDualEditSteps(a, b, parkTag);
  const results: DualEditStepResult[] = [];
  for (const step of steps) {
    const result = await executor(user, step.body);
    results.push({ step: step.label, status: result.status, data: result.data });
    if (result.status !== 200) {
      return {
        ok: false,
        status: result.status,
        payload: {
          message: `Step '${step.label}' failed: ${result.data?.message || 'unknown error'}`,
          step: step.label,
          results,
        },
      };
    }
  }
  return { ok: true, results };
}
