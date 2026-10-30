#!/usr/bin/env node
/**
 * Production boot-timing check — measures the splash window and proves the
 * lazy-route fallback and the shell sync spinner are never visible.
 *
 * WHY A BROWSER CHECK
 * The startup experience is a paint-order property, not a type property:
 * whether the user ever SEES "Loading module…" depends on when React commits
 * a lazy screen relative to when #boot-splash is removed. Unit tests can only
 * assert that the markers exist; they cannot tell whether the splash actually
 * covered the fallback on a real frame. This script loads the PRODUCTION build
 * in headless Chrome and samples every animation frame from navigation start
 * until the splash is gone, recording whether the fallback is genuinely
 * on-screen (not merely present in the DOM).
 *
 * It is deliberately not part of `npm test`: the suite must stay runnable
 * without a browser. CI runs it as a dedicated gate after the production build
 * (the workflow seeds the demo account and passes a 12 s budget, because the
 * gate is frame visibility rather than speed). Locally, run it before a
 * release, or after touching the boot path, `screenPreload.ts`, the lazy route
 * table, or index.html's splash.
 *
 * WHAT IT ASSERTS (both a cold-cache and a warm-cache reload)
 *   1. The static splash is present in the served HTML.
 *   2. The splash is on screen for at least one sampled frame.
 *   3. Neither the lazy fallback nor the shell sync spinner is VISIBLE while
 *      the splash is gone, and the root is never blank — the splash only lifts
 *      once the saved tab's screen has committed. This is the flicker
 *      regression.
 *   4. Real screen content (the saved "Create Sales Invoice" tab) is mounted
 *      when the splash lifts, so a saved session was actually restored.
 *   5. The splash lifts within --budget-ms (default 6000) and is gone at the
 *      end, with no uncaught page exception during boot.
 *   6. The warm reload never mounts the shell spinner at all: the cached
 *      bootstrap paints immediately instead of re-showing the sync surface.
 *
 * The check pins the demo user's activeTab preference to create-sale for the
 * run (a previous value is restored) so the saved lazy screen is deterministic:
 * the server-held preference hydrates after bootstrap and would otherwise
 * override localStorage's last tab.
 *
 * USAGE
 *   npm run check:boot-timing                 # build must exist in dist/
 *   npm run check:boot-timing -- --build      # build first
 *   node scripts/check_boot_timing.mjs --base-url http://localhost:3000
 *
 * The server needs PostgreSQL and the demo account seeded by `npm run setup:pg`
 * (superadmin@example.com / Demo@123 by default). Override the account with
 * BOOT_TRACE_EMAIL / BOOT_TRACE_PASSWORD, the browser binary with
 * BOOT_TRACE_BROWSER, and the splash budget with BOOT_TRACE_BUDGET_MS.
 *
 * No browser-automation dependency is installed: the script speaks the
 * Chrome DevTools Protocol over Node's built-in WebSocket. That keeps the
 * check runnable from a clean `npm ci` and avoids shipping a bundled Chromium.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_LAUNCH_ATTEMPTS,
  describeLaunchOutcome,
  describeLaunchRetry,
  launchRetryAnnotation,
  retryBrowserLaunch,
} from './bootTimingLaunchRetry.mjs';

const ROOT = process.cwd();
const DEFAULT_BUDGET_MS = 6000;
const BOOT_TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

const BASE_URL_ARG = argValue('--base-url');
const BUDGET_MS = Number(argValue('--budget-ms') || process.env.BOOT_TRACE_BUDGET_MS || DEFAULT_BUDGET_MS);
const EMAIL = process.env.BOOT_TRACE_EMAIL || 'superadmin@example.com';
const PASSWORD = process.env.BOOT_TRACE_PASSWORD || 'Demo@123';
const ACTIVE_TAB = 'create-sale';
const EXPECTED_SCREEN = 'Create Sales Invoice';

let browserChild = null;
let browserLaunchAttempts = 0;
let serverChild = null;
let serverLog = '';
let profileDir = null;
let cdp = null;
let preferenceRestore = null;
const pageErrors = [];
const consoleErrors = [];

function log(line = '') {
  console.log(line);
}

/** GitHub only promotes a `::warning` line to the run's annotation list. */
const isGithubActions = process.env.GITHUB_ACTIONS === 'true';

