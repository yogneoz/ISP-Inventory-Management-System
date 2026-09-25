/**
 * Numeric env-var guards (audit backlog #4 — the "PORT=0 trap" class).
 *
 * This deployment's shell harness exports an ambient PORT=0, and any CI/dev
 * environment can export empty or garbage numeric values. Naive parsing has
 * bitten this project repeatedly:
 *   - `Number('')` is 0 and `Number('12x')` is NaN → silent misconfiguration
 *   - `parseInt('8abc')` is 8 → silently ignores the invalid tail
 *   - `express.json({ limit: 0 })` or a NaN limit either rejects every
 *     request or behaves unpredictably
 *
 * This module gives every numeric/size env var ONE hardened parsing path:
 *   - intFromEnv(name, fallback, {min, max}) — strict integer, whole string
 *     must parse (no trailing garbage), clamped into [min,max], logs a
 *     warning and uses the fallback when invalid
 *   - sizeFromEnv(name, fallback, {minBytes}) — body-parser size strings
 *     ('25mb', '1024kb', plain byte numbers); invalid forms fall back with
 *     a warning
 * Invalid values NEVER crash the server and NEVER silently produce 0/NaN —
 * they warn and fall back, so a typo in .env is visible in the logs but
 * cannot take the API down.
 */

function warnInvalid(name: string, raw: string | undefined, fallback: string): void {
  console.warn(
    `⚠️  Env var ${name}=${JSON.stringify(raw ?? '')} is invalid — using fallback ${fallback}.`
  );
}

/**
 * Strictly parse an integer env var. The ENTIRE value must be an integer
 * ('08' ok, '8x' rejected, '' rejected, '0' parsed then range-checked).
 * Returns the clamped value, or `fallback` when unset/invalid.
 */
export function intFromEnv(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {}
): number {
  const { min = -Infinity, max = Infinity } = opts;
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const trimmed = String(raw).trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    warnInvalid(name, raw, String(fallback));
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    warnInvalid(name, raw, String(fallback));
    return fallback;
  }
  if (parsed < min || parsed > max) {
    console.warn(
      `⚠️  Env var ${name}=${JSON.stringify(raw)} is out of range [${min}, ${max}] — using fallback ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

/**
 * Parse a body-parser size string ('25mb', '512kb', '1048576') into bytes.
 * Accepts exactly the forms body-parser accepts (bytes / kb / mb / gb,
 * case-insensitive, optional 'B' suffix). Returns null when invalid —
 * callers decide the fallback.
 */
export function sizeToBytes(raw: string): number | null {
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (m[2] || 'b').toLowerCase();
  const multiplier = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : unit === 'gb' ? 1024 ** 3 : 1;
  return Math.round(value * multiplier);
}

/**
 * Read a body-parser size env var ('1mb' style). Invalid or below-minimum
 * values warn and fall back.
 */
export function sizeFromEnv(
  name: string,
  fallback: string,
  opts: { minBytes?: number } = {}
): string {
  const { minBytes = 1 } = opts;
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const bytes = sizeToBytes(String(raw));
  if (bytes == null || bytes < minBytes) {
    warnInvalid(name, raw, fallback);
    return fallback;
  }
  return String(raw).trim();
}
