/**
 * Draft and validation rules for the per-user permission editor.
 *
 * The screen keeps only the DIFFERENCES from the role matrix: an operation
 * absent from the draft map inherits the role's answer. Keeping this pure makes
 * the tri-state → payload contract testable without mounting the screen, and
 * keeps the future-expiry and required-reason rules identical in the UI and in
 * the request the server validates again.
 */

export type PermissionOverrideEffect = 'grant' | 'deny';
export type PermissionDraftEffect = 'inherit' | PermissionOverrideEffect;

export interface PermissionOverrideDraft {
  effect: PermissionOverrideEffect;
  /** Required: the server writes it to the audit trail. */
  reason: string;
  /** AD date-only (`YYYY-MM-DD`), or null for no expiry. */
  expiresAt: string | null;
}

/** operationId -> draft. Only exceptions are present. */
export type PermissionOverrideDrafts = Record<string, PermissionOverrideDraft>;

/** The subset of the API row the draft needs. */
export interface StoredPermissionOverride {
  operationId: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
}

export interface PermissionOverrideInput {
  operationId: string;
  effect: PermissionOverrideEffect;
  reason: string;
  expiresAt: string | null;
}

/** The API stores an ISO timestamp; the picker works in AD calendar days. */
function dateOnly(value: string | null): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Parses an AD date as the END of that local day. An expiry of "today" is a
 * grant that lasts through today, not one that died at UTC midnight — which is
 * also the server's future check, so the UI cannot stage a value it will reject.
 */
export function expiryInstant(date: string | null): Date | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null; // reject normalised impossible dates such as 2026-02-31
  }
  return parsed;
}

export function draftsFromOverrides(
  overrides: readonly StoredPermissionOverride[]
): PermissionOverrideDrafts {
  const drafts: PermissionOverrideDrafts = {};
  for (const override of overrides) {
    drafts[override.operationId] = {
      effect: override.effect,
      reason: override.reason || '',
      expiresAt: dateOnly(override.expiresAt),
    };
  }
  return drafts;
}

export function draftEffectFor(
  drafts: PermissionOverrideDrafts,
  operationId: string
): PermissionDraftEffect {
  return drafts[operationId]?.effect || 'inherit';
}

/**
 * Moves one operation between Inherit / Grant / Deny. Inherit removes the row
 * (there is no "inherit" effect in the database), and returning to Grant/Deny
 * preserves any reason already typed for the other effect.
 */
export function setDraftEffect(
  drafts: PermissionOverrideDrafts,
  operationId: string,
  effect: PermissionDraftEffect
): PermissionOverrideDrafts {
  if (effect === 'inherit') {
    if (!(operationId in drafts)) return drafts;
    const next = { ...drafts };
    delete next[operationId];
    return next;
  }
  const existing = drafts[operationId];
  return {
    ...drafts,
    [operationId]: {
      effect,
      reason: existing?.reason || '',
      expiresAt: existing?.expiresAt ?? null,
    },
  };
}

/** Updates the reason/expiry of an existing exception; inherit rows are a no-op. */
export function updateDraft(
  drafts: PermissionOverrideDrafts,
  operationId: string,
  patch: Partial<Pick<PermissionOverrideDraft, 'reason' | 'expiresAt'>>
): PermissionOverrideDrafts {
  const existing = drafts[operationId];
  if (!existing) return drafts;
  return { ...drafts, [operationId]: { ...existing, ...patch } };
}

export interface DraftValidation {
  ok: boolean;
  errors: Record<string, string>;
}

export function validateDrafts(
  drafts: PermissionOverrideDrafts,
  now: number = Date.now()
): DraftValidation {
  const errors: Record<string, string> = {};
  for (const [operationId, draft] of Object.entries(drafts)) {
    if (!draft.reason.trim()) {
      errors[operationId] = 'A reason is required for an exception.';
      continue;
    }
    if (draft.expiresAt) {
      const expiry = expiryInstant(draft.expiresAt);
      if (!expiry || expiry.getTime() <= now) {
        errors[operationId] = 'Expiry must be a future date.';
      }
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** The exact replace payload, sorted so retries and tests are deterministic. */
export function draftsToPayload(drafts: PermissionOverrideDrafts): PermissionOverrideInput[] {
  return Object.keys(drafts)
    .sort()
    .map((operationId) => {
      const draft = drafts[operationId];
      const expiry = draft.expiresAt ? expiryInstant(draft.expiresAt) : null;
      return {
        operationId,
        effect: draft.effect,
        reason: draft.reason.trim(),
        expiresAt: expiry ? expiry.toISOString() : null,
      };
    });
}

/** Stable comparison for "are there unsaved changes?". */
export function draftsFingerprint(drafts: PermissionOverrideDrafts): string {
  return JSON.stringify(
    Object.keys(drafts)
      .sort()
      .map((operationId) => [
        operationId,
        drafts[operationId].effect,
        drafts[operationId].reason,
        drafts[operationId].expiresAt,
      ])
  );
}

export function countDraftChanges(drafts: PermissionOverrideDrafts): {
  grants: number;
  denies: number;
  total: number;
} {
  let grants = 0;
  let denies = 0;
  for (const draft of Object.values(drafts)) {
    if (draft.effect === 'grant') grants += 1;
    else denies += 1;
  }
  return { grants, denies, total: grants + denies };
}

/**
 * The operations the user WILL have once these drafts are saved. The role's
 * base answer is the starting point; a grant adds an operation, a deny removes
 * one. Used for the per-group and top-level "effective" preview.
 */
export function effectivePreview(
  base: Record<string, boolean>,
  drafts: PermissionOverrideDrafts,
  /** Grants contributed by the user's assigned permission sets. */
  setGrants: ReadonlySet<string> = new Set()
): { allowed: number; total: number } {
  const operations = new Set([...Object.keys(base), ...Object.keys(drafts), ...setGrants]);
  let allowed = 0;
  for (const operation of operations) {
    const effect = drafts[operation]?.effect;
    if (effect === 'grant') allowed += 1;
    else if (effect === 'deny') continue;
    else if (base[operation] || setGrants.has(operation)) allowed += 1;
  }
  return { allowed, total: operations.size };
}