/** Append to the run summary when CI provides one; never fail a gate over it. */
function appendStepSummary(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    fs.appendFileSync(summaryFile, `${lines.join('\n')}\n`);
  } catch {
    // A summary write is reporting, not a measurement — it cannot redden CI.
  }
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  if (serverLog.trim()) {
    console.error('\nLast server output:\n' + serverLog.trim().split('\n').slice(-20).join('\n'));
  }
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------
function stopChild(child, { tree = false } = {}) {
  if (!child || child.exitCode !== null) return;
  try {
    if (tree && process.platform === 'win32') {
      // PID-based tree kill, never a name pattern: the dev server on 3000 may
      // be a sibling of this check and must not be touched.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Best effort.
  }
}

async function restorePreference() {
  if (!preferenceRestore || preferenceRestore.previous === null) return;
  try {
    await fetch(`${preferenceRestore.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${preferenceRestore.token}`,
      },
      body: JSON.stringify({ activeTab: preferenceRestore.previous }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // A dev tool must not fail on best-effort state restoration.
  }
}

/**
 * Drop one launch attempt: close its CDP socket, kill the browser and delete
 * the temp profile, so a retry cannot reuse a half-started instance.
 */
function resetBrowserProcess() {
  try {
    cdp?.close();
  } catch {}
  cdp = null;
  stopChild(browserChild, { tree: true });
  browserChild = null;
  if (profileDir) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Chrome may still hold a handle on Windows; the OS temp cleaner gets it.
    }
    profileDir = null;
  }
}

function cleanup() {
  resetBrowserProcess();
  if (serverChild) {
    try {
      serverChild.kill('SIGTERM');
    } catch {}
  }
}
process.on('SIGINT', () => {
  void restorePreference().finally(() => {
    cleanup();
    process.exit(130);
  });
});
process.on('SIGTERM', () => {
  void restorePreference().finally(() => {
    cleanup();
    process.exit(143);
  });
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await sleep(200);
  }
  throw new Error(`${url} did not become ready (${lastError})`);
}

// ---------------------------------------------------------------------------
// Production server
// ---------------------------------------------------------------------------
function assertBuildExists() {
  const entry = path.join(ROOT, 'dist', 'index.html');
  const bundle = path.join(ROOT, 'dist', 'server.cjs');
  if (!fs.existsSync(entry) || !fs.existsSync(bundle)) {
    throw new Error('dist/ is missing its production build — run `npm run build` first, or pass --build.');
  }
}

/** Newest mtime under client/index.html + client/src, for the stale-build hint. */
function newestClientSourceMtime() {
  let newest = fs.statSync(path.join(ROOT, 'client', 'index.html')).mtimeMs;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(path.join(ROOT, 'client', 'src'));
  return newest;
}

