/** A palette from a reference image, for the Inspector's "Extract from
 * reference" (the 'palette' param: a string[] of `#rrggbb`). Client-side
 * k-means on the image reduced to 96 px, so it needs no backend endpoint.
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
// Extract measures "the same colour" in the units the moodboard palette
// does (commons/measure.py ``_merge``). contracts/fixtures/colour/
// delta_e00.json is the table both sides are tested against, so they can't
// drift. The merge itself differs: Extract also merges neutral near-blacks
// (``NEUTRAL_NEAR_BLACK``) and the backend doesn't. Its ΔE00 5 merge
// already leaves one black: 0 of 60 per-channel noisy-black seeds kept two
// (review 5, N2), where Extract's ΔE00 3 left a dark photo with three.
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
 *  about three just-noticeable steps, one threshold for every lightness (GM
 *  on #208, round 5). The metric is the moodboard palette's (backend
 *  commons/measure.py ``_merge``); plain OKLab, used before (at 0.03), had no
 *  lightness toe and put #000000 and #010101 twice its threshold apart, so a
 *  noisy black gave three or four black swatches (review 3, M1). CIEDE2000
 *  puts grey-noise blacks 0.2 to 1.2 apart, and blacks noisy on each channel
 *  about 2 apart (CIEDE2000 doesn't shrink chroma near black), which 3
 *  merges in most images. At 3, studio-product.webp's #ededee and #f9f9f9
 *  (2.52) are one white. The backend merges at 5 (``EDGE_LINE_DELTA_E``); at
 *  5 Extract also merged two to three tones of most photos (see the notes
 *  for rounds 4 and 5). */
export const MERGE_DELTA_E = 3;

/** The neutral near-black merge: two swatches that are BOTH darker than
 *  ``maxL`` (CIELAB L*, 0-100) AND BOTH more neutral than ``maxC`` (CIELAB
 *  chroma C*) are one black, and merge whatever their ΔE00, weights adding
 *  up (GM r8 and r9 on #208). Why:
 *  - under L* 6, displays can't tell blacks apart;
 *  - noise blacks (a JPEG or render black, each channel 0-7 on its own)
 *    peak at C* 1.98 over 200 seeds, so 3 leaves a margin; their k-means
 *    centroids sat about ΔE00 3.5 apart in 2 to 8% of images, mostly in
 *    chroma, which CIEDE2000 doesn't shrink near black;
 *  - tinted darks (C* 4-5, cyberpunk-neon, editorial-flash) and deep violets
 *    (C* 15-23, neon-alley) are real tones and stay apart.
 *  Raising ``MERGE_DELTA_E`` instead cost real tones elsewhere. */
export const NEUTRAL_NEAR_BLACK = { maxL: 6, maxC: 3 } as const;

/** Whether a Lab colour is a neutral near-black (``NEUTRAL_NEAR_BLACK``). */
export function isNeutralNearBlack(lab: number[]): boolean {
  return lab[0] < NEUTRAL_NEAR_BLACK.maxL && Math.hypot(lab[1], lab[2]) < NEUTRAL_NEAR_BLACK.maxC;
}

/** The distance the merge reads: 0 for two neutral near-blacks
 *  (``NEUTRAL_NEAR_BLACK``), CIEDE2000 otherwise. */
function mergeDistance(a: number[], b: number[]): number {
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  if (isNeutralNearBlack(la) && isNeutralNearBlack(lb)) return 0;
  return deltaE00Lab(la, lb);
}

/** A swatch under this share of the image is a speck, not a colour of its
 *  own, when it is within ``EDGE_LINE_DELTA_E`` of a bigger swatch: it goes
 *  into the nearest one. The backend's ``ACCENT_MIN_SHARE``
 *  (commons/measure.py): it shows no colour that covers less. */
export const SPECK_SHARE = 0.001;

/** A colour, how much of the image it covers (summed pixel weights) and,
 *  when it came from an image, which k-means clusters it holds. */
export type WeightedColor = { rgb: number[]; weight: number; members?: number[] };

/** What the image says about where swatches sit, each given as the k-means
 *  clusters it holds:
 *  - ``edge``: the share (0-1) of the pixels of ``swatch`` that sit next to
 *    both a pixel of ``a`` and one of ``b``, the evidence that the swatch is
 *    their antialiased edge;
 *  - ``touching``: whether a pixel of ``a`` sits next to one of ``b``;
 *  - ``colour``: the colour of the pixels of ``swatch``. */
export type EdgeEvidence = {
  /** NaN when ``swatch`` has no pixel to look at. */
  edge: (swatch: number[], a: number[], b: number[]) => number;
  touching: (a: number[], b: number[]) => boolean;
  /** The most populated colour of the pixels of ``swatch``
   *  (``mostPopulated``), or null when it has none. */
  colour?: (swatch: number[]) => number[] | null;
  /** The pixels of ``swatch`` (colour and weight), or none when it has none. */
  cells?: (swatch: number[]) => EvidenceCell[];
  /** The share of the evidence's weight that ``swatch``'s pixels hold, or
   *  NaN when it has none there. */
  size?: (swatch: number[]) => number;
};

/** One evidence pixel: its colour, its weight (alpha), and whether it lies
 *  inside a flat area rather than on an edge. */
export type EvidenceCell = { rgb: number[]; weight: number; inside: boolean };

/** How far (per channel, 0-255) a neighbour may be and still count as the
 *  same flat colour. */
export const FLAT_TOLERANCE = 2;

