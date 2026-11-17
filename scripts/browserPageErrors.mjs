#!/usr/bin/env node
/**
 * Page-error classification for the browser gates — worklist A10 follow-up.
 *
 * WHY THIS EXISTS
 * The boot-timing/input-readiness check drives repeated navigations against
 * whatever server it is pointed at. Against a Vite dev server, every document
 * loads Vite's HMR client, and that client rejects its own transport promise
 * when the socket closes before its `open` handshake completes:
 *
 *   Error: WebSocket closed without opened.
 *       at WebSocket.<anonymous> (http://localhost:3000/@vite/client:454:22)
 *
 * (vite 6.4.5, `dist/client/client.mjs:442-456`: `socket.addEventListener
 * ("close", … reject(new Error("WebSocket closed without opened.")))`.) Back-to-
 * back automated navigations close the previous document's socket while the next
 * one is still connecting, so the error appears on reloads and never in the
 * production bundle, which ships no HMR client at all.
 *
 * THE LINE THIS DRAWS
 * It is exactly one message from exactly one script (`/@vite/client`), and it is
 * ignored only when BOTH match. Every other page exception stays fatal on both
 * paths — an app that throws, a failed fetch that rejects unhandled, a
 * postMessage clone error, even a WebSocket error thrown from app code with the
 * same wording but a different stack. The ignored ones are counted and printed,
 * so a dev-server run never hides that they happened.
 */

/** The only message Vite's HMR client is allowed to contribute. */
export const HMR_TOOLING_MESSAGE = 'WebSocket closed without opened.';

/** The dev server's HMR client script, as it appears in a stack or a URL. */
const HMR_CLIENT = /(?:^|[/@])@vite\/client(?:[:?#]|$)/;

/**
 * True only for Vite's HMR transport closing mid-handshake. The message alone
 * is not enough: an app's own socket could throw the same words.
 */
export function isViteHmrToolingError(text) {
  const haystack = String(text ?? '');
  if (!haystack.includes(HMR_TOOLING_MESSAGE)) return false;
  return HMR_CLIENT.test(haystack);
}

/**
 * Split captured page errors into fatal and dev-tooling buckets. `errors` are
 * the strings the CDP `Runtime.exceptionThrown` / console handlers produce.
 */
export function partitionPageErrors(errors = []) {
  const fatal = [];
  const devTooling = [];
  for (const error of errors) {
    if (isViteHmrToolingError(error)) devTooling.push(error);
    else fatal.push(error);
  }
  return { fatal, devTooling };
}

/** One line for the run log; null when nothing was ignored. */
export function describeIgnoredDevTooling(errors = []) {
  if (!errors.length) return null;
  return (
    `⚠ ignored ${errors.length} Vite HMR tooling error(s) — the dev server's own ` +
    `"${HMR_TOOLING_MESSAGE}" from /@vite/client, which the production bundle does not ship; ` +
    'every application exception is still fatal.'
  );
}
