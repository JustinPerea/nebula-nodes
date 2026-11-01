/** A palette from a reference image, for the Inspector's "Extract from
 * reference" (the 'palette' param: a string[] of `#rrggbb`). Client-side
 * k-means on a downscaled canvas, so it needs no backend endpoint.
 *
 * When nothing comes out it says why, when it knows (GM - Design,
 * 2026-10-24): "If the two cases can't be told apart, use only the heading.
 * Don't guess the reason." */
import { quoted } from './canvasFileDrop';

/** Why an image gave no colours: the browser couldn't decode it, no pixel
 * is opaque enough to count (clear or faint alike, GM r5 on #208), or
 * something else (no 2d context, a canvas error, no pixels at all). */
export type PaletteFailure = 'decode' | 'transparent' | 'other';
export type PaletteResult = { ok: true; colors: string[] } | { ok: false; reason: PaletteFailure };

/** GM's copy: a heading naming the file, then the reason on its own line for
 * the two cases Nebula can tell; the heading alone for the rest. */
const REASONS: Partial<Record<PaletteFailure, string>> = {
  decode: "Nebula can't read this image. Try a PNG or JPEG.",
  transparent: 'This image is too transparent to pull colors from.',
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

/** A colour and how much of the image it covers (summed pixel weights). */
export type WeightedColor = { rgb: number[]; weight: number };

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0-255) to OKLab (Björn Ottosson, 2020). */
export function rgbToOklab(rgb: number[]): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance: Euclidean in OKLab (0 the same colour, about 1 black
 *  to white). */
export function deltaEOk(a: number[], b: number[]): number {
  const [l1, a1, b1] = rgbToOklab(a);
  const [l2, a2, b2] = rgbToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Swatches closer than this (OKLab ΔE) read as one colour and are merged.
 *  About two noticeable differences (a just-noticeable OKLab step is about
 *  0.02): on the 12 preset thumbnails and 10 golden board images the closest
 *  pair of swatches k-means keeps apart is far above it, while the copies
 *  k-means makes of one flat colour sit at 0 to 0.01 (see the notes for
 *  2026-10-31). */
export const MERGE_DELTA_E = 0.03;

/** ``colors`` with near-identical ones merged (OKLab ΔE under
 *  ``MERGE_DELTA_E``) and empty ones dropped: the closest pair first, each
 *  merge a weight-averaged colour whose weights add up. Ordered by weight,
 *  most first; a stable sort, so equal weights keep their order. */
export function mergeNearColors(colors: WeightedColor[], threshold = MERGE_DELTA_E): WeightedColor[] {
  const out = colors.filter((c) => c.weight > 0).map((c) => ({ rgb: [...c.rgb], weight: c.weight }));
  for (;;) {
    let pair: [number, number] | null = null;
    let closest = threshold;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = deltaEOk(out[i].rgb, out[j].rgb);
        if (d < closest) {
          closest = d;
          pair = [i, j];
        }
      }
    }
    if (!pair) break;
    const [i, j] = pair;
    const weight = out[i].weight + out[j].weight;
    out[i] = { rgb: out[i].rgb.map((v, n) => (v * out[i].weight + out[j].rgb[n] * out[j].weight) / weight), weight };
    out.splice(j, 1);
  }
  foldEdgeBlends(out, threshold);
  return out.sort((a, b) => b.weight - a.weight);
}

/** A swatch this small (share of the image) that sits on the line between
 *  two bigger swatches is their antialiased edge, not a colour of its own. */
export const EDGE_BLEND_SHARE = 0.05;

/** Fold each small swatch that is a mix of two bigger ones (within
 *  ``threshold``, in OKLab, of the sRGB segment between them, strictly
 *  between the ends) into the nearer of the two; weights add, the bigger one's colour
 *  stays. Smallest first. A small swatch that isn't such a mix (a real
 *  accent) stays. */