/** ``colors`` with near-identical ones merged (CIEDE2000 under
 *  ``MERGE_DELTA_E``, or both neutral near-blacks, ``NEUTRAL_NEAR_BLACK``)
 *  and empty ones dropped: the closest pair first, each merge a
 *  weight-averaged colour whose weights add up. Merged blacks are the
 *  exception (GM r11): the group shows its most populated black (the
 *  heaviest swatch, or with pixels to read, their most populated black),
 *  and every swatch in it must meet the rule against that black, so a
 *  merge never chains. Specks fold into a near bigger swatch
 *  (``foldSpecks``). Then, when ``edgeEvidence`` can tell an edge from an
 *  accent, small edge blends fold (``foldEdgeBlends``), a continuous run of
 *  blends between two colours becomes one band (``foldBands``), and a small
 *  swatch that stays shows its colour at the evidence's scale; without it
 *  none of this happens. Ordered by weight, most first; a stable sort, so
 *  equal weights keep their order. */
export function mergeNearColors(
  colors: WeightedColor[],
  threshold = MERGE_DELTA_E,
  edgeEvidence?: EdgeEvidence,
  lineTolerance = EDGE_LINE_DELTA_E,
): WeightedColor[] {
  const out = colors
    .map((c, i) => ({ rgb: [...c.rgb], weight: c.weight, members: c.members ? [...c.members] : [i] }))
    .filter((c) => c.weight > 0);
  // Each swatch as it came in: a merged black keeps one of these (GM r11).
  const own = new Map<number, { rgb: number[]; weight: number }>();
  for (const c of out) for (const m of c.members) own.set(m, { rgb: c.rgb, weight: c.weight / c.members.length });
  const blackGroup = new Set<Swatch>();
  for (;;) {
    let pair: [number, number] | null = null;
    let closest = threshold;
    let keep: number[] | null = null;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const d = mergeDistance(out[i].rgb, out[j].rgb);
        if (!(d < closest)) continue;
        // A merge of blacks keeps the group's most populated black, and
        // every member must meet the rule against that black, not against
        // a neighbour it was merged with: no chaining.
        let kept: number[] | null = null;
        if (blackGroup.has(out[i]) || blackGroup.has(out[j]) || d < deltaE00(out[i].rgb, out[j].rgb)) {
          const members = [...out[i].members, ...out[j].members];
          kept = members.map((m) => own.get(m)!).reduce(heavier).rgb;
          if (!members.every((m) => mergeDistance(own.get(m)!.rgb, kept!) < threshold)) continue;
        }
        closest = d;
        pair = [i, j];
        keep = kept;
      }
    }
    if (!pair) break;
    const [i, j] = pair;
    const weight = out[i].weight + out[j].weight;
    const merged: Swatch = {
      rgb: keep ?? out[i].rgb.map((v, n) => (v * out[i].weight + out[j].rgb[n] * out[j].weight) / weight),
      weight,
      members: [...out[i].members, ...out[j].members],
    };
    if (keep) blackGroup.add(merged);
    out[i] = merged;
    out.splice(j, 1);
  }
  // With pixels to read, a merged black shows its most populated real black.
  for (const c of blackGroup) {
    const at = out.indexOf(c);
    const real = at >= 0 ? edgeEvidence?.colour?.(c.members) : null;
    if (real && isNeutralNearBlack(rgbToLab(real))) out[at] = { ...c, rgb: real };
  }
  foldSpecks(out, lineTolerance);
  if (edgeEvidence) {
    // A blend that is the edge between two main colours (each at least
    // EDGE_BLEND_SHARE) folds first, so a seam that touches a caption of the
    // same grey doesn't band with it. What is left of a run is one band.
    // Then any blend or band that is an edge folds. A swatch with no pixel
    // at the evidence's scale waits for its run, and only at the end, on
    // its own, reads as all edge, whatever its size.
    foldEdgeBlends(out, lineTolerance, edgeEvidence, { mainEndsOnly: true, unseenIsEdge: false });
    foldBands(out, lineTolerance, edgeEvidence);
    foldEdgeBlends(out, lineTolerance, edgeEvidence, { mainEndsOnly: false, unseenIsEdge: true });
    // A small swatch that stays shows its most populated colour at the
    // evidence's scale, where a keyline isn't smeared into what's beside it
    // (GM r11: #808080, not #6a6a6a), when it is a few clean colours there
    // (``REAL_COLOUR``). A big area keeps its colour, and so does a swatch
    // of scattered tones (a photo's, line art finer than the evidence),
    // which would otherwise jump to a stray pixel.
    const total = out.reduce((sum, c) => sum + c.weight, 0);
    const size = sizer(edgeEvidence, total);
    for (let s = 0; s < out.length; s++) {
      if (size(out[s]) >= EDGE_BLEND_SHARE) continue;
      const cells = edgeEvidence.cells?.(out[s].members) ?? [];
      const real = mostPopulated(cells);
      if (real && fewColours(cells)) out[s] = { ...out[s], rgb: real };
    }
  }
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

/** "Next to": within this many pixels (a square window), read at up to
 *  ``EVIDENCE_MAX_DIM`` px. Two, so a blend one or two pixels wide (each
 *  pixel beside both ends, or each beside one end and the other within
 *  two) is an edge and folds, while a band three or more pixels wide has an
 *  interior and stays: "under 3 px at 256 folds, wider keeps" (GM r10 on
 *  #208). A band w pixels wide has min(w, 2 * EDGE_REACH + 1 - w) / w of its
 *  pixels next to both: 1 at 1 and 2 px, 1/3 at 3, 0 from 4, so 0.7 cuts
 *  between 2 and 3. The notes (round 6) have the measured widths. */
