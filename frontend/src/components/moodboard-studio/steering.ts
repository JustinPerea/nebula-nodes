import type { MoodboardImage } from '../../types';

/** The image fields the analysis reads (backend `source_hash`). Not the
 *  private note, and not the layout: moving or resizing a card keeps the
 *  analysis. */
export const STEERING_KEYS = ['url', 'weight', 'notes', 'excluded'] as const;

/** Whether a change to an image clears the board's analysis. */
export function patchSteers(patch: Partial<MoodboardImage>): boolean {
  return STEERING_KEYS.some((key) => key in patch);
}

/** Set aside (the switch, or weight 0): one rule for the Studio and every
 *  image count (lib/moodboardCount). */
export { isSetAside } from '../../lib/moodboardCount';

/** The weight an image's card shows: its largest card's (the board weight
 *  is the largest copy's), else full weight, as a weight-0 card is laid out
 *  at full size. */
export function cardWeight(image: Pick<MoodboardImage, 'placements'>): number {
  const weights = (image.placements ?? []).map((card) => card.weight).filter((weight) => weight > 0);
  return weights.length ? Math.min(1, Math.max(...weights)) : 1;
}

/** What the Set aside switch changes. On keeps the weight and the card;
 *  off uses the image again, and one at weight 0 takes its card's weight. */
export function setAsidePatch(image: MoodboardImage, on: boolean): Partial<MoodboardImage> {
  if (on) return { excluded: true };
  return image.weight > 0 ? { excluded: false } : { excluded: false, weight: cardWeight(image) };
}
