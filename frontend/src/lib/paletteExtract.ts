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

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

// sRGB to CIELAB (D65) exactly as backend/cinema/color.py ``rgb_to_lab``
// computes it, and CIEDE2000 as backend/commons/colour.py ``delta_e00`` does:
// Extract merges swatches the way the moodboard palette does
// (commons/measure.py ``_merge``), so the two agree on what "the same
// colour" is. contracts/fixtures/colour/delta_e00.json is the table both
// sides are tested against, so they can't drift.
const XYZ_WHITE = [0.95047, 1.0, 1.08883];
const RGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const LAB_EPS = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

/** sRGB (0-255) to CIELAB (L 0-100), as cinema.color.rgb_to_lab. */
export function rgbToLab(rgb: number[]): [number, number, number] {
  const lin = rgb.map(srgbToLinear);
  const f = (t: number) => (t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const [fx, fy, fz] = RGB_TO_XYZ.map((row, i) => f((row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) / XYZ_WHITE[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;
const mod360 = (x: number) => ((x % 360) + 360) % 360;

/** CIEDE2000 between two Lab colours, as commons.colour.delta_e00. */
export function deltaE00Lab(lab1: number[], lab2: number[]): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cbar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = mod360(Math.atan2(b1, a1p) / DEG);
  const h2p = mod360(Math.atan2(b2, a2p) / DEG);
  const zero = c1p * c2p === 0;

  const dLp = L2 - L1;
  const dCp = c2p - c1p;
  let dhp = h2p - h1p;
  if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  if (zero) dhp = 0;
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * DEG);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (c1p + c2p) / 2;
  const hsum = h1p + h2p;
  let hbp = Math.abs(h1p - h2p) > 180 ? (hsum < 360 ? (hsum + 360) / 2 : (hsum - 360) / 2) : hsum / 2;
  if (zero) hbp = hsum;

  const t = 1 - 0.17 * Math.cos((hbp - 30) * DEG) + 0.24 * Math.cos(2 * hbp * DEG)
    + 0.32 * Math.cos((3 * hbp + 6) * DEG) - 0.2 * Math.cos((4 * hbp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const sc = 1 + 0.045 * Cbp;
  const sh = 1 + 0.015 * Cbp * t;
  const rt = -Math.sin(2 * dTheta * DEG) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

/** CIEDE2000 between two sRGB (0-255) colours: 0 the same colour, about 1 a
 *  just-noticeable step, 100 black to white. */
export function deltaE00(a: number[], b: number[]): number {
  return deltaE00Lab(rgbToLab(a), rgbToLab(b));
}

/** Swatches closer than this (CIEDE2000) read as one colour and are merged:
 *  about two just-noticeable steps. The metric is the moodboard palette's
 *  (backend commons/measure.py ``_merge``); plain OKLab, used before (at
 *  0.03), had no lightness toe and put #000000 and #010101 twice its
 *  threshold apart, so a noisy black gave three or four black swatches
 *  (review 3, M1). CIEDE2000 puts the blacks of a noisy black 0.2 to 1.2
 *  apart. The backend merges at 5 (``EDGE_LINE_DELTA_E``); at 5 Extract also
 *  merged the three whites of studio-product.webp (2.5 to 5.5 apart, which
 *  GM signed off as three) and two to three tones of most photos, so Extract
 *  keeps 2 (see the notes for round 4). */
export const MERGE_DELTA_E = 2;

/** A swatch under this share of the image is a speck, not a colour of its
 *  own, when it is within ``EDGE_LINE_DELTA_E`` of a bigger swatch: it goes
 *  into the nearest one. The backend's ``ACCENT_MIN_SHARE``
 *  (commons/measure.py): it shows no colour that covers less. */
export const SPECK_SHARE = 0.001;

/** A colour, how much of the image it covers (summed pixel weights) and,
 *  when it came from an image, which k-means clusters it holds. */
export type WeightedColor = { rgb: number[]; weight: number; members?: number[] };

/** The share (0-1) of the pixels of the clusters ``swatch`` that sit next to
 *  both a pixel of ``a`` and one of ``b``: the evidence that the swatch is
 *  their antialiased edge. */
export type EdgeEvidence = (swatch: number[], a: number[], b: number[]) => number;

/** ``colors`` with near-identical ones merged (CIEDE2000 under
 *  ``MERGE_DELTA_E``) and empty ones dropped: the closest pair first, each
 *  merge a weight-averaged colour whose weights add up. Then small edge
 *  blends are folded (``foldEdgeBlends``), when ``edgeEvidence`` can tell
 *  an edge from an accent; without it nothing is folded. Ordered by weight,
 *  most first; a stable sort, so equal weights keep their order. */
export function mergeNearColors(
  colors: WeightedColor[],
  threshold = MERGE_DELTA_E,
  edgeEvidence?: EdgeEvidence,
  lineTolerance = EDGE_LINE_DELTA_E,
): WeightedColor[] {
  const out = colors
    .map((c, i) => ({ rgb: [...c.rgb], weight: c.weight, members: c.members ? [...c.members] : [i] }))
    .filter((c) => c.weight > 0);
  for (;;) {
    let pair: [number, number] | null = null;
    let closest = threshold;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = deltaE00(out[i].rgb, out[j].rgb);
        if (d < closest) {
          closest = d;
          pair = [i, j];
        }
      }
    }
    if (!pair) break;
    const [i, j] = pair;
    const weight = out[i].weight + out[j].weight;
    out[i] = {
      rgb: out[i].rgb.map((v, n) => (v * out[i].weight + out[j].rgb[n] * out[j].weight) / weight),
      weight,
      members: [...out[i].members, ...out[j].members],
    };
    out.splice(j, 1);
  }
  foldSpecks(out, lineTolerance);
  if (edgeEvidence) foldEdgeBlends(out, lineTolerance, edgeEvidence);
  return out.sort((a, b) => b.weight - a.weight);
}

/** Fold each speck (``SPECK_SHARE``) into the nearest bigger swatch within
 *  ``tolerance``: weights add, the bigger one's colour stays. Smallest
 *  first. A speck far from every other colour stays. */
function foldSpecks(out: Swatch[], tolerance: number): void {
  const total = out.reduce((sum, c) => sum + c.weight, 0);
  for (;;) {
    const order = out.map((_, i) => i).sort((a, b) => out[a].weight - out[b].weight);
    let folded = false;
    for (const s of order) {
      if (out[s].weight >= SPECK_SHARE * total) break;
      let into = -1;
      let nearest = tolerance;
      out.forEach((c, i) => {
        if (i === s || c.weight <= out[s].weight) return;
        const d = deltaE00(out[s].rgb, c.rgb);
        if (d < nearest) {
          nearest = d;
          into = i;
        }
      });
      if (into >= 0) {
        out[into] = { rgb: out[into].rgb, weight: out[into].weight + out[s].weight, members: [...out[into].members, ...out[s].members] };
        out.splice(s, 1);
        folded = true;
        break;
      }
    }
    if (!folded) return;
  }
}

/** A swatch this small (share of the image) that sits on the line between
 *  two bigger swatches may be their antialiased edge. */
export const EDGE_BLEND_SHARE = 0.05;

/** How close (CIEDE2000) a swatch must be to the line between two bigger
 *  ones to be their blend: the backend's merge threshold, ``MERGE_DELTA_E``
 *  of commons/measure.py (the shared fixture's ``mergeDeltaE``). */
export const EDGE_LINE_DELTA_E = 5;

/** ...and it is one only when at least this share of its pixels sit next to
 *  both of them (GM r6 on #208: "a blend lives only on edges, while an
 *  accent has an interior"). A grey caption on a black-and-white logo has an
 *  interior, so it stays however small. */
export const EDGE_EVIDENCE_SHARE = 0.7;

/** "Next to": within this many pixels (a square window). Two, so a blend two
 *  pixels wide (two mixes, each beside one end) still counts as an edge,
 *  while a band three or more pixels wide has an interior row. */
export const EDGE_REACH = 2;

type Swatch = { rgb: number[]; weight: number; members: number[] };

/** Fold each small swatch that is a blend of two bigger ones into the nearer
 *  of the two: in colour, within ``threshold`` (CIEDE2000) of the sRGB
 *  segment between them, strictly between the ends; in the image, mostly
 *  pixels next to both (``EDGE_EVIDENCE_SHARE``). Weights add, the bigger
 *  one's colour stays. Smallest first. Anything else (a real accent) stays. */
function foldEdgeBlends(out: Swatch[], threshold: number, edgeEvidence: EdgeEvidence): void {
  const total = out.reduce((sum, c) => sum + c.weight, 0);
  for (;;) {
    const order = out.map((_, i) => i).sort((a, b) => out[a].weight - out[b].weight);
    let folded = false;
    for (const s of order) {
      if (out[s].weight >= EDGE_BLEND_SHARE * total) break;
      const p = out[s].rgb;
      const lines: { off: number; a: number; b: number; t: number }[] = [];
      for (let a = 0; a < out.length; a++) {
        for (let b = a + 1; b < out.length; b++) {
          if (a === s || b === s || out[a].weight <= out[s].weight || out[b].weight <= out[s].weight) continue;
          // An edge is mixed where the image is resampled, in sRGB values,
          // so the mix is the nearest point on the sRGB segment; how far the
          // swatch is from it is read in CIEDE2000.
          const pa = out[a].rgb;
          const ab = out[b].rgb.map((v, n) => v - pa[n]);
          const len2 = ab.reduce((sum, v) => sum + v * v, 0);
          if (len2 === 0) continue;
          const t = ab.reduce((sum, v, n) => sum + v * (p[n] - pa[n]), 0) / len2;
          if (t <= 0 || t >= 1) continue;
          const off = deltaE00(p, pa.map((v, n) => v + t * ab[n]));
          if (off < threshold) lines.push({ off, a, b, t });
        }
      }
      lines.sort((x, y) => x.off - y.off);
      const line = lines.find(({ a, b }) => edgeEvidence(out[s].members, out[a].members, out[b].members) >= EDGE_EVIDENCE_SHARE);
      if (line) {
        const into = line.t < 0.5 ? line.a : line.b;
        out[into] = { rgb: out[into].rgb, weight: out[into].weight + out[s].weight, members: [...out[into].members, ...out[s].members] };
        out.splice(s, 1);
        folded = true;
        break;
      }
    }
    if (!folded) return;
  }
}

/** Edge evidence from an image's cluster labels (``labels[i]`` the k-means
 *  cluster of pixel i, row by row, or -1 for a pixel not counted). A pixel
 *  counts once, whatever its alpha. */
export function edgeEvidenceFromLabels(labels: Int32Array, width: number): EdgeEvidence {
  const height = Math.ceil(labels.length / width);
  return (swatch, a, b) => {
    const inS = new Set(swatch);
    const inA = new Set(a);
    const inB = new Set(b);
    let pixels = 0;
    let onEdge = 0;
    for (let i = 0; i < labels.length; i++) {
      if (!inS.has(labels[i])) continue;
      pixels++;
      const x = i % width;
      const y = (i - x) / width;
      let nearA = false;
      let nearB = false;
      for (let dy = -EDGE_REACH; dy <= EDGE_REACH && !(nearA && nearB); dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -EDGE_REACH; dx <= EDGE_REACH; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (j >= labels.length) continue;
          const l = labels[j];
          if (inA.has(l)) nearA = true;
          else if (inB.has(l)) nearB = true;
          if (nearA && nearB) break;
        }
      }
      if (nearA && nearB) onEdge++;
    }
    return pixels ? onEdge / pixels : 0;
  };
}

/** Deterministic k-means over RGB pixels, each counting by its weight (its
 *  alpha, ``pixelWeight``). Fixed initial centroids (evenly sampled) + fixed
 *  iteration count → stable output for the same image. With every weight 1
 *  (an opaque image) it is the unweighted k-means, number for number.
 *  Returns each centroid with the weight of the pixels nearest it, most
 *  first. */
export function kMeansColors(pixels: number[][], weights: number[], k: number, iterations = 8): WeightedColor[] {
  return kMeansClusters(pixels, weights, k, iterations).colors;
}

/** ``kMeansColors``, with each colour's cluster id in ``members`` and each
 *  pixel's cluster in ``labels`` (same order as ``pixels``). */
export function kMeansClusters(
  pixels: number[][],
  weights: number[],
  k: number,
  iterations = 8,
): { colors: WeightedColor[]; labels: Int32Array } {
  const labels = new Int32Array(pixels.length);
  if (pixels.length === 0) return { colors: [], labels };
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
    labels[index] = best;
  });
  const colors = centroids
    .map((c, i) => ({ rgb: c, weight: finalCounts[i], members: [i] }))
    .sort((a, b) => b.weight - a.weight);
  return { colors, labels };
}

/** Up to `k` dominant colours of RGBA pixel data (straight alpha, as canvas
 *  `getImageData` gives it, rows of ``width`` pixels; one row when it isn't
 *  given), or why there are none. Alpha counts as on the backend
 *  (``pixelWeight``). Near-identical colours are one swatch and an edge blend
 *  folds into its colours (``mergeNearColors``), so an image with two colours
 *  gives two, ordered by how much of the image each covers. */
export function paletteFromPixels(data: Uint8ClampedArray, k = 6, width = data.length / 4): PaletteResult {
  const pixels: number[][] = [];
  const weights: number[] = [];
  const at: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    const weight = pixelWeight(data[i + 3]);
    if (weight === 0) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
    weights.push(weight);
    at.push(i / 4);
  }
  if (pixels.length === 0) return { ok: false, reason: data.length > 0 ? 'transparent' : 'other' };
  const { colors: clusters, labels } = kMeansClusters(pixels, weights, k);
  const labelAt = new Int32Array(Math.floor(data.length / 4)).fill(-1);
  at.forEach((p, n) => {
    labelAt[p] = labels[n];
  });
  const colors = mergeNearColors(clusters, MERGE_DELTA_E, edgeEvidenceFromLabels(labelAt, Math.max(1, Math.round(width))));
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
    return paletteFromPixels(ctx.getImageData(0, 0, w, h).data, k, w);
  } catch {
    return { ok: false, reason: 'other' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