export const EDGE_REACH = 2;

type Swatch = { rgb: number[]; weight: number; members: number[] };

/** Where ``p`` sits on the sRGB segment from ``a`` to ``b``: ``t`` along it
 *  (0 at a, 1 at b) and ``off``, the CIEDE2000 distance to the nearest point
 *  of it. An edge is mixed where the image is resampled, in sRGB values, so
 *  the mix is the nearest point on the sRGB segment; how far the swatch is
 *  from it is read in CIEDE2000. Null when a and b are the same colour. */
function onSegment(p: number[], a: number[], b: number[]): { t: number; off: number } | null {
  const ab = b.map((v, n) => v - a[n]);
  const len2 = ab.reduce((sum, v) => sum + v * v, 0);
  if (len2 === 0) return null;
  const t = ab.reduce((sum, v, n) => sum + v * (p[n] - a[n]), 0) / len2;
  return { t, off: deltaE00(p, a.map((v, n) => v + t * ab[n])) };
}

/** The heavier of two swatches; of two as heavy, the darker by its sRGB
 *  values in order, so the choice doesn't depend on the order they come in. */
function heavier<T extends { rgb: number[]; weight: number }>(x: T, y: T): T {
  if (x.weight !== y.weight) return x.weight > y.weight ? x : y;
  for (let n = 0; n < 3; n++) if (x.rgb[n] !== y.rgb[n]) return x.rgb[n] < y.rgb[n] ? x : y;
  return x;
}

/** Whether ``s`` can be a blend of two bigger swatches: a small one (under
 *  ``EDGE_BLEND_SHARE``), smaller than both, each measured by ``size``. */
function canBlend(s: Swatch, a: Swatch, b: Swatch, size: (c: Swatch) => number): boolean {
  return size(s) < EDGE_BLEND_SHARE && size(a) > size(s) && size(b) > size(s);
}

/** How much of the image ``c`` covers: its share at the evidence's (finer)
 *  scale when it has pixels there, where a thin edge isn't smeared wider
 *  than it is, and its share of ``total`` otherwise. */
function sizer(evidence: EdgeEvidence, total: number): (c: Swatch) => number {
  return (c) => {
    const fine = evidence.size?.(c.members) ?? NaN;
    return Number.isNaN(fine) ? c.weight / total : fine;
  };
}

/** Colours within this share of the most populated one count as
 *  populated: a line one pixel wide at the evidence's scale has its own
 *  colour and the two mixes beside it about equally often, and the one in
 *  the middle is the line. */
export const MODE_TIE = 0.25;

/** The most populated real colour of ``cells`` (GM r11 on #208: "a palette
 *  never shows a colour the image doesn't contain"): the cells are put in
 *  bins of 4 levels a channel, the heaviest bin wins, and its heaviest exact
 *  colour is the answer. Cells inside a flat area count alone when there
 *  are any. A near tie (``MODE_TIE``) goes to the colour nearest the cells'
 *  mean, which only picks among real colours (a ramp's mid-tone, a thin
 *  line's middle). Null with no cells. */
export function mostPopulated(all: { rgb: number[]; weight: number; inside?: boolean }[]): number[] | null {
  const flat = all.filter((c) => c.inside);
  const cells = flat.length > 0 ? flat : all;
  if (cells.length === 0) return null;
  const total = cells.reduce((sum, c) => sum + c.weight, 0);
  const mean = [0, 1, 2].map((n) => cells.reduce((sum, c) => sum + c.rgb[n] * c.weight, 0) / total);
  const near = (rgb: number[]) => rgb.reduce((sum, v, n) => sum + (v - mean[n]) ** 2, 0);
  const pick = <T>(groups: Map<string, { key: number[]; weight: number; items: T }>) => {
    const all = [...groups.values()];
    const most = Math.max(...all.map((g) => g.weight));
    const close = all.filter((g) => g.weight >= (1 - MODE_TIE) * most);
    close.sort((x, y) => near(x.key) - near(y.key) || y.weight - x.weight || (x.key.join() < y.key.join() ? -1 : 1));
    return close[0];
  };
  const bins = new Map<string, { key: number[]; weight: number; items: { rgb: number[]; weight: number }[] }>();
  for (const c of cells) {
    const b = c.rgb.map((v) => Math.floor(Math.round(v) / 4));
    const k = b.join();
    const g = bins.get(k) ?? { key: b.map((v) => v * 4 + 1.5), weight: 0, items: [] };
    g.weight += c.weight;
    g.items.push(c);
    bins.set(k, g);
  }
  const bin = pick(bins);
  const exact = new Map<string, { key: number[]; weight: number; items: null }>();
  for (const c of bin.items) {
    const r = c.rgb.map((v) => Math.round(v));
    const k = r.join();
    const g = exact.get(k) ?? { key: r, weight: 0, items: null };
    g.weight += c.weight;
    exact.set(k, g);
  }
  return pick(exact).key;
}

/** A small swatch shows its colour at the evidence's scale only when it is
 *  a few clean colours there: its ``REAL_COLOUR.colours`` most populated
 *  (in ``mostPopulated``'s bins) hold ``REAL_COLOUR.share`` of its weight.
 *  A flat accent is one, a line one pixel wide is three (itself and the
 *  mix on each side). A photo's scattered tones or line art finer than the
 *  evidence are dozens (the 22 real images: every small swatch at 1.00 or
 *  at 0.15 and under), and their most populated pixel is a stray. */
