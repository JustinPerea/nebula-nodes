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
 * Every session's L sits inside `min`-`max` and at least `minGap` from every
 * other L in use. A step that would put L past `max` or under `min` is clamped
 * to that edge only when the edge is at least `clampGap` from every L in use;
 * otherwise the offset is not used. No fill is ever pure white.
 */
export const AGENT_CURSOR_SESSION_BAND = { max: 0.92, min: 0.35, minGap: 0.05, clampGap: 0.07 } as const;
/** The arrow (AgentCursorLayer draws it): its path in screen px from the
 *  cursor's origin, the tip at (1.5, 1.5), and its white stroke
 *  (agentCursor.css). The wing reaches 13.2 px right of the tip. */
export const AGENT_CURSOR_ARROW_PATH = 'M1.5 1.5 L1.5 17.5 L6 13.3 L9.1 20.1 L11.9 18.9 L8.9 12.3 L14.7 12.1 Z';
export const AGENT_CURSOR_ARROW_POINTS: readonly Point[] = [
  { x: 1.5, y: 1.5 }, { x: 1.5, y: 17.5 }, { x: 6, y: 13.3 }, { x: 9.1, y: 20.1 },
  { x: 11.9, y: 18.9 }, { x: 8.9, y: 12.3 }, { x: 14.7, y: 12.1 },
];
export const AGENT_CURSOR_ARROW_STROKE = 1.4;
/** The label column from the cursor's origin, in screen px (agentCursor.css):
 *  the name pill at `left`/`top`, `height` tall (an 11 px line of 16 plus
 *  2 px above and below) with fully round ends, then `gap`, then the say
 *  pill, the same height. A name pill can carry a 1 px edge ring outside it
 *  (pillEdge); the say pill's hairline is inset. */
export const AGENT_CURSOR_PILL = { left: 15, top: 17, height: 20, gap: 4, ring: 1 } as const;
/** A cursor whose target is within `radiusPx` of a live cursor's tip joins
 *  that cursor's column, straight below it, never to the right; the step is
 *  the smallest that leaves `clearPx` between the painted shapes (GM -
 *  Design, PR #211 r12 and r13; stackStepPx). */
