/** A palette from a reference image, for the Inspector's "Extract from
 * reference" (the 'palette' param: a string[] of `#rrggbb`). Client-side
 * k-means on a downscaled canvas, so it needs no backend endpoint.
 *
 * When nothing comes out it says why, when it knows (GM - Design,
 * 2026-10-24): "If the two cases can't be told apart, use only the heading.
 * Don't guess the reason." */
import { quoted } from './canvasFileDrop';

/** Why an image gave no colours: the browser couldn't decode it, every
 * pixel is fully transparent, or something else (no 2d context, a canvas
 * error, an image too faint to read but not clear). */
export type PaletteFailure = 'decode' | 'transparent' | 'other';
export type PaletteResult = { ok: true; colors: string[] } | { ok: false; reason: PaletteFailure };

/** GM's copy: a heading naming the file, then the reason on its own line for
 * the two cases Nebula can tell; the heading alone for the rest. */
const REASONS: Partial<Record<PaletteFailure, string>> = {
  decode: "Nebula can't read this image. Try a PNG or JPEG.",
  transparent: 'The image is fully transparent.',
};

export function paletteNotice(fileName: string, reason: PaletteFailure): string {
  const heading = `Couldn't find colors in ${quoted(fileName)}.`;
  const line = REASONS[reason];
  return line ? `${heading}\n${line}` : heading;
}

/** The backend's rule (cinema/color.py ``ALPHA_MIN``): a pixel under this
 *  alpha (of 255) isn't counted, and the rest count by alpha / 255, so a
 *  half-transparent pixel is half a pixel. contracts/fixtures/colour/alpha.json
 *  holds the number; tests on both sides check it, so the two can't drift. */
export const ALPHA_MIN = 16;

/** How much a pixel with this alpha counts: alpha / 255, or 0 under ALPHA_MIN. */
export function pixelWeight(alpha: number): number {
  return alpha < ALPHA_MIN ? 0 : alpha / 255;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Deterministic k-means over RGB pixels, each counting by its weight (its
 *  alpha, ``pixelWeight``). Fixed initial centroids (evenly sampled) + fixed
 *  iteration count → stable output for the same image. With every weight 1
 *  (an opaque image) it is the unweighted k-means, number for number. */
function kMeansColors(pixels: number[][], weights: number[], k: number, iterations = 8): number[][] {
  if (pixels.length === 0) return [];
  const clusterCount = Math.min(k, pixels.length);
  // Deterministic seeding: evenly spaced samples across the pixel list.
  const centroids: number[][] = [];
  for (let i = 0; i < clusterCount; i++) {
    const idx = Math.floor((i * pixels.length) / clusterCount);
    centroids.push([...pixels[idx]]);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const sums = centroids.map(() => [0, 0, 0]);
    const counts = new Array(clusterCount).fill(0);
    pixels.forEach((px, index) => {
      const weight = weights[index];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < clusterCount; c++) {
        const dr = px[0] - centroids[c][0];
        const dg = px[1] - centroids[c][1];
        const db = px[2] - centroids[c][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      sums[best][0] += px[0] * weight;
      sums[best][1] += px[1] * weight;
      sums[best][2] += px[2] * weight;
      counts[best] += weight;
    });
    for (let c = 0; c < clusterCount; c++) {
      if (counts[c] > 0) {
        centroids[c] = [
          sums[c][0] / counts[c],
          sums[c][1] / counts[c],
          sums[c][2] / counts[c],
        ];
      }
    }
  }

  // Order clusters by population (most-dominant first) for a stable, useful order.
  const finalCounts = new Array(clusterCount).fill(0);
  pixels.forEach((px, index) => {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < clusterCount; c++) {
      const dr = px[0] - centroids[c][0];
      const dg = px[1] - centroids[c][1];
      const db = px[2] - centroids[c][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    finalCounts[best] += weights[index];
  });
  return centroids
    .map((c, i) => ({ c, n: finalCounts[i] }))
    .sort((a, b) => b.n - a.n)
    .map((entry) => entry.c);
}

/** The `k` dominant colours of RGBA pixel data (straight alpha, as canvas
 *  `getImageData` gives it), or why there are none. Alpha counts as on the
 *  backend (``pixelWeight``). */
export function paletteFromPixels(data: Uint8ClampedArray, k = 6): PaletteResult {
  const pixels: number[][] = [];
  const weights: number[] = [];
  let anyAlpha = false;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] > 0) anyAlpha = true;
    const weight = pixelWeight(data[i + 3]);
    if (weight === 0) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
    weights.push(weight);
  }
  if (pixels.length === 0) return { ok: false, reason: data.length > 0 && !anyAlpha ? 'transparent' : 'other' };
  return { ok: true, colors: kMeansColors(pixels, weights, k).map((c) => rgbToHex(c[0], c[1], c[2])) };
}

/** Decode the picked file, downscale it onto a canvas and find its `k`
 * dominant colours. The file is read from the person's own copy, so a
 * failed load is a failed decode, never the network. */
export async function extractPaletteFromImage(file: Blob, k = 6): Promise<PaletteResult> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
    if (!img) return { ok: false, reason: 'decode' };
    // Decoded but with no size (an SVG without one): not a decode failure.
    if (!img.width || !img.height) return { ok: false, reason: 'other' };
    const maxDim = 96;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reason: 'other' };
    ctx.drawImage(img, 0, 0, w, h);
    return paletteFromPixels(ctx.getImageData(0, 0, w, h).data, k);
  } catch {
    return { ok: false, reason: 'other' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