export const REAL_COLOUR = { colours: 3, share: 0.75 } as const;

/** Whether ``cells`` are a few clean colours (``REAL_COLOUR``). */
function fewColours(cells: { rgb: number[]; weight: number }[]): boolean {
  const bins = new Map<string, number>();
  let total = 0;
  for (const c of cells) {
    const k = c.rgb.map((v) => Math.floor(Math.round(v) / 4)).join();
    bins.set(k, (bins.get(k) ?? 0) + c.weight);
    total += c.weight;
  }
  const top = [...bins.values()].sort((x, y) => y - x).slice(0, REAL_COLOUR.colours);
  return total > 0 && top.reduce((x, y) => x + y, 0) >= REAL_COLOUR.share * total;
}

/** Whether ``cells``, read along the line from ``a`` to ``b``, are two flat
 *  colours (two strong modes with a thin trough between them) rather than
 *  one colour or a continuous run (GM r11 on #208). Each cell's position is
 *  its projection on the sRGB segment, in ``BAND_BINS`` bins. The cells
 *  split where the two sides are best told apart (Otsu); each side must
 *  hold at least ``BAND_MODE.minSide`` of the weight and be flat (its
 *  heaviest 3 bins hold ``BAND_MODE.flat`` of it), and the bins between
 *  the two modes hold no more than ``BAND_MODE.trough`` of the smaller
 *  mode's peak bin. */
export function twoFlats(all: EvidenceCell[], a: number[], b: number[]): boolean {
  const cells = all.filter((c) => c.inside);
  const ab = b.map((v, n) => v - a[n]);
  const len2 = ab.reduce((sum, v) => sum + v * v, 0);
  if (len2 === 0 || cells.length === 0) return false;
  const hist = new Array(BAND_BINS).fill(0);
  for (const c of cells) {
    const t = Math.min(1, Math.max(0, ab.reduce((sum, v, n) => sum + v * (c.rgb[n] - a[n]), 0) / len2));
    hist[Math.min(BAND_BINS - 1, Math.floor(t * BAND_BINS))] += c.weight;
  }
  const total = hist.reduce((x, y) => x + y, 0);
  // Otsu: the split with the most variance between the two sides.
  let split = -1;
  let bestVar = -1;
  for (let k = 1; k < BAND_BINS; k++) {
    const w0 = hist.slice(0, k).reduce((x, y) => x + y, 0);
    const w1 = total - w0;
    if (w0 <= 0 || w1 <= 0) continue;
    const m0 = hist.slice(0, k).reduce((x, y, i) => x + y * i, 0) / w0;
    const m1 = hist.slice(k).reduce((x, y, i) => x + y * (i + k), 0) / w1;
    const v = w0 * w1 * (m0 - m1) ** 2;
    if (v > bestVar) {
      bestVar = v;
      split = k;
    }
  }
  if (split < 0) return false;
  const side = (lo: number, hi: number) => {
    const mass = hist.slice(lo, hi).reduce((x, y) => x + y, 0);
    let peak = lo;
    for (let i = lo; i < hi; i++) if (hist[i] > hist[peak]) peak = i;
    const window = hist.slice(Math.max(lo, peak - 1), Math.min(hi, peak + 2)).reduce((x, y) => x + y, 0);
    return { mass, peak, flat: mass > 0 ? window / mass : 0 };
  };
  const L = side(0, split);
  const R = side(split, BAND_BINS);
  if (Math.min(L.mass, R.mass) < BAND_MODE.minSide * total) return false;
  if (L.flat < BAND_MODE.flat || R.flat < BAND_MODE.flat) return false;
  if (R.peak - L.peak < 3) return false;
  const between = hist.slice(L.peak + 2, R.peak - 1);
  const trough = between.length ? Math.max(...between) : 0;
  return trough <= BAND_MODE.trough * Math.min(hist[L.peak], hist[R.peak]);
}

/** The bins ``twoFlats`` reads a run in, along its line. */
export const BAND_BINS = 32;
/** ``twoFlats``'s tuning (see the round 7 notes for the cases it holds). */
export const BAND_MODE = { minSide: 0.2, flat: 0.6, trough: 0.25 } as const;

/** One band (GM r10 on #208): a run of small swatches that all lie on the
 *  line between the same two colours, strictly between them and within
 *  ``threshold`` (CIEDE2000), and touch one another in the image (read on
 *  the clusters' own grid), is one band, when it is continuous: an
 *  antialiased edge, a ramp, a stripe the downscale turned into three or
 *  four columns of blends (review 4, L1). Two flat colours that touch stay
 *  two (``twoFlats``; GM r11, review 5 M1). The band shows its most
 *  populated colour at the evidence's scale (``colour``), never a mean, with
 *  its weights adding up; without pixels to read, its heaviest part's. The
 *  evidence then decides the one swatch: next to both colours
 *  (``EDGE_EVIDENCE_SHARE``) it is their edge and folds into the nearer
 *  one; with an interior it is an accent and stays, once. Two small accents
 *  on one line that don't touch stay two. Of all the runs on all the lines,
 *  the one between the heaviest ends goes first (then the longer, the
 *  nearer, then by colour), so the result doesn't depend on the order the
 *  swatches come in; then again until no run is left. */