export const AGENT_CURSOR_STACK = { radiusPx: 16, clearPx: 2 } as const;
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
 * The name pill's edge (GM - Design, PR #211 r9 item 4): a pill whose fill is
 * under 3:1 against the canvas gets a 1 px edge, white at 0.4 (about 3.7:1 on
 * #000), the same rule in both skins. Slava's canvas is #000 (--sr-canvas),
 * the classic skin's #111 (canvas.css). The arrow needs none: its 1.4 px
 * white stroke already reads.
 */
export const AGENT_CURSOR_PILL_EDGE = { minContrast: 3, slavaCanvas: '#000000', classicCanvas: '#111111' } as const;

/** Which canvases this fill's name pill needs the edge on: both, the classic
 *  skin's only (#111 is lighter, so it needs it whenever #000 does), or none. */
export function pillEdge(fillHex: string): 'both' | 'classic' | null {
  const { minContrast, slavaCanvas, classicCanvas } = AGENT_CURSOR_PILL_EDGE;
  if (contrastRatio(fillHex, slavaCanvas) < minContrast) return 'both';
  if (contrastRatio(fillHex, classicCanvas) < minContrast) return 'classic';
  return null;
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
  /** Its say pill shows (or is fading out): its label block is name plus say. */
  say?: boolean;
}

/** An axis-aligned box. */
interface Box { left: number; top: number; right: number; bottom: number }

function pointToBox(p: Point, b: Box): number {
  const dx = Math.max(b.left - p.x, 0, p.x - b.right);
  const dy = Math.max(b.top - p.y, 0, p.y - b.bottom);
  return Math.hypot(dx, dy);
}

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Does segment a-b cross box b (Liang-Barsky)? */
function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - box.left], [dx, box.right - a.x], [-dy, a.y - box.top], [dy, box.bottom - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Distance from a segment to a box: 0 when they meet, else the nearest of
 *  the segment's ends to the box and the box's corners to the segment. */
function segmentToBox(a: Point, b: Point, box: Box): number {
  if (segmentHitsBox(a, b, box)) return 0;
  const corners = [
    { x: box.left, y: box.top }, { x: box.right, y: box.top },
    { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom },
  ];
  return Math.min(pointToBox(a, box), pointToBox(b, box), ...corners.map((c) => pointToSegment(c, a, b)));
}

function boxToBox(a: Box, b: Box): number {
  return Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
}

/** A painted pill: its core segment's box (the pill less its round ends'
 *  radius) and that radius, edge ring included. Width doesn't matter
 *  stacked straight down from the same left, as long as the ends are round. */
interface Pill { core: Box; radius: number }

function pill(top: number, ring: number, dy = 0): Pill {
  const { left, height } = AGENT_CURSOR_PILL;
  const r = height / 2;
  const width = 4 * height;
  return { core: { left: left + r, right: left + width - r, top: top + r + dy, bottom: top + r + dy }, radius: r + ring };
}

/** The earlier cursor's painted label block: its name pill (edge ring
 *  included) and, while one shows, its say pill. */
export function labelBlockPills(say: boolean): Pill[] {
  const { top, height, gap, ring } = AGENT_CURSOR_PILL;
  return say ? [pill(top, ring), pill(top + height + gap, 0)] : [pill(top, ring)];
}

/**
 * How far apart, in screen px, a later cursor `dy` px straight below an
 * earlier one paints from the earlier one's label block: its arrow's
 * painted path (stroke included) and its own name pill (edge ring
 * included) against the earlier name pill (ring included) and say pill.
 * Negative when they overlap.
 */
export function stackClearancePx(dy: number, earlierSay: boolean): number {
  const block = labelBlockPills(earlierSay);
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  const points = AGENT_CURSOR_ARROW_POINTS.map((p) => ({ x: p.x, y: p.y + dy }));
  const own = pill(AGENT_CURSOR_PILL.top, AGENT_CURSOR_PILL.ring, dy);
  let clear = Infinity;
  for (const p of block) {
    for (let i = 0; i < points.length; i += 1) {
      clear = Math.min(clear, segmentToBox(points[i], points[(i + 1) % points.length], p.core) - p.radius - half);
    }
    clear = Math.min(clear, boxToBox(own.core, p.core) - own.radius - p.radius);
  }
  return clear;
}

const stepCache = new Map<boolean, number>();

/**
 * The step down, in whole screen px, from an earlier cursor to the one
 * stacked below it: the smallest that leaves AGENT_CURSOR_STACK.clearPx
 * between the later cursor's painted arrow and name pill and the earlier
 * cursor's painted label block (GM - Design, PR #211 r13 items 1 and 2).
 * 24 below a name; 47 below a name and a say pill.
 */
export function stackStepPx(earlierSay: boolean): number {
  const cached = stepCache.get(earlierSay);
  if (cached !== undefined) return cached;
  let dy = 0;
  while (stackClearancePx(dy, earlierSay) < AGENT_CURSOR_STACK.clearPx - 1e-9) dy += 1;
  stepCache.set(earlierSay, dy);
  return dy;
}

/**
 * Where each cursor lands so no arrow or pill covers another's (GM - Design,
 * PR #211 r12 and r13). Cursors are placed in the order they came to their
 * spots. A cursor whose target is within 16 screen px of an earlier
 * cursor's placed tip (or its target) joins that cursor's column: it lands
 * straight below the column's last cursor, never to the right, by
 * stackStepPx of that cursor's label block (name, plus its say pill while
 * one shows). Joining is transitive, so near and identical targets make one
 * column, ordered by arrival. Only live cursors are passed in: a leaving
 * one doesn't count. Targets and results are in flow coordinates.
 */
export function deStack(cursors: readonly StackEntry[], zoom: number): Map<string, Point> {
  const radius = AGENT_CURSOR_STACK.radiusPx / zoom;
  const placed = new Map<string, Point>();
  const ordered = [...cursors].sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= radius + 1e-9;
  const columns: { x: number; members: { tip: Point; target: Point; say: boolean }[] }[] = [];
  for (const cursor of ordered) {
    const say = Boolean(cursor.say);
    const column = columns.find((c) => c.members.some((m) => near(cursor.target, m.tip) || near(cursor.target, m.target)));
    let at: Point;
    if (!column) {
      at = { ...cursor.target };
      columns.push({ x: at.x, members: [{ tip: at, target: cursor.target, say }] });
    } else {
      const last = column.members[column.members.length - 1];
      at = { x: column.x, y: last.tip.y + stackStepPx(last.say) / zoom };
      column.members.push({ tip: at, target: cursor.target, say });
    }
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
