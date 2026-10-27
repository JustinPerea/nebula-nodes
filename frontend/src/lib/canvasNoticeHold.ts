/** How long a canvas notice with Undo or Redo stays up. Long enough to reach the button. */
export const NOTICE_HOLD_MS = 6000;

/** About 200 words a minute, for a notice with no button (a refusal line). */
const READ_CHARS_PER_SECOND = 18;

/** How long a canvas notice stays up: a notice with Undo or Redo keeps the
 * short hold; a written line with no button (a refusal such as "Couldn't
 * delete the node. A World Labs run is still starting. …") stays for its
 * reading time, never less (error copy round 3b). */
export function noticeHoldMs(text: string, offer: 'undo' | 'redo' | null): number {
  if (offer) return NOTICE_HOLD_MS;
  return Math.max(NOTICE_HOLD_MS, 2000 + Math.ceil((text.length / READ_CHARS_PER_SECOND) * 1000));
}