function foldBands(out: Swatch[], threshold: number, evidence: EdgeEvidence): void {
  for (;;) {
    const total = out.reduce((sum, c) => sum + c.weight, 0);
    const size = sizer(evidence, total);
    // Every candidate band on every line, then one chosen by a rule that
    // doesn't depend on the order the swatches or lines come in.
    const found: { run: number[]; a: number; b: number; off: number }[] = [];
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        const offs = new Map<number, number>();
        out.forEach((c, s) => {
          if (s === a || s === b || !canBlend(c, out[a], out[b], size)) return;
          const at = onSegment(c.rgb, out[a].rgb, out[b].rgb);
          if (at !== null && at.t > 0 && at.t < 1 && at.off < threshold) offs.set(s, at.off);
        });
        const on = [...offs.keys()];
        if (on.length < 2) continue;
        // The runs: the swatches on the line, grouped by touching.
        const group = on.map((_, n) => n);
        const root = (n: number): number => (group[n] === n ? n : (group[n] = root(group[n])));
        for (let i = 0; i < on.length; i++) {
          for (let j = i + 1; j < on.length; j++) {
            if (root(i) !== root(j) && evidence.touching(out[on[i]].members, out[on[j]].members)) group[root(j)] = root(i);
          }
        }
        const runs = new Map<number, number[]>();
        on.forEach((s, n) => runs.set(root(n), [...(runs.get(root(n)) ?? []), s]));
        for (const run of runs.values()) {
          if (run.length < 2) continue;
          // Only a continuous run is a band: two flat colours that touch
          // stay two colours (GM r11 on #208).
          const cells = evidence.cells?.(run.flatMap((s) => out[s].members)) ?? [];
          if (twoFlats(cells, out[a].rgb, out[b].rgb)) continue;
          found.push({ run, a, b, off: run.reduce((sum, s) => sum + offs.get(s)!, 0) / run.length });
        }
      }
    }
    if (found.length === 0) return;
    // The line between the heaviest ends first (a band inside a band's
    // line would otherwise take part of it), then the longer run, the
    // nearer one, and, for an exact tie, the colours themselves.
    const ends = (x: { a: number; b: number }) => out[x.a].weight + out[x.b].weight;
    const key = (x: { run: number[]; a: number; b: number }) =>
      [x.a, x.b, ...x.run].map((s) => out[s].rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')).join();
    found.sort(
      (x, y) =>
        ends(y) - ends(x) || y.run.length - x.run.length || x.off - y.off || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0),
    );
    const { run, a, b } = found[0];
    const weight = run.reduce((sum, s) => sum + out[s].weight, 0);
    const members = run.flatMap((s) => out[s].members);
    // The band shows its most populated real colour, never a mean.
    const heaviest = run.map((s) => out[s]).reduce(heavier);
    const merged: Swatch = { rgb: evidence.colour?.(members) ?? heaviest.rgb, weight, members };
    const at = onSegment(merged.rgb, out[a].rgb, out[b].rgb);
    const share = evidence.edge(merged.members, out[a].members, out[b].members);
    const edge = Number.isNaN(share) || share >= EDGE_EVIDENCE_SHARE;
    const into = at && edge ? (at.t < 0.5 ? a : b) : -1;
    if (into >= 0) {
      out[into] = { rgb: out[into].rgb, weight: out[into].weight + weight, members: [...out[into].members, ...merged.members] };
    }
    const first = Math.min(...run);
    if (into < 0) out[first] = merged;
    const gone = into < 0 ? run.filter((s) => s !== first) : run;
    for (const s of [...gone].sort((x, y) => y - x)) out.splice(s, 1);
  }
}

/** Fold each small swatch that is a blend of two bigger ones into the nearer
 *  of the two: in colour, within ``threshold`` (CIEDE2000) of the sRGB
 *  segment between them, strictly between the ends; in the image, mostly
 *  pixels next to both (``EDGE_EVIDENCE_SHARE``). Weights add, the bigger
 *  one's colour stays. Smallest first. Anything else (a real accent) stays.
 *  A swatch with no pixel to look at folds when ``unseenIsEdge`` (onto any
 *  line, whatever its size), and waits otherwise; with ``mainEndsOnly``, only lines between two main colours
 *  (each at least ``EDGE_BLEND_SHARE``) are read. */
