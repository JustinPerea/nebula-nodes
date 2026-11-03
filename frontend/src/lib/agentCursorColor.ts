/**
 * An agent cursor's colours: each session's shade of its agent's colour, and
 * the contrast maths (GM - Design, PR #211 r2-r8). Kept apart from
 * agentCursorLook so the Agent log, loaded with the app, can shade a line
 * exactly as its cursor is shaded without the cursor layer's geometry
 * (PR #211 r20).
 */
import type { SessionLike } from './agentCursorLabel';

/** OKLCH lightness offsets for an agent's sessions 1-5, cycling after five (GM - Design, PR #211 r2). */
export const AGENT_CURSOR_SESSION_LIGHTNESS = [0, -0.1, 0.1, -0.2, 0.2] as const;
/**
 * Every session's L sits inside `min`-`max` and at least `minGap` from every
 * other L in use. A step that would put L past `max` or under `min` is clamped
 * to that edge only when the edge is at least `clampGap` from every L in use;
 * otherwise the offset is not used. No fill is ever pure white.
 */
export const AGENT_CURSOR_SESSION_BAND = { max: 0.92, min: 0.35, minGap: 0.05, clampGap: 0.07 } as const;

// sRGB ↔ OKLab (Björn Ottosson's published matrices).
type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

/** Linear sRGB for an OKLCH colour (may fall outside 0..1). */
function oklchToLinear(L: number, C: number, h: number): Rgb {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);

/**
 * The OKLCH lightness of an agent's session `ordinal`, from the agent's own L
 * (GM - Design, PR #211 r2, r7 and r8). Sessions take the offsets 0, −0.10,
 * +0.10, −0.20, +0.20 in order, each the first of these that works: the
 * value itself, if it is inside 0.35-0.92 and at least 0.05 from every L in
 * use; past an edge, the edge (0.92 or 0.35), if it is at least 0.07 from
 * every L in use (r8: so a clamped session never sits at the bare minimum
 * from a neighbour); else the next unused offset. When no unused offset
 * works, L steps on by 0.10 inside the band, nearest first. The offsets
 * cycle after five, so sessions 1 and 6 share a fill (their names differ,
 * and with two or more cursors names show). The band holds session 1 too
 * (r3): a base outside 0.35-0.92 is pulled to the nearer edge before any
 * stepping, so black starts at L 0.35, visible on the dark canvas, and white
 * at 0.92.
 */
export function sessionLightness(rawBaseL: number, ordinal: number): number {
  const steps = AGENT_CURSOR_SESSION_LIGHTNESS;
  const { max, min, minGap, clampGap } = AGENT_CURSOR_SESSION_BAND;
  const baseL = Math.min(max, Math.max(min, rawBaseL));
  const index = (ordinal - 1) % steps.length;
  const used: number[] = [];
  const taken = new Set<number>();
  // Gaps compare with a small epsilon so float rounding never flips a gap of
  // exactly 0.05 or 0.07 (base 0.85 clamps to 0.92 at exactly 0.07).
  const roomAt = (candidate: number, gap: number) => used.every((u) => Math.abs(u - candidate) >= gap - 1e-9);
  // Session 1 is the agent's own colour, pulled into the band.
  let L = baseL;
  used.push(L);
  taken.add(0);
  for (let k = 1; k <= index; k += 1) {
    const order = [...steps.keys()].map((j) => (k + j) % steps.length).filter((j) => !taken.has(j));
    // The value itself, or past an edge the edge with 0.07 of room (r8).
    const fit = (delta: number): number | undefined => {
      const value = baseL + delta;
      if (value > max) return roomAt(max, clampGap) ? max : undefined;
      if (value < min) return roomAt(min, clampGap) ? min : undefined;
      return roomAt(value, minGap) ? value : undefined;
    };
    let chosen = order.find((j) => fit(steps[j]) !== undefined);
    if (chosen !== undefined) {
      L = fit(steps[chosen])!;
    } else {
      // Near either end of the band the edge is taken or too close, so no
      // unused offset works (from L 0.85, +0.20 finds 0.92 taken by +0.10).
      // Then step on by 0.10 inside the band, nearest first, until one is
      // clear. Some step always is (every base 0 to 1 in 0.0001 steps,
      // round 3c), so the offset pulled into the band is a last resort
      // that never runs.
      chosen = order[0];
      L = Math.min(max, Math.max(min, baseL + steps[chosen]));
      for (let m = 3; m <= 10; m += 1) {
        const next = [baseL - m * 0.1, baseL + m * 0.1].find((c) => c >= min && c <= max && roomAt(c, minGap));
        if (next !== undefined) {
          L = next;
          break;
        }
      }
    }
    taken.add(chosen);
    used.push(L);
  }
  return L;
}

