/**
 * Request-scoped record of a Super-Admin override of the fiscal-year write lock.
 *
 * The fiscal-year HTTP gate is not the only way into the ledger: an outbox
 * flush and service-to-service callers reach `ensureOpenPeriod` without ever
 * passing through Express. The posting path therefore refuses a closed year by
 * itself, and the one authorized exception - a Super Admin who supplied a
 * written reason, which `enforceFiscalYearWriteAccess` already audit-logs -
 * travels with the request instead of being implied by it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

/** Runs the rest of the request with a closed-year override in force. */
export function runWithClosedFiscalYearOverride<T>(reason: string, fn: () => T): T {
  return storage.run(reason, fn);
}

/** The override reason when a Super Admin already authorized this request. */
export function closedFiscalYearOverrideReason(): string | null {
  return storage.getStore() ?? null;
}