function foldEdgeBlends(
  out: Swatch[],
  threshold: number,
  edgeEvidence: EdgeEvidence,
  { mainEndsOnly, unseenIsEdge }: { mainEndsOnly: boolean; unseenIsEdge: boolean },
): void {
  const total = out.reduce((sum, c) => sum + c.weight, 0);
  const size = sizer(edgeEvidence, total);
  for (;;) {
    const order = out.map((_, i) => i).sort((a, b) => out[a].weight - out[b].weight);
    let folded = false;
    for (const s of order) {
      // A swatch with no pixel at all at the evidence's (finer) scale is a
      // product of the reduction, not a colour the person sees: at the end
      // it folds onto a line whatever its size (the 2 x 2 blocks of a
      // scattered 74%-clear mark mix charcoal and orange into a swatch
      // heavier than the orange; review 4, M3).
      const unseen = unseenIsEdge && Number.isNaN(edgeEvidence.edge(out[s].members, [], []));
      if (size(out[s]) >= EDGE_BLEND_SHARE && !unseen) continue;
      const lines: { off: number; a: number; b: number; t: number }[] = [];
      for (let a = 0; a < out.length; a++) {
        for (let b = a + 1; b < out.length; b++) {
          if (a === s || b === s || (!unseen && !canBlend(out[s], out[a], out[b], size))) continue;
          if (mainEndsOnly && Math.min(size(out[a]), size(out[b])) < EDGE_BLEND_SHARE) continue;
          const at = onSegment(out[s].rgb, out[a].rgb, out[b].rgb);
          if (!at || at.t <= 0 || at.t >= 1) continue;
          if (at.off < threshold) lines.push({ ...at, a, b });
        }
      }
      lines.sort((x, y) => x.off - y.off);
      const line = lines.find(({ a, b }) => {
        const share = edgeEvidence.edge(out[s].members, out[a].members, out[b].members);
        return Number.isNaN(share) ? unseenIsEdge : share >= EDGE_EVIDENCE_SHARE;
      });
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
 *  counts once, whatever its alpha. ``runs``, when given, holds the labels
 *  ``touching`` reads instead: the clusters' own grid, where every cluster
 *  has pixels, while ``labels`` is a finer grid (``EVIDENCE_MAX_DIM``) on
 *  which a blend of the 96 px pass may have none (``edge`` is then NaN).
 *  ``pixels``, the grid ``labels`` labels, gives ``colour``. */
export function edgeEvidenceFromLabels(
  labels: Int32Array,
  width: number,
  runs: { labels: Int32Array; width: number } = { labels, width },
  pixels?: PixelGrid,
): EdgeEvidence {
  const height = Math.ceil(labels.length / width);
  // A pixel is inside a flat area when it has its colour (within
  // ``FLAT_TOLERANCE`` a channel) on both sides along one axis and on at
  // least one side along the other (neighbours off the grid or clear
  // count as the same). A cell a straight edge cuts matches along the edge
  // but on neither side across it, so it is never inside; a line two
  // pixels wide is.
  let inside: Uint8Array | null = null;
  const insideAt = (i: number) => {
    if (!pixels) return false;
    if (!inside) {
      inside = new Uint8Array(labels.length);
      for (let j = 0; j < labels.length; j++) {
        if (!(pixels.weight[j] > 0)) continue;
        const x = j % width;
        const y = Math.floor(j / width);
        const same = (dx: number, dy: number) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true;
          const k = ny * width + nx;
          if (!(pixels.weight[k] > 0)) return true;
          for (let n = 0; n < 3; n++) if (Math.abs(pixels.rgb[k * 3 + n] - pixels.rgb[j * 3 + n]) > FLAT_TOLERANCE) return false;
          return true;
        };
        const h = [same(-1, 0), same(1, 0)];
        const v = [same(0, -1), same(0, 1)];
        inside[j] = (h[0] && h[1] && (v[0] || v[1])) || (v[0] && v[1] && (h[0] || h[1])) ? 1 : 0;
      }
    }
    return inside[i] === 1;
  };
  const cells = pixels
    ? (swatch: number[]) => {
        const inS = new Set(swatch);
        const found: EvidenceCell[] = [];
        for (let i = 0; i < labels.length; i++) {
          if (!inS.has(labels[i]) || !(pixels.weight[i] > 0)) continue;
          found.push({
            rgb: [pixels.rgb[i * 3], pixels.rgb[i * 3 + 1], pixels.rgb[i * 3 + 2]],
            weight: pixels.weight[i],
            inside: insideAt(i),
          });
        }
        return found;
      }
    : undefined;
  const colour = cells ? (swatch: number[]) => mostPopulated(cells(swatch)) : undefined;
  let evidenceTotal = -1;
  const sizes = new Map<string, number>();
  const size = pixels
    ? (swatch: number[]) => {
        if (evidenceTotal < 0) {
          evidenceTotal = 0;
          for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && pixels.weight[i] > 0) evidenceTotal += pixels.weight[i];
        }
        const key = swatch.join();
        let known = sizes.get(key);
        if (known === undefined) {
          const found = cells!(swatch).reduce((sum, c) => sum + c.weight, 0);
          known = found > 0 && evidenceTotal > 0 ? found / evidenceTotal : NaN;
          sizes.set(key, known);
        }
        return known;
      }
    : undefined;
  const touching = (a: number[], b: number[]) => {
    const inA = new Set(a);
    const inB = new Set(b);
    const { labels: at, width: w } = runs;
    const h = Math.ceil(at.length / w);
    for (let i = 0; i < at.length; i++) {
      if (!inA.has(at[i])) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const j = yy * w + xx;
          if (xx >= 0 && xx < w && j < at.length && inB.has(at[j])) return true;
        }
      }
    }
    return false;
  };
  const edge = (swatch: number[], a: number[], b: number[]) => {
    const inS = new Set(swatch);
    const inA = new Set(a);
    const inB = new Set(b);
    let seen = 0;
    let onEdge = 0;
    for (let i = 0; i < labels.length; i++) {
      if (!inS.has(labels[i])) continue;
      seen++;
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
    return seen ? onEdge / seen : NaN;
  };
  return { edge, touching, colour, cells, size };
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

/** The palette clusters are found at this size (longest edge, px). */
export const CLUSTER_MAX_DIM = 96;

/** The edge evidence is read at this size (longest edge, px), finer than the
 *  clusters (GM r10 on #208): a deliberate keyline is a colour, and a 20 px
 *  line on a 1000 px image is about 5 px here, wide enough to show an
 *  interior, where at 96 px it was 2 and read as an edge (review 4, L2). */
export const EVIDENCE_MAX_DIM = 256;

/** Extract reads the picked image at up to this size (longest edge, px): a
 *  4K frame whole; anything larger is drawn down to it first. */
export const READ_MAX_DIM = 4096;

/** Pixels on a grid, row by row ``width`` wide: each cell's straight colour
 *  (``rgb``, 3 per cell) and how much it counts (``weight``; 0 when it isn't
 *  counted). */
export type PixelGrid = { rgb: Float64Array; weight: Float64Array; width: number };

/** RGBA pixel data (straight alpha, as canvas ``getImageData`` gives it) as
 *  a grid, each pixel counting by its alpha (``pixelWeight``). */
export function gridFromRgba(data: Uint8ClampedArray, width: number): PixelGrid {
  const cells = Math.floor(data.length / 4);
  const rgb = new Float64Array(cells * 3);
  const weight = new Float64Array(cells);
  for (let n = 0; n < cells; n++) {
    rgb[n * 3] = data[n * 4];
    rgb[n * 3 + 1] = data[n * 4 + 1];
    rgb[n * 3 + 2] = data[n * 4 + 2];
    weight[n] = pixelWeight(data[n * 4 + 3]);
  }
  return { rgb, weight, width: Math.max(1, Math.round(width)) };
}

/** RGBA pixel data (straight alpha, ``width`` x ``height``) reduced so its
 *  longest edge is at most ``maxDim``, as the backend reduces an image with
 *  transparency (cinema/color.py ``_area_pixels``): each cell is a block of
 *  f x f pixels, its colour their alpha-weighted mean and its weight their
 *  alpha summed over a full block (f * f * 255), so it carries the block's
 *  coverage. Pixels under ``ALPHA_MIN`` are taken out first, so a haze never
 *  adds up to a colour. The browser's own downscale works on premultiplied
 *  8-bit colour, so a block of faint pixels came back hue-shifted: a
 *  phantom green-black on a 74%-clear mark (review 4, M3). With f = 1 it is
 *  ``gridFromRgba``, value for value wherever a pixel counts. */
export function areaGrid(data: Uint8ClampedArray, width: number, height: number, maxDim: number): PixelGrid {
  const f = Math.max(width, height) <= maxDim ? 1 : Math.ceil(Math.max(width, height) / maxDim);
  const gw = Math.ceil(width / f);
  const gh = Math.ceil(height / f);
  const cellX = new Int32Array(width).map((_, x) => Math.floor(x / f));
  const cellY = new Int32Array(height).map((_, y) => Math.floor(y / f));
  return reduceArea(data, width, height, gw, gh, { at: cellX, part: null }, { at: cellY, part: null }, f * f * 255);
}

/** RGBA pixel data (straight alpha, ``width`` x ``height``) reduced so its
 *  longest edge is exactly ``maxDim`` (as it is when already smaller): the
 *  same alpha-weighted area average as ``areaGrid``, with fractional cells,
 *  each source pixel shared between the (at most 2 x 2) cells it overlaps
 *  by how much of it falls in each (GM r11 on #208). An integer block
 *  made the grid anything from 129 to 256 px, so how wide a band had to be
 *  to stay jumped with the image's size (review 5, L1). The evidence is
 *  read on it; the clusters keep ``areaGrid``, as the backend reduces. */
export function exactAreaGrid(data: Uint8ClampedArray, width: number, height: number, maxDim: number): PixelGrid {
  const longest = Math.max(width, height);
  if (longest <= maxDim) return areaGrid(data, width, height, maxDim);
  const gw = Math.max(1, Math.round((width * maxDim) / longest));
  const gh = Math.max(1, Math.round((height * maxDim) / longest));
  const axis = (n: number, g: number) => {
    // Pixel p covers [p, p + 1) of the source; cell c covers [c * size, (c + 1) * size).
    const size = n / g;
    const at = new Int32Array(n);
    const part = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      const c = Math.min(g - 1, Math.floor(p / size));
      at[p] = c;
      part[p] = c + 1 < g ? Math.min(1, (c + 1) * size - p) : 1;
    }
    return { at, part };
  };
  return reduceArea(data, width, height, gw, gh, axis(width, gw), axis(height, gh), (width / gw) * (height / gh) * 255);
}