async function startProductionServer() {
  assertBuildExists();
  const port = await freePort();
  const secret = process.env.AUTH_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
  serverChild = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.cjs')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      AUTH_TOKEN_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
    if (serverLog.length > 20000) serverLog = serverLog.slice(-20000);
  });
  serverChild.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
    if (serverLog.length > 20000) serverLog = serverLog.slice(-20000);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/api/auth/setup-status`, 25000);
  return baseUrl;
}

async function login(baseUrl) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error(`login request failed: ${err?.message || err}`);
  }
  if (!res.ok) {
    throw new Error(
      `login failed with HTTP ${res.status}. Seed the demo data (npm run setup:pg) or set ` +
        `BOOT_TRACE_EMAIL / BOOT_TRACE_PASSWORD to a valid account.`
    );
  }
  const data = await res.json();
  if (!data?.token || !data?.user) throw new Error('login response had no token/user');
  return data;
}

/**
 * The saved tab is restored from localStorage for the FIRST render, but the
 * server-held `activeTab` preference hydrates after bootstrap and wins. Pin it
 * to the screen this check measures, remembering the previous value so the
 * demo account is left as it was found.
 */
async function pinActiveTabPreference(baseUrl, session) {
  const headers = { Authorization: `Bearer ${session.token}` };
  let previous = null;
  try {
    const current = await fetch(`${baseUrl}/api/settings`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (current.ok) {
      const body = await current.json();
      previous = body?.preferences?.activeTab ?? null;
    }
  } catch {
    // If the read fails, still pin the tab; there is nothing to restore.
  }
  preferenceRestore = { baseUrl, token: session.token, previous };
  const put = await fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeTab: ACTIVE_TAB }),
    signal: AbortSignal.timeout(5000),
  });
  if (!put.ok) {
    throw new Error(`could not pin the demo user's activeTab preference (HTTP ${put.status})`);
  }
}

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------
function findBrowser() {
  if (process.env.BOOT_TRACE_BROWSER) {
    if (!fs.existsSync(process.env.BOOT_TRACE_BROWSER)) {
      throw new Error(`BOOT_TRACE_BROWSER does not exist: ${process.env.BOOT_TRACE_BROWSER}`);
    }
    return process.env.BOOT_TRACE_BROWSER;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } else {
      const which = spawnSync('which', [candidate], { encoding: 'utf8' });
      if (which.status === 0) return which.stdout.trim();
    }
  }
  throw new Error(
    'No Chrome/Edge/Chromium found. Install one or set BOOT_TRACE_BROWSER to the executable path.'
  );
}

// ---------------------------------------------------------------------------
// Minimal CDP client (Node's built-in WebSocket, no dependency)
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
        else pending.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners.get(msg.method) || []) listener(msg.params);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launchBrowserOnce(executable) {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-timing-'));
  const browserArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1440,900',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];
  if (process.env.BOOT_TRACE_NO_SANDBOX === '1') browserArgs.unshift('--no-sandbox');
  browserChild = spawn(executable, browserArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserLog = '';
  browserChild.stdout.on('data', (c) => (browserLog += c.toString()));
  browserChild.stderr.on('data', (c) => (browserLog += c.toString()));

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) {
      throw new Error(`browser did not start (no DevToolsActivePort). Output:\n${browserLog.slice(-1500)}`);
    }
    if (browserChild.exitCode !== null) {
      throw new Error(`browser exited during startup (code ${browserChild.exitCode}):\n${browserLog.slice(-1500)}`);
    }
    await sleep(100);
  }
  await sleep(100);
  const [portLine] = fs.readFileSync(portFile, 'utf8').split('\n');
  const port = Number(portLine.trim());
  if (!port) throw new Error(`DevToolsActivePort had no port: ${portLine}`);

  // The browser endpoint must answer before /json/new is usable.
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 10000).catch(() => undefined);
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`could not open a browser tab (HTTP ${res.status})`);
  const target = await res.json();
  if (!target?.webSocketDebuggerUrl) throw new Error('new tab had no webSocketDebuggerUrl');
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  return cdp;
}

/**
 * Try the browser up to BROWSER_LAUNCH_ATTEMPTS times. The runner refuses a
 * launch now and then without ever writing DevToolsActivePort; that is a
 * runner flake, not a boot regression. Each failed attempt is torn down before
 * the next one starts, so a stale profile cannot poison the retry.
 */
async function launchBrowser() {
  const executable = findBrowser();
  browserLaunchAttempts = 0;
  return retryBrowserLaunch(
    () => {
      browserLaunchAttempts += 1;
      return launchBrowserOnce(executable);
    },
    {
      onRetry: (attempt, attempts, err) => {
        resetBrowserProcess();
        log(`⚠ ${describeLaunchRetry(attempt, attempts, err)}`);
        if (isGithubActions) log(launchRetryAnnotation(attempt, attempts, err));
      },
    }
  );
}

