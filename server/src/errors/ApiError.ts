/**
 * Structured API error. Handlers and services throw this instead of hand-
 * rolling `res.status(...).json({ message })`; the central error middleware
 * (errorHandler.ts) converts it into the exact same HTTP response shape the
 * codebase has always produced, so behavior is preserved.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