/** The area average both reductions share. Each source pixel goes to cell
 *  ``at`` along each axis, a ``part`` of it (all of it when ``part`` is
 *  null) and the rest to the next cell. */
function reduceArea(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gw: number,
  gh: number,
  xs: { at: Int32Array; part: Float64Array | null },
  ys: { at: Int32Array; part: Float64Array | null },
  full: number,
): PixelGrid {
  const sums = new Float64Array(gw * gh * 4);
  const add = (c: number, i: number, w: number) => {
    sums[c] += data[i] * w;
    sums[c + 1] += data[i + 1] * w;
    sums[c + 2] += data[i + 2] * w;
    sums[c + 3] += w;
  };
  for (let y = 0; y < height; y++) {
    const cy = ys.at[y];
    const py = ys.part ? ys.part[y] : 1;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < ALPHA_MIN) continue;
      const cx = xs.at[x];
      const px = xs.part ? xs.part[x] : 1;
      add((cy * gw + cx) * 4, i, a * px * py);
      if (px < 1) add((cy * gw + cx + 1) * 4, i, a * (1 - px) * py);
      if (py < 1) {
        add(((cy + 1) * gw + cx) * 4, i, a * px * (1 - py));
        if (px < 1) add(((cy + 1) * gw + cx + 1) * 4, i, a * (1 - px) * (1 - py));
      }
    }
  }
  const rgb = new Float64Array(gw * gh * 3);
  const weight = new Float64Array(gw * gh);
  for (let n = 0; n < gw * gh; n++) {
    const a = sums[n * 4 + 3];
    if (a === 0) continue;
    for (let ch = 0; ch < 3; ch++) rgb[n * 3 + ch] = Math.round(sums[n * 4 + ch] / a);
    weight[n] = a / full;
  }
  return { rgb, weight, width: gw };
}

