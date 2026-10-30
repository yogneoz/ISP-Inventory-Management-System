/**
 * Guard: the boot-timing gate retries a headless-browser launch that dies
 * before DevToolsActivePort appears.
 *
 * GitHub's runner intermittently starts Chrome without ever writing the port
 * file, which failed run 41012427181's first attempt in 3 seconds — before the
 * page was measured — even though typecheck and all tests had passed. The same
 * flake hit run 214. The gate must absorb that launch failure, not turn it into
 * a red build, while still giving up after a bounded number of attempts so a
 * genuinely broken browser cannot hang CI forever.
 *
 * PROVES:
 *   1. A launch that fails twice and then succeeds returns the third result.
 *   2. Retries are bounded and the final error names the real cause.
 *   3. `onRetry` runs between attempts (the hook that tears down the profile)
 *      but not after the last failure.
 *   4. A non-positive attempt count is rejected instead of looping forever.
 *   5. An absorbed retry is reported: one-line log text, a single-line
 *      `::warning` annotation under GitHub Actions, and a step-summary outcome
 *      row that says whether a flake was absorbed — so a saved run answers the
 *      question without reading the step log.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describeLaunchOutcome,
  describeLaunchRetry,
  launchRetryAnnotation,
  retryBrowserLaunch,
} from '../scripts/bootTimingLaunchRetry.mjs';

describe('production boot-timing — browser launch retry', () => {
  test('retries a failed launch and returns the first success', async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; attempts: number; message: string }> = [];

    const result = await retryBrowserLaunch(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('browser did not start (no DevToolsActivePort)');
        return 'connected';
      },
      {
        attempts: 3,
        retryMs: 0,
        onRetry: (attempt: number, attempts: number, err: unknown) => {
          retries.push({ attempt, attempts, message: (err as Error).message });
        },
      }
    );

    assert.equal(result, 'connected');
    assert.equal(calls, 3, 'the successful third attempt must be the last launch');
    assert.deepEqual(retries, [
      { attempt: 1, attempts: 3, message: 'browser did not start (no DevToolsActivePort)' },
      { attempt: 2, attempts: 3, message: 'browser did not start (no DevToolsActivePort)' },
    ]);
  });

  test('gives up after the bounded attempts and names the last failure', async () => {
    let calls = 0;
    const retries: number[] = [];

    await assert.rejects(
      () =>
        retryBrowserLaunch(
          async () => {
            calls += 1;
            throw new Error('browser exited during startup (code 1)');
          },
          {
            attempts: 3,
            retryMs: 0,
            onRetry: (attempt: number) => {
              retries.push(attempt);
            },
          }
        ),
      /browser did not start after 3 attempts — browser exited during startup \(code 1\)/
    );

    assert.equal(calls, 3, 'a permanent failure must not be retried forever');
    assert.deepEqual(retries, [1, 2], 'the final failure is not followed by another retry');
  });

  test('rejects a non-positive attempt count instead of looping forever', async () => {
    await assert.rejects(
      () => retryBrowserLaunch(async () => 'never called', { attempts: 0 }),
      /attempts must be a positive integer/
    );
  });
});

describe('production boot-timing — retry reporting', () => {
  test('a failed attempt is one log line naming the next attempt', () => {
    const line = describeLaunchRetry(
      1,
      3,
      new Error(
        'browser did not start (no DevToolsActivePort). Output:\n[1:ERROR] chrome crashed\n  second line'
      )
    );

    assert.equal(
      line,
      'Headless browser launch attempt 1/3 failed — browser did not start ' +
        '(no DevToolsActivePort). Output: [1:ERROR] chrome crashed second line; ' +
        'retrying with a fresh profile (attempt 2/3).'
    );
    assert.ok(!line.includes('\n'), 'a log/annotation line must stay single-line');
  });

  test('the annotation is a single workflow command line with % escaped', () => {
    const annotation = launchRetryAnnotation(
      2,
      3,
      new Error('browser exited during startup (code 1)\n100% fatal')
    );

    assert.ok(annotation.startsWith('::warning title=Boot timing browser launch::'));
    assert.ok(!annotation.includes('\n'), 'a workflow command must not span lines');
    assert.ok(annotation.includes('100%25 fatal'), 'percent signs must be escaped');
    assert.ok(annotation.includes('attempt 2/3'));
  });

  test('the outcome line says whether a runner flake was absorbed', () => {
    assert.equal(describeLaunchOutcome(0), 'Headless browser: no launch recorded.');
    assert.equal(
      describeLaunchOutcome(1),
      'Headless browser: launched on attempt 1, no retry needed.'
    );
    assert.equal(
      describeLaunchOutcome(2),
      'Headless browser: launched on attempt 2, absorbing 1 failed launch.'
    );
    assert.equal(
      describeLaunchOutcome(3),
      'Headless browser: launched on attempt 3, absorbing 2 failed launches.'
    );
  });

  test('the gate emits both the annotation and the step-summary outcome', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/check_boot_timing.mjs'),
      'utf8'
    );
    // The annotation only under GitHub Actions; the summary wherever CI offers one.
    assert.match(source, /if \(isGithubActions\) log\(launchRetryAnnotation\(/);
    assert.match(source, /process\.env\.GITHUB_STEP_SUMMARY/);
    // Both the pass and the fail path must state the launch outcome.
    assert.equal(
      source.match(/describeLaunchOutcome\(browserLaunchAttempts\)/g)?.length,
      2,
      'the success and failure summaries must both report the launch outcome'
    );
  });
});
