/**
 * Bounded retry for the boot-timing gate's headless-browser launch.
 *
 * The GitHub runner intermittently starts Chrome without ever writing
 * DevToolsActivePort, so the gate fails before it measures anything. Nothing in
 * the app is broken; the launch needs one or two fresh attempts. The caller
 * owns process/profile cleanup between attempts via `onRetry`, so this helper
 * only decides when to try again and how to report the final failure.
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
