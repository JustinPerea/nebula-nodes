import type { MoodboardImage } from '../types';

/** Room between cards dropped together, in board pixels. */
export const DROP_GAP = 24;

/** Where files dropped at `at` go: one card centred on it; more in a row
 *  centred on it, their middles on one line, `DROP_GAP` apart. Top-left
 *  corners, in whole board pixels (what `add`'s `at` takes). */
export function dropLayout(at: { x: number; y: number }, sizes: ReadonlyArray<readonly [number, number]>): Array<{ x: number; y: number }> {
  const total = sizes.reduce((sum, [w]) => sum + w, 0) + DROP_GAP * Math.max(0, sizes.length - 1);
  let left = at.x - total / 2;
  return sizes.map(([w, h]) => {
    const spot = { x: Math.round(left), y: Math.round(at.y - h / 2) };
    left += w + DROP_GAP;
    return spot;
  });
}

/** A dropped file's aspect (width / height), read in the browser before the
 *  upload so its card shows at the size the server will give it. NaN when
 *  it can't be read; the card then takes the default aspect until the board
 *  comes back. */
export function readImageAspect(file: File, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    let url = '';
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(Number.NaN);
      return;
    }
    const img = new Image();
    let done = false;
    const finish = (aspect: number) => {
      if (done) return;
      done = true;
      try { URL.revokeObjectURL(url); } catch { /* already gone */ }
      resolve(aspect);
    };
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : Number.NaN);
    img.onerror = () => finish(Number.NaN);
    window.setTimeout(() => finish(Number.NaN), timeoutMs);
    img.src = url;
  });
}

/** A new board's images as its first save sends them: a card the Studio drew
 *  where a file was dropped goes as its place only (`x`, `y`), so the server
 *  gives it a real id and its own size. */
export function provisionalForCreate<I extends Pick<MoodboardImage, 'placements'>>(images: I[]): I[] {
  return images.map((image) => {
    if (!image.placements?.some((card) => card.id.startsWith('new-'))) return image;
    return { ...image, placements: image.placements.map((card) => (card.id.startsWith('new-')
      ? { frameId: card.frameId ?? null, x: card.x, y: card.y } : card)) as MoodboardImage['placements'] };
  });
}
