/**
 * SCALE-2 — opaque keyset cursor contract.
 *
 * Large tables are read by a stable composite key instead of LIMIT/OFFSET so a
 * row inserted or removed between two page reads can never shift later rows
 * (the duplicate/skip failure of offset pagination). The cursor carries only
 * the last row's key values, is base64url-encoded and HMAC-signed, and is
 * bound to the endpoint's table name so a cursor from one register cannot be
 * replayed against another.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type CursorScalar = string | number;
export type CursorValues = CursorScalar[];

interface CursorBody {
  v: 1;
  t: string;
  k: CursorValues;
}

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 2048;

function cursorSecret(): string {
  return (
    process.env.KEYSET_CURSOR_SECRET ||
    process.env.AUTH_TOKEN_SECRET ||
    'isp-keyset-cursor-v1-development'
  );
}

function sign(body: string): string {
  return createHmac('sha256', cursorSecret()).update(body).digest('base64url');
}

/** Encodes the last row's composite key as an opaque, signed cursor. */
export function encodeKeysetCursor(table: string, key: CursorValues): string {
  const body = Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, t: table, k: key } satisfies CursorBody),
    'utf8'
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Decodes and validates a cursor. Returns null for anything malformed, signed
 * with another secret, issued for another table, or carrying the wrong number
 * of key values. Callers answer a 400 rather than silently starting over,
 * because starting over can duplicate rows on an infinite-scroll register.
 */
export function decodeKeysetCursor(
  raw: unknown,
  table: string,
  arity: number
): CursorValues | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_CURSOR_LENGTH) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = sign(body);
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorBody;
    if (parsed?.v !== CURSOR_VERSION || parsed?.t !== table || !Array.isArray(parsed.k)) {
      return null;
    }
    if (parsed.k.length !== arity) return null;
    if (!parsed.k.every((value) => typeof value === 'string' || typeof value === 'number')) {
      return null;
    }
    return parsed.k;
  } catch {
    return null;
  }
}

/** Clamped page size for keyset reads; the cap is the register's hard bound. */
export function keysetLimit(value: unknown, fallback = 50, max = 500): number {
  const requested = Math.floor(Number(value));
  return Number.isFinite(requested) && requested > 0
    ? Math.min(max, requested)
    : fallback;
}

/** Converts a pg timestamp/date value to the text form used by a cursor. */
export function cursorTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? '');
  // A calendar day column (::date) is already a stable YYYY-MM-DD string.
  return text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text) ? text : text;
}

/**
 * Lexicographic row comparison for a composite key, appending its parameters.
 * `columns` may be expressions (e.g. COALESCE) as long as they match `dir`.
 */
export function keysetPredicate(
  columns: string[],
  dir: 'ASC' | 'DESC',
  values: CursorValues,
  params: unknown[]
): string {
  const placeholders = values.map((value) => {
    params.push(value);
    return `$${params.length}`;
  });
  return `(${columns.join(', ')}) ${dir === 'DESC' ? '<' : '>'} (${placeholders.join(', ')})`;
}

/**
 * The one response shape for keyset reads. `data`/`page`/`pageSize` remain as
 * compatibility aliases while the paged registers migrate to `items`.
 */
export function keysetEnvelope<T>(
  items: T[],
  nextCursor: string | null,
  hasMore: boolean,
  extra: Record<string, unknown> = {}
): Record<string, unknown> & {
  items: T[];
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  return {
    ...extra,
    items,
    data: items,
    page: 1,
    pageSize: items.length,
    nextCursor,
    hasMore,
  };
}

/**
 * SCALE-2 scope guard for an unbounded large-table read. A national table may
 * only be read without a branch when the request also carries a date/FY
 * predicate; otherwise the caller must name a branch. `code` is stable so the
 * client can show a scope picker instead of a generic error.
 */
export function requireLargeTableScope(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  options: { branchId?: unknown; dateFrom?: unknown; dateTo?: unknown; report: boolean }
): boolean {
  if (!options.report) return true;
  const branch = typeof options.branchId === 'string' ? options.branchId.trim() : '';
  const hasBranch = Boolean(branch) && branch !== 'ALL';
  const hasFrom = typeof options.dateFrom === 'string' && options.dateFrom.trim() !== '';
  const hasTo = typeof options.dateTo === 'string' && options.dateTo.trim() !== '';
  if (hasBranch || (hasFrom && hasTo)) return true;
  res.status(400).json({
    code: 'SCOPE_REQUIRED',
    message:
      'This request needs a branch_id or a bounded date range. Add one and retry; ' +
      'a national table is never read without a scope.',
  });
  return false;
}