function foldEdgeBlends(out: WeightedColor[], threshold: number): void {
  const total = out.reduce((sum, c) => sum + c.weight, 0);
  for (;;) {
    const order = out.map((_, i) => i).sort((a, b) => out[a].weight - out[b].weight);
    let folded = false;
    for (const s of order) {
      if (out[s].weight >= EDGE_BLEND_SHARE * total) break;
      const p = out[s].rgb;
      let into = -1;
      let nearest = Infinity;
      for (let a = 0; a < out.length; a++) {
        for (let b = a + 1; b < out.length; b++) {
          if (a === s || b === s || out[a].weight <= out[s].weight || out[b].weight <= out[s].weight) continue;
          // An edge is mixed where the image is resampled, in sRGB values,
          // so the mix is the nearest point on the sRGB segment; how far the
          // swatch is from it is read in OKLab.
          const pa = out[a].rgb;
          const ab = out[b].rgb.map((v, n) => v - pa[n]);
          const len2 = ab.reduce((sum, v) => sum + v * v, 0);
          if (len2 === 0) continue;
          const t = ab.reduce((sum, v, n) => sum + v * (p[n] - pa[n]), 0) / len2;
          if (t <= 0 || t >= 1) continue;
          const off = deltaEOk(p, pa.map((v, n) => v + t * ab[n]));
          if (off < threshold && off < nearest) {
            nearest = off;
            into = t < 0.5 ? a : b;
          }
        }
      }
      if (into >= 0) {
        out[into] = { rgb: out[into].rgb, weight: out[into].weight + out[s].weight };
        out.splice(s, 1);
        folded = true;
        break;
      }
    }
    if (!folded) return;
  }
}

/** Deterministic k-means over RGB pixels, each counting by its weight (its
 *  alpha, ``pixelWeight``). Fixed initial centroids (evenly sampled) + fixed
 *  iteration count → stable output for the same image. With every weight 1
 *  (an opaque image) it is the unweighted k-means, number for number.
 *  Returns each centroid with the weight of the pixels nearest it, most
 *  first. */
export function kMeansColors(pixels: number[][], weights: number[], k: number, iterations = 8): WeightedColor[] {
  if (pixels.length === 0) return [];
  const clusterCount = Math.min(k, pixels.length);
  // Deterministic seeding: evenly spaced samples across the pixel list. A
  // sample of exactly the colour of a seed already taken would only split
  // that colour in two (a striped image gave six swatches of two colours),
  // so the next pixel along with a colour not yet taken is used instead;
  // with none left, fewer seeds. Seeds that already differ are exactly the
  // evenly spaced ones, so those images cluster as before.
  const centroids: number[][] = [];
  const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  for (let i = 0; i < clusterCount; i++) {
    const start = Math.floor((i * pixels.length) / clusterCount);
    for (let step = 0; step < pixels.length; step++) {
      const px = pixels[(start + step) % pixels.length];
      if (!centroids.some((c) => same(c, px))) {
        centroids.push([...px]);
        break;
      }
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    const sums = centroids.map(() => [0, 0, 0]);
    const counts = new Array(centroids.length).fill(0);
    pixels.forEach((px, index) => {
      const weight = weights[index];
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
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
    for (let c = 0; c < centroids.length; c++) {
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
  const finalCounts = new Array(centroids.length).fill(0);
  pixels.forEach((px, index) => {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < centroids.length; c++) {
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
    .map((c, i) => ({ rgb: c, weight: finalCounts[i] }))
    .sort((a, b) => b.weight - a.weight);
}

/** Up to `k` dominant colours of RGBA pixel data (straight alpha, as canvas
 *  `getImageData` gives it), or why there are none. Alpha counts as on the
 *  backend (``pixelWeight``). Near-identical colours are one swatch
 *  (``mergeNearColors``), so an image with two colours gives two, ordered by
 *  how much of the image each covers. */
export function paletteFromPixels(data: Uint8ClampedArray, k = 6): PaletteResult {
  const pixels: number[][] = [];
  const weights: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const weight = pixelWeight(data[i + 3]);
    if (weight === 0) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
    weights.push(weight);
  }
  if (pixels.length === 0) return { ok: false, reason: data.length > 0 ? 'transparent' : 'other' };
  const colors = mergeNearColors(kMeansColors(pixels, weights, k));
  return { ok: true, colors: colors.map(({ rgb }) => rgbToHex(rgb[0], rgb[1], rgb[2])) };
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
