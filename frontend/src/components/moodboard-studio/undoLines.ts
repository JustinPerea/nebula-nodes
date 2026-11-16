/**
 * The undo and redo toasts' words (design r160 answer 3, r161). No colon:
 * "Undid “Made image 3 the cover”". An undo that could not be applied because
 * an image changed after the step says so instead of "Undid" (one sentence for
 * every step kind, the add included) and offers no Redo.
 */

/** "Undid “Made image 3 the cover”" or "Redid “…”". */
export function undoneLine(direction: 'undo' | 'redo', label: string): string {
  return `${direction === 'undo' ? 'Undid' : 'Redid'} “${label}”`;
}

interface SkippedSlice { reason?: unknown; number?: unknown }

/** "image 5", "images 5 and 6", "images 3, 5 and 6". */
function imageNumbers(numbers: readonly number[]): string {
  if (numbers.length === 1) return `image ${numbers[0]}`;
  return `images ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/**
 * "Nebula couldn’t undo “Added image 5” because image 5 changed after that."
 * for an undo that put nothing back and left slices because their image
 * changed after the step; null when the skipped slices are anything else (the
 * server's own lines then stay under "Undid").
 */
export function keptUndoLine(label: string, skipped: readonly SkippedSlice[]): string | null {
  if (skipped.length === 0) return null;
  const numbers: number[] = [];
  for (const slice of skipped) {
    if (slice.reason !== 'changed since' || typeof slice.number !== 'number') return null;
    if (!numbers.includes(slice.number)) numbers.push(slice.number);
  }
  return `Nebula couldn’t undo “${label}” because ${imageNumbers(numbers.sort((a, b) => a - b))} changed after that.`;
}
