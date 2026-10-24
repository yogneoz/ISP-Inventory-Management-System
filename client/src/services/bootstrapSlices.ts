/**
 * Per-slice bootstrap hydration status (architecture backlog C1).
 *
 * Before this module the three deferred ledger slices and every SSE-targeted
 * refresh shared a `.catch(() => null)`: a failed request looked exactly like
 * "still loading" and exactly like "genuinely empty". A ledger could show zero
 * rows because one GET failed, with no message anywhere — GETs are deliberately
 * not toasted (see services/api/http.ts), so nothing surfaced at all.
 *
 * The state here is a pure reducer: App keeps the last good rows in its own
 * `useState` arrays and only ever replaces them when a payload actually
 * arrives, so a failure keeps the previous data on screen. This module records
 * what happened per key — `idle | loading | ready | error` — plus the version
 * that produced the data and the error to show, and exposes ONE notice payload
 * (`visibleSliceErrors`) instead of one toast per slice.
 *
 * C2 adds the other half: a request stamp (`branchId|fiscalYearId|seq`) and a
 * per-key applied version, so a response that belongs to a view the user has
 * already left — or that an out-of-order arrival made older than the rows on
 * screen — is discarded instead of painting the new view with old rows.
 *
 * Standalone (no imports) so the rules are unit-testable without mounting App.
 */

export type BootstrapSliceStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface BootstrapSliceEntry {
  status: BootstrapSliceStatus;
  /** Server dataVersion that produced the current data; kept across failures. */
  dataVersion?: number;
  /** Human-readable failure reason, present only while `status === 'error'`. */
  error?: string;
  /**
   * True once the user dismissed the notice for THIS error. A retry that fails
   * with the same message stays dismissed; a different message re-surfaces it.
   */
  errorDismissed?: boolean;
}

export type BootstrapSliceState = Record<string, BootstrapSliceEntry>;

/** One failed slice, as the notice renders it. */
export interface VisibleSliceError {
  key: string;
  label: string;
  message: string;
}

/** Friendly names for the notice. Unknown keys fall back to the raw key. */
const SLICE_LABELS: Record<string, string> = {
  stock: 'stock levels',
  stockOperations: 'stock operations',
  purchaseOrders: 'purchase orders',
  purchaseInvoices: 'purchase invoices',
  salesInvoices: 'sales invoices',
  purchaseReturns: 'purchase returns',
  salesReturns: 'sales returns',
  shipments: 'shipments',
  transactionLogs: 'transaction log',
  financialSummary: 'financial summary',
  damageRecords: 'damaged stock',
  auditLogs: 'audit trail',
  customerDevices: 'customer devices',
  customers: 'customers',
  suppliers: 'suppliers',
  branches: 'branches',
  locations: 'locations',
  products: 'products',
  categories: 'categories',
  assets: 'fixed assets',
  fiscalYears: 'fiscal years',
  users: 'users',
  approvalRequests: 'approval requests',
  companyProfile: 'company profile',
  appSettings: 'application settings',
  permissionsMatrix: 'permission matrix',
};

/** The name the notice uses for `key`. */
export function sliceLabel(key: string): string {
  return SLICE_LABELS[key] || key;
}

/** A new, empty state. Keys are created on first use. */
export function createBootstrapSliceState(): BootstrapSliceState {
  return {};
}

/**
 * Mark `key` as loading, keeping its last known version and error.
 *
 * The error is kept (not cleared) so the notice does not blink out during a
 * retry: it still describes the last failed attempt — and the rows on screen
 * are still the ones it refers to — until one attempt succeeds.
 */
export function beginSliceLoad(state: BootstrapSliceState, key: string): BootstrapSliceState {
  const prev = state[key] || { status: 'idle' as const };
  return { ...state, [key]: { ...prev, status: 'loading' } };
}

/**
 * Mark `key` ready. `dataVersion` is recorded when supplied; otherwise the
 * previous version is kept (a payload without a version still proves the data).
 * The error and its dismissal are cleared — this is the "successful retry
 * clears the error" rule.
 */
export function markSliceReady(
  state: BootstrapSliceState,
  key: string,
  dataVersion?: number
): BootstrapSliceState {
  const prev = state[key];
  const entry: BootstrapSliceEntry = { status: 'ready' };
  const version = typeof dataVersion === 'number' ? dataVersion : prev?.dataVersion;
  if (typeof version === 'number') entry.dataVersion = version;
  return { ...state, [key]: entry };
}

/**
 * Mark several keys ready in one update (a full bootstrap payload). Only the
 * keys the payload actually carried are touched: the deferred ledgers are not
 * part of the full bootstrap, so their error state must survive it.
 */
export function markSlicesReady(
  state: BootstrapSliceState,
  keys: readonly string[],
  dataVersion?: number
): BootstrapSliceState {
  return keys.reduce((next, key) => markSliceReady(next, key, dataVersion), state);
}

/**
 * Record a failed load. The last good data stays on screen (App never applies
 * a failed payload); this keeps its version and shows the reason. Repeating the
 * SAME message does not undo a dismissal; a new message does.
 */
export function markSliceError(
  state: BootstrapSliceState,
  key: string,
  message: string
): BootstrapSliceState {
  const prev = state[key];
  const entry: BootstrapSliceEntry = { status: 'error', error: message, errorDismissed: false };
  if (typeof prev?.dataVersion === 'number') entry.dataVersion = prev.dataVersion;
  // Compare the retained ERROR, not the status: a retry goes through
  // `beginSliceLoad` first, which sets `loading` while keeping the error, so a
  // status-based check would treat the same failure as new and nag again.
  if (prev?.error === message) {
    entry.errorDismissed = Boolean(prev.errorDismissed);
  }
  return { ...state, [key]: entry };
}