// ---------------------------------------------------------------------------
// In-page probe, injected before every document.
//
// It lives here as a real function so the browser side is readable, and is
// stringified into Page.addScriptToEvaluateOnNewDocument. It must not close
// over anything from this module.
// ---------------------------------------------------------------------------
function bootTraceProbe() {
  if (window.__bootTrace) return;

  const now = () => Math.round(performance.now());
  const trace = {
    status: 'pending',
    startedAt: now(),
    finishedAt: null,
    splashSeen: false,
    splashAtDomContentLoaded: false,
    fallbackSeen: false,
    fallbackVisibleFrames: 0,
    fallbackVisibleMs: 0,
    spinnerSeen: false,
    firstSpinnerAt: null,
    spinnerVisibleFrames: 0,
    spinnerVisibleMs: 0,
    // Frames where the splash is gone but a boot-only loading surface is
    // visible, or the root is empty. All three are the flicker this check
    // exists to catch.
    exposedLoadingFrames: 0,
    blankFrames: 0,
    splashRemovedAt: null,
    contentReadyAt: null,
    firstRootChildAt: null,
    firstFallbackAt: null,
    firstFallbackVisibleAt: null,
    frames: 0,
    milestones: {},
    final: {},
    samples: [],
  };
  window.__bootTrace = trace;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-paint') trace.milestones.firstPaint = Math.round(entry.startTime);
        if (entry.name === 'first-contentful-paint') {
          trace.milestones.firstContentfulPaint = Math.round(entry.startTime);
        }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch {
    // Paint Timing is not available everywhere; the frame samples still carry
    // the values this check gates on.
  }

  document.addEventListener('DOMContentLoaded', () => {
    trace.milestones.domContentLoaded = now();
    trace.splashAtDomContentLoaded = !!document.getElementById('boot-splash');
    if (trace.splashAtDomContentLoaded) trace.splashSeen = true;
  });
  window.addEventListener('load', () => {
    trace.milestones.load = now();
  });

  /**
   * True only when the element is actually painted where a user can see it:
   * laid out, not hidden, and the topmost element at its centre is the element
   * (or inside it). The boot splash is a fixed full-viewport layer with a high
   * z-index, so a fallback underneath it is in the DOM but NOT visible — which
   * is exactly the distinction this check exists to measure.
   */
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
      return false;
    }
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  }

  let lastSampleAt = null;
  let framesAfterRemoval = 0;
  let finished = false;

  function finish(status) {
    if (finished) return;
    finished = true;

    const splash = document.getElementById('boot-splash');
    const fallback = document.getElementById('tab-loading-fallback');
    const root = document.getElementById('root');

    if (trace.splashRemovedAt === null && !splash) trace.splashRemovedAt = now();

    trace.final = {
      splash: !!splash,
      splashAtDomContentLoaded: trace.splashAtDomContentLoaded,
      fallback: !!fallback,
      fallbackVisible: isVisible(fallback),
      spinner: !!document.getElementById('app-sync-spinner'),
      spinnerVisible: isVisible(document.getElementById('app-sync-spinner')),
      rootChildren: root ? root.childElementCount : 0,
      // The shell header/branch picker comes first in body text; the screen's
      // own heading lives in <main>, so read that separately.
      mainText: (document.querySelector('main')?.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500),
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600),
      activeTab: (() => {
        try {
          return localStorage.getItem('inventory_active_tab');
        } catch {
          return null;
        }
      })(),
    };

    // The splash can lift in the same task that commits the screen, before a
    // frame ever observes "splash + content". The final state then proves the
    // screen was already there; a truly exposed fallback is counted separately
    // by fallbackVisibleFrames and still fails the check.
    if (
      trace.contentReadyAt === null &&
      trace.fallbackVisibleFrames === 0 &&
      trace.spinnerVisibleFrames === 0 &&
      !trace.final.fallback &&
      !trace.final.spinner &&
      trace.final.rootChildren > 0
    ) {
      // The screen and the splash swap in the same task: no frame ever saw
      // "splash + content", but nothing was exposed either.
      trace.contentReadyAt = trace.splashRemovedAt;
    }

    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      trace.milestones.domContentLoaded ??= Math.round(nav.domContentLoadedEventEnd);
      trace.milestones.load ??= Math.round(nav.loadEventEnd);
    }
    const splashSeen = trace.splashSeen || trace.final.splashAtDomContentLoaded || !!splash;
    trace.splashSeen = splashSeen;
    trace.splashWindowMs = splashSeen ? trace.splashRemovedAt : null;
    trace.status = status;
    trace.finishedAt = now();
    // Keep the payload bounded if the page ever takes much longer than usual.
    if (trace.samples.length > 600) trace.samples = trace.samples.slice(-600);
  }

  function frame() {
    if (finished) return;
    const at = now();
    const splash = document.getElementById('boot-splash');
    const fallback = document.getElementById('tab-loading-fallback');
    const spinner = document.getElementById('app-sync-spinner');
    const root = document.getElementById('root');
    const rootChildren = root ? root.childElementCount : 0;
    const fallbackVisible = isVisible(fallback);
    const spinnerVisible = isVisible(spinner);

    if (splash) trace.splashSeen = true;
    if (fallback) trace.fallbackSeen = true;
    if (spinner) {
      trace.spinnerSeen = true;
      if (trace.firstSpinnerAt === null) trace.firstSpinnerAt = at;
    }
    if (fallbackVisible) {
      trace.fallbackVisibleFrames += 1;
      trace.fallbackVisibleMs += lastSampleAt === null ? 0 : at - lastSampleAt;
      if (trace.firstFallbackVisibleAt === null) trace.firstFallbackVisibleAt = at;
    }
    if (spinnerVisible) {
      trace.spinnerVisibleFrames += 1;
      trace.spinnerVisibleMs += lastSampleAt === null ? 0 : at - lastSampleAt;
    }
    if (!splash && (fallbackVisible || spinnerVisible)) trace.exposedLoadingFrames += 1;
    if (!splash && rootChildren === 0) trace.blankFrames += 1;
    if (rootChildren > 0 && trace.firstRootChildAt === null) trace.firstRootChildAt = at;
    if (fallback && trace.firstFallbackAt === null) trace.firstFallbackAt = at;
    if (!splash && trace.splashRemovedAt === null) trace.splashRemovedAt = at;
    if (splash && rootChildren > 0 && !fallback && !spinner && trace.contentReadyAt === null) {
      trace.contentReadyAt = at;
    }

    trace.frames += 1;
    trace.samples.push({
      t: at,
      splash: !!splash,
      fallback: !!fallback,
      fallbackVisible,
      rootChildren,
      spinner: !!spinner,
    });
    lastSampleAt = at;

    if (trace.splashRemovedAt !== null) {
      framesAfterRemoval += 1;
      if (framesAfterRemoval >= 6) {
        finish('done');
        return;
      }
    } else if (at > 10000) {
      finish('timeout');
      return;
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  setTimeout(() => {
    if (!finished) finish('timeout');
  }, 12000);
}

const PROBE_SOURCE = `(${bootTraceProbe.toString()})();`;

// ---------------------------------------------------------------------------
// Page driving
// ---------------------------------------------------------------------------
async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page exception: ${result.exceptionDetails.text}`);
  }
  return result.result?.value;
}

async function waitForEvaluation(expression, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch {
      // The execution context is replaced during navigation; retry.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readTrace() {
  const trace = await waitForEvaluation(
    'window.__bootTrace && window.__bootTrace.status !== "pending" ? window.__bootTrace : null',
    BOOT_TIMEOUT_MS,
    'the in-page boot trace'
  );
  return trace;
}

async function measureReload(label, { clearCache }) {
  // Drop the previous document's finished trace before navigating: otherwise
  // the first poll can read stale timings from the page that is being replaced.
  await evaluate('window.__bootTrace = null; true');
  if (clearCache) {
    await evaluate(`(() => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && (key.indexOf('inventory_bootstrap_v3') === 0 || key === 'inventory_recent_bootstrap_cache_v2')) {
          localStorage.removeItem(key);
        }
      }
      return true;
    })()`);
  }
  await cdp.send('Page.reload', { ignoreCache: false });
  const trace = await readTrace();
  log(pretty(label, trace));
  return trace;
}

function ms(value) {
  return value === null || value === undefined ? '—' : `${value} ms`;
}

function pretty(label, trace) {
  const m = trace.milestones || {};
  const lines = [
    label,
    `  first paint              ${ms(m.firstPaint)}`,
    `  first contentful paint   ${ms(m.firstContentfulPaint)}`,
    `  DOMContentLoaded         ${ms(m.domContentLoaded)}`,
    `  root mounted             ${ms(trace.firstRootChildAt)}`,
    `  fallback in DOM          ${ms(trace.firstFallbackAt)}`,
    `  fallback VISIBLE         ${trace.fallbackVisibleFrames} frame(s), ${Math.round(trace.fallbackVisibleMs)} ms`,
    `  spinner in DOM           ${ms(trace.firstSpinnerAt)}`,
    `  spinner VISIBLE          ${trace.spinnerVisibleFrames} frame(s), ${Math.round(trace.spinnerVisibleMs)} ms`,
    `  loading without splash   ${trace.exposedLoadingFrames} frame(s)`,
    `  blank without splash     ${trace.blankFrames} frame(s)`,
    `  screen committed         ${ms(trace.contentReadyAt)}`,
    `  splash removed           ${ms(trace.splashRemovedAt)}`,
    `  frames sampled           ${trace.frames}`,
  ];
  return lines.join('\n');
}

function assertTrace(label, trace, { requireNoSpinner = false } = {}) {
  const problems = [];
  if (trace.status !== 'done') problems.push(`trace ended as "${trace.status}" instead of done`);
  if (!trace.splashSeen) problems.push('the boot splash was never seen (missing from the served HTML?)');
  if (trace.splashRemovedAt === null) problems.push('the boot splash never lifted');
  if (trace.fallbackVisibleFrames > 0) {
    problems.push(
      `the lazy fallback was VISIBLE for ${trace.fallbackVisibleFrames} frame(s) ` +
        `(${Math.round(trace.fallbackVisibleMs)} ms) — the splash lifted before the screen committed`
    );
  }
  if (trace.spinnerVisibleFrames > 0) {
    problems.push(
      `the shell sync spinner was VISIBLE for ${trace.spinnerVisibleFrames} frame(s) ` +
        `(${Math.round(trace.spinnerVisibleMs)} ms) — the splash lifted before bootstrap/screen content`
    );
  }
  if (trace.blankFrames > 0) {
    problems.push(
      `the page was blank (empty #root) without the splash for ${trace.blankFrames} frame(s) — ` +
        `the splash lifted before anything painted`
    );
  }
  if (requireNoSpinner && trace.firstSpinnerAt !== null) {
    problems.push(
      `the shell spinner mounted at ${trace.firstSpinnerAt} ms on the warm reload — ` +
        `the cached bootstrap did not paint immediately`
    );
  }
  if (trace.contentReadyAt === null) problems.push('no real screen content committed before the splash lifted');
  if (trace.splashWindowMs !== null && trace.splashWindowMs > BUDGET_MS) {
    problems.push(`splash window ${trace.splashWindowMs} ms exceeds the ${BUDGET_MS} ms budget`);
  }
  if (trace.final?.splash) problems.push('the splash was still present at the end of the trace');
  if (trace.final?.fallback) problems.push('the lazy fallback was still mounted at the end of the trace');
  if (trace.final?.spinner) problems.push('the shell sync spinner was still mounted at the end of the trace');
  if ((trace.final?.rootChildren || 0) === 0) problems.push('the app root was empty at the end of the trace');
  const text = trace.final?.mainText || trace.final?.text || '';
  if (!text.includes(EXPECTED_SCREEN)) {
    problems.push(
      `the settled screen was not "${EXPECTED_SCREEN}" (got: "${text.slice(0, 200)}") — ` +
        `the saved session/tab did not restore`
    );
  }
  if (trace.final?.activeTab !== ACTIVE_TAB) {
    problems.push(`active tab was "${trace.final?.activeTab}" instead of "${ACTIVE_TAB}"`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) throw new Error('--budget-ms must be a positive number');
  if (hasFlag('--build')) {
    log('Building production bundles…');
    const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
    if (build.status !== 0) throw new Error('npm run build failed');
  } else if (!BASE_URL_ARG) {
    assertBuildExists();
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('This check needs Node.js 22+ for its built-in WebSocket (DevTools Protocol).');
  }

  const baseUrl = BASE_URL_ARG ? BASE_URL_ARG.replace(/\/$/, '') : await startProductionServer();
  if (!BASE_URL_ARG) {
    const builtAt = fs.statSync(path.join(ROOT, 'dist', 'index.html')).mtime;
    log(`Build: dist/index.html (${builtAt.toLocaleString()})`);
    if (!hasFlag('--build') && newestClientSourceMtime() > builtAt.getTime() + 1000) {
      log('⚠ dist/ is older than the newest client source — run with --build for a current measurement.\n');
    }
  }
  const session = await login(baseUrl);
  await pinActiveTabPreference(baseUrl, session);

  log(`\nProduction boot timing — ${baseUrl}`);
  log(`Account: ${EMAIL} · tab: ${ACTIVE_TAB} · splash budget: ${BUDGET_MS} ms\n`);

  await launchBrowser();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE });

  cdp.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || 'unknown exception');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params?.type !== 'error') return;
    const text = (params.args || [])
      .map((arg) => arg.value ?? arg.description ?? '')
      .join(' ')
      .trim();
    if (text) consoleErrors.push(text);
  });

  // First navigation is only a setup boot: it establishes the origin, then the
  // session/tab are written exactly as a real sign-in would write them, and the
  // measured reload restores both. Its signed-out 401s (the app still asks for
  // the BS calendar and settings before the login screen) are expected and are
  // dropped here so they cannot be attributed to the measured reloads.
  await cdp.send('Page.navigate', { url: baseUrl });
  await readTrace();
  pageErrors.length = 0;
  consoleErrors.length = 0;

  const seed = {
    user: JSON.stringify(session.user),
    root: JSON.stringify(session.user),
    token: session.token,
    tab: ACTIVE_TAB,
  };
  await evaluate(`(() => {
    localStorage.removeItem('inventory_session_logged_out');
    localStorage.setItem('inventory_auth_user', ${JSON.stringify(seed.user)});
    localStorage.setItem('inventory_root_user', ${JSON.stringify(seed.root)});
    localStorage.setItem('inventory_auth_token', ${JSON.stringify(seed.token)});
    localStorage.setItem('inventory_active_tab', ${JSON.stringify(seed.tab)});
    return true;
  })()`);

  const cold = await measureReload('Cold reload (no bootstrap cache)', { clearCache: true });
  await sleep(500); // let the app persist its bootstrap cache
  const warm = await measureReload('Warm reload (cached bootstrap)', { clearCache: false });

  if (pageErrors.length) {
    throw new Error(`uncaught page exception(s) during boot:\n${pageErrors.join('\n')}`);
  }
  if (consoleErrors.length) {
    log(`\nConsole errors during boot (${consoleErrors.length}), first few:`);
    for (const error of consoleErrors.slice(0, 5)) log(`  ${error.slice(0, 300)}`);
  }

  const problems = [
    ...assertTrace('cold reload', cold),
    ...assertTrace('warm reload', warm, { requireNoSpinner: true }),
  ];
  if (problems.length) {
    for (const problem of problems) console.error(`\n✖ ${problem}`);
    appendStepSummary([
      '### Production boot timing — failed',
      '',
      `- ${describeLaunchOutcome(browserLaunchAttempts)}`,
      ...problems.map((problem) => `- ${problem}`),
    ]);
    process.exitCode = 1;
    return;
  }

  const launchLine = describeLaunchOutcome(browserLaunchAttempts);
  log(
    `\n✔ Boot timing OK — no visible lazy fallback on either reload; ` +
      `splash lifted onto "${EXPECTED_SCREEN}" in ${cold.splashWindowMs} ms cold / ${warm.splashWindowMs} ms warm ` +
      `(budget ${BUDGET_MS} ms).`
  );
  log(`  ${launchLine} (limit ${BROWSER_LAUNCH_ATTEMPTS}).`);
  appendStepSummary([
    '### Production boot timing',
    '',
    `- ${launchLine}`,
    `- Splash lifted onto "${EXPECTED_SCREEN}" in ${cold.splashWindowMs} ms cold / ` +
      `${warm.splashWindowMs} ms warm (budget ${BUDGET_MS} ms).`,
  ]);
}

main()
  .catch((err) => fail(err?.message || String(err)))
  .finally(async () => {
    await restorePreference();
    cleanup();
    // Give the child processes a moment to die before the process exits so
    // Windows does not leave the temp profile locked.
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
