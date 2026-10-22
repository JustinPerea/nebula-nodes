import { failureKind, type FailureKind } from './errorCopy';

/**
 * A Commons request that failed, with its HTTP status: 0 when there was no
 * answer at all (a lost connection), 401 when there is no session to send.
 * Its message is copy, ready to show (lib/errorCopy.ts, GM - Design
 * error-copy): GM's line for no answer, 408, 429 and 5xx, else the
 * backend's own reason. The raw answer stays for debugging: `detail` is what
 * the backend sent, `cause` the error behind a lost connection. The
 * Commons' leave popover reads the status to offer Save and leave again
 * only when saving again could work.
 */
export class CommonsRequestError extends Error {
  readonly status: number;
  /** The backend's `detail` as it came (a string, FastAPI's field list, or nothing). */
  readonly detail: unknown;

  constructor(message: string, status: number, options: { cause?: unknown; detail?: unknown } = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'CommonsRequestError';
    this.status = status;
    this.detail = options.detail;
  }

  get kind(): FailureKind {
    return failureKind(this.status);
  }
}
