/**
 * A refusal an operator can act on, carrying the HTTP status the controller
 * must answer with. Availability checks use it so "not enough stock" surfaces
 * as a clean 400 with available/requested numbers instead of the generic
 * `500 Database error: …` the guarded UPDATE used to produce.
 */
export class OperationError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

/** Maps any thrown error to the status/message a controller should send. */
export function errorResponse(err: any): { status: number; message: string } {
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    return { status: err.status, message: String(err.message) };
  }
  return { status: 500, message: `Database error: ${err?.message}` };
}
