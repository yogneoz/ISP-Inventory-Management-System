/**
 * Database availability errors (OPS-1).
 *
 * These are the only messages a caller may see when the database is busy or
 * unreachable. Driver text (host, port, SQL, socket detail) stays in the
 * server log; the response is a stable, retryable contract:
 *
 *   503 + Retry-After + { message, code: 'DB_BUSY' | 'DB_UNAVAILABLE' }
 */
import { ApiError } from './ApiError';
import { dbRetryAfterSeconds } from '../observability/dbBreaker';

/** The database is reachable but could not answer in time (pool/statement). */
export class DbBusyError extends ApiError {
  constructor(retryAfterSec = dbRetryAfterSeconds()) {
    super(503, 'The database is busy right now. Retry shortly.', {
      code: 'DB_BUSY',
      retryAfterSec,
    });
    this.name = 'DbBusyError';
  }
}

/** The database did not answer at all (unreachable or socket dropped). */
export class DbUnavailableError extends ApiError {
  constructor(retryAfterSec = dbRetryAfterSeconds()) {
    super(503, 'The database is temporarily unavailable. Retry shortly.', {
      code: 'DB_UNAVAILABLE',
      retryAfterSec,
    });
    this.name = 'DbUnavailableError';
  }
}
