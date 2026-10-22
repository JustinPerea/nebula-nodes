/**
 * A Commons request the backend refused, with its HTTP status (401 when there
 * is no session to send). A failure with no answer at all (a lost
 * connection) is a plain error. The Commons' leave popover reads the status
 * to offer Save and leave again only when saving again could work.
 */
export class CommonsRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CommonsRequestError';
    this.status = status;
  }
}