function fillAt(base: { l: number; c: number; h: number }, L: number): string {
  if (inGamut(oklchToLinear(L, base.c, base.h))) return toHex(oklchToLinear(L, base.c, base.h).map(toGamma) as Rgb);
  let lo = 0;
  let hi = base.c;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, base.h))) lo = mid;
    else hi = mid;
  }
  return toHex(oklchToLinear(L, lo, base.h).map(toGamma) as Rgb);
}

/**
 * The fill for one session of an agent: the agent's own hue and chroma at
 * the session's lightness (sessionLightness), with chroma lowered only as far
 * as it must be to stay in sRGB. The first session is the agent's colour
 * exactly when its L is inside the band, else pulled to the band's edge.
 */
export function sessionFill(hex: string, session: SessionLike | null): string {
  const ordinal = session && Number.isInteger(session.ordinal) && session.ordinal > 0 ? session.ordinal : 1;
  const base = hexToOklch(hex);
  if (!base) return hex;
  const L = Math.min(1, Math.max(0, sessionLightness(base.l, ordinal)));
  // sessionLightness keeps every L inside 0.35-0.92, so no fill is ever
  // #ffffff or invisible black; a colour already in the band is kept exactly.
  return L === base.l ? hex : fillAt(base, L);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The tone to draw text in on `surface`: `fill` itself when it reads at
 * least `minContrast`:1 there, else the nearest tone of the same hue that
 * does (OKLCH lightness stepped in 0.005s either way, chroma lowered only
 * as far as sRGB needs). GM - Design, PR #211 r20: the Agent log's name
 * text, whose dot keeps the cursor's own shade.
 */
export function readableTone(fill: string, surface: string, minContrast = 4.5): string {
  if (contrastRatio(fill, surface) >= minContrast) return fill;
  const base = hexToOklch(fill);
  if (!base) return fill;
  for (let k = 1; k <= 200; k += 1) {
    for (const L of [base.l + k * 0.005, base.l - k * 0.005]) {
      if (L < 0 || L > 1) continue;
      const tone = fillAt(base, L);
      if (contrastRatio(tone, surface) >= minContrast) return tone;
    }
  }
  return luminance(surface) < 0.18 ? '#ffffff' : '#000000';
}

/**
 * The Agent log's surface behind its rows: Restraint's panel glass
 * (--sr-glass, rgba(22, 22, 24, 0.66)) over the black canvas (--sr-canvas).
 * Restraint is the app's one appearance (lib/skins). A test re-derives it
 * from the stylesheet.
 */
export const AGENT_LOG_SURFACE = '#0f0f10';

/**
 * An Agent log line's colours for a cursor (GM - Design, PR #211 r20): the
 * dot in the cursor's own shade, exactly as the canvas fills it
 * (sessionFill), and the name text in that shade too, unless it reads
 * under 4.5:1 on the log's surface; then the nearest passing tone of the
 * same hue (readableTone).
 */
export function agentLogTones(color: string, session: SessionLike | null, surface = AGENT_LOG_SURFACE): { dot: string; name: string } {
  const dot = sessionFill(color, session);
  return { dot, name: readableTone(dot, surface) };
}
