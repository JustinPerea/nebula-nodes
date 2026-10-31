import type { Point } from './agentCursorMotion';

/**
 * How an agent cursor reads (GM - Design, agent cursor §1 and §4): when its
 * name shows, where the say pill sits, the name's text colour, the fill for
 * each session of one agent, and how cursors keep off each other's tips.
 */

/** The person's pointer counts as over a cursor's arrow or pills within this many px (cursors take no pointer events). */
export const AGENT_CURSOR_HOVER_SLOP_PX = 4;
/** The name shows this long on a first sighting. */
export const AGENT_CURSOR_NAME_FIRST_SIGHT_MS = 1500;
/** OKLCH lightness offsets for an agent's sessions 1-5, cycling after five (GM - Design, PR #211 r2). */
export const AGENT_CURSOR_SESSION_LIGHTNESS = [0, -0.1, 0.1, -0.2, 0.2] as const;
/**
 * A step that would put L above `max` is mirrored (−step), one under `min`
 * the other way; a result within `minGap` of a session already used takes
 * the next unused offset instead. No fill is ever pure white.
 */
export const AGENT_CURSOR_SESSION_BAND = { max: 0.92, min: 0.35, minGap: 0.05 } as const;
/** A later cursor whose target is this close to an earlier one's lands this far down-right. */
export const AGENT_CURSOR_STACK = { radiusPx: 16, offsetPx: 10 } as const;
export const AGENT_CURSOR_INK_DARK = '#0b0b0c';
export const AGENT_CURSOR_INK_LIGHT = '#ffffff';
/** A chat title in a cursor's name is cut to this many characters. */
export const AGENT_CURSOR_TITLE_CHARS = 20;

interface SessionLike {
  ordinal: number;
}

/**
 * "Claude" for number 1, then "Claude · 2", "Claude · 3": the number the
 * backend gave, the lowest free among the agent's live sessions. This only
 * shows it and never numbers. A chat title, when Nebula has one for the
 * session, takes the number's place.
 */
/** The first `count` user-perceived characters (grapheme clusters), so a flag or an accent is never split. */
export function cutGraphemes(text: string, count: number): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return [...text].slice(0, count).join('');
  const parts: string[] = [];
  for (const { segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (parts.length === count) break;
    parts.push(segment);
  }
  return parts.join('');
}

