/**
 * Marks a string as the backend's exact words, kept only to match a response (read with
 * `.get(detail)`, never shown). The straight-apostrophe ratchet skips text inside it, since the
 * backend writes straight ones and the match must be exact. Never wrap shown copy: a test
 * (tests/lib/backendText.guard.test.ts) allows it only as a key of errorCopy's match tables, and
 * checks each key against the backend source.
 */
export function backendText(text: string): string {
  return text;
}
