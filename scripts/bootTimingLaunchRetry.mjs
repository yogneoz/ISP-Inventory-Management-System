/**
 * Bounded retry for the boot-timing gate's headless-browser launch, plus the
 * reporting that makes a retry visible in CI.
 *
 * The GitHub runner intermittently starts Chrome without ever writing
 * DevToolsActivePort, so the gate fails before it measures anything. Nothing in
 * the app is broken; the launch needs one or two fresh attempts. The caller
 * owns process/profile cleanup between attempts via `onRetry`, so this helper
 * only decides when to try again and how to report the final failure.
 *
 * A retry must be answerable from a saved run, not only from the step log: a
 * passing gate that swallowed a flake and a passing gate that never retried
 * look identical otherwise. `launchRetryAnnotation` surfaces the absorbed
 * failure as a run annotation and `describeLaunchOutcome` states the final
 * attempt count in the step summary.
 */

/** Keep the gate bounded: three attempts cannot stretch a real failure forever. */
export const BROWSER_LAUNCH_ATTEMPTS = 3;

/** A short pause lets a just-killed browser release its profile on Windows. */
export const BROWSER_LAUNCH_RETRY_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `launchOnce` until it succeeds or `attempts` is exhausted.
 *
 * @param {() => Promise<unknown>} launchOnce One complete launch attempt.
 * @param {{
 *   attempts?: number,
 *   retryMs?: number,
 *   onRetry?: (attempt: number, attempts: number, error: unknown) => void | Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<unknown>} The first successful launch result.
 */
export async function retryBrowserLaunch(
  launchOnce,
  {
    attempts = BROWSER_LAUNCH_ATTEMPTS,
    retryMs = BROWSER_LAUNCH_RETRY_MS,
    onRetry = () => {},
    sleep = defaultSleep,
  } = {}
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer (got ${attempts})`);
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchOnce();
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await onRetry(attempt, attempts, err);
      await sleep(retryMs);
    }
  }

  throw new Error(
    `browser did not start after ${attempts} attempts — ${lastError?.message || lastError}`
  );
}

/**
 * One-line description of a failed attempt. Chrome's failure text spans
 * several lines, and an annotation or summary row must stay on one, so all
 * whitespace collapses.
 */
export function describeLaunchRetry(attempt, attempts, error) {
  const cause = String(error?.message ?? error ?? 'unknown error')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    `Headless browser launch attempt ${attempt}/${attempts} failed — ${cause}; ` +
    `retrying with a fresh profile (attempt ${attempt + 1}/${attempts}).`
  );
}

/**
 * GitHub Actions annotation for a failed attempt, so the absorbed flake shows
 * up in the run's annotation list instead of only inside the step log. Escape
 * `%` per the workflow-command grammar; newlines are already collapsed.
 */
export function launchRetryAnnotation(attempt, attempts, error) {
  const text = describeLaunchRetry(attempt, attempts, error).replace(/%/g, '%25');
  return `::warning title=Boot timing browser launch::${text}`;
}

/**
 * The durable outcome line for the CI step summary: did the launch happen
 * cleanly, or did it absorb one or more runner flakes?
 */
export function describeLaunchOutcome(attemptsUsed) {
  if (!attemptsUsed) return 'Headless browser: no launch recorded.';
  const retries = attemptsUsed - 1;
  if (retries === 0) return 'Headless browser: launched on attempt 1, no retry needed.';
  return (
    `Headless browser: launched on attempt ${attemptsUsed}, absorbing ${retries} failed ` +
    `launch${retries === 1 ? '' : 'es'}.`
  );
}
