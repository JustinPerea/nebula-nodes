import type { MoodboardImage } from '../types';

/**
 * A board's cover: the image it opens on, its picture on the canvas card, in
 * the Studio's rail and in lists (backend services/moodboard_store.py,
 * contract 07 section 1.1). A pick, not a reorder: no image changes number.
 * The chosen image (`coverImageId`) when it is on the board, else #1.
 */
export interface BoardCover {
  id: string;
  /** Its board number (#n, its place in `images`). */
  number: number;
  /** False when nobody picked one, so the board opens on #1. */
  chosen: boolean;
}

export function boardCover(images: readonly Pick<MoodboardImage, 'id'>[], coverImageId: string | null | undefined):
  BoardCover | null {
  const index = coverImageId ? images.findIndex((image) => image.id === coverImageId) : -1;
  if (index >= 0) return { id: images[index].id, number: index + 1, chosen: true };
  return images.length ? { id: images[0].id, number: 1, chosen: false } : null;
}

/** The url the board opens on, as the backend's `thumbnail` reads it. */
export function coverUrl(images: readonly Pick<MoodboardImage, 'id' | 'url'>[], coverImageId: string | null | undefined): string {
  const cover = boardCover(images, coverImageId);
  return cover ? images[cover.number - 1].url : '';
}