/** Up to `k` dominant colours of a grid of pixels (``PixelGrid``), or why
 *  there are none. Near-identical colours are one swatch and an edge blend
 *  folds into its colours (``mergeNearColors``), so an image with two
 *  colours gives two, ordered by how much of the image each covers. The
 *  edge evidence is read on ``evidence`` when given (a finer grid of the
 *  same image, each cell labelled with its nearest cluster), on ``grid``
 *  otherwise. */
export function paletteFromGrid(grid: PixelGrid, k = 6, evidence?: PixelGrid): PaletteResult {
  const pixels: number[][] = [];
  const weights: number[] = [];
  const at: number[] = [];
  for (let n = 0; n < grid.weight.length; n++) {
    if (grid.weight[n] <= 0) continue;
    pixels.push([grid.rgb[n * 3], grid.rgb[n * 3 + 1], grid.rgb[n * 3 + 2]]);
    weights.push(grid.weight[n]);
    at.push(n);
  }
  if (pixels.length === 0) return { ok: false, reason: grid.weight.length > 0 ? 'transparent' : 'other' };
  const { colors: clusters, labels } = kMeansClusters(pixels, weights, k);
  const labelAt = new Int32Array(grid.weight.length).fill(-1);
  at.forEach((p, n) => {
    labelAt[p] = labels[n];
  });
  const runs = { labels: labelAt, width: grid.width };
  let found = edgeEvidenceFromLabels(labelAt, grid.width, runs, grid);
  if (evidence) {
    const centroids: number[][] = [];
    for (const c of clusters) centroids[c.members![0]] = c.rgb;
    const fine = new Int32Array(evidence.weight.length).fill(-1);
    for (let n = 0; n < evidence.weight.length; n++) {
      if (evidence.weight[n] <= 0) continue;
      fine[n] = nearestCentroid([evidence.rgb[n * 3], evidence.rgb[n * 3 + 1], evidence.rgb[n * 3 + 2]], centroids);
    }
    found = edgeEvidenceFromLabels(fine, evidence.width, runs, evidence);
  }
  const colors = mergeNearColors(clusters, MERGE_DELTA_E, found);
  return { ok: true, colors: colors.map(({ rgb }) => rgbToHex(rgb[0], rgb[1], rgb[2])) };
}

/** The index of the centroid nearest ``px`` (squared RGB distance, as
 *  k-means assigns), the first on a tie. */
function nearestCentroid(px: number[], centroids: number[][]): number {
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
  return best;
}

/** Up to `k` dominant colours of RGBA pixel data (straight alpha, as canvas
 *  `getImageData` gives it, rows of ``width`` pixels; one row when it isn't
 *  given), or why there are none: ``paletteFromGrid`` with each pixel
 *  counting by its alpha (``pixelWeight``), as on the backend, and the
 *  evidence read on the same pixels. */
export function paletteFromPixels(data: Uint8ClampedArray, k = 6, width = data.length / 4): PaletteResult {
  return paletteFromGrid(gridFromRgba(data, width), k);
}

/** Whether any pixel of RGBA data is less than fully opaque. */
function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/** The palette of an image read whole (RGBA ``data``, ``width`` x
 *  ``height``): clusters on the image reduced to ``CLUSTER_MAX_DIM`` by the
 *  alpha-weighted area filter (``areaGrid``), or on ``clusterGrid`` when
 *  given (the browser's own 96 px downscale of an opaque image, which Extract
 *  has always read, so an opaque image clusters as it did), and the edge
 *  evidence read at ``EVIDENCE_MAX_DIM``. */
export function paletteFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  k = 6,
  clusterGrid?: { data: Uint8ClampedArray; width: number },
): PaletteResult {
  const grid = clusterGrid ? gridFromRgba(clusterGrid.data, clusterGrid.width) : areaGrid(data, width, height, CLUSTER_MAX_DIM);
  return paletteFromGrid(grid, k, exactAreaGrid(data, width, height, EVIDENCE_MAX_DIM));
}

/** Draw ``img`` at ``w`` x ``h`` and read its pixels back, or null without a
 *  2d context. The canvas is let go once read. */
function readPixels(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

/** The size ``img`` is drawn at for a longest edge of at most ``maxDim``. */
function fitted(img: HTMLImageElement, maxDim: number): [number, number] {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  return [Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale))];
}

/** Decode the picked file, read its pixels and find its `k` dominant
 * colours (``paletteFromImageData``). An image with transparency is read at
 * full size (up to ``READ_MAX_DIM``) and reduced here, alpha-weighted, never
 * by the canvas's premultiplied downscale; an opaque one clusters on the
 * canvas's 96 px downscale as before, and reads its evidence at full size. The file is read from the person's own
 * copy, so a failed load is a failed decode, never the network. */
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
    // The 96 px downscale is drawn first, as Extract always drew it: Chrome
    // downscales an image it has already drawn at full size differently
    // (studio-product came back #e1dfdc and #ac9261, not #e2e0de and
    // #b29b6d), so the full-size read comes second.
    const [sw, sh] = fitted(img, CLUSTER_MAX_DIM);
    const small = readPixels(img, sw, sh);
    const [w, h] = fitted(img, READ_MAX_DIM);
    const data = sw === w && sh === h ? small : readPixels(img, w, h);
    if (!small || !data) return { ok: false, reason: 'other' };
    if (hasTransparency(data)) return paletteFromImageData(data, w, h, k);
    return paletteFromImageData(data, w, h, k, { data: small, width: sw });
  } catch {
    return { ok: false, reason: 'other' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
