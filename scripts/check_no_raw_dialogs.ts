/**
 * Client-layer guard: fails when `client/src` calls a native blocking dialog
 * (`alert` / `confirm` / `prompt` / `window.alert` / `window.confirm` /
 * `window.prompt`) instead of the in-app `useDialog()` API.
 *
 * Why this exists: `DialogProvider` used to monkey-patch `window.alert`, which
 * hid the ~100 raw call sites migrated on 2026-10-05 and would hide any new
 * ones too. The patch is gone — every dialog now flows through the provider's
 * modal — so a raw call would either show the browser-native box or (for
 * confirm/prompt) block the main thread. This guard keeps the migration
 * permanent.
 *
 * The allowed forms are:
 *  - `alertDialog(...)` / `confirmDialog(...)` / `promptDialog(...)` from
 *    `const { alert: alertDialog, confirm: confirmDialog, ... } = useDialog()`
 *    (the suffixed names are the repo convention, matching `confirmDialog`
 *    that already existed before the migration), and
 *  - `utilityAlert(...)` — the `DialogProvider` bridge for non-component
 *    modules such as `utils/exportUtils` that cannot call hooks.
 *
 * Detection is deliberately lexical (no TS parser dependency): comment-only
 * lines are skipped (the `DialogProvider` docs quote `alert(...)`) and the
 * patterns require `(` directly after the identifier, so `alertDialog(`,
 * `confirmDialog(`, `promptDialog(` and `utilityAlert(` never match.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RawDialogViolation {
  file: string;
  line: number;
  snippet: string;
}

/**
 * A native dialog call: the identifier directly followed by `(`, not preceded
 * by an identifier character (so `myAlert(` never matches) and either bare or
 * behind `window.`. Case-sensitive: `utilityAlert(` carries a capital A.
 */
const NATIVE_DIALOG_CALL = /(?<![A-Za-z0-9_$])(?:window\.)?(alert|confirm|prompt)\s*\(/;

/** Comment-only lines carry doc examples like `await alert('...')`. */
function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('{/*')
  );
}

/**
 * Pure detection core: returns one violation per source line containing a
 * native dialog call outside comments.
 */
export function findRawDialogCalls(source: string, fileLabel: string): RawDialogViolation[] {
  const violations: RawDialogViolation[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) return;
    if (NATIVE_DIALOG_CALL.test(line)) {
      violations.push({ file: fileLabel, line: idx + 1, snippet: trimmed });
    }
  });
  return violations;
}

function collectClientFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectClientFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** CLI entry: scans client/src (or argv paths) and exits 1 on any violation. */
export function runAsScript(argv: string[] = process.argv.slice(2)): number {
  const targets = argv.length
    ? argv
    : [path.resolve(process.cwd(), 'client', 'src')];

  const files: string[] = [];
  for (const target of targets) {
    if (fs.statSync(target).isDirectory()) files.push(...collectClientFiles(target));
    else files.push(target);
  }

  const violations: RawDialogViolation[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    violations.push(...findRawDialogCalls(source, path.relative(process.cwd(), file)));
  }

  if (violations.length > 0) {
    console.error(`✖ raw-dialog violation: native alert/confirm/prompt found in ${violations.length} place(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}\n    ${v.snippet}\n`);
    }
    console.error(
      'Use the useDialog() hook (alertDialog / confirmDialog / promptDialog) in components, or utilityAlert() from DialogProvider in non-component modules.'
    );
    return 1;
  }

  console.log(`✅ No native alert/confirm/prompt call sites in ${files.length} client file(s).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check_no_raw_dialogs.ts')) {
  process.exit(runAsScript());
}
