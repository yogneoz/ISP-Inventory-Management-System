/**
 * Structured API error. Handlers and services throw this instead of hand-
 * rolling `res.status(...).json({ message })`; the central error middleware
 * (errorHandler.ts) converts it into the exact same HTTP response shape the
 * codebase has always produced, so behavior is preserved.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Stable machine-readable code for retryable availability errors. */
  readonly code?: string;
  /** Seconds the caller should wait before retrying; emitted as Retry-After. */
  readonly retryAfterSec?: number;

  constructor(
    status: number,
    message: string,
    options: { code?: string; retryAfterSec?: number } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = options.code;
    this.retryAfterSec = options.retryAfterSec;
  }
}
