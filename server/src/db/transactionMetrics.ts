/**
 * Transaction-retry counters for monitoring.
 *
 * The transaction runner replays deadlock (40P01) and serialization-failure
 * (40001) victims, so a retry is the system working — but a rising rate means
 * real contention between requests. Keeping the counters here (not only in the
 * log line) lets `GET /api/health` report them during an incident, where
 * monitoring already looks. Counters are process-local and reset on restart;
 * they are a rate signal, not a durable audit trail.
 */
export type TransactionRetryMetrics = {
  /** Retries attempted (a request retried twice counts twice). */
  total: number;
  /** Of `total`, aborts by deadlock (40P01). */
  deadlock: number;
  /** Of `total`, aborts by serialization failure (40001). */
  serializationFailure: number;
  /** When the last retry happened, ISO-8601; null until the first one. */
  lastRetryAt: string | null;
  /** SQLSTATE of the last retried abort, for a quick read of the cause. */
  lastCode: string | null;
};

const DEADLOCK = '40P01';
const SERIALIZATION_FAILURE = '40001';

let total = 0;
let deadlock = 0;
let serializationFailure = 0;
let lastRetryAt: string | null = null;
let lastCode: string | null = null;

/** Record one retry of a transaction aborted with `code`. */
export function recordTransactionRetry(code: string): void {
  total += 1;
  if (code === DEADLOCK) deadlock += 1;
  else if (code === SERIALIZATION_FAILURE) serializationFailure += 1;
  lastRetryAt = new Date().toISOString();
  lastCode = code;
}

/** A snapshot for the health endpoint (a copy, so callers cannot mutate it). */
export function transactionRetryMetrics(): TransactionRetryMetrics {
  return { total, deadlock, serializationFailure, lastRetryAt, lastCode };
}

/** Test hook: counters are process-local, so a test starts from zero. */
export function resetTransactionRetryMetrics(): void {
  total = 0;
  deadlock = 0;
  serializationFailure = 0;
  lastRetryAt = null;
  lastCode = null;
}
