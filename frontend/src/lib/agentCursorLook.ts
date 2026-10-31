import type { Point } from './agentCursorMotion';

/**
 * How an agent cursor reads (GM - Design, agent cursor §1 and §4): when its
 * name shows, where the say pill sits, the name's text colour, the fill for
 * each session of one agent, and how cursors keep off each other's tips.
 */

/** The name shows this long on a first sighting. */
export const AGENT_CURSOR_NAME_FIRST_SIGHT_MS = 1500;
/** OKLCH lightness steps for an agent's sessions, in order of appearance, repeating. */
export const AGENT_CURSOR_SESSION_LIGHTNESS = [0, 0.1, -0.1, 0.18] as const;
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
 * "Claude" for an agent's first session, then "Claude · 2", "Claude · 3" in
 * the order they appeared. A chat title, when Nebula has one for the session,
 * takes the number's place.
 */
export function sessionName(name: string, session: SessionLike | null, title?: string | null): string {
  const cut = title ? [...title.trim()].slice(0, AGENT_CURSOR_TITLE_CHARS).join('').trim() : '';
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
 * The fill for one session of an agent: the agent's own hue, a lightness
 * step per session (0, +0.10, −0.10, +0.18, repeating), and chroma lowered
 * only as far as it must be to stay in sRGB. The first session is the
 * agent's colour exactly.
 */
export function sessionFill(hex: string, session: SessionLike | null): string {
  const ordinal = session && Number.isInteger(session.ordinal) && session.ordinal > 0 ? session.ordinal : 1;
  const steps = AGENT_CURSOR_SESSION_LIGHTNESS;
  const delta = steps[(ordinal - 1) % steps.length];
  const base = hexToOklch(hex);
  if (!base || delta === 0) return hex;
  const L = Math.min(1, Math.max(0, base.l + delta));
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
 * The name is hidden while the cursor moves. It shows when two or more agent
 * cursors are on the canvas, while the person's pointer is over it, and for a
 * moment on a first sighting.
 */
export function nameVisible(o: { moving: boolean; peers: number; hovered: boolean; sinceFirstSightMs: number }): boolean {
  if (o.moving) return false;
  return o.peers >= 2 || o.hovered || o.sinceFirstSightMs < AGENT_CURSOR_NAME_FIRST_SIGHT_MS;
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
  receivedAt: number;
}

/**
 * Where each cursor lands so no tip covers another's. In order of arrival, a
 * cursor lands 10 screen px down and right for each earlier cursor whose
 * target is within 16 screen px of its own, so a third on the same spot
 * steps past the second. Targets and results are in flow coordinates.
 */
export function deStack(cursors: readonly StackEntry[], zoom: number): Map<string, Point> {
  const radius = AGENT_CURSOR_STACK.radiusPx / zoom;
  const offset = AGENT_CURSOR_STACK.offsetPx / zoom;
  const placed = new Map<string, Point>();
  const ordered = [...cursors].sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  ordered.forEach((cursor, index) => {
    const { x, y } = cursor.target;
    const under = ordered.slice(0, index).filter((earlier) => Math.hypot(earlier.target.x - x, earlier.target.y - y) < radius).length;
    placed.set(cursor.key, { x: x + under * offset, y: y + under * offset });
  });
  return placed;
}

/** Keys in paint order: the most recently active cursor last, so it's on top. */
export function paintOrder(cursors: readonly { key: string; receivedAt: number }[]): string[] {
  return [...cursors]
    .sort((a, b) => a.receivedAt - b.receivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((c) => c.key);
}
