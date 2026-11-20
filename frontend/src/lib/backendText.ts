/**
 * Marks a string as the backend's exact words, kept only to match a response (read with
 * `.get(detail)`, never shown). The straight-apostrophe ratchet skips text inside it, since the
 * backend writes straight ones. A key is matched with apostrophes folded (errorCopy's foldApostrophes,
 * on the key and on the response), so a key may be written with either. Never wrap shown copy: a test
 * (tests/lib/backendText.guard.test.ts) allows it only as a key of errorCopy's match tables, and
 * checks each key against the backend source.
 */
export function backendText(text: string): string {
  return text;
}