/** Dismiss the notice for every currently-failed slice. */
export function dismissSliceErrors(state: BootstrapSliceState): BootstrapSliceState {
  let changed = false;
  const next: BootstrapSliceState = { ...state };
  for (const [key, entry] of Object.entries(state)) {
    if (entry.status === 'error' && !entry.errorDismissed) {
      next[key] = { ...entry, errorDismissed: true };
      changed = true;
    }
  }
  return changed ? next : state;
}

/**
 * Every failed slice whose notice has not been dismissed, in insertion order —
 * the whole payload for the ONE notice (never a toast per slice). An entry
 * being retried (`loading` with a retained error) stays listed: the rows on
 * screen are still the ones the message is about until the retry succeeds.
 */
export function visibleSliceErrors(state: BootstrapSliceState): VisibleSliceError[] {
  return Object.entries(state)
    .filter(([, entry]) => Boolean(entry.error) && !entry.errorDismissed)
    .map(([key, entry]) => ({ key, label: sliceLabel(key), message: entry.error as string }));
}

/** Keys whose last load failed, dismissed or not (the Retry set). */
export function failedSliceKeys(state: BootstrapSliceState): string[] {
  return Object.entries(state)
    .filter(([, entry]) => entry.status === 'error')
    .map(([key]) => key);
}

/** True while any tracked slice is being (re)fetched. */
export function isAnySliceLoading(state: BootstrapSliceState): boolean {
  return Object.values(state).some((entry) => entry.status === 'loading');
}

/**
 * Settle a request that will NEVER apply its payload (discarded).
 *
 * `beginSliceLoad` set the key to `loading`; a discarded response must not
 * leave that flag set forever (it would keep the notice's Retry disabled), so
 * the entry falls back to what is actually true: the previously applied data
 * is still what is on screen (`ready` with its version), an existing error is
 * still an error, and a key that never loaded is `idle`. A superseded request
 * does NOT call this — its newer sibling owns the key and will settle it.
 */
export function settleSliceDiscarded(
  state: BootstrapSliceState,
  key: string
): BootstrapSliceState {
  const prev = state[key];
  if (!prev || prev.status !== 'loading') return state;
  if (prev.error) return { ...state, [key]: { ...prev, status: 'error' } };
  const entry: BootstrapSliceEntry = {
    status: typeof prev.dataVersion === 'number' ? 'ready' : 'idle',
  };
  if (typeof prev.dataVersion === 'number') entry.dataVersion = prev.dataVersion;
  return { ...state, [key]: entry };
}

// ---------------------------------------------------------------------------
// C2 — request stamps and applied versions
// ---------------------------------------------------------------------------

/**
 * The scope a slice response must still belong to. `ALL` mirrors the API's
 * meaning for an absent branch/fiscal year, so the stamp is unambiguous.
 */
export function sliceScopeKey(
  branchId?: string | null,
  fiscalYearId?: string | null
): string {
  return `${branchId || 'ALL'}|${fiscalYearId || 'ALL'}`;
}

/** One in-flight slice request, stamped with the view and its own sequence. */
export interface SliceRequest {
  key: string;
  scope: string;
  seq: number;
}

/** Why a response was or was not applied. */
export type SliceDecision =
  | 'apply'
  | 'superseded'
  | 'stale-scope'
  | 'older-version';

/**
 * Decides whether a slice response may paint, exactly as App needs it:
 *
 *  - **superseded** — a newer request for the same key exists (a second refresh
 *    started while this one was in flight). That newer request owns the key's
 *    status; this response must not touch it.
 *  - **stale-scope** — the user switched branch or fiscal year while this was in
 *    flight. The rows would belong to the view they left; discard them.
 *  - **older-version** — same view, but the payload is older than one already
 *    applied for this key (out-of-order arrival). Applying it would move the
 *    screen backwards; discard it.
 *
 * Versions are per key, because a slice's `dataVersion` only proves freshness
 * for the slice it carries. Equal versions apply (same data, harmless).
 */
export class SliceRequestGate {
  private seq = 0;
  private latestByKey = new Map<string, number>();
  private appliedByKey = new Map<string, number>();

  /** Stamp a new request and make it the latest for its key. */
  begin(key: string, scope: string): SliceRequest {
    const seq = ++this.seq;
    this.latestByKey.set(key, seq);
    return { key, scope, seq };
  }

  decide(
    request: SliceRequest,
    currentScope: string,
    responseVersion?: number
  ): SliceDecision {
    if (this.latestByKey.get(request.key) !== request.seq) return 'superseded';
    if (request.scope !== currentScope) return 'stale-scope';
    const applied = this.appliedByKey.get(request.key);
    if (
      typeof responseVersion === 'number' &&
      typeof applied === 'number' &&
      responseVersion < applied
    ) {
      return 'older-version';
    }
    return 'apply';
  }

  /**
   * Record the version whose data is now on screen for these keys. Called for a
   * full bootstrap payload too: a targeted slice request that started BEFORE
   * that payload and returns AFTER it must not overwrite newer rows just
   * because its response arrived last.
   */
  noteApplied(keys: readonly string[], dataVersion?: number): void {
    if (typeof dataVersion !== 'number') return;
    for (const key of keys) this.appliedByKey.set(key, dataVersion);
  }
}
