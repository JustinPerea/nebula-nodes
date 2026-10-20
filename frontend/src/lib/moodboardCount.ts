import type { MoodboardImage } from '../types';

type SetAsideFields = Partial<Pick<MoodboardImage, 'excluded' | 'weight'>>;

/** Set aside: the person's switch (stored as `excluded`), or weight 0,
 *  which steers nothing either. A set-aside image is still read for its
 *  colours; it never steers. An image with no weight steers at full weight,
 *  as the backend reads it (moodboard_analysis.steers). */
export function isSetAside(image: SetAsideFields): boolean {
  return image.excluded === true || (typeof image.weight === 'number' && !(image.weight > 0));
}

export function setAsideCount(images: readonly SetAsideFields[]): number {
  return images.filter(isSetAside).length;
}

/** A board's image count wherever it shows (the node card, the Studio rail,
 *  the Assets panel): "5 images · 1 set aside". Every image counts, so the
 *  set-aside ones are named beside it; the Preview counts only the images
 *  that steer, the same rule (lib/moodboardBundle): "4 images" beside
 *  "5 images · 1 set aside", whether #n was switched aside or is at weight 0. */
export function moodboardImagesLabel(count: number, setAside = 0): string {
  const images = `${count} ${count === 1 ? 'image' : 'images'}`;
  return setAside > 0 ? `${images} · ${setAside} set aside` : images;
}
