/**
 * Single-flight-with-trailing-pass runner (audit finding H4).
 *
 * The operational-cache refresh used to queue one FULL fan-out per committed
 * write (`refreshChain = refreshChain.then(refresh)`), so a burst of N writes
 * paid N sequential re-reads of every cache table and each response waited for
 * the whole queue. Throughput fell as the caches grew, and the queue — not the
 * database — became the write ceiling.
 *
 * This runner keeps the correctness property the old chain existed for (a
 * response is only flushed once a refresh that started AFTER the caller arrived
 * has completed) while collapsing overlapping work:
 *
 *   - the first caller starts a pass;
 *   - callers that arrive while that pass runs mark it dirty and await the SAME
 *     promise, so they never see a snapshot older than their own commit;
 *   - the driver runs one more pass for the dirty flag and then resolves
 *     everyone at once.
 *
 * A burst of N writes therefore costs at most two passes instead of N, and the
 * cost no longer grows with concurrency.
 */

export interface CoalescingRunnerStats {
  /** Completed refresh passes. */
  passes: number;
  /** Calls that asked for a refresh (including coalesced ones). */
  requests: number;
  /** Calls that joined an in-flight pass instead of starting a new one. */
  coalesced: number;
  /** Duration of the most recent pass. */
  lastDurationMs: number;
  /** Whether a pass is running right now. */
  running: boolean;
}

export interface CoalescingRunner {
  (): Promise<void>;
  stats(): CoalescingRunnerStats;
}

/**
 * @param runOnce  One full refresh pass. Must not throw (a failed refresh is
 *                 logged by the caller, never surfaced to the HTTP request).
 * @param enabled  When false, calls resolve immediately without running.
 */
export function createCoalescingRunner(
  runOnce: () => Promise<void>,
  enabled: () => boolean = () => true
): CoalescingRunner {
  let inFlight: Promise<void> | null = null;
  let dirty = false;
  let passes = 0;
  let requests = 0;
  let coalesced = 0;
  let lastDurationMs = 0;

  async function drain(): Promise<void> {
    do {
      dirty = false;
      const startedAt = Date.now();
      passes += 1;
      await runOnce();
      lastDurationMs = Date.now() - startedAt;
      // `enabled` is re-checked so a pass triggered while PostgreSQL is
      // dropping out does not spin.
    } while (dirty && enabled());
  }

  const runner = (() => {
    if (!enabled()) return Promise.resolve();
    requests += 1;
    if (inFlight) {
      // Someone is already reading the tables; this caller's write must be
      // covered by ANOTHER pass, which the driver's trailing loop performs.
      dirty = true;
      coalesced += 1;
      return inFlight;
    }
    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }) as CoalescingRunner;

  runner.stats = () => ({
    passes,
    requests,
    coalesced,
    lastDurationMs,
    running: inFlight !== null,
  });

  return runner;
}