export function sessionName(name: string, session: SessionLike | null, title?: string | null): string {
  const cut = title ? cutGraphemes(title.trim(), AGENT_CURSOR_TITLE_CHARS).trim() : '';
  if (cut) return `${name} · ${cut}`;
  if (!session || !Number.isInteger(session.ordinal) || session.ordinal < 2) return name;
  return `${name} · ${session.ordinal}`;
}

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
 * (GM - Design, PR #211 r2). Sessions take the offsets 0, −0.10, +0.10,
 * −0.20, +0.20 in order. A step past 0.92 is mirrored down, one under 0.35
 * mirrored up, and one landing within 0.05 of an earlier session's L takes
 * the next unused offset. The offsets cycle after five, so sessions 1 and 6
 * share a fill (their names differ, and with two or more cursors names show).
 */
export function sessionLightness(baseL: number, ordinal: number): number {
  const steps = AGENT_CURSOR_SESSION_LIGHTNESS;
  const { max, min, minGap } = AGENT_CURSOR_SESSION_BAND;
  const place = (delta: number) => {
    const L = baseL + delta;
    if (L > max) return baseL - Math.abs(delta);
    if (L < min) return baseL + Math.abs(delta);
    return L;
  };
  const index = (ordinal - 1) % steps.length;
  const used: number[] = [];
  const taken = new Set<number>();
  // Session 1 is the agent's own colour, unless that is white (shown at 0.92).
  let L = baseL >= 0.9999 ? max : baseL;
  used.push(L);
  taken.add(0);
  for (let k = 1; k <= index; k += 1) {
    const order = [...steps.keys()].map((j) => (k + j) % steps.length).filter((j) => !taken.has(j));
    const clear = (candidate: number) => used.every((u) => Math.abs(u - candidate) >= minGap - 1e-9);
    let chosen = order.find((j) => clear(place(steps[j])));
    if (chosen !== undefined) {
      L = place(steps[chosen]);
    } else {
      // Near either end of the band the mirrored offsets fold onto each
      // other (from L 0.85, +0.10 and +0.20 mirror onto 0.75 and 0.65), so
      // no unused offset is clear. Then step on by 0.10 inside the band,
      // nearest first, until one is.
      chosen = order[0];
      L = place(steps[chosen]);
      for (let m = 3; m <= 10; m += 1) {
        const next = [baseL - m * 0.1, baseL + m * 0.1].find((c) => c >= min && c <= max && clear(c));
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
 * exactly, unless that is pure white, which no cursor ever is.
 */
export function sessionFill(hex: string, session: SessionLike | null): string {
  const ordinal = session && Number.isInteger(session.ordinal) && session.ordinal > 0 ? session.ordinal : 1;
  const base = hexToOklch(hex);
  if (!base) return hex;
  const L = Math.min(1, Math.max(0, sessionLightness(base.l, ordinal)));
  // sessionLightness keeps every L at or under 0.92 except an agent's own
  // off-white colour as its session 1, so no fill is ever #ffffff.
  return L === base.l && hex.toLowerCase() !== '#ffffff' ? hex : fillAt(base, L);
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

/** The dark ink's fallback: on a narrow band of mid-luminance fills neither ink clears 4.5:1, and black does. */
export const AGENT_CURSOR_INK_BLACK = '#000000';
const MIN_CONTRAST = 4.5;

/**
 * The name's text colour on this fill: whichever ink reads better, and at
 * least 4.5:1. Every built-in agent colour gets the dark ink, as before.
 * Where the better of the two falls short (fills near luminance 0.19, where
 * #0b0b0c and white both give about 4.4:1), black does it (at least 4.58:1).
 */
export function inkFor(fillHex: string): string {
  const dark = contrastRatio(fillHex, AGENT_CURSOR_INK_DARK);
  const light = contrastRatio(fillHex, AGENT_CURSOR_INK_LIGHT);
  if (Math.max(dark, light) < MIN_CONTRAST) return AGENT_CURSOR_INK_BLACK;
  return dark >= light ? AGENT_CURSOR_INK_DARK : AGENT_CURSOR_INK_LIGHT;
}

/**
 * With two or more agent cursors on the canvas the name always shows, moving
 * too. A lone cursor hides its name while it moves, and shows it while the
 * person's pointer is over it and for a moment on a first sighting.
 */
export function nameVisible(o: { moving: boolean; peers: number; hovered: boolean; sinceFirstSightMs: number }): boolean {
  // Two or more cursors: the name holds its slot, moving or not, so the say
  // pill under it never jumps (GM - Design, PR #211 r2).
  if (o.peers >= 2) return true;
  if (o.moving) return false;
  return o.hovered || o.sinceFirstSightMs < AGENT_CURSOR_NAME_FIRST_SIGHT_MS;
}

/** What the label shows. With the name hidden, the say pill takes the name's slot. */
export type LabelLayout = 'none' | 'name' | 'say' | 'name+say';

export function labelLayout(nameShown: boolean, sayShown: boolean): LabelLayout {
  if (nameShown) return sayShown ? 'name+say' : 'name';
  return sayShown ? 'say' : 'none';
}

interface StackEntry {
  key: string;
  target: Point;
  /** When this cursor came to its spot: earlier ones keep their place (GM - Design, PR #211 r2). */
  since: number;
}

/**
 * Where each cursor lands so no tip covers another's. Cursors are placed in
 * the order they came to their spots. Each starts at its target; while it is
 * within 16 screen px of an earlier cursor's placed tip and not already at
 * least 10 px down and right of it, it steps 10 px down and right. So a
 * second cursor on a spot lands 10 px down-right of the first, a third past
 * both, and one aimed up-left of an earlier tip never lands on it. Targets
 * and results are in flow coordinates.
 */
export function deStack(cursors: readonly StackEntry[], zoom: number): Map<string, Point> {
  const radius = AGENT_CURSOR_STACK.radiusPx / zoom;
  const offset = AGENT_CURSOR_STACK.offsetPx / zoom;
  const placed = new Map<string, Point>();
  const ordered = [...cursors].sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const eps = 1e-9;
  for (const cursor of ordered) {
    let at = { ...cursor.target };
    const blocked = () => [...placed.values()].some((p) => Math.hypot(p.x - at.x, p.y - at.y) < radius
      && !(at.x >= p.x + offset - eps && at.y >= p.y + offset - eps));
    for (let i = 0; i <= 2 * placed.size + 2 && blocked(); i += 1) at = { x: at.x + offset, y: at.y + offset };
    placed.set(cursor.key, at);
  }
  return placed;
}

/** Keys in paint order: the most recently active cursor last, so it's on top. */
export function paintOrder(cursors: readonly { key: string; receivedAt: number }[]): string[] {
  return [...cursors]
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((c) => c.key);
}
