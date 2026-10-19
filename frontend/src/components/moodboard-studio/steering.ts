import type { MoodboardImage } from '../../types';

/** The image fields the analysis reads (backend `source_hash`). Not the
 *  private note, and not the layout: moving or resizing a card keeps the
 *  analysis. */
export const STEERING_KEYS = ['url', 'weight', 'notes', 'excluded'] as const;

/** Whether a change to an image clears the board's analysis. */
export function patchSteers(patch: Partial<MoodboardImage>): boolean {
  return STEERING_KEYS.some((key) => key in patch);
}
