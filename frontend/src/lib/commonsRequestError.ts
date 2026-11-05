import { RequestFailedError } from './errorCopy';

/**
 * A Commons request that failed, with its HTTP status: 0 when there was no
 * answer at all (a lost connection), 401 when there is no session to send.
 * Like every request's error (lib/errorCopy.ts, GM - Design error-copy) it
 * carries a heading naming the call ("Couldn't save your labels."), a reason
 * line (GM's line for no answer, 408, 429 and 5xx, else the backend's own
 * written reason, else GM's line for the status) and its kind; `message` is
 * the one-line form. The raw answer stays for debugging: `detail` is what
 * the backend sent, `cause` the error behind a lost connection. The
 * Commons' leave popover reads the status to offer Save and leave again
 * only when saving again could work.
 */
export class CommonsRequestError extends RequestFailedError {
  constructor(reason: string, status: number,
    options: { cause?: unknown; detail?: unknown; heading?: string; code?: string | null; sentAt?: number | null } = {}) {
    const { heading = '', ...rest } = options;
    super(heading, status, { ...rest, reason });
    this.name = 'CommonsRequestError';
  }
}
